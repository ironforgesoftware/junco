/**
 * Hardened pidfile lock — the shared cross-process mutual-exclusion primitive
 * behind BOTH the daemon's single-instance lock (src/lock.ts) and the outbox
 * flush lock (src/githubOutbox.ts).
 *
 * A pidfile records `<pid>\n<process start-time discriminator>\n`. It is stale
 * when the pid is dead, unreadable/unparseable, or alive but its recorded
 * start-time discriminator no longer matches the live process (a recycled pid,
 * which would otherwise block acquisition forever). Creation is atomic
 * including content (temp file + hard link), and stealing a stale file moves it
 * aside by rename with post-move verification, so concurrent starters settle on
 * exactly one winner and no stealer can ever destroy a racing winner's fresh
 * live lock (the ABA the naive unlink-in-place steal reintroduces).
 */

import { mkdirSync, writeFileSync, linkSync, renameSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface PidfileLock {
  /** The lock file path. */
  path: string;
  /** Release the lock (best-effort unlink if we still own it). Idempotent. */
  release(): void;
}

/** Injectable side effects (tests only; production callers omit these). */
export interface PidfileLockDeps {
  /** Process-identity lookup — see getProcessStartTime. Default: getProcessStartTime. */
  getProcessStartTimeFn?: (pid: number) => string | null;
  /** Liveness probe for the recorded owner pid. Default: signal 0 (ESRCH →
   * dead; EPERM/other → alive). Injectable so tests can pin alive/dead. */
  pidAliveFn?: (pid: number) => boolean;
}

/**
 * Format tag on the start-time discriminator we write. It is self-identifying
 * so a reader can tell a value THIS code produced — `ps -o lstart=` captured
 * under LC_ALL=C — from a legacy untagged one written by a pre-#69 daemon under
 * an arbitrary locale. On an untagged (unrecognized) discriminator we fall back
 * to pid-liveness alone rather than mis-judging a live daemon's
 * differently-formatted string as a recycled pid (which would false-steal the
 * lock and admit two daemons). `c1` = "ps lstart under LC_ALL=C, format v1".
 */
export const PIDFILE_DISCRIMINATOR_PREFIX = "c1:";

/** Hard cap on the `ps` probe so a wedged `ps` can't block startup forever. */
const PS_TIMEOUT_MS = 5000;

/**
 * Opaque process-identity discriminator: the process start time as reported by
 * `ps -p <pid> -o lstart=` (supported on both macOS and Linux), captured under
 * a pinned LC_ALL=C so writer and reader agree regardless of the caller's
 * locale, and returned with the format tag prepended. Two reads for the same
 * live process compare equal; a recycled pid yields a different string. Returns
 * null when the pid is dead or the lookup fails/times out (unknown).
 */
export function getProcessStartTime(pid: number): string | null {
  try {
    // LC_ALL=C pins the lstart formatting; a hung ps is killed at PS_TIMEOUT_MS
    // (res.error set → treated as unknown). Both close issue #69.
    const res = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: PS_TIMEOUT_MS,
    });
    if (res.error || res.status !== 0) return null;
    const out = res.stdout.trim();
    return out.length > 0 ? `${PIDFILE_DISCRIMINATOR_PREFIX}${out}` : null;
  } catch {
    return null;
  }
}

/** Default owner-liveness probe: signal 0. ESRCH → dead (stale); EPERM or any
 * other failure → treat as alive (safe choice). */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Acquire a pidfile lock using a pidfile + liveness check.
 *
 * Returns a PidfileLock on success, or null if another live process holds it.
 * The residual TOCTOU (>= 3 starters interleaving inside two nested
 * sub-millisecond windows, see the restore path below) is accepted.
 */
export function acquirePidfileLock(
  lockPath: string,
  deps: PidfileLockDeps = {},
): PidfileLock | null {
  mkdirSync(dirname(lockPath), { recursive: true });

  const result = tryCreate(lockPath, deps);
  if (result !== "EEXIST") {
    // Created fresh, or an unexpected error was rethrown inside tryCreate
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
  // winner's freshly created pidfile and admit two live holders.
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
    // atomic restore; a re-claim by another starter loses the name to us harmlessly
    claimName(lockPath, asideRaw ?? "", deps);
    bestEffortUnlink(asidePath);
    return null;
  }
  bestEffortUnlink(asidePath);

  const retryResult = tryCreate(lockPath, deps);
  if (retryResult === "EEXIST") {
    // Another process raced us and won
    return null;
  }
  // Either a PidfileLock or an unexpected error was rethrown
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
 * Returns "EEXIST" if the file already exists, the PidfileLock on success, or
 * rethrows any other unexpected error.
 */
function tryCreate(lockPath: string, deps: PidfileLockDeps): PidfileLock | "EEXIST" {
  const ownPid = process.pid;
  const content = pidfileContent(ownPid, deps);
  return claimName(lockPath, content, deps);
}

/**
 * Claim `lockPath` atomically with the given content: write a unique temp file
 * then hard-link it into place (EEXIST if the name is taken). Returns a
 * PidfileLock on success, "EEXIST" if already held, or rethrows.
 */
function claimName(
  lockPath: string,
  content: string,
  _deps: PidfileLockDeps,
): PidfileLock | "EEXIST" {
  const ownPid = process.pid;
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
function pidfileContent(ownPid: number, deps: PidfileLockDeps): string {
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
function checkStale(lockPath: string, deps: PidfileLockDeps): boolean {
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
function checkStaleContent(raw: string, deps: PidfileLockDeps): boolean {
  const parsed = parsePidfile(raw);
  if (parsed === null) {
    // Unparseable — treat as stale
    return true;
  }
  const { pid, startTime } = parsed;

  const pidAlive = deps.pidAliveFn ?? defaultPidAlive;
  if (!pidAlive(pid)) {
    // No live process with this pid — stale
    return true;
  }

  if (!startTime.startsWith(PIDFILE_DISCRIMINATOR_PREFIX)) {
    // No recognized discriminator: none was recorded (legacy 1-line pidfile /
    // ps lookup failed at write time → ""), OR the recorded string was written
    // by a pre-#69 daemon under a different locale (untagged). We cannot safely
    // compare it against the LC_ALL=C value we produce now, so we fall back to
    // pid liveness alone (safe choice: alive) rather than mis-judging a live
    // daemon's differently-formatted string as a recycled pid — which would
    // false-steal the lock and admit two daemons (issue #69).
    return false;
  }

  const getStartTime = deps.getProcessStartTimeFn ?? getProcessStartTime;
  const actual = getStartTime(pid);
  if (actual === null) {
    // Identity unknown — safe choice: alive
    return false;
  }
  // Same pid but a different (recognized) start time: the recorded owner is
  // dead and the pid was recycled by an unrelated process — stale.
  return actual !== startTime;
}

/** Parse `<pid>\n<start time>\n`. Returns null when the pid line is unusable. */
function parsePidfile(raw: string): { pid: number; startTime: string } | null {
  const lines = raw.split("\n");
  const pid = parseInt(lines[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, startTime: (lines[1] ?? "").trim() };
}

function buildLock(lockPath: string, ownPid: number): PidfileLock {
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
 * holder), else null. Read-only — never mutates the lock.
 */
export function readPidfileHolder(lockPath: string, deps: PidfileLockDeps = {}): number | null {
  try {
    const parsed = parsePidfile(readFileSync(lockPath, "utf-8"));
    if (parsed === null) return null;
    const { pid, startTime } = parsed;
    const pidAlive = deps.pidAliveFn ?? defaultPidAlive;
    if (!pidAlive(pid)) return null;
    if (startTime.startsWith(PIDFILE_DISCRIMINATOR_PREFIX)) {
      const getStartTime = deps.getProcessStartTimeFn ?? getProcessStartTime;
      const actual = getStartTime(pid);
      // Identity known and different → recycled pid, not the recorded holder
      if (actual !== null && actual !== startTime) return null;
    }
    // Untagged/legacy discriminator (or none): a live pid resolves as the
    // holder — never return null for a differently-formatted string, so
    // `junco status`/`restart` keep finding a live pre-#69 daemon (issue #69).
    return pid;
  } catch {
    return null;
  }
}
