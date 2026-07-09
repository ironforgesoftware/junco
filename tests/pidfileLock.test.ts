import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquirePidfileLock,
  readPidfileHolder,
  getProcessStartTime,
  PIDFILE_DISCRIMINATOR_PREFIX,
} from "../src/pidfileLock.js";

/** A recognized-but-mismatched discriminator: carries the format tag (so the
 * reader treats it as ours and compares it) yet never matches a live process —
 * i.e. a recycled pid. */
const RECYCLED = `${PIDFILE_DISCRIMINATOR_PREFIX}not-the-real-start-time`;

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "junco-pidlock-"));
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

describe("acquirePidfileLock", () => {
  it("fresh acquire returns a lock and writes pid on line 1, start time on line 2", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    const lock = acquirePidfileLock(lockPath);
    expect(lock).not.toBeNull();
    const lines = readFileSync(lockPath, "utf-8").split("\n");
    expect(parseInt(lines[0]!, 10)).toBe(process.pid);
    expect(lines[1]).toBe(getProcessStartTime(process.pid) ?? "");
    lock!.release();
  });

  it("second acquire while a live pid holds it returns null", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    writeFileSync(lockPath, `${process.pid}\n`);
    expect(acquirePidfileLock(lockPath)).toBeNull();
  });

  it("dead owner pid is stolen (default liveness probe)", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    writeFileSync(lockPath, "999999\n");
    const lock = acquirePidfileLock(lockPath, { pidAliveFn: () => false });
    expect(lock).not.toBeNull();
    expect(parseInt(readFileSync(lockPath, "utf-8"), 10)).toBe(process.pid);
    lock!.release();
  });

  it("unparseable pidfile is stale even when the liveness probe would say alive", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    writeFileSync(lockPath, "garbage\n");
    const lock = acquirePidfileLock(lockPath, { pidAliveFn: () => true });
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("recycled pid: live pid with a mismatched start time is stolen", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    writeFileSync(lockPath, `${process.pid}\n${RECYCLED}\n`);
    const lock = acquirePidfileLock(lockPath);
    expect(lock).not.toBeNull();
    expect(parseInt(readFileSync(lockPath, "utf-8"), 10)).toBe(process.pid);
    lock!.release();
  });

  it("live pid with a matching start time returns null (held)", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    const start = getProcessStartTime(process.pid);
    expect(start).not.toBeNull();
    writeFileSync(lockPath, `${process.pid}\n${start}\n`);
    expect(acquirePidfileLock(lockPath)).toBeNull();
  });

  it("release only unlinks a file we still own; idempotent", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    const lock = acquirePidfileLock(lockPath)!;
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
    expect(() => lock.release()).not.toThrow();
  });

  it("release does NOT unlink a file owned by a different pid", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    const lock = acquirePidfileLock(lockPath)!;
    writeFileSync(lockPath, "99999\n");
    lock.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("never exposes the lock name before its content is complete (atomic create)", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    let visibleDuringContentBuild: boolean | null = null;
    const lock = acquirePidfileLock(lockPath, {
      getProcessStartTimeFn: (pid) => {
        visibleDuringContentBuild = existsSync(lockPath);
        return getProcessStartTime(pid);
      },
    });
    expect(lock).not.toBeNull();
    expect(visibleDuringContentBuild).toBe(false);
    lock!.release();
  });

  it("winning acquire leaves only the lock file — no temp/aside residue", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "x.lock");
    const lock = acquirePidfileLock(lockPath);
    expect(readdirSync(dir)).toEqual(["x.lock"]);
    lock!.release();
  });

  it("steal of a genuinely stale lock leaves no aside/temp residue", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "x.lock");
    writeFileSync(lockPath, `${process.pid}\n${RECYCLED}\n`);
    const lock = acquirePidfileLock(lockPath);
    expect(lock).not.toBeNull();
    expect(readdirSync(dir)).toEqual(["x.lock"]);
    lock!.release();
  });

  it("steal race: stale file vanishing mid-steal is settled by the atomic create", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "x.lock");
    writeFileSync(lockPath, `${process.pid}\n${RECYCLED}\n`);
    let calls = 0;
    const lock = acquirePidfileLock(lockPath, {
      getProcessStartTimeFn: (pid) => {
        calls += 1;
        if (calls === 2) rmSync(lockPath, { force: true });
        return getProcessStartTime(pid);
      },
    });
    expect(lock).not.toBeNull();
    expect(parseInt(readFileSync(lockPath, "utf-8"), 10)).toBe(process.pid);
    expect(readdirSync(dir)).toEqual(["x.lock"]);
    lock!.release();
  });

  it("steal race: never destroys a racing winner's fresh live lock (ABA)", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "x.lock");
    // We judge this file stale (recycled pid) ...
    writeFileSync(lockPath, `${process.pid}\n${RECYCLED}\n`);
    const freshLiveContent = `${process.pid}\n${getProcessStartTime(process.pid)}\n`;
    // ... but during the identity check (call 2 — between judging and stealing)
    // a racing starter completes its ENTIRE steal: the lock name now holds a
    // fresh pidfile with a live, matching owner. The naive unlink-in-place code
    // deleted that live lock and acquired anyway — two holders. The steal must
    // detect this and lose, leaving the winner's pidfile in place.
    let calls = 0;
    const lock = acquirePidfileLock(lockPath, {
      getProcessStartTimeFn: (pid) => {
        calls += 1;
        if (calls === 2) {
          rmSync(lockPath, { force: true });
          writeFileSync(lockPath, freshLiveContent);
        }
        return getProcessStartTime(pid);
      },
    });
    expect(lock).toBeNull();
    expect(readFileSync(lockPath, "utf-8")).toBe(freshLiveContent);
    expect(readdirSync(dir)).toEqual(["x.lock"]);
  });

  it("parent directory is auto-created", () => {
    const lockPath = join(makeTmpDir(), "nested", "deep", "x.lock");
    const lock = acquirePidfileLock(lockPath);
    expect(lock).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    lock!.release();
  });
});

describe("readPidfileHolder", () => {
  it("live pid → pid; missing, garbage, dead → null", () => {
    const p = join(makeTmpDir(), "x.lock");
    expect(readPidfileHolder(p)).toBeNull();
    writeFileSync(p, String(process.pid));
    expect(readPidfileHolder(p)).toBe(process.pid);
    writeFileSync(p, "not-a-pid");
    expect(readPidfileHolder(p)).toBeNull();
    writeFileSync(p, "999999");
    expect(readPidfileHolder(p, { pidAliveFn: () => false })).toBeNull();
  });

  it("recycled pid → null, matching identity → pid", () => {
    const p = join(makeTmpDir(), "x.lock");
    writeFileSync(p, `${process.pid}\n${RECYCLED}\n`);
    expect(readPidfileHolder(p)).toBeNull();
    writeFileSync(p, `${process.pid}\n${getProcessStartTime(process.pid)}\n`);
    expect(readPidfileHolder(p)).toBe(process.pid);
  });
});

describe("upgrade transition — legacy locale-formatted discriminator (#69)", () => {
  // A pre-#69 daemon wrote the pidfile discriminator as a raw, locale-formatted
  // `ps -o lstart=` string with no format tag. The upgraded reader now produces
  // an LC_ALL=C, tagged string that differs — but the owner is still alive, so
  // it must NOT be judged a recycled pid.
  const LEGACY_UNTAGGED = "Mon Jul  7 10:00:00 2025";

  it("acquire does NOT steal a live pre-#69 daemon's untagged discriminator", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    writeFileSync(lockPath, `${process.pid}\n${LEGACY_UNTAGGED}\n`);
    // The current LC_ALL=C value differs from the recorded locale string, but
    // the untagged format is unrecognized → fall back to pid liveness → held.
    const lock = acquirePidfileLock(lockPath, {
      getProcessStartTimeFn: () => `${PIDFILE_DISCRIMINATOR_PREFIX}Lun 7 juil. 10:00:00 2025`,
    });
    expect(lock).toBeNull();
    // The live daemon's pidfile is untouched.
    expect(readFileSync(lockPath, "utf-8")).toBe(`${process.pid}\n${LEGACY_UNTAGGED}\n`);
  });

  it("readPidfileHolder still resolves a live pre-#69 daemon's holder pid", () => {
    const p = join(makeTmpDir(), "x.lock");
    writeFileSync(p, `${process.pid}\n${LEGACY_UNTAGGED}\n`);
    // status/restart must keep finding the pid — never null on a format mismatch.
    expect(
      readPidfileHolder(p, {
        getProcessStartTimeFn: () => `${PIDFILE_DISCRIMINATOR_PREFIX}whatever-different`,
      }),
    ).toBe(process.pid);
  });

  it("a tagged discriminator whose identity is now unknown is treated as alive", () => {
    const lockPath = join(makeTmpDir(), "x.lock");
    writeFileSync(lockPath, `${process.pid}\n${PIDFILE_DISCRIMINATOR_PREFIX}recorded\n`);
    // Recognized format, but ps can't confirm identity (null) → safe-choice alive.
    const lock = acquirePidfileLock(lockPath, { getProcessStartTimeFn: () => null });
    expect(lock).toBeNull();
  });
});

describe("getProcessStartTime", () => {
  it("stable, non-empty for a live pid; null for a dead pid", () => {
    const first = getProcessStartTime(process.pid);
    expect(first).not.toBeNull();
    expect(first!.length).toBeGreaterThan(0);
    expect(getProcessStartTime(process.pid)).toBe(first);
    expect(getProcessStartTime(2147483646)).toBeNull();
  });

  it("carries the format tag so a reader can recognize its own output", () => {
    expect(getProcessStartTime(process.pid)!.startsWith(PIDFILE_DISCRIMINATOR_PREFIX)).toBe(true);
  });

  it("is locale-stable — the caller's LC_TIME cannot shift it (LC_ALL=C pinned)", () => {
    const saved = process.env.LC_TIME;
    try {
      process.env.LC_TIME = "C";
      const a = getProcessStartTime(process.pid);
      process.env.LC_TIME = "fr_FR.UTF-8";
      const b = getProcessStartTime(process.pid);
      expect(a).not.toBeNull();
      expect(b).toBe(a);
    } finally {
      if (saved === undefined) delete process.env.LC_TIME;
      else process.env.LC_TIME = saved;
    }
  });
});
