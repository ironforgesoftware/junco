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
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runPrFlow } from "../src/prFlow.js";
import { deriveRepoContext } from "../src/repoContext.js";
import { parseTicket } from "../src/ticket.js";
import type { Config, Ticket } from "../src/types.js";
import type { AgentSessionLike } from "../src/agent/session.js";

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
    omlx: { url: "http://127.0.0.1:1234/v1", apiKey: "test" },
    modelId: "test/model",
    tools: [],
    defaultTimeoutMinutes: 30,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
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
          message: { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 } },
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

    const dst = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: completed");
    expect(text).toContain("pr_url: https://github.com/owner/repo/pull/123");
    expect(text).toContain("pushed: true");
    expect(text).toContain("branch: junco/happy");
    // The branch landed on the remote.
    const remoteBranches = run(["git", "-C", h.work, "ls-remote", "--heads", "origin", "junco/happy"]);
    expect(remoteBranches).toContain("junco/happy");
  });

  it("no-changes: agent makes no commit → completed_no_changes → done/, no push", async () => {
    const cfg = makeConfig(h);
    const { task, path } = makeTicket(
      h,
      "noop.md",
      `---\nid: noop\nrepo: ${h.work}\n---\n# No-op ticket\n\nDecide nothing is needed.\n`,
    );
    const ctx = ctxFor(cfg, task);

    const dst = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: false }),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: completed_no_changes");
    expect(text).toContain("pushed: false");
    // No branch pushed.
    const remoteBranches = run(["git", "-C", h.work, "ls-remote", "--heads", "origin", "junco/noop"]);
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
    const dst = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: () => {
        agentCalled = true;
        return commitFactory({ commit: true })(cfg, h.wtsRoot)();
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
    const { task, path } = makeTicket(h, "verify.md", `---\nid: verify\nrepo: ${h.work}\n---\n${body}`);
    const ctx = ctxFor(cfg, task);

    const dst = await runPrFlow(cfg, task, path, ctx, {
      sessionFactoryFor: commitFactory({ commit: true }),
      dirs: { done: h.done, failed: h.failed },
    });

    expect(dst.startsWith(h.failed)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: failed");
    expect(text).toContain("verification gate blocked push");
    // No branch pushed.
    const remoteBranches = run(["git", "-C", h.work, "ls-remote", "--heads", "origin", "junco/verify"]);
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
    const dst = await runPrFlow(cfg, task, path, ctx, {
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
});
