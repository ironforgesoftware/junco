/**
 * Tests for src/repo.ts — validateRepoContext + resolveAmendTarget.
 * Written FIRST (TDD). These fail until repo.ts is implemented.
 *
 * Uses a REAL git harness + a fake gh script that emits canned JSON.
 * No real GitHub network calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { validateRepoContext, resolveAmendTarget } from "../src/repo.js";
import type { RepoContext } from "../src/repoContext.js";
import type { Config } from "../src/types.js";
import { setupForkHarness, FORK_NWO } from "./helpers/forkHarness.js";

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

  writeFileSync(join(work, "README.md"), "seed\n");
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
 *   - "pr list"    → prints PR array JSON (from env FAKE_GH_PR_LIST_JSON, default [])
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
  "pr list "*)
    printf '%s\\n' "\${FAKE_GH_PR_LIST_JSON:-[]}"
    exit 0
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
    dataDir: "/tmp/vault/state",
    queueRoot: "/tmp/vault/Junco",
    legacy: { vaultRoot: false, stateDir: false, worktreeRoot: false, externalReposRoot: false },
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
    ghBin,
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: join(work, "wts"),
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
    dailyBudgetUsd: 0,
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
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm", fileAs: "me" },
    sandbox: {
      enabled: false,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    },
    botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
    logToFile: false,
    transcriptsEnabled: false,
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
// Fork harness — file scope so it's shared by "push_remote (fork mode)" and
// "resolveAmendTarget — fork PRs" below.
// ---------------------------------------------------------------------------

let tmp: string;
let h: ReturnType<typeof setupForkHarness>;
let cfg: Config;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "junco-fork-test-"));
  h = setupForkHarness(tmp);
  const ghBin = join(tmp, "fake-gh.sh");
  writeFakeGh(ghBin);
  cfg = makeConfig(h.work, ghBin);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function forkCtx(over: Partial<RepoContext> = {}): RepoContext {
  return {
    repo: h.work,
    baseBranch: "main",
    branchName: "junco/x",
    draft: true,
    prTitle: null,
    labels: [],
    reviewers: [],
    amendsPr: null,
    pushRemote: "fork",
    forkNwo: null,
    ...over,
  };
}

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

    await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(/must differ from base_branch/i);
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

  it("throws on branch collision when the existing branch has an OPEN PR, hinting amends_pr", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(work, { branchName: "junco/collision" });

    // Push the branch to origin to create the collision
    run(["git", "-C", work, "checkout", "-b", "junco/collision"]);
    run(["git", "-C", work, "push", "-u", "origin", "junco/collision"]);
    run(["git", "-C", work, "checkout", "main"]);

    process.env.FAKE_GH_PR_LIST_JSON = JSON.stringify([
      {
        number: 7,
        url: "https://github.com/owner/repo/pull/7",
        headRepositoryOwner: { login: "owner" },
      },
    ]);
    try {
      await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(/already exists on origin/i);
      await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(/amends_pr: 7/);
    } finally {
      delete process.env.FAKE_GH_PR_LIST_JSON;
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// validateRepoContext — pushed branch with no PR resumes (issue #29)
// ---------------------------------------------------------------------------

describe("validateRepoContext — pushed branch with no PR (issues #29, #70)", () => {
  it("resumes a REQUEUED ticket (retry_count>0) whose branch has NO open PR: resolves + signals the sha", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(work, { branchName: "junco/crashed" });

    // A crashed run pushed the branch but never opened a PR; orphan recovery
    // requeued the ticket (retry_count > 0) — positive crash-recovery provenance.
    run(["git", "-C", work, "checkout", "-b", "junco/crashed"]);
    writeFileSync(join(work, "crashed.txt"), "pushed then crashed\n");
    run(["git", "-C", work, "add", "crashed.txt"]);
    run(["git", "-C", work, "commit", "-m", "crashed-run commit"]);
    run(["git", "-C", work, "push", "-u", "origin", "junco/crashed"]);
    run(["git", "-C", work, "checkout", "main"]);
    const remoteSha = run(["git", "-C", work, "rev-parse", "junco/crashed"]).trim();

    // fake gh pr list defaults to [] — no open PR for that head.
    const signals = { resumeRemoteSha: null as string | null };
    await expect(validateRepoContext(cfg, ctx, { signals, retryCount: 1 })).resolves.toBe(
      "owner/repo",
    );
    expect(signals.resumeRemoteSha).toBe(remoteSha);
  }, 15000);

  it("REFUSES a FRESH ticket (retry_count 0) whose branch collides with a PR-less remote branch (issue #70)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(work, { branchName: "junco/human-wip" });

    // A human's WIP branch that happens to collide on the ticket's branch_name,
    // with no open PR. A fresh ticket must NOT force-push over it.
    run(["git", "-C", work, "checkout", "-b", "junco/human-wip"]);
    writeFileSync(join(work, "wip.txt"), "human work in progress\n");
    run(["git", "-C", work, "add", "wip.txt"]);
    run(["git", "-C", work, "commit", "-m", "human WIP"]);
    run(["git", "-C", work, "push", "-u", "origin", "junco/human-wip"]);
    run(["git", "-C", work, "checkout", "main"]);

    // retryCount defaults to 0 (fresh) → refuse, never signal a resume sha.
    const signals = { resumeRemoteSha: null as string | null };
    await expect(validateRepoContext(cfg, ctx, { signals })).rejects.toThrow(
      /no open PR of ours|refusing to overwrite/i,
    );
    expect(signals.resumeRemoteSha).toBeNull();
  }, 15000);

  it("leaves the resume signal null when the branch does not exist on the remote", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(work);

    const signals = { resumeRemoteSha: null as string | null };
    await expect(validateRepoContext(cfg, ctx, { signals })).resolves.toBe("owner/repo");
    expect(signals.resumeRemoteSha).toBeNull();
  }, 15000);
});

// ---------------------------------------------------------------------------
// validateRepoContext — ls-remote exact-ref match (issue #72)
// ---------------------------------------------------------------------------

describe("validateRepoContext — ls-remote exact-ref match (issue #72)", () => {
  it("a sibling ref refs/heads/<x>/<branch> alone is NOT a collision (exact-match only)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(work, { branchName: "junco/foo" });

    // Only a sibling exists on origin; the EXACT branch does not. `git ls-remote
    // --heads origin junco/foo` tail-matches refs/heads/aaa/junco/foo, so the
    // pre-fix code read it as a collision.
    run(["git", "-C", work, "checkout", "-b", "aaa/junco/foo"]);
    writeFileSync(join(work, "sib.txt"), "sibling\n");
    run(["git", "-C", work, "add", "sib.txt"]);
    run(["git", "-C", work, "commit", "-m", "sibling commit"]);
    run(["git", "-C", work, "push", "-u", "origin", "aaa/junco/foo"]);
    run(["git", "-C", work, "checkout", "main"]);

    // No exact branch → no collision, no resume signal (fresh ticket resolves).
    const signals = { resumeRemoteSha: null as string | null };
    await expect(validateRepoContext(cfg, ctx, { signals })).resolves.toBe("owner/repo");
    expect(signals.resumeRemoteSha).toBeNull();
  }, 15000);

  it("with BOTH the exact branch and a sibling present, resume uses the EXACT branch's sha", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, ghScript);
    const ctx = makeContext(work, { branchName: "junco/foo" });

    // Sibling (a DIFFERENT commit) that sorts BEFORE the exact ref in
    // ls-remote's output — the pre-fix `split[0]` would grab its sha.
    run(["git", "-C", work, "checkout", "-b", "aaa/junco/foo"]);
    writeFileSync(join(work, "sib.txt"), "sibling\n");
    run(["git", "-C", work, "add", "sib.txt"]);
    run(["git", "-C", work, "commit", "-m", "sibling commit"]);
    run(["git", "-C", work, "push", "-u", "origin", "aaa/junco/foo"]);
    run(["git", "-C", work, "checkout", "main"]);

    run(["git", "-C", work, "checkout", "-b", "junco/foo"]);
    writeFileSync(join(work, "exact.txt"), "exact branch\n");
    run(["git", "-C", work, "add", "exact.txt"]);
    run(["git", "-C", work, "commit", "-m", "exact-branch commit"]);
    run(["git", "-C", work, "push", "-u", "origin", "junco/foo"]);
    run(["git", "-C", work, "checkout", "main"]);
    const exactSha = run(["git", "-C", work, "rev-parse", "junco/foo"]).trim();
    const siblingSha = run(["git", "-C", work, "rev-parse", "aaa/junco/foo"]).trim();
    expect(exactSha).not.toBe(siblingSha);

    // Requeued ticket (retry_count>0), no PR → resume; the force-with-lease sha
    // must be the EXACT branch's tip, never the sibling's.
    const signals = { resumeRemoteSha: null as string | null };
    await expect(validateRepoContext(cfg, ctx, { signals, retryCount: 1 })).resolves.toBe(
      "owner/repo",
    );
    expect(signals.resumeRemoteSha).toBe(exactSha);
    expect(signals.resumeRemoteSha).not.toBe(siblingSha);
  }, 15000);
});

// ---------------------------------------------------------------------------
// validateRepoContext — amend mode (ctx mutation)
// ---------------------------------------------------------------------------

describe("validateRepoContext — amend mode", () => {
  it("mutates ctx.branchName and ctx.baseBranch from PR metadata", async () => {
    const { work } = setupGitHarness(tmpRoot);

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
      await expect(resolveAmendTarget(cfg, ctx, "owner/repo")).rejects.toThrow(/CLOSED.*not OPEN/i);
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
      await expect(resolveAmendTarget(cfg, ctx, "owner/repo")).rejects.toThrow(/cross-repo|fork/i);
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
      await expect(resolveAmendTarget(cfg, ctx, "owner/repo")).rejects.toThrow(
        /metadata incomplete/i,
      );
    } finally {
      delete process.env.FAKE_GH_PR_JSON;
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// allowed_repo_roots containment
// ---------------------------------------------------------------------------

describe("allowed_repo_roots", () => {
  it("rejects a repo outside every allowed root, before touching git/gh", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = { ...makeConfig(work, ghScript), allowedRepoRoots: ["/srv/allowed-only"] };
    const ctx = makeContext("/home/evil/repo");
    await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(/allowed_repo_roots/);
  });

  it("accepts a repo under an allowed root (continues to the existing checks)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = { ...makeConfig(work, ghScript), allowedRepoRoots: [tmpRoot] };
    const ctx = makeContext(work);
    await expect(validateRepoContext(cfg, ctx)).resolves.toBe("owner/repo");
  }, 15000);

  it("an empty allowlist allows everything (default)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = { ...makeConfig(work, ghScript), allowedRepoRoots: [] };
    const ctx = makeContext(work);
    await expect(validateRepoContext(cfg, ctx)).resolves.toBe("owner/repo");
  }, 15000);

  it("an exact-root match is allowed (no separator-suffix false negative)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = { ...makeConfig(work, ghScript), allowedRepoRoots: [work] };
    const ctx = makeContext(work);
    await expect(validateRepoContext(cfg, ctx)).resolves.toBe("owner/repo");
  }, 15000);

  it("a prefix that is not a path boundary is rejected (/srv/allowed vs /srv/allowed-evil)", async () => {
    const { work } = setupGitHarness(tmpRoot);
    const cfg = { ...makeConfig(work, ghScript), allowedRepoRoots: ["/srv/allowed"] };
    const ctx = makeContext("/srv/allowed-evil");
    await expect(validateRepoContext(cfg, ctx)).rejects.toThrow(/allowed_repo_roots/);
  });
});

// ---------------------------------------------------------------------------
// validateRepoContext — push_remote (fork mode)
// ---------------------------------------------------------------------------

describe("validateRepoContext — push_remote (fork mode)", () => {
  it("resolves forkNwo from the fork remote URL", async () => {
    const ctx = forkCtx();
    await validateRepoContext(cfg, ctx);
    expect(ctx.forkNwo).toBe(FORK_NWO);
  }, 15000);

  it("rejects a push_remote that is not a remote on the clone", async () => {
    await expect(validateRepoContext(cfg, forkCtx({ pushRemote: "nope" }))).rejects.toThrow(
      /push_remote/,
    );
  }, 15000);

  it("rejects a push_remote with flag-shaped characters", async () => {
    await expect(
      validateRepoContext(cfg, forkCtx({ pushRemote: "--upload-pack=x" })),
    ).rejects.toThrow(/not a valid git remote name/);
  }, 15000);

  it("rejects a push_remote with a leading hyphen (reads as a git flag)", async () => {
    await expect(validateRepoContext(cfg, forkCtx({ pushRemote: "-flag" }))).rejects.toThrow(
      /not a valid git remote name/,
    );
  }, 15000);

  it("checks branch collision against the FORK, not origin", async () => {
    // Plant junco/x on the fork bare only — with an open PR from OUR fork.
    run(["git", "-C", h.work, "push", "fork", "HEAD:refs/heads/junco/x"]);
    process.env.FAKE_GH_PR_LIST_JSON = JSON.stringify([
      {
        number: 12,
        url: "https://github.com/up/stream/pull/12",
        headRepositoryOwner: { login: "me" },
      },
    ]);
    try {
      await expect(validateRepoContext(cfg, forkCtx())).rejects.toThrow(/already exists/);
      // Fork-mode collisions point the operator at the amend iteration path.
      await expect(validateRepoContext(cfg, forkCtx())).rejects.toThrow(/amends_pr/);
    } finally {
      delete process.env.FAKE_GH_PR_LIST_JSON;
    }
    // …and a branch existing on ORIGIN must NOT collide in fork mode.
    run(["git", "-C", h.work, "push", "origin", "HEAD:refs/heads/junco/y"]);
    const ok = forkCtx({ branchName: "junco/y" });
    await expect(validateRepoContext(cfg, ok)).resolves.toBeTruthy();
  }, 15000);

  it("fork mode: a same-named branch PR from SOMEONE ELSE'S fork does not block the resume (issues #29, #70)", async () => {
    run(["git", "-C", h.work, "push", "fork", "HEAD:refs/heads/junco/x"]);
    const remoteSha = run(["git", "-C", h.work, "rev-parse", "HEAD"]).trim();
    // gh pr list --head matches on headRefName only — a stranger's fork with
    // the same branch name must not read as "our PR is already open".
    process.env.FAKE_GH_PR_LIST_JSON = JSON.stringify([
      {
        number: 13,
        url: "https://github.com/up/stream/pull/13",
        headRepositoryOwner: { login: "stranger" },
      },
    ]);
    try {
      const signals = { resumeRemoteSha: null as string | null };
      // retry_count>0 → crash-recovery provenance arms the resume (#70).
      await expect(
        validateRepoContext(cfg, forkCtx(), { signals, retryCount: 1 }),
      ).resolves.toBeTruthy();
      expect(signals.resumeRemoteSha).toBe(remoteSha);
    } finally {
      delete process.env.FAKE_GH_PR_LIST_JSON;
    }
  }, 15000);

  it("appends externalReposRoot to allowed_repo_roots containment", async () => {
    const boxed = { ...cfg, allowedRepoRoots: ["/nowhere"] };
    boxed.github = { ...cfg.github, externalReposRoot: tmp }; // h.work lives under tmp
    await expect(validateRepoContext(boxed, forkCtx())).resolves.toBeTruthy();
  }, 15000);
});

// ---------------------------------------------------------------------------
// resolveAmendTarget — fork PRs (cross-repo PR whose head is our own fork)
// ---------------------------------------------------------------------------

describe("resolveAmendTarget — fork PRs", () => {
  const crossJson = (owner: string) =>
    JSON.stringify({
      state: "OPEN",
      headRefName: "junco/x",
      baseRefName: "main",
      isDraft: true,
      url: "https://github.com/up/stream/pull/9",
      isCrossRepository: true,
      headRepositoryOwner: { login: owner },
      headRepository: { name: "stream" },
    });

  it("allows a cross-repo PR whose head is our fork", async () => {
    process.env.FAKE_GH_PR_JSON = crossJson("me");
    try {
      const ctx = forkCtx({ amendsPr: 9, forkNwo: FORK_NWO });
      const t = await resolveAmendTarget(cfg, ctx, "up/stream");
      expect(t.headRef).toBe("junco/x");
    } finally {
      delete process.env.FAKE_GH_PR_JSON;
    }
  }, 15000);

  it("still refuses someone else's fork", async () => {
    process.env.FAKE_GH_PR_JSON = crossJson("stranger");
    try {
      const ctx = forkCtx({ amendsPr: 9, forkNwo: FORK_NWO });
      await expect(resolveAmendTarget(cfg, ctx, "up/stream")).rejects.toThrow(/cross-repo/);
    } finally {
      delete process.env.FAKE_GH_PR_JSON;
    }
  }, 15000);

  it("refuses a cross-repo PR when the ticket has no push_remote", async () => {
    process.env.FAKE_GH_PR_JSON = crossJson("me");
    try {
      const ctx = forkCtx({ amendsPr: 9, pushRemote: "origin", forkNwo: null });
      await expect(resolveAmendTarget(cfg, ctx, "up/stream")).rejects.toThrow(/push_remote/);
    } finally {
      delete process.env.FAKE_GH_PR_JSON;
    }
  }, 15000);
});
