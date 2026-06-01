import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface SingletonLock {
  /** The lock file path. */
  path: string;
  /** Release the lock (best-effort unlink if we still own it). Idempotent. */
  release(): void;
}

/**
 * Acquire a single-instance lock using a pidfile + liveness check.
 *
 * This is a portability adaptation of Python's fcntl.flock approach:
 * flock auto-releases on process death; a bare pidfile does not. We compensate
 * by detecting stale pidfiles (owner process is dead) and stealing them.
 *
 * Returns a SingletonLock on success, or null if another live process holds it.
 */
export function acquireSingletonLock(lockPath: string): SingletonLock | null {
  mkdirSync(dirname(lockPath), { recursive: true });

  const result = tryCreate(lockPath);
  if (result !== "EEXIST") {
    // Created fresh, or unexpected error was rethrown inside tryCreate
    return result;
  }

  // EEXIST: file already present — check if the owner is alive or stale
  const isStale = checkStale(lockPath);
  if (!isStale) {
    // Live process holds the lock
    return null;
  }

  // Stale: unlink and retry once
  try {
    unlinkSync(lockPath);
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      // Unexpected error — another process may have grabbed it; bail out
      return null;
    }
    // ENOENT: another process already stole it, that's fine; retry will settle it
  }

  const retryResult = tryCreate(lockPath);
  if (retryResult === "EEXIST") {
    // Another process raced us and won
    return null;
  }
  // Either a SingletonLock or an unexpected error was rethrown
  return retryResult;
}

/**
 * Attempt to create the pidfile atomically.
 *
 * Returns "EEXIST" if the file already exists, the SingletonLock on success,
 * or rethrows any other unexpected error.
 */
function tryCreate(lockPath: string): SingletonLock | "EEXIST" {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL | O_WRONLY
  } catch (e: any) {
    if (e.code === "EEXIST") {
      return "EEXIST";
    }
    throw e;
  }

  const ownPid = process.pid;
  const content = String(ownPid) + "\n";
  writeSync(fd, content);
  closeSync(fd);

  return buildLock(lockPath, ownPid);
}

/**
 * Returns true if the pidfile is stale (owner process is dead or pid unreadable).
 * Returns false if the owner is alive (or we cannot determine safely).
 */
function checkStale(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch {
    // File vanished between the EEXIST and now — treat as stale so the retry can proceed
    return true;
  }

  const pid = parseInt(raw.trim().split("\n")[0] ?? "", 10);
  if (!Number.isInteger(pid) || isNaN(pid) || pid <= 0) {
    // Unparseable — treat as stale
    return true;
  }

  try {
    process.kill(pid, 0);
    // Signal 0 succeeded: the process is alive
    return false;
  } catch (e: any) {
    if (e.code === "ESRCH") {
      // No such process — stale
      return true;
    }
    if (e.code === "EPERM") {
      // Process exists but owned by another user — treat as alive (safe choice)
      return false;
    }
    // Unexpected error; treat as alive (safe choice)
    return false;
  }
}

function buildLock(lockPath: string, ownPid: number): SingletonLock {
  let released = false;

  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;

      // Only unlink if we still own the file
      let raw: string;
      try {
        raw = readFileSync(lockPath, "utf-8");
      } catch {
        // File is gone (ENOENT) or unreadable — nothing to do
        return;
      }

      const filePid = parseInt(raw.trim().split("\n")[0] ?? "", 10);
      if (filePid !== ownPid) {
        // File was overwritten by someone else — do not unlink
        return;
      }

      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort; ignore ENOENT and other errors
      }
    },
  };
}
