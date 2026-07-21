/**
 * Tests for src/critic.ts — the post-session critic (in-process diff-vs-spec
 * review). Faithful port of worker.py's critic, but the model runs in-process
 * via runAgent with an injected (fake) session factory.
 *
 * Uses a REAL git harness (bare remote + working clone with a commit) for the
 * gitDiff path; runCriticPass is driven by an injected fake AgentSessionLike.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config, Ticket } from "../src/types.js";
import {
  scanCriticMarker,
  gitDiff,
  buildCriticPrompt,
  CRITIC_PROMPT_TEMPLATE,
  DIFF_TRUNCATION_NOTE,
  runCriticPass,
  buildCorrectivePrompt,
} from "../src/critic.js";
import { makeConfig } from "./helpers/config.js";
import { run, cloneHarness } from "./helpers/gitHarness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<Config> = {}): Config {
  return makeConfig(
    {
      dataDir: "/tmp/vault/state",
      queueRoot: "/tmp/vault/Junco",
      worktreeRoot: "/tmp/wts",
      tools: [],
      criticEnabled: true,
      planLintEnabled: true,
      verifyEnabled: true,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: true,
    },
    {
      planLintBlockOnError: true,
      planLintCheckLabels: true,
      github: {
        enabled: false,
        triggerLabel: "junco",
        askLabel: "junco:ask",
        pollIntervalSeconds: 60,
        repos: [],
        requireApproval: true,
        plannerModelId: null,
        externalReposRoot: "/tmp/junco-test-external",
      },
      botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
      ...overrides,
    },
  );
}

function makeTicket(body: string): Ticket {
  return {
    path: "/tmp/t.md",
    id: "t",
    priority: "normal",
    timeoutSeconds: 1800,
    body,
    frontmatter: {},
    hasRepo: true,
    notBefore: null,
    retryCount: 0,
    tools: null,
    github: null,
    githubRequest: null,
    assess: null,
    analyze: null,
    workdir: null,
    network: null,
  };
}

/**
 * A fake AgentSessionLike that emits `finalDelta` as a single text_delta on
 * prompt(), then turn_end + agent_end, so runAgent's RunResult.finalText carries
 * the verdict text. Mirrors the SDK event shapes used elsewhere in tests.
 */
function fakeCriticSession(finalDelta: string) {
  const listeners: ((e: any) => void)[] = [];
  return {
    subscribe(l: (e: any) => void) {
      listeners.push(l);
      return () => {};
    },
    async prompt(_text: string) {
      const events = [
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: finalDelta },
        },
        {
          type: "turn_end",
          message: {
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
          },
        },
        { type: "agent_end", messages: [], willRetry: false },
      ];
      for (const e of events) listeners.forEach((l) => l(e));
    },
    dispose() {},
    abort: async () => {},
  };
}

/**
 * A fake critic session that emits each of `messages` as its OWN assistant
 * message (message_start + delta), so the verdict marker can land in a message
 * that is not the last one — reproducing #36's finalText = last-message-only.
 */
function fakeMultiMessageCriticSession(messages: string[]) {
  const listeners: ((e: any) => void)[] = [];
  return {
    subscribe(l: (e: any) => void) {
      listeners.push(l);
      return () => {};
    },
    async prompt(_text: string) {
      for (const m of messages) {
        listeners.forEach((l) => l({ type: "message_start", message: { role: "assistant" } }));
        listeners.forEach((l) =>
          l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: m } }),
        );
      }
      listeners.forEach((l) =>
        l({
          type: "turn_end",
          message: {
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
          },
        }),
      );
      listeners.forEach((l) => l({ type: "agent_end", messages: [], willRetry: false }));
    },
    dispose() {},
    abort: async () => {},
  };
}

// run() + the bare-remote-plus-clone tree live in tests/helpers/gitHarness.ts.
// cloneHarness copies a once-per-process template (~7ms) rather than rebuilding
// it with 10 git subprocesses (~142ms) per test.
const setupGitHarness = cloneHarness;

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "junco-critic-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scanCriticMarker
// ---------------------------------------------------------------------------

describe("scanCriticMarker", () => {
  it("PASS marker → pass with empty findings", () => {
    expect(scanCriticMarker("blah blah\nJUNCO_VERIFY: PASS")).toEqual({
      status: "pass",
      findings: "",
    });
  });

  it("MISSING marker → missing with trimmed findings", () => {
    expect(scanCriticMarker("JUNCO_VERIFY: MISSING foo, bar")).toEqual({
      status: "missing",
      findings: "foo, bar",
    });
  });

  it("no marker → error", () => {
    expect(scanCriticMarker("the diff looks fine to me")).toEqual({
      status: "error",
      findings: "critic did not emit JUNCO_VERIFY marker",
    });
  });

  it("empty text → error (no output)", () => {
    expect(scanCriticMarker("")).toEqual({ status: "error", findings: "no output from critic" });
  });

  it("multiple markers → LAST wins", () => {
    const text = "JUNCO_VERIFY: MISSING early item\n...reconsidered...\nJUNCO_VERIFY: PASS";
    expect(scanCriticMarker(text)).toEqual({ status: "pass", findings: "" });
  });
});

// ---------------------------------------------------------------------------
// buildCriticPrompt
// ---------------------------------------------------------------------------

describe("buildCriticPrompt", () => {
  it("substitutes spec/diff/base into the verbatim template", () => {
    const out = buildCriticPrompt("THE SPEC", "THE DIFF", "main");
    expect(out).toContain("You are a strict code reviewer.");
    expect(out).toContain("THE SPEC");
    expect(out).toContain("THE DIFF");
    expect(out).toContain("git diff main..HEAD --unified=3");
    expect(out).toContain("JUNCO_VERIFY: PASS");
    expect(out).toContain("JUNCO_VERIFY: MISSING <comma-separated short labels of missing items>");
    expect(out).toContain("Now output your single-line verdict.");
  });

  it("CRITIC_PROMPT_TEMPLATE has the {spec}/{diff}/{base} placeholders", () => {
    expect(CRITIC_PROMPT_TEMPLATE).toContain("{spec}");
    expect(CRITIC_PROMPT_TEMPLATE).toContain("{diff}");
    expect(CRITIC_PROMPT_TEMPLATE).toContain("{base}");
  });
});

// ---------------------------------------------------------------------------
// gitDiff
// ---------------------------------------------------------------------------

describe("gitDiff", () => {
  it("returns the diff text between base and HEAD", async () => {
    const { work } = setupGitHarness(tmpRoot);
    writeFileSync(join(work, "feature.ts"), "export const answer = 42;\n");
    run(["git", "-C", work, "add", "feature.ts"]);
    run(["git", "-C", work, "commit", "-m", "add feature"]);

    const diff = await gitDiff(makeCfg(), work, "origin/main");
    expect(diff).toContain("feature.ts");
    expect(diff).toContain("export const answer = 42;");
    expect(diff).toContain("+export const answer = 42;");
  });

  it("returns empty string when base == HEAD (no diff)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const diff = await gitDiff(makeCfg(), work, "origin/main");
    expect(diff.trim()).toBe("");
  });

  it("truncates a >100k diff and appends the truncation note", async () => {
    const { work } = setupGitHarness(tmpRoot);
    // ~150k of distinct lines → diff well over the 100k cap.
    const lines: string[] = [];
    for (let i = 0; i < 8000; i++)
      lines.push(`line number ${i} with some padding content here xyz`);
    writeFileSync(join(work, "big.txt"), lines.join("\n") + "\n");
    run(["git", "-C", work, "add", "big.txt"]);
    run(["git", "-C", work, "commit", "-m", "big"]);

    const diff = await gitDiff(makeCfg(), work, "origin/main");
    expect(diff.length).toBe(100_000 + DIFF_TRUNCATION_NOTE.length);
    expect(diff).toContain("DIFF TRUNCATED: only the first 100,000 characters are shown");
  });
});

// ---------------------------------------------------------------------------
// runCriticPass
// ---------------------------------------------------------------------------

describe("runCriticPass", () => {
  it("PASS verdict from the in-process critic → status pass", async () => {
    const { work } = setupGitHarness(tmpRoot);
    writeFileSync(join(work, "feature.ts"), "export const x = 1;\n");
    run(["git", "-C", work, "add", "feature.ts"]);
    run(["git", "-C", work, "commit", "-m", "feat"]);

    const result = await runCriticPass(makeCfg(), makeTicket("do the thing"), work, "origin/main", {
      criticSessionFactory: async () => fakeCriticSession("Looks good.\nJUNCO_VERIFY: PASS") as any,
    });
    expect(result.status).toBe("pass");
    expect(result.findings).toBe("");
    expect(result.rawOutput).toContain("JUNCO_VERIFY: PASS");
  });

  it("returns the critic session's usage (Phase-3 cost accounting)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    writeFileSync(join(work, "feature.ts"), "export const x = 1;\n");
    run(["git", "-C", work, "add", "feature.ts"]);
    run(["git", "-C", work, "commit", "-m", "feat"]);

    const result = await runCriticPass(makeCfg(), makeTicket("do the thing"), work, "origin/main", {
      criticSessionFactory: async () => fakeCriticSession("JUNCO_VERIFY: PASS") as any,
    });
    // fakeCriticSession's turn_end reports { input: 1, output: 1, cacheRead: 0,
    // totalTokens: 2 } — runAgent's accumulator threads it straight through.
    expect(result.usage).toEqual({ input: 1, output: 1, cacheRead: 0, total: 2, costUsd: 0 });
  });

  it("MISSING verdict → status missing with findings", async () => {
    const { work } = setupGitHarness(tmpRoot);
    writeFileSync(join(work, "feature.ts"), "export const x = 1;\n");
    run(["git", "-C", work, "add", "feature.ts"]);
    run(["git", "-C", work, "commit", "-m", "feat"]);

    const result = await runCriticPass(makeCfg(), makeTicket("do the thing"), work, "origin/main", {
      criticSessionFactory: async () =>
        fakeCriticSession("JUNCO_VERIFY: MISSING error handling, tests") as any,
    });
    expect(result.status).toBe("missing");
    expect(result.findings).toBe("error handling, tests");
  });

  it("finds the verdict marker when it precedes a trailing message (#67)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    writeFileSync(join(work, "feature.ts"), "export const x = 1;\n");
    run(["git", "-C", work, "add", "feature.ts"]);
    run(["git", "-C", work, "commit", "-m", "feat"]);

    // The critic emits its verdict, THEN a trailing note. finalText (#36) is
    // only the trailing note; reading allText recovers the marker.
    const result = await runCriticPass(makeCfg(), makeTicket("do the thing"), work, "origin/main", {
      criticSessionFactory: async () =>
        fakeMultiMessageCriticSession(["JUNCO_VERIFY: PASS", "That completes the review."]) as any,
    });
    expect(result.status).toBe("pass");
    expect(result.findings).toBe("");
  });

  it("criticEnabled=false → skipped (matches Python wording)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const result = await runCriticPass(
      makeCfg({ criticEnabled: false }),
      makeTicket("x"),
      work,
      "origin/main",
    );
    expect(result).toEqual({
      status: "skipped",
      findings: "cfg.critic_enabled=false",
      rawOutput: "",
      usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
    });
  });

  it("empty diff → skipped (matches Python wording)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    // No new commits past origin/main → empty diff.
    const result = await runCriticPass(makeCfg(), makeTicket("x"), work, "origin/main", {
      // Factory should never be invoked, but inject one to prove it isn't.
      criticSessionFactory: async () => {
        throw new Error("factory should not be called on empty diff");
      },
    });
    expect(result).toEqual({
      status: "skipped",
      findings: "empty diff",
      rawOutput: "",
      usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// buildCorrectivePrompt
// ---------------------------------------------------------------------------

describe("buildCorrectivePrompt", () => {
  it("contains the missing items, the corrective framing, and the original spec", () => {
    const out = buildCorrectivePrompt(makeTicket("ORIGINAL SPEC BODY"), "error handling, retries");
    expect(out).toContain("Corrective re-dispatch");
    expect(out).toContain("error handling, retries");
    expect(out).toContain("ORIGINAL SPEC BODY");
    expect(out).toContain("## Original ticket spec");
    expect(out).toContain("Do NOT amend, rebase, or force-change prior");
  });
});

// ---------------------------------------------------------------------------
// buildCriticPrompt — truncation guidance
// ---------------------------------------------------------------------------

describe("buildCriticPrompt truncation guidance", () => {
  it("carries no truncation note for a complete diff", () => {
    const out = buildCriticPrompt("the spec", "diff --git a/x b/x\n+1\n", "main");
    expect(out).not.toMatch(/TRUNCATED/);
  });

  it("instructs the critic to lean PASS when the diff is truncated", () => {
    const out = buildCriticPrompt("the spec", "x".repeat(40) + DIFF_TRUNCATION_NOTE, "main");
    expect(out).toMatch(/TRUNCATED/);
    expect(out).toMatch(/do not report MISSING for items you cannot see/i);
    expect(out).toMatch(/lean PASS/);
  });
});
