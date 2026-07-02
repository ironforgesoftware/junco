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
import { runOnce, claimNextTask, executeClaimed, type ClaimedWork } from "./runOnce.js";
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
import { pollGithubInbox, newBridgeState } from "./githubInbox.js";
import { makeGithubReporter } from "./githubReport.js";
import type { TicketReporter } from "./reporter.js";

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
  /** Serial-mode seam (max_concurrent = 1): claim + execute one ticket. */
  runOnceFn?: (cfg: Config) => Promise<boolean>;
  /** Concurrent-mode seams (max_concurrent > 1). */
  claimFn?: (
    cfg: Config,
    opts: { skipRepoKeys: Set<string>; readyFn?: () => Promise<boolean> },
  ) => Promise<ClaimedWork | null>;
  executeFn?: (cfg: Config, work: ClaimedWork) => Promise<void>;
  recoverOrphansFn?: (cfg: Config) => void;
  pruneFn?: (worktreeRoot: string) => void;
  waitForEndpointFn?: (cfg: Config, stopFlag: StopFlagLike) => Promise<void>;
  sleep?: (seconds: number, stopFlag: StopFlagLike) => Promise<void>;
  mkdirs?: (cfg: Config) => void;
  // Injectable so tests never bind a real port. Defaults to the real
  // startHealthServer. The daemon shares the process-wide `metrics` singleton.
  startHealthServerFn?: (opts: HealthServerOpts) => Promise<HealthServerHandle>;
  /** Bridge sweep override (tests). Only consulted when cfg.github.enabled. */
  bridgeSweepFn?: (cfg: Config) => Promise<number>;
}

function defaultMkdirs(cfg: Config): void {
  const paths = queuePaths(cfg);
  for (const dir of [paths.inbox, paths.processing, paths.done, paths.failed]) {
    mkdirSync(dir, { recursive: true });
  }
}

export interface SchedulerDeps {
  claimFn?: (
    cfg: Config,
    opts: { skipRepoKeys: Set<string>; readyFn?: () => Promise<boolean> },
  ) => Promise<ClaimedWork | null>;
  executeFn?: (cfg: Config, work: ClaimedWork) => Promise<void>;
  sleep?: (seconds: number, stopFlag: StopFlagLike) => Promise<void>;
  readyFn?: () => Promise<boolean>;
  /** Throttled bridge sweep (built by mainLoop); called once per poll tick. */
  maybeBridgeSweepFn?: () => Promise<void>;
  /** Lifecycle reporter threaded into the default executeFn. */
  reporter?: TicketReporter;
}

/**
 * Concurrent claim/execute scheduler (max_concurrent > 1): tops up to
 * cfg.maxConcurrent in-flight tickets, never runs two tickets against the same
 * repo at once (skipRepoKeys), wakes on the earlier of a task settling or the
 * poll tick, and drains in-flight work on a graceful stop. Force-stop aborts
 * the sessions via the StopFlag's forceSignal (threaded by executeFn).
 */
export async function runScheduler(
  cfg: Config,
  stopFlag: StopFlag,
  opts: { once?: boolean } = {},
  deps: SchedulerDeps = {},
): Promise<void> {
  const claimFn =
    deps.claimFn ??
    ((c: Config, o: { skipRepoKeys: Set<string>; readyFn?: () => Promise<boolean> }) =>
      claimNextTask(c, o));
  const executeFn =
    deps.executeFn ??
    ((c: Config, w: ClaimedWork) =>
      executeClaimed(c, w, { abortSignal: stopFlag.forceSignal, reporter: deps.reporter }));
  const sleep = deps.sleep ?? sleepInterruptible;

  const inflight = new Set<Promise<void>>();
  const busyRepos = new Set<string>();
  let idleAnnounced = false;
  let breakAfterDrain = false;

  while (!stopFlag.requested && !breakAfterDrain) {
    metrics.recordPoll();
    if (deps.maybeBridgeSweepFn) await deps.maybeBridgeSweepFn();
    let claimedThisPoll = 0;
    while (inflight.size < cfg.maxConcurrent && !stopFlag.requested) {
      const work = await claimFn(cfg, { skipRepoKeys: busyRepos, readyFn: deps.readyFn });
      if (!work) break;
      claimedThisPoll++;
      idleAnnounced = false;
      if (work.repoKey) busyRepos.add(work.repoKey);
      const p: Promise<void> = executeFn(cfg, work)
        .catch((e) =>
          log.error("task execution crashed", {
            id: work.ticket.id,
            error: e instanceof Error ? (e.stack ?? e.message) : String(e),
          }),
        )
        .finally(() => {
          inflight.delete(p);
          if (work.repoKey) busyRepos.delete(work.repoKey);
        });
      inflight.add(p);
      if (opts.once) break;
    }

    if (opts.once && (claimedThisPoll > 0 || inflight.size > 0)) {
      breakAfterDrain = true;
    } else if (inflight.size === 0) {
      if (!idleAnnounced) {
        log.info("idle");
        idleAnnounced = true;
      }
      await sleep(cfg.pollIntervalSeconds, stopFlag);
    } else {
      // Wake on the next settle OR the next poll tick, whichever first — a
      // freed slot tops up immediately; a busy-but-not-full pool still polls.
      await Promise.race([sleep(cfg.pollIntervalSeconds, stopFlag), ...inflight]);
    }
  }

  if (inflight.size > 0) {
    log.info("draining in-flight tasks", { count: inflight.size });
    await Promise.allSettled([...inflight]);
  }
}

/**
 * Poll-forever daemon loop with graceful shutdown.  Port of worker.py
 * main_loop: ensure queue dirs → recover orphans → prune stale worktrees →
 * wait for endpoint → poll loop (handled → reset idle + break-if-once + continue;
 * else log idle once + interruptible sleep) → "worker exiting cleanly".
 *
 * At [worker].max_concurrent > 1 the poll loop is replaced by runScheduler
 * (parallel tickets, per-repo serialization, graceful drain); the serial loop
 * below is kept byte-for-byte for the default of 1 — zero behavioral change.
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
  // GitHub bridge (issues → inbox) + reporter (labels/comment back). Gated on
  // cfg.github.enabled: disabled = zero gh calls, local behavior unchanged.
  const reporter = cfg.github.enabled ? makeGithubReporter(cfg) : undefined;
  const bridgeSweepFn = cfg.github.enabled ? (deps.bridgeSweepFn ?? defaultBridgeSweep()) : null;
  let lastSweepMs = -Infinity;
  const monoMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
  const maybeBridgeSweep = async (): Promise<void> => {
    if (!bridgeSweepFn) return;
    if (monoMs() - lastSweepMs < cfg.github.pollIntervalSeconds * 1000) return;
    lastSweepMs = monoMs();
    try {
      metrics.recordBridgeSweep(await bridgeSweepFn(cfg));
    } catch (e) {
      metrics.recordBridgeError();
      log.warn("github bridge sweep failed; queue unaffected", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // The daemon's default runOnce probes endpoint readiness before claiming,
  // so an endpoint outage queues work instead of burning tickets into failed/.
  const runOnceFn =
    deps.runOnceFn ??
    ((c: Config) =>
      runOnce(c, {
        readyFn: () => endpointReachable(c),
        abortSignal: stopFlag.forceSignal,
        reporter,
      }));
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
    if (cfg.maxConcurrent > 1) {
      await runScheduler(cfg, stopFlag, opts, {
        claimFn: deps.claimFn,
        executeFn: deps.executeFn,
        sleep: deps.sleep,
        readyFn: () => endpointReachable(cfg),
        maybeBridgeSweepFn: maybeBridgeSweep,
        reporter,
      });
    } else {
      let idleAnnounced = false;
      while (!stopFlag.requested) {
        metrics.recordPoll();
        await maybeBridgeSweep();
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

/** Default bridge sweep: process-lifetime state (label/origin caches) in a closure. */
function defaultBridgeSweep(): (cfg: Config) => Promise<number> {
  const state = newBridgeState();
  return (cfg: Config) => pollGithubInbox(cfg, state);
}
