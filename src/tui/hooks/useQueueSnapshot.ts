import { useState, useEffect } from "react";
import type { QueueSnapshot } from "../queueSnapshot.js";

export function useQueueSnapshot(
  queueFn: () => Promise<QueueSnapshot>,
  pollMs: number,
): { queueSnap: QueueSnapshot | null; queueNow: Date } {
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot | null>(null);
  const [queueNow, setQueueNow] = useState<Date>(() => new Date());

  // Queue polling (also fires once on mount).
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const s = await queueFn();
      if (!alive) return;
      setQueueSnap(s);
      setQueueNow(new Date());
    };
    void run();
    const id = setInterval(() => void run(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [queueFn, pollMs]);

  return { queueSnap, queueNow };
}
