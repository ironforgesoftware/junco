/**
 * Repo validation + amend-target resolution — faithful port of worker.py:
 *   - AmendTarget             (lines 1767-1774)
 *   - resolveAmendTarget      (lines 1776-1812)
 *   - validateRepoContext     (lines 1815-1874)
 */

import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { git, gh, GitOpError } from "./git.js";
import { isAmend } from "./repoContext.js";
import { log } from "./logging.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import type { RepoContext } from "./repoContext.js";
import type { Config } from "./types.js";

// ---------------------------------------------------------------------------
// AmendTarget
// ---------------------------------------------------------------------------

export interface AmendTarget {
  prNumber: number;
  prUrl: string;
  headRef: string;
  baseRef: string;
  isDraft: boolean;
}

// ---------------------------------------------------------------------------
// resolveAmendTarget
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `resolve_amend_target` (lines 1776-1812).
 *
 * Queries gh for the PR's metadata; refuses closed/merged/cross-repo PRs.
 */
export async function resolveAmendTarget(
  cfg: Config,
  ctx: RepoContext,
  nwo: string,
): Promise<AmendTarget> {
  if (ctx.amendsPr === null) {
    throw new GitOpError("resolveAmendTarget called with no amendsPr");
  }

  let stdout: string;
  try {
    const result = await gh(
      cfg,
      [
        "pr",
        "view",
        String(ctx.amendsPr),
        "--repo",
        nwo,
        "--json",
        "state,headRefName,baseRefName,isDraft,url,isCrossRepository",
      ],
      { cwd: ctx.repo, retryNetwork: true },
    );
    stdout = result.stdout;
  } catch (e) {
    if (e instanceof GitOpError) {
      throw new GitOpError(`gh pr view #${ctx.amendsPr} failed: ${e.stderr.trim() || e.message}`);
    }
    throw e;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout || "{}") as Record<string, unknown>;
  } catch {
    throw new GitOpError(`gh pr view returned non-JSON: ${stdout.slice(0, 200)}`);
  }

  const state = String(data["state"] ?? "");
  if (state !== "OPEN") {
    throw new GitOpError(
      `PR #${ctx.amendsPr} is ${JSON.stringify(state)}, not OPEN — cannot amend`,
    );
  }

  if (data["isCrossRepository"]) {
    throw new GitOpError(
      `PR #${ctx.amendsPr} is from a fork (cross-repo); worker cannot push to it`,
    );
  }

  const head = String(data["headRefName"] ?? "");
  const base = String(data["baseRefName"] ?? "");
  const url = String(data["url"] ?? "");

  if (!head || !base || !url) {
    throw new GitOpError(`PR #${ctx.amendsPr} metadata incomplete: ${JSON.stringify(data)}`);
  }

  return {
    prNumber: ctx.amendsPr,
    prUrl: url,
    headRef: head,
    baseRef: base,
    isDraft: Boolean(data["isDraft"]),
  };
}

// ---------------------------------------------------------------------------
// validateRepoContext
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `validate_repo_context` (lines 1815-1874).
 *
 * Verifies repo, remote, and base branch. Returns the repo's nameWithOwner.
 * Raises GitOpError on any precondition failure.
 *
 * If ctx.amendsPr is set, the branch-collision check is replaced by a PR
 * lookup and ctx.branchName / ctx.baseBranch are MUTATED to match the PR's
 * head / base refs.
 */
export async function validateRepoContext(cfg: Config, ctx: RepoContext): Promise<string> {
  // Containment rail: when [git].allowed_repo_roots is non-empty, a ticket may
  // only target repos under one of those roots. The inbox is a code-execution
  // boundary — this caps where a hostile or fat-fingered ticket can point it.
  if (cfg.allowedRepoRoots.length > 0) {
    const real = resolve(ctx.repo);
    // externalReposRoot is implicitly allowed: dispatch-managed clones must not
    // silently break under a locked-down allowed_repo_roots.
    const allowed = [...cfg.allowedRepoRoots, cfg.github.externalReposRoot];
    const ok = allowed.some((root) => {
      const r = resolve(root);
      return real === r || real.startsWith(r + sep);
    });
    if (!ok) {
      throw new GitOpError(
        `repo ${ctx.repo} is outside [git].allowed_repo_roots — refusing to run this ticket`,
      );
    }
  }

  // Check repo path exists
  if (!existsSync(ctx.repo)) {
    throw new GitOpError(`repo path does not exist: ${ctx.repo}`);
  }

  // Check it is a git repo (.git dir or file)
  const dotGit = join(ctx.repo, ".git");
  if (!existsSync(dotGit)) {
    throw new GitOpError(`not a git repo: ${ctx.repo} (no .git)`);
  }

  // Cheap structural check for fresh tickets (amend mode overrides branches
  // later, so this check would be wrong for pre-override values).
  if (!isAmend(ctx) && ctx.branchName === ctx.baseBranch) {
    throw new GitOpError(
      `branch_name (${ctx.branchName}) must differ from base_branch (${ctx.baseBranch})`,
    );
  }

  // Resolve repo name-with-owner via gh. Also validates that gh has credentials.
  let nwo: string;
  try {
    const nwoResult = await gh(
      cfg,
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      { cwd: ctx.repo, retryNetwork: true },
    );
    nwo = nwoResult.stdout.trim();
  } catch (e) {
    if (e instanceof GitOpError) {
      throw new GitOpError(`gh repo view failed in ${ctx.repo}: ${e.stderr.trim() || e.message}`);
    }
    throw e;
  }

  if (!nwo) {
    throw new GitOpError(`gh could not determine nameWithOwner for ${ctx.repo}`);
  }

  // push_remote resolution. The remote NAME is validated (a "-"-prefixed value
  // would be parsed as a git flag), and for a non-origin remote the fork's nwo
  // is derived from the remote URL — never guessed from a username.
  if (!/^[A-Za-z0-9_-]+$/.test(ctx.pushRemote)) {
    throw new GitOpError(
      `push_remote ${JSON.stringify(ctx.pushRemote)} is not a valid git remote name`,
    );
  }
  if (ctx.pushRemote !== "origin") {
    // `git remote get-url` resolves `url.<base>.insteadOf` rewrites (per its
    // own docs), which would hand us the rewritten push target instead of the
    // configured github.com URL. `git config --get remote.<name>.url` reads
    // the raw value, which is what nwoFromRemoteUrl needs.
    const fr = await git(cfg, ["config", "--get", `remote.${ctx.pushRemote}.url`], {
      cwd: ctx.repo,
      check: false,
    });
    if (fr.code !== 0 || !fr.stdout.trim()) {
      throw new GitOpError(
        `push_remote ${JSON.stringify(ctx.pushRemote)} is not a remote on ${ctx.repo} — ` +
          `run junco dispatch (or add the fork remote) first`,
      );
    }
    const forkNwo = nwoFromRemoteUrl(fr.stdout.trim());
    if (forkNwo === null) {
      throw new GitOpError(
        `push_remote ${ctx.pushRemote} URL is not a github.com remote: ${fr.stdout.trim()}`,
      );
    }
    ctx.forkNwo = forkNwo;
  }

  if (isAmend(ctx)) {
    // Amend mode: resolve the PR's branches and override ctx accordingly.
    const target = await resolveAmendTarget(cfg, ctx, nwo);

    if (ctx.branchName && ctx.branchName !== target.headRef) {
      log.warn(
        `amend ticket specified branchName=${JSON.stringify(ctx.branchName)} but PR #${ctx.amendsPr} head is ${JSON.stringify(target.headRef)}; using the PR's head`,
      );
    }
    if (ctx.baseBranch && ctx.baseBranch !== target.baseRef) {
      log.warn(
        `amend ticket specified baseBranch=${JSON.stringify(ctx.baseBranch)} but PR #${ctx.amendsPr} base is ${JSON.stringify(target.baseRef)}; using the PR's base`,
      );
    }

    // MUTATE ctx to reflect the PR's actual branches
    ctx.branchName = target.headRef;
    ctx.baseBranch = target.baseRef;

    // Verify the head branch actually exists on the push remote
    const bls = await git(cfg, ["ls-remote", "--heads", ctx.pushRemote, ctx.branchName], {
      cwd: ctx.repo,
      check: false,
      retryNetwork: true,
    });
    if (bls.code !== 0 || !bls.stdout.trim()) {
      throw new GitOpError(
        `PR #${ctx.amendsPr} head branch ${JSON.stringify(ctx.branchName)} not on ${ctx.pushRemote}`,
      );
    }
    return nwo;
  }

  // Fresh-ticket mode: enforce remaining safety rails.
  // Ensure base branch exists on origin.
  const ls = await git(cfg, ["ls-remote", "--heads", "origin", ctx.baseBranch], {
    cwd: ctx.repo,
    check: false,
    retryNetwork: true,
  });
  if (ls.code !== 0 || !ls.stdout.trim()) {
    throw new GitOpError(
      `base branch ${JSON.stringify(ctx.baseBranch)} not found on origin (or ls-remote failed)`,
    );
  }

  // Refuse to stomp an existing branch on the push remote.
  const bls = await git(cfg, ["ls-remote", "--heads", ctx.pushRemote, ctx.branchName], {
    cwd: ctx.repo,
    check: false,
    retryNetwork: true,
  });
  if (bls.code === 0 && bls.stdout.trim()) {
    throw new GitOpError(
      `branch ${JSON.stringify(ctx.branchName)} already exists on ${ctx.pushRemote}; pick a different branch_name or delete the remote branch first`,
    );
  }

  return nwo;
}
