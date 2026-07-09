/**
 * Durable review queue for `junco assess` — one JSON file per audit batch under
 * <state_dir>/assess-review/ (atomic tmp+rename, watchlist/outbox pattern). The
 * audit (assessFlow.ts) PARKS findings here; a human-confirmed file step
 * (assessFiling.ts, via the CLI) files them. Never throws on read: missing →
 * empty, corrupt → skipped/`error`. Reviewed batches archive to filed/.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import type { Finding } from "./findings.js";
import { log } from "./logging.js";
import { slugifyId } from "./slug.js";

export interface PendingAssess {
  id: string; // = the assess ticket id (stable across requeue → re-run overwrites)
  nwo: string;
  external: boolean;
  autoPlan: boolean;
  repoPath: string;
  createdAt: string; // ISO
  findings: Finding[];
}

export interface AssessReviewDeps {
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (a: string, b: string) => void;
  mkdirFn?: (d: string) => void;
  readdirFn?: (d: string) => string[];
}

export function assessReviewPaths(cfg: Config): { dir: string; filed: string } {
  const dir = join(cfg.stateDir, "assess-review");
  return { dir, filed: join(dir, "filed") };
}

/**
 * Filename for a pending-assess batch id, confined to a single inert path
 * component (issue #32 class — see slug.ts). Applied at every read/write/
 * remove call site so the id can never escape <state_dir>/assess-review/.
 */
function pendingFileName(id: string): string {
  return `${slugifyId(id)}.json`;
}

export function writePending(
  cfg: Config,
  batch: PendingAssess,
  deps: AssessReviewDeps = {},
): string {
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const { dir } = assessReviewPaths(cfg);
  mkdirFn(dir);
  const dst = join(dir, pendingFileName(batch.id));
  const tmp = `${dst}.tmp`;
  writeFileFn(tmp, JSON.stringify(batch, null, 2) + "\n");
  renameFn(tmp, dst);
  return dst;
}

export function listPending(cfg: Config, deps: AssessReviewDeps = {}): PendingAssess[] {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const { dir } = assessReviewPaths(cfg);
  let names: string[];
  try {
    names = readdirFn(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .flatMap((n) => {
      try {
        return [JSON.parse(readFileFn(join(dir, n))) as PendingAssess];
      } catch (e) {
        log.warn("skipping unparseable pending assess batch", { name: n, error: String(e) });
        return [];
      }
    });
}

export function readPending(
  cfg: Config,
  id: string,
  deps: AssessReviewDeps = {},
): { batch: PendingAssess | null; error: string | null } {
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const { dir } = assessReviewPaths(cfg);
  let raw: string;
  try {
    raw = readFileFn(join(dir, pendingFileName(id)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { batch: null, error: null };
    return { batch: null, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    return { batch: JSON.parse(raw) as PendingAssess, error: null };
  } catch (e) {
    return { batch: null, error: `pending batch is not valid JSON: ${(e as Error).message}` };
  }
}

export function removePending(cfg: Config, id: string, deps: AssessReviewDeps = {}): void {
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const { dir, filed } = assessReviewPaths(cfg);
  mkdirFn(filed);
  renameFn(join(dir, pendingFileName(id)), join(filed, pendingFileName(id)));
}

export function pendingCount(cfg: Config, deps: AssessReviewDeps = {}): number {
  const readdirFn = deps.readdirFn ?? readdirSync;
  try {
    return readdirFn(assessReviewPaths(cfg).dir).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
