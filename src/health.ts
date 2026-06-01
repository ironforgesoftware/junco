/**
 * oMLX startup health-check — port of worker.py omlx_reachable +
 * wait_for_omlx (lines 616-647).
 *
 * On daemon startup junco blocks until the local oMLX inference server is
 * reachable, so the first ticket doesn't fail on a cold server.
 */

import type { Config } from "./types.js";
import { log } from "./logging.js";
import { resolveProbeBaseUrl } from "./agent/modelSetup.js";

/**
 * Minimal stop-flag interface consumed by waitForOmlx.  The real StopFlag
 * lands in M4-T4; a local copy is fine — any object with `requested: boolean`
 * satisfies it.
 */
export interface StopFlagLike {
  readonly requested: boolean;
}

// ---------------------------------------------------------------------------
// omlxReachable
// ---------------------------------------------------------------------------

export interface OmlxReachableDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Probe the oMLX /models endpoint.  Returns true when the server responds
 * with a 2xx status (resp.ok), false for any other outcome (non-ok, network
 * error, timeout).
 *
 * Probe URL: resolveProbeBaseUrl gives the /v1 API base (from a configured
 * models.json's provider entry, or the inline base_url), then re-append
 * /models — hitting the configured endpoint with Bearer auth.
 */
export async function omlxReachable(
  cfg: Config,
  deps?: OmlxReachableDeps,
): Promise<boolean> {
  const fetchFn = deps?.fetchFn ?? fetch;
  const timeoutMs = deps?.timeoutMs ?? 5000;

  const base = resolveProbeBaseUrl(cfg).replace(/\/+$/, "");
  const probeUrl = `${base}/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetchFn(probeUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.model.apiKey}` },
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// waitForOmlx
// ---------------------------------------------------------------------------

/**
 * Default interruptible sleep: sleeps in ≤1s increments checking
 * stopFlag.requested.  The canonical version (sleepInterruptible) arrives in
 * M4-T4; tests inject their own sleep, so this is only used in production.
 */
async function defaultSleep(
  seconds: number,
  stopFlag: StopFlagLike,
): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (!stopFlag.requested && Date.now() < end) {
    const remaining = end - Date.now();
    await new Promise<void>((r) => setTimeout(r, Math.min(1000, remaining)));
  }
}

export interface WaitForOmlxDeps {
  fetchFn?: typeof fetch;
  sleep?: (seconds: number, stopFlag: StopFlagLike) => Promise<void>;
}

/**
 * Block until the oMLX server is reachable or the stop-flag is set.
 * Port of worker.py wait_for_omlx (lines 629-647).
 *
 * - If cfg.startupWait is false → return immediately (no probe).
 * - Loop while !stopFlag.requested:
 *   - probe via omlxReachable; on success log and return.
 *   - on failure: log a warning on tries===1 or tries%10===0 (exactly the
 *     Python cadence), then sleep cfg.startupPollSeconds.
 */
export async function waitForOmlx(
  cfg: Config,
  stopFlag: StopFlagLike,
  deps?: WaitForOmlxDeps,
): Promise<void> {
  if (!cfg.startupWait) return;

  const fetchFn = deps?.fetchFn;
  const sleep = deps?.sleep ?? defaultSleep;

  let tries = 0;
  while (!stopFlag.requested) {
    if (await omlxReachable(cfg, { fetchFn })) {
      if (tries > 0) {
        log.info(`oMLX reachable after ${tries} retries`);
      } else {
        log.info("oMLX reachable");
      }
      return;
    }

    tries++;
    if (tries === 1 || tries % 10 === 0) {
      log.warn(
        `inference endpoint unreachable at ${cfg.model.baseUrl}; retry ${tries} (every ${cfg.startupPollSeconds}s)`,
      );
    }

    await sleep(cfg.startupPollSeconds, stopFlag);
  }
}
