import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSingletonLock, getProcessStartTime, readLockHolder } from "../src/lock.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "junco-lock-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  tmpDirs = [];
});

describe("acquireSingletonLock", () => {
  it("fresh acquire: returns a lock and writes process.pid to the file", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    const lock = acquireSingletonLock(lockPath);

    expect(lock).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    const contents = readFileSync(lockPath, "utf-8").trim();
    expect(parseInt(contents, 10)).toBe(process.pid);
    lock!.release();
  });

  it("second acquire while held (live pid) returns null", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    // Write a pidfile with our own (definitely-alive) pid
    writeFileSync(lockPath, String(process.pid) + "\n");

    const lock = acquireSingletonLock(lockPath);
    expect(lock).toBeNull();
  });

  it("stale pidfile (dead process) is stolen and returns a lock with our pid", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    // Use a very high pid that is almost certainly unused
    const deadPid = 2147483646;

    // Guard: skip if this pid is unexpectedly alive (e.g. on exotic CI)
    let pidIsAlive = false;
    try {
      process.kill(deadPid, 0);
      pidIsAlive = true;
    } catch (e: any) {
      if (e.code !== "ESRCH") {
        // EPERM means the process exists; treat as alive
        pidIsAlive = true;
      }
    }

    if (pidIsAlive) {
      // Cannot run this test reliably — skip assertions
      return;
    }

    writeFileSync(lockPath, String(deadPid) + "\n");

    const lock = acquireSingletonLock(lockPath);
    expect(lock).not.toBeNull();
    const contents = readFileSync(lockPath, "utf-8").trim();
    expect(parseInt(contents, 10)).toBe(process.pid);
    lock!.release();
  });

  it("unparseable pidfile is treated as stale and stolen", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    writeFileSync(lockPath, "garbage\n");

    const lock = acquireSingletonLock(lockPath);
    expect(lock).not.toBeNull();
    const contents = readFileSync(lockPath, "utf-8").trim();
    expect(parseInt(contents, 10)).toBe(process.pid);
    lock!.release();
  });

  it("release() unlinks the file we own, and is idempotent", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    const lock = acquireSingletonLock(lockPath)!;
    expect(lock).not.toBeNull();

    lock.release();
    expect(existsSync(lockPath)).toBe(false);

    // Calling release again must not throw
    expect(() => lock.release()).not.toThrow();
  });

  it("release() does NOT unlink a file owned by a different pid", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    const lock = acquireSingletonLock(lockPath)!;
    expect(lock).not.toBeNull();

    // Overwrite the file with a different pid
    writeFileSync(lockPath, "99999\n");

    lock.release();
    // File should still exist because we didn't own it
    expect(existsSync(lockPath)).toBe(true);
  });

  it("fresh acquire writes pid on line 1 and our process start time on line 2", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    const lock = acquireSingletonLock(lockPath);
    expect(lock).not.toBeNull();

    const lines = readFileSync(lockPath, "utf-8").split("\n");
    expect(parseInt(lines[0]!, 10)).toBe(process.pid);
    // Line 2 is the identity discriminator: our own start time (or "" if ps is unavailable)
    expect(lines[1]).toBe(getProcessStartTime(process.pid) ?? "");
    lock!.release();
  });

  it("PID reuse: live pid with a mismatched start time is treated as stale and stolen", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    // A recycled pid: the pid is alive (it's us) but the recorded start time
    // belongs to the dead previous owner.
    writeFileSync(lockPath, `${process.pid}\nnot-the-real-start-time\n`);

    const lock = acquireSingletonLock(lockPath);
    expect(lock).not.toBeNull();
    const contents = readFileSync(lockPath, "utf-8").trim();
    expect(parseInt(contents, 10)).toBe(process.pid);
    lock!.release();
  });

  it("live pid with a matching start time returns null (held)", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    const start = getProcessStartTime(process.pid);
    expect(start).not.toBeNull(); // sanity: ps must work in the test env
    writeFileSync(lockPath, `${process.pid}\n${start}\n`);

    const lock = acquireSingletonLock(lockPath);
    expect(lock).toBeNull();
  });

  it("live pid with an unknown start time is treated as alive (safe fallback)", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    writeFileSync(lockPath, `${process.pid}\nsome-recorded-start-time\n`);

    // ps lookup fails → identity unknown → preserve the safe-choice bias: alive
    const lock = acquireSingletonLock(lockPath, { getProcessStartTimeFn: () => null });
    expect(lock).toBeNull();
  });

  it("legacy single-line pidfile with a live pid returns null (no false steal on upgrade)", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    // Old-format pidfile written by a still-running pre-upgrade daemon
    writeFileSync(lockPath, String(process.pid) + "\n");

    const lock = acquireSingletonLock(lockPath);
    expect(lock).toBeNull();
  });

  it("never exposes the lock name before its content is complete (atomic create)", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    // The identity lookup runs while the pidfile content is being assembled.
    // If the lock name is already visible at that point, a concurrent reader
    // could observe an empty/partial pidfile, parse it as stale, and steal a
    // lock whose owner is alive (issue #24, vector 2).
    let visibleDuringContentBuild: boolean | null = null;
    const lock = acquireSingletonLock(lockPath, {
      getProcessStartTimeFn: (pid) => {
        visibleDuringContentBuild = existsSync(lockPath);
        return getProcessStartTime(pid);
      },
    });

    expect(lock).not.toBeNull();
    expect(visibleDuringContentBuild).toBe(false);
    lock!.release();
  });

  it("empty pidfile is treated as stale and stolen (creation is atomic, so empty = corrupt)", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    writeFileSync(lockPath, "");

    const lock = acquireSingletonLock(lockPath);
    expect(lock).not.toBeNull();
    const contents = readFileSync(lockPath, "utf-8").trim();
    expect(parseInt(contents, 10)).toBe(process.pid);
    lock!.release();
  });

  it("winning acquire leaves only the lock file — no temp residue", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    const lock = acquireSingletonLock(lockPath);
    expect(lock).not.toBeNull();
    expect(readdirSync(dir)).toEqual(["worker.lock"]);
    lock!.release();
  });

  it("losing acquire (live holder) leaves only the holder's lock file — no temp residue", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    writeFileSync(lockPath, `${process.pid}\n${getProcessStartTime(process.pid)}\n`);

    const lock = acquireSingletonLock(lockPath);
    expect(lock).toBeNull();
    expect(readdirSync(dir)).toEqual(["worker.lock"]);
    // The holder's pidfile is untouched
    expect(parseInt(readFileSync(lockPath, "utf-8"), 10)).toBe(process.pid);
  });

  it("parent directory is auto-created if it does not exist", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "nonexistent", "subdir", "worker.lock");

    const lock = acquireSingletonLock(lockPath);
    expect(lock).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    lock!.release();
  });
});

describe("readLockHolder", () => {
  it("live pid → pid; missing file, garbage, or dead pid → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-lockread-"));
    const p = join(dir, "worker.lock");
    expect(readLockHolder(p)).toBeNull(); // missing
    writeFileSync(p, String(process.pid), "utf8");
    expect(readLockHolder(p)).toBe(process.pid); // alive (us)
    writeFileSync(p, "not-a-pid", "utf8");
    expect(readLockHolder(p)).toBeNull(); // garbage
    writeFileSync(p, "999999", "utf8");
    expect(readLockHolder(p)).toBeNull(); // (almost certainly) dead
    rmSync(dir, { recursive: true, force: true });
  });

  it("checks the start-time discriminator: recycled pid → null, matching → pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-lockread-"));
    const p = join(dir, "worker.lock");
    writeFileSync(p, `${process.pid}\nnot-the-real-start-time\n`, "utf8");
    expect(readLockHolder(p)).toBeNull(); // pid recycled: not the recorded process
    writeFileSync(p, `${process.pid}\n${getProcessStartTime(process.pid)}\n`, "utf8");
    expect(readLockHolder(p)).toBe(process.pid); // same pid, same identity
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("getProcessStartTime", () => {
  it("returns a stable, non-empty string for a live pid and null for a dead pid", () => {
    const first = getProcessStartTime(process.pid);
    expect(first).not.toBeNull();
    expect(first!.length).toBeGreaterThan(0);
    // Opaque-string contract: two reads of the same live process compare equal
    expect(getProcessStartTime(process.pid)).toBe(first);
    expect(getProcessStartTime(2147483646)).toBeNull();
  });
});
