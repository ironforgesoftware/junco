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
import { waitForOmlx, type StopFlagLike } from "./health.js";
import { log } from "./logging.js";

// ---------------------------------------------------------------------------
// StopFlag
// ---------------------------------------------------------------------------

/**
 * Cooperative shutdown flag.  Signal handlers (and tests) call requestStop();
 * the main loop polls `requested`.  Port of worker.py StopFlag — logs once on
 * the first stop request, then stays latched true.
 */
export class StopFlag implements StopFlagLike {
  private _requested = false;

  get requested(): boolean {
    return this._requested;
  }

  requestStop(): void {
    if (!this._requested) {
      log.info("stop requested; will exit after current task");
    }
    this._requested = true;
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
 * Register SIGTERM/SIGINT handlers that request a graceful stop.  Returns an
 * uninstall function that removes exactly those listeners (named references so
 * removeListener matches), letting tests — and a clean shutdown — detach them.
 * Port of worker.py _install_signal_handlers.
 */
export function installSignalHandlers(stopFlag: StopFlag): () => void {
  const handler = (): void => {
    stopFlag.requestStop();
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
  waitForOmlxFn?: (cfg: Config, stopFlag: StopFlagLike) => Promise<void>;
  sleep?: (seconds: number, stopFlag: StopFlagLike) => Promise<void>;
  mkdirs?: (cfg: Config) => void;
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
 * wait for oMLX → poll loop (handled → reset idle + break-if-once + continue;
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
  const runOnceFn = deps.runOnceFn ?? ((c: Config) => runOnce(c));
  const recoverOrphansFn = deps.recoverOrphansFn ?? recoverOrphans;
  const pruneFn = deps.pruneFn ?? ((r: string) => pruneStaleWorktrees(r));
  const waitForOmlxFn =
    deps.waitForOmlxFn ?? ((c: Config, s: StopFlagLike) => waitForOmlx(c, s));
  const sleep = deps.sleep ?? sleepInterruptible;
  const mkdirs = deps.mkdirs ?? defaultMkdirs;

  mkdirs(cfg);
  recoverOrphansFn(cfg);
  pruneFn(cfg.worktreeRoot);
  await waitForOmlxFn(cfg, stopFlag);

  log.info("worker online", {
    pid: process.pid,
    vault: join(cfg.vaultRoot, cfg.juncoSubdir),
    model: cfg.modelId,
    once: Boolean(opts.once),
  });

  let idleAnnounced = false;
  while (!stopFlag.requested) {
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

  log.info("worker exiting cleanly");
}
