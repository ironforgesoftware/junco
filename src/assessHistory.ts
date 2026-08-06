/**
 * Durable per-repo assess history — one JSON file per repo under
 * <dataDir>/assess-history/, keyed by nwo. assessFlow.ts writes one record
 * per TERMINAL whole-repo run; the rail, `junco status` and `junco doctor`
 * read it to answer "when was this last audited, and did it find anything?".
 * Issue #193.
 *
 * Third instantiation of reviewStore.ts. That factory is named for review
 * QUEUES and carries an archive-on-remove this store never calls; the reuse is
 * for its durable keyed-upsert core (atomic tmp+rename, never-throw reads,
 * slug+hash key confinement — #202). Keyed by nwo rather than a ticket id, so
 * `write` is an upsert: the newest terminal run for a repo replaces its record.
 *
 * ONE FILE PER REPO IS LOAD-BEARING. The daemon runs max_concurrent > 1, so a
 * single shared map file would lose updates across DIFFERENT repos finalizing
 * concurrently; per-repo files confine that risk to same-repo contention, and
 * the write is atomic tmp+rename (via reviewStore.ts), so a record is never
 * torn. Residual caveat: the scheduler serializes claims by repo PATH, not
 * nwo (runOnce.ts), so two distinct local checkouts of the same upstream nwo
 * can still interleave this file's read-modify-write — last-write-wins, and
 * the next clean assess of either checkout self-heals it.
 *
 * dataTreePaths(cfg).assessHistory is the only join of the "assess-history"
 * subdir onto the data root — every function below resolves it fresh per
 * call (reviewStore.ts takes the absolute dir at call time, not a subdir at
 * construction).
 */
import { createHash } from "node:crypto";
import { makeReviewStore, type ReviewStoreDeps } from "./reviewStore.js";
import { dataTreePaths } from "./dataTree.js";
import { slugifyId } from "./slug.js";
import type { Config } from "./types.js";

export interface AssessHistory {
  id: string; // = nwo ("owner/repo") — the store key
  lastSuccessAt: string | null; // ISO; null until a whole-repo run succeeds
  lastFound: number | null; // counts.found at that success
  lastParked: number | null; // counts.parked at that success
  lastFailureAt: string | null; // ISO; cleared by the next success
  lastFailureReason: string | null; // cleared by the next success
}

export type AssessHistoryDeps = ReviewStoreDeps;

/** #202: slugifyId is lossy — `o-a/b` and `o/a-b` both collapse to `o-a-b`, so
 * two distinct watched repos would otherwise share one history file (harmless
 * to filed findings, which key by ticket id, but a repo's rail/doctor/status
 * line would then show ANOTHER repo's audit age). Append an 8-hex sha256 of the
 * FULL nwo so distinct repos never alias; the slug prefix keeps the directory
 * eyeball-readable and the fixed suffix is uniquely splittable. */
function historyKey(nwo: string): string {
  return `${slugifyId(nwo)}-${createHash("sha256").update(nwo).digest("hex").slice(0, 8)}`;
}

// Only `id` is required: every other field is nullable BY DESIGN (a repo whose
// only run failed has no lastSuccessAt), so a truncated or hand-edited file
// still reads rather than being skipped wholesale.
const store = makeReviewStore<AssessHistory>(["id"], historyKey);

export function assessHistoryDir(cfg: Config): string {
  return dataTreePaths(cfg).assessHistory;
}

export function listHistory(cfg: Config, deps: AssessHistoryDeps = {}): AssessHistory[] {
  return store.list(dataTreePaths(cfg).assessHistory, deps);
}

export function readHistory(
  cfg: Config,
  nwo: string,
  deps: AssessHistoryDeps = {},
): AssessHistory | null {
  return store.read(dataTreePaths(cfg).assessHistory, nwo, deps).entry;
}

/** Record ONE terminal whole-repo assess run.
 *
 * Success stamps the success fields and CLEARS the failure fields; failure
 * stamps the failure fields and leaves the last success untouched. That
 * asymmetry is the whole point: the rail's age always tracks the last
 * SUCCESSFUL audit, so a crashed run can never mark a repo fresh, while a
 * repo whose audits keep failing stays visibly distinct from one nobody ran.
 */
export function recordRun(
  cfg: Config,
  nwo: string,
  run:
    | { ok: true; at: string; found: number; parked: number }
    | { ok: false; at: string; reason: string },
  deps: AssessHistoryDeps = {},
): void {
  const prev = readHistory(cfg, nwo, deps);
  const next: AssessHistory = run.ok
    ? {
        id: nwo,
        lastSuccessAt: run.at,
        lastFound: run.found,
        lastParked: run.parked,
        lastFailureAt: null,
        lastFailureReason: null,
      }
    : {
        id: nwo,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        lastFound: prev?.lastFound ?? null,
        lastParked: prev?.lastParked ?? null,
        lastFailureAt: run.at,
        lastFailureReason: run.reason,
      };
  store.write(dataTreePaths(cfg).assessHistory, next, deps);
}
