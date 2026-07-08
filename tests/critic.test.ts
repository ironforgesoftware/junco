/**
 * Tests for src/critic.ts — the post-session critic (in-process diff-vs-spec
 * review). Faithful port of worker.py's critic, but the model runs in-process
 * via runAgent with an injected (fake) session factory.
 *
 * Uses a REAL git harness (bare remote + working clone with a commit) for the
 * gitDiff path; runCriticPass is driven by an injected fake AgentSessionLike.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(argv: string[], cwd?: string): string {
  return execFileSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CI",
      GIT_AUTHOR_EMAIL: "ci@example.com",
      GIT_COMMITTER_NAME: "CI",
      GIT_COMMITTER_EMAIL: "ci@example.com",
    },
  });
}

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: "/tmp/vault",
    juncoSubdir: "Junco",
    model: {
      id: "test/model",
      modelsJson: null,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "test",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 49152,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevel: "medium",
      compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
    },
    tools: [],
    defaultTimeoutMinutes: 30,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    supervisorEnabled: false,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    ghBin: "gh",
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: "/tmp/wts",
    removeWorktreeOnSuccess: true,
    allowedRepoRoots: [],
    draftByDefault: true,
    defaultLabels: [],
    verifyEnabled: true,
    verifyCommandTimeout: 60,
    verifyBlockOnFail: false,
    criticEnabled: true,
    criticMaxRetries: 1,
    criticThinking: "minimal",
    planLintEnabled: true,
    planLintBlockOnError: true,
    planLintCheckLabels: true,
    commitLeftoversEnabled: false,
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    logLevel: "info",
    stateDir: "/tmp/vault/state",
    logToFile: false,
    transcriptsEnabled: false,
    github: {
      enabled: false,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos: [],
      requireApproval: true,
      plannerModelId: null,
    },
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm" },
    ...overrides,
  };
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
    workdir: null,
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

/** Bare remote + working clone with a base commit. Returns {remote, work}. */
function setupGitHarness(tmpRoot: string): { remote: string; work: string } {
  const remote = join(tmpRoot, "remote.git");
  const work = join(tmpRoot, "work");
  run(["git", "init", "--bare", "-b", "main", remote]);
  run(["git", "init", "-b", "main", work]);
  run(["git", "-C", work, "config", "user.email", "ci@example.com"]);
  run(["git", "-C", work, "config", "user.name", "CI"]);
  run(["git", "-C", work, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(work, "README.md"), "seed\n");
  run(["git", "-C", work, "add", "README.md"]);
  run(["git", "-C", work, "commit", "-m", "seed"]);
  run(["git", "-C", work, "remote", "add", "origin", remote]);
  run(["git", "-C", work, "push", "-u", "origin", "main"]);
  return { remote, work };
}

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
    expect(result).toEqual({ status: "skipped", findings: "empty diff", rawOutput: "" });
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
