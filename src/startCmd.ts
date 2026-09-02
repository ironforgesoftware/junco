/**
 * `junco start` — the foreground daemon: claim the three single-instance locks,
 * install signal handlers, wire the config watcher and the provider gate, then
 * hand off to mainLoop and hand every claim back on the way out.
 *
 * Extracted verbatim from cli.ts's `start` branch (#351) so the daemon
 * entrypoint is unit-testable without going through argv parsing. Every side
 * effect is a `StartCmdDeps` seam; the defaults wire the real implementations.
 */

import { dirname } from "node:path";
import type { Config } from "./types.js";
import type { SingletonLock } from "./lock.js";
import { acquireSingletonLock, daemonLockPaths, readLockHolder } from "./lock.js";
import type { PidfileLock } from "./pidfileLock.js";
import { acquirePidfileLock } from "./pidfileLock.js";
import { loadConfig, isLoopbackHost, assembleConfig, configDeprecations } from "./config.js";
import type { ConfigParsed } from "./config.js";
import { withBotAuth } from "./ghAuth.js";
import {
  StopFlag,
  installSignalHandlers,
  mainLoop,
  makeProviderGate,
  type MainLoopDeps,
} from "./daemon.js";
import { makeConfigHolder, watchConfig, type ConfigHolder } from "./configWatcher.js";
import { log, setLogLevel } from "./logging.js";
import { setupLogOutputs } from "./daemonLogs.js";

/** Every side effect `start` performs, injectable so a test never takes a real
 *  lock, watches a real file, or runs a real daemon loop. `CliDeps` extends
 *  this, so `run(['start'], deps)` forwards the same seams unchanged. */
export interface StartCmdDeps {
  loadConfigFn?: (path: string) => Config;
  acquireLockFn?: (lockPath: string) => SingletonLock | null;
  /** The shared-tree claim `start` takes in ADDITION to worker.lock (#310).
   *  worker.lock is keyed to the config directory, so two daemons launched
   *  from two different config files never see each other's pidfile even when
   *  both configs resolve to the same data root — and therefore the same
   *  queue. This claim lives IN that shared root, which both of them can see.
   *  Default: the real acquirePidfileLock (the same primitive migrate.lock
   *  uses). Its own seam rather than acquireLockFn's so a test can drive the
   *  two claims independently — and so a fake worker lock is never released
   *  twice. */
  acquireTreeLockFn?: (lockPath: string) => PidfileLock | null;
  /** The queue-root claim `start` takes alongside the data-root one (#310).
   *  Its own root because a legacy `vaultRoot` puts `queueRoot` OUTSIDE
   *  `dataDir`: two configs with two different data roots can still name one
   *  shared vault queue, which neither worker.lock nor the data-root claim can
   *  see — and the queue is the shared state whose corruption actually loses
   *  work. Default: the real acquirePidfileLock. Its own seam rather than
   *  acquireTreeLockFn's so a test can drive the two claims independently and
   *  no fake is ever released twice. */
  acquireQueueLockFn?: (lockPath: string) => PidfileLock | null;
  installSignalHandlersFn?: (stopFlag: StopFlag) => () => void;
  mainLoopFn?: (
    cfg: Config,
    stopFlag: StopFlag,
    opts: { once?: boolean },
    deps?: MainLoopDeps,
  ) => Promise<void>;
  /** Resolve (and attach) the daemon's bot-account GitHub auth context onto
   * Config before `start` proceeds (Task 6, gh-bot-account spec) — cli.ts
   * inherits this seam for `run-once` and `outbox flush` too. A disabled
   * botAccount returns cfg unchanged; enabled-but-unauthed throws — the caller
   * must refuse to start BEFORE the lock is taken or logs are set up.
   * Default: the real withBotAuth. (Typed monomorphically over Config rather
   * than `typeof withBotAuth` — that signature is generic over
   * `C extends Pick<Config, "botAccount" | "ghBin">`, which a plain test fake
   * typed at `Config` can't satisfy; the real generic withBotAuth still
   * satisfies this narrower shape.) */
  withBotAuthFn?: (cfg: Config) => Promise<Config>;
  /** Config hot-reload watcher (Task 6). Injected so tests never touch a real
   * fs.watch on a config path that may not exist on disk. Default: the real
   * watchConfig. The optional third param carries `onApplied` (Task 10) — the
   * daemon wires it to the shared provider gate's `clearLatched()` so a
   * successful reload (bad key fixed, quota lifted) drops a stale latch
   * without a restart — and `assembleFn` (Task 6), which the daemon wires to
   * re-attach the startup-resolved bot auth context in lockstep with each
   * reload's botAccount.enabled. */
  watchConfigFn?: (
    configPath: string,
    holder: ConfigHolder,
    deps?: { onApplied?: () => void; assembleFn?: (d: ConfigParsed) => Config },
  ) => { close(): void };
  /** Who holds a daemon pidfile? Read-only, path-parameterized: `start` asks
   *  it about the shared-root claim it just failed to take, so the refusal can
   *  name the pid (#310), and cli.ts inherits the seam for the FTUE gate's
   *  question about the pidfile beside the config (#273). Default: the real
   *  readLockHolder. Injected so a unit test never reads the developer's own
   *  live `~/.junco/worker.lock`. */
  readLockHolderFn?: (lockPath: string) => number | null;
}

/** The two shared roots `start` claims, and the wording each one needs. Keyed
 *  by the label that names the root in the headline AND in the field column,
 *  so the two can never drift apart. */
const SHARED_ROOT_REFUSALS = {
  "data root": {
    why:
      `That daemon resolved a DIFFERENT config file, so its worker.lock sits beside\n` +
      `its own config and this process can never see it — but both configs resolve to\n` +
      `the same data root, so both daemons would poll one queue, claim the same\n` +
      `tickets and write the same worktrees. Two config files are not two junco\n` +
      `installs: the data root is what makes them one.\n`,
    remedy: `give this config a data root of its own\n(\`dataDir\`), then start again.`,
  },
  "queue root": {
    why:
      `That daemon resolved a DIFFERENT config file, so its worker.lock sits beside\n` +
      `its own config and this process can never see it — and its data root can differ\n` +
      `from this one, so the data-root claim does not collide either. What the two\n` +
      `configs share is the QUEUE: both daemons would poll one inbox, claim the same\n` +
      `tickets and finalize over each other's work. A legacy \`vaultRoot\` queue lives\n` +
      `outside the data root, which is exactly how two otherwise-separate installs end\n` +
      `up on one queue.\n`,
    remedy: `give this config a queue of its own\n(\`vaultRoot\`, or a data root that owns its queue), then start again.`,
  },
} as const;

/**
 * Operator-facing refusal when another daemon already claims one of the shared
 * roots this one resolved (#310).
 *
 * The whole difficulty of this failure is that it looks impossible from the
 * operator's chair: two config files, two `junco start`s, two `worker.lock`s
 * that genuinely do not collide — and yet only one may run. So the message
 * does not just say "already running"; it names the shared root, the claim
 * file, and THIS config, and states the reason the two are not independent.
 *
 * One builder for both roots so the two refusals are the same shape by
 * construction — an operator who has seen one can read the other.
 *
 * `holderPid` is null when the claim was taken but its owner could not be
 * identified (it was released between the failed acquire and the read, or the
 * pidfile is unreadable). Never print "pid null" — say the pid is unavailable
 * and keep the rest of the diagnosis, which is still correct.
 *
 * The closing line states the exit code and why (final review F1). This
 * refusal is loud in the MESSAGE, not in the status code: the population that
 * hits it is the one running under launchd/systemd, whose units restart on
 * failure (`service.ts`), so a non-zero exit here buys nothing and costs a
 * 30-second respawn loop that never ends. An operator who sees `echo $?` == 0
 * after twelve lines of refusal deserves to be told that was deliberate.
 */
function sharedRootClaimRefusal(args: {
  kind: keyof typeof SHARED_ROOT_REFUSALS;
  root: string;
  claimPath: string;
  configPath: string;
  holderPid: number | null;
}): string {
  const { kind, root, claimPath, configPath, holderPid } = args;
  const { why, remedy } = SHARED_ROOT_REFUSALS[kind];
  const heldBy = holderPid === null ? "another live process (pid unavailable)" : `pid ${holderPid}`;
  const stopIt =
    holderPid === null
      ? "Stop the daemon holding the claim"
      : `Stop that daemon (pid ${holderPid})`;
  // Field labels share one column (14) so both refusals line up identically.
  const field = (label: string, value: string): string => `  ${`${label}:`.padEnd(14)}${value}\n`;
  return (
    `junco: refusing to start — another junco daemon already claims this ${kind}.\n\n` +
    field(kind, root) +
    field("claimed by", heldBy) +
    field("this config", configPath) +
    field("claim file", claimPath) +
    `\n${why}` +
    // The remedy starts on its own line so the advice stays inside 80 columns
    // however many digits the pid has.
    `\n${stopIt}, or ${remedy}\n` +
    `\nThis daemon did NOT start. Exiting 0 on purpose: a supervisor (launchd/systemd)\n` +
    `restarts a unit that exits non-zero, and retrying a misconfiguration every 30s\n` +
    `forever is not a repair — the unit stays down until you fix the config above.\n`
  );
}

/** Run the daemon in the foreground. Returns an exit code; never calls
 *  process.exit. */
export async function runStartCommand(
  configPath: string,
  opts: { once?: boolean } = {},
  deps: StartCmdDeps = {},
): Promise<number> {
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const acquireLockFn = deps.acquireLockFn ?? acquireSingletonLock;
  // The shared-tree claim (#310) — the same pidfile primitive migrate.lock
  // takes, addressed at the resolved data root instead of the config dir.
  const acquireTreeLockFn = deps.acquireTreeLockFn ?? ((p: string) => acquirePidfileLock(p));
  const acquireQueueLockFn = deps.acquireQueueLockFn ?? ((p: string) => acquirePidfileLock(p));
  const installSignalHandlersFn = deps.installSignalHandlersFn ?? installSignalHandlers;
  const mainLoopFn = deps.mainLoopFn ?? mainLoop;
  const watchConfigFn = deps.watchConfigFn ?? watchConfig;
  // Wrapped (rather than `deps.withBotAuthFn ?? withBotAuth` inline) because
  // withBotAuth is generic over `C extends Pick<Config, ...>` — calling a
  // union of that generic signature and a monomorphic-over-Config fake infers
  // C from the constraint, not from the Config argument, and fails to
  // typecheck. A monomorphic wrapper sidesteps it.
  const withBotAuthFn = deps.withBotAuthFn ?? ((c: Config) => withBotAuth(c));

  const cfg = loadConfigFn(configPath);

  // Refuse-to-start guard (Task 6): resolve the bot-account auth context
  // BEFORE the singleton lock is taken or worker.log is rotated — a bad or
  // expired bot login must not silently fall back to the operator's own
  // identity, and its failure must leave no trace of a started daemon.
  let cfgAuthed: Config;
  try {
    cfgAuthed = await withBotAuthFn(cfg);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  setLogLevel(cfgAuthed.logLevel);

  // Every daemon pidfile path — one spelling for every reader (lock.ts).
  const lockPaths = daemonLockPaths(configPath, cfgAuthed);
  const lockPath = lockPaths.worker;

  const lock = acquireLockFn(lockPath);
  if (lock === null) {
    log.warn("another instance holds the lock; exiting", { lockPath });
    // Exit 0 — process supervisor must NOT respawn-loop on a "lock held" situation.
    // We never touched worker.log (the rotating sink is set up below, only once
    // we hold the lock), so a lock-losing start can't rotate a live daemon's log.
    return 0;
  }

  // Both shared-root refusals below name the holder's pid; resolved once so
  // the two read the same way and the same injected probe answers for both.
  const readHolderFn = deps.readLockHolderFn ?? readLockHolder;

  // The two tree claims are ACQUIRED INSIDE this try, not above it (final
  // review F2): `acquirePidfileLock` mkdirs and writes, so it can throw
  // (EACCES on a root this user cannot write, EROFS, ENOSPC) — and a throw
  // one statement above the `finally` would leak exactly the pidfiles that
  // `finally` exists to hand back. Both start null so the `finally` can tell
  // "never taken" from "held", which is also what makes an early `return`
  // from a refusal below correct without a manual release.
  let treeLock: PidfileLock | null = null;
  let queueLock: PidfileLock | null = null;
  try {
    // The data-root claim (#310) — taken IMMEDIATELY after worker.lock and
    // before the log sink, because a peer holding this claim resolved the
    // same dataDir and is therefore writing the very worker.log we would
    // rotate. worker.lock cannot catch that peer: it is keyed to the config
    // directory, and the peer's config lives somewhere this process has
    // never heard of.
    treeLock = acquireTreeLockFn(lockPaths.dataTree);
    if (treeLock === null) {
      process.stderr.write(
        sharedRootClaimRefusal({
          kind: "data root",
          root: dirname(lockPaths.dataTree),
          claimPath: lockPaths.dataTree,
          configPath,
          holderPid: readHolderFn(lockPaths.dataTree),
        }),
      );
      // Exit 0, SAME as the worker.lock case above and for the same reason
      // (final review F1): the rendered service units restart on failure —
      // launchd `KeepAlive{SuccessfulExit:false}` + `ThrottleInterval 30`,
      // systemd `Restart=on-failure` + `RestartSec=30` (service.ts) — and
      // the operator most likely to hit THIS refusal is the one running a
      // second supervised unit, i.e. #310's own population. Exiting 1 gave
      // them a unit that refused, died and respawned every 30 seconds
      // forever, writing the refusal ~2,880 times a day and re-running
      // `withBotAuth`'s `gh` subprocess each cycle. Loudness belongs in the
      // message (which names the root, the claim file, the holder's pid and
      // now the exit code itself); the status code's only real consumer here
      // is the supervisor, and its correct instruction is "stay down".
      return 0;
    }

    // The queue-root claim (#310) — a SEPARATE root, not a formality. A
    // legacy `vaultRoot` puts queueRoot outside dataDir, so two configs with
    // two different data roots can still name one shared vault queue:
    // worker.lock misses it (config-dir keyed), the data-root claim misses
    // it (the roots differ), and both daemons then poll one inbox. The two
    // claims can never be the same file — `daemon-tree.lock` vs
    // `daemon-queue.lock` (lock.ts) — so there is nothing to dedupe even
    // when queueRoot IS dataDir.
    queueLock = acquireQueueLockFn(lockPaths.queue);
    if (queueLock === null) {
      process.stderr.write(
        sharedRootClaimRefusal({
          kind: "queue root",
          root: dirname(lockPaths.queue),
          claimPath: lockPaths.queue,
          configPath,
          holderPid: readHolderFn(lockPaths.queue),
        }),
      );
      return 0; // see the data-root branch above for why 0 and not 1
    }

    // All three claims are held from here on: every exit path below —
    // return, throw, or fatal — runs the outer finally that hands them back.
    // A claim that outlives its process is a stale pidfile the next start
    // has to steal.
    //
    // Set up the rotating worker.log sink now that we own the daemon slot —
    // rotation is the lock holder's exclusive job (#76).
    const teardownLogs = setupLogOutputs(cfgAuthed, { rotate: true });

    // Loud warning when /health binds a non-loopback address (#44): the metrics
    // body is unauthenticated and leaks in-flight ticket ids + operational
    // metadata to the whole network. `junco doctor` mirrors this warning.
    // No truthy `&& cfg.healthHost` guard: an empty/unparseable host is
    // non-loopback (isLoopbackHost("") → false), so a value that bypassed the
    // config normalization still triggers the warning instead of evading it (#71).
    if (cfgAuthed.healthEnabled && !isLoopbackHost(cfgAuthed.healthHost)) {
      log.warn("health bind is not loopback — /health is UNAUTHENTICATED and exposed", {
        healthHost: cfgAuthed.healthHost,
        healthPort: cfgAuthed.healthPort,
        advice: "bind healthHost to 127.0.0.1 unless it is firewalled",
      });
    }

    // Deprecated legacy config keys (Unified Data Root spec §5): one log.warn
    // per set key, logged once at startup — `junco doctor` mirrors the same
    // list as a "deprecated config keys" finding.
    for (const line of configDeprecations(cfgAuthed)) {
      log.warn(line);
    }

    const stopFlag = new StopFlag();
    const uninstall = installSignalHandlersFn(stopFlag);

    // Live-reload (Task 6): the holder starts seeded with the config we just
    // loaded; the watcher re-parses config.json on change and swaps in a new
    // Config, which mainLoop's per-iteration reads pick up without a restart.
    // Hot-reload is optional — a watch-start failure (EMFILE/ENOSPC/EACCES/
    // unsupported FS) must NOT crash the daemon, matching the health server's
    // graceful-degrade pattern below: log a warning and continue with the
    // holder seeded but never updated (hot-reload disabled until restart).
    // Built BEFORE the gate so the gate can read retryBackoffSeconds live off
    // holder.current (a reload:"live" lever — #180).
    const holder = makeConfigHolder(cfgAuthed);

    // Provider gate (Task 10): one instance shared between mainLoop's claim/
    // health wiring and the hot-reload watcher below, so a successful config
    // edit (bad key fixed, quota lifted, model id corrected) clears a stale
    // latch without requiring a restart. The backoff getter re-reads the live
    // retryBackoffSeconds so gate backoff windows honor a hot-reload too (#180).
    const gate = makeProviderGate(cfgAuthed, () => holder.current.retryBackoffSeconds);

    let watcher: { close(): void } | null = null;
    try {
      watcher = watchConfigFn(configPath, holder, {
        onApplied: () => gate.clearLatched(),
        // Hot reload must not silently drop (or fabricate) the bot identity:
        // re-attach the STARTUP-resolved context while the file still enables
        // it; a flip either way is a restart-kind lever (configLevers).
        assembleFn: (d) => {
          const next = assembleConfig(d);
          return next.botAccount.enabled && cfgAuthed.ghAuth
            ? { ...next, ghAuth: cfgAuthed.ghAuth }
            : next;
        },
      });
    } catch (e) {
      log.warn("config watcher failed to start; hot-reload disabled until restart", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    try {
      await mainLoopFn(
        cfgAuthed,
        stopFlag,
        { once: opts.once === true },
        { configHolder: holder, gate },
      );
      return 0;
    } catch (e) {
      log.error("fatal error in main loop", {
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
      return 1;
    } finally {
      if (watcher) watcher.close();
      uninstall();
      teardownLogs();
    }
  } finally {
    // ONE finally for all three claims (#310), and the only place any of
    // them is released — so a throw anywhere in startup (a signal-handler
    // install, a log sink, the provider gate) hands them all back instead of
    // leaving a stale pidfile for the next start to steal. Since F2 the
    // region also covers the two ACQUISITIONS, so a throw from
    // `acquirePidfileLock` itself no longer leaks whatever is already held —
    // hence the null guards: a claim that was never taken has nothing to
    // hand back. Order mirrors acquisition, innermost first.
    queueLock?.release();
    treeLock?.release();
    lock.release();
  }
}
