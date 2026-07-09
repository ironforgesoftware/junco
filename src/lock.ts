import { mkdirSync, writeFileSync, linkSync, renameSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

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
 * Opaque process-identity discriminator: the process start time as reported by
 * `ps -p <pid> -o lstart=` (supported on both macOS and Linux). Two reads for
 * the same live process compare equal; a recycled pid yields a different
 * string. Returns null when the pid is dead or the lookup fails (unknown).
 */
export function getProcessStartTime(pid: number): string | null {
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8" });
    if (res.error || res.status !== 0) return null;
    const out = res.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Acquire a single-instance lock using a pidfile + liveness check.
 *
 * This is a portability adaptation of Python's fcntl.flock approach:
 * flock auto-releases on process death; a bare pidfile does not. We compensate
 * by detecting stale pidfiles (owner process is dead) and stealing them.
 *
 * The pidfile records `<pid>\n<process start time>\n`. It is stale when the
 * pid is dead, or when the pid is alive but its start time mismatches the
 * recorded one — a recycled pid (which would otherwise block startup forever).
 * A missing/unknown start time falls back to pid liveness alone (safe-choice
 * bias: alive). Creation is atomic including content (temp file + link), and
 * stealing moves the stale file aside by rename with post-move verification —
 * concurrent starters settle on exactly one winner. The residual TOCTOU
 * (>= 3 starters interleaving inside two nested sub-millisecond windows, see
 * the restore path below) is accepted for a per-user daemon.
 *
 * Returns a SingletonLock on success, or null if another live process holds it.
 */
export function acquireSingletonLock(lockPath: string, deps: LockDeps = {}): SingletonLock | null {
  mkdirSync(dirname(lockPath), { recursive: true });

  const result = tryCreate(lockPath, deps);
  if (result !== "EEXIST") {
    // Created fresh, or unexpected error was rethrown inside tryCreate
    return result;
  }

  // EEXIST: file already present — check if the owner is alive or stale
  const isStale = checkStale(lockPath, deps);
  if (!isStale) {
    // Live process holds the lock
    return null;
  }

  // Stale: atomically move the stale pidfile aside to a unique name so that
  // exactly one stealer proceeds — the racing loser's rename fails with
  // ENOENT. Never unlink the lock name in place: that could delete a racing
  // winner's freshly created pidfile and admit two live daemons.
  const asidePath = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockPath, asidePath);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      // A racing stealer already moved it aside; the atomic create below
      // settles who wins.
      const settled = tryCreate(lockPath, deps);
      return settled === "EEXIST" ? null : settled;
    }
    // Unexpected error — bail out (safe choice)
    return null;
  }

  // Post-move verification (race-free: the aside name is private to us).
  // If a racing stealer completed its whole steal — rename aside + fresh
  // create — between our staleness judgment and our rename, we just moved the
  // WINNER'S live pidfile aside, not the stale one. Restore it atomically and
  // lose. Only if what we hold is itself stale do we discard it and proceed.
  let asideRaw: string | null;
  try {
    asideRaw = readFileSync(asidePath, "utf-8");
  } catch {
    asideRaw = null;
  }
  if (asideRaw === null || !checkStaleContent(asideRaw, deps)) {
    try {
      linkSync(asidePath, lockPath); // atomic restore; EEXIST if re-claimed meanwhile
    } catch {
      // Name already re-claimed by another starter — nothing safe left to do
    }
    bestEffortUnlink(asidePath);
    return null;
  }
  bestEffortUnlink(asidePath);

  const retryResult = tryCreate(lockPath, deps);
  if (retryResult === "EEXIST") {
    // Another process raced us and won
    return null;
  }
  // Either a SingletonLock or an unexpected error was rethrown
  return retryResult;
}

/**
 * Attempt to create the pidfile atomically — content included.
 *
 * The full content is written to a unique temp file first, then the lock name
 * is claimed with linkSync (hard link → EEXIST for the loser, like O_EXCL).
 * The lock name therefore never exists with empty/partial content, so a
 * concurrent reader can never misparse a mid-write pidfile as stale.
 *
 * Returns "EEXIST" if the file already exists, the SingletonLock on success,
 * or rethrows any other unexpected error.
 */
function tryCreate(lockPath: string, deps: LockDeps): SingletonLock | "EEXIST" {
  const ownPid = process.pid;
  const content = pidfileContent(ownPid, deps);

  const tmpPath = `${lockPath}.${ownPid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmpPath, content);
  try {
    linkSync(tmpPath, lockPath); // atomic claim: fails with EEXIST if taken
  } catch (e: any) {
    bestEffortUnlink(tmpPath);
    if (e.code === "EEXIST") {
      return "EEXIST";
    }
    throw e;
  }
  bestEffortUnlink(tmpPath);

  return buildLock(lockPath, ownPid);
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

/** Pidfile format: `<pid>\n<start time>\n` ("" when our own start time is unknown). */
function pidfileContent(ownPid: number, deps: LockDeps): string {
  const getStartTime = deps.getProcessStartTimeFn ?? getProcessStartTime;
  const startTime = getStartTime(ownPid) ?? "";
  return `${ownPid}\n${startTime}\n`;
}

/**
 * Returns true if the pidfile is stale (owner process is dead, pid unreadable,
 * or the pid has been recycled by an unrelated process — detected via the
 * start-time discriminator). Returns false if the owner is alive (or we
 * cannot determine safely).
 */
function checkStale(lockPath: string, deps: LockDeps): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch {
    // File vanished between the EEXIST and now — treat as stale so the retry can proceed
    return true;
  }
  return checkStaleContent(raw, deps);
}

/** Content-based staleness judgment — see checkStale. */
function checkStaleContent(raw: string, deps: LockDeps): boolean {
  const parsed = parsePidfile(raw);
  if (parsed === null) {
    // Unparseable — treat as stale
    return true;
  }
  const { pid, startTime } = parsed;

  try {
    process.kill(pid, 0);
    // Signal 0 succeeded: a process with this pid is alive — but is it the
    // recorded one? Fall through to the identity check below.
  } catch (e: any) {
    if (e.code === "ESRCH") {
      // No such process — stale
      return true;
    }
    // EPERM: process exists but owned by another user — treat as alive (safe
    // choice). Any other unexpected error: also treat as alive.
    return false;
  }

  if (startTime === "") {
    // No discriminator recorded (legacy pidfile, or owner's ps lookup failed
    // at write time) — fall back to pid liveness alone (safe choice: alive).
    return false;
  }

  const getStartTime = deps.getProcessStartTimeFn ?? getProcessStartTime;
  const actual = getStartTime(pid);
  if (actual === null) {
    // Identity unknown — safe choice: alive
    return false;
  }
  // Same pid but a different start time: the recorded owner is dead and the
  // pid was recycled by an unrelated process — stale.
  return actual !== startTime;
}

/** Parse `<pid>\n<start time>\n`. Returns null when the pid line is unusable. */
function parsePidfile(raw: string): { pid: number; startTime: string } | null {
  const lines = raw.split("\n");
  const pid = parseInt(lines[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, startTime: (lines[1] ?? "").trim() };
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

/**
 * Who holds the lock? The pid in the pidfile when that process is alive AND
 * matches the recorded start-time discriminator (a recycled pid is not the
 * holder), else null. Read-only — never mutates the lock (used by
 * `junco status`/`doctor`).
 */
export function readLockHolder(lockPath: string, deps: LockDeps = {}): number | null {
  try {
    const parsed = parsePidfile(readFileSync(lockPath, "utf-8"));
    if (parsed === null) return null;
    const { pid, startTime } = parsed;
    process.kill(pid, 0); // throws if dead / not signalable
    if (startTime !== "") {
      const getStartTime = deps.getProcessStartTimeFn ?? getProcessStartTime;
      const actual = getStartTime(pid);
      // Identity known and different → recycled pid, not the recorded holder
      if (actual !== null && actual !== startTime) return null;
    }
    return pid;
  } catch {
    return null;
  }
}
