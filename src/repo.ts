/**
 * Repo validation + amend-target resolution — faithful port of worker.py's
 * `AmendTarget`, `resolve_amend_target`, and `validate_repo_context`.
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
 * Port of worker.py `resolve_amend_target`.
 *
 * Queries gh for the PR's metadata; refuses closed/merged PRs, and refuses
 * cross-repo PRs unless the head is the operator's own fork (ctx.forkNwo).
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
        "state,headRefName,baseRefName,isDraft,url,isCrossRepository,headRepositoryOwner,headRepository",
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
    // Cross-repo PRs are refused UNLESS the head is the operator's own fork
    // (ctx.forkNwo, derived from ctx.pushRemote in validateRepoContext) —
    // anyone else's fork keeps the blanket refusal.
    const owner = String(
      (data["headRepositoryOwner"] as Record<string, unknown> | undefined)?.["login"] ?? "",
    );
    const name = String(
      (data["headRepository"] as Record<string, unknown> | undefined)?.["name"] ?? "",
    );
    const headNwo = owner && name ? `${owner}/${name}` : null;
    const ownFork =
      ctx.forkNwo !== null &&
      headNwo !== null &&
      headNwo.toLowerCase() === ctx.forkNwo.toLowerCase();
    if (!ownFork) {
      throw new GitOpError(
        `PR #${ctx.amendsPr} is from a fork (cross-repo); worker cannot push to it` +
          (ctx.forkNwo === null
            ? " — set push_remote on the ticket to amend a PR from YOUR fork"
            : ` — PR head ${headNwo ?? "unknown"} is not the ${ctx.pushRemote} remote (${ctx.forkNwo})`),
      );
    }
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

/** Optional signals threaded out of a fresh-mode validation.
 * `resumeRemoteSha` is set (issue #29) when the ticket's branch already
 * exists on the push remote but carries NO open PR of ours — the state is a
 * crashed/interrupted run, not a collision, so the flow may RESUME: push
 * `--force-with-lease` against this sha and idempotently (re)create the PR. */
interface ValidateSignals {
  resumeRemoteSha: string | null;
}

export interface ValidateOpts {
  signals?: ValidateSignals;
  /** Issue #70: the ticket's transparent-retry counter (0 on first attempt).
   * Fresh-mode resume — force-pushing over a branch that is already on the push
   * remote but carries NO open PR of ours — is armed ONLY when this is > 0.
   * That is positive provenance the branch is junco's OWN crashed run: a genuine
   * crash between push and PR-create leaves the ticket in processing/, and orphan
   * recovery requeues it with retry_count++ (see orphans.ts / requeue.ts). A
   * FRESH ticket (retryCount 0) whose branch_name collides with a PR-less remote
   * branch is REFUSED — that branch may be a human's WIP and must not be
   * clobbered. */
  retryCount?: number;
}

/** A minimal open-PR reference for the fresh-mode collision check. */
interface OpenPrRef {
  number: number;
  url: string;
  headOwner: string | null;
}

/**
 * List OPEN PRs whose head branch is `ctx.branchName` on `nwo`. Returns null
 * when the query could not be run/parsed — the caller then treats the branch
 * as un-resumable (conservative: never force-push when we cannot confirm no
 * PR exists).
 */
async function listOpenPrsForHead(
  cfg: Config,
  ctx: RepoContext,
  nwo: string,
): Promise<OpenPrRef[] | null> {
  const r = await gh(
    cfg,
    [
      "pr",
      "list",
      "--repo",
      nwo,
      "--head",
      ctx.branchName,
      "--state",
      "open",
      "--json",
      "number,url,headRepositoryOwner",
    ],
    { cwd: ctx.repo, check: false, retryNetwork: true },
  );
  if (r.code !== 0) return null;
  try {
    const arr = JSON.parse(r.stdout || "[]") as Record<string, unknown>[];
    if (!Array.isArray(arr)) return null;
    return arr.map((p) => ({
      number: Number(p["number"] ?? 0),
      url: String(p["url"] ?? ""),
      headOwner: (p["headRepositoryOwner"] as Record<string, unknown> | undefined)?.["login"]
        ? String((p["headRepositoryOwner"] as Record<string, unknown>)["login"])
        : null,
    }));
  } catch {
    return null;
  }
}

/**
 * Select the sha of the ref that is EXACTLY `refs/heads/<branchName>` from
 * `git ls-remote --heads` output, or null when no line's ref matches exactly.
 *
 * `git ls-remote --heads <remote> <branch>` matches against the ref TAIL, so a
 * sibling ref like `refs/heads/sub/<branch>` also appears in the output. Taking
 * the first whitespace token of the whole output (the pre-#72 code) could grab
 * a sibling's sha — a wrong `--force-with-lease` lease — or read a sibling-only
 * result as a collision. Parse line-by-line and keep only the exact ref.
 */
function exactRefSha(lsRemoteStdout: string, branchName: string): string | null {
  const wanted = `refs/heads/${branchName}`;
  for (const line of lsRemoteStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/);
    if (ref === wanted) return sha;
  }
  return null;
}

/**
 * Port of worker.py `validate_repo_context`.
 *
 * Verifies repo, remote, and base branch. Returns the repo's nameWithOwner.
 * Raises GitOpError on any precondition failure.
 *
 * If ctx.amendsPr is set, the branch-collision check is replaced by a PR
 * lookup and ctx.branchName / ctx.baseBranch are MUTATED to match the PR's
 * head / base refs.
 *
 * Fresh mode (issues #29, #70): when the branch already exists on the push
 * remote, an open PR of ours keeps the terminal refusal (hinting `amends_pr`).
 * With NO such PR the branch is only resumed — `opts.signals.resumeRemoteSha`
 * set to the remote tip for a force-push-with-lease + recreate — when
 * `opts.retryCount > 0` (crash-recovery provenance: orphan recovery requeued a
 * genuine crash-between-push-and-create). A FRESH ticket (retryCount 0) with a
 * PR-less colliding branch is REFUSED, never force-pushed over.
 */
export async function validateRepoContext(
  cfg: Config,
  ctx: RepoContext,
  opts: ValidateOpts = {},
): Promise<string> {
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

  // push_remote resolution. The remote NAME is validated: a leading '-' would
  // read as a git flag, so the anchor forbids it (interior hyphens are fine);
  // the config-key probe below (`git config --get remote.<name>.url`) is the
  // second rail. For a non-origin remote the fork's nwo is derived from the
  // remote URL — never guessed from a username.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(ctx.pushRemote)) {
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
          `run junco import (or add the fork remote) first`,
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

  // The branch's state on the push remote decides collision vs. resume. Match
  // the ref EXACTLY (issue #72): `--heads <branch>` tail-matches, so a sibling
  // ref like refs/heads/sub/<branch> also shows up — only refs/heads/<branch>
  // itself counts as this branch existing, and its sha is the lease target.
  const bls = await git(cfg, ["ls-remote", "--heads", ctx.pushRemote, ctx.branchName], {
    cwd: ctx.repo,
    check: false,
    retryNetwork: true,
  });
  const remoteSha = bls.code === 0 ? exactRefSha(bls.stdout, ctx.branchName) : null;
  if (remoteSha !== null) {
    // Does an OPEN PR of OURS already track this branch? For a fork push the
    // head owner must be our fork's owner (a stranger's same-named branch PR
    // is not ours); for origin it is the repo owner. A null/failed query is
    // treated as "cannot confirm" → refuse (never force-push blindly).
    const expectedOwner = (ctx.pushRemote !== "origin" && ctx.forkNwo ? ctx.forkNwo : nwo)
      .split("/")[0]
      .toLowerCase();
    const prs = await listOpenPrsForHead(cfg, ctx, nwo);
    const ours =
      prs === null
        ? undefined
        : prs.find((p) => (p.headOwner ?? expectedOwner).toLowerCase() === expectedOwner);

    // No open PR of ours + crash-recovery provenance (retry_count > 0) → the
    // pushed branch is junco's OWN crashed/interrupted run, not a collision.
    // Signal the remote tip so the flow force-pushes with a lease on it and
    // idempotently (re)creates the PR. A FRESH ticket (retryCount 0) is NOT
    // resumed here: the branch may be human WIP — fall through to the refusal
    // below (#70).
    const resumeArmed = opts.signals !== undefined && (opts.retryCount ?? 0) > 0;
    if (prs !== null && ours === undefined && resumeArmed) {
      opts.signals!.resumeRemoteSha = remoteSha;
      log.warn(
        `branch ${JSON.stringify(ctx.branchName)} already on ${ctx.pushRemote} but no open PR of ours ` +
          `and ticket was requeued (retry_count>0) — resuming crashed run (will push --force-with-lease)`,
      );
      return nwo;
    }

    // Refuse. An open PR of ours points the operator at the amend iteration
    // path (hinting the actual PR number); fork mode uses its own wording.
    if (ours) {
      const prHint = String(ours.number);
      if (ctx.pushRemote !== "origin") {
        throw new GitOpError(
          `branch ${JSON.stringify(ctx.branchName)} already exists on fork; ` +
            `to push feedback commits to the open PR, dispatch a ticket with ` +
            `amends_pr: ${prHint} and push_remote: ${ctx.pushRemote} — or pick a different branch_name`,
        );
      }
      throw new GitOpError(
        `branch ${JSON.stringify(ctx.branchName)} already exists on ${ctx.pushRemote} with an open PR; ` +
          `iterate with amends_pr: ${prHint} (or pick a different branch_name or delete the remote branch)`,
      );
    }

    // No open PR of ours (or the PR query could not be run) on a ticket that is
    // NOT resuming a crash: a name-colliding remote branch we cannot attribute
    // to a crashed run of ours. Refuse rather than force-push over what may be
    // human work-in-progress (#70) — a genuine crashed junco run resumes
    // automatically on a later retry, once orphan recovery has bumped
    // retry_count above 0.
    const where = ctx.pushRemote !== "origin" ? "fork" : ctx.pushRemote;
    throw new GitOpError(
      `branch ${JSON.stringify(ctx.branchName)} already exists on ${where} with no open PR of ours — ` +
        `refusing to overwrite it (it may be work in progress). If this is a crashed junco run it will ` +
        `resume automatically on a later retry; otherwise pick a different branch_name or delete the remote branch.`,
    );
  }

  return nwo;
}
