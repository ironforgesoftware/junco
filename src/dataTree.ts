/**
 * The single source of truth for the unified data tree's shape (spec
 * 2026-07-16 §4). Subdir constants are imported by the stores
 * (assessReview/commentReview/githubOutbox/watchlist/dashboard) so the tree
 * and its writers can never drift; ensureDataTree materializes everything
 * eagerly at daemon startup so no directory is invisible-until-first-use.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Paths } from "./types.js";
import { queuePaths } from "./config.js";

export const REVIEW_ASSESS_SUBDIR = "review/assess";
export const REVIEW_COMMENTS_SUBDIR = "review/comments";
export const OUTBOX_SUBDIR = "outbox";
export const MIRROR_SUBDIR = "mirror";
export const CLONES_WATCHED_SUBDIR = "clones/watched";
export const CLONES_EXTERNAL_SUBDIR = "clones/external";
export const WATCHLIST_FILENAME = "watchlist.json";

export interface DataTreePaths {
  root: string;
  queue: Paths; // from queuePaths(cfg)
  reviewAssess: string; // + "/filed" archive
  reviewComments: string; // + "/posted", "/discarded" archives
  outbox: string; // + "/dead"
  mirror: string;
  clonesWatched: string;
  clonesExternal: string; // NOTE: cfg.github.externalReposRoot (legacy-overridable)
  worktrees: string; // NOTE: cfg.worktreeRoot (legacy-overridable)
  transcripts: string;
  watchlistFile: string;
  spendFile: string;
  metricsFile: string; // PR 3 writes it; listed now
  logFile: string;
  migratedFile: string; // dataMigrate journal (Task 4)
}

export function dataTreePaths(cfg: Config): DataTreePaths {
  const r = cfg.dataDir;
  return {
    root: r,
    queue: queuePaths(cfg),
    reviewAssess: join(r, REVIEW_ASSESS_SUBDIR),
    reviewComments: join(r, REVIEW_COMMENTS_SUBDIR),
    outbox: join(r, OUTBOX_SUBDIR),
    mirror: join(r, MIRROR_SUBDIR),
    clonesWatched: join(r, CLONES_WATCHED_SUBDIR),
    clonesExternal: cfg.github.externalReposRoot,
    worktrees: cfg.worktreeRoot,
    transcripts: join(r, "transcripts"),
    watchlistFile: join(r, WATCHLIST_FILENAME),
    spendFile: join(r, "spend.json"),
    metricsFile: join(r, "metrics.json"),
    logFile: join(r, "worker.log"),
    migratedFile: join(r, "migrated.json"),
  };
}

export interface EnsureDataTreeDeps {
  mkdirFn?: (d: string) => void;
  existsFn?: (p: string) => boolean;
  writeFn?: (p: string, s: string) => void;
}

/**
 * Materializes the tree eagerly (daemon startup) so no directory is
 * invisible-until-first-use, and drops a self-gitignoring `*` at the root
 * (respecting an operator-customized file: only written when absent).
 *
 * Does NOT mkdir `clonesExternal`/`worktrees` — externalRepo.ts/worktree.ts
 * create those on demand, and they may be legacy-overridden outside the
 * root. When `legacy.vaultRoot` is set, the queue dirs created are the
 * legacy ones via `queuePaths` — exactly what the daemon needs, without a
 * phantom default queue under dataDir.
 */
export function ensureDataTree(cfg: Config, deps: EnsureDataTreeDeps = {}): void {
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const existsFn = deps.existsFn ?? existsSync;
  const writeFn = deps.writeFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const p = dataTreePaths(cfg);
  const dirs = [
    p.queue.inbox,
    p.queue.processing,
    p.queue.done,
    p.queue.failed,
    join(p.reviewAssess, "filed"),
    join(p.reviewComments, "posted"),
    join(p.reviewComments, "discarded"),
    join(p.outbox, "dead"),
    p.mirror,
    p.clonesWatched,
    p.transcripts,
  ];
  for (const d of dirs) mkdirFn(d);
  const gi = join(p.root, ".gitignore");
  if (!existsFn(gi)) writeFn(gi, "*\n"); // self-ignoring root; an operator-customized file is respected
}
