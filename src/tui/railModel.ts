/**
 * Pure row model for the unified rail: every repo junco knows about (watched
 * github repos + discovered local checkouts) followed by the five pinned
 * system rows. Selection is KEY-anchored (rowKey), never a bare index — the
 * heavy poll can discover a clone mid-session and shift positions.
 * Spec: docs/superpowers/specs/2026-07-20-tui-unified-view-design.md §1.
 */

import { resolve } from "node:path";
import type { LocalRepo } from "./localSnapshot.js";

export type SystemSection = "queue" | "outbox" | "worktrees" | "daemon" | "logs";
export const SYSTEM_SECTIONS: readonly SystemSection[] = [
  "queue",
  "outbox",
  "worktrees",
  "daemon",
  "logs",
];

export interface WatchedMapping {
  nwo: string;
  path: string;
  fromConfig: boolean;
  external: boolean;
}

export interface UnifiedRepo {
  /** Stable selection key: nwo.toLowerCase() for watched rows, resolved path
   * for discovered rows (paths can never collide with an owner/name). */
  key: string;
  nwo: string | null;
  path: string;
  fromConfig: boolean;
  external: boolean;
  source: "config" | "watchlist" | "external" | "clone";
  /** In config ∪ watchlist — the rows the github bridge/polls act on. */
  watched: boolean;
  /** Heavy-poll git enrichment; null until the first heavy tick delivers. */
  git: {
    branch: string | null;
    headSha: string | null;
    dirty: boolean | null;
    originUrl: string | null;
    error: string | null;
  } | null;
  /** Extra local checkouts of the same nwo, collapsed into this row. */
  clones: string[];
}

export type RailRow =
  | { kind: "repo"; repo: UnifiedRepo }
  | { kind: "system"; section: SystemSection };

export type BodyKind =
  | { kind: "issues"; nwo: string }
  | { kind: "repoDetail"; repo: UnifiedRepo }
  | { kind: "section"; section: SystemSection };

export const sysKey = (s: SystemSection): string => `sys:${s}`;
export const rowKey = (row: RailRow): string =>
  row.kind === "system" ? sysKey(row.section) : row.repo.key;

const gitOf = (r: LocalRepo): NonNullable<UnifiedRepo["git"]> => ({
  branch: r.branch,
  headSha: r.headSha,
  dirty: r.dirty,
  originUrl: r.originUrl,
  error: r.error,
});

/** Watched mappings first (their input order — config then watchlist), each
 * enriched from the heavy candidate matched by resolved path, then by nwo;
 * same-nwo extras collapse into `clones`. Unclaimed heavy candidates append
 * as unwatched rows in their input order. */
export function buildUnifiedRepos(
  watched: WatchedMapping[],
  heavy: LocalRepo[] | null,
): UnifiedRepo[] {
  const candidates = heavy ?? [];
  const byPath = new Map<string, LocalRepo>();
  const byNwo = new Map<string, LocalRepo[]>();
  for (const r of candidates) {
    byPath.set(resolve(r.path), r);
    if (r.nwo !== null) {
      const k = r.nwo.toLowerCase();
      byNwo.set(k, [...(byNwo.get(k) ?? []), r]);
    }
  }
  const claimed = new Set<string>();
  const out: UnifiedRepo[] = [];
  for (const w of watched) {
    const key = w.nwo.toLowerCase();
    const wPath = resolve(w.path);
    const matches: LocalRepo[] = [];
    const seen = new Set<string>();
    for (const m of [byPath.get(wPath), ...(byNwo.get(key) ?? [])]) {
      if (m === undefined) continue;
      const p = resolve(m.path);
      if (seen.has(p)) continue;
      seen.add(p);
      claimed.add(p);
      matches.push(m);
    }
    const primary = matches.find((m) => resolve(m.path) === wPath) ?? matches[0];
    out.push({
      key,
      nwo: w.nwo,
      path: w.path,
      fromConfig: w.fromConfig,
      external: w.external,
      source: w.fromConfig ? "config" : "watchlist",
      watched: true,
      git: primary !== undefined ? gitOf(primary) : null,
      clones: matches.filter((m) => m !== primary).map((m) => m.path),
    });
  }
  for (const r of candidates) {
    const p = resolve(r.path);
    if (claimed.has(p)) continue;
    claimed.add(p);
    out.push({
      key: p,
      nwo: r.nwo,
      path: r.path,
      fromConfig: false,
      external: false,
      source: r.source,
      watched: false,
      git: gitOf(r),
      clones: [],
    });
  }
  return out;
}

export function buildRailRows(repos: UnifiedRepo[]): RailRow[] {
  return [
    ...repos.map((repo): RailRow => ({ kind: "repo", repo })),
    ...SYSTEM_SECTIONS.map((section): RailRow => ({ kind: "system", section })),
  ];
}

/** Key-anchored index resolution with the clamp-to-last-slot fallback
 * (the established lastIdxRef pattern from App's issue/PR anchors). */
export function resolveRailIndex(rows: RailRow[], sel: string | null, lastIdx: number): number {
  if (rows.length === 0) return 0;
  if (sel !== null) {
    const i = rows.findIndex((r) => rowKey(r) === sel);
    if (i >= 0) return i;
  }
  return Math.max(0, Math.min(lastIdx, rows.length - 1));
}

/** Body routing (spec §3): issues only for WATCHED nwo rows with github
 * enabled; every other repo row gets the RepoDetail body. */
export function bodyKindFor(row: RailRow | undefined, githubEnabled: boolean): BodyKind | null {
  if (row === undefined) return null;
  if (row.kind === "system") return { kind: "section", section: row.section };
  if (row.repo.watched && row.repo.nwo !== null && githubEnabled) {
    return { kind: "issues", nwo: row.repo.nwo };
  }
  return { kind: "repoDetail", repo: row.repo };
}
