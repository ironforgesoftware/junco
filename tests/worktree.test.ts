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
  repoDiscriminator,
  currentHeadSha,
  linkNodeModules,
  prepareWorktree,
  cleanupWorktree,
  pruneStaleWorktrees,
  worktreesLockPath,
} from "../src/worktree.js";
import { GitOpError } from "../src/git.js";
import { acquirePidfileLock } from "../src/pidfileLock.js";
import type { RepoContext } from "../src/repoContext.js";
import type { Config } from "../src/types.js";
import { setupForkHarness } from "./helpers/forkHarness.js";

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
    ghBin: "gh", // not used in worktree tests
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: wtsRoot,
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
    pushRemote: "origin",
    forkNwo: null,
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
// repoDiscriminator (issue #33)
// ---------------------------------------------------------------------------

describe("repoDiscriminator", () => {
  it("is a stable, filesystem-safe name derived from the resolved repo path", () => {
    const d = repoDiscriminator("/srv/repos/my-app");
    expect(d).toBe(repoDiscriminator("/srv/repos/my-app")); // deterministic
    expect(d).toMatch(/^my-app-[0-9a-f]{8}$/); // readable basename + short hash
  });

  it("differs for two repos that share a basename", () => {
    expect(repoDiscriminator("/srv/a/api")).not.toBe(repoDiscriminator("/srv/b/api"));
  });

  it("resolves relative segments so equivalent paths collapse to one namespace", () => {
    expect(repoDiscriminator("/srv/repos/../repos/my-app")).toBe(
      repoDiscriminator("/srv/repos/my-app"),
    );
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

  it("slug from taskId becomes the worktree dir name, namespaced per repo", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work, { branchName: "junco/slug-test" });

    const wtPath = await prepareWorktree(cfg, ctx, "my ticket id!");

    // "my ticket id!" → replace non-[A-Za-z0-9._-] → "my-ticket-id-" →
    //   strip leading/trailing dashes → "my-ticket-id"
    const slug = worktreeSlug("my ticket id!");
    expect(slug).toBe("my-ticket-id");
    // Issue #33: the path is namespaced by a per-repo discriminator so
    // same-slug tickets to different repos never collide.
    expect(wtPath).toBe(join(wtsRoot, repoDiscriminator(work), slug));
  }, 30000);

  it("same task id in two different repos: distinct paths, live sibling untouched (issue #33)", async () => {
    // Two independent repos sharing ONE worktree root — the scheduler lets
    // these run concurrently (busyRepos keys on the repo, not the slug).
    const a = setupGitHarness(join(tmpRoot, "a"));
    const b = setupGitHarness(join(tmpRoot, "b"));
    const wtsRoot = join(tmpRoot, "shared-wts");
    const cfgA = makeConfig(a.work, wtsRoot);
    const cfgB = makeConfig(b.work, wtsRoot);

    // Ticket A is "live": provisioned with uncommitted work in progress.
    const wtA = await prepareWorktree(cfgA, makeContext(a.work), "fix-lint");
    writeFileSync(join(wtA, "in-progress.txt"), "uncommitted live work\n");

    // Ticket B (same generic id, different repo) provisions concurrently.
    const wtB = await prepareWorktree(cfgB, makeContext(b.work), "fix-lint");

    expect(wtB).not.toBe(wtA);
    // A's live worktree was NOT pruned/renamed aside by B's provisioning.
    expect(existsSync(join(wtA, "in-progress.txt"))).toBe(true);
    expect(existsSync(wtB)).toBe(true);
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

  it("falls back to a forced worktree-add if the branch already exists locally", async () => {
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

  it("fallback resets a stale local branch to origin/<base> — retries never build on crashed-run commits (issue #34)", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work, { branchName: "junco/stale-local" });

    // Simulate a crashed run's leftover: a local feature branch carrying a
    // commit that was never pushed (validateRepoContext only checks the
    // REMOTE branch, so fresh-mode validation passes on retry).
    run(["git", "-C", work, "checkout", "-b", "junco/stale-local"]);
    writeFileSync(join(work, "stale.txt"), "crashed-run leftover\n");
    run(["git", "-C", work, "add", "stale.txt"]);
    run(["git", "-C", work, "commit", "-m", "crashed-run commit"]);
    run(["git", "-C", work, "checkout", "main"]);

    const wtPath = await prepareWorktree(cfg, ctx, "stale-local-task");

    const branch = run(["git", "-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"]).trim();
    expect(branch).toBe("junco/stale-local");
    // The retry starts from origin/main — NOT from the crashed run's tip.
    const head = run(["git", "-C", wtPath, "rev-parse", "HEAD"]).trim();
    const base = run(["git", "-C", work, "rev-parse", "origin/main"]).trim();
    expect(head).toBe(base);
    expect(existsSync(join(wtPath, "stale.txt"))).toBe(false);
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

  it("removes the now-empty repo-discriminator parent dir (issue #33 layout)", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);

    const wtPath = await prepareWorktree(cfg, ctx, "empty-parent-task");
    await cleanupWorktree(cfg, ctx, wtPath);

    // Both the worktree and its per-repo parent dir are gone; the root stays.
    expect(existsSync(wtPath)).toBe(false);
    expect(existsSync(join(wtsRoot, repoDiscriminator(work)))).toBe(false);
    expect(existsSync(wtsRoot)).toBe(true);
  }, 30000);

  it("keeps the repo-discriminator parent when a sibling worktree is still live", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);

    const wt1 = await prepareWorktree(cfg, makeContext(work, { branchName: "junco/s1" }), "sib-1");
    const wt2 = await prepareWorktree(cfg, makeContext(work, { branchName: "junco/s2" }), "sib-2");
    await cleanupWorktree(cfg, makeContext(work), wt1);

    expect(existsSync(wt1)).toBe(false);
    expect(existsSync(wt2)).toBe(true); // sibling untouched, parent kept
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

  it("prunes stale backups nested one level down (issue #33 per-repo layout)", () => {
    const wtsRoot = join(tmpRoot, "wts-prune");
    const repoDir = join(wtsRoot, "my-app-0a1b2c3d");
    mkdirSync(repoDir, { recursive: true });

    const oldNested = join(repoDir, "ticket.old-100");
    mkdirSync(oldNested, { recursive: true });
    const nowTs = Math.floor(Date.now() / 1000);
    const recentNested = join(repoDir, `ticket.old-${nowTs}`);
    mkdirSync(recentNested, { recursive: true });

    pruneStaleWorktrees(wtsRoot, 3 * 86400);

    expect(existsSync(oldNested)).toBe(false);
    expect(existsSync(recentNested)).toBe(true);
  });

  it("never descends into a git checkout (a .old-<ts> dir INSIDE a legacy live worktree survives)", () => {
    const wtsRoot = join(tmpRoot, "wts-prune");
    // A legacy flat live worktree: identified by its .git entry.
    const legacyLive = join(wtsRoot, "legacy-ticket");
    mkdirSync(legacyLive, { recursive: true });
    writeFileSync(join(legacyLive, ".git"), "gitdir: /somewhere\n");
    const repoOwnedDir = join(legacyLive, "fixtures.old-100");
    mkdirSync(repoOwnedDir, { recursive: true });

    pruneStaleWorktrees(wtsRoot, 3 * 86400);

    // The repo's own files are not junco's to prune.
    expect(existsSync(repoOwnedDir)).toBe(true);
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
    // fail — it is not a registered worktree). A read-only PARENT (the per-repo
    // discriminator dir) then makes the move-aside rename fail too (rename
    // needs write perm on the parent).
    const repoDir = join(wtsRoot, repoDiscriminator(work));
    const wtPath = join(repoDir, "stale-guard-ticket");
    mkdirSync(wtPath, { recursive: true });
    chmodSync(repoDir, 0o555);
    try {
      await expect(prepareWorktree(cfg, ctx, "stale-guard-ticket")).rejects.toThrow(GitOpError);
      await expect(prepareWorktree(cfg, ctx, "stale-guard-ticket")).rejects.toThrow(
        /stale worktree cleanup failed/,
      );
    } finally {
      chmodSync(repoDir, 0o755);
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// prepareWorktree — amend mode (fork): fetch/reset from ctx.pushRemote
// ---------------------------------------------------------------------------

describe("prepareWorktree — amend mode (fork)", () => {
  let forkTmp: string;
  let h: ReturnType<typeof setupForkHarness>;
  let cfg: Config;

  beforeEach(() => {
    forkTmp = mkdtempSync(join(tmpdir(), "junco-wt-fork-test-"));
    h = setupForkHarness(forkTmp);
    cfg = makeConfig(h.work, join(forkTmp, "wts"));
  });

  afterEach(() => {
    rmSync(forkTmp, { recursive: true, force: true });
  });

  const forkCtx = (overrides: Partial<RepoContext> = {}): RepoContext =>
    makeContext(h.work, { pushRemote: "fork", amendsPr: 9, ...overrides });

  it("amend mode fetches the head branch from the push remote (fork)", async () => {
    // plant junco/amend-me on the FORK bare only
    run(["git", "-C", h.work, "checkout", "-b", "junco/amend-me"]);
    writeFileSync(join(h.work, "f.txt"), "fork tip\n");
    run(["git", "-C", h.work, "add", "f.txt"]);
    run(["git", "-C", h.work, "commit", "-m", "fork tip"]);
    run(["git", "-C", h.work, "push", "fork", "junco/amend-me"]);
    run(["git", "-C", h.work, "checkout", "main"]);
    run(["git", "-C", h.work, "branch", "-D", "junco/amend-me"]);

    const ctx = forkCtx({ amendsPr: 9, branchName: "junco/amend-me" });
    const wt = await prepareWorktree(cfg, ctx, "t-amend");
    expect(run(["git", "-C", wt, "log", "-1", "--format=%s"]).trim()).toBe("fork tip");
  }, 30000);
});

// ---------------------------------------------------------------------------
// worktrees.lock — daemon-side mutation serialization (behavior-preserving)
// ---------------------------------------------------------------------------

describe("worktreesLockPath", () => {
  it("is `.worktrees.lock` directly under worktreeRoot", () => {
    const cfg = makeConfig(join(tmpRoot, "w"), join(tmpRoot, "wts"));
    expect(worktreesLockPath(cfg)).toBe(join(tmpRoot, "wts", ".worktrees.lock"));
  });
});

describe("worktrees.lock contention", () => {
  it("a held lock blocks a second acquirer at the same path, and frees on release", () => {
    const cfg = makeConfig(join(tmpRoot, "w"), join(tmpRoot, "wts"));
    const first = acquirePidfileLock(worktreesLockPath(cfg));
    expect(first).not.toBeNull();
    // Same path, holder still alive → second acquirer is refused.
    expect(acquirePidfileLock(worktreesLockPath(cfg))).toBeNull();
    first!.release();
    // Released → a fresh acquirer wins again.
    const third = acquirePidfileLock(worktreesLockPath(cfg));
    expect(third).not.toBeNull();
    third!.release();
  });
});

describe("worktree mutators release the lock", () => {
  it("prepareWorktree releases the worktrees lock on success", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    await prepareWorktree(cfg, makeContext(work), "lock-ok-task");
    const after = acquirePidfileLock(worktreesLockPath(cfg));
    expect(after).not.toBeNull(); // lock was released
    after!.release();
  }, 30000);

  it("prepareWorktree releases the worktrees lock when it throws", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);
    // Reuse the stale-dir cleanup failure: a plain dir occupies the worktree
    // path and a read-only per-repo parent makes the move-aside rename fail.
    const repoDir = join(wtsRoot, repoDiscriminator(work));
    const wtPath = join(repoDir, "lock-throw-task");
    mkdirSync(wtPath, { recursive: true });
    chmodSync(repoDir, 0o555);
    try {
      await expect(prepareWorktree(cfg, ctx, "lock-throw-task")).rejects.toThrow(GitOpError);
    } finally {
      chmodSync(repoDir, 0o755);
    }
    const after = acquirePidfileLock(worktreesLockPath(cfg));
    expect(after).not.toBeNull(); // finally released the lock despite the throw
    after!.release();
  }, 30000);

  it("prepareWorktree still provisions when the lock is already held (behavior-preserving)", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const held = acquirePidfileLock(worktreesLockPath(cfg));
    expect(held).not.toBeNull();
    // Contention must not deadlock or throw: the daemon is authoritative and
    // proceeds. Its `lock?.release()` no-ops on the null it got, so OUR held
    // lock is left intact.
    const wtPath = await prepareWorktree(cfg, makeContext(work), "held-lock-task");
    expect(existsSync(wtPath)).toBe(true);
    // Our lock survived the mutator's finally.
    expect(acquirePidfileLock(worktreesLockPath(cfg))).toBeNull();
    held!.release();
  }, 30000);

  it("cleanupWorktree releases the worktrees lock", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);
    const wtPath = await prepareWorktree(cfg, ctx, "cleanup-lock-task");
    await cleanupWorktree(cfg, ctx, wtPath);
    const after = acquirePidfileLock(worktreesLockPath(cfg));
    expect(after).not.toBeNull();
    after!.release();
  }, 30000);

  it("pruneStaleWorktrees releases the lock and still prunes", () => {
    const wtsRoot = join(tmpRoot, "wts-lock-prune");
    mkdirSync(wtsRoot, { recursive: true });
    const oldDir = join(wtsRoot, "ticket.old-100");
    mkdirSync(oldDir, { recursive: true });

    pruneStaleWorktrees(wtsRoot, 3 * 86400);

    expect(existsSync(oldDir)).toBe(false); // still prunes
    const after = acquirePidfileLock(worktreesLockPath({ worktreeRoot: wtsRoot }));
    expect(after).not.toBeNull(); // lock released
    after!.release();
  });

  it("pruneStaleWorktrees stays a no-op when worktreeRoot is absent (no dir/lock created)", () => {
    const absent = join(tmpRoot, "never-created");
    expect(() => pruneStaleWorktrees(absent, 3 * 86400)).not.toThrow();
    // The lock guard must sit AFTER the existsSync early-return, so acquiring
    // the lock never resurrects the root dir.
    expect(existsSync(absent)).toBe(false);
  });
});
