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
import type { Config, Ticket } from "../src/types.js";
import type { AssessFlowResult } from "../src/assessFlow.js";
import type { AnalyzeFlowResult } from "../src/analyzeFlow.js";
import { listPending } from "../src/assessReview.js";
import { draftCount } from "../src/commentReview.js";
import { makeGithubReporter } from "../src/githubReport.js";

function cfg(root: string): Config {
  return {
    vaultRoot: root,
    juncoSubdir: "Junco",
    model: {
      id: "m",
      modelsJson: null,
      api: "openai-completions",
      baseUrl: "u",
      apiKey: "k",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 49152,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevel: "medium",
      compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
    },
    tools: ["read"],
    defaultTimeoutMinutes: 1,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    supervisorEnabled: true,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    ghBin: "gh",
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: "/tmp/worktrees",
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
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm" },
    stateDir: join(root, "state"),
    logToFile: false,
    transcriptsEnabled: false,
  };
}

function fakeFactory() {
  return async () => ({
    subscribe(l: (e: any) => void) {
      queueMicrotask(() => {
        l({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "reply!" },
        });
        l({
          type: "turn_end",
          message: {
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
}

// A scriptable session (parameterized on the emitted text) — used by the
// assess end-to-end test below, mirroring tests/assessFlow.test.ts's
// fakeSession helper.
function fakeSession(finalText: string) {
  return async () => ({
    subscribe(l: (e: any) => void) {
      queueMicrotask(() => {
        l({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: finalText },
        });
        l({
          type: "turn_end",
          message: {
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
          },
        });
        l({ type: "agent_end", messages: [], willRetry: false });
      });
      return () => {};
    },
    async prompt() {
      await new Promise((r) => setTimeout(r, 1));
    },
    dispose() {},
    abort: async () => {},
  });
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

describe("transcript path sanitization (issue #32)", () => {
  it("slugifies a path-traversal frontmatter id before building the transcript path", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    // A hostile id that would escape stateDir/transcripts/ if used verbatim.
    writeFileSync(
      join(j, "inbox", "evil.md"),
      "---\nid: ../../../../pwned\n---\n# Q\nask\n",
      "utf8",
    );
    const stateDir = join(root, "state");
    const c: Config = { ...cfg(root), stateDir, transcriptsEnabled: true };

    await runOnce(c, { sessionFactoryFor: () => fakeFactory() });

    // The transcript must live inside stateDir/transcripts/ as a single inert
    // filename — never at the traversal target.
    const transcriptsDir = join(stateDir, "transcripts");
    const written = readdirSync(transcriptsDir);
    expect(written).toContain("..-..-..-..-pwned.jsonl");
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
    expect(seenModelId).toBe("m");
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
      usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
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
      usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
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
});
