/**
 * Durable review queue for `junco assess` — one JSON file per audit batch under
 * <state_dir>/assess-review/ (atomic tmp+rename, watchlist/outbox pattern). The
 * audit (assessFlow.ts) PARKS findings here; a human-confirmed file step
 * (assessFiling.ts, via the CLI) files them. Never throws on read: missing →
 * empty, corrupt → skipped/`error`. Reviewed batches archive to filed/.
 *
 * Public API unchanged; storage generalized into reviewStore.ts so a second
 * review kind (pending comment drafts, SP-2) can reuse the same pattern.
 */
import { makeReviewStore, type ReviewStoreDeps } from "./reviewStore.js";
import type { Config } from "./types.js";
import type { Finding } from "./findings.js";

export interface PendingAssess {
  id: string; // = the assess ticket id (stable across requeue → re-run overwrites)
  nwo: string;
  external: boolean;
  autoPlan: boolean;
  repoPath: string;
  createdAt: string; // ISO
  findings: Finding[];
}

export type AssessReviewDeps = ReviewStoreDeps;

const store = makeReviewStore<PendingAssess>("assess-review");

export function assessReviewPaths(cfg: Config): { dir: string; filed: string } {
  return { dir: store.dir(cfg), filed: store.archiveDir(cfg, "filed") };
}

export function writePending(
  cfg: Config,
  batch: PendingAssess,
  deps: AssessReviewDeps = {},
): string {
  return store.write(cfg, batch, deps);
}

export function listPending(cfg: Config, deps: AssessReviewDeps = {}): PendingAssess[] {
  return store.list(cfg, deps);
}

export function readPending(
  cfg: Config,
  id: string,
  deps: AssessReviewDeps = {},
): { batch: PendingAssess | null; error: string | null } {
  const { entry, error } = store.read(cfg, id, deps);
  return { batch: entry, error }; // preserve the existing {batch,error} shape
}

export function removePending(cfg: Config, id: string, deps: AssessReviewDeps = {}): void {
  store.remove(cfg, id, "filed", deps);
}

export function pendingCount(cfg: Config, deps: AssessReviewDeps = {}): number {
  return store.count(cfg, deps);
}
