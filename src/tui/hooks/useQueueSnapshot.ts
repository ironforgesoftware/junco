import { useState, useEffect } from "react";
import type { QueueSnapshot } from "../queueSnapshot.js";
import { keepIfEqual } from "./keepIfEqual.js";

export function useQueueSnapshot(
  queueFn: () => Promise<QueueSnapshot>,
  pollMs: number,
): { queueSnap: QueueSnapshot | null } {
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot | null>(null);

  // Queue polling (also fires once on mount). An unchanged snapshot keeps the
  // previous reference so React bails out — the age clock is useClock's job.
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const s = await queueFn();
      if (!alive) return;
      setQueueSnap((prev) => keepIfEqual(prev, s));
    };
    void run();
    const id = setInterval(() => void run(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [queueFn, pollMs]);

  return { queueSnap };
}
