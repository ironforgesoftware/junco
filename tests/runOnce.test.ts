import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  chmodSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runOnce, claimNextTask } from "../src/runOnce.js";
import type { Config, Ticket, TicketGithub } from "../src/types.js";
import type { ProviderFailureClass } from "../src/providerFailure.js";
import type { AssessFlowResult } from "../src/assessFlow.js";
import type { AnalyzeFlowResult } from "../src/analyzeFlow.js";
import type { PrFlowResult } from "../src/prFlow.js";
import type { TaskRecord } from "../src/taskHistory.js";
import { listPending } from "../src/assessReview.js";
import { draftCount } from "../src/commentReview.js";
import { makeGithubReporter } from "../src/githubReport.js";
import { fakeSession, type FakeSessionFactory } from "./helpers/fakeSession.js";
import { makeSpendLedger } from "../src/spendLedger.js";
import { makeConfig } from "./helpers/config.js";

function cfg(root: string): Config {
  return makeConfig(
    {
      dataDir: root,
      queueRoot: join(root, "Junco"),
      worktreeRoot: "/tmp/worktrees",
      tools: ["read"],
      criticEnabled: true,
      planLintEnabled: true,
      verifyEnabled: true,
      supervisorEnabled: true,
      healthEnabled: false,
      removeWorktreeOnSuccess: true,
    },
    {
      defaultTimeoutMinutes: 1, // short so timeout paths are reachable in-test
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
    },
  );
}

// The default Q&A session: replies "reply!" with zero reported cost. The 5ms
// prompt() delay is the original local fixture's — long enough that the
// subscribe-time event burst always lands inside the awaited prompt.
function fakeFactory(): FakeSessionFactory {
  return fakeSession("reply!", 0, 5);
}

describe("runOnce", () => {
  it("processes a Q&A ticket to done/ with the reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "q1.md"), "---\nid: q1\n---\n# Q\nask\n", "utf8");

    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() });
    expect(handled).toBe(true);
    const doneFiles = readdirSync(join(j, "done"));
    expect(doneFiles).toHaveLength(1);
    expect(readFileSync(join(j, "done", doneFiles[0]), "utf8")).toContain("reply!");
    expect(readdirSync(join(j, "inbox"))).toHaveLength(0);
  });

  it("returns false when the inbox is empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(root, "Junco", d), { recursive: true }),
    );
    expect(await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() })).toBe(false);
  });

  it("claims a PR-flow ticket and routes a bad repo to failed/", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    // repo path does not exist → validateRepoContext throws → finalize to failed/.
    writeFileSync(
      join(j, "inbox", "pr.md"),
      "---\nid: pr\nrepo: /tmp/does-not-exist-junco\n---\n# PR\n",
      "utf8",
    );
    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() });
    expect(handled).toBe(true);
    // claimed + finalized to failed/ (not left in inbox)
    expect(readdirSync(join(j, "inbox"))).toHaveLength(0);
    const failedFiles = readdirSync(join(j, "failed"));
    expect(failedFiles).toHaveLength(1);
    expect(readFileSync(join(j, "failed", failedFiles[0]), "utf8")).toContain("status: failed");
  });

  it("skips an unreadable ticket but still processes a healthy one", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    // A directory named like a ticket makes readFileSync throw (EISDIR) → must be skipped.
    mkdirSync(join(j, "inbox", "bad.md"));
    writeFileSync(join(j, "inbox", "good.md"), "---\nid: good\n---\n# Q\nask\n", "utf8");

    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() });
    expect(handled).toBe(true);
    const doneFiles = readdirSync(join(j, "done"));
    expect(doneFiles).toHaveLength(1);
    expect(doneFiles[0]).toContain("good.md");
  });

  it("gives the Q&A session a read-only tool subset", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "q1.md"), "---\nid: q1\n---\n# Q\nask\n", "utf8");

    let receivedTools: string[] | undefined;
    const c: Config = {
      ...cfg(root),
      tools: ["read", "write", "bash", "edit", "grep", "find", "ls"],
    };
    await runOnce(c, {
      sessionFactoryFor: (passedCfg) => {
        receivedTools = passedCfg.tools;
        return fakeFactory();
      },
    });
    expect(receivedTools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("skips tickets whose not_before is in the future", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(
      join(j, "inbox", "future.md"),
      '---\nid: future\nnot_before: "2099-01-01T00:00:00Z"\n---\nq\n',
      "utf8",
    );
    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() });
    expect(handled).toBe(false);
    expect(readdirSync(join(j, "inbox"))).toEqual(["future.md"]); // not claimed
  });

  it("treats an unparseable not_before as eligible", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(
      join(j, "inbox", "odd.md"),
      '---\nid: odd\nnot_before: "not-a-date"\n---\nq\n',
      "utf8",
    );
    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory() });
    expect(handled).toBe(true);
  });

  it("readiness gate: does not claim when readyFn says the endpoint is down", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: () => fakeFactory(),
      readyFn: async () => false,
    });
    expect(handled).toBe(false);
    expect(readdirSync(join(j, "inbox"))).toEqual(["t.md"]); // still queued, not burned
  });

  it("Q&A transient error requeues to inbox instead of failing (budget permitting)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const erroringFactory = () => async () => ({
      subscribe() {
        return () => {};
      },
      async prompt() {
        throw new Error("fetch failed: ECONNREFUSED");
      },
      dispose() {},
      abort: async () => {},
    });
    const handled = await runOnce(cfg(root), { sessionFactoryFor: erroringFactory });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    expect(readdirSync(join(j, "processing"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 1/);
    expect(content).toMatch(/not_before:/);
  });

  it("Q&A transient error with exhausted budget finalizes to failed/ as before", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\nretry_count: 2\n---\nq\n", "utf8");
    const erroringFactory = () => async () => ({
      subscribe() {
        return () => {};
      },
      async prompt() {
        throw new Error("fetch failed: ECONNREFUSED");
      },
      dispose() {},
      abort: async () => {},
    });
    const handled = await runOnce(cfg(root), { sessionFactoryFor: erroringFactory });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "inbox"))).toHaveLength(0);
    expect(readdirSync(join(j, "failed"))).toHaveLength(1);
  });
});

describe("executeClaimed crash containment", () => {
  // The gap this guards: runAgent awaits the session factory OUTSIDE its
  // try/catch (src/agent/session.ts), so a factory rejection (e.g. model id
  // unresolvable at session-create time) propagates out of executeClaimed.
  // Without containment that strands the claimed ticket in processing/
  // (scheduler mode) or kills the daemon (serial mode).
  const rejectingFactory = () => async (): Promise<never> => {
    throw new Error("model unresolved at session create");
  };

  it("a rejecting session factory requeues the ticket instead of throwing (budget permitting)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");

    await expect(runOnce(cfg(root), { sessionFactoryFor: rejectingFactory })).resolves.toBe(true);
    expect(readdirSync(join(j, "processing"))).toHaveLength(0); // not stranded
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 1/);
    expect(content).toMatch(/not_before:/);
  });

  it("exhausted budget finalizes to failed/ with the error as the reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\nretry_count: 2\n---\nq\n", "utf8");

    await expect(runOnce(cfg(root), { sessionFactoryFor: rejectingFactory })).resolves.toBe(true);
    expect(readdirSync(join(j, "inbox"))).toHaveLength(0);
    expect(readdirSync(join(j, "processing"))).toHaveLength(0);
    const failed = readdirSync(join(j, "failed"));
    expect(failed).toHaveLength(1);
    const content = readFileSync(join(j, "failed", failed[0]), "utf8");
    expect(content).toContain("status: failed");
    expect(content).toContain("model unresolved at session create");
  });

  // Issue #115: the "both dispositions failed → leave in processing/ for orphan
  // recovery, never rethrow" branch (runOnce.ts) had zero coverage — every other
  // containment test keeps the finalize path alive. Here the requeue budget is
  // exhausted (retry_count:2, disposition #1 fails) AND failed/ is planted as a
  // regular file so finalize's mkdirSync(failed) throws EEXIST (disposition #2).
  it("leaves the ticket in processing/ without rethrowing when BOTH dispositions fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    writeFileSync(join(j, "failed"), "", "utf8"); // a FILE where finalize expects a dir
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\nretry_count: 2\n---\nq\n", "utf8");

    // Must resolve, not throw — a rethrow would crash-loop the daemon.
    await expect(runOnce(cfg(root), { sessionFactoryFor: rejectingFactory })).resolves.toBe(true);

    // Ticket stranded in processing/ for startup orphan recovery; the inbox was
    // drained by the claim, done/ stayed empty, and failed/ was never converted.
    expect(readdirSync(join(j, "processing"))).toHaveLength(1);
    expect(readdirSync(join(j, "inbox"))).toHaveLength(0);
    expect(readdirSync(join(j, "done"))).toHaveLength(0);
  });

  it("fires onRequeue (contained crash, budget left) and onFinal (budget exhausted)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    const calls: string[] = [];
    const reporter = {
      onStart: async () => void calls.push("start"),
      onRequeue: async () => void calls.push("requeue"),
      onFinal: async (_t: unknown, o: { status: string }) => void calls.push(`final:${o.status}`),
    };

    writeFileSync(join(j, "inbox", "a.md"), "---\nid: a\n---\nq\n", "utf8");
    await runOnce(cfg(root), { sessionFactoryFor: rejectingFactory, reporter });
    expect(calls).toEqual(["start", "requeue"]);

    calls.length = 0;
    writeFileSync(join(j, "inbox", "b.md"), "---\nid: b\nretry_count: 2\n---\nq\n", "utf8");
    await runOnce(cfg(root), { sessionFactoryFor: rejectingFactory, reporter });
    expect(calls).toEqual(["start", "final:failed"]);
  });
});

/** A session factory whose fake session's prompt() rejects with `message` —
 * surfaces as result.errorMessage (see agent/session.ts's outer catch). */
function erroringFactory(message: string) {
  return () => async () => ({
    subscribe() {
      return () => {};
    },
    async prompt() {
      throw new Error(message);
    },
    dispose() {},
    abort: async () => {},
  });
}

/** Records calls made by the code under test; a plain object satisfying
 * `Pick<ProviderGate, "reportFailure" | "reportSuccess" | "notBeforeIso">` —
 * no need to pull in the real latching state machine for these tests. */
function fakeGate(notBefore = "2099-01-01T00:00:00.000Z") {
  const failureCalls: { cls: ProviderFailureClass; reason: string }[] = [];
  let successCalls = 0;
  return {
    failureCalls,
    get successCalls() {
      return successCalls;
    },
    reportFailure(cls: ProviderFailureClass, reason: string) {
      failureCalls.push({ cls, reason });
    },
    reportSuccess() {
      successCalls += 1;
    },
    notBeforeIso() {
      return notBefore;
    },
  };
}

/** Records recordUsd calls; a plain object satisfying
 * `Pick<SpendLedger, "recordUsd">` — mirrors fakeGate above (no need to pull
 * in the real persisted-file ledger for wiring tests). */
function fakeSpend(): { calls: number[]; recordUsd: (usd: number) => void } {
  const calls: number[] = [];
  return {
    calls,
    recordUsd(usd: number) {
      calls.push(usd);
    },
  };
}

/** A Q&A session that emits ONE turn_end carrying a cost, then finishes
 * cleanly (stopReason "stop", no errorMessage) — the happy-path costed run. */
function costedFactory(costUsd: number) {
  return () => async () => {
    let listener: ((e: any) => void) | null = null;
    return {
      subscribe(l: (e: any) => void) {
        listener = l;
        queueMicrotask(() => {
          listener?.({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "reply!" },
          });
          listener?.({
            type: "turn_end",
            message: {
              stopReason: "stop",
              usage: {
                input: 3,
                output: 4,
                cacheRead: 0,
                totalTokens: 7,
                cost: { total: costUsd },
              },
            },
          });
          listener?.({ type: "agent_end", messages: [], willRetry: false });
        });
        return () => {};
      },
      async prompt() {
        await new Promise((r) => setTimeout(r, 1));
      },
      dispose() {},
      abort: async () => {},
    };
  };
}

/** A Q&A session that emits ONE turn_end carrying BOTH a cost and a
 * non-null errorMessage (stopReason "error") — costUsd > 0 but the run is
 * transient (isTransientFailure: errorMessage !== null) and requeues. */
function costedTransientFactory(costUsd: number, errorMessage: string) {
  return () => async () => {
    let listener: ((e: any) => void) | null = null;
    return {
      subscribe(l: (e: any) => void) {
        listener = l;
        queueMicrotask(() => {
          listener?.({
            type: "turn_end",
            message: {
              stopReason: "error",
              errorMessage,
              usage: {
                input: 3,
                output: 4,
                cacheRead: 0,
                totalTokens: 7,
                cost: { total: costUsd },
              },
            },
          });
          listener?.({ type: "agent_end", messages: [], willRetry: false });
        });
        return () => {};
      },
      async prompt() {
        await new Promise((r) => setTimeout(r, 1));
      },
      dispose() {},
      abort: async () => {},
    };
  };
}

describe("spend ledger wiring (Phase 3 Task 4)", () => {
  it("a completed Q&A run records once with the run's costUsd", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const spend = fakeSpend();

    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: costedFactory(0.0456),
      spend,
    });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
    expect(spend.calls).toHaveLength(1);
    expect(spend.calls[0]).toBeCloseTo(0.0456);
  });

  it("a run that ends in a REQUEUE is still recorded — the ledger counts money spent regardless of the ticket's disposition", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const spend = fakeSpend();

    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: costedTransientFactory(0.0789, "agent gave up"),
      spend,
    });
    expect(handled).toBe(true);
    // Requeued (budgeted path), not failed/done — pin the requeue explicitly.
    expect(readdirSync(join(j, "done"))).toHaveLength(0);
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    expect(readFileSync(join(j, "inbox", inbox[0]), "utf8")).toMatch(/retry_count: 1/);
    // ...yet the session's spend was still recorded.
    expect(spend.calls).toHaveLength(1);
    expect(spend.calls[0]).toBeCloseTo(0.0789);
  });

  it("no spend dep in deps → recording is a no-op; the run completes exactly as it would without the ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");

    // A costed session, but `spend` is absent from deps — must not throw, and
    // the ticket must finalize exactly as the pre-ledger behavior did.
    const handled = await runOnce(cfg(root), { sessionFactoryFor: costedFactory(0.01) });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
  });

  it("a fake session reporting costUsd 0 records nothing on disk (recordUsd's own zero-guard, not a special case here)", async () => {
    // Uses the REAL makeSpendLedger rather than the plain fakeSpend() spy:
    // runOnce/executeClaimed call `recordUsd(costUsd)` UNCONDITIONALLY (no
    // zero-check of their own — recordUsd's guard is the ledger's job, per
    // the brief), so this pins that a zero-cost fake session (fakeFactory's
    // turn_end carries no `cost` field, so costUsd defaults to 0) still
    // leaves the persisted ledger untouched.
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const stateDir = join(root, "state");
    const spend = makeSpendLedger(stateDir);

    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory(), spend });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
    expect(spend.todayUsd()).toBe(0);
    expect(existsSync(join(stateDir, "spend.json"))).toBe(false);
  });
});

describe("provider gate wiring (Phase 2 Task 5)", () => {
  it("gate-class Q&A failure (401 auth) requeues WITHOUT consuming the retry budget and reports to the gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const gate = fakeGate();
    const calls: string[] = [];
    const reporter = {
      onStart: async () => void calls.push("start"),
      onRequeue: async () => void calls.push("requeue"),
      onFinal: async () => void calls.push("final"),
    };

    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: erroringFactory("401 invalid x-api-key"),
      gate,
      reporter,
    });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    expect(readdirSync(join(j, "processing"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).not.toMatch(/retry_count:/); // absent, not bumped
    expect(content).toMatch(/not_before:/);
    expect(gate.failureCalls).toHaveLength(1);
    expect(gate.failureCalls[0]?.cls).toBe("auth");
    expect(calls).toEqual(["start", "requeue"]);
  });

  it("gate-class Q&A failure (429 rate limit) reports rate_limit and requeues count-free", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const gate = fakeGate();

    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: erroringFactory("429 rate limited"),
      gate,
    });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).not.toMatch(/retry_count:/);
    expect(content).toMatch(/not_before:/);
    expect(gate.failureCalls).toEqual([{ cls: "rate_limit", reason: "429 rate limited" }]);
  });

  it("crash containment classifies a catalog-miss session-build throw as model_not_found and gate-routes it count-free", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    // retry_count already at the budget cap — proves the gate path bypasses
    // the budget check entirely rather than just having budget left.
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\nretry_count: 2\n---\nq\n", "utf8");
    const catalogMissFactory = () => async (): Promise<never> => {
      throw new Error(
        'model "anthropic/nope": provider "anthropic" did not resolve from the builtin catalog and ' +
          "no inline endpoint is configured — set model.baseUrl + model.apiKey, point " +
          "model.modelsJson at a Pi models.json, or use a catalog provider id.",
      );
    };
    const gate = fakeGate();

    const handled = await runOnce(cfg(root), { sessionFactoryFor: catalogMissFactory, gate });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    expect(readdirSync(join(j, "processing"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 2/); // unchanged, not consumed
    expect(gate.failureCalls).toHaveLength(1);
    expect(gate.failureCalls[0]?.cls).toBe("model_not_found");
  });

  it("plain-text Q&A error with a gate present still uses the existing budgeted requeue path and does not latch the gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const gate = fakeGate();

    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: erroringFactory("agent gave up"),
      gate,
    });
    expect(handled).toBe(true);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 1/); // budgeted path consumed the count
    expect(gate.failureCalls).toEqual([]); // no latch — classifier says unknown
  });

  it("a successful Q&A run reports success to the gate exactly once, just before finalize", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const gate = fakeGate();

    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory(), gate });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
    expect(gate.successCalls).toBe(1);
    expect(gate.failureCalls).toEqual([]);
  });

  it("a recovered auto-retry blip (turn_end error -> auto_retry_end success -> clean turn_end) finalizes to done/ and reports SUCCESS, not failure", async () => {
    // Regression pin for the CRITICAL fix in src/agent/runResult.ts: the SDK
    // emits turn_end for the errored attempt BEFORE deciding to retry, and
    // when the retry recovers it emits auto_retry_end{success:true} with no
    // finalError. Before the fix, the first attempt's errorMessage survived
    // (null-guarded first-wins never got cleared), so a fully-recovered run
    // would gate-route as a rate_limit failure (count-free requeue) instead
    // of finalizing to done/ and reporting success.
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const gate = fakeGate();
    const recoveredBlipFactory = () => async () => ({
      subscribe(l: (e: any) => void) {
        queueMicrotask(() => {
          l({
            type: "turn_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "429 overloaded",
              usage: { input: 0, output: 0 },
            },
          });
          l({ type: "auto_retry_end", success: true, attempt: 1 });
          l({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "all good now" },
          });
          l({
            type: "turn_end",
            message: {
              role: "assistant",
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
            },
          });
          l({ type: "agent_end", messages: [], willRetry: false });
        });
        return () => {};
      },
      async prompt() {
        await new Promise((r) => setTimeout(r, 5));
      },
      dispose() {},
      abort: async () => {},
    });

    const handled = await runOnce(cfg(root), { sessionFactoryFor: recoveredBlipFactory, gate });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    expect(gate.successCalls).toBe(1);
    expect(gate.failureCalls).toEqual([]);
  });

  it("Q&A outage error reports to the gate but still requeues via the BUDGETED path", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const gate = fakeGate();

    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: erroringFactory("connect ECONNREFUSED 127.0.0.1:1234"),
      gate,
    });
    expect(handled).toBe(true);
    expect(gate.failureCalls).toEqual([
      { cls: "outage", reason: "connect ECONNREFUSED 127.0.0.1:1234" },
    ]);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 1/); // budgeted path, NOT the gate's count-free one
    expect(content).toMatch(/not_before:/);
  });

  it("crash containment: an outage-class factory reject reports to the gate but keeps the BUDGETED requeue path", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const outageFactory = () => async (): Promise<never> => {
      throw new Error("fetch failed");
    };
    const gate = fakeGate();

    const handled = await runOnce(cfg(root), { sessionFactoryFor: outageFactory, gate });
    expect(handled).toBe(true);
    expect(gate.failureCalls).toEqual([{ cls: "outage", reason: "fetch failed" }]);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 1/); // budgeted path, NOT the gate's count-free one
    expect(content).toMatch(/not_before:/);
  });

  it("crash containment: an arbitrary 403 in a thrown reason does NOT gate-latch (false-latch guard) — budgeted requeue instead", async () => {
    // The crash site classifies ARBITRARY exception text (a rejecting session
    // factory, a git/gh error, even a ticket filename echoed into a message),
    // never the SDK's structured in-session errorMessage. Bare \b40[13]\b /
    // \b429\b patterns can false-positive against that text (e.g. a gh CLI
    // error mentioning an HTTP 403). auth/quota/rate_limit route through
    // GATE_CLASSES into the gate's LATCHED states (auth_error/
    // quota_exhausted) — a false latch here BLOCKS CLAIMING and only clears
    // on an explicit success, but a latch that never lets a ticket run can
    // never produce that success, freezing the queue forever. So only
    // model_not_found (the resolution-failure throw class this crash site
    // was actually built for) gets gate-class routing at THIS site; auth/
    // quota/rate_limit fall through to the unknown/budgeted path.
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const forbiddenFactory = () => async (): Promise<never> => {
      throw new Error("gh: HTTP 403 Forbidden from api.github.com");
    };
    const gate = fakeGate();

    const handled = await runOnce(cfg(root), { sessionFactoryFor: forbiddenFactory, gate });
    expect(handled).toBe(true);
    expect(gate.failureCalls).toEqual([]); // NOT gate-routed — not model_not_found, not outage
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    expect(readdirSync(join(j, "processing"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 1/); // budgeted path, not the gate's count-free one
    expect(content).toMatch(/not_before:/);
  });

  it("Q&A timeout with a stale gate-class errorMessage does not take the count-free path (parity with prFlow's hardError guard)", async () => {
    // A timeout landing mid-retry-backoff leaves the FIRST attempt's
    // errorMessage captured (no clean auto_retry_end ever fires — the
    // timeout aborts the run first), so classifying it as gate-class here
    // would wrongly report to the gate and requeue count-free. timedOut must
    // win: existing timeout semantics (routes to failed/ as "timeout") apply
    // instead, exactly like prFlow's `hardError` guard excludes timedOut.
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\ntimeout_minutes: 0.001\n---\nq\n", "utf8");
    const gate = fakeGate();
    const timedOutRateLimitFactory = () => async () => {
      let resolvePrompt: (() => void) | undefined;
      return {
        subscribe(l: (e: any) => void) {
          queueMicrotask(() => {
            l({
              type: "turn_end",
              message: {
                role: "assistant",
                stopReason: "error",
                errorMessage: "429 rate limited",
                usage: { input: 0, output: 0 },
              },
            });
          });
          return () => {};
        },
        async prompt() {
          // Never resolves on its own; only the timeout's abort() unblocks it.
          return new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          });
        },
        dispose() {},
        abort: async () => {
          resolvePrompt?.();
        },
      };
    };

    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: timedOutRateLimitFactory,
      gate,
    });
    expect(handled).toBe(true);
    expect(gate.failureCalls).toEqual([]); // gate NOT consulted for count-free routing
    expect(gate.successCalls).toBe(0);
    const failed = readdirSync(join(j, "failed"));
    expect(failed).toHaveLength(1); // existing timeout semantics: routes to failed/ as "timeout"
    const content = readFileSync(join(j, "failed", failed[0]), "utf8");
    expect(content).toContain("status: timeout");
  });

  it("Q&A timeout with a stale OUTAGE-class errorMessage does not report to the gate (#180, parity with prFlow's hardError guard)", async () => {
    // Sibling of the 429 case above, but for the outage branch (runOnce.ts:396),
    // which was NOT behind the !timedOut && !abortedByGuard guard: a timeout
    // landing mid-retry-backoff leaves the first attempt's outage-class
    // errorMessage captured; reporting it would push the SHARED gate into
    // outage_backoff and pause claiming for other tickets. timedOut must win.
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\ntimeout_minutes: 0.001\n---\nq\n", "utf8");
    const gate = fakeGate();
    const timedOutOutageFactory = () => async () => {
      let resolvePrompt: (() => void) | undefined;
      return {
        subscribe(l: (e: any) => void) {
          queueMicrotask(() => {
            l({
              type: "turn_end",
              message: {
                role: "assistant",
                stopReason: "error",
                errorMessage: "fetch failed",
                usage: { input: 0, output: 0 },
              },
            });
          });
          return () => {};
        },
        async prompt() {
          return new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          });
        },
        dispose() {},
        abort: async () => {
          resolvePrompt?.();
        },
      };
    };

    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: timedOutOutageFactory,
      gate,
    });
    expect(handled).toBe(true);
    expect(gate.failureCalls).toEqual([]); // the :396 outage report is suppressed by the timeout guard
    expect(gate.successCalls).toBe(0);
    const failed = readdirSync(join(j, "failed"));
    expect(failed).toHaveLength(1); // existing timeout semantics: routes to failed/ as "timeout"
    const content = readFileSync(join(j, "failed", failed[0]), "utf8");
    expect(content).toContain("status: timeout");
  });

  it("without a gate in deps, a 401 error falls back to the existing budgeted requeue path (byte-identical pre-gate behavior)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");

    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: erroringFactory("401 invalid x-api-key"),
    });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 1/); // budgeted path, not the gate's count-free path
    expect(content).toMatch(/not_before:/);
  });
});

/** Transcript writes go through an async createWriteStream (agent/session.ts),
 * so a single synchronous readdirSync right after the run can beat the first
 * flush on a fast/slow CI runner (issue #157). Loop-until-condition with a
 * bounded retry instead, per the repo's async-race guidance. */
async function untilTranscriptWritten(dir: string, name: string, ms = 3000): Promise<string[]> {
  const start = Date.now();
  let entries: string[] = [];
  while (Date.now() - start < ms) {
    entries = existsSync(dir) ? readdirSync(dir) : [];
    if (entries.includes(name)) return entries;
    await new Promise((r) => setTimeout(r, 10));
  }
  return entries;
}

describe("transcript path sanitization (issue #32)", () => {
  it("slugifies a path-traversal frontmatter id before building the transcript path", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    // A hostile id that would escape dataDir/transcripts/ if used verbatim.
    writeFileSync(
      join(j, "inbox", "evil.md"),
      "---\nid: ../../../../pwned\n---\n# Q\nask\n",
      "utf8",
    );
    const stateDir = join(root, "state");
    const c: Config = { ...cfg(root), dataDir: stateDir, transcriptsEnabled: true };

    await runOnce(c, { sessionFactoryFor: () => fakeFactory() });

    // The transcript must live inside dataDir/transcripts/ as a single inert
    // filename — never at the traversal target. Poll until the async stream
    // flushes it rather than asserting on a single synchronous readdirSync
    // (issue #157).
    const transcriptsDir = join(stateDir, "transcripts");
    const expectedName = "..-..-..-..-pwned.jsonl";
    const written = await untilTranscriptWritten(transcriptsDir, expectedName);
    expect(written).toContain(expectedName);
    // The traversal target (root/pwned.jsonl) must NOT exist.
    expect(existsSync(join(root, "pwned.jsonl"))).toBe(false);
  });
});

describe("per-ticket tools override", () => {
  it("Q&A default stays read-only; a tools: frontmatter overrides it verbatim", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    const seen: string[][] = [];
    const capturing = (passedCfg: Config) => {
      seen.push(passedCfg.tools);
      return fakeFactory()();
    };
    const c: Config = {
      ...cfg(root),
      tools: ["read", "write", "bash", "edit", "grep", "find", "ls"],
    };

    writeFileSync(join(j, "inbox", "plain.md"), "---\nid: plain\n---\nq\n", "utf8");
    await runOnce(c, { sessionFactoryFor: (pc) => () => capturing(pc) });
    expect(seen[0]).toEqual(["read", "grep", "find", "ls"]);

    writeFileSync(
      join(j, "inbox", "bashy.md"),
      "---\nid: bashy\ntools: [read, bash]\n---\nq\n",
      "utf8",
    );
    await runOnce(c, { sessionFactoryFor: (pc) => () => capturing(pc) });
    expect(seen[1]).toEqual(["read", "bash"]);
  });
});

describe("reporter seam", () => {
  it("fires onStart then onFinal for a completed Q&A ticket", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "q.md"), "---\nid: q\n---\nask\n", "utf8");
    const calls: string[] = [];
    const reporter = {
      onStart: async () => void calls.push("start"),
      onRequeue: async () => void calls.push("requeue"),
      onFinal: async (_t: unknown, o: { status: string }) => void calls.push(`final:${o.status}`),
    };
    await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory(), reporter });
    expect(calls).toEqual(["start", "final:completed"]);
  });

  it("fires onStart then onRequeue for a transiently-failing Q&A ticket", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "q.md"), "---\nid: q\n---\nask\n", "utf8");
    const erroring = () => async () => ({
      subscribe() {
        return () => {};
      },
      async prompt() {
        throw new Error("fetch failed: ECONNREFUSED");
      },
      dispose() {},
      abort: async () => {},
    });
    const calls: string[] = [];
    const reporter = {
      onStart: async () => void calls.push("start"),
      onRequeue: async () => void calls.push("requeue"),
      onFinal: async () => void calls.push("final"),
    };
    await runOnce(cfg(root), { sessionFactoryFor: erroring, reporter });
    expect(calls).toEqual(["start", "requeue"]);
  });

  it("a throwing reporter never fails the ticket", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "q.md"), "---\nid: q\n---\nask\n", "utf8");
    const reporter = {
      onStart: async () => {
        throw new Error("reporter down");
      },
      onRequeue: async () => {
        throw new Error("reporter down");
      },
      onFinal: async () => {
        throw new Error("reporter down");
      },
    };
    const handled = await runOnce(cfg(root), { sessionFactoryFor: () => fakeFactory(), reporter });
    expect(handled).toBe(true);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
  });
});

describe("Q&A workdir", () => {
  function sandbox() {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    return { root, j };
  }

  it("runs the session in a valid workdir", async () => {
    const { root, j } = sandbox();
    const wd = mkdtempSync(join(tmpdir(), "junco-wd-"));
    writeFileSync(join(j, "inbox", "q.md"), `---\nid: q\nworkdir: ${wd}\n---\nask\n`, "utf8");
    let seenCwd = "";
    await runOnce(cfg(root), {
      sessionFactoryFor: (_c, cwd) => {
        seenCwd = cwd;
        return fakeFactory();
      },
    });
    expect(seenCwd).toBe(wd);
  });

  it("falls back to processing/ when workdir does not exist", async () => {
    const { root, j } = sandbox();
    writeFileSync(
      join(j, "inbox", "q.md"),
      "---\nid: q\nworkdir: /nonexistent-junco-dir\n---\nask\n",
      "utf8",
    );
    let seenCwd = "";
    await runOnce(cfg(root), {
      sessionFactoryFor: (_c, cwd) => {
        seenCwd = cwd;
        return fakeFactory();
      },
    });
    expect(seenCwd).toBe(join(j, "processing"));
  });

  it("falls back to processing/ when workdir is outside allowed_repo_roots", async () => {
    const { root, j } = sandbox();
    const wd = mkdtempSync(join(tmpdir(), "junco-wd-"));
    writeFileSync(join(j, "inbox", "q.md"), `---\nid: q\nworkdir: ${wd}\n---\nask\n`, "utf8");
    let seenCwd = "";
    const c: Config = { ...cfg(root), allowedRepoRoots: ["/somewhere-else-entirely"] };
    await runOnce(c, {
      sessionFactoryFor: (_c, cwd) => {
        seenCwd = cwd;
        return fakeFactory();
      },
    });
    expect(seenCwd).toBe(join(j, "processing"));
  });
});

describe("claimNextTask (per-repo serialization)", () => {
  it("skips tickets whose repoKey is busy and claims the next eligible", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-claim-"));
    const j = join(root, "Junco");
    ["inbox", "processing"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    const repoA = join(root, "repoA");
    const repoB = join(root, "repoB");
    writeFileSync(join(j, "inbox", "r1.md"), `---\nid: r1\nrepo: ${repoA}\n---\nx\n`, "utf8");
    writeFileSync(join(j, "inbox", "r2.md"), `---\nid: r2\nrepo: ${repoB}\n---\nx\n`, "utf8");
    const w = await claimNextTask(cfg(root), { skipRepoKeys: new Set([repoA]) });
    expect(w?.ticket.id).toBe("r2");
    expect(w?.repoKey).toBe(repoB);
  });

  it("returns null when everything is gated on busy repos", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-claim-"));
    const j = join(root, "Junco");
    ["inbox", "processing"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    const repoA = join(root, "repoA");
    writeFileSync(join(j, "inbox", "r1.md"), `---\nid: r1\nrepo: ${repoA}\n---\nx\n`, "utf8");
    const w = await claimNextTask(cfg(root), { skipRepoKeys: new Set([repoA]) });
    expect(w).toBeNull();
    expect(readdirSync(join(j, "inbox"))).toEqual(["r1.md"]); // left queued
  });

  it("Q&A tickets have a null repoKey (never repo-gated)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-claim-"));
    const j = join(root, "Junco");
    ["inbox", "processing"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    writeFileSync(join(j, "inbox", "q.md"), "---\nid: q\n---\nx\n", "utf8");
    const w = await claimNextTask(cfg(root), { skipRepoKeys: new Set(["/anything"]) });
    expect(w?.ticket.id).toBe("q");
    expect(w?.repoKey).toBeNull();
  });

  // Issue #113: two spellings of ONE repo (a symlink alias, or a case-variant on
  // a case-insensitive filesystem) must serialize. repoKey is canonicalized via
  // realpath so aliased paths collapse to a single busy key.
  it("collapses symlink-aliased repo paths onto one canonical busy key", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-claim-"));
    const j = join(root, "Junco");
    ["inbox", "processing"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    // One real repo plus a symlink alias pointing at it. Two tickets name the
    // same repo two ways: the real path and the alias.
    const realRepo = join(root, "repo");
    mkdirSync(realRepo, { recursive: true });
    const aliasRepo = join(root, "repo-alias");
    symlinkSync(realRepo, aliasRepo);
    writeFileSync(join(j, "inbox", "r1.md"), `---\nid: r1\nrepo: ${realRepo}\n---\nx\n`, "utf8");
    writeFileSync(join(j, "inbox", "r2.md"), `---\nid: r2\nrepo: ${aliasRepo}\n---\nx\n`, "utf8");

    // Claim r1 first (nothing busy) — its repoKey is the canonical realpath.
    const w1 = await claimNextTask(cfg(root));
    expect(w1?.ticket.id).toBe("r1");
    expect(w1?.repoKey).toBe(realpathSync.native(realRepo));

    // With r1's repo marked busy, the alias-spelled r2 must hash to that same
    // key and stay queued — the same-repo serialization invariant survives the
    // aliased spelling (pre-fix the lexical alias key differs and r2 is claimed).
    const w2 = await claimNextTask(cfg(root), { skipRepoKeys: new Set([w1!.repoKey!]) });
    expect(w2).toBeNull();
    expect(readdirSync(join(j, "inbox"))).toEqual(["r2.md"]); // left queued
  });
});

describe("claimNextTask (priority ordering)", () => {
  // Issue #115: claimNextTask's priority sort (high>normal>low) had no direct
  // test — only the TUI display sort was covered. Filenames here sort a<b<c,
  // the INVERSE of priority, so a filename-order claim would take low first.
  it("claims high before normal before low, regardless of filename order", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-prio-"));
    const j = join(root, "Junco");
    ["inbox", "processing"].forEach((d) => mkdirSync(join(j, d), { recursive: true }));
    writeFileSync(join(j, "inbox", "a.md"), "---\nid: low\npriority: low\n---\nx\n", "utf8");
    writeFileSync(join(j, "inbox", "b.md"), "---\nid: normal\npriority: normal\n---\nx\n", "utf8");
    writeFileSync(join(j, "inbox", "c.md"), "---\nid: high\npriority: high\n---\nx\n", "utf8");

    // Each claim re-discovers the inbox and takes the highest-priority ticket
    // remaining, draining high → normal → low.
    const first = await claimNextTask(cfg(root));
    const second = await claimNextTask(cfg(root));
    const third = await claimNextTask(cfg(root));
    expect([first?.ticket.id, second?.ticket.id, third?.ticket.id]).toEqual([
      "high",
      "normal",
      "low",
    ]);
  });
});

describe("planner model override", () => {
  it("plan-kind tickets swap cfg.model.id when planner_model_id is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(
      join(j, "inbox", "p.md"),
      `---\nid: gh-a-b-1-plan\ngithub:\n  nwo: a/b\n  issue: 1\n  kind: plan\n---\nplan prompt\n`,
      "utf8",
    );
    const c: Config = {
      ...cfg(root),
      github: { ...cfg(root).github, plannerModelId: "prov/big" },
    };
    let seenModelId = "";
    await runOnce(c, {
      sessionFactoryFor: (passedCfg) => {
        seenModelId = passedCfg.model.id;
        return fakeFactory();
      },
    });
    expect(seenModelId).toBe("prov/big");
  });

  it("non-plan tickets keep the configured model", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "q.md"), "---\nid: q\n---\nask\n", "utf8");
    const c: Config = {
      ...cfg(root),
      github: { ...cfg(root).github, plannerModelId: "prov/big" },
    };
    let seenModelId = "";
    await runOnce(c, {
      sessionFactoryFor: (passedCfg) => {
        seenModelId = passedCfg.model.id;
        return fakeFactory();
      },
    });
    expect(seenModelId).toBe(cfg(root).model.id);
  });
});

describe("assess routing", () => {
  // A zeroed RunResult, mirroring assessFlow.ts's emptyRunResult — the fake
  // assessFlowFn below needs a well-formed `result` field on its
  // AssessFlowResult since outcomeFromQa dereferences it.
  function fakeRunResult(finalText: string): AssessFlowResult["result"] {
    return {
      finalText,
      toolCalls: [],
      usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
      stopReason: "stop",
      errorMessage: null,
      timedOut: false,
      durationMs: 5,
      abortedByGuard: false,
    };
  }

  it("branch ordering: an assess ticket (which also carries repo:) is routed to the assess flow, never the PR flow", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    // A repo: that a PR flow would happily accept (deriveRepoContext only
    // needs a truthy string — it doesn't check existence), PLUS assess: {}.
    // If the branch order regresses (hasRepo checked first), this ticket
    // gets routed into runPrFlow instead of the fake assessFlowFn below.
    const repo = mkdtempSync(join(tmpdir(), "junco-assess-repo-"));
    const wtRoot = mkdtempSync(join(tmpdir(), "junco-assess-wt-"));
    writeFileSync(
      join(j, "inbox", "a.md"),
      `---\nid: assess-1\nassess: {}\nrepo: ${repo}\n---\n# Assess\nscan for vulns\n`,
      "utf8",
    );

    const assessCalls: Array<{ cfg: Config; ticketId: string; claimedPath: string }> = [];
    const fakeAssessFlowFn = async (
      passedCfg: Config,
      ticket: Ticket,
      claimedPath: string,
    ): Promise<AssessFlowResult> => {
      assessCalls.push({ cfg: passedCfg, ticketId: ticket.id, claimedPath });
      return {
        dst: join(j, "done", "a.md"),
        status: "completed",
        requeued: false,
        result: fakeRunResult("assess done"),
        found: 0,
        deduped: 0,
        dropped: 0,
        parked: 0,
      };
    };

    let sessionFactoryCalls = 0;
    const finalCalls: Array<{ kind: string; status: string; finalText: string }> = [];
    const requeueCalls: string[] = [];
    const reporter = {
      onStart: async (): Promise<void> => undefined,
      onRequeue: async (): Promise<void> => void requeueCalls.push("requeue"),
      onFinal: async (
        _t: unknown,
        o: { kind: string; status: string; finalText: string },
      ): Promise<void> => void finalCalls.push(o),
    };

    const c: Config = { ...cfg(root), worktreeRoot: wtRoot };
    const handled = await runOnce(c, {
      assessFlowFn: fakeAssessFlowFn,
      sessionFactoryFor: () => {
        sessionFactoryCalls++;
        return fakeFactory();
      },
      reporter,
    });

    expect(handled).toBe(true);
    // The fake assess flow was invoked with the right ticket — proves the
    // assess branch fired.
    expect(assessCalls).toHaveLength(1);
    expect(assessCalls[0].ticketId).toBe("assess-1");
    // The PR flow was NOT entered: its session factory (shared seam) was
    // never invoked, and it never touched the worktree root.
    expect(sessionFactoryCalls).toBe(0);
    expect(readdirSync(wtRoot)).toHaveLength(0);
    // Reporter got the assess flow's outcome as a qa-kind final.
    expect(requeueCalls).toHaveLength(0);
    expect(finalCalls).toHaveLength(1);
    expect(finalCalls[0]).toMatchObject({
      kind: "qa",
      status: "completed",
      finalText: "assess done",
    });
  });

  it("requeue parity: a requeued assess flow fires onRequeue, not onFinal", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    const repo = mkdtempSync(join(tmpdir(), "junco-assess-repo-"));
    writeFileSync(
      join(j, "inbox", "a.md"),
      `---\nid: assess-2\nassess: {}\nrepo: ${repo}\n---\n# Assess\nscan for vulns\n`,
      "utf8",
    );

    const fakeAssessFlowFn = async (): Promise<AssessFlowResult> => ({
      dst: join(j, "inbox", "a.md"),
      status: "requeued",
      requeued: true,
      result: fakeRunResult(""),
      found: 0,
      deduped: 0,
      dropped: 0,
      parked: 0,
    });

    const calls: string[] = [];
    const reporter = {
      onStart: async (): Promise<void> => void calls.push("start"),
      onRequeue: async (): Promise<void> => void calls.push("requeue"),
      onFinal: async (): Promise<void> => void calls.push("final"),
    };

    const handled = await runOnce(cfg(root), { assessFlowFn: fakeAssessFlowFn, reporter });

    expect(handled).toBe(true);
    expect(calls).toEqual(["start", "requeue"]);
  });

  it("end-to-end through the real assess flow: parks the finding for review and lands the ticket in done/", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );

    // A real tiny git repo — the assess target — with one committed file the
    // agent's finding will cite (the hallucination filter requires the cited
    // path to exist on disk).
    const repo = mkdtempSync(join(tmpdir(), "junco-assess-e2e-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;\n", "utf8");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "CI",
      GIT_AUTHOR_EMAIL: "ci@example.com",
      GIT_COMMITTER_NAME: "CI",
      GIT_COMMITTER_EMAIL: "ci@example.com",
    };
    const runGit = (args: string[]): void => {
      execFileSync("git", args, { cwd: repo, env: gitEnv });
    };
    runGit(["init", "-q", "-b", "main"]);
    runGit(["config", "commit.gpgsign", "false"]);
    runGit(["add", "src/index.ts"]);
    runGit(["commit", "-q", "-m", "seed"]);
    runGit(["remote", "add", "origin", "git@github.com:acme/demo.git"]);

    // A fake gh script that logs every invocation. The audit only issues the
    // author-scoped dedup `issue list` now (parking never files); the create
    // arm stays scripted so a regression that re-files would surface loudly.
    const ghLog = join(root, "gh.log");
    const ghBin = join(root, "fake-gh.sh");
    writeFileSync(
      ghBin,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
case "$1 $2" in
  "issue list") echo '[]'; exit 0 ;;
  "label create") exit 0 ;;
  "issue create") echo 'https://github.com/acme/demo/issues/1'; exit 0 ;;
  *) echo "fake-gh: unhandled: $*" >&2; exit 1 ;;
esac
`,
      "utf8",
    );
    chmodSync(ghBin, 0o755);

    writeFileSync(
      join(j, "inbox", "a.md"),
      `---\nid: assess-e2e\nassess: {}\nrepo: ${repo}\n---\n# Assess\nscan for vulns\n`,
      "utf8",
    );

    const finding = {
      kind: "code",
      severity: "high",
      ruleId: "XSS-1",
      title: "Reflected XSS",
      description: "desc",
      location: { path: "src/index.ts" },
    };
    const finalText = "found things\n\n```junco-findings\n" + JSON.stringify([finding]) + "\n```";

    const c: Config = {
      ...cfg(root),
      ghBin,
      allowedRepoRoots: [repo],
    };
    const handled = await runOnce(c, { sessionFactoryFor: () => fakeSession(finalText) });

    expect(handled).toBe(true);
    const doneFiles = readdirSync(join(j, "done"));
    expect(doneFiles).toHaveLength(1);
    const body = readFileSync(join(j, "done", doneFiles[0]), "utf8");
    expect(body).toContain("<!-- junco-result");
    // The audit PARKS the finding — the summary points at the file step, and
    // no issue URL appears (nothing was filed).
    expect(body).toContain("junco assess file assess-e2e");
    expect(body).not.toContain("https://github.com/acme/demo/issues/1");

    // The finding landed in the review store, keyed by ticket id, flagged owned.
    const pend = listPending(c);
    expect(pend).toHaveLength(1);
    expect(pend[0].id).toBe("assess-e2e");
    expect(pend[0].nwo).toBe("acme/demo");
    expect(pend[0].external).toBe(false);
    expect(pend[0].findings).toHaveLength(1);

    // Only the dedup list ran against GitHub; nothing was created.
    const ghCalls = readFileSync(ghLog, "utf8").trim().split("\n");
    expect(ghCalls.some((l) => l.startsWith("issue create"))).toBe(false);
    expect(ghCalls.some((l) => l.startsWith("issue list"))).toBe(true);
  });
});

describe("analyze routing", () => {
  function fakeRunResult(finalText: string): AnalyzeFlowResult["result"] {
    return {
      finalText,
      toolCalls: [],
      usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
      stopReason: "stop",
      errorMessage: null,
      timedOut: false,
      durationMs: 5,
      abortedByGuard: false,
    };
  }

  it("branch ordering: an analyze ticket (which also carries repo:) routes to the analyze flow, never PR/Q&A/assess", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    // A repo: a PR flow would accept, PLUS analyze: {issue,title}. If branch
    // order regresses (hasRepo first), this routes into runPrFlow instead.
    const repo = mkdtempSync(join(tmpdir(), "junco-analyze-repo-"));
    const wtRoot = mkdtempSync(join(tmpdir(), "junco-analyze-wt-"));
    writeFileSync(
      join(j, "inbox", "a.md"),
      `---\nid: analyze-1\nanalyze:\n  issue: 7\n  title: Look into it\nrepo: ${repo}\n---\n# Analyze\ninvestigate\n`,
      "utf8",
    );

    const analyzeCalls: Array<{ cfg: Config; ticketId: string; claimedPath: string }> = [];
    const fakeAnalyzeFlowFn = async (
      passedCfg: Config,
      ticket: Ticket,
      claimedPath: string,
    ): Promise<AnalyzeFlowResult> => {
      analyzeCalls.push({ cfg: passedCfg, ticketId: ticket.id, claimedPath });
      return {
        dst: join(j, "done", "a.md"),
        status: "completed",
        requeued: false,
        result: fakeRunResult("analyze done"),
        parked: true,
      };
    };

    let sessionFactoryCalls = 0;
    // Real GitHub reporter with a gh SPY: the ticket's github is null, so
    // onFinal must return before touching gh (githubReport.ts:166).
    const ghCalls: string[][] = [];
    const ghSpy = (async (_cfg: unknown, args: string[]) => {
      ghCalls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }) as never;
    const c: Config = { ...cfg(root), worktreeRoot: wtRoot };
    const reporter = makeGithubReporter(c, { ghFn: ghSpy });

    const handled = await runOnce(c, {
      analyzeFlowFn: fakeAnalyzeFlowFn,
      sessionFactoryFor: () => {
        sessionFactoryCalls++;
        return fakeFactory();
      },
      reporter,
    });

    expect(handled).toBe(true);
    // The fake analyze flow was invoked with the right ticket — proves the
    // analyze branch fired ahead of assess/hasRepo/Q&A.
    expect(analyzeCalls).toHaveLength(1);
    expect(analyzeCalls[0].ticketId).toBe("analyze-1");
    // PR/Q&A flow was NOT entered: the shared session factory was never built,
    // and the worktree root stayed empty.
    expect(sessionFactoryCalls).toBe(0);
    expect(readdirSync(wtRoot)).toHaveLength(0);
    // Reporter no-op lock: a github-less ticket makes onFinal return before any
    // gh call — the reporter never touched GitHub.
    expect(ghCalls).toHaveLength(0);
  });

  it("requeue parity: a requeued analyze flow fires onRequeue, not onFinal", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    const repo = mkdtempSync(join(tmpdir(), "junco-analyze-repo-"));
    writeFileSync(
      join(j, "inbox", "a.md"),
      `---\nid: analyze-2\nanalyze:\n  issue: 8\n  title: T\nrepo: ${repo}\n---\n# Analyze\ninvestigate\n`,
      "utf8",
    );

    const fakeAnalyzeFlowFn = async (): Promise<AnalyzeFlowResult> => ({
      dst: join(j, "inbox", "a.md"),
      status: "requeued",
      requeued: true,
      result: fakeRunResult(""),
      parked: false,
    });

    const calls: string[] = [];
    const reporter = {
      onStart: async (): Promise<void> => void calls.push("start"),
      onRequeue: async (): Promise<void> => void calls.push("requeue"),
      onFinal: async (): Promise<void> => void calls.push("final"),
    };

    const handled = await runOnce(cfg(root), { analyzeFlowFn: fakeAnalyzeFlowFn, reporter });

    expect(handled).toBe(true);
    expect(calls).toEqual(["start", "requeue"]);
    expect(draftCount(cfg(root))).toBe(0);
  });

  // Issue #103: "analyze never posts" must not rest on the reporter's own
  // `if (!t.github …) return` guard — a hand-authored ticket carrying BOTH
  // `analyze:` and `github:` must still get zero outward writes, because
  // runOnce routes the analyze branch's terminal disposition through a
  // hard-coded no-op reporter regardless of what's injected.
  it("a hand-authored analyze:+github: ticket never reaches the reporter's onFinal (#103)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    const repo = mkdtempSync(join(tmpdir(), "junco-analyze-repo-"));
    writeFileSync(
      join(j, "inbox", "a.md"),
      `---\nid: analyze-3\nanalyze:\n  issue: 9\n  title: T\nrepo: ${repo}\ngithub:\n  nwo: a/b\n  issue: 9\n  kind: ask\n---\n# Analyze\ninvestigate\n`,
      "utf8",
    );

    const fakeAnalyzeFlowFn = async (): Promise<AnalyzeFlowResult> => ({
      dst: join(j, "done", "a.md"),
      status: "completed",
      requeued: false,
      result: fakeRunResult("analyze done"),
      parked: true,
    });

    const calls: string[] = [];
    const reporter = {
      onStart: async (): Promise<void> => void calls.push("start"),
      onRequeue: async (): Promise<void> => void calls.push("requeue"),
      onFinal: async (): Promise<void> => void calls.push("final"),
    };

    const handled = await runOnce(cfg(root), { analyzeFlowFn: fakeAnalyzeFlowFn, reporter });

    expect(handled).toBe(true);
    // onFinal — the call that would post an outward comment — must never
    // reach the injected reporter on the analyze path, `github:` block or not.
    expect(calls).not.toContain("final");
  });
});

describe("github_request fulfillment wiring", () => {
  const STAMP: TicketGithub = { nwo: "acme/api", issue: 7, kind: "pr", external: false };

  function seed(root: string, frontmatterExtra: string): void {
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(
      join(j, "inbox", "t.md"),
      `---\nid: t\nrepo: ${join(root, "no-such-repo")}\n${frontmatterExtra}---\n# T\nbody\n`,
      "utf8",
    );
  }

  it("fulfills for a PR-flow ticket: stamp lands on the ticket, reporter restarts with the link", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "github_request:\n  create_issue: true\n");
    const seen: Ticket[] = [];
    const starts: Array<string | null> = [];
    await runOnce(cfg(root), {
      sessionFactoryFor: () => fakeFactory(),
      fulfillIssueRequestFn: (_c, ticket) => {
        seen.push(ticket);
        return Promise.resolve(STAMP);
      },
      reporter: {
        onStart: (t) => {
          starts.push(t.github ? `${t.github.nwo}#${t.github.issue}` : null);
          return Promise.resolve();
        },
        onRequeue: () => Promise.resolve(),
        onFinal: () => Promise.resolve(),
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].github).toEqual(STAMP); // stamped before the flow consumed it
    expect(starts).toEqual([null, "acme/api#7"]); // pre-fulfillment no-op, then the linked re-call
  });

  it("does not fulfill for Q&A tickets or when github: provenance already exists", async () => {
    const qaRoot = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(qaRoot, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(
      join(j, "inbox", "q.md"),
      "---\nid: q\ngithub_request:\n  create_issue: true\n---\nq\n",
      "utf8",
    );
    let calls = 0;
    await runOnce(cfg(qaRoot), {
      sessionFactoryFor: () => fakeFactory(),
      fulfillIssueRequestFn: () => {
        calls += 1;
        return Promise.resolve(STAMP);
      },
    });
    expect(calls).toBe(0);

    const linkedRoot = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(
      linkedRoot,
      'github: {nwo: "acme/api", issue: 3, kind: pr}\ngithub_request:\n  create_issue: true\n',
    );
    await runOnce(cfg(linkedRoot), {
      sessionFactoryFor: () => fakeFactory(),
      fulfillIssueRequestFn: () => {
        calls += 1;
        return Promise.resolve(STAMP);
      },
    });
    expect(calls).toBe(0);
  });
});

describe("task-history ledger (Task 4)", () => {
  // Captures appendTaskRecordFn calls — the injectable seam over
  // taskHistory.ts's appendTaskRecord (which itself is exercised in
  // taskHistory.test.ts; here we only need to prove runOnce calls it with
  // the right record, at the right finalize points, and never on a requeue).
  function fakeAppendTaskRecord(): {
    calls: TaskRecord[];
    fn: (cfg: Config, rec: TaskRecord) => void;
  } {
    const calls: TaskRecord[] = [];
    return { calls, fn: (_cfg: Config, rec: TaskRecord) => void calls.push(rec) };
  }

  function fakeFlowRunResult(
    overrides: Partial<AssessFlowResult["result"]> = {},
  ): AssessFlowResult["result"] {
    return {
      finalText: "",
      toolCalls: [],
      usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
      stopReason: "stop",
      errorMessage: null,
      timedOut: false,
      durationMs: 5,
      abortedByGuard: false,
      ...overrides,
    };
  }

  function seed(root: string, id: string, frontmatterExtra = ""): void {
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(
      join(j, "inbox", `${id}.md`),
      `---\nid: ${id}\n${frontmatterExtra}---\n# T\nbody\n`,
      "utf8",
    );
  }

  it("PR path: a completed pr-flow run appends one pr-kind record with usage/duration/prUrl/retryCount", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    seed(root, "pr-1", "repo: /tmp/fake-repo-for-history\nretry_count: 3\n");

    const fakePrFlowFn = async (): Promise<PrFlowResult> => ({
      dst: join(j, "done", "pr-1.md"),
      status: "completed",
      requeued: false,
      prUrl: "https://x/pull/1",
      commitCount: 1,
      finalText: "done",
      phaseError: null,
      prQueued: false,
      usage: { input: 10, output: 5, cacheRead: 0, total: 15, costUsd: 0.01 },
      durationMs: 4000,
    });

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      prFlowFn: fakePrFlowFn,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(1);
    const r = rec.calls[0];
    expect(r).toMatchObject({
      kind: "pr",
      status: "completed",
      durationSeconds: 4,
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.01,
      prUrl: "https://x/pull/1",
      retryCount: 3,
    });
    expect(r.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("PR path: a requeued pr-flow run appends zero records", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    seed(root, "pr-2", "repo: /tmp/fake-repo-for-history\n");

    const fakePrFlowFn = async (): Promise<PrFlowResult> => ({
      dst: join(j, "inbox", "pr-2.md"),
      status: "requeued",
      requeued: true,
      prUrl: null,
      commitCount: 0,
      finalText: "",
      phaseError: null,
      prQueued: false,
    });

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      prFlowFn: fakePrFlowFn,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  it("Assess path: a completed assess-flow run appends one assess-kind record", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    seed(root, "assess-1", "assess: {}\nrepo: /tmp/fake-repo-for-history\n");

    const fakeAssessFlowFn = async (): Promise<AssessFlowResult> => ({
      dst: join(j, "done", "assess-1.md"),
      status: "completed",
      requeued: false,
      result: fakeFlowRunResult({
        usage: { input: 7, output: 3, cacheRead: 0, total: 10, costUsd: 0.02 },
        durationMs: 2000,
      }),
      found: 1,
      deduped: 0,
      dropped: 0,
      parked: 1,
    });

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      assessFlowFn: fakeAssessFlowFn,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({
      kind: "assess",
      status: "completed",
      durationSeconds: 2,
      tokensIn: 7,
      tokensOut: 3,
      costUsd: 0.02,
    });
  });

  it("Assess path: a requeued assess-flow run appends zero records", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "assess-2", "assess: {}\nrepo: /tmp/fake-repo-for-history\n");

    const fakeAssessFlowFn = async (): Promise<AssessFlowResult> => ({
      dst: join(root, "Junco", "inbox", "assess-2.md"),
      status: "requeued",
      requeued: true,
      result: fakeFlowRunResult(),
      found: 0,
      deduped: 0,
      dropped: 0,
      parked: 0,
    });

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      assessFlowFn: fakeAssessFlowFn,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  it("Analyze path: a completed analyze-flow run appends one analyze-kind record", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    seed(root, "analyze-1", "analyze:\n  issue: 7\n  title: T\nrepo: /tmp/fake-repo-for-history\n");

    const fakeAnalyzeFlowFn = async (): Promise<AnalyzeFlowResult> => ({
      dst: join(j, "done", "analyze-1.md"),
      status: "completed",
      requeued: false,
      result: fakeFlowRunResult({
        usage: { input: 4, output: 6, cacheRead: 0, total: 10, costUsd: 0.03 },
        durationMs: 3000,
      }),
      parked: true,
    });

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      analyzeFlowFn: fakeAnalyzeFlowFn,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({
      kind: "analyze",
      status: "completed",
      durationSeconds: 3,
      tokensIn: 4,
      tokensOut: 6,
      costUsd: 0.03,
    });
  });

  it("Analyze path: a requeued analyze-flow run appends zero records", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "analyze-2", "analyze:\n  issue: 8\n  title: T\nrepo: /tmp/fake-repo-for-history\n");

    const fakeAnalyzeFlowFn = async (): Promise<AnalyzeFlowResult> => ({
      dst: join(root, "Junco", "inbox", "analyze-2.md"),
      status: "requeued",
      requeued: true,
      result: fakeFlowRunResult(),
      parked: false,
    });

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      analyzeFlowFn: fakeAnalyzeFlowFn,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  it("Ask path: a plain Q&A ticket appends one ask-kind record with no github fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "ask-1");

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: costedFactory(0.03),
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(1);
    const r = rec.calls[0];
    expect(r.kind).toBe("ask");
    expect(r.status).toBe("completed");
    expect(r.tokensIn).toBe(3);
    expect(r.tokensOut).toBe(4);
    expect(r.costUsd).toBeCloseTo(0.03);
    expect(r.nwo).toBeUndefined();
    expect(r.issue).toBeUndefined();
  });

  it("Ask path: a bridged plan ticket appends a plan-kind record carrying nwo/issue", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "plan-1", "github:\n  nwo: acme/api\n  issue: 42\n  kind: plan\n");

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: () => fakeFactory(),
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].kind).toBe("plan");
    expect(rec.calls[0].nwo).toBe("acme/api");
    expect(rec.calls[0].issue).toBe(42);
  });

  it('hasRepo-but-empty repo (repo: "") falls through to Q&A and appends an ask-kind record', async () => {
    // repo: "" makes hasRepo true (frontmatter.repo is defined, non-null) but
    // deriveRepoContext's `if (!rawRepo) return null` rejects the empty
    // string, so executeClaimed logs "hasRepo ticket produced no repo
    // context; treating as Q&A" and actually runs the Q&A branch. The record
    // must reflect that executed branch (ask), not the field-shape guess (pr).
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "empty-repo-1", 'repo: ""\n');

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: () => fakeFactory(),
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].kind).toBe("ask");
    expect(rec.calls[0].status).toBe("completed");
  });

  it("repo: + github.kind=plan runs the real PR flow and appends a pr-kind record", async () => {
    // A ticket carrying BOTH `repo:` and `github: { kind: plan, ... }` still
    // dispatches through the hasRepo branch (executeClaimed checks hasRepo,
    // not github.kind) and runs the real PR flow — the record must say "pr",
    // not "plan", even though the field-shape guess would say "plan" first.
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    seed(
      root,
      "pr-plan-1",
      "repo: /tmp/fake-repo-for-history\ngithub:\n  nwo: acme/api\n  issue: 5\n  kind: plan\n  external: false\n",
    );

    const fakePrFlowFn = async (): Promise<PrFlowResult> => ({
      dst: join(j, "done", "pr-plan-1.md"),
      status: "completed",
      requeued: false,
      prUrl: "https://x/pull/2",
      commitCount: 1,
      finalText: "done",
      phaseError: null,
      prQueued: false,
      usage: { input: 1, output: 1, cacheRead: 0, total: 2, costUsd: 0 },
      durationMs: 100,
    });

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      prFlowFn: fakePrFlowFn,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].kind).toBe("pr");
  });

  it("Q&A transient-failure requeue appends zero records", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "transient-1");
    const erroringFactory = () => async () => ({
      subscribe() {
        return () => {};
      },
      async prompt() {
        throw new Error("fetch failed: ECONNREFUSED");
      },
      dispose() {},
      abort: async () => {},
    });

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: erroringFactory,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  it("crash containment: a rejecting factory with budget remaining requeues and appends zero records", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "crash-1");
    const rejectingFactory = () => async (): Promise<never> => {
      throw new Error("model unresolved at session create");
    };

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: rejectingFactory,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  it("crash containment: exhausted retry budget finalizes to failed/ and appends one record with zero tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "crash-2", "retry_count: 2\n");
    const rejectingFactory = () => async (): Promise<never> => {
      throw new Error("model unresolved at session create");
    };

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: rejectingFactory,
      appendTaskRecordFn: rec.fn,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(1);
    const r = rec.calls[0];
    expect(r.status).toBe("failed");
    expect(r.tokensIn).toBe(0);
    expect(r.tokensOut).toBe(0);
    expect(r.costUsd).toBe(0);
    expect(r.kind).toBe("ask");
  });

  it("uses nowFn (when provided) for the record's `at` timestamp", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "ask-2");
    const pinned = new Date("2020-01-02T03:04:05.000Z");

    const rec = fakeAppendTaskRecord();
    const handled = await runOnce(cfg(root), {
      sessionFactoryFor: () => fakeFactory(),
      appendTaskRecordFn: rec.fn,
      nowFn: () => pinned,
    });

    expect(handled).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].at).toBe(pinned.toISOString());
  });
});
