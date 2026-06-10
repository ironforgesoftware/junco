/**
 * Daemon main loop + graceful shutdown — the integration heart of M4.
 *
 * Faithful port of worker.py:
 *   - StopFlag                  (lines 2690-2697)
 *   - _sleep_interruptible      (lines 2700-2706)
 *   - main_loop                 (lines 3368-3399)
 *   - _install_signal_handlers  (lines 3406-3408)
 *
 * Graceful shutdown semantics: a signal sets stopFlag.requested; the loop
 * finishes the IN-FLIGHT runOnce (no abort), then exits.  runOnce does NOT take
 * a stopFlag — a task runs to completion; the stopFlag governs only the poll
 * cadence (sleepInterruptible) and the loop guard.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { runOnce } from "./runOnce.js";
import { recoverOrphans } from "./orphans.js";
import { pruneStaleWorktrees } from "./worktree.js";
import { waitForEndpoint, endpointReachable, type StopFlagLike } from "./health.js";
import { log } from "./logging.js";
import { metrics } from "./metrics.js";
import {
  startHealthServer,
  type HealthServerHandle,
  type HealthServerOpts,
} from "./healthServer.js";

// ---------------------------------------------------------------------------
// StopFlag
// ---------------------------------------------------------------------------

/**
 * Cooperative shutdown flag.  Signal handlers (and tests) call requestStop();
 * the main loop polls `requested`.  Port of worker.py StopFlag — logs once on
 * the first stop request, then stays latched true.
 *
 * Force-stop escalation: a SECOND signal calls requestForceStop(), which aborts
 * `forceSignal` — runAgent listens on it and soft-aborts the in-flight session
 * (guard-kill semantics: commits made so far are salvaged into a PR).
 */
export class StopFlag implements StopFlagLike {
  private _requested = false;
  private readonly _force = new AbortController();

  get requested(): boolean {
    return this._requested;
  }

  /** Aborts when a force-stop is requested; runAgent listens on this. */
  get forceSignal(): AbortSignal {
    return this._force.signal;
  }

  requestStop(): void {
    if (!this._requested) {
      log.info("stop requested; will exit after current task (signal again to abort it)");
    }
    this._requested = true;
  }

  requestForceStop(): void {
    this._requested = true;
    if (!this._force.signal.aborted) {
      log.warn("force stop: aborting in-flight agent session (committed work will be salvaged)");
      this._force.abort();
    }
  }
}

// ---------------------------------------------------------------------------
// sleepInterruptible
// ---------------------------------------------------------------------------

export interface SleepDeps {
  setTimeoutFn?: typeof setTimeout;
}

/**
 * Sleep for `seconds`, but wake early as soon as stopFlag.requested flips true.
 * Port of worker.py _sleep_interruptible: poll in <=1s increments off a
 * monotonic deadline so a stop is honored within ~1s.
 *
 * Uses process.hrtime.bigint() (monotonic — immune to wall-clock jumps) for the
 * deadline.  The per-step timer is injectable for deterministic tests.
 */
export async function sleepInterruptible(
  seconds: number,
  stopFlag: StopFlagLike,
  deps: SleepDeps = {},
): Promise<void> {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;

  const nowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
  const endMs = nowMs() + seconds * 1000;

  while (!stopFlag.requested) {
    const remainingMs = endMs - nowMs();
    if (remainingMs <= 0) return;
    const stepMs = Math.min(1000, remainingMs);
    await new Promise<void>((resolve) => {
      setTimeoutFn(resolve, stepMs);
    });
  }
}

// ---------------------------------------------------------------------------
// installSignalHandlers
// ---------------------------------------------------------------------------

/**
 * Register SIGTERM/SIGINT handlers with stop escalation: the first signal
 * requests a graceful stop (drain the in-flight task), the second force-stops
 * (abort the agent session, salvage commits), the third hard-exits (130).
 * Returns an uninstall function that removes exactly those listeners (named
 * references so removeListener matches), letting tests — and a clean
 * shutdown — detach them.
 */
export function installSignalHandlers(stopFlag: StopFlag): () => void {
  let count = 0;
  const handler = (): void => {
    count++;
    if (count === 1) stopFlag.requestStop();
    else if (count === 2) stopFlag.requestForceStop();
    else process.exit(130); // third signal: the operator really means it
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  return () => {
    process.removeListener("SIGTERM", handler);
    process.removeListener("SIGINT", handler);
  };
}

// ---------------------------------------------------------------------------
// mainLoop
// ---------------------------------------------------------------------------

export interface MainLoopDeps {
  runOnceFn?: (cfg: Config) => Promise<boolean>;
  recoverOrphansFn?: (cfg: Config) => void;
  pruneFn?: (worktreeRoot: string) => void;
  waitForEndpointFn?: (cfg: Config, stopFlag: StopFlagLike) => Promise<void>;
  sleep?: (seconds: number, stopFlag: StopFlagLike) => Promise<void>;
  mkdirs?: (cfg: Config) => void;
  // Injectable so tests never bind a real port. Defaults to the real
  // startHealthServer. The daemon shares the process-wide `metrics` singleton.
  startHealthServerFn?: (opts: HealthServerOpts) => Promise<HealthServerHandle>;
}

function defaultMkdirs(cfg: Config): void {
  const paths = queuePaths(cfg);
  for (const dir of [paths.inbox, paths.processing, paths.done, paths.failed]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Poll-forever daemon loop with graceful shutdown.  Port of worker.py
 * main_loop: ensure queue dirs → recover orphans → prune stale worktrees →
 * wait for endpoint → poll loop (handled → reset idle + break-if-once + continue;
 * else log idle once + interruptible sleep) → "worker exiting cleanly".
 *
 * Every side-effecting collaborator is injectable so the loop is unit-testable
 * without real fs / network / timers.
 */
export async function mainLoop(
  cfg: Config,
  stopFlag: StopFlag,
  opts: { once?: boolean } = {},
  deps: MainLoopDeps = {},
): Promise<void> {
  // The daemon's default runOnce probes endpoint readiness before claiming,
  // so an endpoint outage queues work instead of burning tickets into failed/.
  const runOnceFn =
    deps.runOnceFn ??
    ((c: Config) =>
      runOnce(c, { readyFn: () => endpointReachable(c), abortSignal: stopFlag.forceSignal }));
  const recoverOrphansFn = deps.recoverOrphansFn ?? recoverOrphans;
  const pruneFn = deps.pruneFn ?? ((r: string) => pruneStaleWorktrees(r));
  const waitForEndpointFn =
    deps.waitForEndpointFn ?? ((c: Config, s: StopFlagLike) => waitForEndpoint(c, s));
  const sleep = deps.sleep ?? sleepInterruptible;
  const mkdirs = deps.mkdirs ?? defaultMkdirs;
  const startHealthServerFn = deps.startHealthServerFn ?? startHealthServer;

  mkdirs(cfg);
  // Stamp the start time once the queue dirs exist; the health server reports
  // uptime off this. Idempotent — first call wins.
  metrics.markStarted();
  recoverOrphansFn(cfg);
  pruneFn(cfg.worktreeRoot);
  await waitForEndpointFn(cfg, stopFlag);

  log.info("worker online", {
    pid: process.pid,
    vault: join(cfg.vaultRoot, cfg.juncoSubdir),
    model: cfg.model.id,
    once: Boolean(opts.once),
  });

  // Health endpoint (optional). A start failure must NOT crash the daemon — we
  // log a warning and continue headless. The server closes after the loop ends.
  let health: HealthServerHandle | null = null;
  if (cfg.healthEnabled) {
    try {
      health = await startHealthServerFn({
        host: cfg.healthHost,
        port: cfg.healthPort,
        metrics,
        readinessProbe: () => endpointReachable(cfg),
      });
      log.info("health endpoint listening", { url: health.url });
    } catch (e) {
      log.warn("health endpoint failed to start; continuing without it", {
        error: e instanceof Error ? e.message : String(e),
        port: cfg.healthPort,
      });
      health = null;
    }
  }

  try {
    let idleAnnounced = false;
    while (!stopFlag.requested) {
      metrics.recordPoll();
      const handled = await runOnceFn(cfg);
      if (handled) {
        idleAnnounced = false;
        if (opts.once) break;
        continue;
      }
      if (!idleAnnounced) {
        log.info("idle");
        idleAnnounced = true;
      }
      await sleep(cfg.pollIntervalSeconds, stopFlag);
    }
  } finally {
    // Always tear the health server down, even if the loop throws. It stays up
    // for the whole in-flight task during a graceful shutdown (close runs after
    // the loop exits), but a mid-loop throw must not leak the bound port to an
    // embedded/test caller — we don't rely on process exit to free it.
    if (health) await health.close();
  }

  log.info("worker exiting cleanly");
}
