/**
 * Daemon main loop + graceful shutdown — the integration heart of M4.
 *
 * Faithful port of worker.py's `StopFlag`, `_sleep_interruptible`, `main_loop`,
 * and `_install_signal_handlers`.
 *
 * Shutdown is a three-stage escalation, one stage per signal
 * (`installSignalHandlers`):
 *   1. graceful — `stopFlag.requested` latches; the poll loop (or runScheduler)
 *      finishes the IN-FLIGHT ticket without aborting it, then exits.  The flag
 *      governs the poll cadence (`sleepInterruptible`) and the loop guard.
 *   2. force    — `stopFlag.requestForceStop()` aborts `stopFlag.forceSignal`,
 *      which mainLoop/runScheduler thread into runOnce/executeClaimed as
 *      `abortSignal`.  runAgent listens on it and SOFT-aborts the session, so
 *      commits made so far are still salvaged into a PR (guard-kill semantics).
 *   3. hard     — a third signal exits 130 outright.
 */

import { join } from "node:path";
import type { Config } from "./types.js";
import type { ConfigHolder } from "./configWatcher.js";
import { ensureDataTree, dataTreePaths } from "./dataTree.js";
import { migrateStateTree, type MigrateResult } from "./dataMigrate.js";
import { acquirePidfileLock } from "./pidfileLock.js";
import { runOnce, claimNextTask, executeClaimed, type ClaimedWork } from "./runOnce.js";
import { recoverOrphans } from "./orphans.js";
import { pruneStaleWorktrees } from "./worktree.js";
import {
  waitForEndpoint,
  endpointReachable,
  makeCachedProbe,
  type StopFlagLike,
} from "./health.js";
import { log } from "./logging.js";
import { ensureSkillLinks, type SkillLinksReport } from "./skillLinks.js";
import { metrics } from "./metrics.js";
import { ProviderGate, type GateStateKind } from "./providerGate.js";
import { makeSpendLedger, type SpendLedger } from "./spendLedger.js";
import { makeMetricsWriter, type MetricsWriter } from "./metricsWriter.js";
import {
  startHealthServer,
  type HealthServerHandle,
  type HealthServerOpts,
} from "./healthServer.js";
import { pollGithubInbox, newBridgeState } from "./githubInbox.js";
import { makeGithubReporter } from "./githubReport.js";
import type { TicketReporter } from "./reporter.js";
import { outboxDepth, flushOutbox, type FlushResult } from "./githubOutbox.js";
import { sweepDependencies } from "./ticketDeps.js";
import { detectSplitQueue, type SplitQueueFinding } from "./splitQueue.js";

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

export interface SignalHandlerDeps {
  /** Process-exit seam for the third-signal hard-exit (130) path. Injectable
   * so the escalation can be asserted without a test really tearing down the
   * runner; defaults to a real process.exit. */
  exit?: (code: number) => void;
}

/**
 * Register SIGTERM/SIGINT handlers with stop escalation: the first signal
 * requests a graceful stop (drain the in-flight task), the second force-stops
 * (abort the agent session, salvage commits), the third hard-exits (130).
 * Returns an uninstall function that removes exactly those listeners (named
 * references so removeListener matches), letting tests — and a clean
 * shutdown — detach them.
 */
export function installSignalHandlers(
  stopFlag: StopFlag,
  deps: SignalHandlerDeps = {},
): () => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let count = 0;
  const handler = (): void => {
    count++;
    if (count === 1) stopFlag.requestStop();
    else if (count === 2) stopFlag.requestForceStop();
    else exit(130); // third signal: the operator really means it
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  return () => {
    process.removeListener("SIGTERM", handler);
    process.removeListener("SIGINT", handler);
  };
}

// ---------------------------------------------------------------------------
// Restart-kind lever freeze
// ---------------------------------------------------------------------------

// Restart-kind levers (configLevers reload:"restart") must never hot-apply — even
// read via the holder they stay at startup values, so a live edit can't move the
// dataDir/queueRoot or rebind the health socket mid-run. Live-kind fields come from
// the holder; restart-kind fields are pinned to the frozen startup cfg. Keep this
// list in sync with the reload:"restart" entries in src/configLevers.ts.
export function overlayFrozenRestartFields(frozen: Config, live: Config): Config {
  return {
    ...live,
    dataDir: frozen.dataDir,
    // dataLayout is dataDir-derived (single-root ~/.junco consolidation) —
    // pin it alongside dataDir. Without this, a live config edit that
    // resolves to a differently-laid-out root (e.g. an operator's dataDir
    // edit probing a fresh v2 tree while the frozen root is a pre-existing
    // flat one) would pair the FROZEN dataDir with the LIVE dataLayout via
    // the `...live` spread above, and every dataTreePaths()-derived path
    // (outbox/transcripts/history/logFile/...) would silently move to
    // data/cache/logs subpaths inside a live flat tree — a tree split, plus
    // sandboxDenyPaths (also layout-derived) would stop denying the real
    // (flat) state paths since it'd deny the nonexistent v2 ones instead.
    dataLayout: frozen.dataLayout,
    queueRoot: frozen.queueRoot,
    legacy: frozen.legacy,
    // worktreeRoot derives from dataDir (restart-kind) whenever the legacy
    // git.worktreeRoot key is unset — pin the derived value so a live dataDir
    // edit can't move new worktrees while everything else stays frozen. An
    // EXPLICIT live git.worktreeRoot is a reload:"live" lever and keeps its
    // hot-apply semantics. (Same rule for github.externalReposRoot below.)
    worktreeRoot: live.legacy.worktreeRoot ? live.worktreeRoot : frozen.worktreeRoot,
    maxConcurrent: frozen.maxConcurrent,
    healthEnabled: frozen.healthEnabled,
    healthHost: frozen.healthHost,
    healthPort: frozen.healthPort,
    logToFile: frozen.logToFile,
    transcriptsEnabled: frozen.transcriptsEnabled,
    // botAccount.enabled + botAccount.configDir are both reload:"restart" — pin
    // the whole object. And pin the runtime-resolved ghAuth alongside it: it's
    // attached at startup from botAccount, never re-parsed from the file, so a
    // live spread would silently DROP it the moment an edit touches botAccount
    // (identity revert) or leave it pointing at a configDir the edit just moved.
    botAccount: frozen.botAccount,
    ghAuth: frozen.ghAuth,
    github: {
      ...live.github,
      enabled: frozen.github.enabled,
      // triggerLabel/askLabel feed the reporter's lifecycle-label prefix, which
      // is baked in once at mainLoop setup — freeze them so the live bridge
      // sweep can't scan a new label while the reporter still writes the old
      // prefix (#162). Both are reload:"restart".
      triggerLabel: frozen.github.triggerLabel,
      askLabel: frozen.github.askLabel,
      // Derived-from-dataDir unless the legacy key is explicitly set — see
      // the worktreeRoot pin above for the rationale.
      externalReposRoot: live.legacy.externalReposRoot
        ? live.github.externalReposRoot
        : frozen.github.externalReposRoot,
    },
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
  /** In-place state-tree migration (Task 4), run BEFORE mkdirs — an eager
   * mkdir would otherwise fabricate empty destinations for pairs whose old
   * name still holds the real data. Defaults to the real migrateStateTree. */
  migrateFn?: (cfg: Config) => MigrateResult;
  /** #197.2: non-blocking lock around the startup migration so a concurrent
   * `junco data migrate` (which can't see a mid-startup daemon via /health —
   * the health server starts after migration) doesn't double-run the pass.
   * Returns null when another migrate holds the lock. Takes the lock FILE
   * path itself (dataTreePaths(cfg).migrateLockFile) — the caller joins
   * "migrate.lock" onto the data root exactly once, in dataTree.ts, so this
   * and dataMigrateCmd.ts's own lock acquisition (src/dataMigrateCmd.ts)
   * can never drift apart on where the mutex file lives. Default: the real
   * acquirePidfileLock. */
  migrateLockFn?: (lockFile: string) => { release: () => void } | null;
  mkdirs?: (cfg: Config) => void;
  /** Skill-link distribution (Task 3): symlinks the package skills/ dir into
   * <dataDir>/skills and fans out per-harness junco-dispatch links (Task 2's
   * ensureSkillLinks). Runs immediately after the data-tree ensure so the
   * mount's parent always exists first. Idempotent + never throws — an
   * all-quiet report (every entry's kind is "ok" or "harness-not-installed")
   * logs nothing. Defaults to the real ensureSkillLinks. */
  ensureSkillLinksFn?: (cfg: Config) => SkillLinksReport;
  // Injectable so tests never bind a real port. Defaults to the real
  // startHealthServer. The daemon shares the process-wide `metrics` singleton.
  startHealthServerFn?: (opts: HealthServerOpts) => Promise<HealthServerHandle>;
  /** Split-queue guard (#274): reports when the resolved queue's inbox is
   * empty while another known queue root's inbox is not — the 2026-08-01
   * incident, where the dispatcher wrote to one root and the worker polled
   * another for four days while both sides reported healthy. Pure
   * observability: it never gates startup (see the try/catch at its call
   * site). Defaults to the real detectSplitQueue, which reads the filesystem
   * and takes env from process.env. */
  detectSplitQueueFn?: (cfg: Config) => SplitQueueFinding | null;
  /** Bridge sweep override (tests). Only consulted when cfg.github.enabled. */
  bridgeSweepFn?: (cfg: Config) => Promise<number>;
  /** Standalone outbox drain override (tests). Only consulted when
   * cfg.github.enabled is FALSE — when the bridge is enabled, its sweep
   * already flushes the outbox first (pollGithubInbox's flush-first
   * behavior), so a second flusher here would be redundant. Defaults to the
   * real flushOutbox. */
  outboxDrainFn?: (cfg: Config) => Promise<FlushResult>;
  /** Dependency sweep seam (spec 2026-08-20); default sweepDependencies. */
  depSweepFn?: typeof sweepDependencies;
  /** Live-reload seam (Task 6): when set, per-iteration config reads prefer
   * `configHolder.current` over the `cfg` this loop was started with. Setup
   * (restart-kind) collaborators above intentionally keep reading the
   * initial `cfg` — see the "Do NOT change" list in mainLoop's body. */
  configHolder?: ConfigHolder;
  /** Provider gate (Task 10): classification-driven claim pausing, shared by
   * the claim readyFn (serial + scheduler), the health server's gateStatus,
   * and (via cli.ts) the config-watcher's clear-on-successful-reload. Absent
   * → mainLoop builds its own via makeProviderGate(cfg). Typed as a Pick (not
   * the concrete class) so tests can inject a plain fake — same pattern as
   * runOnce.test.ts's fakeGate — without pulling in the real latching state
   * machine. */
  gate?: Pick<
    ProviderGate,
    | "claimBlockReason"
    | "status"
    | "reportFailure"
    | "reportSuccess"
    | "notBeforeIso"
    | "reportBudgetExhausted"
  >;
  /** Per-day spend ledger (Phase-3 Task 4), constructed next to the gate:
   * absent → mainLoop builds its own via `makeSpendLedger(dataTreePaths(cfg).spendFile)`.
   * `cfg` here is always the FROZEN startup config (dataDir is
   * restart-kind — see overlayFrozenRestartFields), exactly like the gate and
   * the health server bind. Threaded into both the serial default runOnceFn
   * and the scheduler's default executeFn (peer of `gate`). `todayUsd`/
   * `nextMidnightMs` (Phase-3 Task 5) are consulted by gatedReady itself,
   * ahead of the claim gate check — see gatedReady below. */
  spend?: Pick<SpendLedger, "recordUsd" | "todayUsd" | "nextMidnightMs">;
  /** Out-of-process metrics.json writer (Task 3), constructed next to `spend`:
   * absent → mainLoop builds its own via
   * `makeMetricsWriter(dataTreePaths(cfg).metricsFile)`. `cfg` here is always
   * the FROZEN startup config (dataDir is restart-kind — see
   * overlayFrozenRestartFields), exactly like the gate, the spend ledger, and
   * the health server bind. `flush`ed once right after metrics.markStarted()
   * so the file exists with the new pid immediately, `write`n (debounced) on
   * every poll tick — both the serial loop's and the scheduler's own (peer of
   * `spend` in SchedulerDeps below) — and `flush`ed again in the shutdown
   * finally so the last snapshot is durable even when the loop throws. A
   * write failure never surfaces here — metricsWriter.ts swallows it. */
  metricsWriter?: Pick<MetricsWriter, "write" | "flush">;
}

/**
 * Default provider-gate factory (Task 10): seeds retry backoff from
 * cfg.retryBackoffSeconds and routes transitions into the process-wide
 * metrics singleton. Shared by mainLoop's own default and cli.ts (which
 * constructs one gate up front so it can wire the SAME instance into both
 * mainLoopFn's deps and the config-watcher's onApplied clear).
 *
 * `backoffGetter` (#180): retryBackoffSeconds is a reload:"live" lever, so
 * callers with a live config holder pass a getter (`() => holder.current
 * .retryBackoffSeconds`) that the gate re-reads on every report/stamp;
 * omitting it freezes the startup value (fine for tests / one-shot callers).
 */
export function makeProviderGate(cfg: Config, backoffGetter?: () => number): ProviderGate {
  return new ProviderGate({
    retryBackoffSeconds: backoffGetter ?? cfg.retryBackoffSeconds,
    onTransition: (_from, to) => metrics.recordGateTransition(to),
  });
}

function defaultMkdirs(cfg: Config): void {
  ensureDataTree(cfg);
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
  /** Live-reload seam (Task 6): when set, per-dispatch reads (maxConcurrent,
   * poll sleep) prefer `configHolder.current` over the `cfg` this scheduler
   * was invoked with. */
  configHolder?: ConfigHolder;
  /** Provider gate (Task 10), threaded into the default executeFn's
   * executeClaimed call (peer of `reporter`) — absent preserves pre-gate
   * scheduler behavior exactly. See MainLoopDeps.gate for the full picture;
   * mainLoop passes its own gate through here. */
  gate?: Pick<ProviderGate, "reportFailure" | "reportSuccess" | "notBeforeIso">;
  /** Per-day spend ledger (Task 4), threaded into the default executeFn's
   * executeClaimed call (peer of `gate`) — absent preserves pre-ledger
   * scheduler behavior exactly. mainLoop passes its own ledger through here. */
  spend?: Pick<SpendLedger, "recordUsd">;
  /** Out-of-process metrics.json writer (Task 3), threaded from mainLoop's own
   * instance (peer of `gate`/`spend`) — written (debounced) once per poll
   * tick, right next to the metrics singleton's own recordPoll(). Absent (a
   * direct runScheduler test, or a caller that doesn't care) simply skips the
   * per-poll write — no default is built here. */
  metricsWriter?: Pick<MetricsWriter, "write">;
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
      executeClaimed(c, w, {
        abortSignal: stopFlag.forceSignal,
        reporter: deps.reporter,
        gate: deps.gate,
        spend: deps.spend,
      }));
  const sleep = deps.sleep ?? sleepInterruptible;
  // Live-reload seam (Task 6): falls back to the `cfg` this scheduler was
  // invoked with when no holder is wired (existing callers/tests unaffected).
  // Restart-kind fields are always pinned to the frozen `cfg` this scheduler
  // was invoked with — see overlayFrozenRestartFields.
  const activeCfg = (): Config =>
    deps.configHolder ? overlayFrozenRestartFields(cfg, deps.configHolder.current) : cfg;

  const inflight = new Set<Promise<void>>();
  const busyRepos = new Set<string>();
  let idleAnnounced = false;
  let breakAfterDrain = false;

  try {
    while (!stopFlag.requested && !breakAfterDrain) {
      metrics.recordPoll();
      deps.metricsWriter?.write(metrics.snapshot());
      if (deps.maybeBridgeSweepFn) await deps.maybeBridgeSweepFn();
      let claimedThisPoll = 0;
      // maxConcurrent is restart-kind (Task 6/Fix C): read the FROZEN `cfg`
      // here, not activeCfg() — a live edit must never silently change the
      // concurrency limit mid-run while configWatcher tells the operator to
      // restart to apply it. claim/execute below still use activeCfg() so an
      // in-flight/newly-claimed ticket picks up other, live-kind levers.
      while (inflight.size < cfg.maxConcurrent && !stopFlag.requested) {
        const work = await claimFn(activeCfg(), { skipRepoKeys: busyRepos, readyFn: deps.readyFn });
        if (!work) break;
        claimedThisPoll++;
        idleAnnounced = false;
        if (work.repoKey) busyRepos.add(work.repoKey);
        const p: Promise<void> = executeFn(activeCfg(), work)
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
        await sleep(activeCfg().pollIntervalSeconds, stopFlag);
      } else {
        // Wake on the next settle OR the next poll tick, whichever first — a
        // freed slot tops up immediately; a busy-but-not-full pool still polls.
        await Promise.race([sleep(activeCfg().pollIntervalSeconds, stopFlag), ...inflight]);
      }
    }
  } catch (e) {
    // claimNextTask deliberately rethrows non-ENOENT fs errors. Left unhandled
    // that throw escapes to cli.ts's process.exit(1), which hard-kills every
    // in-flight agent session with NO commit salvage — the opposite of the
    // graceful drain a SIGTERM gives. Log it and fall through to the drain in
    // the finally so in-flight work still completes.
    log.error("scheduler loop aborted; draining in-flight tasks", {
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  } finally {
    if (inflight.size > 0) {
      log.info("draining in-flight tasks", { count: inflight.size });
      await Promise.allSettled([...inflight]);
    }
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
    if (monoMs() - lastSweepMs < activeCfg().github.pollIntervalSeconds * 1000) return;
    lastSweepMs = monoMs();
    try {
      metrics.recordBridgeSweep(await bridgeSweepFn(activeCfg()));
    } catch (e) {
      metrics.recordBridgeError();
      log.warn("github bridge sweep failed; queue unaffected", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Local-mode outbox auto-drain: when the bridge is disabled, pollGithubInbox
  // (the only automatic flusher — see its flush-first behavior) never runs,
  // so an offline PR flow's queued push/PR/comment ops would otherwise sit
  // parked until an operator remembers `junco outbox flush`. This mirrors
  // maybeBridgeSweep's throttle (same cfg.github.pollIntervalSeconds cadence
  // — sane even with github disabled, since it's just the default) but is
  // mutually exclusive with the bridge sweep: enabled github already flushes
  // the outbox first every sweep, so a second flusher here would be
  // redundant (and could race it pointlessly).
  const outboxDrainFn = cfg.github.enabled ? null : (deps.outboxDrainFn ?? flushOutbox);
  let lastDrainMs = -Infinity;
  const maybeOutboxDrain = async (): Promise<void> => {
    if (!outboxDrainFn) return;
    if (monoMs() - lastDrainMs < activeCfg().github.pollIntervalSeconds * 1000) return;
    lastDrainMs = monoMs();
    if (outboxDepth(activeCfg()) <= 0) return;
    try {
      const result = await outboxDrainFn(activeCfg());
      metrics.recordOutboxFlush(result, outboxDepth(activeCfg()));
    } catch (e) {
      log.warn("outbox drain failed; queue unaffected", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Live-reload seam (Task 6): per-iteration reads below prefer the holder's
  // current config over the `cfg` this loop was started with. Setup below
  // (mkdirs, recoverOrphans, pruneFn, waitForEndpoint, the health server's
  // host/port, "worker online") is intentionally restart-kind — it stays on
  // the initial `cfg`, matching the existing lever-reload classification.
  // Restart-kind fields are pinned to that frozen `cfg` even when read through
  // the holder below — see overlayFrozenRestartFields.
  const activeCfg = (): Config =>
    deps.configHolder ? overlayFrozenRestartFields(cfg, deps.configHolder.current) : cfg;

  // Dependency sweep (spec 2026-08-20): stamps deps_satisfied for done+merged
  // parents and cascades dependents of failed ones. Mode-agnostic — runs with
  // the bridge disabled — and lazy: a queue with no depends_on edges costs one
  // readdir per throttled tick.
  const depSweepFn = deps.depSweepFn ?? sweepDependencies;
  let lastDepSweepMs = -Infinity;
  const maybeDepSweep = async (): Promise<void> => {
    if (monoMs() - lastDepSweepMs < activeCfg().planSets.mergePollSeconds * 1000) return;
    lastDepSweepMs = monoMs();
    try {
      await depSweepFn(activeCfg());
    } catch (e) {
      log.warn("dependency sweep failed; queue unaffected", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Provider gate (Task 10): classification-driven claim pausing. A latched
  // auth/quota/misconfig state (or an unexpired rate-limit/outage backoff)
  // pauses claiming without touching retry_count; runOnce/executeClaimed
  // report into it below, the health server surfaces its status, and (via
  // cli.ts) a successful config hot-reload clears a stale latch.
  const gate = deps.gate ?? makeProviderGate(cfg, () => activeCfg().retryBackoffSeconds);
  // Per-day spend ledger (Phase-3 Task 4): every session runOnce/executeClaimed
  // runs records its costUsd here. `cfg` is the frozen startup config, not
  // activeCfg() — dataDir is restart-kind (same freeze as the gate above and
  // the health server's host/port bind; see overlayFrozenRestartFields).
  const spend = deps.spend ?? makeSpendLedger(dataTreePaths(cfg).spendFile);
  // Out-of-process metrics.json writer (Task 3): same frozen-cfg bind as spend
  // just above — dataDir is restart-kind, so a live reload must never move
  // the file mid-run (see overlayFrozenRestartFields).
  const metricsWriter = deps.metricsWriter ?? makeMetricsWriter(dataTreePaths(cfg).metricsFile);
  // Single TTL-cached probe shared by the claim gate and the health server so
  // neither multiplies upstream endpoint-probe traffic. Wraps the *call* —
  // activeCfg() is read fresh on every uncached probe — so a hot-reloaded
  // endpoint config is picked up on the next probe past the TTL; no cache
  // invalidation is needed.
  const cachedReachable = makeCachedProbe(() => endpointReachable(activeCfg()));
  // #180.2: the pause warn is debounced to once per gate-state transition
  // (keyed on the state KIND, not the reason string — the budget reason embeds
  // a running spend total that changes every poll). Steady-state blocked polls
  // drop to debug so a latch doesn't spam warn for its whole lifetime.
  let lastGateWarnState: GateStateKind = "ok";
  const gatedReady = async (): Promise<boolean> => {
    // Daily spend cap (Phase-3 Task 5): checked BEFORE the gate/probe, on
    // EVERY poll, using the LIVE config — dailyBudgetUsd is a live lever, so
    // an operator raising it hot-reloads immediately. 0 disables the check
    // entirely and never touches the spend ledger (spy-verified in tests).
    // Reporting into the gate here (rather than just returning false
    // directly) gives the budget the same claimBlockReason()/status()/
    // /health surfacing as every other gate state, with no new surface code.
    const liveCfg = activeCfg();
    if (liveCfg.dailyBudgetUsd > 0) {
      const todaySpent = spend.todayUsd();
      if (todaySpent >= liveCfg.dailyBudgetUsd) {
        gate.reportBudgetExhausted(
          spend.nextMidnightMs(),
          `daily budget $${liveCfg.dailyBudgetUsd.toFixed(2)} reached ($${todaySpent.toFixed(2)} spent)`,
        );
      }
    }
    const block = gate.claimBlockReason();
    if (block) {
      const kind = gate.status().state;
      if (kind !== lastGateWarnState) {
        log.warn("claiming paused by provider gate", { reason: block, state: kind });
      } else {
        log.debug("claiming still paused by provider gate", { reason: block, state: kind });
      }
      lastGateWarnState = kind;
      return false;
    }
    if (lastGateWarnState !== "ok") {
      log.info("claiming resumed by provider gate");
      lastGateWarnState = "ok";
    }
    return cachedReachable();
  };

  // The daemon's default runOnce probes endpoint readiness (gated) before
  // claiming, so an endpoint outage OR a latched provider failure queues work
  // instead of burning tickets into failed/.
  const runOnceFn =
    deps.runOnceFn ??
    ((c: Config) =>
      runOnce(c, {
        readyFn: gatedReady,
        abortSignal: stopFlag.forceSignal,
        reporter,
        gate,
        spend,
      }));
  const recoverOrphansFn = deps.recoverOrphansFn ?? recoverOrphans;
  const pruneFn = deps.pruneFn ?? ((r: string) => pruneStaleWorktrees(r));
  const waitForEndpointFn =
    deps.waitForEndpointFn ?? ((c: Config, s: StopFlagLike) => waitForEndpoint(c, s));
  const sleep = deps.sleep ?? sleepInterruptible;
  const migrateFn = deps.migrateFn ?? migrateStateTree;
  const migrateLockFn = deps.migrateLockFn ?? ((f: string) => acquirePidfileLock(f));
  const mkdirs = deps.mkdirs ?? defaultMkdirs;
  const ensureSkillLinksFn = deps.ensureSkillLinksFn ?? ensureSkillLinks;
  const startHealthServerFn = deps.startHealthServerFn ?? startHealthServer;
  const detectSplitQueueFn = deps.detectSplitQueueFn ?? ((c: Config) => detectSplitQueue(c));

  // Split-queue guard (#274) — FIRST piece of startup work, ahead of the
  // migrate lock, mkdirs, and both destructive recovery steps. The reason it
  // has to be here and nowhere later: recoverOrphans + pruneStaleWorktrees are
  // destructive, and the operator must see the mismatch BEFORE the daemon acts
  // on the wrong root. Sitting ahead of waitForEndpointFn (which can block for
  // a long time) is a second, smaller win: the warning lands immediately
  // instead of after the wait.
  //
  // NOT a reason, though it reads like one: "mkdirs (ensureDataTree) creates
  // the resolved queue, so checking after it would degrade the finding to 'you
  // have no tickets yet'." It would not — `discoverTasks` (src/queue.ts)
  // returns [] for ENOENT and [] for an existing-empty directory alike, so a
  // check run after mkdirs produces a byte-identical finding. Recorded here
  // because that false argument used to lead this comment: a maintainer who
  // checks it, finds it inert, and concludes the whole ordering constraint is
  // folklore would move the guard below recoverOrphans and silently kill the
  // feature. The destructive-steps reason above is the real one and is pinned
  // by an invocationCallOrder assertion in tests/daemon.test.ts.
  //
  // Safe ahead of migrateFn: the startup migration only renames state-tree
  // pairs INSIDE cfg.dataDir (stateTreeMigrations, src/dataMigrate.ts), never
  // the cross-root `queue` move — that one lives in dataRootPairs and only
  // `junco data migrate` performs it — so this can't fire on tickets the
  // daemon itself is about to relocate.
  // A detector failure must never take the daemon down: this is observability
  // with no consumer that a startup abort would help. It also has an
  // interactive twin — `junco doctor` runs the same check — so the evidence
  // isn't lost, and a warn here would spend the operator's attention budget on
  // every single start for something like an unreadable abandoned root. Debug
  // keeps it recoverable in worker.log without training anyone to ignore the
  // real warning below.
  try {
    const split = detectSplitQueueFn(cfg);
    if (split) {
      const otherRoots = split.others.map((o) => o.root).join(", ");
      log.warn(
        "the resolved queue's inbox is empty but another known queue root holds tickets — this worker will sit idle while they wait",
        {
          resolvedQueueRoot: split.resolvedRoot,
          otherQueueRoots: split.others.map((o) => `${o.root} (${o.label}, ${o.pending} pending)`),
          advice:
            `tickets are being filed into ${otherRoots} but this worker only claims from ` +
            `${join(split.resolvedRoot, "inbox")} — point whatever files tickets at the resolved ` +
            `root, or move them there (\`junco data migrate\` for a legacy root), then restart; ` +
            `\`junco doctor\` prints the resolved paths`,
        },
      );
    }
  } catch (err) {
    log.debug("split-queue check skipped", { error: String(err) });
  }

  // Migrate BEFORE mkdirs: ensureDataTree mkdir-p's the whole new tree, so if
  // it ran first every old-name pair's destination would already exist (as an
  // empty dir) by the time migrateStateTree looked — turning every ordinary
  // rename into the repair path for no reason. See dataMigrate.ts's
  // recursively-empty-dst repair rule for the cases that path actually means
  // to catch (a crash between mkdir and rename, or scaffolding a rolled-back
  // version materialized), not routine startup ordering.
  //
  // #197.2: hold migrate.lock (non-blocking) for the pass. A concurrent
  // `junco data migrate` in the startup window is invisible to its /health
  // probe (the health server starts after this), so without the lock both
  // would run the state-tree pass. Renames are atomic — the loser only
  // errors-then-converges — so this is tidiness, not corruption: skip if held.
  // acquirePidfileLock mkdirs only dirname(lockPath) = cfg.dataDir, not the
  // nested tree, so the migrate-before-mkdirs invariant above is preserved.
  const migLock = migrateLockFn(dataTreePaths(cfg).migrateLockFile);
  if (migLock === null) {
    log.warn("state-tree migration skipped — another migrate holds migrate.lock");
  } else {
    try {
      const mig = migrateFn(cfg);
      for (const step of mig.steps) {
        // One receipt per pair that actually moved — worker.log evidence of
        // what the automatic migration did (durable journal is migrated.json).
        if (step.action === "renamed") {
          log.info("state-tree migration: renamed", { from: step.from, to: step.to });
        }
      }
      for (const conflict of mig.conflicts) {
        log.warn("state-tree migration conflict; manual resolution required", { conflict });
      }
    } finally {
      migLock.release();
    }
  }
  // #281 item 7 — mkdirs runs AFTER migrate.lock was released just above, and
  // that ordering is deliberate, not an oversight. Recorded here so the next
  // reader does not re-derive the analysis (or "fix" a window that was left
  // alone on purpose):
  //
  // - Nothing executes in the window. `migLock.release()` is the last
  //   statement of the `finally`; only two closing braces separate it from
  //   this call.
  // - In normal operation only `junco data migrate --force` gets inside it.
  //   This process holds `worker.lock` across the WHOLE startup — cli.ts
  //   acquires it before calling mainLoop and releases it in the `finally`
  //   after the loop returns — and an unforced migrate refuses on either
  //   signal of a live daemon: the /health probe, or a live holder of the
  //   worker.lock it derives from its own config path exactly as cli.ts does
  //   (dataMigrateCmd.ts phase 1a; both signals skipped only by --force).
  // - What such a migrate could collide with is small: `ensureDataTree`
  //   (mkdirs) mkdir -p's the tree and writes a `.gitignore` when none
  //   exists. It never deletes, moves, or overwrites anything. Empty
  //   scaffolding it materializes under a concurrent migrate's destination is
  //   repaired away by that migrate's own recursively-empty check
  //   (dataMigrate.ts); the worst case is a nested dir arriving between that
  //   check and the rename, so the rename fails ENOTEMPTY and the migrate
  //   aborts — after printing a receipt of the pairs that DID land, and with
  //   its resume driven off the filesystem, so a re-run picks up exactly the
  //   stragglers. No data is lost in either direction.
  // - The genuinely destructive startup steps — recoverOrphansFn and pruneFn
  //   below — were never under migrate.lock at all. That is a larger,
  //   pre-existing exposure, deliberately out of scope here rather than
  //   anything this window introduces.
  mkdirs(cfg);
  // Skill links (Task 3): symlink the packaged skills/ dir into <dataDir>/skills
  // and fan out per-harness junco-dispatch links, right after the data tree
  // exists (the mount's parent) and before anything else touches it. Never
  // throws — failures land as failure-kind entries in the report
  // (isSkillLinkFailure), never exceptions. An all-quiet run (the common case
  // once links are established) logs nothing.
  const linkReport = ensureSkillLinksFn(cfg);
  // All-quiet contract: "ok" (already a valid link) and "harness-not-installed"
  // (never linked here, by design) are the steady-state outcomes once links
  // are established — log nothing for those. Anything else (created/repaired/
  // any failure kind) is news worth a line.
  const noisy = linkReport.entries.filter(
    (e) => e.kind !== "ok" && e.kind !== "harness-not-installed",
  );
  if (noisy.length > 0) {
    log.info("skill links ensured", { entries: noisy });
  }
  // Stamp the start time once the queue dirs exist; the health server reports
  // uptime off this. Idempotent — first call wins.
  metrics.markStarted();
  // Unconditional (Task 3): the file exists with the new pid immediately,
  // rather than waiting up to METRICS_WRITE_INTERVAL_MS for the first
  // debounced poll-tick write.
  metricsWriter.flush(metrics.snapshot());
  recoverOrphansFn(cfg);
  pruneFn(cfg.worktreeRoot);
  await waitForEndpointFn(cfg, stopFlag);

  log.info("worker online", {
    pid: process.pid,
    queue: cfg.queueRoot,
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
        readinessProbe: cachedReachable,
        gateStatus: () => gate.status(),
        spendStatus: () => ({
          todayUsd: spend.todayUsd(),
          dailyBudgetUsd: activeCfg().dailyBudgetUsd,
        }),
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
      await runScheduler(activeCfg(), stopFlag, opts, {
        claimFn: deps.claimFn,
        executeFn: deps.executeFn,
        sleep: deps.sleep,
        configHolder: deps.configHolder,
        readyFn: gatedReady,
        maybeBridgeSweepFn: async () => {
          await maybeBridgeSweep();
          await maybeOutboxDrain();
          await maybeDepSweep();
        },
        reporter,
        gate,
        spend,
        metricsWriter,
      });
    } else {
      let idleAnnounced = false;
      while (!stopFlag.requested) {
        metrics.recordPoll();
        metricsWriter.write(metrics.snapshot());
        await maybeBridgeSweep();
        await maybeOutboxDrain();
        await maybeDepSweep();
        // A stop can land during the bridge sweep (multi-repo gh calls,
        // seconds), the outbox drain, or the dependency sweep — re-check
        // before claiming brand-new work, mirroring the scheduler's per-claim
        // check above. Without this a post-signal claim starts up to
        // timeout_minutes of new work.
        if (stopFlag.requested) break;
        const handled = await runOnceFn(activeCfg());
        if (handled) {
          idleAnnounced = false;
          if (opts.once) break;
          continue;
        }
        if (!idleAnnounced) {
          log.info("idle");
          idleAnnounced = true;
        }
        await sleep(activeCfg().pollIntervalSeconds, stopFlag);
      }
    }
  } finally {
    // Always tear the health server down, even if the loop throws. It stays up
    // for the whole in-flight task during a graceful shutdown (close runs after
    // the loop exits), but a mid-loop throw must not leak the bound port to an
    // embedded/test caller — we don't rely on process exit to free it.
    if (health) await health.close();
    // Unconditional (Task 3): the finally runs even on a mid-loop throw, which
    // is exactly when an out-of-process reader most wants the last known
    // state — a debounced write() could otherwise sit inside the window and
    // never land.
    metricsWriter.flush(metrics.snapshot());
  }

  log.info("worker exiting cleanly");
}

/** Default bridge sweep: process-lifetime state (label/origin caches) in a
 * closure. Also wires the outbox-flush metrics hook: pollGithubInbox flushes
 * the outbox before its repo loop and reports the result via onFlush, which
 * we route to the metrics singleton here — the same layer that records
 * recordBridgeSweep off this function's own return value, one call site up
 * in maybeBridgeSweep. depth is recomputed per flush (outboxDepth is a cheap
 * readdir) so the gauge reflects what's left in the queue right now. */
function defaultBridgeSweep(): (cfg: Config) => Promise<number> {
  const state = newBridgeState();
  return (cfg: Config) =>
    pollGithubInbox(cfg, state, {
      onFlush: (fr) => metrics.recordOutboxFlush(fr, outboxDepth(cfg)),
    });
}
