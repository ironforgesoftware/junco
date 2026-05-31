/**
 * Tests for src/repo.ts — validateRepoContext + resolveAmendTarget.
 * Written FIRST (TDD). These fail until repo.ts is implemented.
 *
 * Uses a REAL git harness + a fake gh script that emits canned JSON.
 * No real GitHub network calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { validateRepoContext, resolveAmendTarget } from "../src/repo.js";
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

function setupGitHarness(tmpRoot: string): {
  remote: string;
  work: string;
} {
  const remote = join(tmpRoot, "remote.git");
  const work = join(tmpRoot, "work");

  run(["git", "init", "--bare", "-b", "main", remote]);
  run(["git", "init", "-b", "main", work]);
  run(["git", "-C", work, "config", "user.email", "ci@example.com"]);
  run(["git", "-C", work, "config", "user.name", "CI"]);
  run(["git", "-C", work, "config", "commit.gpgsign", "false"]);

  require("node:fs").writeFileSync(join(work, "README.md"), "seed\n");
  run(["git", "-C", work, "add", "README.md"]);
  run(["git", "-C", work, "commit", "-m", "seed"]);
  run(["git", "-C", work, "remote", "add", "origin", remote]);
  run(["git", "-C", work, "push", "-u", "origin", "main"]);

  return { remote, work };
}

/**
 * Write a fake gh script to `scriptPath` and chmod +x.
 *
 * The script inspects its arguments:
 *   - "repo view"  → prints nwo (from env FAKE_GH_NWO or "owner/repo")
 *   - "pr view"    → prints PR JSON (from env FAKE_GH_PR_JSON)
 *   - anything else → exits 1
 */
function writeFakeGh(scriptPath: string): void {
  const script = `#!/bin/sh
# Fake gh CLI for Junco TS tests
args="$*"
case "$args" in
  "repo view --json nameWithOwner -q .nameWithOwner"*)
    echo "\${FAKE_GH_NWO:-owner/repo}"
    exit 0
    ;;
  "pr view "*)
    if [ -n "\${FAKE_GH_PR_JSON}" ]; then
      printf '%s\\n' "\${FAKE_GH_PR_JSON}"
      exit 0
    else
      echo '{"state":"OPEN","headRefName":"feature/branch","baseRefName":"main","isDraft":false,"url":"https://github.com/owner/repo/pull/42","isCrossRepository":false}'
      exit 0
    fi
    ;;
  *)
    echo "fake-gh: unhandled args: $args" >&2
    exit 1
    ;;
esac
`;
  writeFileSync(scriptPath, script, { encoding: "utf8" });
  chmodSync(scriptPath, 0o755);
}

function makeConfig(work: string, ghBin: string): Config {
  return {
    vaultRoot: "/tmp/vault",
    juncoSubdir: "Junco",
    omlx: { url: "http://127.0.0.1:1234/v1", apiKey: "test" },
    modelId: "test/model",
    tools: [],
    defaultTimeoutMinutes: 30,
    supervisorEnabled: false,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    ghBin,
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: join(work, "wts"),
    removeWorktreeOnSuccess: true,
    draftByDefault: true,
    defaultLabels: [],
  };
}

function makeContext(
  work: string,
  overrides: Partial<RepoContext> = {},
): RepoContext {
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
let ghScript: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "junco-repo-test-"));
  ghScript = join(tmpRoot, "fake-gh.sh");
  writeFakeGh(ghScript);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateRepoContext — fresh mode
// ---------------------------------------------------------------------------

describe("validateRepoContext — fresh mode", () => {
  it("returns the nwo from gh for a valid fresh context", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(work);

    process.env.FAKE_GH_NWO = "owner/my-repo";
    try {
      const nwo = await validateRepoContext(cfg, ctx);
      expect(nwo).toBe("owner/my-repo");
    } finally {
      delete process.env.FAKE_GH_NWO;
    }
  }, 15000);

  it("throws if repo path does not exist", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(join(tmpRoot, "nonexistent-repo"));

    await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(/does not exist/i);
  }, 15000);

  it("throws if path exists but is not a git repo", async () => {
    const notARepo = join(tmpRoot, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    const cfg = makeConfig(notARepo, ghScript);
    const ctx = makeContext(notARepo);

    await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(/not a git repo/i);
  }, 15000);

  it("throws if branchName === baseBranch in fresh mode", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(work, { branchName: "main", baseBranch: "main" });

    await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(
      /must differ from base_branch/i,
    );
  }, 15000);

  it("throws if base branch does not exist on origin", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    // "nonexistent-base" is not pushed to the bare remote
    const ctx = makeContext(work, { baseBranch: "nonexistent-base" });

    await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(
      /base branch.*not found on origin/i,
    );
  }, 15000);

  it("throws on branch collision (feature branch already exists on origin)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(work, { branchName: "junco/collision" });

    // Push the branch to origin to create the collision
    run(["git", "-C", work, "checkout", "-b", "junco/collision"]);
    run(["git", "-C", work, "push", "-u", "origin", "junco/collision"]);
    run(["git", "-C", work, "checkout", "main"]);

    await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(
      /already exists on origin/i,
    );
  }, 15000);
});

// ---------------------------------------------------------------------------
// validateRepoContext — amend mode (ctx mutation)
// ---------------------------------------------------------------------------

describe("validateRepoContext — amend mode", () => {
  it("mutates ctx.branchName and ctx.baseBranch from PR metadata", async () => {
    const { work, remote } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);

    // Create and push the feature branch (simulates open PR head on origin)
    run(["git", "-C", work, "checkout", "-b", "feature/amend-branch"]);
    run(["git", "-C", work, "push", "-u", "origin", "feature/amend-branch"]);
    run(["git", "-C", work, "checkout", "main"]);

    const prJson = JSON.stringify({
      state: "OPEN",
      headRefName: "feature/amend-branch",
      baseRefName: "main",
      isDraft: false,
      url: "https://github.com/owner/repo/pull/42",
      isCrossRepository: false,
    });

    // Use a temp fake gh that returns this specific PR JSON
    const amendGhScript = join(tmpRoot, "fake-gh-amend.sh");
    const amendScript = `#!/bin/sh
args="$*"
case "$args" in
  "repo view --json nameWithOwner -q .nameWithOwner"*)
    echo "owner/my-repo"
    exit 0
    ;;
  "pr view "*)
    printf '%s\\n' '${prJson}'
    exit 0
    ;;
  *)
    echo "fake-gh: unhandled args: $args" >&2
    exit 1
    ;;
esac
`;
    writeFileSync(amendGhScript, amendScript, { encoding: "utf8" });
    chmodSync(amendGhScript, 0o755);

    const amendCfg = makeConfig(work, amendGhScript);
    const ctx = makeContext(work, {
      amendsPr: 42,
      branchName: "old-name", // should be overridden
      baseBranch: "old-base", // should be overridden
    });

    const nwo = await validateRepoContext(amendCfg, ctx);
    expect(nwo).toBe("owner/my-repo");
    expect(ctx.branchName).toBe("feature/amend-branch");
    expect(ctx.baseBranch).toBe("main");
  }, 15000);
});

// ---------------------------------------------------------------------------
// resolveAmendTarget
// ---------------------------------------------------------------------------

describe("resolveAmendTarget", () => {
  it("returns AmendTarget for an OPEN non-fork PR", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);

    const prJson = JSON.stringify({
      state: "OPEN",
      headRefName: "feature/abc",
      baseRefName: "main",
      isDraft: true,
      url: "https://github.com/owner/repo/pull/5",
      isCrossRepository: false,
    });
    process.env.FAKE_GH_PR_JSON = prJson;

    try {
      const ctx = makeContext(work, { amendsPr: 5 });
      const tgt = await resolveAmendTarget(cfg, ctx, "owner/repo");

      expect(tgt.prNumber).toBe(5);
      expect(tgt.prUrl).toBe("https://github.com/owner/repo/pull/5");
      expect(tgt.headRef).toBe("feature/abc");
      expect(tgt.baseRef).toBe("main");
      expect(tgt.isDraft).toBe(true);
    } finally {
      delete process.env.FAKE_GH_PR_JSON;
    }
  }, 15000);

  it("throws for a CLOSED PR", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);

    const prJson = JSON.stringify({
      state: "CLOSED",
      headRefName: "feature/abc",
      baseRefName: "main",
      isDraft: false,
      url: "https://github.com/owner/repo/pull/5",
      isCrossRepository: false,
    });
    process.env.FAKE_GH_PR_JSON = prJson;

    try {
      const ctx = makeContext(work, { amendsPr: 5 });
      await expect(
        resolveAmendTarget(cfg, ctx, "owner/repo"),
      ).rejects.toThrow(/CLOSED.*not OPEN/i);
    } finally {
      delete process.env.FAKE_GH_PR_JSON;
    }
  }, 15000);

  it("throws for a cross-repository (fork) PR", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);

    const prJson = JSON.stringify({
      state: "OPEN",
      headRefName: "feature/fork",
      baseRefName: "main",
      isDraft: false,
      url: "https://github.com/owner/repo/pull/99",
      isCrossRepository: true,
    });
    process.env.FAKE_GH_PR_JSON = prJson;

    try {
      const ctx = makeContext(work, { amendsPr: 99 });
      await expect(
        resolveAmendTarget(cfg, ctx, "owner/repo"),
      ).rejects.toThrow(/cross-repo|fork/i);
    } finally {
      delete process.env.FAKE_GH_PR_JSON;
    }
  }, 15000);

  it("throws for incomplete PR metadata (missing url)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);

    const prJson = JSON.stringify({
      state: "OPEN",
      headRefName: "feature/abc",
      baseRefName: "main",
      isDraft: false,
      url: "", // missing URL
      isCrossRepository: false,
    });
    process.env.FAKE_GH_PR_JSON = prJson;

    try {
      const ctx = makeContext(work, { amendsPr: 1 });
      await expect(
        resolveAmendTarget(cfg, ctx, "owner/repo"),
      ).rejects.toThrow(/metadata incomplete/i);
    } finally {
      delete process.env.FAKE_GH_PR_JSON;
    }
  }, 15000);
});
