/**
 * Health-body fetch, split out of localSnapshot.ts into its own leaf module.
 * queueSnapshot.ts needs `HealthBody`/`fetchHealthBody`, but localSnapshot.ts
 * imports makeQueueSnapshotFn FROM queueSnapshot.ts — leaving this here would
 * make a future runtime import back from queueSnapshot.ts a cycle. Living in
 * its own leaf module lets both sides import it without one importing the
 * other.
 */

import type { Config } from "../types.js";
import type { MetricsSnapshot } from "../metrics.js";
import type { GateStatus } from "../providerGate.js";
import type { SpendStatus } from "../healthServer.js";
import type { ChatHealth } from "../chat/chatManager.js";
import { HEALTH_TIMEOUT_MS } from "../config.js";

export interface HealthBody {
  status: string;
  ready: boolean;
  metrics: MetricsSnapshot;
  /** Provider gate (Task 9/10) — always present on a current daemon
   * (possibly `null` when no gate is wired); the key is absent entirely on an
   * older daemon build. Optional here so both shapes typecheck. */
  gate?: GateStatus | null;
  /** Per-day spend (Phase-3 Task 6) — always present on a current daemon
   * (possibly `null` when no spendStatus is wired); the key is absent
   * entirely on an older daemon build. Optional here so both shapes
   * typecheck. */
  spend?: SpendStatus | null;
  /** Dashboard chat (spec 2026-09-01) — absent entirely on an older daemon. */
  chats?: ChatHealth | null;
}

/** Single AbortController-timed GET /health — the ONE owner of the probe's
 * timeout/abort and the `healthEnabled` gate; `makeQueueSnapshotFn`
 * (queueSnapshot.ts) self-fetches through here rather than repeating it.
 * null when health is disabled, the response is not ok, or the fetch errors —
 * the daemon-down signal the callers thread everywhere. */
export async function fetchHealthBody(
  cfg: Config,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<HealthBody | null> {
  if (!cfg.healthEnabled) return null;
  const fetchFn = deps.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as HealthBody;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
