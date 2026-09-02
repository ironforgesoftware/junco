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
import { setupForkHarness, FORK_NWO } from "./helpers/forkHarness.js";
import { makeConfig as baseConfig } from "./helpers/config.js";
import { gitLogShim } from "./helpers/ghScript.js";
import { run, cloneHarness } from "./helpers/gitHarness.js";

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

// run() + the bare-remote-plus-clone tree live in tests/helpers/gitHarness.ts.
// cloneHarness copies a once-per-process template (~7ms) rather than rebuilding
// it with 10 git subprocesses (~142ms) per test.
const setupGitHarness = cloneHarness;

function makeConfig(work: string, tmpRoot: string, ghBin = "gh"): Config {
  return baseConfig(
    {
      dataDir: "/tmp/vault/state",
      queueRoot: "/tmp/vault/Junco",
      worktreeRoot: join(tmpRoot, "wts"),
      tools: [],
      criticEnabled: true,
      planLintEnabled: true,
      verifyEnabled: true,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: true,
    },
    {
      ghBin, // the caller's fake gh script; gh-free tests keep the parameter default
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

  it("pushBranch honors a non-origin remote", async () => {
    const h = setupForkHarness(tmpRoot);
    const cfg = makeConfig(h.work, tmpRoot);

    run(["git", "-C", h.work, "checkout", "-b", "junco/fp"]);
    writeFileSync(join(h.work, "fp.txt"), "fp\n");
    run(["git", "-C", h.work, "add", "fp.txt"]);
    run(["git", "-C", h.work, "commit", "-m", "fork push commit"]);

    await pushBranch(cfg, h.work, "junco/fp", undefined, "fork");

    // Lands on the fork remote...
    expect(
      run(["git", "-C", h.forkRemote, "rev-parse", "refs/heads/junco/fp"]).trim(),
    ).toBeTruthy();
    // ...and must NOT land on upstream.
    expect(() => run(["git", "-C", h.upstream, "rev-parse", "refs/heads/junco/fp"])).toThrow();
  }, 30000);

  // Resume mode (issue #29): a crashed run left the branch on the remote with
  // no PR — the retry rebuilds from the base and must overwrite the stale
  // remote tip, but only if it still points where validation saw it.
  it("overwrites a stale remote branch when forceWithLeaseSha matches the remote tip", async () => {
    const { remote, work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, tmpRoot);

    // The crashed run's push: a stale commit on the remote branch.
    run(["git", "-C", work, "checkout", "-b", "junco/lease"]);
    writeFileSync(join(work, "stale.txt"), "stale\n");
    run(["git", "-C", work, "add", "stale.txt"]);
    run(["git", "-C", work, "commit", "-m", "stale crashed-run commit"]);
    run(["git", "-C", work, "push", "-u", "origin", "junco/lease"]);
    const staleSha = run(["git", "-C", work, "rev-parse", "junco/lease"]).trim();

    // The retry: branch reset to base, fresh commit (diverged from staleSha).
    run(["git", "-C", work, "reset", "--hard", "origin/main"]);
    writeFileSync(join(work, "fresh.txt"), "fresh\n");
    run(["git", "-C", work, "add", "fresh.txt"]);
    run(["git", "-C", work, "commit", "-m", "fresh retry commit"]);

    await pushBranch(cfg, work, "junco/lease", undefined, "origin", staleSha);

    expect(run(["git", "-C", remote, "log", "-1", "--format=%s", "junco/lease"]).trim()).toBe(
      "fresh retry commit",
    );
  }, 30000);

  it("rejects the forced push when the remote tip no longer matches the lease sha", async () => {
    const { remote, work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, tmpRoot);

    run(["git", "-C", work, "checkout", "-b", "junco/lease2"]);
    writeFileSync(join(work, "stale.txt"), "stale\n");
    run(["git", "-C", work, "add", "stale.txt"]);
    run(["git", "-C", work, "commit", "-m", "someone else's commit"]);
    run(["git", "-C", work, "push", "-u", "origin", "junco/lease2"]);

    run(["git", "-C", work, "reset", "--hard", "origin/main"]);
    writeFileSync(join(work, "fresh.txt"), "fresh\n");
    run(["git", "-C", work, "add", "fresh.txt"]);
    run(["git", "-C", work, "commit", "-m", "fresh retry commit"]);

    // Lease pinned to a sha the remote branch does NOT point at (main's tip).
    const wrongSha = run(["git", "-C", work, "rev-parse", "origin/main"]).trim();
    await expect(
      pushBranch(cfg, work, "junco/lease2", undefined, "origin", wrongSha),
    ).rejects.toThrow(GitOpError);

    // The remote tip was protected.
    expect(run(["git", "-C", remote, "log", "-1", "--format=%s", "junco/lease2"]).trim()).toBe(
      "someone else's commit",
    );
  }, 30000);

  // Issue #347: the remote and branch go after `--`, so a ref that ever slipped
  // past isSafeGitRef with a leading dash is read as a positional, never a flag.
  it("terminates options before the remote and branch operands", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const logFile = join(tmpRoot, "git-push.log");
    const cfg: Config = {
      ...makeConfig(work, tmpRoot),
      gitBin: gitLogShim(tmpRoot, "git-log-push.sh", logFile),
    };

    run(["git", "-C", work, "checkout", "-b", "junco/eoo-push"]);
    writeFileSync(join(work, "eoo.txt"), "eoo\n");
    run(["git", "-C", work, "add", "eoo.txt"]);
    run(["git", "-C", work, "commit", "-m", "eoo commit"]);

    await pushBranch(cfg, work, "junco/eoo-push");
    const sha = run(["git", "-C", work, "rev-parse", "junco/eoo-push"]).trim();
    await pushBranch(cfg, work, "junco/eoo-push", undefined, "origin", sha);

    const argvs = readFileSync(logFile, "utf8").trim().split("\n");
    expect(argvs).toContain("push --set-upstream -- origin junco/eoo-push");
    expect(argvs).toContain(
      `push --force-with-lease=junco/eoo-push:${sha} --set-upstream -- origin junco/eoo-push`,
    );
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

  it("prefixes --head with the fork owner when forkNwo is set", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const ghScript = join(tmpRoot, "fake-gh.sh");
    writeFakeGhForPr(ghScript);
    const cfg = makeConfig(work, tmpRoot, ghScript);
    mkdirSync(cfg.worktreeRoot, { recursive: true });
    const ctx = makeContext(work, {
      branchName: "junco/fp",
      forkNwo: FORK_NWO,
      // A default workflow label would normally flow into --label; on a fork PR
      // the upstream label namespace is not ours, so it must be suppressed.
      labels: ["junco"],
    });

    const bodyFile = join(tmpRoot, "body.md");
    writeFileSync(bodyFile, "PR body\n");
    const logFile = join(tmpRoot, "gh-fork.log");

    process.env.FAKE_GH_OUTPUT = "https://github.com/up/stream/pull/1";
    process.env.FAKE_GH_EXIT_CODE = "0";
    process.env.FAKE_GH_LOG_FILE = logFile;
    try {
      const url = await openPullRequest(cfg, ctx, "up/stream", "t", bodyFile);
      expect(url).toBe("https://github.com/up/stream/pull/1");
      const argv = readFileSync(logFile, "utf8");
      expect(argv).toContain("--head me:junco/fp");
      expect(argv).toContain("--repo up/stream");
      // Fork PRs are label-free — the upstream label namespace is not ours.
      expect(argv).not.toContain("--label");
    } finally {
      delete process.env.FAKE_GH_OUTPUT;
      delete process.env.FAKE_GH_EXIT_CODE;
      delete process.env.FAKE_GH_LOG_FILE;
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

// ---------------------------------------------------------------------------
// derivePrTitle — apply tickets (2026-08-31): a body carrying a junco-patch
// fence must never have its title scraped from arbitrary diff content (the
// reviewer reproduced a title of "My Project" lifted from a unified-diff
// CONTEXT line). Precedence: ctx.prTitle -> series' first Subject line
// (tag stripped) -> H1 OUTSIDE the fence -> task.id.
// ---------------------------------------------------------------------------

const APPLY_FENCE = "`".repeat(4);

/** A minimal well-formed junco-patch series body. `subjectLine` is the raw
 * mbox `Subject: ...` line, or null to omit it entirely (exercising the
 * Subject-less fallback). `h1` prepends a real H1 OUTSIDE the fence. */
function applyBody(subjectLine: string | null, h1?: string): string {
  const lines = [
    "From 9f3a1c2e0000000000000000000000000000abcd Mon Sep 17 00:00:00 2001",
    "From: Dispatcher <d@example.com>",
    "Date: Sun, 31 Aug 2026 12:00:00 -0700",
  ];
  if (subjectLine !== null) lines.push(subjectLine);
  lines.push(
    "",
    "---",
    " game.js | 1 +",
    " 1 file changed, 1 insertion(+)",
    "",
    "diff --git a/game.js b/game.js",
    "index 1111111..2222222 100644",
    "--- a/game.js",
    "+++ b/game.js",
    "@@ -1,2 +1,3 @@",
    " const LEVELS = [",
    '+  "new",',
    " ];",
    "",
  );
  const raw = lines.join("\n");
  const heading = h1 !== undefined ? `# ${h1}\n\n` : "";
  return `${heading}${APPLY_FENCE}junco-patch\n${raw}${APPLY_FENCE}\n`;
}

describe("derivePrTitle — apply tickets (2026-08-31)", () => {
  it("ctx.prTitle still wins over the mbox Subject", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: "Explicit apply title" });
    const task = { id: "APPLY-1", body: applyBody("Subject: [PATCH 1/1] feat: add a level") };
    expect(derivePrTitle(ctx, task)).toBe("Explicit apply title");
  });

  it("falls back to the series' first Subject line with the [PATCH n/m] tag stripped", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: null });
    const task = { id: "APPLY-2", body: applyBody("Subject: [PATCH 1/1] feat: add a level") };
    expect(derivePrTitle(ctx, task)).toBe("feat: add a level");
  });

  it("never scrapes an H1-shaped diff CONTEXT line inside the fence for its title", () => {
    // Reproduces the reviewer's finding: a unified-diff context line " # My
    // Project" trims to "# My Project" and used to be mistaken for a real H1.
    const ctx = makeContext("/tmp/repo", { prTitle: null });
    const raw = [
      "From 9f3a1c2e0000000000000000000000000000abcd Mon Sep 17 00:00:00 2001",
      "From: Dispatcher <d@example.com>",
      "Date: Sun, 31 Aug 2026 12:00:00 -0700",
      "Subject: [PATCH 1/1] docs: tweak readme",
      "",
      "---",
      " README.md | 1 +",
      " 1 file changed, 1 insertion(+)",
      "",
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,3 +1,4 @@",
      " # My Project",
      "+more text",
      " body",
      "",
    ].join("\n");
    const task = { id: "APPLY-3", body: `${APPLY_FENCE}junco-patch\n${raw}${APPLY_FENCE}\n` };
    expect(derivePrTitle(ctx, task)).toBe("docs: tweak readme");
  });

  it("falls back to an H1 OUTSIDE the fence when the series has no Subject line", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: null });
    const task = { id: "APPLY-4", body: applyBody(null, "Prose Heading") };
    expect(derivePrTitle(ctx, task)).toBe("Prose Heading");
  });

  it("prefers an H1 OUTSIDE the fence over an H1-shaped line that merely appears inside it", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: null });
    const raw = [
      "From 9f3a1c2e0000000000000000000000000000abcd Mon Sep 17 00:00:00 2001",
      "From: Dispatcher <d@example.com>",
      "Date: Sun, 31 Aug 2026 12:00:00 -0700",
      "",
      "---",
      " README.md | 1 +",
      " 1 file changed, 1 insertion(+)",
      "",
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,3 +1,4 @@",
      " # Sneaky Heading",
      "+more text",
      " body",
      "",
    ].join("\n");
    const task = {
      id: "APPLY-5",
      body: `# Real Heading\n\n${APPLY_FENCE}junco-patch\n${raw}${APPLY_FENCE}\n`,
    };
    expect(derivePrTitle(ctx, task)).toBe("Real Heading");
  });

  it("falls back to task.id when the series has no Subject line and no H1 outside the fence", () => {
    const ctx = makeContext("/tmp/repo", { prTitle: null });
    const task = { id: "APPLY-6", body: applyBody(null) };
    expect(derivePrTitle(ctx, task)).toBe("APPLY-6");
  });
});
