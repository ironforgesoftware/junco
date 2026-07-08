/**
 * Tests for src/pr.ts — commit/push/PR-open operations.
 * Written FIRST (TDD). These fail until pr.ts is implemented.
 *
 * Uses a REAL git harness: bare remote + working clone with commits.
 * Fake gh via a small script pointed at by cfg.ghBin.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  countNewCommits,
  listNewCommits,
  commitLeftovers,
  pushBranch,
  openPullRequest,
  derivePrTitle,
} from "../src/pr.js";
import { GitOpError } from "../src/git.js";
import type { RepoContext } from "../src/repoContext.js";
import type { Config } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

function run(args: string[], cwd?: string): string {
  return execFileSync(args[0], args.slice(1), {
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

/** Set up a bare remote + seeded working clone in tmp. Returns paths. */
function setupGitHarness(tmpRoot: string): {
  remote: string;
  work: string;
} {
  const remote = join(tmpRoot, "remote.git");
  const work = join(tmpRoot, "work");

  // Init bare remote
  run(["git", "init", "--bare", "-b", "main", remote]);

  // Init working repo
  run(["git", "init", "-b", "main", work]);
  run(["git", "-C", work, "config", "user.email", "ci@example.com"]);
  run(["git", "-C", work, "config", "user.name", "CI"]);
  run(["git", "-C", work, "config", "commit.gpgsign", "false"]);

  // Seed a commit
  writeFileSync(join(work, "README.md"), "seed\n");
  run(["git", "-C", work, "add", "README.md"]);
  run(["git", "-C", work, "commit", "-m", "seed"]);

  // Connect to remote + push
  run(["git", "-C", work, "remote", "add", "origin", remote]);
  run(["git", "-C", work, "push", "-u", "origin", "main"]);

  return { remote, work };
}

function makeConfig(work: string, tmpRoot: string, ghBin = "gh"): Config {
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
    ghBin,
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: join(tmpRoot, "wts"),
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
  };
}

function makeContext(work: string, overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    repo: work,
    baseBranch: "main",
    branchName: "junco/test-feature",
    draft: false,
    prTitle: null,
    labels: [],
    reviewers: [],
    amendsPr: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Global tmp dir per test file
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "junco-pr-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// countNewCommits
// ---------------------------------------------------------------------------

describe("countNewCommits", () => {
  it("returns 2 when 2 commits were made past a ref", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, tmpRoot);

    // Capture current HEAD as sinceRef
    const sinceRef = run(["git", "-C", work, "rev-parse", "HEAD"]).trim();

    // Make 2 new commits
    writeFileSync(join(work, "a.txt"), "a\n");
    run(["git", "-C", work, "add", "a.txt"]);
    run(["git", "-C", work, "commit", "-m", "commit a"]);

    writeFileSync(join(work, "b.txt"), "b\n");
    run(["git", "-C", work, "add", "b.txt"]);
    run(["git", "-C", work, "commit", "-m", "commit b"]);

    const count = await countNewCommits(cfg, work, sinceRef);
    expect(count).toBe(2);
  }, 15000);

  it("returns 0 for a bad (non-existent) ref", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, tmpRoot);

    const count = await countNewCommits(cfg, work, "nonexistent-ref-xyz");
    expect(count).toBe(0);
  }, 15000);
});

// ---------------------------------------------------------------------------
// listNewCommits
// ---------------------------------------------------------------------------

describe("listNewCommits", () => {
  it("returns [{sha, subject}] for new commits with correct subjects", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, tmpRoot);

    const sinceRef = run(["git", "-C", work, "rev-parse", "HEAD"]).trim();

    writeFileSync(join(work, "x.txt"), "x\n");
    run(["git", "-C", work, "add", "x.txt"]);
    run(["git", "-C", work, "commit", "-m", "first new commit"]);

    writeFileSync(join(work, "y.txt"), "y\n");
    run(["git", "-C", work, "add", "y.txt"]);
    run(["git", "-C", work, "commit", "-m", "second new commit"]);

    const commits = await listNewCommits(cfg, work, sinceRef);

    // Should return 2 commits (newest first, as git log default)
    expect(commits).toHaveLength(2);

    // Each has sha and subject
    for (const c of commits) {
      expect(c.sha).toMatch(/^[0-9a-f]+$/);
      expect(typeof c.subject).toBe("string");
    }

    // Subjects match (log is newest-first)
    expect(commits[0].subject).toBe("second new commit");
    expect(commits[1].subject).toBe("first new commit");
  }, 15000);

  it("returns empty array when there are no new commits", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, tmpRoot);

    const sinceRef = run(["git", "-C", work, "rev-parse", "HEAD"]).trim();

    const commits = await listNewCommits(cfg, work, sinceRef);
    expect(commits).toHaveLength(0);
  }, 15000);
});

// ---------------------------------------------------------------------------
// commitLeftovers
// ---------------------------------------------------------------------------

describe("commitLeftovers", () => {
  it("stages and commits a dirty worktree, leaving it clean", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, tmpRoot);

    // Dirty the worktree: new untracked file + modified tracked file
    writeFileSync(join(work, "new-file.txt"), "new content\n");
    writeFileSync(join(work, "README.md"), "modified\n");

    // Verify it's dirty
    const statusBefore = run(["git", "-C", work, "status", "--porcelain"]).trim();
    expect(statusBefore).not.toBe("");

    await commitLeftovers(cfg, work, "leftover changes");

    // Now it should be clean
    const statusAfter = run(["git", "-C", work, "status", "--porcelain"]).trim();
    expect(statusAfter).toBe("");

    // And a new commit should exist with the right message
    const lastMsg = run(["git", "-C", work, "log", "-1", "--format=%s"]).trim();
    expect(lastMsg).toBe("leftover changes");
  }, 15000);

  it("succeeds with an empty message (--allow-empty-message)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, tmpRoot);

    writeFileSync(join(work, "extra.txt"), "extra\n");
    run(["git", "-C", work, "add", "extra.txt"]);

    // Unstage it to make it untracked again
    run(["git", "-C", work, "reset", "HEAD", "extra.txt"]);

    await expect(commitLeftovers(cfg, work, "")).resolves.not.toThrow();
  }, 15000);
});

// ---------------------------------------------------------------------------
// pushBranch
// ---------------------------------------------------------------------------

describe("pushBranch", () => {
  it("pushes a branch to the bare remote", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, tmpRoot);

    // Create a new branch with a commit
    run(["git", "-C", work, "checkout", "-b", "junco/push-test"]);
    writeFileSync(join(work, "push.txt"), "push\n");
    run(["git", "-C", work, "add", "push.txt"]);
    run(["git", "-C", work, "commit", "-m", "push test commit"]);

    await pushBranch(cfg, work, "junco/push-test");

    // Assert the branch now exists on the remote
    const lsRemote = run(["git", "-C", work, "ls-remote", "--heads", "origin", "junco/push-test"]);
    expect(lsRemote.trim()).not.toBe("");
  }, 30000);
});

// ---------------------------------------------------------------------------
// openPullRequest
// ---------------------------------------------------------------------------

/**
 * Write a fake gh script that:
 * - Logs its argv to a file at $FAKE_GH_LOG_FILE (if set).
 * - Prints the value of $FAKE_GH_OUTPUT (default: nothing).
 * - Exits with $FAKE_GH_EXIT_CODE (default: 0).
 */
function writeFakeGhForPr(scriptPath: string): void {
  const script = `#!/bin/sh
# Fake gh for pr.test.ts
if [ -n "\${FAKE_GH_LOG_FILE}" ]; then
  printf '%s\\n' "$*" >> "\${FAKE_GH_LOG_FILE}"
fi
if [ -n "\${FAKE_GH_OUTPUT}" ]; then
  printf '%s\\n' "\${FAKE_GH_OUTPUT}"
fi
exit "\${FAKE_GH_EXIT_CODE:-0}"
`;
  writeFileSync(scriptPath, script, { encoding: "utf8" });
  chmodSync(scriptPath, 0o755);
}

describe("openPullRequest", () => {
  it("returns the PR URL (last https:// line of stdout)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const ghScript = join(tmpRoot, "fake-gh.sh");
    writeFakeGhForPr(ghScript);
    const cfg = makeConfig(work, tmpRoot, ghScript);
    mkdirSync(cfg.worktreeRoot, { recursive: true });
    const ctx = makeContext(work, {
      branchName: "junco/my-feature",
      baseBranch: "main",
      draft: false,
      labels: [],
      reviewers: [],
    });

    const bodyFile = join(tmpRoot, "body.md");
    writeFileSync(bodyFile, "PR body\n");

    process.env.FAKE_GH_OUTPUT = "Some preamble text\nhttps://github.com/owner/repo/pull/7";
    process.env.FAKE_GH_EXIT_CODE = "0";
    process.env.FAKE_GH_LOG_FILE = join(tmpRoot, "gh-args.log");
    try {
      const url = await openPullRequest(cfg, ctx, "owner/repo", "My PR", bodyFile);
      expect(url).toBe("https://github.com/owner/repo/pull/7");
    } finally {
      delete process.env.FAKE_GH_OUTPUT;
      delete process.env.FAKE_GH_EXIT_CODE;
      delete process.env.FAKE_GH_LOG_FILE;
    }
  }, 15000);

  it("passes --draft when ctx.draft is true", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const ghScript = join(tmpRoot, "fake-gh.sh");
    writeFakeGhForPr(ghScript);
    const cfg = makeConfig(work, tmpRoot, ghScript);
    mkdirSync(cfg.worktreeRoot, { recursive: true });
    const ctx = makeContext(work, {
      branchName: "junco/draft-feature",
      baseBranch: "main",
      draft: true,
      labels: [],
      reviewers: [],
    });

    const bodyFile = join(tmpRoot, "body.md");
    writeFileSync(bodyFile, "body\n");
    const logFile = join(tmpRoot, "gh-draft.log");

    process.env.FAKE_GH_OUTPUT = "https://github.com/owner/repo/pull/8";
    process.env.FAKE_GH_EXIT_CODE = "0";
    process.env.FAKE_GH_LOG_FILE = logFile;
    try {
      await openPullRequest(cfg, ctx, "owner/repo", "Draft PR", bodyFile);
      const logged = readFileSync(logFile, "utf8");
      expect(logged).toContain("--draft");
    } finally {
      delete process.env.FAKE_GH_OUTPUT;
      delete process.env.FAKE_GH_EXIT_CODE;
      delete process.env.FAKE_GH_LOG_FILE;
    }
  }, 15000);

  it("passes --label per label", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const ghScript = join(tmpRoot, "fake-gh.sh");
    writeFakeGhForPr(ghScript);
    const cfg = makeConfig(work, tmpRoot, ghScript);
    mkdirSync(cfg.worktreeRoot, { recursive: true });
    const ctx = makeContext(work, {
      branchName: "junco/labeled",
      baseBranch: "main",
      draft: false,
      labels: ["bug", "enhancement"],
      reviewers: [],
    });

    const bodyFile = join(tmpRoot, "body.md");
    writeFileSync(bodyFile, "body\n");
    const logFile = join(tmpRoot, "gh-labels.log");

    process.env.FAKE_GH_OUTPUT = "https://github.com/owner/repo/pull/9";
    process.env.FAKE_GH_EXIT_CODE = "0";
    process.env.FAKE_GH_LOG_FILE = logFile;
    try {
      await openPullRequest(cfg, ctx, "owner/repo", "Labeled PR", bodyFile);
      const logged = readFileSync(logFile, "utf8");
      expect(logged).toContain("--label bug");
      expect(logged).toContain("--label enhancement");
    } finally {
      delete process.env.FAKE_GH_OUTPUT;
      delete process.env.FAKE_GH_EXIT_CODE;
      delete process.env.FAKE_GH_LOG_FILE;
    }
  }, 15000);

  it("passes --reviewer per reviewer", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const ghScript = join(tmpRoot, "fake-gh.sh");
    writeFakeGhForPr(ghScript);
    const cfg = makeConfig(work, tmpRoot, ghScript);
    mkdirSync(cfg.worktreeRoot, { recursive: true });
    const ctx = makeContext(work, {
      branchName: "junco/reviewed",
      baseBranch: "main",
      draft: false,
      labels: [],
      reviewers: ["alice", "bob"],
    });

    const bodyFile = join(tmpRoot, "body.md");
    writeFileSync(bodyFile, "body\n");
    const logFile = join(tmpRoot, "gh-reviewers.log");

    process.env.FAKE_GH_OUTPUT = "https://github.com/owner/repo/pull/10";
    process.env.FAKE_GH_EXIT_CODE = "0";
    process.env.FAKE_GH_LOG_FILE = logFile;
    try {
      await openPullRequest(cfg, ctx, "owner/repo", "Reviewed PR", bodyFile);
      const logged = readFileSync(logFile, "utf8");
      expect(logged).toContain("--reviewer alice");
      expect(logged).toContain("--reviewer bob");
    } finally {
      delete process.env.FAKE_GH_OUTPUT;
      delete process.env.FAKE_GH_EXIT_CODE;
      delete process.env.FAKE_GH_LOG_FILE;
    }
  }, 15000);

  it("throws GitOpError when gh prints non-URL output", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const ghScript = join(tmpRoot, "fake-gh.sh");
    writeFakeGhForPr(ghScript);
    const cfg = makeConfig(work, tmpRoot, ghScript);
    mkdirSync(cfg.worktreeRoot, { recursive: true });
    const ctx = makeContext(work, {
      branchName: "junco/no-url",
      baseBranch: "main",
      draft: false,
      labels: [],
      reviewers: [],
    });

    const bodyFile = join(tmpRoot, "body.md");
    writeFileSync(bodyFile, "body\n");

    process.env.FAKE_GH_OUTPUT = "not a url at all";
    process.env.FAKE_GH_EXIT_CODE = "0";
    try {
      await expect(openPullRequest(cfg, ctx, "owner/repo", "No URL PR", bodyFile)).rejects.toThrow(
        GitOpError,
      );
    } finally {
      delete process.env.FAKE_GH_OUTPUT;
      delete process.env.FAKE_GH_EXIT_CODE;
    }
  }, 15000);

  it("throws GitOpError when gh produces no output", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const ghScript = join(tmpRoot, "fake-gh.sh");
    writeFakeGhForPr(ghScript);
    const cfg = makeConfig(work, tmpRoot, ghScript);
    mkdirSync(cfg.worktreeRoot, { recursive: true });
    const ctx = makeContext(work, { branchName: "junco/empty-output" });

    const bodyFile = join(tmpRoot, "body.md");
    writeFileSync(bodyFile, "body\n");

    // No FAKE_GH_OUTPUT set → empty output
    delete process.env.FAKE_GH_OUTPUT;
    process.env.FAKE_GH_EXIT_CODE = "0";
    try {
      await expect(openPullRequest(cfg, ctx, "owner/repo", "Empty PR", bodyFile)).rejects.toThrow(
        GitOpError,
      );
    } finally {
      delete process.env.FAKE_GH_EXIT_CODE;
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// derivePrTitle
// ---------------------------------------------------------------------------

describe("derivePrTitle", () => {
  it("returns ctx.prTitle when set", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: "My explicit title" });
    const task = { id: "TASK-1", body: "# Heading\nbody" };
    expect(derivePrTitle(ctx, task)).toBe("My explicit title");
  });

  it("returns first H1 heading from task body when prTitle is null", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: null });
    const task = { id: "TASK-1", body: "Some preamble\n# First Heading\n## Second\nbody" };
    expect(derivePrTitle(ctx, task)).toBe("First Heading");
  });

  it("returns task.id when H1 heading text is empty after trimming", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: null });
    const task = { id: "TASK-99", body: "#   \nbody" };
    expect(derivePrTitle(ctx, task)).toBe("TASK-99");
  });

  it("returns task.id when no H1 heading exists in body", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: null });
    const task = { id: "TASK-2", body: "## Not H1\nSome body text" };
    expect(derivePrTitle(ctx, task)).toBe("TASK-2");
  });

  it("returns task.id when body is empty", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: null });
    const task = { id: "TASK-3", body: "" };
    expect(derivePrTitle(ctx, task)).toBe("TASK-3");
  });

  it("ctx.prTitle takes priority over H1 heading", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: "Explicit wins" });
    const task = { id: "TASK-4", body: "# H1 Heading" };
    expect(derivePrTitle(ctx, task)).toBe("Explicit wins");
  });
});
