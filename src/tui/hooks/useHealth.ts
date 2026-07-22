import { useState, useEffect } from "react";
import type { DashboardClient, HealthInfo } from "../ghClient.js";

export function useHealth(client: DashboardClient, pollMs: number): HealthInfo | null {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const h = await client.health();
      if (alive) setHealth(h);
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
