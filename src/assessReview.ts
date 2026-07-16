/**
 * Durable review queue for `junco assess` — one JSON file per audit batch under
 * <dataDir>/review/assess/ (atomic tmp+rename, watchlist/outbox pattern). The
 * audit (assessFlow.ts) PARKS findings here; a human-confirmed file step
 * (assessFiling.ts, via the CLI) files them. Never throws on read: missing →
 * empty, corrupt → skipped/`error`. Reviewed batches archive to filed/.
 *
 * Public API unchanged; storage generalized into reviewStore.ts so a second
 * review kind (pending comment drafts, SP-2) can reuse the same pattern.
 */
import { makeReviewStore, type ReviewStoreDeps } from "./reviewStore.js";
import { REVIEW_ASSESS_SUBDIR } from "./dataTree.js";
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
  issue?: number; // scoping issue (junco assess owner/repo#N) — filed findings reference it
}

export type AssessReviewDeps = ReviewStoreDeps;

// `issue` is the one optional PendingAssess field (scoping context, not
// always present) — every other field is required for a batch to be usable
// downstream (e.g. runAssessReviewCommand's `batch.findings.length`).
const store = makeReviewStore<PendingAssess>(REVIEW_ASSESS_SUBDIR, [
  "id",
  "nwo",
  "external",
  "autoPlan",
  "repoPath",
  "createdAt",
  "findings",
]);

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

/** true → archived; false → the batch was already archived/gone (ENOENT-safe:
 * archiving an id twice is a no-op, not a throw). */
export function removePending(cfg: Config, id: string, deps: AssessReviewDeps = {}): boolean {
  return store.remove(cfg, id, "filed", deps);
}

export function pendingCount(cfg: Config, deps: AssessReviewDeps = {}): number {
  return store.count(cfg, deps);
}
