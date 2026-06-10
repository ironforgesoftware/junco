/**
 * Git worktree provisioning — faithful port of worker.py:
 *   - worktreeSlug            (lines 1915)
 *   - currentHeadSha          (lines 2021-2022)
 *   - linkNodeModules         (lines 1877-1901)
 *   - prepareWorktree         (lines 1904-1982)
 *   - cleanupWorktree         (lines 2066-2070)
 *   - pruneStaleWorktrees     (lines 588-609)
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";
import { isAmend } from "./repoContext.js";
import { log } from "./logging.js";
import type { RepoContext } from "./repoContext.js";
import type { Config } from "./types.js";
import { GitOpError } from "./git.js";

// ---------------------------------------------------------------------------
// worktreeSlug
// ---------------------------------------------------------------------------

/**
 * Port of the inline slug in worker.py prepare_worktree (line 1915):
 *   re.sub(r"[^A-Za-z0-9._-]+", "-", task_id).strip("-") or "ticket"
 *
 * NOTE: Unlike the branch slug (which allows "/"), the worktree DIR slug
 * excludes "/" — it is a simple filesystem directory name.
 */
export function worktreeSlug(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

// ---------------------------------------------------------------------------
// currentHeadSha
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `current_head_sha` (lines 2021-2022).
 */
export async function currentHeadSha(cfg: Pick<Config, "gitBin">, wtPath: string): Promise<string> {
  const result = await git(cfg, ["rev-parse", "HEAD"], { cwd: wtPath });
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// linkNodeModules
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `_link_node_modules` (lines 1877-1901).
 *
 * Symlinks `<repoPath>/node_modules` into `<wtPath>/node_modules` if:
 *   - repoPath/node_modules is a directory
 *   - wtPath/node_modules does not yet exist (not a file, dir, or symlink)
 *
 * Sync fs calls are intentional (matching the Python which is also sync).
 */
export function linkNodeModules(repoPath: string, wtPath: string): void {
  const src = join(repoPath, "node_modules");
  const dst = join(wtPath, "node_modules");

  // Check if source is a real directory
  try {
    const srcStat = lstatSync(src);
    if (!srcStat.isDirectory()) return;
  } catch {
    // src doesn't exist
    return;
  }

  // Check if destination already exists (dir or symlink)
  try {
    lstatSync(dst);
    // If lstat succeeds, dst already exists — respect it, don't clobber
    return;
  } catch {
    // dst doesn't exist — fall through to create symlink
  }

  try {
    symlinkSync(src, dst);
    log.info(`linked node_modules: ${dst} -> ${src}`);
  } catch (e) {
    log.warn(`could not symlink node_modules into worktree (${dst}): ${e}`);
  }
}

// ---------------------------------------------------------------------------
// prepareWorktree
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `prepare_worktree` (lines 1904-1982).
 *
 * Fresh-ticket mode: fetch base branch, create a new feature branch from
 *   origin/<baseBranch>.
 * Amend mode: fetch the existing head branch, create a worktree checked out
 *   on that branch.
 *
 * Returns the worktree path.
 */
export async function prepareWorktree(
  cfg: Config,
  ctx: RepoContext,
  taskId: string,
): Promise<string> {
  // Ensure worktreeRoot exists
  mkdirSync(cfg.worktreeRoot, { recursive: true });

  const slug = worktreeSlug(taskId);
  const wtPath = join(cfg.worktreeRoot, slug);

  // Handle stale worktree from a prior run
  if (existsSync(wtPath)) {
    log.warn(`stale worktree dir exists, pruning: ${wtPath}`);
    // Attempt clean removal via git worktree remove
    await git(cfg, ["worktree", "remove", "--force", wtPath], {
      cwd: ctx.repo,
      check: false,
    });
    if (existsSync(wtPath)) {
      // Last resort: rename out of the way
      const backup = `${wtPath}.old-${Math.floor(Date.now() / 1000)}`;
      try {
        renameSync(wtPath, backup);
      } catch (e) {
        throw new GitOpError(
          `stale worktree cleanup failed: could not move ${wtPath} aside: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
      log.warn(`unprunable worktree moved aside: ${wtPath} -> ${backup}`);
    }
  }

  if (isAmend(ctx)) {
    // Amend mode: fetch the feature branch, then add worktree on it.
    await git(cfg, ["fetch", "origin", ctx.branchName], {
      cwd: ctx.repo,
      timeoutMs: 180_000,
      retryNetwork: true,
    });

    // Force-reset the local branch pointer to origin's tip (check:false —
    // harmless if branch doesn't exist yet; worktree add -B covers it).
    await git(cfg, ["branch", "-f", ctx.branchName, `origin/${ctx.branchName}`], {
      cwd: ctx.repo,
      timeoutMs: 60_000,
      check: false,
    });

    try {
      await git(cfg, ["worktree", "add", wtPath, ctx.branchName], {
        cwd: ctx.repo,
        timeoutMs: 120_000,
      });
    } catch (e) {
      if (
        e instanceof GitOpError &&
        (e.stderr.toLowerCase().includes("already checked out") ||
          e.stderr.toLowerCase().includes("missing"))
      ) {
        // Fall back to force-reset via -B semantics
        await git(
          cfg,
          ["worktree", "add", "-B", ctx.branchName, wtPath, `origin/${ctx.branchName}`],
          { cwd: ctx.repo, timeoutMs: 120_000 },
        );
      } else {
        throw e;
      }
    }

    linkNodeModules(ctx.repo, wtPath);
    return wtPath;
  }

  // Fresh-ticket mode: fetch base, create a NEW feature branch.
  await git(cfg, ["fetch", "origin", ctx.baseBranch], {
    cwd: ctx.repo,
    timeoutMs: 180_000,
    retryNetwork: true,
  });

  try {
    await git(cfg, ["worktree", "add", "-b", ctx.branchName, wtPath, `origin/${ctx.baseBranch}`], {
      cwd: ctx.repo,
      timeoutMs: 120_000,
    });
  } catch (e) {
    if (e instanceof GitOpError && e.stderr.toLowerCase().includes("already exists")) {
      // Branch may already exist locally (no remote) — add without -b.
      await git(cfg, ["worktree", "add", wtPath, ctx.branchName], {
        cwd: ctx.repo,
        timeoutMs: 120_000,
      });
    } else {
      throw e;
    }
  }

  linkNodeModules(ctx.repo, wtPath);
  return wtPath;
}

// ---------------------------------------------------------------------------
// cleanupWorktree
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `cleanup_worktree` (lines 2066-2070).
 *
 * Best-effort removal — swallows all errors (logs a warning).
 */
export async function cleanupWorktree(
  cfg: Config,
  ctx: RepoContext,
  wtPath: string,
): Promise<void> {
  try {
    await git(cfg, ["worktree", "remove", wtPath], {
      cwd: ctx.repo,
      timeoutMs: 60_000,
      check: false,
    });
  } catch (e) {
    log.warn(`worktree remove failed (non-fatal): ${e}`);
  }
}

// ---------------------------------------------------------------------------
// pruneStaleWorktrees
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `prune_stale_worktrees` (lines 588-609).
 *
 * Removes `*.old-<unix-ts>` dirs in worktreeRoot that are older than
 * maxAgeSeconds. Uses the timestamp embedded in the name (not dir mtime).
 *
 * No-op if worktreeRoot does not exist.
 */
export function pruneStaleWorktrees(worktreeRoot: string, maxAgeSeconds = 3 * 86400): void {
  if (!existsSync(worktreeRoot)) return;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const OLD_TS_RE = /\.old-(\d+)$/;

  let entries: string[];
  try {
    entries = readdirSync(worktreeRoot);
  } catch {
    return;
  }

  for (const name of entries) {
    const m = OLD_TS_RE.exec(name);
    if (!m) continue;

    const childPath = join(worktreeRoot, name);

    // Must be a directory
    try {
      const st = lstatSync(childPath);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }

    const ts = parseInt(m[1], 10);
    const age = nowSeconds - ts;
    if (age < maxAgeSeconds) continue;

    log.info(`pruning stale worktree backup (age=${age}s): ${childPath}`);
    rmSync(childPath, { recursive: true, force: true });
  }
}
