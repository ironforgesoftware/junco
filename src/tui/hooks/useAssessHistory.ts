import { useState, useEffect, useRef } from "react";
import { isDeepStrictEqual } from "node:util";
import type { AssessHistory } from "../../assessHistory.js";

// Assess-history polling (also fires once on mount). Slower than the queue
// cadence: a record only changes when an assess run finalizes (#193). The
// Map is rebuilt only when the fetched rows differ from the last adopted
// rows, so an unchanged poll never commits (spec 2026-09-01-ink-render-perf).
export function useAssessHistory(
  fn: () => Promise<AssessHistory[]>,
  pollMs: number,
): Map<string, AssessHistory> {
  const [assessHistory, setAssessHistory] = useState<Map<string, AssessHistory>>(new Map());
  const lastRows = useRef<AssessHistory[] | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const rows = await fn();
      if (!alive) return;
      if (lastRows.current !== null && isDeepStrictEqual(lastRows.current, rows)) return;
      lastRows.current = rows;
      setAssessHistory(new Map(rows.map((h) => [h.id, h])));
    };
    void run();
    const id = setInterval(() => void run(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fn, pollMs]);
  return assessHistory;
}
