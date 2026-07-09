/**
 * `junco worktree prune <path>` — the single chokepoint for destroying a
 * per-ticket worktree, shared by the CLI and (later) the dashboard so ONE place
 * owns the daemon-safety discipline:
 *
 *   1. Path containment: the path must resolve under cfg.worktreeRoot.
 *   2. Shared lock: acquire the SAME worktrees.lock the daemon takes around its
 *      worktree mutations (prepareWorktree/cleanupWorktree/pruneStaleWorktrees,
 *      wired daemon-side in Stage B), so prune and daemon provisioning are
 *      mutually exclusive — they can no longer race .git/worktrees/<id> metadata
 *      or index.lock.
 *   3. Liveness gate, UNDER the lock: refuse if the worktree's slug segment
 *      matches worktreeSlug(id) for any ticket in processing/ OR any /health
 *      currentTickets entry. Because the check runs under the lock it observes
 *      the committed processing/ state the daemon writes before provisioning —
 *      closing the TOCTOU. Daemon down / health disabled → processing/ scan
 *      alone (authoritative when no concurrent writer exists). The slug gate does
 *      NOT depend on the repo reverse-map, so an ⟨unmapped⟩ worktree is still
 *      gated.
 *   4. Remove: `git worktree remove --force` (safe ONLY because 2+3 established,
 *      under the lock, that no live run owns this tree — junco never calls
 *      `git worktree lock`, so we do not rely on git's lock semantics), then
 *      rmdir the now-empty per-repo discriminator parent (mirrors cleanupWorktree).
 */

import { readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Config } from "./types.js";
import { git } from "./git.js";
import { queuePaths } from "./config.js";
import { parseTicket } from "./ticket.js";
import { worktreeSlug, worktreesLockPath } from "./worktree.js";
import { acquirePidfileLock, type PidfileLock } from "./pidfileLock.js";

const HEALTH_TIMEOUT_MS = 1500;

export interface PruneDeps {
  printFn?: (s: string) => void;
  /** Async git runner (non-throwing): resolves { code, stdout }. Default spawns real git with check:false. */
  gitFn?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
  /** fetch seam for the /health currentTickets probe. Default: global fetch. */
  fetchFn?: typeof fetch;
  /** processing/ directory listing. Default: fs.readdirSync. */
  readdirFn?: (d: string) => string[];
  /** Ticket file read. Default: fs.readFileSync utf8. */
  readFileFn?: (p: string) => string;
  /** Lock acquisition seam. Default: acquirePidfileLock(worktreesLockPath(cfg)). */
  acquireLockFn?: () => PidfileLock | null;
  /** Empty-parent removal. Default: fs.rmdirSync. */
  rmdirFn?: (p: string) => void;
  /** Recursive fallback removal for a broken/backup worktree. Default: fs.rmSync recursive+force. */
  rmRecursiveFn?: (p: string) => void;
}

export async function runWorktreePruneCommand(
  cfg: Config,
  args: string[],
  deps: PruneDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const gitFn =
    deps.gitFn ??
    (async (a: string[], cwd: string) => {
      const r = await git(cfg, a, { cwd, check: false });
      return { code: r.code, stdout: r.stdout };
    });
  const fetchFn = deps.fetchFn ?? fetch;
  const readdirFn = deps.readdirFn ?? ((d: string) => readdirSync(d));
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const acquireLockFn = deps.acquireLockFn ?? (() => acquirePidfileLock(worktreesLockPath(cfg)));
  const rmdirFn = deps.rmdirFn ?? ((p: string) => rmdirSync(p));
  const rmRecursiveFn =
    deps.rmRecursiveFn ?? ((p: string) => rmSync(p, { recursive: true, force: true }));

  const rawArg = args[0];
  if (!rawArg) {
    print("Usage: junco worktree prune <path>\n");
    return 2;
  }

  // 1. Path containment — never operate outside the daemon-owned worktree root.
  const root = resolve(cfg.worktreeRoot);
  const target = resolve(rawArg);
  if (target === root) {
    print("junco worktree prune: refusing to remove the worktree root itself\n");
    return 2;
  }
  if (!target.startsWith(root + sep)) {
    print(`junco worktree prune: '${rawArg}' is not under the worktree root (${root})\n`);
    return 2;
  }

  // 2. Shared lock — mutual exclusion with the daemon's worktree mutations.
  const lock = acquireLockFn();
  if (lock === null) {
    print("junco worktree prune: another worktree operation is in progress — try again\n");
    return 1;
  }

  try {
    // 3. Liveness gate, computed UNDER the lock.
    const liveSlugs = new Set<string>();

    // processing/ scan — the daemon commits a claimed ticket here BEFORE it
    // provisions the worktree, so under our lock this set is authoritative.
    const processingDir = queuePaths(cfg).processing;
    let names: string[] = [];
    try {
      names = readdirFn(processingDir).filter((n) => n.endsWith(".md"));
    } catch {
      /* no processing dir yet */
    }
    for (const n of names) {
      const p = join(processingDir, n);
      try {
        liveSlugs.add(worktreeSlug(parseTicket(p, readFileFn(p), cfg.defaultTimeoutMinutes).id));
      } catch {
        /* unreadable/unparseable — can't own a live worktree; skip */
      }
    }

    // /health currentTickets — the live in-flight set while the daemon is up.
    // Unreachable / disabled → processing/ scan alone (fallback above).
    for (const id of await fetchCurrentTickets(cfg, fetchFn)) liveSlugs.add(worktreeSlug(id));

    const targetSlug = basename(target);
    if (liveSlugs.has(targetSlug)) {
      print(
        `junco worktree prune: refusing to prune '${targetSlug}' — a live/queued ticket owns it\n`,
      );
      return 1;
    }

    // 4. Remove under the lock. Resolve the owning repo so `git worktree remove`
    //    runs from a valid working tree; a broken/backup dir with no resolvable
    //    repo (rev-parse fails) falls back to a plain recursive removal.
    let removed = false;
    const rp = await gitFn(["rev-parse", "--path-format=absolute", "--git-common-dir"], target);
    if (rp.code === 0 && rp.stdout.trim().length > 0) {
      const commonDir = rp.stdout.trim();
      const repoRoot = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
      const rm = await gitFn(["worktree", "remove", "--force", target], repoRoot);
      removed = rm.code === 0;
    }
    if (!removed) rmRecursiveFn(target);

    // rmdir the now-empty per-repo discriminator parent (mirrors cleanupWorktree,
    // worktree.ts:293-300) — never the root, and only when empty.
    const parent = dirname(target);
    if (resolve(parent) !== root) {
      try {
        rmdirFn(parent);
      } catch {
        /* non-empty (live sibling / .old-* backup) or already gone — fine */
      }
    }

    print(`pruned: ${target}\n`);
    return 0;
  } finally {
    lock.release();
  }
}

/** Single AbortController-timed /health fetch → currentTickets, or [] when
 * health is disabled/unreachable (daemon-down fallback to the processing/ scan). */
async function fetchCurrentTickets(cfg: Config, fetchFn: typeof fetch): Promise<string[]> {
  if (!cfg.healthEnabled) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) return [];
    const j = (await resp.json()) as { metrics?: { currentTickets?: string[] } };
    return j.metrics?.currentTickets ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
