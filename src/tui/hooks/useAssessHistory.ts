import { useState, useEffect } from "react";
import type { AssessHistory } from "../../assessHistory.js";

// Assess-history polling (also fires once on mount). Slower than the queue
// cadence: a record only changes when an assess run finalizes (#193).
export function useAssessHistory(
  fn: () => Promise<AssessHistory[]>,
  pollMs: number,
): Map<string, AssessHistory> {
  const [assessHistory, setAssessHistory] = useState<Map<string, AssessHistory>>(new Map());
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const rows = await fn();
      if (!alive) return;
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
