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

import type { PidfileLock } from "./pidfileLock.js";
import { acquirePidfileLock, readPidfileHolder, getProcessStartTime } from "./pidfileLock.js";

// Re-exported so existing importers (and tests) keep resolving it from ./lock.
export { getProcessStartTime };

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
