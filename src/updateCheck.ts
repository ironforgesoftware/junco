/**
 * Best-effort npm update check (spec 2026-07-16). CLI/TUI-side only — the
 * daemon never checks and never restarts itself. Never throws: no network
 * (or a garbage registry response) degrades to "no badge".
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types.js";
import { UPDATE_CHECK_FILENAME } from "./dataTree.js";

export interface SelfPackage {
  name: string;
  version: string;
  /** Dir containing our own package.json: repo root in dev, package root installed. */
  rootDir: string;
}

/** `../package.json` relative to this module — resolves from both src/ (vitest) and dist/ (installed CLI). */
export function getSelfPackage(): SelfPackage {
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  return { name: pkg.name, version: pkg.version, rootDir };
}

/**
 * Strict X.Y.Z compare (leading `v` tolerated). Junco publishes plain semver
 * to the `latest` dist-tag; anything else → null, which every caller treats
 * as "no update available" — never a badge on garbage.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export interface UpdateInfo {
  current: string; // running version
  latest: string; // newest known on the registry (possibly cache-served)
  available: boolean; // compareVersions(latest, current) === 1
}

/** All fields optional: a first-ever failed check writes just lastAttempt. */
interface UpdateCache {
  latest?: string;
  checkedAt?: string;
  lastAttempt?: string;
}

export interface UpdateCheckOpts {
  forceFresh?: boolean; // junco update: skip fresh-window AND failure backoff
  fetchFn?: typeof fetch;
  readFileFn?: (p: string) => string; // throws when absent (fs semantics)
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (from: string, to: string) => void;
  nowFn?: () => Date;
  selfPkgFn?: () => SelfPackage;
}

export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RETRY_BACKOFF_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;

/**
 * Best-effort check. Cache stores only { latest, checkedAt, lastAttempt } —
 * `available` is recomputed against the RUNNING version every call, so the
 * badge clears the instant the operator actually updates. Never throws; every
 * failure path degrades to the stale cache or null.
 */
export async function checkForUpdate(
  cfg: Config,
  opts: UpdateCheckOpts = {},
): Promise<UpdateInfo | null> {
  if (cfg.updateCheck === false) return null;
  const self = (opts.selfPkgFn ?? getSelfPackage)();
  const now = (opts.nowFn ?? (() => new Date()))();
  const readFileFn = opts.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFileFn = opts.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const renameFn = opts.renameFn ?? renameSync;
  const cachePath = join(cfg.dataDir, UPDATE_CHECK_FILENAME);

  let cache: UpdateCache = {};
  try {
    cache = JSON.parse(readFileFn(cachePath)) as UpdateCache;
  } catch {
    cache = {}; // absent or corrupt — same thing
  }

  // NaN (garbage timestamp) compares false against every window → "infinitely old".
  const ageMs = (isoStamp?: string): number =>
    isoStamp === undefined ? Infinity : now.getTime() - Date.parse(isoStamp);
  const fromCache = (): UpdateInfo | null =>
    cache.latest !== undefined
      ? {
          current: self.version,
          latest: cache.latest,
          available: compareVersions(cache.latest, self.version) === 1,
        }
      : null;
  const writeCache = (c: UpdateCache): void => {
    // Atomic tmp+rename in the same dir; a read-only/missing dataDir just
    // means no cache — the check stays best-effort.
    try {
      writeFileFn(cachePath + ".tmp", JSON.stringify(c) + "\n");
      renameFn(cachePath + ".tmp", cachePath);
    } catch {
      /* best-effort */
    }
  };

  if (opts.forceFresh !== true) {
    if (ageMs(cache.checkedAt) < FRESH_WINDOW_MS) return fromCache();
    if (ageMs(cache.lastAttempt) < RETRY_BACKOFF_MS) return fromCache();
  }

  try {
    const fetchFn = opts.fetchFn ?? fetch;
    // Literal scoped name works on this route (cf. registry.npmjs.org/@types/node/latest).
    const resp = await fetchFn(`https://registry.npmjs.org/${self.name}/latest`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json()) as { version?: unknown };
    if (typeof body.version !== "string" || compareVersions(body.version, "0.0.0") === null) {
      throw new Error("unparseable registry response");
    }
    cache = { latest: body.version, checkedAt: now.toISOString() };
    writeCache(cache);
    return fromCache();
  } catch {
    writeCache({ ...cache, lastAttempt: now.toISOString() });
    return fromCache();
  }
}
