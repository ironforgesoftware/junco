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
  rmdirSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { git, isNetworkError } from "./git.js";
import { isAmend } from "./repoContext.js";
import { log } from "./logging.js";
import type { RepoContext } from "./repoContext.js";
import type { Config } from "./types.js";
import { GitOpError } from "./git.js";
import { acquirePidfileLock } from "./pidfileLock.js";

// ---------------------------------------------------------------------------
// worktreesLockPath
// ---------------------------------------------------------------------------

/**
 * Path of the daemon-side worktrees advisory lock over `worktreeRoot` mutations
 * (prepare/cleanup/prune here, and the `junco worktree prune` CLI). Same hardened
 * primitive as the outbox flush lock (src/pidfileLock.ts), but this is NOT a true
 * mutex — the lock is ONE-DIRECTIONAL. The daemon acquires it yet proceeds even
 * when acquisition fails (it ignores the null return, being the singleton
 * writer); only `junco worktree prune` yields when it can't acquire, backing off
 * rather than racing `git worktree add/remove` on shared `.git/worktrees/<id>`
 * metadata. So the lock is a courtesy that makes prune yield to the daemon — it
 * is NOT the liveness guarantee. That guarantee is the SLUG GATE (prune refuses
 * any worktree whose slug matches a processing/ or /health currentTickets
 * ticket); do not lean on this lock for correctness.
 */
export function worktreesLockPath(cfg: Pick<Config, "worktreeRoot">): string {
  return join(cfg.worktreeRoot, ".worktrees.lock");
}

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
// repoDiscriminator
// ---------------------------------------------------------------------------

/**
 * Per-repo namespace segment for worktree paths (issue #33): with
 * max_concurrent > 1 the scheduler serializes same-REPO tickets only, so two
 * same-slug tickets targeting different repos may run concurrently — keying
 * the worktree path on the slug alone let the second provision destroy the
 * first's live worktree. The discriminator derives from the RESOLVED repo
 * path: a readable basename slug plus a short hash so two repos sharing a
 * basename still get distinct namespaces.
 */
export function repoDiscriminator(repoPath: string): string {
  const real = resolve(repoPath);
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  return `${worktreeSlug(basename(real))}-${hash}`;
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
// seedBotIdentity
// ---------------------------------------------------------------------------

/** Bot mode: stamp the bot's identity into PER-WORKTREE git config so every
 * process committing here (the agent's bash tool — sandboxed or not — and
 * commitLeftovers) authors as the bot, while the parent clone's identity is
 * untouched. Requires extensions.worktreeConfig (git ≥ 2.20); enabling it
 * writes one inert flag into the parent's .git/config — the only mutation the
 * parent ever sees. No-op when cfg.ghAuth is absent. */
async function seedBotIdentity(cfg: Config, repoPath: string, wtPath: string): Promise<void> {
  if (!cfg.ghAuth) return;
  await git(cfg, ["config", "extensions.worktreeConfig", "true"], {
    cwd: repoPath,
    timeoutMs: 30_000,
  });
  await git(cfg, ["config", "--worktree", "user.name", cfg.ghAuth.login], {
    cwd: wtPath,
    timeoutMs: 30_000,
  });
  await git(cfg, ["config", "--worktree", "user.email", cfg.ghAuth.email], {
    cwd: wtPath,
    timeoutMs: 30_000,
  });
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
 * Returns the worktree path. When `opts.signals` is supplied and the fresh-mode
 * base fetch fails with a network error, the fetch is tolerated (worktree is cut
 * from the local `origin/<base>` ref) and `signals.staleBase` is flipped true so
 * the PR body can flag the possibly-stale base — everything else still throws.
 * `opts.retryBaseDelayMs` overrides the fetch's network-retry backoff base
 * (tests scripting offline fetches pass ~5ms).
 */
export async function prepareWorktree(
  cfg: Config,
  ctx: RepoContext,
  taskId: string,
  opts: { signals?: { staleBase: boolean }; retryBaseDelayMs?: number } = {},
): Promise<string> {
  const lock = acquirePidfileLock(worktreesLockPath(cfg));
  try {
    const slug = worktreeSlug(taskId);
    // Worktree paths are namespaced per repo (issue #33): the stale-dir pruning
    // below must never be able to hit a same-slug ticket running against a
    // DIFFERENT repo. Creates worktreeRoot too (recursive).
    const repoDir = join(cfg.worktreeRoot, repoDiscriminator(ctx.repo));
    mkdirSync(repoDir, { recursive: true });
    const wtPath = join(repoDir, slug);

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
      // Amend mode: fetch the feature branch from the push remote (the
      // operator's own fork when ctx.pushRemote !== "origin"), then add
      // worktree on it.
      await git(cfg, ["fetch", ctx.pushRemote, ctx.branchName], {
        cwd: ctx.repo,
        timeoutMs: 180_000,
        retryNetwork: true,
        retryBaseDelayMs: opts.retryBaseDelayMs,
      });

      // Force-reset the local branch pointer to the push remote's tip
      // (check:false — harmless if branch doesn't exist yet; worktree add -B
      // covers it).
      await git(cfg, ["branch", "-f", ctx.branchName, `${ctx.pushRemote}/${ctx.branchName}`], {
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
            [
              "worktree",
              "add",
              "-B",
              ctx.branchName,
              wtPath,
              `${ctx.pushRemote}/${ctx.branchName}`,
            ],
            { cwd: ctx.repo, timeoutMs: 120_000 },
          );
        } else {
          throw e;
        }
      }

      await seedBotIdentity(cfg, ctx.repo, wtPath);
      linkNodeModules(ctx.repo, wtPath);
      return wtPath;
    }

    // Fresh-ticket mode: fetch base, create a NEW feature branch. Offline
    // tolerance: a network-shaped fetch failure is survivable — the worktree is
    // cut from whatever `origin/<base>` we already have locally, and the caller
    // is told the base may be stale (see signals.staleBase).
    try {
      await git(cfg, ["fetch", "origin", ctx.baseBranch], {
        cwd: ctx.repo,
        timeoutMs: 180_000,
        retryNetwork: true,
        retryBaseDelayMs: opts.retryBaseDelayMs,
      });
    } catch (e) {
      if (e instanceof GitOpError && isNetworkError(e.stderr)) {
        log.warn("offline — proceeding from local base");
        if (opts.signals) opts.signals.staleBase = true;
      } else {
        throw e;
      }
    }

    try {
      await git(
        cfg,
        ["worktree", "add", "-b", ctx.branchName, wtPath, `origin/${ctx.baseBranch}`],
        {
          cwd: ctx.repo,
          timeoutMs: 120_000,
        },
      );
    } catch (e) {
      if (e instanceof GitOpError && e.stderr.toLowerCase().includes("already exists")) {
        // Branch already exists locally — a leftover from a crashed run that
        // committed but never pushed. Force-reset it to the base (issue #34):
        // adding it without -B would check out the stale tip and the retry
        // would silently build on (and re-verify against) the aborted work.
        // Mirrors the amend path's -B recovery above.
        await git(
          cfg,
          ["worktree", "add", "-B", ctx.branchName, wtPath, `origin/${ctx.baseBranch}`],
          { cwd: ctx.repo, timeoutMs: 120_000 },
        );
      } else {
        throw e;
      }
    }

    await seedBotIdentity(cfg, ctx.repo, wtPath);
    linkNodeModules(ctx.repo, wtPath);
    return wtPath;
  } finally {
    lock?.release();
  }
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
  const lock = acquirePidfileLock(worktreesLockPath(cfg));
  try {
    try {
      await git(cfg, ["worktree", "remove", wtPath], {
        cwd: ctx.repo,
        timeoutMs: 60_000,
        check: false,
      });
    } catch (e) {
      log.warn(`worktree remove failed (non-fatal): ${e}`);
    }
    // Issue #33 layout: worktrees live under worktreeRoot/<repo-discriminator>/.
    // Drop the per-repo parent when this was its last worktree — rmdir only
    // removes EMPTY dirs, so a live sibling (or .old-* backup) keeps it alive.
    const parent = dirname(wtPath);
    if (resolve(parent) !== resolve(cfg.worktreeRoot)) {
      try {
        rmdirSync(parent);
      } catch {
        /* non-empty or already gone — fine */
      }
    }
  } finally {
    lock?.release();
  }
}

// ---------------------------------------------------------------------------
// pruneStaleWorktrees
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `prune_stale_worktrees` (lines 588-609).
 *
 * Removes `*.old-<unix-ts>` dirs under worktreeRoot that are older than
 * maxAgeSeconds. Uses the timestamp embedded in the name (not dir mtime).
 * Backups live either directly in worktreeRoot (legacy flat layout) or one
 * level down inside a per-repo discriminator dir (issue #33 layout) — both
 * are scanned. Recursion never enters a git checkout (a dir with a `.git`
 * entry): a legacy live worktree's own files are not junco's to prune.
 *
 * No-op if worktreeRoot does not exist.
 */
export function pruneStaleWorktrees(worktreeRoot: string, maxAgeSeconds = 3 * 86400): void {
  if (!existsSync(worktreeRoot)) return;

  const lock = acquirePidfileLock(worktreesLockPath({ worktreeRoot }));
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const OLD_TS_RE = /\.old-(\d+)$/;

    const pruneDir = (dir: string, depth: number): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const name of entries) {
        const childPath = join(dir, name);

        // Must be a directory
        try {
          const st = lstatSync(childPath);
          if (!st.isDirectory()) continue;
        } catch {
          continue;
        }

        const m = OLD_TS_RE.exec(name);
        if (!m) {
          // Per-repo discriminator dirs hold the backups one level down; a git
          // checkout (`.git` file or dir) is a live worktree — never enter it.
          if (depth === 0 && !existsSync(join(childPath, ".git"))) pruneDir(childPath, 1);
          continue;
        }

        const ts = parseInt(m[1], 10);
        const age = nowSeconds - ts;
        if (age < maxAgeSeconds) continue;

        log.info(`pruning stale worktree backup (age=${age}s): ${childPath}`);
        rmSync(childPath, { recursive: true, force: true });
      }
    };

    pruneDir(worktreeRoot, 0);
  } finally {
    lock?.release();
  }
}
