import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSingletonLock } from "../src/lock.js";

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

  it("parent directory is auto-created if it does not exist", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "nonexistent", "subdir", "worker.lock");

    const lock = acquireSingletonLock(lockPath);
    expect(lock).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    lock!.release();
  });
});
