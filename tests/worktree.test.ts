/**
 * Tests for src/worktree.ts — git worktree provisioning.
 * Written FIRST (TDD). These fail until worktree.ts is implemented.
 *
 * Uses a REAL git harness: bare remote + seeded working repo.
 * No network calls; all git operations are local.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  chmodSync,
  writeFileSync,
  readlinkSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  worktreeSlug,
  currentHeadSha,
  linkNodeModules,
  prepareWorktree,
  cleanupWorktree,
  pruneStaleWorktrees,
} from "../src/worktree.js";
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
  wtsRoot: string;
} {
  const remote = join(tmpRoot, "remote.git");
  const work = join(tmpRoot, "work");
  const wtsRoot = join(tmpRoot, "wts");

  // Init bare remote
  run(["git", "init", "--bare", "-b", "main", remote]);

  // Init working repo
  run(["git", "init", "-b", "main", work]);
  run(["git", "-C", work, "config", "user.email", "ci@example.com"]);
  run(["git", "-C", work, "config", "user.name", "CI"]);
  run(["git", "-C", work, "config", "commit.gpgsign", "false"]);

  // Seed a commit
  const readmePath = join(work, "README.md");
  writeFileSync(readmePath, "seed\n");
  run(["git", "-C", work, "add", "README.md"]);
  run(["git", "-C", work, "commit", "-m", "seed"]);

  // Connect to remote + push
  run(["git", "-C", work, "remote", "add", "origin", remote]);
  run(["git", "-C", work, "push", "-u", "origin", "main"]);

  return { remote, work, wtsRoot };
}

function makeConfig(work: string, wtsRoot: string): Config {
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
    supervisorEnabled: false,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    ghBin: "gh", // not used in worktree tests
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: wtsRoot,
    removeWorktreeOnSuccess: true,
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
  };
}

function makeContext(work: string, overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    repo: work,
    baseBranch: "main",
    branchName: "junco/test-feature",
    draft: true,
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
  tmpRoot = mkdtempSync(join(tmpdir(), "junco-wt-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// worktreeSlug
// ---------------------------------------------------------------------------

describe("worktreeSlug", () => {
  it("passes through clean alphanumeric IDs unchanged", () => {
    expect(worktreeSlug("abc123")).toBe("abc123");
  });

  it("replaces spaces and special chars with dashes", () => {
    expect(worktreeSlug("my ticket id")).toBe("my-ticket-id");
  });

  it("strips leading/trailing dashes", () => {
    expect(worktreeSlug("---abc---")).toBe("abc");
  });

  it("collapses multiple special chars into one dash", () => {
    expect(worktreeSlug("a!!!b")).toBe("a-b");
  });

  it("preserves dots and hyphens in the middle", () => {
    expect(worktreeSlug("v1.2-rc")).toBe("v1.2-rc");
  });

  it("falls back to 'ticket' for an empty or all-special string", () => {
    expect(worktreeSlug("")).toBe("ticket");
    expect(worktreeSlug("!@#")).toBe("ticket");
  });

  it("excludes forward slashes (unlike branch slugs)", () => {
    // slashes are treated as separators and replaced with dashes
    expect(worktreeSlug("junco/my-feature")).toBe("junco-my-feature");
  });
});

// ---------------------------------------------------------------------------
// currentHeadSha
// ---------------------------------------------------------------------------

describe("currentHeadSha", () => {
  it("returns a 40-char hex SHA", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, join(tmpRoot, "wts"));
    const sha = await currentHeadSha(cfg, work);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("matches the SHA from git rev-parse", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, join(tmpRoot, "wts"));
    const sha = await currentHeadSha(cfg, work);
    const expected = run(["git", "-C", work, "rev-parse", "HEAD"]).trim();
    expect(sha).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// linkNodeModules
// ---------------------------------------------------------------------------

describe("linkNodeModules", () => {
  it("creates a symlink from wtPath/node_modules to repoPath/node_modules", () => {
    const repoPath = join(tmpRoot, "repo");
    const wtPath = join(tmpRoot, "wt");
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });
    mkdirSync(wtPath, { recursive: true });

    linkNodeModules(repoPath, wtPath);

    const dst = join(wtPath, "node_modules");
    expect(lstatSync(dst).isSymbolicLink()).toBe(true);
  });

  it("is a no-op if repoPath has no node_modules", () => {
    const repoPath = join(tmpRoot, "repo");
    const wtPath = join(tmpRoot, "wt");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(wtPath, { recursive: true });

    linkNodeModules(repoPath, wtPath);

    expect(existsSync(join(wtPath, "node_modules"))).toBe(false);
  });

  it("is a no-op if wtPath/node_modules already exists", () => {
    const repoPath = join(tmpRoot, "repo");
    const wtPath = join(tmpRoot, "wt");
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });
    mkdirSync(join(wtPath, "node_modules"), { recursive: true });

    // Should not throw
    linkNodeModules(repoPath, wtPath);

    // Still a real dir, not a symlink
    expect(lstatSync(join(wtPath, "node_modules")).isSymbolicLink()).toBe(false);
  });

  it("is a no-op if wtPath/node_modules is already a symlink", () => {
    const repoPath = join(tmpRoot, "repo");
    const wtPath = join(tmpRoot, "wt");
    const otherDir = join(tmpRoot, "other");
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    mkdirSync(wtPath, { recursive: true });

    // Pre-existing symlink pointing elsewhere
    symlinkSync(otherDir, join(wtPath, "node_modules"));

    linkNodeModules(repoPath, wtPath);

    // Symlink still points to otherDir, not repoPath/node_modules
    const resolved = readlinkSync(join(wtPath, "node_modules"));
    expect(resolved).toBe(otherDir);
  });
});

// ---------------------------------------------------------------------------
// prepareWorktree (fresh mode)
// ---------------------------------------------------------------------------

describe("prepareWorktree — fresh mode", () => {
  it("creates a worktree dir checked out on the new branch", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);

    const wtPath = await prepareWorktree(cfg, ctx, "test-task-001");

    expect(existsSync(wtPath)).toBe(true);

    // Check the branch name in the worktree
    const branch = run(["git", "-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"]).trim();
    expect(branch).toBe("junco/test-feature");
  }, 30000);

  it("creates worktreeRoot dir if it doesn't exist", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const wtsRoot = join(tmpRoot, "new-wts-dir");
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);

    await prepareWorktree(cfg, ctx, "test-task-002");

    expect(existsSync(wtsRoot)).toBe(true);
  }, 30000);

  it("slug from taskId becomes the worktree dir name", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work, { branchName: "junco/slug-test" });

    const wtPath = await prepareWorktree(cfg, ctx, "my ticket id!");

    // "my ticket id!" → replace non-[A-Za-z0-9._-] → "my-ticket-id-" →
    //   strip leading/trailing dashes → "my-ticket-id"
    const slug = worktreeSlug("my ticket id!");
    expect(slug).toBe("my-ticket-id");
    expect(wtPath).toBe(join(wtsRoot, slug));
  }, 30000);

  it("handles stale worktree by renaming aside", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx1 = makeContext(work, { branchName: "junco/stale-test-1" });
    const ctx2 = makeContext(work, { branchName: "junco/stale-test-2" });

    // Create first worktree
    await prepareWorktree(cfg, ctx1, "stale-task");

    // Create second worktree with same taskId — should handle the stale one
    const wtPath2 = await prepareWorktree(cfg, ctx2, "stale-task");
    expect(existsSync(wtPath2)).toBe(true);

    // The old worktree was either cleanly removed or renamed aside to
    // .old-<ts>; either way, the new worktree exists.
    expect(existsSync(wtPath2)).toBe(true);
  }, 30000);

  it("falls back to worktree-add without -b if branch already exists locally", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work, { branchName: "junco/existing-local" });

    // Create the branch locally so the fresh-mode -b fails with "already exists"
    run(["git", "-C", work, "branch", "junco/existing-local", "origin/main"]);

    const wtPath = await prepareWorktree(cfg, ctx, "existing-local-task");
    expect(existsSync(wtPath)).toBe(true);
    const branch = run(["git", "-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"]).trim();
    expect(branch).toBe("junco/existing-local");
  }, 30000);
});

// ---------------------------------------------------------------------------
// cleanupWorktree
// ---------------------------------------------------------------------------

describe("cleanupWorktree", () => {
  it("removes the worktree dir (best-effort, no throw)", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);

    const wtPath = await prepareWorktree(cfg, ctx, "cleanup-task");
    expect(existsSync(wtPath)).toBe(true);

    await expect(cleanupWorktree(cfg, ctx, wtPath)).resolves.not.toThrow();
    // After cleanup the dir should be gone
    expect(existsSync(wtPath)).toBe(false);
  }, 30000);

  it("does not throw on a non-existent path", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);

    await expect(cleanupWorktree(cfg, ctx, join(wtsRoot, "does-not-exist"))).resolves.not.toThrow();
  }, 30000);
});

// ---------------------------------------------------------------------------
// pruneStaleWorktrees
// ---------------------------------------------------------------------------

describe("pruneStaleWorktrees", () => {
  it("removes .old-<ts> dirs older than maxAgeSeconds", () => {
    const wtsRoot = join(tmpRoot, "wts-prune");
    mkdirSync(wtsRoot, { recursive: true });

    // An old stale dir (timestamp 100 seconds from epoch — well over 3 days ago)
    const oldDir = join(wtsRoot, "ticket.old-100");
    mkdirSync(oldDir, { recursive: true });

    pruneStaleWorktrees(wtsRoot, 3 * 86400);

    expect(existsSync(oldDir)).toBe(false);
  });

  it("keeps .old-<ts> dirs that are within maxAgeSeconds", () => {
    const wtsRoot = join(tmpRoot, "wts-prune");
    mkdirSync(wtsRoot, { recursive: true });

    // A very recent stale dir (now + 10 seconds would be in the future, use current time)
    const nowTs = Math.floor(Date.now() / 1000);
    const recentDir = join(wtsRoot, `ticket.old-${nowTs}`);
    mkdirSync(recentDir, { recursive: true });

    pruneStaleWorktrees(wtsRoot, 3 * 86400);

    expect(existsSync(recentDir)).toBe(true);
  });

  it("is a no-op if worktreeRoot does not exist", () => {
    // Should not throw
    expect(() => pruneStaleWorktrees(join(tmpRoot, "nonexistent"), 3 * 86400)).not.toThrow();
  });

  it("ignores non-.old-<digits> entries", () => {
    const wtsRoot = join(tmpRoot, "wts-prune");
    mkdirSync(wtsRoot, { recursive: true });

    const normalDir = join(wtsRoot, "ticket.old-notanumber");
    mkdirSync(normalDir, { recursive: true });
    const plainDir = join(wtsRoot, "my-feature");
    mkdirSync(plainDir, { recursive: true });

    pruneStaleWorktrees(wtsRoot, 3 * 86400);

    // These should still exist (not matched)
    expect(existsSync(normalDir)).toBe(true);
    expect(existsSync(plainDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// prepareWorktree — stale-dir cleanup failure surfaces as GitOpError
// ---------------------------------------------------------------------------

describe("prepareWorktree (stale-dir cleanup failure)", () => {
  it("rejects with GitOpError when the unprunable dir cannot be moved aside", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);

    // A stale plain dir occupies the worktree path (git worktree remove will
    // fail — it is not a registered worktree). A read-only PARENT then makes
    // the move-aside rename fail too (rename needs write perm on the parent).
    const wtPath = join(wtsRoot, "stale-guard-ticket");
    mkdirSync(wtPath, { recursive: true });
    chmodSync(wtsRoot, 0o555);
    try {
      await expect(prepareWorktree(cfg, ctx, "stale-guard-ticket")).rejects.toThrow(GitOpError);
      await expect(prepareWorktree(cfg, ctx, "stale-guard-ticket")).rejects.toThrow(
        /stale worktree cleanup failed/,
      );
    } finally {
      chmodSync(wtsRoot, 0o755);
    }
  }, 30000);
});
