import { isDeepStrictEqual } from "node:util";

/** Return `prev` when `next` is structurally identical, else `next`. Used as
 * `setX((prev) => keepIfEqual(prev, next))` at every poll sink: an updater
 * that returns the previous reference lets React bail out (Object.is), so an
 * unchanged poll produces no commit — and therefore no Ink frame (spec
 * 2026-09-01-ink-render-perf-design.md, tier 1). Strict deep equality on
 * plain data; anything non-plain (functions, class instances) compares by
 * reference and simply falls through to today's behavior (a frame). */
export function keepIfEqual<T>(prev: T, next: T): T {
  return isDeepStrictEqual(prev, next) ? prev : next;
}

/** `keepIfEqual` through a projection: compare `key(prev)` to `key(next)` so
 * a sink can ignore fields it renders at a coarser granularity than they
 * change (uptime seconds rendered as minutes) while still STORING the raw
 * value. */
export function keepIfEqualBy<T>(prev: T, next: T, key: (v: T) => unknown): T {
  return isDeepStrictEqual(key(prev), key(next)) ? prev : next;
}

/** Whole minutes for equality keys — the granularity `fmtUp` (Chrome) and
 * `fmtDur` (sections) render uptime at. */
export function wholeMinutes(seconds: number | null): number | null {
  return seconds === null ? null : Math.floor(seconds / 60);
}
