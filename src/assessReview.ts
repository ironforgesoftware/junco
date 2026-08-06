/**
 * Durable review queue for `junco assess` — one JSON file per audit batch under
 * <dataDir>/review/assess/ (atomic tmp+rename, watchlist/outbox pattern). The
 * audit (assessFlow.ts) PARKS findings here; a human-confirmed file step
 * (assessFiling.ts, via the CLI) files them. Never throws on read: missing →
 * empty, corrupt → skipped/`error`. Reviewed batches archive to filed/.
 *
 * Public API unchanged; storage generalized into reviewStore.ts so a second
 * review kind (pending comment drafts, SP-2) can reuse the same pattern.
 * dataTreePaths(cfg).reviewAssess is the only join of the "review/assess"
 * subdir onto the data root — every function below resolves it fresh per
 * call rather than baking it into a module-level store, since reviewStore.ts
 * now expects the absolute dir at call time, not a subdir at construction.
 */
import { makeReviewStore, type ReviewStoreDeps } from "./reviewStore.js";
import { dataTreePaths } from "./dataTree.js";
import type { Config } from "./types.js";
import type { Finding } from "./findings.js";

/** Per-finding filing accounting, stamped by assessFiling.ts at file time.
 * `deduped` = the marker scan found it already on GitHub during a pass. */
export interface FiledRecord {
  at: string; // ISO, the filing pass's timestamp
  how: "created" | "queued" | "deduped";
  url?: string; // gh-printed issue URL (how: "created" only)
}

export interface PendingAssess {
  id: string; // = the assess ticket id (stable across requeue → re-run overwrites)
  nwo: string;
  external: boolean;
  autoPlan: boolean;
  repoPath: string;
  createdAt: string; // ISO
  findings: Finding[];
  issue?: number; // scoping issue (junco assess owner/repo#N) — filed findings reference it
  filed?: Record<string, FiledRecord>; // fingerprint → accounting; absent = nothing filed yet
}

export type AssessReviewDeps = ReviewStoreDeps;

// `issue` and `filed` are the two optional PendingAssess fields — every other
// field is required for a batch to be usable downstream (e.g.
// runAssessReviewCommand's `batch.findings.length`).
const store = makeReviewStore<PendingAssess>([
  "id",
  "nwo",
  "external",
  "autoPlan",
  "repoPath",
  "createdAt",
  "findings",
]);

export function assessReviewPaths(cfg: Config): { dir: string; filed: string } {
  const dir = dataTreePaths(cfg).reviewAssess;
  return { dir, filed: store.archiveDir(dir, "filed") };
}

export function writePending(
  cfg: Config,
  batch: PendingAssess,
  deps: AssessReviewDeps = {},
): string {
  return store.write(dataTreePaths(cfg).reviewAssess, batch, deps);
}

export function listPending(cfg: Config, deps: AssessReviewDeps = {}): PendingAssess[] {
  return store.list(dataTreePaths(cfg).reviewAssess, deps);
}

export function readPending(
  cfg: Config,
  id: string,
  deps: AssessReviewDeps = {},
): { batch: PendingAssess | null; error: string | null } {
  const { entry, error } = store.read(dataTreePaths(cfg).reviewAssess, id, deps);
  return { batch: entry, error }; // preserve the existing {batch,error} shape
}

/** Explicit end-of-life for a batch: archive to filed/. true → archived;
 * false → already archived/gone (ENOENT-safe: discarding twice is a no-op,
 * not a throw). Filing does NOT archive (assessFiling.ts stamps `filed`
 * records instead) — this is the only way a batch leaves the review list. */
export function discardPending(cfg: Config, id: string, deps: AssessReviewDeps = {}): boolean {
  return store.remove(dataTreePaths(cfg).reviewAssess, id, "filed", deps);
}

export function pendingCount(cfg: Config, deps: AssessReviewDeps = {}): number {
  return store.count(dataTreePaths(cfg).reviewAssess, deps);
}

/** Upgrade a `queued` filed record once the outbox flush learns the op's real
 * outcome (issue created, or marker-deduped). ONLY `queued` records upgrade —
 * `created` provenance (URL included) is never overwritten (#232). Scans every
 * parked batch for the nwo: the same fingerprint can be parked in more than
 * one batch (assess re-runs park under the same ticket id, but a manual
 * re-assess under a new id would not). */
export function upgradeQueuedFiledRecord(
  cfg: Config,
  nwo: string,
  fingerprint: string,
  rec: FiledRecord,
  deps: AssessReviewDeps = {},
): void {
  for (const batch of listPending(cfg, deps)) {
    if (batch.nwo !== nwo) continue;
    const cur = batch.filed?.[fingerprint];
    if (cur === undefined || cur.how !== "queued") continue;
    writePending(cfg, { ...batch, filed: { ...batch.filed, [fingerprint]: rec } }, deps);
  }
}
