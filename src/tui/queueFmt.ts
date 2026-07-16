/** Pure presentation helpers shared by the Rail queue card and QueueView. */

import type { TicketGithub } from "../types.js";
import type { AssessHistory } from "../assessHistory.js";

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

/** Compact sibling of fmtAge for width-starved columns: no " ago" suffix, and
 * days cap at "99d+" so the rail's fixed indicator slot cannot be blown out by
 * an ancient timestamp. */
export function fmtAgeShort(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  return d > 99 ? "99d+" : `${d}d`;
}

/** The rail's assess column: `2h 0✓` · `21d 4⚠` · `21d! 4⚠` · `—` · `— !`.
 *
 * The age tracks the last SUCCESSFUL audit; `!` means the most recent attempt
 * failed (issue #193). Every glyph is width-1 under string-width — `⚠` is bare
 * U+26A0; emitting the VS16 form (⚠️) would make it width-2 and break the
 * fixed column. */
export function fmtAssessIndicator(h: AssessHistory | null, now: Date): string {
  if (!h || (h.lastSuccessAt === null && h.lastFailureAt === null)) return "—";
  const failed = h.lastFailureAt !== null;
  if (h.lastSuccessAt === null) return "— !"; // failed, never succeeded
  const age = fmtAgeShort(h.lastSuccessAt, now) + (failed ? "!" : "");
  const n = h.lastFound ?? 0;
  const count = n === 0 ? "0✓" : `${n > 99 ? "99+" : n}⚠`;
  return `${age} ${count}`;
}

export function fmtTokens(n: number | null): string | null {
  if (n === null) return null;
  return n < 1000 ? `${n} tok` : `${(n / 1000).toFixed(1)}k tok`;
}

/** Compact magnitude: `740`, `1.2k`, `3.4M` — one decimal, trailing `.0`
 * stripped. Bucket is picked AFTER rounding: a value whose k-form would round
 * to "1000.0k" (≈999_950 and up) rolls into the M bucket instead. */
export function fmtCompact(n: number): string {
  if (n < 1000) return `${n}`;
  const useM = n >= 1_000_000 || Number((n / 1_000).toFixed(1)) >= 1000;
  const [divisor, suffix] = useM ? [1_000_000, "M"] : [1_000, "k"];
  const v = (n / divisor).toFixed(1).replace(/\.0$/, "");
  return `${v}${suffix}`;
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
