/** Pure filtering helpers over LogEntry[] for the TUI log view. No I/O. */

import type { LogEntry } from "../logReader.js";

export type Level = "debug" | "info" | "warn" | "error";
export const LEVEL_ORDER: Level[] = ["debug", "info", "warn", "error"];

/** Rank for the level threshold; a null (unstructured) line ranks as info so it
 * survives info but hides at warn+. */
export function levelRank(l: LogEntry["level"]): number {
  return l === null ? 1 : LEVEL_ORDER.indexOf(l);
}

export function cycleLevel(l: Level): Level {
  return LEVEL_ORDER[(LEVEL_ORDER.indexOf(l) + 1) % LEVEL_ORDER.length];
}

export interface LogFilters {
  minLevel: Level;
  ticket: string | null;
  search: string;
}

export function filterEntries(entries: LogEntry[], f: LogFilters): LogEntry[] {
  const min = levelRank(f.minLevel);
  const needle = f.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (levelRank(e.level) < min) return false;
    if (f.ticket !== null && e.ticket !== f.ticket) return false;
    if (needle !== "") {
      const hay = `${e.msg} ${e.ticket ?? ""} ${JSON.stringify(e.fields)}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export function distinctTickets(entries: LogEntry[]): string[] {
  const s = new Set<string>();
  for (const e of entries) if (e.ticket !== null) s.add(e.ticket);
  return [...s].sort();
}
