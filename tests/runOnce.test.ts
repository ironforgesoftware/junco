import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOnce, claimNextTask } from "../src/runOnce.js";
import type { Config } from "../src/types.js";

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
    },
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
});
