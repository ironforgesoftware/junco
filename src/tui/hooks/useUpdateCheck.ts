import { useState, useEffect } from "react";
import type { UpdateInfo } from "../../updateCheck.js";

// Update-check polling: fires once on mount (never blocks first paint —
// async post-mount) and every 24h thereafter. Absent fn (tests, or a config
// with updateCheck disabled upstream) → chip/help line stay off.
export function useUpdateCheck(fn?: () => Promise<UpdateInfo | null>): string | null {
  const [updateLatest, setUpdateLatest] = useState<string | null>(null);
  useEffect(() => {
    if (!fn) return;
    let cancelled = false;
    const tick = (): void => {
      void fn()
        .then((info) => {
          if (!cancelled) setUpdateLatest(info !== null && info.available ? info.latest : null);
        })
        .catch(() => {}); // checkForUpdate never throws; belt for injected fakes
    };
    tick();
    const t = setInterval(tick, 24 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [fn]);
  return updateLatest;
}
