/** Pure presentation helpers shared by the Rail queue card and QueueView. */

import type { TicketGithub } from "../types.js";

const ID_MAX = 24;

/** `#46 exec` for bridged tickets (kind `pr` reads as `exec`), else the id. */
export function queueLabel(github: TicketGithub | null, id: string): string {
  if (github) return `#${github.issue} ${github.kind === "pr" ? "exec" : github.kind}`;
  return id.length > ID_MAX ? id.slice(0, ID_MAX - 1) + "…" : id;
}

export function fmtElapsed(startedAt: string | null, now: Date): string | null {
  if (!startedAt) return null;
  const ms = now.getTime() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export function fmtAge(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTokens(n: number | null): string | null {
  if (n === null) return null;
  return n < 1000 ? `${n} tok` : `${(n / 1000).toFixed(1)}k tok`;
}

/** Local wall-clock HH:MM (not_before display). */
export function fmtClock(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

/** `turn 14 · bash · 12.3k tok · 4m32s` — null segments omitted. */
export function progressLine(
  r: {
    turns: number | null;
    lastTool: string | null;
    outputTokens: number | null;
    startedAt: string | null;
    stale: boolean;
  },
  now: Date,
): string {
  if (r.stale) return "processing (daemon down)";
  const parts = [
    r.turns !== null ? `turn ${r.turns}` : null,
    r.lastTool,
    fmtTokens(r.outputTokens),
    fmtElapsed(r.startedAt, now),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : "starting…";
}
