/**
 * Generic durable review-queue factory — the storage layer lifted out of
 * assessReview.ts (see that file's history) so a second review kind (pending
 * comment drafts, SP-2) can reuse the same durable-queue pattern: one JSON
 * file per entry under a caller-supplied absolute dir (atomic tmp+rename,
 * watchlist/outbox pattern). Never throws on read: missing → empty/null,
 * corrupt or shape-invalid (missing required fields — see requiredFields
 * below) → skipped (list) / `error` (read). Removed entries archive into a
 * caller-named subdirectory (e.g. "filed", "posted"); archiving an id that's
 * already gone is a no-op (`remove` returns false), never a raw ENOENT throw.
 *
 * Every method takes the entry dir itself, not a `Config` — the three
 * concrete stores (assessReview.ts/commentReview.ts/assessHistory.ts) pass
 * `dataTreePaths(cfg).reviewAssess` / `.reviewComments` / `.assessHistory`
 * (dataTree.ts is the only place that joins those subdirs onto the data
 * root); this factory itself never reads `cfg.dataDir` or a data-tree subdir
 * constant.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logging.js";
import { slugifyId } from "./slug.js";

export interface ReviewStoreDeps {
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (a: string, b: string) => void;
  mkdirFn?: (d: string) => void;
  readdirFn?: (d: string) => string[];
}

export interface ReviewStore<T extends { id: string }> {
  archiveDir(dir: string, sub: string): string;
  write(dir: string, entry: T, deps?: ReviewStoreDeps): string;
  list(dir: string, deps?: ReviewStoreDeps): T[];
  read(dir: string, id: string, deps?: ReviewStoreDeps): { entry: T | null; error: string | null };
  /** true → archived; false → nothing to archive (id already gone: ENOENT is
   * not an error here, matching the store's never-throw-on-read ethos). */
  remove(dir: string, id: string, archiveSub: string, deps?: ReviewStoreDeps): boolean;
  count(dir: string, deps?: ReviewStoreDeps): number;
}

/**
 * Field-presence check applied to parsed JSON before it is trusted as T: a
 * hand-tampered or truncated file (e.g. `{}`) parses cleanly but is missing
 * fields downstream code dereferences unconditionally (e.g. `batch.findings
 * .length`). Only presence is checked (not deep types) — cheap, generic
 * across every store built on top of this factory, and enough to turn a
 * silent `undefined` deref into a loud skip/error at the read boundary.
 */
function hasRequiredFields(v: unknown, requiredFields: readonly string[]): boolean {
  if (v === null || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  return requiredFields.every((k) => rec[k] !== undefined);
}

export function makeReviewStore<T extends { id: string }>(
  requiredFields: readonly string[] = ["id"],
  // #202: how an entry id maps to its on-disk key. Defaults to slugifyId (which
  // is LOSSY — `o-a/b` and `o/a-b` both slug to `o-a-b`); a store keyed by a
  // value that can collide under slugifyId (e.g. assessHistory's nwo) passes a
  // collision-free deriver here. Applied at every read/write/remove call site
  // so the id still can never escape the entry dir (issue #32 class).
  keyOf: (id: string) => string = slugifyId,
): ReviewStore<T> {
  const entryFileName = (id: string): string => `${keyOf(id)}.json`;

  function archiveDir(dir: string, sub: string): string {
    return join(dir, sub);
  }

  function write(dir: string, entry: T, deps: ReviewStoreDeps = {}): string {
    const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
    const renameFn = deps.renameFn ?? renameSync;
    const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
    mkdirFn(dir);
    const dst = join(dir, entryFileName(entry.id));
    const tmp = `${dst}.tmp`;
    writeFileFn(tmp, JSON.stringify(entry, null, 2) + "\n");
    renameFn(tmp, dst);
    return dst;
  }

  function list(dir: string, deps: ReviewStoreDeps = {}): T[] {
    const readdirFn = deps.readdirFn ?? readdirSync;
    const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileFn(join(dir, n)));
        } catch (e) {
          log.warn("skipping unparseable review-store entry", {
            dir,
            name: n,
            error: String(e),
          });
          return [];
        }
        if (!hasRequiredFields(parsed, requiredFields)) {
          log.warn("skipping malformed review-store entry (missing required fields)", {
            dir,
            name: n,
            requiredFields,
          });
          return [];
        }
        return [parsed as T];
      });
  }

  function read(
    dir: string,
    id: string,
    deps: ReviewStoreDeps = {},
  ): { entry: T | null; error: string | null } {
    const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
    let raw: string;
    try {
      raw = readFileFn(join(dir, entryFileName(id)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { entry: null, error: null };
      return { entry: null, error: e instanceof Error ? e.message : String(e) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { entry: null, error: `stored entry is not valid JSON: ${(e as Error).message}` };
    }
    if (!hasRequiredFields(parsed, requiredFields)) {
      return { entry: null, error: "stored entry is missing required fields" };
    }
    return { entry: parsed as T, error: null };
  }

  function remove(
    dir: string,
    id: string,
    archiveSub: string,
    deps: ReviewStoreDeps = {},
  ): boolean {
    const renameFn = deps.renameFn ?? renameSync;
    const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
    const archive = archiveDir(dir, archiveSub);
    mkdirFn(archive);
    try {
      renameFn(join(dir, entryFileName(id)), join(archive, entryFileName(id)));
      return true;
    } catch (e) {
      // Archiving an id that's already archived (or was never written) is not
      // an error — matches the store's never-throw-on-read ethos rather than
      // raising a raw ENOENT to callers that just want "is it gone now?".
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw e;
    }
  }

  function count(dir: string, deps: ReviewStoreDeps = {}): number {
    const readdirFn = deps.readdirFn ?? readdirSync;
    try {
      return readdirFn(dir).filter((n) => n.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  return { archiveDir, write, list, read, remove, count };
}
