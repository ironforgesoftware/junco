/**
 * Dynamic repo watchlist — shared by the dashboard (writes) and the bridge
 * sweep (reads via resolveWatchedRepos EVERY sweep → hot reload, no daemon
 * restart). Stored as JSON under the state dir; atomic tmp+rename writes.
 * Config [[github.repos]] entries always win on nwo conflicts.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config, GithubRepoMapping } from "./types.js";
import { log } from "./logging.js";
import { dataTreePaths } from "./dataTree.js";

export interface WatchlistEntry {
  nwo: string;
  path: string;
  /** Fork-PR mode: shown in the dashboard, but NEVER polled by the bridge. */
  external?: boolean;
}

const NWO_RE = /^[\w.-]+\/[\w.-]+$/;

export function watchlistPath(cfg: Config): string {
  return dataTreePaths(cfg).watchlistFile;
}

/** Never throws: missing → empty; corrupt/invalid → empty + error message
 * (callers surface it; the corrupt file is never clobbered here). */
export function readWatchlist(file: string): { entries: WatchlistEntry[]; error: string | null } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { entries: [], error: null };
    return { entries: [], error: e instanceof Error ? e.message : String(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { entries: [], error: `watchlist is not valid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { entries: [], error: "watchlist is not a JSON array" };
  const entries: WatchlistEntry[] = [];
  let invalid = 0;
  for (const it of parsed) {
    const e = it as Record<string, unknown>;
    if (
      e !== null &&
      typeof e === "object" &&
      typeof e.nwo === "string" &&
      NWO_RE.test(e.nwo) &&
      typeof e.path === "string" &&
      e.path.trim() !== "" &&
      (!("external" in e) || typeof e.external === "boolean")
    ) {
      entries.push({
        nwo: e.nwo,
        path: e.path,
        ...(e.external === true ? { external: true } : {}),
      });
    } else {
      invalid++;
    }
  }
  return {
    entries,
    error: invalid > 0 ? `${invalid} invalid entr${invalid === 1 ? "y" : "ies"} ignored` : null,
  };
}

/** Atomic write: mkdir -p, sibling tmp, rename. */
export function writeWatchlist(file: string, entries: WatchlistEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/** Config repos ∪ watchlist entries, deduped by nwo (case-insensitive), config
 * wins. Watchlist trouble degrades to config-only with a warn. `includeExternal`
 * decides whether fork-PR (external:true) entries survive — see the two exported
 * wrappers for the security reasoning behind each choice. */
function resolveWatched(cfg: Config, includeExternal: boolean): GithubRepoMapping[] {
  const out: GithubRepoMapping[] = [...cfg.github.repos];
  const seen = new Set(out.map((r) => r.nwo.toLowerCase()));
  const { entries, error } = readWatchlist(watchlistPath(cfg));
  if (error) {
    log.warn("github watchlist unreadable; using config repos only", { error });
  }
  for (const e of entries) {
    if (e.external === true && !includeExternal) continue;
    if (seen.has(e.nwo.toLowerCase())) continue;
    seen.add(e.nwo.toLowerCase());
    out.push({ nwo: e.nwo, path: e.path });
  }
  return out;
}

/** Bridge-POLL repo set: fork-PR (external:true) entries EXCLUDED. The bridge
 * must never poll them — an upstream maintainer (write access by definition)
 * with their own trigger label would pass verifyLabelApplier and inject
 * tickets. This exclusion is a polling-security rule; do not weaken it. */
export function resolveWatchedRepos(cfg: Config): GithubRepoMapping[] {
  return resolveWatched(cfg, false);
}

/** PR-LISTING repo set: fork-PR (external:true) entries INCLUDED. Listing
 * junco-authored PRs is read-only, so the poll-injection risk above does not
 * apply; fork-mode draft PRs — whose entire human checkpoint is that draft —
 * must appear in `junco prs` exactly as they do in the dashboard (#131). */
export function resolveWatchedReposForPrs(cfg: Config): GithubRepoMapping[] {
  return resolveWatched(cfg, true);
}
