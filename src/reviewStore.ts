/**
 * Generic durable review-queue factory — the storage layer lifted out of
 * assessReview.ts (see that file's history) so a second review kind (pending
 * comment drafts, SP-2) can reuse the same durable-queue pattern: one JSON
 * file per entry under <state_dir>/<subdir>/ (atomic tmp+rename,
 * watchlist/outbox pattern). Never throws on read: missing → empty/null,
 * corrupt → skipped (list) / `error` (read). Removed entries archive into a
 * caller-named subdirectory (e.g. "filed", "posted").
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
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
  dir(cfg: Config): string;
  archiveDir(cfg: Config, sub: string): string;
  write(cfg: Config, entry: T, deps?: ReviewStoreDeps): string;
  list(cfg: Config, deps?: ReviewStoreDeps): T[];
  read(cfg: Config, id: string, deps?: ReviewStoreDeps): { entry: T | null; error: string | null };
  remove(cfg: Config, id: string, archiveSub: string, deps?: ReviewStoreDeps): void;
  count(cfg: Config, deps?: ReviewStoreDeps): number;
}

/**
 * Filename for an entry id, confined to a single inert path component
 * (issue #32 class — see slug.ts). Applied at every read/write/remove call
 * site so the id can never escape <state_dir>/<subdir>/.
 */
function entryFileName(id: string): string {
  return `${slugifyId(id)}.json`;
}

export function makeReviewStore<T extends { id: string }>(subdir: string): ReviewStore<T> {
  function dir(cfg: Config): string {
    return join(cfg.stateDir, subdir);
  }

  function archiveDir(cfg: Config, sub: string): string {
    return join(dir(cfg), sub);
  }

  function write(cfg: Config, entry: T, deps: ReviewStoreDeps = {}): string {
    const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
    const renameFn = deps.renameFn ?? renameSync;
    const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
    const d = dir(cfg);
    mkdirFn(d);
    const dst = join(d, entryFileName(entry.id));
    const tmp = `${dst}.tmp`;
    writeFileFn(tmp, JSON.stringify(entry, null, 2) + "\n");
    renameFn(tmp, dst);
    return dst;
  }

  function list(cfg: Config, deps: ReviewStoreDeps = {}): T[] {
    const readdirFn = deps.readdirFn ?? readdirSync;
    const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
    const d = dir(cfg);
    let names: string[];
    try {
      names = readdirFn(d);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .sort()
      .flatMap((n) => {
        try {
          return [JSON.parse(readFileFn(join(d, n))) as T];
        } catch (e) {
          log.warn("skipping unparseable review-store entry", {
            subdir,
            name: n,
            error: String(e),
          });
          return [];
        }
      });
  }

  function read(
    cfg: Config,
    id: string,
    deps: ReviewStoreDeps = {},
  ): { entry: T | null; error: string | null } {
    const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
    const d = dir(cfg);
    let raw: string;
    try {
      raw = readFileFn(join(d, entryFileName(id)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { entry: null, error: null };
      return { entry: null, error: e instanceof Error ? e.message : String(e) };
    }
    try {
      return { entry: JSON.parse(raw) as T, error: null };
    } catch (e) {
      return { entry: null, error: `stored entry is not valid JSON: ${(e as Error).message}` };
    }
  }

  function remove(cfg: Config, id: string, archiveSub: string, deps: ReviewStoreDeps = {}): void {
    const renameFn = deps.renameFn ?? renameSync;
    const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
    const d = dir(cfg);
    const archive = archiveDir(cfg, archiveSub);
    mkdirFn(archive);
    renameFn(join(d, entryFileName(id)), join(archive, entryFileName(id)));
  }

  function count(cfg: Config, deps: ReviewStoreDeps = {}): number {
    const readdirFn = deps.readdirFn ?? readdirSync;
    try {
      return readdirFn(dir(cfg)).filter((n) => n.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  return { dir, archiveDir, write, list, read, remove, count };
}
