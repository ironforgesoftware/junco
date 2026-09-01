import { useState, useEffect } from "react";
import type { DashboardClient, HealthInfo } from "../ghClient.js";
import { keepIfEqualBy, wholeMinutes } from "./keepIfEqual.js";

/** Equality key: the header renders uptime in whole minutes (Chrome's fmtUp),
 * so a poll that only advanced the seconds must not repaint. */
const healthKey = (h: HealthInfo | null): unknown =>
  h === null ? null : { ...h, uptimeSeconds: wholeMinutes(h.uptimeSeconds) };

export function useHealth(client: DashboardClient, pollMs: number): HealthInfo | null {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const h = await client.health();
      if (alive) setHealth((prev) => keepIfEqualBy(prev, h, healthKey));
    };
    void run();
    const id = setInterval(() => void run(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, pollMs]);
  return health;
}
