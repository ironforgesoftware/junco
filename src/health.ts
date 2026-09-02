/**
 * Inference-endpoint startup health-check — port of worker.py `omlx_reachable`
 * + `wait_for_omlx`.
 *
 * On daemon startup junco blocks until the configured inference endpoint is
 * reachable, so the first ticket doesn't fail on a cold server (skipped for
 * hosted catalog-eligible models — see shouldProbeEndpoint).
 */

import type { Config } from "./types.js";
import { log } from "./logging.js";
import { resolveProbeBaseUrl, shouldProbeEndpoint } from "./agent/modelSetup.js";

/**
 * Minimal stop-flag interface consumed by waitForEndpoint.  The real StopFlag
 * lands in M4-T4; a local copy is fine — any object with `requested: boolean`
 * satisfies it.
 */
export interface StopFlagLike {
  readonly requested: boolean;
}

// ---------------------------------------------------------------------------
// probePolicy
// ---------------------------------------------------------------------------

/**
 * Should the endpoint be probed right now?  `worker.endpointProbe` is a
 * three-way override of shouldProbeEndpoint's catalog-skip heuristic:
 * "never" always skips, "always" always probes, "auto" (default) defers to
 * shouldProbeEndpoint (probe local/inline, skip hosted-catalog models).
 * Shared by endpointReachable, waitForEndpoint, and doctor's own guard so the
 * policy has exactly one source of truth.
 */
export function probePolicy(cfg: Config): boolean {
  switch (cfg.endpointProbe) {
    case "never":
      return false;
    case "always":
      return true;
    case "auto":
    default:
      return shouldProbeEndpoint(cfg.model);
  }
}

// ---------------------------------------------------------------------------
// endpointReachable
// ---------------------------------------------------------------------------

export interface EndpointReachableDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Probe the endpoint's /models route.  Returns true when the server responds
 * with a 2xx status (resp.ok), false for any other outcome (non-ok, network
 * error, timeout).
 *
 * Probe URL: resolveProbeBaseUrl gives the /v1 API base (from a configured
 * models.json's provider entry, or the inline base_url), then re-append
 * /models — hitting the configured endpoint with Bearer auth.
 */
export async function endpointReachable(
  cfg: Config,
  deps?: EndpointReachableDeps,
): Promise<boolean> {
  if (!probePolicy(cfg)) return true;

  const fetchFn = deps?.fetchFn ?? fetch;
  const timeoutMs = deps?.timeoutMs ?? 5000;

  const base = resolveProbeBaseUrl(cfg).replace(/\/+$/, "");
  const probeUrl = `${base}/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetchFn(probeUrl, {
      method: "GET",
      headers: cfg.model.apiKey !== null ? { Authorization: `Bearer ${cfg.model.apiKey}` } : {},
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
// waitForEndpoint
// ---------------------------------------------------------------------------

/**
 * Default interruptible sleep: sleeps in ≤1s increments checking
 * stopFlag.requested.  The canonical version (sleepInterruptible) arrives in
 * M4-T4; tests inject their own sleep, so this is only used in production.
 */
async function defaultSleep(seconds: number, stopFlag: StopFlagLike): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (!stopFlag.requested && Date.now() < end) {
    const remaining = end - Date.now();
    await new Promise<void>((r) => setTimeout(r, Math.min(1000, remaining)));
  }
}

export interface WaitForEndpointDeps {
  fetchFn?: typeof fetch;
  sleep?: (seconds: number, stopFlag: StopFlagLike) => Promise<void>;
}

/**
 * Block until the inference endpoint is reachable or the stop-flag is set.
 * Port of worker.py wait_for_omlx.
 *
 * - If cfg.startupWait is false → return immediately (no probe).
 * - Loop while !stopFlag.requested:
 *   - probe via endpointReachable; on success log and return.
 *   - on failure: log a warning on tries===1 or tries%10===0 (exactly the
 *     Python cadence), then sleep cfg.startupPollSeconds.
 */
export async function waitForEndpoint(
  cfg: Config,
  stopFlag: StopFlagLike,
  deps?: WaitForEndpointDeps,
): Promise<void> {
  if (!cfg.startupWait) return;

  if (!probePolicy(cfg)) {
    if (cfg.endpointProbe === "never") {
      log.info("endpoint probe disabled (worker.endpointProbe=never) — startup wait skipped");
    } else {
      log.info("hosted provider (catalog) — endpoint startup wait skipped");
    }
    return;
  }

  const fetchFn = deps?.fetchFn;
  const sleep = deps?.sleep ?? defaultSleep;

  let tries = 0;
  while (!stopFlag.requested) {
    if (await endpointReachable(cfg, { fetchFn })) {
      if (tries > 0) {
        log.info(`inference endpoint reachable after ${tries} retries`);
      } else {
        log.info("inference endpoint reachable");
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

// ---------------------------------------------------------------------------
// makeCachedProbe
// ---------------------------------------------------------------------------

/** TTL-cached, in-flight-deduplicated wrapper around a boolean probe. One
 * instance is shared by the claim gate, /health, and /ready so the dashboard's
 * poll cadence can't multiply upstream probe traffic.
 *
 * A rejection is treated as a `false` result and cached for the same TTL as a
 * success — deliberately, so a flaky/unreachable endpoint doesn't turn into a
 * probe-per-caller storm; the next natural TTL expiry re-checks it. */
export function makeCachedProbe(
  probe: () => Promise<boolean>,
  ttlMs = 10_000,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let cached: boolean | undefined;
  let cachedAt = -Infinity;
  let inFlight: Promise<boolean> | undefined;

  return async function cachedProbe(): Promise<boolean> {
    if (cached !== undefined && now() - cachedAt < ttlMs) {
      return cached;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      let result: boolean;
      try {
        result = await probe();
      } catch {
        result = false;
      }
      cached = result;
      cachedAt = now();
      inFlight = undefined;
      return result;
    })();

    return inFlight;
  };
}
