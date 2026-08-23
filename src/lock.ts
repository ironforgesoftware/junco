/**
 * Single-instance daemon lock — a thin, signature-stable facade over the
 * shared hardened pidfile helper (src/pidfileLock.ts), which also backs the
 * outbox flush lock.
 *
 * This is a portability adaptation of Python's fcntl.flock approach: flock
 * auto-releases on process death; a bare pidfile does not. We compensate by
 * detecting stale pidfiles (owner process is dead or its pid was recycled) and
 * stealing them atomically. See pidfileLock.ts for the mechanics.
 */

import { dirname, join, resolve } from "node:path";
import type { PidfileLock } from "./pidfileLock.js";
import { acquirePidfileLock, readPidfileHolder, getProcessStartTime } from "./pidfileLock.js";
import type { Config } from "./types.js";

// Re-exported so existing importers (and tests) keep resolving it from ./lock.
export { getProcessStartTime };

/**
 * Every pidfile path the daemon singleton uses, derived once (#310).
 *
 * Until this existed, NINE expressions across six modules (cli, doctor,
 * ensureDaemon, restartCmd, updateCmd, dataMigrateCmd) spelled the daemon
 * pidfile path by hand — and they had already drifted: doctor's omitted the
 * `resolve()` the other eight carried, so for a RELATIVE config path it
 * probed a cwd-relative file no daemon ever writes and reported "not running"
 * against a live one. (`join` normalizes `..` on its own, which is why the
 * two spellings agreed everywhere else and the drift stayed invisible.)
 * Every reader of these paths must agree with the writer or the check
 * silently answers the wrong question, so there is one spelling and it lives
 * here, beside the primitive that takes the locks.
 */
export interface DaemonLockPaths {
  /** Beside the resolved config — unchanged, the existing worker.lock. */
  worker: string;
  /** The shared data root's claim. NEVER named worker.lock (see below). */
  dataTree: string;
  /** The shared queue root's claim. */
  queue: string;
}

/**
 * The two shared-tree claims are deliberately NOT named `worker.lock`, and
 * they are deliberately named differently FROM EACH OTHER.
 *
 * On a default install `dataDir === dirname(configPath)` and
 * `queueRoot === <dataDir>/queue`, so a claim reusing the `worker.lock` name
 * would land on the file `junco start` just locked: the daemon would contend
 * with itself and refuse to start. Distinct basenames make that impossible by
 * construction rather than by an invariant someone has to remember — and they
 * keep the two claims distinct even in the pathological layout where a legacy
 * `vaultRoot` puts `queueRoot` at the same directory as `dataDir`.
 */
const DATA_TREE_CLAIM = "daemon-tree.lock";
const QUEUE_CLAIM = "daemon-queue.lock";

/**
 * The data-root claim for an ARBITRARY root, not necessarily this config's.
 *
 * `daemonLockPaths` below answers "what would I claim?"; these two answer
 * "what would a daemon that resolved THAT root have claimed?" — the question
 * `junco data migrate` has to ask, because it walks several roots in one run
 * (this config's `dataDir`, the relocation target, the fixed legacy path) and
 * a daemon that has already flipped its own resolution holds its claim at
 * whichever one IT resolved. Exported rather than letting the caller spell
 * `join(root, "daemon-tree.lock")` for the same reason `workerLockPath`
 * exists: every reader of a claim must agree with the writer byte for byte,
 * `resolve()` included, or the probe silently answers the wrong question
 * (#310).
 */
export function daemonTreeClaimPath(dataRoot: string): string {
  return join(resolve(dataRoot), DATA_TREE_CLAIM);
}

/** The queue-root claim for an arbitrary queue root — see daemonTreeClaimPath. */
export function daemonQueueClaimPath(queueRoot: string): string {
  return join(resolve(queueRoot), QUEUE_CLAIM);
}

/**
 * The daemon-singleton pidfile: `worker.lock` beside the RESOLVED config
 * (mirroring Python's `args.config.resolve().parent / "worker.lock"`).
 *
 * Split out from `daemonLockPaths` because `cli.ts`'s FTUE gate reads this
 * path before any config has been loaded — it is the cheapest "is a daemon
 * live?" probe there is, and needs no `Config` at all. Making the whole
 * helper require one would have forced a config load earlier in `start`,
 * which is a behaviour change, not a refactor.
 *
 * `resolve()` is load-bearing, not decoration: it normalizes `..` segments so
 * two processes that name the same config file differently still compute the
 * same lock path, and it makes a relative config path absolute rather than
 * cwd-relative at each separate use. (`resolveConfigPath` rejects a relative
 * `JUNCO_CONFIG` outright for the same reason — see config.ts.)
 */
export function workerLockPath(configPath: string): string {
  return join(dirname(resolve(configPath)), "worker.lock");
}

/**
 * All three claims. `worker` is exactly `workerLockPath(configPath)`; the two
 * tree claims sit at the roots the daemon actually contends for — shared
 * state that two daemons started from two DIFFERENT config paths can still
 * collide over, which `worker.lock` alone cannot see (#310).
 *
 * The roots are `resolve()`d for the same reason the config path is: the
 * claim is a rendezvous point between processes, so it has to have one
 * spelling. (`assembleConfig` expands `~` in these but does not normalize
 * them further.)
 */
export function daemonLockPaths(
  configPath: string,
  cfg: Pick<Config, "dataDir" | "queueRoot">,
): DaemonLockPaths {
  return {
    worker: workerLockPath(configPath),
    dataTree: daemonTreeClaimPath(cfg.dataDir),
    queue: daemonQueueClaimPath(cfg.queueRoot),
  };
}

export interface SingletonLock {
  /** The lock file path. */
  path: string;
  /** Release the lock (best-effort unlink if we still own it). Idempotent. */
  release(): void;
}

/** Injectable side effects (tests only; production callers omit this). */
export interface LockDeps {
  /** Process-identity lookup — see getProcessStartTime. Default: getProcessStartTime. */
  getProcessStartTimeFn?: (pid: number) => string | null;
}

/**
 * Acquire a single-instance lock using a pidfile + liveness check.
 *
 * Returns a SingletonLock on success, or null if another live process holds it.
 */
export function acquireSingletonLock(lockPath: string, deps: LockDeps = {}): SingletonLock | null {
  const lock: PidfileLock | null = acquirePidfileLock(lockPath, deps);
  return lock;
}

/**
 * Who holds the lock? The pid in the pidfile when that process is alive AND
 * matches the recorded start-time discriminator (a recycled pid is not the
 * holder), else null. Read-only — never mutates the lock (used by
 * `junco status`/`doctor`).
 */
export function readLockHolder(lockPath: string, deps: LockDeps = {}): number | null {
  return readPidfileHolder(lockPath, deps);
}
