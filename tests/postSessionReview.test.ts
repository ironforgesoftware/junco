/**
 * Tests for src/postSessionReview.ts — prFlow's Phase 9, exercised on its own.
 *
 * The point of the extraction (#353): the escalation ladder's second rung
 * (Stage 2b — a clean apply whose `## Verification` block then failed) and the
 * critic's corrective re-dispatch both live here, and both used to be reachable
 * only by driving all 14 phases of `runPrFlow`. These drive the phase directly:
 * a REAL git clone for the commit counting/diffing, an injected `runBlockFn`
 * so verification verdicts are scripted rather than spawned, and fake sessions
 * for the fallback/corrective/critic turns.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runPostSessionReview, type ReviewCtx } from "../src/postSessionReview.js";
import { parseTicket } from "../src/ticket.js";
import type { Config, RunResult, Ticket, Usage } from "../src/types.js";
import type { AgentSessionLike } from "../src/agent/session.js";
import type { PatchSeries } from "../src/patchTicket.js";
import type { RunBlockFn } from "../src/verify.js";
import { makeConfig as baseConfig } from "./helpers/config.js";
import { run, cloneHarness } from "./helpers/gitHarness.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  root: string;
  /** Seeded clone with `origin/main` — doubles as the "worktree" under review. */
  work: string;
  tickets: string;
}

function setup(): Harness {
  const root = mkdtempSync(join(tmpdir(), "junco-review-"));
  const { work } = cloneHarness(root);
  const tickets = join(root, "tickets");
  mkdirSync(tickets, { recursive: true });
  return { root, work, tickets };
}

function makeConfig(h: Harness, overrides: Partial<Config> = {}): Config {
  return baseConfig(
    {
      dataDir: h.root,
      queueRoot: join(h.root, "Junco"),
      worktreeRoot: join(h.root, "wts"),
      tools: [],
      criticEnabled: false, // off by default; opt-in per test
      planLintEnabled: false,
      verifyEnabled: true,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: false,
    },
    { verifySandboxed: false, ...overrides },
  );
}

const TICKET_BODY = `# Add a feature

Make a change.

## Verification

\`\`\`bash
true
\`\`\`
`;

function makeTicket(h: Harness, id: string, body = TICKET_BODY): Ticket {
  const path = join(h.tickets, `${id}.md`);
  const content = `---\nid: ${id}\nrepo: ${h.work}\n---\n${body}`;
  writeFileSync(path, content, "utf8");
  return parseTicket(path, content, 30);
}

const SERIES: PatchSeries = { raw: "From 0123456\n", count: 1, files: ["feature.txt"] };

/** A real commit in the worktree, so `runCriticPass`'s diff-vs-base is non-empty. */
function seedCommit(h: Harness, name = "seeded.txt"): void {
  writeFileSync(join(h.work, name), `${name}\n`, "utf8");
  run(["git", "-C", h.work, "add", "-A"]);
  run(["git", "-C", h.work, "commit", "-m", `feat: ${name}`]);
}

function usage(n: number): Usage {
  return { input: n, output: n, cacheRead: 0, total: 2 * n, costUsd: n / 100 };
}

function mainResult(over: Partial<RunResult> = {}): RunResult {
  return {
    finalText: "main run",
    toolCalls: [],
    usage: usage(1),
    stopReason: "stop",
    errorMessage: null,
    timedOut: false,
    durationMs: 1,
    abortedByGuard: false,
    ...over,
  };
}

/**
 * A session whose prompt() makes a REAL commit in `cwd` and reports `costUsd`,
 * so the commit re-count after an escalation rung sees new work (mirrors
 * prFlow.test.ts's `commitFactory`). `label` lands in finalText so a test can
 * tell WHICH session's RunResult came back.
 */
function commitSessionFactory(
  label: string,
  cwd: string,
  costUsd = 0,
): () => () => Promise<AgentSessionLike> {
  let n = 0;
  return () => async () => {
    let listener: ((e: unknown) => void) | null = null;
    return {
      subscribe(l: (e: never) => void) {
        listener = l as (e: unknown) => void;
        return () => {};
      },
      async prompt() {
        const file = `${label}-${++n}.txt`;
        writeFileSync(join(cwd, file), `${label}\n`, "utf8");
        run(["git", "-C", cwd, "add", "-A"]);
        run(["git", "-C", cwd, "commit", "-m", `feat: ${file}`]);
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: label },
        });
        listener?.({
          type: "turn_end",
          message: {
            stopReason: "stop",
            usage: { input: 5, output: 5, cacheRead: 0, totalTokens: 10, cost: { total: costUsd } },
          },
        });
        listener?.({ type: "agent_end", messages: [], willRetry: false });
      },
      dispose() {},
      abort: async () => {},
    } as unknown as AgentSessionLike;
  };
}

/** A critic session emitting a fixed JUNCO_VERIFY verdict line per call. */
function criticFactory(verdicts: string[], costUsd = 0): () => Promise<AgentSessionLike> {
  let i = 0;
  return async () => {
    let listener: ((e: unknown) => void) | null = null;
    const line = verdicts[Math.min(i++, verdicts.length - 1)];
    return {
      subscribe(l: (e: never) => void) {
        listener = l as (e: unknown) => void;
        return () => {};
      },
      async prompt() {
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: line },
        });
        listener?.({
          type: "turn_end",
          message: {
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2, cost: { total: costUsd } },
          },
        });
        listener?.({ type: "agent_end", messages: [], willRetry: false });
      },
      dispose() {},
      abort: async () => {},
    } as unknown as AgentSessionLike;
  };
}

/** A scripted `## Verification` runner: one exit code per call, last repeats. */
function scriptedBlocks(exitCodes: number[]): { runBlockFn: RunBlockFn; calls: () => number } {
  let i = 0;
  return {
    runBlockFn: async () => {
      const code = exitCodes[Math.min(i++, exitCodes.length - 1)];
      return { exitCode: code, output: code === 0 ? "ok" : "boom" };
    },
    calls: () => i,
  };
}

/** ReviewCtx for a plain agent ticket; overrides pick the shape under test. */
function ctxFor(h: Harness, cfg: Config, task: Ticket, over: Partial<ReviewCtx> = {}): ReviewCtx {
  return {
    cfg,
    flowCfg: cfg,
    task,
    wtPath: h.work,
    sinceRef: "origin/main",
    amend: false,
    patchSeries: null,
    result: mainResult(),
    newCommits: 1,
    commits: [],
    appliedCleanly: false,
    applyFallback: null,
    mode: "agent",
    verifyDeps: {},
    makeAgentSessionFactory: commitSessionFactory("unused", h.work),
    deps: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPostSessionReview", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  it("skips the whole phase on a guard-aborted run: no verification, critic 'skipped'", async () => {
    const cfg = makeConfig(h, { criticEnabled: true });
    const blocks = scriptedBlocks([0]);
    const out = await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "aborted"), {
        result: mainResult({ abortedByGuard: true }),
        verifyDeps: { runBlockFn: blocks.runBlockFn },
        deps: {
          criticSessionFactory: () => {
            throw new Error("critic must not run on a guard-aborted session");
          },
        },
      }),
    );

    expect(out.verification).toBeNull();
    expect(out.criticResult?.status).toBe("skipped");
    expect(out.criticResult?.findings).toBe("aborted-by-repetition session");
    expect(out.extraUsages).toEqual([]);
    expect(blocks.calls()).toBe(0);
  });

  it("skips the whole phase on a timed-out run, naming the timeout in the critic record", async () => {
    const cfg = makeConfig(h, { criticEnabled: true });
    const out = await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "timedout"), { result: mainResult({ timedOut: true }) }),
    );

    expect(out.verification).toBeNull();
    expect(out.criticResult?.findings).toBe("timed-out session");
  });

  // --- Escalation ladder rung 2 (Stage 2b): clean apply + failed verification --

  it("rung 2: a clean apply whose verification fails escalates to the agent, re-verifies once", async () => {
    const cfg = makeConfig(h, { applyFallbackToAgent: true, criticEnabled: true });
    // First verification run fails; the post-fallback re-verify passes.
    const blocks = scriptedBlocks([1, 0]);
    const out = await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "rung2"), {
        patchSeries: SERIES,
        appliedCleanly: true,
        mode: "apply",
        result: mainResult({ finalText: "applied 1 patch" }),
        verifyDeps: { runBlockFn: blocks.runBlockFn },
        makeAgentSessionFactory: commitSessionFactory("fallback", h.work, 0.5),
        deps: { criticSessionFactory: criticFactory(["JUNCO_VERIFY: PASS"]) },
      }),
    );

    expect(out.applyFallback).toEqual({
      kind: "verification",
      reason: expect.stringContaining("0/1 verification checks passed"),
    });
    expect(out.mode).toBe("apply_fallback");
    // The critic-skip narrowing is released the moment the agent improvises.
    expect(out.applyClean).toBe(false);
    // Full fidelity: `result` IS the fallback session's own RunResult.
    expect(out.result.finalText).toBe("fallback");
    // Re-verified exactly once, and the second verdict is what stands.
    expect(blocks.calls()).toBe(2);
    expect(out.verification?.blocksPassed).toBe(1);
    expect(out.verification?.failedOutputs).toEqual([]);
    // Commits were re-counted after the fallback session committed.
    expect(out.newCommits).toBe(1);
    expect(out.commits.map((c) => c.subject)).toEqual(["feat: fallback-1.txt"]);
    // Releasing the narrowing means the critic actually ran on the improvised
    // diff — and only its usage is in extraUsages: the fallback's rides on
    // `result`, which is already sumUsage's base (pushing it would double-count).
    expect(out.criticResult?.status).toBe("pass");
    expect(out.extraUsages).toHaveLength(1);
  });

  it("rung 2 stays put when applyFallbackToAgent is off: mode 'apply', critic still skipped", async () => {
    const cfg = makeConfig(h, { applyFallbackToAgent: false });
    const blocks = scriptedBlocks([1]);
    const out = await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "rung2-off"), {
        patchSeries: SERIES,
        appliedCleanly: true,
        mode: "apply",
        verifyDeps: { runBlockFn: blocks.runBlockFn },
        makeAgentSessionFactory: () => {
          throw new Error("no agent session when applyFallbackToAgent is off");
        },
      }),
    );

    expect(out.applyFallback).toBeNull();
    expect(out.mode).toBe("apply");
    expect(out.applyClean).toBe(true);
    expect(out.criticResult?.status).toBe("skipped");
    expect(out.criticResult?.findings).toBe("apply mode — the patch series is the spec");
    expect(blocks.calls()).toBe(1);
    expect(out.verification?.failedOutputs).toHaveLength(1);
  });

  it("rung 2 never fires twice: a ticket that already fell back in Phase 4 is left alone", async () => {
    const cfg = makeConfig(h, { applyFallbackToAgent: true });
    const blocks = scriptedBlocks([1]);
    const rung1 = { kind: "apply" as const, reason: "CONFLICT (content): merge conflict" };
    const out = await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "rung1-then-2"), {
        patchSeries: SERIES,
        // Phase 4's rung already ran the agent, so appliedCleanly is false.
        appliedCleanly: false,
        applyFallback: rung1,
        mode: "apply_fallback",
        verifyDeps: { runBlockFn: blocks.runBlockFn },
        makeAgentSessionFactory: () => {
          throw new Error("the ladder must never escalate twice");
        },
      }),
    );

    // Rung 1's reason survives — rung 2 did not overwrite it.
    expect(out.applyFallback).toEqual(rung1);
    expect(out.mode).toBe("apply_fallback");
    expect(blocks.calls()).toBe(1);
  });

  it("a clean apply that verifies skips the critic but still records the verification", async () => {
    const cfg = makeConfig(h, { criticEnabled: true, applyFallbackToAgent: true });
    const blocks = scriptedBlocks([0]);
    const out = await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "clean-apply"), {
        patchSeries: SERIES,
        appliedCleanly: true,
        mode: "apply",
        verifyDeps: { runBlockFn: blocks.runBlockFn },
        deps: {
          criticSessionFactory: () => {
            throw new Error("apply mode must not run the critic");
          },
        },
      }),
    );

    expect(out.applyClean).toBe(true);
    expect(out.criticResult?.status).toBe("skipped");
    expect(out.verification?.blocksPassed).toBe(1);
    expect(out.extraUsages).toEqual([]);
  });

  // --- Escalation ladder rung: critic MISSING → one corrective re-dispatch ----

  it("critic MISSING re-dispatches one corrective turn, then re-runs critic + verification", async () => {
    const cfg = makeConfig(h, { criticEnabled: true, criticMaxRetries: 1 });
    const blocks = scriptedBlocks([0]);
    seedCommit(h); // the critic skips an empty diff
    const out = await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "critic-retry"), {
        verifyDeps: { runBlockFn: blocks.runBlockFn },
        makeAgentSessionFactory: commitSessionFactory("corrective", h.work),
        deps: {
          criticSessionFactory: criticFactory([
            "JUNCO_VERIFY: MISSING - the error path",
            "JUNCO_VERIFY: PASS",
          ]),
        },
      }),
    );

    expect(out.criticRetriesUsed).toBe(1);
    expect(out.criticResult?.status).toBe("pass");
    // critic pass 1 + corrective + critic pass 2 — the corrective's own usage
    // is in extraUsages here (unlike rung 2, which replaces `result`).
    expect(out.extraUsages).toHaveLength(3);
    // Verification ran once before the critic and once after the retry.
    expect(blocks.calls()).toBe(2);
    expect(out.commits.map((c) => c.subject)).toContain("feat: corrective-1.txt");
    // The main run's RunResult is untouched by a corrective re-dispatch.
    expect(out.result.finalText).toBe("main run");
  });

  it("critic MISSING does not re-dispatch in amend mode", async () => {
    const cfg = makeConfig(h, { criticEnabled: true, criticMaxRetries: 1 });
    const blocks = scriptedBlocks([0]);
    seedCommit(h);
    const out = await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "critic-amend"), {
        amend: true,
        verifyDeps: { runBlockFn: blocks.runBlockFn },
        makeAgentSessionFactory: () => {
          throw new Error("no corrective re-dispatch in amend mode");
        },
        deps: { criticSessionFactory: criticFactory(["JUNCO_VERIFY: MISSING - a thing"]) },
      }),
    );

    expect(out.criticRetriesUsed).toBe(0);
    expect(out.criticResult?.status).toBe("missing");
    expect(out.extraUsages).toHaveLength(1);
    expect(blocks.calls()).toBe(1);
  });

  it("records every critic pass's spend as it completes", async () => {
    const cfg = makeConfig(h, { criticEnabled: true, criticMaxRetries: 1 });
    const recorded: number[] = [];
    seedCommit(h);
    await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "critic-spend"), {
        verifyDeps: { runBlockFn: scriptedBlocks([0]).runBlockFn },
        makeAgentSessionFactory: commitSessionFactory("corrective", h.work),
        deps: {
          criticSessionFactory: criticFactory(
            ["JUNCO_VERIFY: MISSING - x", "JUNCO_VERIFY: PASS"],
            0.25,
          ),
          spend: { recordUsd: (usd) => recorded.push(usd) },
        },
      }),
    );

    // Both critic passes, plus the corrective session's own (via runEnveloped).
    expect(recorded.filter((u) => u === 0.25)).toHaveLength(2);
  });

  it("passes the ticket's commits and count straight through when nothing re-runs", async () => {
    const cfg = makeConfig(h, {});
    const commits = [{ sha: "abc1234", subject: "feat: from phase 7" }];
    const out = await runPostSessionReview(
      ctxFor(h, cfg, makeTicket(h, "passthrough"), {
        newCommits: 3,
        commits,
        verifyDeps: { runBlockFn: scriptedBlocks([0]).runBlockFn },
      }),
    );

    expect(out.newCommits).toBe(3);
    expect(out.commits).toBe(commits);
    expect(out.criticResult?.status).toBe("skipped");
    expect(out.criticResult?.findings).toBe("cfg.critic_enabled=false");
  });
});
