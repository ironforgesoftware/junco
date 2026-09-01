import { useState, useEffect } from "react";

/** The dashboard's age clock: the `now` every "Ns ago" / elapsed string is
 * computed against. A standalone tick (default 5 s in App) instead of a bump
 * on every queue poll, so a poll that delivered unchanged data commits
 * nothing (spec 2026-09-01-ink-render-perf-design.md). Consumers render ages
 * at minute granularity except the sub-minute "Ns ago" form, where a 5 s step
 * is the accepted trade-off. */
export function useClock(intervalMs: number): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}
