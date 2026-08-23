import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, basename, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireSingletonLock,
  daemonLockPaths,
  getProcessStartTime,
  readLockHolder,
  workerLockPath,
} from "../src/lock.js";
import { PIDFILE_DISCRIMINATOR_PREFIX } from "../src/pidfileLock.js";

/** A recognized-but-mismatched discriminator: format-tagged (so the reader
 * compares it) yet never matching a live process — i.e. a recycled pid. */
const RECYCLED = `${PIDFILE_DISCRIMINATOR_PREFIX}not-the-real-start-time`;

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
    writeFileSync(lockPath, `${process.pid}\n${RECYCLED}\n`);

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

    writeFileSync(lockPath, `${process.pid}\n${PIDFILE_DISCRIMINATOR_PREFIX}some-recorded-time\n`);

    // Recognized discriminator, but ps lookup fails → identity unknown →
    // preserve the safe-choice bias: alive.
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

  it("legacy locale-formatted discriminator (live pid) is NOT stolen on upgrade (#69)", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    // A pre-#69 daemon recorded a raw, locale-formatted lstart with no format
    // tag. The upgraded reader's LC_ALL=C value differs, but the owner is alive
    // — the untagged format is unrecognized, so we must fall back to liveness
    // and NOT false-steal a live daemon's lock (two-daemon regression).
    writeFileSync(lockPath, `${process.pid}\nMon Jul  7 10:00:00 2025\n`);

    const lock = acquireSingletonLock(lockPath, {
      getProcessStartTimeFn: () => `${PIDFILE_DISCRIMINATOR_PREFIX}Lun 7 juil. 10:00:00 2025`,
    });
    expect(lock).toBeNull();
    // ...and status/restart still resolve the live daemon's pid.
    expect(
      readLockHolder(lockPath, {
        getProcessStartTimeFn: () => `${PIDFILE_DISCRIMINATOR_PREFIX}different`,
      }),
    ).toBe(process.pid);
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

  it("steal of a genuinely stale lock leaves no aside/temp residue", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    // Recycled pid: alive, but not the recorded owner — stale
    writeFileSync(lockPath, `${process.pid}\n${RECYCLED}\n`);

    const lock = acquireSingletonLock(lockPath);
    expect(lock).not.toBeNull();
    expect(readdirSync(dir)).toEqual(["worker.lock"]);
    lock!.release();
  });

  it("steal race: stale file vanishing mid-steal is settled by the atomic create", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    writeFileSync(lockPath, `${process.pid}\n${RECYCLED}\n`);

    // Choreography (see acquireSingletonLock): call 1 builds our own pidfile
    // content, call 2 is the staleness identity check. Unlinking during call 2
    // simulates a racing stealer removing the stale file between our judgment
    // and our steal. The retry create must settle it — we win here because the
    // simulated racer never created a fresh lock.
    let calls = 0;
    const lock = acquireSingletonLock(lockPath, {
      getProcessStartTimeFn: (pid) => {
        calls += 1;
        if (calls === 2) unlinkSync(lockPath);
        return getProcessStartTime(pid);
      },
    });

    expect(lock).not.toBeNull();
    expect(parseInt(readFileSync(lockPath, "utf-8"), 10)).toBe(process.pid);
    expect(readdirSync(dir)).toEqual(["worker.lock"]);
    lock!.release();
  });

  it("steal race: never destroys a racing winner's fresh live lock (ABA)", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "worker.lock");

    // We judge this file stale (recycled pid) ...
    writeFileSync(lockPath, `${process.pid}\n${RECYCLED}\n`);
    const freshLiveContent = `${process.pid}\n${getProcessStartTime(process.pid)}\n`;

    // ... but during the identity check (call 2 — the window between judging
    // and stealing) a racing starter completes its ENTIRE steal: the lock name
    // now holds a fresh pidfile with a live, matching owner. The old
    // unlink-in-place code deleted that live lock and acquired anyway — two
    // daemons. The steal must detect this and lose, leaving the winner's
    // pidfile in place.
    let calls = 0;
    const lock = acquireSingletonLock(lockPath, {
      getProcessStartTimeFn: (pid) => {
        calls += 1;
        if (calls === 2) {
          unlinkSync(lockPath);
          writeFileSync(lockPath, freshLiveContent);
        }
        return getProcessStartTime(pid);
      },
    });

    expect(lock).toBeNull();
    expect(readFileSync(lockPath, "utf-8")).toBe(freshLiveContent);
    expect(readdirSync(dir)).toEqual(["worker.lock"]);
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
    writeFileSync(p, `${process.pid}\n${RECYCLED}\n`, "utf8");
    expect(readLockHolder(p)).toBeNull(); // pid recycled: not the recorded process
    writeFileSync(p, `${process.pid}\n${getProcessStartTime(process.pid)}\n`, "utf8");
    expect(readLockHolder(p)).toBe(process.pid); // same pid, same identity
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Lock-path derivation — the ONE spelling (#310 Task 1)
//
// Nine expressions across six modules used to construct the daemon pidfile
// path by hand, and one of them (doctor.ts) omitted the `resolve()` every
// other site had. These pin the single helper both spellings collapsed into,
// and — the assertion that matters — that the two shared-tree claims can
// never collide with `worker.lock` or with each other on a DEFAULT install,
// where `dataDir === dirname(configPath)`.
// ---------------------------------------------------------------------------

describe("workerLockPath", () => {
  it("is worker.lock beside the RESOLVED config (absolute input)", () => {
    expect(workerLockPath("/sbxroot/.junco/config.json")).toBe("/sbxroot/.junco/worker.lock");
  });

  it("normalizes `..` segments in an absolute path", () => {
    expect(workerLockPath("/sbxroot/.junco/sub/../config.json")).toBe(
      "/sbxroot/.junco/worker.lock",
    );
  });

  it("resolves a relative config path against the cwd (this is what doctor.ts missed)", () => {
    // THE input the two spellings disagreed on. `join(dirname(p), "worker.lock")`
    // normalizes `..` by itself, so it agreed for every ABSOLUTE path — it
    // diverged only for a relative one, where it returned a relative path that
    // re-resolves against whatever cwd each reader happens to have (a launchd
    // daemon's is `/`). That is how doctor could report "not running" at a live
    // daemon. Every call-site pin below uses a relative path for this reason.
    const got = workerLockPath(join("rel", "config.json"));
    expect(isAbsolute(got)).toBe(true);
    expect(got).toBe(join(process.cwd(), "rel", "worker.lock"));
  });
});

describe("daemonLockPaths", () => {
  /** A default install: the data root IS the config's directory. */
  const DEFAULT_CFG_PATH = "/sbxroot/.junco/config.json";
  const defaultCfg = { dataDir: "/sbxroot/.junco", queueRoot: "/sbxroot/.junco/queue" };

  it("worker is byte-identical to workerLockPath", () => {
    expect(daemonLockPaths(DEFAULT_CFG_PATH, defaultCfg).worker).toBe(
      workerLockPath(DEFAULT_CFG_PATH),
    );
  });

  it("claims the shared roots: dataTree under dataDir, queue under queueRoot", () => {
    const p = daemonLockPaths(DEFAULT_CFG_PATH, {
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxvault/junco",
    });
    expect(dirname(p.dataTree)).toBe("/sbxroot/data");
    expect(dirname(p.queue)).toBe("/sbxvault/junco");
  });

  it("NEITHER tree claim is named worker.lock", () => {
    const p = daemonLockPaths(DEFAULT_CFG_PATH, defaultCfg);
    expect(basename(p.dataTree)).not.toBe("worker.lock");
    expect(basename(p.queue)).not.toBe("worker.lock");
  });

  it("the three paths are pairwise distinct on a DEFAULT install", () => {
    // The regression this exists for: on a default install dataDir ===
    // dirname(configPath), so a claim that reused the name `worker.lock`
    // would have `junco start` contend with the lock it just took and refuse
    // to start. Distinct BASENAMES are what makes that impossible — the
    // claims stay distinct even for the pathological queueRoot === dataDir.
    const p = daemonLockPaths(DEFAULT_CFG_PATH, defaultCfg);
    expect(dirname(p.dataTree)).toBe(dirname(p.worker)); // same directory...
    expect(new Set([p.worker, p.dataTree, p.queue]).size).toBe(3); // ...three files
  });

  it("stays pairwise distinct even when queueRoot === dataDir === the config dir", () => {
    const p = daemonLockPaths(DEFAULT_CFG_PATH, {
      dataDir: "/sbxroot/.junco",
      queueRoot: "/sbxroot/.junco",
    });
    expect(new Set([p.worker, p.dataTree, p.queue]).size).toBe(3);
  });

  it("normalizes the roots the same way the config path is normalized", () => {
    const p = daemonLockPaths(DEFAULT_CFG_PATH, {
      dataDir: "/sbxroot/data/sub/..",
      queueRoot: "/sbxroot/data/sub/../queue",
    });
    expect(dirname(p.dataTree)).toBe("/sbxroot/data");
    expect(dirname(p.queue)).toBe("/sbxroot/data/queue");
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
