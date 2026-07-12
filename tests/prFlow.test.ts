/**
 * Tests for src/prFlow.ts — the PR-flow orchestrator (M3-T9).
 *
 * Uses a REAL git harness (bare remote + seeded clone) + a fake gh script, plus
 * an injected fake agent session factory whose prompt() makes a REAL commit in
 * the worktree cwd (mirroring the Python fake_omp_pr.sh). No real model, no
 * real GitHub.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runPrFlow, buildPrBody, type PrOutcome } from "../src/prFlow.js";
import { deriveRepoContext } from "../src/repoContext.js";
import { claim } from "../src/queue.js";
import { parseTicket } from "../src/ticket.js";
import { listOps, type OutboxOp } from "../src/githubOutbox.js";
import { TERMINAL_DONE_STATUSES, type Config, type Ticket } from "../src/types.js";
import type { AgentSessionLike } from "../src/agent/session.js";
import type { ProviderFailureClass } from "../src/providerFailure.js";
import { setupForkHarness, FORK_NWO } from "./helpers/forkHarness.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "CI",
  GIT_AUTHOR_EMAIL: "ci@example.com",
  GIT_COMMITTER_NAME: "CI",
  GIT_COMMITTER_EMAIL: "ci@example.com",
};

function run(args: string[], cwd?: string): string {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8", env: GIT_ENV });
}

interface Harness {
  root: string;
  remote: string;
  work: string;
  wtsRoot: string;
  ghBin: string;
  processing: string;
  done: string;
  failed: string;
}

function setup(): Harness {
  const root = mkdtempSync(join(tmpdir(), "junco-prflow-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const wtsRoot = join(root, "wts");
  const processing = join(root, "processing");
  const done = join(root, "done");
  const failed = join(root, "failed");
  [wtsRoot, processing, done, failed].forEach((d) => mkdirSync(d, { recursive: true }));

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

  // Fake gh: `repo view` → nwo; `pr create` → a canned URL.
  const ghBin = join(root, "fake-gh.sh");
  writeFileSync(
    ghBin,
    `#!/bin/sh
args="$*"
case "$args" in
  "repo view --json nameWithOwner -q .nameWithOwner"*)
    echo "owner/repo"; exit 0 ;;
  "pr create "*)
    echo "https://github.com/owner/repo/pull/123"; exit 0 ;;
  *)
    echo "fake-gh: unhandled: $args" >&2; exit 1 ;;
esac
`,
    "utf8",
  );
  chmodSync(ghBin, 0o755);

  return { root, remote, work, wtsRoot, ghBin, processing, done, failed };
}

function makeConfig(h: Harness, overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: h.root,
    juncoSubdir: "Junco",
    model: {
      id: "test/model",
      source: "auto",
      baseUrlExplicit: false,
      retry: { maxRetries: null, baseDelayMs: null },
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
    endpointProbe: "auto",
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    supervisorEnabled: false,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    ghBin: h.ghBin,
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: h.wtsRoot,
    removeWorktreeOnSuccess: false, // preserve so we can assert on commits
    allowedRepoRoots: [],
    draftByDefault: true,
    defaultLabels: [],
    verifyEnabled: true,
    verifyCommandTimeout: 60,
    verifyBlockOnFail: false,
    criticEnabled: false, // off by default; opt-in per test
    criticMaxRetries: 1,
    criticThinking: "minimal",
    planLintEnabled: false, // off by default; opt-in per test
    planLintBlockOnError: true,
    planLintCheckLabels: false,
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
    sandbox: {
      enabled: false,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    },
    stateDir: join(h.root, "state"),
    logToFile: false,
    transcriptsEnabled: false,
    ...overrides,
  };
}

/** A ticket parsed from a markdown string written into processing/. */
function makeTicket(h: Harness, name: string, content: string): { task: Ticket; path: string } {
  const path = join(h.processing, name);
  writeFileSync(path, content, "utf8");
  return { task: parseTicket(path, content, 30), path };
}

function ctxFor(cfg: Config, task: Ticket) {
  const ctx = deriveRepoContext(task.frontmatter, task.id, {
    defaultBaseBranch: cfg.defaultBaseBranch,
    branchPrefix: cfg.branchPrefix,
    draftByDefault: cfg.draftByDefault,
    defaultLabels: cfg.defaultLabels,
  });
  if (!ctx) throw new Error("expected a repo context");
  return ctx;
}

/**
 * Fake agent session factory: prompt() makes a REAL commit in the worktree cwd
 * (file write + git add + git commit), then emits a text_delta + turn_end +
 * agent_end. `commit=false` makes a NO-OP session (no commit). Mirrors the
 * Python fake_omp_pr.sh — a real commit so countNewCommits > 0.
 */
function commitFactory(
  opts: { commit?: boolean; stopReason?: string; file?: string } = {},
): (cfg: Config, cwd: string) => () => Promise<AgentSessionLike> {
  const { commit = true, stopReason = "stop", file = "feature.txt" } = opts;
  return (_cfg, cwd) => async () => {
    let listener: ((e: any) => void) | null = null;
    return {
      subscribe(l: (e: any) => void) {
        listener = l;
        return () => {};
      },
      async prompt() {
        if (commit) {
          writeFileSync(join(cwd, file), `work ${Date.now()}\n`, "utf8");
          run(["git", "-C", cwd, "add", "-A"]);
          run(["git", "-C", cwd, "commit", "-m", `feat: ${file}`]);
        }
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "done." },
        });
        listener?.({
          type: "turn_end",
          message: { stopReason, usage: { input: 5, output: 5, cacheRead: 0, totalTokens: 10 } },
        });
        listener?.({ type: "agent_end", messages: [], willRetry: false });
      },
      dispose() {},
      abort: async () => {},
    };
  };
}

/** A fake critic session that emits a fixed JUNCO_VERIFY verdict line. */
function criticFactory(verdictLine: string): () => Promise<AgentSessionLike> {
  return async () => {
    let listener: ((e: any) => void) | null = null;
    return {
      subscribe(l: (e: any) => void) {
        listener = l;
        return () => {};
      },
      async prompt() {
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: verdictLine },
        });
        listener?.({
          type: "turn_end",
          message: {
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
          },
        });
        listener?.({ type: "agent_end", messages: [], willRetry: false });
      },
      dispose() {},
      abort: async () => {},
    };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPrFlow", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  it("happy path: validates, commits, pushes, opens a PR → done/ with pr_url + pushed", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "happy.md",
      `---\nid: happy\nrepo: ${h.work}\n---\n# Add a feature\n\nMake a change.\n`,
    );
    const ctx = ctxFor(cfg, task);

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
    });

    // Structured result: status/prUrl/commitCount surface for the reporter seam.
    expect(flow.status).toBe("completed");
    expect(flow.requeued).toBe(false);
    expect(flow.prUrl).toBe("https://github.com/owner/repo/pull/123");
    expect(flow.commitCount).toBeGreaterThan(0);
    const dst = flow.dst;
    expect(dst.startsWith(h.done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: completed");
    expect(text).toContain("pr_url: https://github.com/owner/repo/pull/123");
    expect(text).toContain("pushed: true");
    expect(text).toContain("branch: junco/happy");
    // The branch landed on the remote.
    const remoteBranches = run([
      "git",
      "-C",
      h.work,
      "ls-remote",
      "--heads",
      "origin",
      "junco/happy",
    ]);
    expect(remoteBranches).toContain("junco/happy");
  });

  it("a traversal ticket id cannot escape the transcripts dir (#94, regression of #32)", async () => {
    // A malicious id whose raw form resolves OUTSIDE <stateDir>/transcripts/.
    // branch_name is pinned so the id influences only the transcript path (the
    // one call site that regressed), not the git ref. runAgent synchronously
    // mkdirSync(dirname(transcriptPath)); with the raw-id bug that creates
    // <stateDir>/pwned/ outside the transcripts dir. The fix slugifies the id
    // into a single inert path component so nothing escapes.
    const cfg = makeConfig(h, { transcriptsEnabled: true });
    const { task, path } = makeTicket(
      h,
      "traversal.md",
      `---\nid: "../pwned/x"\nrepo: ${h.work}\nbranch_name: pwned-branch\n---\n# Add a feature\n\nMake a change.\n`,
    );
    const ctx = ctxFor(cfg, task);

    await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(existsSync(join(cfg.stateDir, "pwned"))).toBe(false);
    // The transcript still lands, contained, under the slugified filename.
    expect(existsSync(join(cfg.stateDir, "transcripts"))).toBe(true);
  });

  it("threads allText through PrFlowResult when the run has messages before the last (#86)", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "multi.md",
      `---\nid: multi\nrepo: ${h.work}\n---\n# Add a feature\n\nMake a change.\n`,
    );
    const ctx = ctxFor(cfg, task);

    // A session that emits a first message, banks it with a message_start
    // (assistant), then a trailing message — so finalText is the last message
    // only while allText is the whole run.
    const twoMessageFactory =
      (_cfg: Config, cwd: string) => async (): Promise<AgentSessionLike> => {
        let listener: ((e: any) => void) | null = null;
        return {
          subscribe(l: (e: any) => void) {
            listener = l;
            return () => {};
          },
          async prompt() {
            writeFileSync(join(cwd, "feature.txt"), `work ${Date.now()}\n`, "utf8");
            run(["git", "-C", cwd, "add", "-A"]);
            run(["git", "-C", cwd, "commit", "-m", "feat: feature.txt"]);
            listener?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "PREFACE-LINE" },
            });
            listener?.({ type: "message_start", message: { role: "assistant" } });
            listener?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "done." },
            });
            listener?.({
              type: "turn_end",
              message: {
                stopReason: "stop",
                usage: { input: 5, output: 5, cacheRead: 0, totalTokens: 10 },
              },
            });
            listener?.({ type: "agent_end", messages: [], willRetry: false });
          },
          dispose() {},
          abort: async () => {},
        };
      };

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: twoMessageFactory,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.finalText).toBe("done.");
    expect(flow.allText).toContain("PREFACE-LINE");
    expect(flow.allText).toContain("done.");
  });

  it("no-changes: agent makes no commit → completed_no_changes → done/, no push", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "noop.md",
      `---\nid: noop\nrepo: ${h.work}\n---\n# No-op ticket\n\nDecide nothing is needed.\n`,
    );
    const ctx = ctxFor(cfg, task);

    const { dst } = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: false }),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: completed_no_changes");
    expect(text).toContain("pushed: false");
    // No branch pushed.
    const remoteBranches = run([
      "git",
      "-C",
      h.work,
      "ls-remote",
      "--heads",
      "origin",
      "junco/noop",
    ]);
    expect(remoteBranches.trim()).toBe("");
  });

  it("plan-lint block: a failing rule routes to failed/ without running the agent", async () => {
    const cfg = makeConfig(h, { planLintEnabled: true, planLintBlockOnError: true });
    // `cd` inside the Verification fenced block is an error rule.
    const body = `# Bad ticket

## Verification

\`\`\`bash
cd /tmp
echo hi
\`\`\`

## Notes for the agent (strict — copy verbatim)

Stay put.
`;
    const { task, path } = makeTicket(h, "lint.md", `---\nid: lint\nrepo: ${h.work}\n---\n${body}`);
    const ctx = ctxFor(cfg, task);

    let agentCalled = false;
    const { dst } = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: (cfg2, cwd) => () => {
        agentCalled = true;
        return commitFactory({ commit: true })(cfg2, cwd)();
      },
      dirs: { done: h.done, failed: h.failed },
    });

    expect(agentCalled).toBe(false);
    expect(dst.startsWith(h.failed)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: failed");
    expect(text).toContain("plan-lint:");
    // No worktree created (agent never ran).
    expect(readdirSync(h.wtsRoot)).toHaveLength(0);
  });

  it("verification gate: a failing ## Verification block with block_on_fail → failed/, no push", async () => {
    const cfg = makeConfig(h, { verifyEnabled: true, verifyBlockOnFail: true });
    const body = `# Feature with failing verification

Make a change.

## Verification

\`\`\`bash
exit 1
\`\`\`
`;
    const { task, path } = makeTicket(
      h,
      "verify.md",
      `---\nid: verify\nrepo: ${h.work}\n---\n${body}`,
    );
    const ctx = ctxFor(cfg, task);

    const { dst } = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.failed)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: failed");
    expect(text).toContain("verification gate blocked push");
    // No branch pushed.
    const remoteBranches = run([
      "git",
      "-C",
      h.work,
      "ls-remote",
      "--heads",
      "origin",
      "junco/verify",
    ]);
    expect(remoteBranches.trim()).toBe("");
  });

  it("critic corrective: MISSING then a corrective turn sets criticRetriesUsed and still pushes", async () => {
    const cfg = makeConfig(h, { criticEnabled: true, criticMaxRetries: 1, verifyEnabled: false });
    const { task, path } = makeTicket(
      h,
      "critic.md",
      `---\nid: critic\nrepo: ${h.work}\n---\n# Feature needing a fix\n\nImplement X.\n`,
    );
    const ctx = ctxFor(cfg, task);

    // The critic returns MISSING on every call (drives ONE corrective re-dispatch).
    // Both the initial and corrective agent turns make a commit.
    const { dst } = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: true }),
      criticSessionFactory: criticFactory("JUNCO_VERIFY: MISSING the X bit"),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: completed");
    expect(text).toContain("pushed: true");
    // Two commits: the initial + the corrective re-dispatch.
    expect(text).toContain("commit_count: 2");
  });

  // -------------------------------------------------------------------------
  // Transient-failure requeue
  // -------------------------------------------------------------------------

  /** Session whose prompt() throws — a hard non-guard error with no commits. */
  function erroringFactory(): (cfg: Config, cwd: string) => () => Promise<AgentSessionLike> {
    return (_cfg, _cwd) => async () => ({
      subscribe() {
        return () => {};
      },
      async prompt() {
        throw new Error("fetch failed: ECONNREFUSED");
      },
      dispose() {},
      abort: async () => {},
    });
  }

  it("transient agent error with zero commits requeues the ticket and removes the worktree", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "flaky.md",
      `---\nid: flaky\nrepo: ${h.work}\n---\n# Flaky\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);

    const { dst } = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: erroringFactory(),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst).toContain(join("Junco", "inbox")); // requeued, not failed
    const text = readFileSync(dst, "utf8");
    expect(text).toMatch(/retry_count: 1/);
    expect(text).toMatch(/not_before:/);
    expect(text).not.toMatch(/junco-result/);
    expect(readdirSync(h.failed)).toHaveLength(0);
    expect(readdirSync(h.wtsRoot)).toHaveLength(0); // worktree cleaned for the retry
  });

  it("transient error with retry budget exhausted routes to failed/ as before", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "spent.md",
      `---\nid: spent\nrepo: ${h.work}\nretry_count: 2\n---\n# Spent\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);

    const { dst } = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: erroringFactory(),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.failed)).toBe(true);
    expect(readFileSync(dst, "utf8")).toContain("status: failed");
  });

  it("a tools: frontmatter narrows the PR-flow session's allowlist", async () => {
    const cfg = makeConfig(h, { tools: ["read", "write", "bash", "edit"] });
    const { task, path } = makeTicket(
      h,
      "narrow.md",
      `---\nid: narrow\nrepo: ${h.work}\ntools: [read, edit]\n---\n# Narrow\n\nDo a thing.\n`,
    );
    const seen: string[][] = [];
    const { dst } = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: (passedCfg, cwd) => {
        seen.push(passedCfg.tools);
        return commitFactory({ commit: true })(passedCfg, cwd);
      },
      dirs: { done: h.done, failed: h.failed },
    });
    expect(dst.startsWith(h.done)).toBe(true);
    expect(seen[0]).toEqual(["read", "edit"]);
  });

  // -------------------------------------------------------------------------
  // Timeout salvage
  // -------------------------------------------------------------------------

  /** Session that (optionally) commits, then hangs until runAgent's timeout
   * timer aborts it — produces a timedOut RunResult. */
  function timingOutFactory(
    opts: { commit?: boolean } = {},
  ): (cfg: Config, cwd: string) => () => Promise<AgentSessionLike> {
    const { commit = true } = opts;
    return (_cfg, cwd) => async () => {
      let resolveHang: (() => void) | null = null;
      return {
        subscribe() {
          return () => {};
        },
        async prompt() {
          if (commit) {
            writeFileSync(join(cwd, "salvage.txt"), "work before the cutoff\n", "utf8");
            run(["git", "-C", cwd, "add", "-A"]);
            run(["git", "-C", cwd, "commit", "-m", "feat: salvage"]);
          }
          await new Promise<void>((r) => {
            resolveHang = r;
          }); // hang until abort()
        },
        dispose() {},
        abort: async () => {
          resolveHang?.();
        },
      };
    };
  }

  /**
   * Session that (optionally) commits, then trips the supplied AbortController —
   * an operator force-stop, which session.ts treats with guard-kill semantics and
   * so returns an `abortedByGuard: true` RunResult (the SOFT-abort salvage path).
   * Hangs on a promise resolved by runAgent's abort(). The fixtures keep the
   * supervisor disabled, so the force-stop signal is how we drive a guard abort
   * end-to-end (issue #125).
   */
  function guardAbortingFactory(
    controller: AbortController,
    opts: { commit?: boolean } = {},
  ): (cfg: Config, cwd: string) => () => Promise<AgentSessionLike> {
    const { commit = true } = opts;
    return (_cfg, cwd) => async () => {
      let resolveHang: (() => void) | null = null;
      return {
        subscribe() {
          return () => {};
        },
        async prompt() {
          if (commit) {
            writeFileSync(join(cwd, "salvage.txt"), "work before the kill\n", "utf8");
            run(["git", "-C", cwd, "add", "-A"]);
            run(["git", "-C", cwd, "commit", "-m", "feat: salvage"]);
          }
          // Arm the hang BEFORE tripping the signal: abort() fires synchronously
          // and resolves this promise, so resolveHang must already be set.
          const hang = new Promise<void>((r) => {
            resolveHang = r;
          });
          controller.abort(); // operator force-stop → guard-kill salvage semantics
          await hang;
        },
        dispose() {},
        abort: async () => {
          resolveHang?.();
        },
      };
    };
  }

  it("a timed-out session with commits is salvaged: pushed, PR opened, timeout_partial → done/", async () => {
    const cfg = makeConfig(h);
    // timeout_minutes 0.005 → 300ms; the fake commits synchronously, then hangs.
    const { task, path } = makeTicket(
      h,
      "slowpoke.md",
      `---\nid: slowpoke\nrepo: ${h.work}\ntimeout_minutes: 0.005\n---\n# Slow\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);

    const { dst } = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: timingOutFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: timeout_partial");
    expect(text).toContain("pushed: true");
    expect(text).toContain("Partial run — hit the ticket timeout");
    const remoteBranches = run([
      "git",
      "-C",
      h.work,
      "ls-remote",
      "--heads",
      "origin",
      "junco/slowpoke",
    ]);
    expect(remoteBranches).toContain("junco/slowpoke");
  }, 20000);

  it("a timed-out session with no commits fails with a preserved worktree", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "idle.md",
      `---\nid: idle\nrepo: ${h.work}\ntimeout_minutes: 0.005\n---\n# Idle\n\nDo nothing slowly.\n`,
    );
    const ctx = ctxFor(cfg, task);

    const { dst } = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: timingOutFactory({ commit: false }),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.failed)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: timeout");
    expect(text).toContain("ticket timeout with no commits");
    expect(text).toContain("Worktree preserved");
  }, 20000);

  // -------------------------------------------------------------------------
  // Guard-abort salvage (issue #125) — the SOFT-abort twin of timeout salvage,
  // never previously driven end-to-end through runPrFlow.
  // -------------------------------------------------------------------------

  it("a guard-aborted session with commits is salvaged: pushed, PR opened, aborted_partial → done/ (#125)", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "guardkill.md",
      `---\nid: guardkill\nrepo: ${h.work}\n---\n# Kill\n\nDo a thing then loop.\n`,
    );
    const controller = new AbortController();

    const { dst, status } = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: guardAbortingFactory(controller, { commit: true }),
      abortSignal: controller.signal,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.done)).toBe(true);
    expect(status).toBe("aborted_partial");
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: aborted_partial");
    expect(text).toContain("pushed: true");
    expect(text).toContain("Partial run — aborted by the loop guard");
    // The branch really landed on the remote.
    expect(
      run(["git", "-C", h.work, "ls-remote", "--heads", "origin", "junco/guardkill"]),
    ).toContain("junco/guardkill");
  }, 20000);

  it("offline GUARD-abort with commits routes to done/ (aborted_partial), no false 'no committed work' banner (#123/#125)", async () => {
    const cfg = makeConfig(h, { gitBin: gitFailShim("git-offkill.sh", "push", NET) });
    const { task, path } = makeTicket(
      h,
      "offkill.md",
      `---\nid: offkill\nrepo: ${h.work}\n---\n# Kill offline\n\nDo a thing then loop.\n`,
    );
    // Bridged ticket → the queued op carries a finalize block we can assert on.
    task.github = { nwo: "owner/repo", issue: 12, kind: "pr", external: false };
    const controller = new AbortController();

    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: guardAbortingFactory(controller, { commit: true }),
      abortSignal: controller.signal,
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });

    expect(flow.dst.startsWith(h.done)).toBe(true);
    expect(flow.status).toBe("aborted_partial");
    expect(flow.prQueued).toBe(true);
    const text = readFileSync(flow.dst, "utf8");
    expect(text).toContain("status: aborted_partial");
    expect(text).toContain("PR queued for offline push");
    expect(text).toContain("Partial run — aborted by the loop guard");
    // The false banner from the pre-#123 misroute must NOT appear.
    expect(text).not.toContain("with no committed work");
    // The parked op carries the corrected done-routing status for its replay.
    const op = listOps(cfg)[0].op as Extract<OutboxOp, { kind: "pr" }>;
    expect(op.finalize?.status).toBe("aborted_partial");
    expect(op.pushed).toBe(false);
  }, 20000);

  it("a requeued ticket can be re-claimed and run to done/ (no branch collision)", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "retry-roundtrip.md",
      `---\nid: retry-roundtrip\nrepo: ${h.work}\n---\n# Roundtrip\n\nDo a thing.\n`,
    );

    const flow1 = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: erroringFactory(),
      dirs: { done: h.done, failed: h.failed },
    });
    expect(flow1.requeued).toBe(true);
    expect(flow1.status).toBe("requeued");
    expect(flow1.dst).toContain(join("Junco", "inbox"));

    // Second attempt: re-claim (simulating the queue) and run a committing fake.
    const claimed2 = claim(flow1.dst, h.processing)!;
    const task2 = parseTicket(claimed2, readFileSync(claimed2, "utf8"), 30);
    expect(task2.retryCount).toBe(1);
    const flow2 = await runPrFlow(cfg, task2, claimed2, ctxFor(cfg, task2), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
    });
    expect(flow2.dst.startsWith(h.done)).toBe(true);
    expect(readFileSync(flow2.dst, "utf8")).toContain("status: completed");
  });

  // -------------------------------------------------------------------------
  // Offline endgame (outbox) — Task 4
  // -------------------------------------------------------------------------

  /**
   * Write an executable git shim that fails the named subcommand with a
   * scripted stderr line and delegates everything else to the real git — the
   * gitBin equivalent of the fake-gh script. `subcommand` is matched as a
   * standalone argv token (none of the flow's other git calls carry it).
   */
  function gitFailShim(name: string, subcommand: string, stderrLine: string): string {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const p = join(h.root, name);
    writeFileSync(
      p,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "${subcommand}" ]; then
    echo ${JSON.stringify(stderrLine)} >&2
    exit 1
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`,
      "utf8",
    );
    chmodSync(p, 0o755);
    return p;
  }

  /** A fake gh that answers `repo view` but fails `pr create` however scripted. */
  function ghShim(name: string, prCreateBody: string): string {
    const p = join(h.root, name);
    writeFileSync(
      p,
      `#!/bin/sh
args="$*"
case "$args" in
  "repo view --json nameWithOwner -q .nameWithOwner"*)
    echo "owner/repo"; exit 0 ;;
  "pr create "*)
    ${prCreateBody} ;;
  *)
    echo "fake-gh: unhandled: $args" >&2; exit 1 ;;
esac
`,
      "utf8",
    );
    chmodSync(p, 0o755);
    return p;
  }

  const NET = "connect: network is unreachable";

  async function runFlowWithOfflinePush(): Promise<{
    flow: Awaited<ReturnType<typeof runPrFlow>>;
    cfg: Config;
  }> {
    // Real gh (repo view works, but push dies first); git shim fails `push`.
    const cfg = makeConfig(h, { gitBin: gitFailShim("git-offpush.sh", "push", NET) });
    const { task, path } = makeTicket(
      h,
      "offpush.md",
      `---\nid: offpush\nrepo: ${h.work}\n---\n# Add a feature\n\nDo it.\n`,
    );
    // A bridged ticket → the queued op carries a finalize block.
    task.github = { nwo: "owner/repo", issue: 7, kind: "pr", external: false };
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5, // don't eat real network backoff in tests
    });
    return { flow, cfg };
  }

  async function runFlowWithOfflinePrCreate(): Promise<{
    flow: Awaited<ReturnType<typeof runPrFlow>>;
    cfg: Config;
  }> {
    // Real git (push lands on the bare remote); fake-gh fails `pr create` offline.
    const cfg = makeConfig(h, { ghBin: ghShim("gh-offpr.sh", `echo "${NET}" >&2; exit 1`) });
    const { task, path } = makeTicket(
      h,
      "offpr.md",
      `---\nid: offpr\nrepo: ${h.work}\n---\n# Add a feature\n\nDo it.\n`,
    );
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });
    return { flow, cfg };
  }

  async function runFlowWithPermanentPushFailure(): Promise<{
    flow: Awaited<ReturnType<typeof runPrFlow>>;
    cfg: Config;
  }> {
    // Non-network push failure ("denied") — not ours to queue.
    const cfg = makeConfig(h, {
      gitBin: gitFailShim("git-denied.sh", "push", "remote: Permission to owner/repo.git denied"),
    });
    const { task, path } = makeTicket(
      h,
      "denied.md",
      `---\nid: denied\nrepo: ${h.work}\n---\n# Add a feature\n\nDo it.\n`,
    );
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
    });
    return { flow, cfg };
  }

  it("offline push queues a composite pr op and finalizes done with prQueued", async () => {
    const { flow, cfg } = await runFlowWithOfflinePush();
    expect(flow.requeued).toBe(false);
    expect(TERMINAL_DONE_STATUSES.has(flow.status)).toBe(true);
    expect(flow.prUrl).toBeNull();
    expect(flow.prQueued).toBe(true);
    const ops = listOps(cfg);
    expect(ops).toHaveLength(1);
    const op = ops[0].op as Extract<OutboxOp, { kind: "pr" }>;
    expect(op.kind).toBe("pr");
    expect(op.branch).toMatch(/^junco\//);
    expect(op.finalize?.status).toBe(flow.status);
    expect(op.pushed).toBe(false);
    // Worktree preserved (never cleaned on an offline branch).
    expect(readdirSync(h.wtsRoot).length).toBeGreaterThan(0);
  });

  it("offline TIMEOUT soft-abort with commits routes to done/ (timeout_partial), not failed/ (#123)", async () => {
    // A timed-out session that committed continues to the phase-11 push. Offline,
    // the composite push→PR→comment op is parked (prQueued) but pushed stays
    // false. The ONLINE twin lands timeout_partial → done/; computePrStatus must
    // treat the queued op as "pushed" so this offline salvage routes to done/ the
    // same way — not to failed/ as bare `timeout`.
    const cfg = makeConfig(h, { gitBin: gitFailShim("git-offtimeout.sh", "push", NET) });
    const { task, path } = makeTicket(
      h,
      "offtimeout.md",
      `---\nid: offtimeout\nrepo: ${h.work}\ntimeout_minutes: 0.005\n---\n# Slow\n\nDo a thing.\n`,
    );
    // Bridged ticket → the queued op carries a finalize block we can assert on.
    task.github = { nwo: "owner/repo", issue: 11, kind: "pr", external: false };
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: timingOutFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });

    expect(flow.dst.startsWith(h.done)).toBe(true);
    expect(flow.status).toBe("timeout_partial");
    expect(flow.prQueued).toBe(true);
    const text = readFileSync(flow.dst, "utf8");
    expect(text).toContain("status: timeout_partial");
    expect(text).toContain("PR queued for offline push");
    // The parked op carries the corrected (done-routing) status for its replay.
    const op = listOps(cfg)[0].op as Extract<OutboxOp, { kind: "pr" }>;
    expect(op.finalize?.status).toBe("timeout_partial");
    expect(op.pushed).toBe(false);
  }, 20000);

  it("offline gh pr create (after successful push) checkpoints pushed:true", async () => {
    const { flow, cfg } = await runFlowWithOfflinePrCreate();
    expect(flow.prQueued).toBe(true);
    const op = listOps(cfg)[0].op as Extract<OutboxOp, { kind: "pr" }>;
    expect(op.pushed).toBe(true);
    expect(op.prUrl).toBeNull();
    // The branch really landed on the remote before gh failed.
    expect(run(["git", "-C", h.work, "ls-remote", "--heads", "origin", "junco/offpr"])).toContain(
      "junco/offpr",
    );
  });

  it("non-network push failure keeps today's behavior (phaseError, no op)", async () => {
    const { flow, cfg } = await runFlowWithPermanentPushFailure();
    expect(flow.prQueued ?? false).toBe(false);
    expect(listOps(cfg)).toHaveLength(0);
    expect(flow.phaseError).toContain("push/commit failed");
    expect(flow.dst.startsWith(h.failed)).toBe(true);
  });

  it("offline base fetch proceeds from local base and stamps the PR body stale", async () => {
    // Capture the PR body gh received so we can assert the stale-base banner.
    const capture = join(h.root, "pr-body-capture.md");
    const prCreate = `prev=""
    for a in "$@"; do
      if [ "$prev" = "--body-file" ]; then cp "$a" ${JSON.stringify(capture)}; fi
      prev="$a"
    done
    echo "https://github.com/owner/repo/pull/123"; exit 0`;
    const cfg = makeConfig(h, {
      ghBin: ghShim("gh-capture.sh", prCreate),
      gitBin: gitFailShim("git-nofetch.sh", "fetch", NET),
    });
    const { task, path } = makeTicket(
      h,
      "stale.md",
      `---\nid: stale\nrepo: ${h.work}\n---\n# Add a feature\n\nDo it.\n`,
    );
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });
    expect(flow.status).toBe("completed");
    expect(flow.prUrl).toBe("https://github.com/owner/repo/pull/123");
    expect(readFileSync(capture, "utf8")).toContain("Built offline from a possibly stale base");
  });

  // -------------------------------------------------------------------------
  // Pushed-branch-with-no-PR recovery (issue #29)
  // -------------------------------------------------------------------------

  /** A fake gh built from a case-map: keys are argv-prefix globs, values are
   * `sh` bodies. Always answers `repo view`. Unhandled args exit 1. */
  function ghCases(name: string, cases: Record<string, string>): string {
    const branches = Object.entries(cases)
      .map(([glob, body]) => `  ${glob})\n    ${body} ;;`)
      .join("\n");
    const p = join(h.root, name);
    writeFileSync(
      p,
      `#!/bin/sh
args="$*"
case "$args" in
  "repo view --json nameWithOwner -q .nameWithOwner"*)
    echo "owner/repo"; exit 0 ;;
${branches}
  *)
    echo "fake-gh: unhandled: $args" >&2; exit 1 ;;
esac
`,
      "utf8",
    );
    chmodSync(p, 0o755);
    return p;
  }

  it("resume (requeued ticket): a pushed branch with no PR force-pushes over the stale tip and opens a PR", async () => {
    const cfg = makeConfig(h, {
      ghBin: ghCases("gh-resume.sh", {
        '"pr list "*': 'echo "[]"; exit 0',
        '"pr create "*': 'echo "https://github.com/owner/repo/pull/123"; exit 0',
      }),
    });

    // Simulate a crashed run: branch pushed to origin carrying a stale commit,
    // NO PR, local branch deleted (the orphan re-runs the fresh flow). Orphan
    // recovery requeued the ticket, so retry_count > 0 — the crash-recovery
    // provenance that arms the resume (#70).
    run(["git", "-C", h.work, "checkout", "-b", "junco/resume-me"]);
    writeFileSync(join(h.work, "stale.txt"), "stale\n");
    run(["git", "-C", h.work, "add", "stale.txt"]);
    run(["git", "-C", h.work, "commit", "-m", "crashed-run commit"]);
    run(["git", "-C", h.work, "push", "-u", "origin", "junco/resume-me"]);
    run(["git", "-C", h.work, "checkout", "main"]);
    run(["git", "-C", h.work, "branch", "-D", "junco/resume-me"]);

    const { task, path } = makeTicket(
      h,
      "resume-me.md",
      `---\nid: resume-me\nrepo: ${h.work}\nretry_count: 1\n---\n# Resume\n\nDo it.\n`,
    );
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true, file: "fresh.txt" }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });

    expect(flow.status).toBe("completed");
    expect(flow.prUrl).toBe("https://github.com/owner/repo/pull/123");
    // The remote branch was force-overwritten: the fresh commit is the tip and
    // the crashed run's stale commit is no longer reachable.
    const remoteLog = run(["git", "-C", h.remote, "log", "--format=%s", "junco/resume-me"]);
    expect(remoteLog).toContain("feat: fresh.txt");
    expect(remoteLog).not.toContain("crashed-run commit");
  }, 30000);

  it("fresh ticket: a colliding PR-less remote branch is REFUSED, not force-pushed (issue #70)", async () => {
    const cfg = makeConfig(h, {
      ghBin: ghCases("gh-refuse.sh", {
        '"pr list "*': 'echo "[]"; exit 0',
        '"pr create "*': 'echo "https://github.com/owner/repo/pull/999"; exit 0',
      }),
    });

    // A human's WIP branch collides on the ticket's branch_name, with no PR.
    run(["git", "-C", h.work, "checkout", "-b", "junco/collide-fresh"]);
    writeFileSync(join(h.work, "human.txt"), "human work in progress\n");
    run(["git", "-C", h.work, "add", "human.txt"]);
    run(["git", "-C", h.work, "commit", "-m", "human WIP commit"]);
    run(["git", "-C", h.work, "push", "-u", "origin", "junco/collide-fresh"]);
    run(["git", "-C", h.work, "checkout", "main"]);
    run(["git", "-C", h.work, "branch", "-D", "junco/collide-fresh"]);

    // Fresh ticket (no retry_count) — validate must REFUSE, never force-push.
    const { task, path } = makeTicket(
      h,
      "collide-fresh.md",
      `---\nid: collide-fresh\nrepo: ${h.work}\n---\n# Fresh collide\n\nDo it.\n`,
    );
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true, file: "fresh.txt" }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });

    expect(flow.dst.startsWith(h.failed)).toBe(true);
    expect(flow.phaseError).toMatch(/no open PR of ours|refusing to overwrite/i);
    // The human's branch is untouched on the remote (never force-pushed).
    const remoteLog = run(["git", "-C", h.remote, "log", "--format=%s", "junco/collide-fresh"]);
    expect(remoteLog).toContain("human WIP commit");
    expect(remoteLog).not.toContain("fresh.txt");
  }, 30000);

  it("idempotent create: gh pr create 'already exists' recovers the URL via pr list → completed", async () => {
    const cfg = makeConfig(h, {
      ghBin: ghCases("gh-exists.sh", {
        '"pr create "*': 'echo "a pull request for branch junco/idem already exists" >&2; exit 1',
        '"pr list "*':
          'echo \'[{"number":456,"url":"https://github.com/owner/repo/pull/456"}]\'; exit 0',
      }),
    });
    const { task, path } = makeTicket(
      h,
      "idem.md",
      `---\nid: idem\nrepo: ${h.work}\n---\n# Idempotent\n\nDo it.\n`,
    );
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });
    expect(flow.status).toBe("completed");
    expect(flow.prUrl).toBe("https://github.com/owner/repo/pull/456");
    expect(flow.dst.startsWith(h.done)).toBe(true);
    expect(readFileSync(flow.dst, "utf8")).toContain(
      "pr_url: https://github.com/owner/repo/pull/456",
    );
  }, 30000);

  it("deterministic gh pr create failure fails terminally (branch pushed, open manually), never requeues (issue #73)", async () => {
    const cfg = makeConfig(h, {
      ghBin: ghCases("gh-nogo.sh", {
        // A deterministic create failure (not network, not "already exists") —
        // it would fail identically on every retry.
        '"pr create "*':
          'echo "pull request create failed: No commits between main and junco/nogo" >&2; exit 1',
      }),
    });
    const { task, path } = makeTicket(
      h,
      "nogo.md",
      `---\nid: nogo\nrepo: ${h.work}\n---\n# No-go\n\nDo it.\n`,
    );
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });

    // Terminal fail — NOT requeued (a fresh ticket with retry budget available).
    expect(flow.requeued).toBe(false);
    expect(flow.dst.startsWith(h.failed)).toBe(true);
    const text = readFileSync(flow.dst, "utf8");
    expect(text).toContain("status: failed");
    expect(text).toContain("gh pr create failed (branch pushed, open manually)");
    expect(readdirSync(h.done)).toHaveLength(0);
    // The branch really did push before gh failed — the resumable state is
    // preserved on the remote for a manual open.
    expect(run(["git", "-C", h.work, "ls-remote", "--heads", "origin", "junco/nogo"])).toContain(
      "junco/nogo",
    );
  }, 30000);

  it("a network gh pr create failure whose text lands only in the offline branch queues the endgame", async () => {
    // A network create failure is caught by the offline branch and parked in the
    // outbox — it neither requeues nor fails terminally (issue #73 leaves this
    // untouched: transient create failures are still handled durably).
    const cfg = makeConfig(h, {
      ghBin: ghCases("gh-net.sh", {
        '"pr create "*': 'echo "error connecting to api.github.com" >&2; exit 1',
      }),
    });
    const { task, path } = makeTicket(
      h,
      "netpr.md",
      `---\nid: netpr\nrepo: ${h.work}\n---\n# Net\n\nDo it.\n`,
    );
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });
    expect(flow.requeued).toBe(false);
    expect(flow.prQueued).toBe(true);
    expect(TERMINAL_DONE_STATUSES.has(flow.status)).toBe(true);
    expect(listOps(cfg)).toHaveLength(1);
  }, 30000);

  // -------------------------------------------------------------------------
  // Offline amend honesty (issue #50)
  // -------------------------------------------------------------------------

  it("offline amend parks the push and the result block says the push is queued (not unqualified success)", async () => {
    const NET = "connect: network is unreachable";
    // gh answers repo view + the amend PR view; git shim fails only `push`.
    const cfg = makeConfig(h, {
      ghBin: ghCases("gh-amend.sh", {
        '"pr view "*':
          'echo \'{"state":"OPEN","headRefName":"junco/amend-me","baseRefName":"main","isDraft":true,"url":"https://github.com/owner/repo/pull/42","isCrossRepository":false}\'; exit 0',
      }),
      gitBin: gitFailShim("git-amendpush.sh", "push", NET),
    });

    // Seed an existing open-PR head branch on origin (validate + amend fetch).
    run(["git", "-C", h.work, "checkout", "-b", "junco/amend-me"]);
    writeFileSync(join(h.work, "existing.txt"), "prior PR work\n");
    run(["git", "-C", h.work, "add", "existing.txt"]);
    run(["git", "-C", h.work, "commit", "-m", "prior commit"]);
    run(["git", "-C", h.work, "push", "-u", "origin", "junco/amend-me"]);
    run(["git", "-C", h.work, "checkout", "main"]);

    const { task, path } = makeTicket(
      h,
      "amend.md",
      `---\nid: amend\nrepo: ${h.work}\namends_pr: 42\n---\n# Amend\n\nAdd more.\n`,
    );
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true, file: "more.txt" }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });

    // The commits are local + the PR URL is known, so it finalizes as it earned…
    expect(TERMINAL_DONE_STATUSES.has(flow.status)).toBe(true);
    expect(flow.status).toBe("completed");
    expect(flow.prUrl).toBe("https://github.com/owner/repo/pull/42");
    // …but the result block is HONEST that the push is only queued.
    const text = readFileSync(flow.dst, "utf8");
    expect(text).toContain("Amend push queued for offline delivery");
    expect(text).toContain("pushed: false");
    // The push really was parked in the outbox.
    const pushOps = listOps(cfg).filter((o) => o.op.kind === "push");
    expect(pushOps).toHaveLength(1);
    // prQueued stays false — the reporter's own finalize comment still runs
    // (it queues itself if still offline); only the composite fresh op sets it.
    expect(flow.prQueued).toBe(false);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Provider gate wiring (Phase 2 Task 6) — classify + gate-route the two
// zero-commit failure sites (hard-error at ~line 480, stop_reason at ~line
// 568), and report a clean run's success to the gate.
// ---------------------------------------------------------------------------

/** Records calls made by the code under test; a plain object satisfying
 * `Pick<ProviderGate, "reportFailure" | "reportSuccess" | "notBeforeIso">` —
 * mirrors the runOnce.test.ts fakeGate (Phase 2 Task 5). */
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

describe("provider gate wiring (Phase 2 Task 6)", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  /** Session whose prompt() throws — a hard non-guard error with no commits.
   * Parametrized (unlike the plain `erroringFactory` above) so different
   * gate-class/outage/unclassified error TEXTS can drive the hard-error site. */
  function throwingFactory(
    message: string,
  ): (cfg: Config, cwd: string) => () => Promise<AgentSessionLike> {
    return (_cfg, _cwd) => async () => ({
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

  /** Session that commits, THEN throws — the hard-error-WITH-commits case:
   * gate-class routing must not touch this (committed work is salvaged, not
   * discarded), regardless of the error text. */
  function commitThenThrowFactory(
    message: string,
  ): (cfg: Config, cwd: string) => () => Promise<AgentSessionLike> {
    return (_cfg, cwd) => async () => ({
      subscribe() {
        return () => {};
      },
      async prompt() {
        writeFileSync(join(cwd, "feature.txt"), `work ${Date.now()}\n`, "utf8");
        run(["git", "-C", cwd, "add", "-A"]);
        run(["git", "-C", cwd, "commit", "-m", "feat: feature.txt"]);
        throw new Error(message);
      },
      dispose() {},
      abort: async () => {},
    });
  }

  /** Session whose prompt() ends the turn with the given stopReason and no
   * commit — no thrown exception, no errorMessage on the turn (a "silent"
   * stop_reason='error'/'length'). Drives prFlow's stop_reason requeue gate
   * (~line 568): errorMessage is null, so classification there falls back to
   * the assistant's own visible text (RunResult.finalText), which is exactly
   * what `text` becomes. */
  function stopReasonFactory(
    stopReason: string,
    text: string,
  ): (cfg: Config, cwd: string) => () => Promise<AgentSessionLike> {
    return (_cfg, _cwd) => async () => {
      let listener: ((e: any) => void) | null = null;
      return {
        subscribe(l: (e: any) => void) {
          listener = l;
          return () => {};
        },
        async prompt() {
          listener?.({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: text },
          });
          listener?.({
            type: "turn_end",
            message: { stopReason, usage: { input: 5, output: 5, cacheRead: 0, totalTokens: 10 } },
          });
          listener?.({ type: "agent_end", messages: [], willRetry: false });
        },
        dispose() {},
        abort: async () => {},
      };
    };
  }

  /** Local copy of the outer describe block's `timingOutFactory` (that one is
   * scoped to its own callback, not visible here): commits, then hangs until
   * runAgent's timeout timer aborts it — produces a timedOut, salvaged RunResult. */
  function timingOutFactory(
    opts: { commit?: boolean } = {},
  ): (cfg: Config, cwd: string) => () => Promise<AgentSessionLike> {
    const { commit = true } = opts;
    return (_cfg, cwd) => async () => {
      let resolveHang: (() => void) | null = null;
      return {
        subscribe() {
          return () => {};
        },
        async prompt() {
          if (commit) {
            writeFileSync(join(cwd, "salvage.txt"), "work before the cutoff\n", "utf8");
            run(["git", "-C", cwd, "add", "-A"]);
            run(["git", "-C", cwd, "commit", "-m", "feat: salvage"]);
          }
          await new Promise<void>((r) => {
            resolveHang = r;
          }); // hang until abort()
        },
        dispose() {},
        abort: async () => {
          resolveHang?.();
        },
      };
    };
  }

  it("gate-class zero-commit 401 (hard-error site) requeues WITHOUT consuming the retry budget and reports auth to the gate", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "auth401.md",
      `---\nid: auth401\nrepo: ${h.work}\n---\n# Flaky\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: throwingFactory("401 invalid x-api-key"),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.requeued).toBe(true);
    expect(flow.dst).toContain(join("Junco", "inbox"));
    const content = readFileSync(flow.dst, "utf8");
    expect(content).not.toMatch(/retry_count:/); // absent, not bumped
    expect(content).toMatch(/not_before:/);
    expect(gate.failureCalls).toEqual([{ cls: "auth", reason: "401 invalid x-api-key" }]);
    expect(readdirSync(h.wtsRoot)).toHaveLength(0); // worktree cleaned for the retry
  });

  it("WITH commits + 401 (hard-error site): gate is NOT consulted; the existing salvage (preserve + fail) path is unchanged", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "auth401commits.md",
      `---\nid: auth401commits\nrepo: ${h.work}\n---\n# Flaky\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitThenThrowFactory("401 invalid x-api-key"),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.status).toBe("failed");
    expect(flow.dst.startsWith(h.failed)).toBe(true);
    const text = readFileSync(flow.dst, "utf8");
    expect(text).toContain("status: failed");
    expect(text).toContain("Worktree preserved");
    expect(gate.failureCalls).toEqual([]); // never consulted — commits exist
    expect(readdirSync(h.wtsRoot)).toHaveLength(1); // preserved, not cleaned
  });

  it("prose '429' in finalText at the stop_reason site does NOT consult the gate — agent prose never reaches the classifier", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "rate429.md",
      `---\nid: rate429\nrepo: ${h.work}\n---\n# Flaky\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: stopReasonFactory("error", "429 too many requests"),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.requeued).toBe(true);
    expect(flow.dst).toContain(join("Junco", "inbox"));
    const content = readFileSync(flow.dst, "utf8");
    expect(content).toMatch(/retry_count: 1/); // BUDGETED requeue — not the gate's count-free one
    expect(content).toMatch(/not_before:/);
    expect(gate.failureCalls).toEqual([]); // errorMessage is null here; prose must never latch
  });

  it("outage zero-commit (hard-error site, thrown ECONNREFUSED) reports outage to the gate but keeps the BUDGETED requeue path", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "outage1.md",
      `---\nid: outage1\nrepo: ${h.work}\n---\n# Flaky\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: throwingFactory("connect ECONNREFUSED 127.0.0.1:1234"),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.requeued).toBe(true);
    const content = readFileSync(flow.dst, "utf8");
    expect(content).toMatch(/retry_count: 1/); // budgeted path, NOT the gate's count-free one
    expect(content).toMatch(/not_before:/);
    expect(gate.failureCalls).toEqual([
      { cls: "outage", reason: "connect ECONNREFUSED 127.0.0.1:1234" },
    ]);
  });

  it("outage-looking prose in finalText at the stop_reason site does NOT reach the gate — budgeted requeue only", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "outage2.md",
      `---\nid: outage2\nrepo: ${h.work}\n---\n# Flaky\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: stopReasonFactory("length", "fetch failed: upstream reset"),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.requeued).toBe(true);
    const content = readFileSync(flow.dst, "utf8");
    expect(content).toMatch(/retry_count: 1/);
    expect(content).toMatch(/not_before:/);
    expect(gate.failureCalls).toEqual([]); // prose, not a structured errorMessage — no gate report
  });

  it("false-positive regression: agent prose mentioning 429/403/billing at stop_reason=length never latches the gate", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "prose-latch.md",
      `---\nid: prose-latch\nrepo: ${h.work}\n---\n# Handle limits\n\nAdd rate limit handling.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    // Truncated agent PROSE about the ticket's subject matter — exactly the
    // text that must never be mistaken for a provider failure: it name-drops
    // a 429, a 403, and billing while being a work narration, not an error.
    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: stopReasonFactory(
        "length",
        "I will add 429 rate limit handling, fix the 403 handling, and update the billing retry docs",
      ),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.requeued).toBe(true);
    const content = readFileSync(flow.dst, "utf8");
    expect(content).toMatch(/retry_count: 1/); // budgeted path — the count IS consumed
    expect(gate.failureCalls).toEqual([]); // and the gate never hears about it
  });

  it("an unclassified stop_reason='error' with a gate present still uses the existing budgeted requeue path and does not consult the gate", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "plaintext568.md",
      `---\nid: plaintext568\nrepo: ${h.work}\n---\n# Flaky\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: stopReasonFactory("error", "agent gave up trying"),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.requeued).toBe(true);
    const content = readFileSync(flow.dst, "utf8");
    expect(content).toMatch(/retry_count: 1/); // budgeted path consumed the count
    expect(gate.failureCalls).toEqual([]); // no latch — classifier says unknown
  });

  it("a stop_reason='error' zero-commit run without a gate in deps falls back to the plain requeueTicket path (byte-identical pre-gate behavior)", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "nogate568.md",
      `---\nid: nogate568\nrepo: ${h.work}\n---\n# Flaky\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: stopReasonFactory("error", "429 too many requests"),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.requeued).toBe(true);
    const content = readFileSync(flow.dst, "utf8");
    expect(content).toMatch(/retry_count: 1/); // budgeted path, not the gate's count-free path
    expect(content).toMatch(/not_before:/);
  });

  it("a successful run (commits, push, PR opened) reports success to the gate exactly once", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "gatesuccess.md",
      `---\nid: gatesuccess\nrepo: ${h.work}\n---\n# Add a feature\n\nMake a change.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: true }),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.status).toBe("completed");
    expect(gate.successCalls).toBe(1);
    expect(gate.failureCalls).toEqual([]);
  });

  it("a clean no-changes finish also reports success to the gate exactly once", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "gatenochange.md",
      `---\nid: gatenochange\nrepo: ${h.work}\n---\n# No-op ticket\n\nDecide nothing is needed.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: false }),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.status).toBe("completed_no_changes");
    expect(gate.successCalls).toBe(1);
    expect(gate.failureCalls).toEqual([]);
  });

  it("a timed-out salvage run with commits does NOT report success to the gate", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "gatetimeout.md",
      `---\nid: gatetimeout\nrepo: ${h.work}\ntimeout_minutes: 0.005\n---\n# Slow\n\nDo a thing.\n`,
    );
    const ctx = ctxFor(cfg, task);
    const gate = fakeGate();

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: timingOutFactory({ commit: true }),
      gate,
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.status).toBe("timeout_partial");
    expect(gate.successCalls).toBe(0);
    expect(gate.failureCalls).toEqual([]);
  }, 20000);
});

// ---------------------------------------------------------------------------
// Fork PR flow (Task 10) — push to a non-origin remote, open the PR against
// upstream with a cross-repo --head, and keep the outbox silent on the upstream
// issue for external tickets.
// ---------------------------------------------------------------------------

/**
 * Fork-flavoured harness: `origin` -> upstream.git, `fork` -> a github.com URL
 * rewritten (via insteadOf) to a local fork.git. Shaped as the module's
 * `Harness` so makeConfig/makeTicket/ctxFor/commitFactory all apply unchanged.
 * The fake gh answers `repo view` with the UPSTREAM nwo and records `pr create`
 * argv to `argsFile` so the cross-repo --head can be asserted.
 */
function setupFork(): {
  h: Harness;
  upstream: string;
  forkRemote: string;
  argsFile: string;
} {
  const root = mkdtempSync(join(tmpdir(), "junco-prflow-fork-"));
  const fh = setupForkHarness(root); // creates upstream.git, fork.git, work under root
  const wtsRoot = join(root, "wts");
  const processing = join(root, "processing");
  const done = join(root, "done");
  const failed = join(root, "failed");
  [wtsRoot, processing, done, failed].forEach((d) => mkdirSync(d, { recursive: true }));

  const argsFile = join(root, "gh-args.log");
  const ghBin = join(root, "fake-gh-fork.sh");
  writeFileSync(
    ghBin,
    `#!/bin/sh
args="$*"
case "$args" in
  "repo view --json nameWithOwner -q .nameWithOwner"*)
    echo "\${FAKE_GH_NWO:-up/stream}"; exit 0 ;;
  "pr create "*)
    printf '%s\\n' "$*" >> ${JSON.stringify(argsFile)}
    echo "https://github.com/up/stream/pull/7"; exit 0 ;;
  *)
    echo "fake-gh: unhandled: $args" >&2; exit 1 ;;
esac
`,
    "utf8",
  );
  chmodSync(ghBin, 0o755);

  const h: Harness = {
    root,
    remote: fh.upstream,
    work: fh.work,
    wtsRoot,
    ghBin,
    processing,
    done,
    failed,
  };
  return { h, upstream: fh.upstream, forkRemote: fh.forkRemote, argsFile };
}

/** External fork ticket: push_remote fork + a bridged, external github block. */
function forkTicketContent(work: string): string {
  return `---
id: gh-up-stream-7
repo: ${JSON.stringify(work)}
push_remote: fork
pr_title: "Fix the thing"
github:
  nwo: "up/stream"
  issue: 7
  kind: pr
  external: true
---
# Fix the thing
`;
}

describe("runPrFlow — fork PR flow", () => {
  let h: Harness;
  let upstream: string;
  let forkRemote: string;
  let argsFile: string;

  beforeEach(() => {
    ({ h, upstream, forkRemote, argsFile } = setupFork());
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  it("fork ticket: pushes to the fork, opens PR --head me:branch against upstream", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(h, "gh-up-stream-7.md", forkTicketContent(h.work));
    const ctx = ctxFor(cfg, task);

    const flow = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(flow.status).toBe("completed");
    expect(flow.prUrl).toBe("https://github.com/up/stream/pull/7");
    expect(readFileSync(flow.dst, "utf8")).toContain("pushed: true");

    // Branch landed on the FORK bare, not upstream.
    expect(
      run(["git", "-C", forkRemote, "rev-parse", "refs/heads/junco/gh-up-stream-7"]).trim(),
    ).toBeTruthy();
    expect(() =>
      run(["git", "-C", upstream, "rev-parse", "refs/heads/junco/gh-up-stream-7"]),
    ).toThrow();

    // gh pr create carried the cross-repo head form <fork-owner>:<branch>.
    const create = readFileSync(argsFile, "utf8");
    expect(create).toContain("--head me:junco/gh-up-stream-7");
    expect(create).toContain("--repo up/stream");
  }, 30000);

  it("offline fork ticket: queued pr op has remote/head set and finalize null (external)", async () => {
    // A git shim that fails only `push` with a network-shaped stderr → the whole
    // push→PR→finalize endgame parks in the outbox. Everything else (config,
    // ls-remote, fetch, worktree add) delegates to the real git.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const NET = "connect: network is unreachable";
    const gitBin = join(h.root, "git-offpush-fork.sh");
    writeFileSync(
      gitBin,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "push" ]; then
    echo ${JSON.stringify(NET)} >&2
    exit 1
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`,
      "utf8",
    );
    chmodSync(gitBin, 0o755);

    // A default workflow label would flow into ctx.labels; a fork PR must drop it.
    const cfg = makeConfig(h, { gitBin, defaultLabels: ["junco"] });
    const { task, path } = makeTicket(h, "gh-up-stream-7.md", forkTicketContent(h.work));
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5, // don't eat real network backoff in tests
    });

    expect(flow.prQueued).toBe(true);
    expect(TERMINAL_DONE_STATUSES.has(flow.status)).toBe(true);
    const ops = listOps(cfg);
    const pr = ops.find((o) => o.op.kind === "pr")!.op as Extract<OutboxOp, { kind: "pr" }>;
    expect(pr.remote).toBe("fork");
    expect(pr.head).toBe(`${FORK_NWO.split("/")[0]}:junco/gh-up-stream-7`);
    expect(pr.labels).toEqual([]); // fork PRs are label-free (upstream namespace not ours)
    expect(pr.finalize).toBeNull(); // external — no upstream comment/label replay
  }, 30000);

  it("fork PR recovery: 'already exists' resolves the URL via gh pr list --head owner:branch (issue #75)", async () => {
    // gh pr create reports the fork PR already exists; recovery must resolve its
    // URL. `gh pr view <owner>:<branch>` cannot resolve a cross-repo selector, so
    // the recovery uses `gh pr list --head <owner>:<branch>` instead (#75).
    const listArgs = join(h.root, "gh-list-args.log");
    const ghBin = join(h.root, "fake-gh-fork-exists.sh");
    writeFileSync(
      ghBin,
      `#!/bin/sh
args="$*"
case "$args" in
  "repo view --json nameWithOwner -q .nameWithOwner"*)
    echo "up/stream"; exit 0 ;;
  "pr create "*)
    echo "a pull request for branch me:junco/gh-up-stream-7 already exists" >&2; exit 1 ;;
  "pr list "*)
    printf '%s\\n' "$*" >> ${JSON.stringify(listArgs)}
    echo '[{"number":7,"url":"https://github.com/up/stream/pull/7"}]'; exit 0 ;;
  *)
    echo "fake-gh: unhandled: $args" >&2; exit 1 ;;
esac
`,
      "utf8",
    );
    chmodSync(ghBin, 0o755);

    const cfg = makeConfig(h, { ghBin });
    const { task, path } = makeTicket(h, "gh-up-stream-7.md", forkTicketContent(h.work));
    const flow = await runPrFlow(cfg, task, path, ctxFor(cfg, task), {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
      retryBaseDelayMs: 5,
    });

    expect(flow.status).toBe("completed");
    expect(flow.prUrl).toBe("https://github.com/up/stream/pull/7");
    expect(flow.dst.startsWith(h.done)).toBe(true);
    // Recovery used the cross-repo head qualifier that gh pr list supports.
    const listArgv = readFileSync(listArgs, "utf8");
    expect(listArgv).toContain("--head me:junco/gh-up-stream-7");
    expect(listArgv).toContain("--state open");
  }, 30000);
});

// ---------------------------------------------------------------------------
// buildPrBody — github provenance (Closes line)
// ---------------------------------------------------------------------------

describe("buildPrBody github provenance", () => {
  const bodyTicket = (github: Ticket["github"]): Ticket => ({
    ...parseTicket("/q/t.md", `---\nid: t\nrepo: /r\n---\n# T\n\nDo it.\n`, 30),
    github,
  });
  const emptyOutcome: PrOutcome = {
    statusOverride: null,
    nwo: "acme/api",
    branch: "junco/t",
    baseBranch: "main",
    prUrl: null,
    commits: [],
    pushed: false,
    worktreePath: null,
    worktreePreserved: false,
    amendedPrNumber: null,
    verification: null,
    critic: null,
    criticRetriesUsed: 0,
    prQueued: false,
    staleBase: false,
  };
  const okResult = {
    finalText: "done.",
    toolCalls: [],
    usage: { input: 1, output: 1, cacheRead: 0, total: 2, costUsd: 0 },
    stopReason: "stop",
    errorMessage: null,
    timedOut: false,
    durationMs: 1000,
    abortedByGuard: false,
  };
  const ctx = {
    repo: "/r",
    baseBranch: "main",
    branchName: "junco/t",
    prTitle: null,
    draft: true,
    labels: [],
    reviewers: [],
    amendsPr: null,
    pushRemote: "origin",
    forkNwo: null,
  } as never;

  it("appends a Closes line for bridged pr tickets", () => {
    const t = bodyTicket({ nwo: "acme/api", issue: 42, kind: "pr", external: false });
    expect(buildPrBody(t, ctx, emptyOutcome, okResult)).toContain("Closes acme/api#42");
  });

  it("external ticket PR body still carries the Closes footer", () => {
    // External (fork) tickets still auto-close the upstream issue on merge — the
    // deterministic Closes footer is fork-agnostic and must survive.
    const t = bodyTicket({ nwo: "up/stream", issue: 7, kind: "pr", external: true });
    expect(buildPrBody(t, ctx, emptyOutcome, okResult)).toContain("Closes up/stream#7");
  });

  it("omits the Closes line for local tickets and ask tickets", () => {
    expect(buildPrBody(bodyTicket(null), ctx, emptyOutcome, okResult)).not.toContain("Closes ");
    const ask = bodyTicket({ nwo: "acme/api", issue: 42, kind: "ask", external: false });
    expect(buildPrBody(ask, ctx, emptyOutcome, okResult)).not.toContain("Closes ");
  });

  it("stamps a stale-base warning when the outcome was built offline", () => {
    const t = bodyTicket(null);
    expect(buildPrBody(t, ctx, { ...emptyOutcome, staleBase: true }, okResult)).toContain(
      "> ⚠️ Built offline from a possibly stale base — rebase check recommended.",
    );
    expect(buildPrBody(t, ctx, emptyOutcome, okResult)).not.toContain("stale base");
  });
});
