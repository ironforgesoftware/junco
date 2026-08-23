/**
 * Tests for src/cli.ts — `run(argv, deps)` pure function.
 *
 * TDD for M4-T5: junco start daemon command + singleton-lock wiring.
 * All collaborators (lock, signals, mainLoop, runOnce, loadConfig) are
 * injected via CliDeps — no real fs / daemon / signals / timers.
 */

import { describe, it, expect, vi, type MockedFunction, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Config } from "../src/types.js";
import type { SingletonLock } from "../src/lock.js";
import { acquireSingletonLock, readLockHolder } from "../src/lock.js";
import { acquirePidfileLock } from "../src/pidfileLock.js";
import { run } from "../src/cli.js";
import type { CliDeps } from "../src/cli.js";
import { renderService } from "../src/service.js";
import { submitTicket } from "../src/dispatch.js";
import { ConfigSchema } from "../src/config.js";
import type { ConfigParsed } from "../src/config.js";
import type { EnsureResult } from "../src/ensureDaemon.js";
import { makeConfig } from "./helpers/config.js";
import { GH_AUTH_CTX } from "./helpers/dashFixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub Config — injected mainLoop / runOnce ignore it. `legacy` is
 * populated (all-clean) so the startup configDeprecations() call in the
 * `start` arm doesn't throw on a bare `{}` stub. */
function stubConfig(): Config {
  return {
    // #310: `start` derives the shared-tree claims from these BEFORE it takes
    // any lock, and `daemonLockPaths` resolve()s both — an absent dataDir does
    // not degrade, it throws inside node:path.resolve. Synthetic, deliberately
    // non-existent paths (the `/sbxroot/...` convention used by the sandbox
    // tests): every lock seam in makeDeps is a fake, so nothing is created
    // here and no test can wander into the maintainer's live ~/.junco.
    dataDir: "/sbxroot/data",
    queueRoot: "/sbxroot/data/queue",
    legacy: {
      vaultRoot: false,
      stateDir: false,
      worktreeRoot: false,
      externalReposRoot: false,
      dataRoot: false,
    },
  } as Config;
}

/** A fake SingletonLock with a spy on release(). */
function makeFakeLock(): SingletonLock & { release: ReturnType<typeof vi.fn<() => void>> } {
  return {
    path: "/tmp/worker.lock",
    release: vi.fn<() => void>(),
  };
}

/**
 * Build a full CliDeps object with sensible defaults for the happy path:
 * - loadConfigFn → returns stubConfig()
 * - acquireLockFn → returns a fake lock
 * - installSignalHandlersFn → returns an uninstall spy
 * - mainLoopFn → resolves immediately
 * - runOnceFn → resolves true
 *
 * Individual tests override only the deps they care about.
 */
function makeDeps(
  overrides: Partial<Parameters<typeof run>[1]> = {},
): NonNullable<Parameters<typeof run>[1]> {
  const fakeLock = makeFakeLock();
  const fakeTreeLock = makeFakeLock();
  const fakeQueueLock = makeFakeLock();
  const uninstallSpy = vi.fn();
  return {
    loadConfigFn: vi.fn(() => stubConfig()),
    acquireLockFn: vi.fn(() => fakeLock),
    // #310: never take a REAL data-root claim by default. On the maintainer's
    // own machine the default dataDir is their live ~/.junco, and a real
    // pidfile there would collide with (or be stolen from) their daemon.
    acquireTreeLockFn: vi.fn(() => fakeTreeLock),
    // Same, for the queue root — and a DISTINCT fake, so a test asserting one
    // claim's release() count can never be satisfied by the other's.
    acquireQueueLockFn: vi.fn(() => fakeQueueLock),
    installSignalHandlersFn: vi.fn(() => uninstallSpy),
    mainLoopFn: vi.fn(async () => {}),
    runOnceFn: vi.fn(async () => true),
    // Never touch a real fs.watch — the stub config path may not exist on disk.
    watchConfigFn: vi.fn(() => ({ close: vi.fn() })),
    // stubConfig() returns `{}` — no botAccount — so the real withBotAuth
    // would throw reading `.enabled` off undefined. Default to a no-op
    // pass-through; tests that care about bot-auth wiring override it.
    withBotAuthFn: vi.fn(async (c: Config) => c),
    // FTUE gate (#273): both liveness probes default to "nothing running" so
    // no test ever reads the real ~/.junco/worker.lock or fetches the real
    // 127.0.0.1:8787 — on the maintainer's own machine both answer.
    readLockHolderFn: vi.fn(() => null),
    fetchHealthFn: vi.fn(async () => null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// start — happy path
// ---------------------------------------------------------------------------

describe("run(['start']) — happy path", () => {
  it("returns 0", async () => {
    const deps = makeDeps();
    const code = await run(["start"], deps);
    expect(code).toBe(0);
  });

  it("calls mainLoop exactly once with once=false", async () => {
    const deps = makeDeps();
    await run(["start"], deps);
    expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
    const [, , opts] = (deps.mainLoopFn as MockedFunction<any>).mock.calls[0];
    expect(opts).toMatchObject({ once: false });
  });

  it("calls uninstall after mainLoop", async () => {
    const uninstallSpy = vi.fn();
    const deps = makeDeps({
      installSignalHandlersFn: vi.fn(() => uninstallSpy),
    });
    await run(["start"], deps);
    expect(uninstallSpy).toHaveBeenCalledTimes(1);
  });

  it("calls lock.release() after mainLoop", async () => {
    const fakeLock = makeFakeLock();
    const deps = makeDeps({ acquireLockFn: vi.fn(() => fakeLock) });
    await run(["start"], deps);
    expect(fakeLock.release).toHaveBeenCalledTimes(1);
  });

  it("wires a shared provider gate into both watchConfigFn's onApplied and mainLoopFn's deps (Task 10)", async () => {
    const watchConfigFn = vi.fn(() => ({ close: vi.fn() }));
    const deps = makeDeps({ watchConfigFn });
    await run(["start"], deps);

    expect(watchConfigFn).toHaveBeenCalledTimes(1);
    const [, , watchDeps] = (watchConfigFn as MockedFunction<any>).mock.calls[0];
    expect(typeof watchDeps.onApplied).toBe("function");

    const [, , , mainLoopDeps] = (deps.mainLoopFn as MockedFunction<any>).mock.calls[0];
    expect(mainLoopDeps.gate).toBeDefined();
    expect(typeof mainLoopDeps.gate.clearLatched).toBe("function");

    // Same instance, not a lookalike — the watcher's onApplied must clear the
    // EXACT gate the daemon reads its claim/health state from, not a copy.
    const clearSpy = vi.spyOn(mainLoopDeps.gate, "clearLatched");
    watchDeps.onApplied();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// start — non-loopback health_host warning (#44)
// ---------------------------------------------------------------------------

describe("run(['start']) — health bind warning", () => {
  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it("warns loudly when health is enabled on a non-loopback host", async () => {
    const deps = makeDeps({
      loadConfigFn: vi.fn(() => ({ ...stubConfig(), healthEnabled: true, healthHost: "0.0.0.0" })),
    });
    const cap = captureStdout();
    try {
      await run(["start"], deps);
    } finally {
      cap.restore();
    }
    const out = cap.lines.join("");
    expect(out).toMatch(/health/i);
    expect(out).toContain("0.0.0.0");
  });

  it("does not warn for a loopback health_host", async () => {
    const deps = makeDeps({
      loadConfigFn: vi.fn(() => ({
        ...stubConfig(),
        healthEnabled: true,
        healthHost: "127.0.0.1",
      })),
    });
    const cap = captureStdout();
    try {
      await run(["start"], deps);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("")).not.toMatch(/health bind/i);
  });

  it("still warns when health_host is empty (binds all interfaces) — #71 belt-and-suspenders", async () => {
    // An empty host that bypassed config normalization must NOT evade the
    // warning: the old `&& cfg.healthHost` guard short-circuited on "".
    const deps = makeDeps({
      loadConfigFn: vi.fn(() => ({ ...stubConfig(), healthEnabled: true, healthHost: "" })),
    });
    const cap = captureStdout();
    try {
      await run(["start"], deps);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("")).toMatch(/health bind is not loopback/i);
  });
});

// ---------------------------------------------------------------------------
// start — deprecated legacy config keys (Unified Data Root spec §5)
// ---------------------------------------------------------------------------

describe("run(['start']) — deprecated config keys warning", () => {
  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it("logs a warning for each set legacy key", async () => {
    const deps = makeDeps({
      loadConfigFn: vi.fn(
        () =>
          ({
            ...stubConfig(),
            legacy: {
              vaultRoot: true,
              stateDir: false,
              worktreeRoot: false,
              externalReposRoot: false,
              dataRoot: false,
            },
          }) as Config,
      ),
    });
    const cap = captureStdout();
    try {
      await run(["start"], deps);
    } finally {
      cap.restore();
    }
    const out = cap.lines.join("");
    expect(out).toMatch(/vaultRoot\/juncoSubdir are deprecated/);
    expect(out).toContain("junco data migrate");
    // #199.4: pin the LEVEL too — a regression downgrading these to info would
    // otherwise still match the text above. Logs are JSON under vitest.
    const entry = cap.lines
      .flatMap((l) => l.split("\n"))
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l) as { level?: string; msg?: string };
        } catch {
          return null;
        }
      })
      .find((e) => e !== null && /vaultRoot\/juncoSubdir are deprecated/.test(e.msg ?? ""));
    expect(entry?.level).toBe("warn");
  });

  it("does not warn for a clean (non-legacy) config", async () => {
    const deps = makeDeps();
    const cap = captureStdout();
    try {
      await run(["start"], deps);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("")).not.toMatch(/deprecated/i);
  });
});

// ---------------------------------------------------------------------------
// start --once
// ---------------------------------------------------------------------------

describe("run(['start','--once'])", () => {
  it("passes once=true to mainLoopFn", async () => {
    const deps = makeDeps();
    await run(["start", "--once"], deps);
    const [, , opts] = (deps.mainLoopFn as MockedFunction<any>).mock.calls[0];
    expect(opts).toMatchObject({ once: true });
  });

  it("still returns 0", async () => {
    const deps = makeDeps();
    expect(await run(["start", "--once"], deps)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// start — lock held
// ---------------------------------------------------------------------------

describe("run(['start']) — lock held", () => {
  it("returns 0 (not an error — supervisor must not respawn-loop)", async () => {
    const deps = makeDeps({ acquireLockFn: vi.fn(() => null) });
    expect(await run(["start"], deps)).toBe(0);
  });

  it("does NOT call mainLoopFn", async () => {
    const deps = makeDeps({ acquireLockFn: vi.fn(() => null) });
    await run(["start"], deps);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });

  it("does NOT install signal handlers", async () => {
    const deps = makeDeps({ acquireLockFn: vi.fn(() => null) });
    await run(["start"], deps);
    expect(deps.installSignalHandlersFn).not.toHaveBeenCalled();
  });

  it("does NOT claim the data root either (a lock-losing start touches nothing)", async () => {
    const acquireTreeLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({ acquireLockFn: vi.fn(() => null), acquireTreeLockFn });
    await run(["start"], deps);
    expect(acquireTreeLockFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// start — the data-root claim (#310)
//
// worker.lock is keyed to the CONFIG directory, so two daemons started from two
// different config files never see each other's pidfile — even when both
// configs resolve to the same dataDir and therefore the same queue. The daemon
// additionally claims the shared data root itself, which both of them CAN see.
// ---------------------------------------------------------------------------

describe("run(['start']) — data-root claim (#310)", () => {
  it("(b) a normal single-instance start still succeeds, claiming <dataDir>/daemon-tree.lock", async () => {
    const acquireTreeLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({ acquireTreeLockFn });

    expect(await run(["start"], deps)).toBe(0);
    expect(acquireTreeLockFn).toHaveBeenCalledTimes(1);
    expect(acquireTreeLockFn).toHaveBeenCalledWith(join("/sbxroot/data", "daemon-tree.lock"));
    expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
  });

  it("(a) refuses a second start with a DIFFERENT config path but the SAME dataDir, naming the holder pid", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-tree-claim-"));
    try {
      const dataDir = join(root, "shared-data");
      const configA = join(root, "a", "config.json");
      const configB = join(root, "b", "config.json");
      const shared = { ...stubConfig(), dataDir, queueRoot: join(dataDir, "queue") } as Config;

      // The real primitive, against a tmp tree we own — nothing here can reach
      // the maintainer's ~/.junco (dataDir and HOME are both injected).
      const realTreeLock = (p: string) => acquirePidfileLock(p);

      let secondCode = -1;
      const stderrLines: string[] = [];

      const first = makeDeps({
        env: { HOME: root, JUNCO_CONFIG: configA },
        loadConfigFn: vi.fn(() => shared),
        acquireTreeLockFn: realTreeLock,
        // The second daemon starts WHILE the first still holds the claim.
        mainLoopFn: vi.fn(async () => {
          const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
            stderrLines.push(String(s));
            return true;
          });
          try {
            secondCode = await run(
              ["start"],
              makeDeps({
                env: { HOME: root, JUNCO_CONFIG: configB },
                loadConfigFn: vi.fn(() => shared),
                acquireTreeLockFn: realTreeLock,
                readLockHolderFn: (p: string) => readLockHolder(p),
              }),
            );
          } finally {
            spy.mockRestore();
          }
        }),
      });

      expect(await run(["start"], first)).toBe(0);

      // Exit 0, not 1 (final review F1): the refusal is loud in the MESSAGE,
      // and a supervisor that restarts on failure must not be handed a
      // restart trigger for a misconfiguration only a human can fix.
      expect(secondCode).toBe(0);
      const msg = stderrLines.join("");
      expect(msg).toContain(`pid ${process.pid}`);
      expect(msg).toContain(dataDir);
      expect(msg).toContain(configB);
      expect(msg).toMatch(/refusing to start/i);
      expect(msg).toMatch(/did NOT start/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(a) the refusal never reaches mainLoop and releases the worker.lock it took", async () => {
    const workerLock = makeFakeLock();
    const deps = makeDeps({
      acquireLockFn: vi.fn(() => workerLock),
      acquireTreeLockFn: vi.fn(() => null),
      readLockHolderFn: vi.fn(() => 4242),
    });
    const stderrLines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      stderrLines.push(String(s));
      return true;
    });
    try {
      expect(await run(["start"], deps)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
    expect(deps.installSignalHandlersFn).not.toHaveBeenCalled();
    // Exactly once — the refusal branch no longer releases by hand; the one
    // outer `finally` does it (F2), and a double release would show up here.
    expect(workerLock.release).toHaveBeenCalledTimes(1);
    expect(stderrLines.join("")).toContain("pid 4242");
  });

  it("(c) releases the data-root claim after mainLoop returns", async () => {
    const treeLock = makeFakeLock();
    const deps = makeDeps({ acquireTreeLockFn: vi.fn(() => treeLock) });
    await run(["start"], deps);
    expect(treeLock.release).toHaveBeenCalledTimes(1);
  });

  it("(c) STILL releases the data-root claim when mainLoop throws", async () => {
    const treeLock = makeFakeLock();
    const deps = makeDeps({
      acquireTreeLockFn: vi.fn(() => treeLock),
      mainLoopFn: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await run(["start"], deps)).toBe(1);
    expect(treeLock.release).toHaveBeenCalledTimes(1);
  });

  it("(c) STILL releases both claims on a MID-STARTUP throw (after the claim, before mainLoop)", async () => {
    const workerLock = makeFakeLock();
    const treeLock = makeFakeLock();
    const deps = makeDeps({
      acquireLockFn: vi.fn(() => workerLock),
      acquireTreeLockFn: vi.fn(() => treeLock),
      installSignalHandlersFn: vi.fn(() => {
        throw new Error("mid-startup boom");
      }),
    });
    await expect(run(["start"], deps)).rejects.toThrow("mid-startup boom");
    expect(treeLock.release).toHaveBeenCalledTimes(1);
    expect(workerLock.release).toHaveBeenCalledTimes(1);
  });

  it("(d) a DEFAULT install (dataDir === dirname(configPath)) starts fine — no self-contention", async () => {
    const home = mkdtempSync(join(tmpdir(), "junco-default-install-"));
    try {
      // Exactly the default layout: config at <home>/.junco/config.json, so
      // dirname(configPath) IS dataDir. A claim reusing the `worker.lock`
      // basename would land on the file `start` just locked and refuse.
      const dataDir = join(home, ".junco");
      const cfg = { ...stubConfig(), dataDir, queueRoot: join(dataDir, "queue") } as Config;
      const deps = makeDeps({
        env: { HOME: home },
        loadConfigFn: vi.fn(() => cfg),
        acquireLockFn: (p: string) => acquireSingletonLock(p), // REAL
        acquireTreeLockFn: (p: string) => acquirePidfileLock(p), // REAL
        readLockHolderFn: (p: string) => readLockHolder(p),
      });

      expect(await run(["start"], deps)).toBe(0);
      expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
      // Both pidfiles were distinct AND both were released on shutdown.
      expect(existsSync(join(dataDir, "worker.lock"))).toBe(false);
      expect(existsSync(join(dataDir, "daemon-tree.lock"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// start — the queue-root claim (#310)
//
// The data-root claim alone misses the shape that actually loses work. A legacy
// `vaultRoot` puts `queueRoot` OUTSIDE `dataDir`, so two configs with two
// DIFFERENT data roots can still name one shared vault queue: neither
// worker.lock (keyed to the config dir) nor the data-root claim collides, and
// both daemons poll the same inbox, claim the same tickets and finalize over
// each other. The queue root gets its own claim for exactly that shape.
// ---------------------------------------------------------------------------

describe("run(['start']) — queue-root claim (#310)", () => {
  it("a normal single-instance start still succeeds, claiming <queueRoot>/daemon-queue.lock", async () => {
    const acquireQueueLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({ acquireQueueLockFn });

    expect(await run(["start"], deps)).toBe(0);
    expect(acquireQueueLockFn).toHaveBeenCalledTimes(1);
    expect(acquireQueueLockFn).toHaveBeenCalledWith(
      join("/sbxroot/data/queue", "daemon-queue.lock"),
    );
    expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
  });

  it("the vault shape: refuses a second start with a different config AND a different dataDir but the SAME queueRoot", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-queue-claim-"));
    try {
      // The legacy-vaultRoot shape: two independent data roots, one shared
      // queue. `daemon-tree.lock` cannot see this — the two data roots differ.
      const sharedQueue = join(root, "vault", "junco");
      const dataDirA = join(root, "data-a");
      const dataDirB = join(root, "data-b");
      const configA = join(root, "a", "config.json");
      const configB = join(root, "b", "config.json");
      const cfgA = { ...stubConfig(), dataDir: dataDirA, queueRoot: sharedQueue } as Config;
      const cfgB = { ...stubConfig(), dataDir: dataDirB, queueRoot: sharedQueue } as Config;

      // The real primitive, against a tmp tree we own — HOME, dataDir and
      // queueRoot are all injected, so nothing can reach the maintainer's
      // ~/.junco or their real queue.
      const realClaim = (p: string) => acquirePidfileLock(p);

      let secondCode = -1;
      const stderrLines: string[] = [];

      const first = makeDeps({
        env: { HOME: root, JUNCO_CONFIG: configA },
        loadConfigFn: vi.fn(() => cfgA),
        acquireTreeLockFn: realClaim,
        acquireQueueLockFn: realClaim,
        // The second daemon starts WHILE the first still holds the claim.
        mainLoopFn: vi.fn(async () => {
          const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
            stderrLines.push(String(s));
            return true;
          });
          try {
            secondCode = await run(
              ["start"],
              makeDeps({
                env: { HOME: root, JUNCO_CONFIG: configB },
                loadConfigFn: vi.fn(() => cfgB),
                acquireTreeLockFn: realClaim,
                acquireQueueLockFn: realClaim,
                readLockHolderFn: (p: string) => readLockHolder(p),
              }),
            );
          } finally {
            spy.mockRestore();
          }
        }),
      });

      expect(await run(["start"], first)).toBe(0);

      expect(secondCode).toBe(0); // see the data-root case above (F1)
      const msg = stderrLines.join("");
      expect(msg).toMatch(/refusing to start/i);
      expect(msg).toContain(`pid ${process.pid}`);
      expect(msg).toContain(sharedQueue);
      expect(msg).toContain(configB);
      // The loser's OWN data-root claim (which it did take — the data roots
      // differ) is handed back, not leaked for the next start to steal.
      expect(existsSync(join(dataDirB, "daemon-tree.lock"))).toBe(false);
      // …and the winner released everything on its way out.
      expect(existsSync(join(sharedQueue, "daemon-queue.lock"))).toBe(false);
      expect(existsSync(join(dataDirA, "daemon-tree.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the refusal never reaches mainLoop and hands back BOTH claims it already took", async () => {
    const workerLock = makeFakeLock();
    const treeLock = makeFakeLock();
    const deps = makeDeps({
      acquireLockFn: vi.fn(() => workerLock),
      acquireTreeLockFn: vi.fn(() => treeLock),
      acquireQueueLockFn: vi.fn(() => null),
      readLockHolderFn: vi.fn(() => 7171),
    });
    const stderrLines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      stderrLines.push(String(s));
      return true;
    });
    try {
      expect(await run(["start"], deps)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
    expect(deps.installSignalHandlersFn).not.toHaveBeenCalled();
    // Once each — released by the one outer `finally` (F2), not by hand.
    expect(treeLock.release).toHaveBeenCalledTimes(1);
    expect(workerLock.release).toHaveBeenCalledTimes(1);
    expect(stderrLines.join("")).toContain("pid 7171");
  });

  it("releases the queue claim after mainLoop returns", async () => {
    const queueLock = makeFakeLock();
    const deps = makeDeps({ acquireQueueLockFn: vi.fn(() => queueLock) });
    await run(["start"], deps);
    expect(queueLock.release).toHaveBeenCalledTimes(1);
  });

  it("STILL releases the queue claim when mainLoop throws", async () => {
    const queueLock = makeFakeLock();
    const deps = makeDeps({
      acquireQueueLockFn: vi.fn(() => queueLock),
      mainLoopFn: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await run(["start"], deps)).toBe(1);
    expect(queueLock.release).toHaveBeenCalledTimes(1);
  });

  it("STILL releases all three claims on a MID-STARTUP throw (after the claims, before mainLoop)", async () => {
    const workerLock = makeFakeLock();
    const treeLock = makeFakeLock();
    const queueLock = makeFakeLock();
    const deps = makeDeps({
      acquireLockFn: vi.fn(() => workerLock),
      acquireTreeLockFn: vi.fn(() => treeLock),
      acquireQueueLockFn: vi.fn(() => queueLock),
      installSignalHandlersFn: vi.fn(() => {
        throw new Error("mid-startup boom");
      }),
    });
    await expect(run(["start"], deps)).rejects.toThrow("mid-startup boom");
    expect(queueLock.release).toHaveBeenCalledTimes(1);
    expect(treeLock.release).toHaveBeenCalledTimes(1);
    expect(workerLock.release).toHaveBeenCalledTimes(1);
  });

  it("a lock-losing start never claims the queue root either", async () => {
    const acquireQueueLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({ acquireLockFn: vi.fn(() => null), acquireQueueLockFn });
    await run(["start"], deps);
    expect(acquireQueueLockFn).not.toHaveBeenCalled();
  });

  it("a DEFAULT install claims three DISTINCT files and cleans up all three", async () => {
    const home = mkdtempSync(join(tmpdir(), "junco-default-queue-"));
    try {
      // The default layout: config at <home>/.junco/config.json (so
      // dirname(configPath) IS dataDir) and queueRoot at <dataDir>/queue. The
      // three claims must be three different files — a shared basename would
      // make the daemon contend with itself and refuse to start.
      const dataDir = join(home, ".junco");
      const queueRoot = join(dataDir, "queue");
      const cfg = { ...stubConfig(), dataDir, queueRoot } as Config;
      const deps = makeDeps({
        env: { HOME: home },
        loadConfigFn: vi.fn(() => cfg),
        acquireLockFn: (p: string) => acquireSingletonLock(p), // REAL
        acquireTreeLockFn: (p: string) => acquirePidfileLock(p), // REAL
        acquireQueueLockFn: (p: string) => acquirePidfileLock(p), // REAL
        readLockHolderFn: (p: string) => readLockHolder(p),
      });

      expect(await run(["start"], deps)).toBe(0);
      expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
      expect(existsSync(join(dataDir, "worker.lock"))).toBe(false);
      expect(existsSync(join(dataDir, "daemon-tree.lock"))).toBe(false);
      expect(existsSync(join(queueRoot, "daemon-queue.lock"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// start — the shared-root refusal must not be a supervisor restart trigger
// (final review F1)
//
// The refusal's whole audience is the operator running a SECOND supervised
// unit for a second config that resolves to one data root — #310's own
// population. The rendered units restart on a non-zero exit, so an exit-1
// refusal is a 30-second respawn loop that never ends: twelve lines of refusal
// ~2,880 times a day, plus a `withBotAuth` `gh` subprocess per cycle. The
// message carries the loudness; the exit code's only real consumer here is the
// supervisor, and its correct instruction is "stay down".
// ---------------------------------------------------------------------------

describe("run(['start']) — refusal exit code vs. supervisor restart (#310, F1)", () => {
  /** Run `start` with stderr captured, returning [exitCode, stderr]. */
  async function runQuiet(deps: CliDeps): Promise<[number, string]> {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
    try {
      return [await run(["start"], deps), lines.join("")];
    } finally {
      spy.mockRestore();
    }
  }

  it("the rendered units DO restart on a non-zero exit — the coupling this exit code answers to", () => {
    // Pinned here so the two can never drift apart silently: if either unit
    // ever stops restarting on failure, this test is where the reasoning
    // behind `return 0` gets revisited.
    const opts = { cliEntry: "/opt/junco/dist/cli.js", stopTimeoutSeconds: 60 };
    const launchd = renderService("launchd", opts);
    expect(launchd).toMatch(/<key>KeepAlive<\/key>/);
    expect(launchd).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(renderService("systemd", opts)).toContain("Restart=on-failure");
  });

  it("the data-root refusal exits 0, exactly like the worker.lock branch", async () => {
    const [code, msg] = await runQuiet(makeDeps({ acquireTreeLockFn: vi.fn(() => null) }));
    expect(code).toBe(0);
    // Exit 0 is NOT silence: the refusal is still twelve loud lines, and it
    // says so itself, so an operator reading `echo $?` is not misled.
    expect(msg).toMatch(/refusing to start/i);
    expect(msg).toMatch(/did NOT start/);
    expect(msg).toMatch(/Exiting 0 on purpose/);
  });

  it("the queue-root refusal exits 0 too", async () => {
    const [code, msg] = await runQuiet(makeDeps({ acquireQueueLockFn: vi.fn(() => null) }));
    expect(code).toBe(0);
    expect(msg).toMatch(/refusing to start/i);
    expect(msg).toMatch(/Exiting 0 on purpose/);
  });

  it("neither refusal runs mainLoop — exit 0 means 'not started', never 'started'", async () => {
    const tree = makeDeps({ acquireTreeLockFn: vi.fn(() => null) });
    await runQuiet(tree);
    expect(tree.mainLoopFn).not.toHaveBeenCalled();
    const queue = makeDeps({ acquireQueueLockFn: vi.fn(() => null) });
    await runQuiet(queue);
    expect(queue.mainLoopFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// start — a THROWING claim acquisition must not leak the locks already held
// (final review F2)
//
// `acquirePidfileLock` mkdirs and writes, so EACCES on an unwritable root,
// EROFS or ENOSPC all reach the caller as an exception. Acquiring outside the
// outer `try` reintroduced exactly the leak that `try` was added to close.
// ---------------------------------------------------------------------------

describe("run(['start']) — a throwing claim acquisition (#310, F2)", () => {
  it("a throw from the DATA-ROOT acquisition still hands back worker.lock", async () => {
    const workerLock = makeFakeLock();
    const deps = makeDeps({
      acquireLockFn: vi.fn(() => workerLock),
      acquireTreeLockFn: vi.fn(() => {
        throw Object.assign(new Error("EACCES: permission denied, mkdir '/srv/junco'"), {
          code: "EACCES",
        });
      }),
    });
    await expect(run(["start"], deps)).rejects.toThrow(/EACCES/);
    expect(workerLock.release).toHaveBeenCalledTimes(1);
  });

  it("a throw from the QUEUE acquisition hands back BOTH worker.lock and the data-root claim", async () => {
    const workerLock = makeFakeLock();
    const treeLock = makeFakeLock();
    const deps = makeDeps({
      acquireLockFn: vi.fn(() => workerLock),
      acquireTreeLockFn: vi.fn(() => treeLock),
      acquireQueueLockFn: vi.fn(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }),
    });
    await expect(run(["start"], deps)).rejects.toThrow(/ENOSPC/);
    expect(treeLock.release).toHaveBeenCalledTimes(1);
    expect(workerLock.release).toHaveBeenCalledTimes(1);
  });

  it("leaves NO pidfile on disk when the queue acquisition throws (real primitive, real tmp roots)", async () => {
    const home = mkdtempSync(join(tmpdir(), "junco-claim-throw-"));
    try {
      const dataDir = join(home, ".junco");
      const cfg = { ...stubConfig(), dataDir, queueRoot: join(dataDir, "queue") } as Config;
      const deps = makeDeps({
        env: { HOME: home },
        loadConfigFn: vi.fn(() => cfg),
        acquireLockFn: (p: string) => acquireSingletonLock(p), // REAL
        acquireTreeLockFn: (p: string) => acquirePidfileLock(p), // REAL
        acquireQueueLockFn: () => {
          throw new Error("EROFS: read-only file system");
        },
        readLockHolderFn: (p: string) => readLockHolder(p),
      });
      await expect(run(["start"], deps)).rejects.toThrow(/EROFS/);
      // Both real pidfiles are gone — nothing for the next start to steal.
      expect(existsSync(join(dataDir, "worker.lock"))).toBe(false);
      expect(existsSync(join(dataDir, "daemon-tree.lock"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// start — mainLoop throws
// ---------------------------------------------------------------------------

describe("run(['start']) — mainLoop throws", () => {
  it("returns 1", async () => {
    const deps = makeDeps({
      mainLoopFn: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await run(["start"], deps)).toBe(1);
  });

  it("STILL calls uninstall (finally)", async () => {
    const uninstallSpy = vi.fn();
    const deps = makeDeps({
      installSignalHandlersFn: vi.fn(() => uninstallSpy),
      mainLoopFn: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await run(["start"], deps);
    expect(uninstallSpy).toHaveBeenCalledTimes(1);
  });

  it("STILL calls lock.release() (finally)", async () => {
    const fakeLock = makeFakeLock();
    const deps = makeDeps({
      acquireLockFn: vi.fn(() => fakeLock),
      mainLoopFn: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await run(["start"], deps);
    expect(fakeLock.release).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// start — watchConfigFn throws (Fix A: guarded watcher startup, Task 6)
// ---------------------------------------------------------------------------

describe("run(['start']) — watchConfigFn throws (Fix A)", () => {
  // Previously an unguarded `watcher = watchConfigFn(configPath, holder)` let
  // a throw (EMFILE/ENOSPC/EACCES/unsupported FS) escape straight out of
  // run(): mainLoop never ran, and none of uninstall()/lock.release()/
  // teardownLogs() fired. The fix wraps the call in try/catch so a throw just
  // disables hot-reload (holder stays seeded, never updated) and startup
  // continues normally.
  it("does not crash startup — mainLoop still runs and start still returns 0", async () => {
    const deps = makeDeps({
      watchConfigFn: vi.fn(() => {
        throw new Error("EMFILE: too many open files");
      }),
    });
    const code = await run(["start"], deps);
    expect(code).toBe(0);
    expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
  });

  it("still tears down: lock.release() and the signal-handler uninstall both run", async () => {
    const fakeLock = makeFakeLock();
    const uninstallSpy = vi.fn();
    const deps = makeDeps({
      acquireLockFn: vi.fn(() => fakeLock),
      installSignalHandlersFn: vi.fn(() => uninstallSpy),
      watchConfigFn: vi.fn(() => {
        throw new Error("EMFILE: too many open files");
      }),
    });
    await run(["start"], deps);
    expect(fakeLock.release).toHaveBeenCalledTimes(1);
    expect(uninstallSpy).toHaveBeenCalledTimes(1);
  });

  it("logs a warning naming the failure instead of propagating it", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
    const deps = makeDeps({
      watchConfigFn: vi.fn(() => {
        throw new Error("EMFILE: too many open files");
      }),
    });
    try {
      await run(["start"], deps);
    } finally {
      spy.mockRestore();
    }
    const out = lines.join("");
    expect(out).toMatch(/watcher/i);
    expect(out).toContain("EMFILE");
  });
});

// ---------------------------------------------------------------------------
// bare invocation → ensure the daemon, then dashboard
// ---------------------------------------------------------------------------

describe("run([]) — bare invocation ensures the daemon, then dashboard", () => {
  it("ensures the daemon THEN opens the dashboard when a config exists (bare, TTY)", async () => {
    const { cfg } = freshDispatchVault();
    const ensure = vi.fn(async (): Promise<EnsureResult> => ({ state: "running", pid: 7 }));
    const dash = vi.fn(async () => 0);
    const deps = makeDeps({
      existsFn: () => true,
      isTTYFn: () => true,
      loadConfigFn: () => cfg,
      ensureDaemonFn: ensure,
      runDashboardFn: dash,
    });
    expect(await run([], deps)).toBe(0);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(dash).toHaveBeenCalledTimes(1);
    // ordering: ensured BEFORE the dashboard opened
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(dash.mock.invocationCallOrder[0]);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });

  it("routes to the dashboard FTUE (no pre-flight) when no config exists", async () => {
    const ensure = vi.fn(async (): Promise<EnsureResult> => ({ state: "running", pid: 1 }));
    const dash = vi.fn(async () => 0);
    const deps = makeDeps({
      existsFn: () => false,
      isTTYFn: () => true,
      ensureDaemonFn: ensure,
      runDashboardFn: dash,
    });
    expect(await run([], deps)).toBe(0);
    expect(dash).toHaveBeenCalledWith(null, expect.any(String));
    expect(ensure).not.toHaveBeenCalled();
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });

  it("bare + config but NON-TTY skips the pre-flight (no daemon started in pipes/CI)", async () => {
    const { cfg } = freshDispatchVault();
    const ensure = vi.fn(async (): Promise<EnsureResult> => ({ state: "running", pid: 1 }));
    const dash = vi.fn(async () => 0);
    const deps = makeDeps({
      existsFn: () => true,
      isTTYFn: () => false,
      loadConfigFn: () => cfg,
      ensureDaemonFn: ensure,
      runDashboardFn: dash,
    });
    expect(await run([], deps)).toBe(0);
    expect(ensure).not.toHaveBeenCalled();
    expect(dash).toHaveBeenCalledTimes(1);
  });

  it("explicit `dashboard` does NOT run the pre-flight (pure observer)", async () => {
    const { cfg } = freshDispatchVault();
    const ensure = vi.fn(async (): Promise<EnsureResult> => ({ state: "running", pid: 1 }));
    const dash = vi.fn(async () => 0);
    const deps = makeDeps({
      existsFn: () => true,
      isTTYFn: () => true,
      loadConfigFn: () => cfg,
      ensureDaemonFn: ensure,
      runDashboardFn: dash,
    });
    expect(await run(["dashboard"], deps)).toBe(0);
    expect(ensure).not.toHaveBeenCalled();
    expect(dash).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// FTUE gate (#273) — the FRESH setup walkthrough refuses to run when this
// machine already has a junco (a live daemon, or a populated data tree with no
// config at the resolved path). The 2026-08-01 split-queue incident was the
// walkthrough writing a competing config against a daemon with four days of
// uptime. The RE-RUN path is deliberately never gated: it reads and writes
// back the SAME file, so it cannot create a competing config, and it is the
// only door an operator has for fixing a broken one (there is no
// `junco setup`).
// ---------------------------------------------------------------------------

describe("run([]) — the fresh setup walkthrough refuses against a live junco (#273)", () => {
  /** A machine with nothing on disk: no config, no data tree. */
  const FRESH_ENV = { HOME: "/nonexistent/junco-ftue-home" };
  const LOCK_PATH = "/nonexistent/junco-ftue-home/.junco/worker.lock";
  const DATA_ROOT = "/nonexistent/junco-ftue-home/.junco";

  /** Capture stderr around a run() (the :409 / auth-login precedent). */
  async function runCapturingStderr(
    argv: string[],
    deps: CliDeps,
  ): Promise<{ code: number; err: string }> {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      lines.push(String(s));
      return true;
    });
    try {
      const code = await run(argv, deps);
      return { code, err: lines.join("") };
    } finally {
      spy.mockRestore();
    }
  }

  it("(a) refuses with exit 1 and names the live daemon when /health answers", async () => {
    const dash = vi.fn(async () => 0);
    const ensure = vi.fn(async (): Promise<EnsureResult> => ({ state: "running", pid: 1 }));
    const { code, err } = await runCapturingStderr(
      [],
      makeDeps({
        env: FRESH_ENV,
        existsFn: () => false, // no config, no data tree
        isTTYFn: () => true,
        runDashboardFn: dash,
        ensureDaemonFn: ensure,
        readLockHolderFn: () => null, // lock lives elsewhere (HOME moved)
        fetchHealthFn: async () => ({ metrics: { pid: 4242, uptimeSeconds: 372_000 } }),
      }),
    );
    expect(code).toBe(1); // 1, never 130 — 130 means the user cancelled
    expect(dash).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(err).toContain("4242"); // names the daemon
    expect(err).toContain("103h20m"); // ...and its uptime
    expect(err).toContain("127.0.0.1:8787");
    // Not a dead end: the resolved config path plus concrete next steps.
    expect(err).toContain("/nonexistent/junco-ftue-home/.junco/config.json");
    expect(err).toContain("junco doctor");
    // ...and NOT `junco status`, or any other config-loading command. This
    // refusal only prints when there is no file at the resolved path, and
    // `status` calls loadConfig unconditionally (parseConfigFile rethrows the
    // ENOENT) — advising it hands the operator a guaranteed second crash. Only
    // `doctor` survives a missing config, by catching the load failure and
    // reporting it as a finding.
    expect(err).not.toContain("junco status");
  });

  it("(a2) refuses on the worker.lock holder alone (a health-disabled daemon)", async () => {
    const dash = vi.fn(async () => 0);
    const health = vi.fn(async () => null);
    const { code, err } = await runCapturingStderr(
      [],
      makeDeps({
        env: FRESH_ENV,
        existsFn: () => false,
        isTTYFn: () => true,
        runDashboardFn: dash,
        readLockHolderFn: (p: string) => (p === LOCK_PATH ? 777 : null),
        fetchHealthFn: health,
      }),
    );
    expect(code).toBe(1);
    expect(dash).not.toHaveBeenCalled();
    expect(err).toContain("777");
    expect(err).toContain(LOCK_PATH);
    // The pidfile is the cheaper, config-free probe — it must short-circuit
    // the 1500 ms health fetch, not run alongside it.
    expect(health).not.toHaveBeenCalled();
  });

  it("(b) refuses and names the populated data root when no daemon is live", async () => {
    const dash = vi.fn(async () => 0);
    // The moved-HOME / typo'd-config shape: no config at the resolved path,
    // but the data tree beside it is populated.
    const existsFn = (p: string): boolean => p === join(DATA_ROOT, "queue");
    const { code, err } = await runCapturingStderr(
      [],
      makeDeps({
        env: FRESH_ENV,
        existsFn,
        isTTYFn: () => true,
        runDashboardFn: dash,
        readLockHolderFn: () => null,
        fetchHealthFn: async () => null,
      }),
    );
    expect(code).toBe(1);
    expect(dash).not.toHaveBeenCalled();
    expect(err).toContain(DATA_ROOT); // names the populated root
    expect(err).toContain("/nonexistent/junco-ftue-home/.junco/config.json");
    expect(err).toContain("junco doctor");
    expect(err).toContain("junco config init"); // this message's own escape hatch
    expect(err).not.toContain("junco status"); // see (a): it crashes in this state
    // A distinct message from the live-daemon refusal — not one generic wall.
    expect(err).not.toMatch(/daemon is already running/i);
  });

  it("(c) a genuinely fresh machine still opens the walkthrough", async () => {
    const dash = vi.fn(async () => 0);
    const { code, err } = await runCapturingStderr(
      [],
      makeDeps({
        env: FRESH_ENV,
        existsFn: () => false,
        isTTYFn: () => true,
        runDashboardFn: dash,
        readLockHolderFn: () => null,
        fetchHealthFn: async () => null,
      }),
    );
    expect(code).toBe(0);
    expect(dash).toHaveBeenCalledWith(null, expect.any(String));
    expect(err).not.toMatch(/refusing/i);
  });

  it("(d) the RE-RUN path is never gated — a live daemon does not block editing an existing config", async () => {
    // THE critical negative test. Re-run mode rewrites the SAME file it read
    // (wizard.ts), so it cannot split the queue; and it is the only tool an
    // operator has for repairing a config. Gating it would lock them out.
    const { cfg } = freshDispatchVault();
    for (const argv of [[], ["dashboard"]]) {
      const dash = vi.fn(async (_c: Config | null, _p: string) => 0);
      const { code, err } = await runCapturingStderr(
        argv,
        makeDeps({
          env: FRESH_ENV,
          existsFn: () => true, // config on disk → re-run mode
          isTTYFn: () => true,
          loadConfigFn: () => cfg,
          runDashboardFn: dash,
          ensureDaemonFn: vi.fn(
            async (): Promise<EnsureResult> => ({
              state: "running",
              pid: 4242,
            }),
          ),
          // A very live daemon, on both probes.
          readLockHolderFn: () => 4242,
          fetchHealthFn: async () => ({ metrics: { pid: 4242, uptimeSeconds: 372_000 } }),
        }),
      );
      expect(code).toBe(0);
      expect(dash).toHaveBeenCalledTimes(1);
      expect(dash.mock.calls[0][0]).not.toBeNull(); // the loaded config, not the FTUE null
      expect(err).not.toMatch(/refusing/i);
    }
  });
});

// ---------------------------------------------------------------------------
// run-once subcommand
// ---------------------------------------------------------------------------

describe("run(['run-once'])", () => {
  it("returns 0", async () => {
    const deps = makeDeps();
    expect(await run(["run-once"], deps)).toBe(0);
  });

  it("calls runOnceFn", async () => {
    const deps = makeDeps();
    await run(["run-once"], deps);
    expect(deps.runOnceFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT call acquireLockFn (run-once skips the singleton lock)", async () => {
    const deps = makeDeps();
    await run(["run-once"], deps);
    expect(deps.acquireLockFn).not.toHaveBeenCalled();
  });

  it("does NOT call mainLoopFn", async () => {
    const deps = makeDeps();
    await run(["run-once"], deps);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bot auth at daemon entrypoints — Task 6
// ---------------------------------------------------------------------------

describe("bot auth at daemon entrypoints", () => {
  it("start refuses to run when bot auth resolution throws", async () => {
    const deps = makeDeps({
      withBotAuthFn: async () => {
        throw new Error("botAccount.enabled is true but no working gh login exists");
      },
    });
    const code = await run(["start"], deps);
    expect(code).toBe(1);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
    expect(deps.acquireLockFn).not.toHaveBeenCalled();
  });

  it("start's refusal prints the failure to stderr", async () => {
    const deps = makeDeps({
      withBotAuthFn: async () => {
        throw new Error("botAccount.enabled is true but no working gh login exists");
      },
    });
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
    try {
      await run(["start"], deps);
    } finally {
      spy.mockRestore();
    }
    expect(lines.join("")).toContain("botAccount.enabled is true but no working gh login exists");
  });

  it("start passes the bot-attached config through to mainLoopFn", async () => {
    const deps = makeDeps({
      withBotAuthFn: async (c: Config) => ({ ...c, ghAuth: GH_AUTH_CTX }),
    });
    await run(["start"], deps);
    const [seenCfg] = (deps.mainLoopFn as MockedFunction<any>).mock.calls[0];
    expect((seenCfg as Config).ghAuth?.login).toBe(GH_AUTH_CTX.login);
  });

  it("start's watcher re-attaches the startup ghAuth context while the reload keeps botAccount enabled, and drops it when the reload disables botAccount", async () => {
    const watchConfigFn = vi.fn(() => ({ close: vi.fn() }));
    const deps = makeDeps({
      withBotAuthFn: async (c: Config) => ({ ...c, ghAuth: GH_AUTH_CTX }),
      watchConfigFn,
    });
    await run(["start"], deps);

    const [, , watchDeps] = (watchConfigFn as MockedFunction<any>).mock.calls[0];
    const assembleFn = watchDeps.assembleFn as (d: ConfigParsed) => Config;

    const enabledParsed = ConfigSchema.parse({
      vaultRoot: "/tmp/x",
      botAccount: { enabled: true, configDir: "/tmp/gh" },
    });
    expect(assembleFn(enabledParsed).ghAuth?.login).toBe(GH_AUTH_CTX.login);

    const disabledParsed = ConfigSchema.parse({
      vaultRoot: "/tmp/x",
      botAccount: { enabled: false },
    });
    expect(assembleFn(disabledParsed).ghAuth).toBeUndefined();
  });

  it("start's watcher never FABRICATES ghAuth: bot disabled at startup, reload enables it → still no ghAuth", async () => {
    const watchConfigFn = vi.fn(() => ({ close: vi.fn() }));
    // Bot disabled at startup → withBotAuthFn resolves no ghAuth (passthrough).
    const deps = makeDeps({
      withBotAuthFn: async (c: Config) => c,
      watchConfigFn,
    });
    await run(["start"], deps);

    const [, , watchDeps] = (watchConfigFn as MockedFunction<any>).mock.calls[0];
    const assembleFn = watchDeps.assembleFn as (d: ConfigParsed) => Config;

    // A live edit turns the bot ON, but there is no startup-resolved context to
    // attach — the assembler must NOT invent one (only a restart resolves auth).
    const enabledParsed = ConfigSchema.parse({
      vaultRoot: "/tmp/x",
      botAccount: { enabled: true, configDir: "/tmp/gh" },
    });
    expect(assembleFn(enabledParsed).ghAuth).toBeUndefined();
  });

  it("run-once refuses to run when bot auth resolution throws", async () => {
    const deps = makeDeps({
      withBotAuthFn: async () => {
        throw new Error("boom");
      },
    });
    const code = await run(["run-once"], deps);
    expect(code).toBe(1);
    expect(deps.runOnceFn).not.toHaveBeenCalled();
  });

  it("run-once hands the attached config to runOnceFn", async () => {
    let seen: Config | undefined;
    const deps = makeDeps({
      withBotAuthFn: async (c: Config) => ({ ...c, ghAuth: GH_AUTH_CTX }),
      runOnceFn: async (c: Config) => {
        seen = c;
        return false;
      },
    });
    const code = await run(["run-once"], deps);
    expect(code).toBe(0);
    expect(seen?.ghAuth?.login).toBe(GH_AUTH_CTX.login);
  });
});

// ---------------------------------------------------------------------------
// unknown subcommand
// ---------------------------------------------------------------------------

describe("run(['bogus']) — unknown subcommand", () => {
  it("returns 2", async () => {
    const deps = makeDeps();
    expect(await run(["bogus"], deps)).toBe(2);
  });

  it("does NOT call mainLoopFn", async () => {
    const deps = makeDeps();
    await run(["bogus"], deps);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });

  it("does NOT call runOnceFn", async () => {
    const deps = makeDeps();
    await run(["bogus"], deps);
    expect(deps.runOnceFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// --help / -h
// ---------------------------------------------------------------------------

describe("run(['--help'])", () => {
  it("returns 0", async () => {
    const deps = makeDeps();
    expect(await run(["--help"], deps)).toBe(0);
  });

  it("does NOT call mainLoopFn", async () => {
    const deps = makeDeps();
    await run(["--help"], deps);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });

  it("does NOT call runOnceFn", async () => {
    const deps = makeDeps();
    await run(["--help"], deps);
    expect(deps.runOnceFn).not.toHaveBeenCalled();
  });
});

describe("run(['-h'])", () => {
  it("returns 0", async () => {
    const deps = makeDeps();
    expect(await run(["-h"], deps)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// --version
// ---------------------------------------------------------------------------

describe("run(['--version'])", () => {
  it("--version prints the package version and exits 0", async () => {
    const out: string[] = [];
    const code = await run(["--version"], { printFn: (s) => out.push(s) });
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(code).toBe(0);
    expect(out.join("")).toBe(`${pkg.version}\n`);
  });
});

// ---------------------------------------------------------------------------
// service subcommand
// ---------------------------------------------------------------------------

describe("run(['service','--platform','systemd'])", () => {
  it("returns 0", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s), env: { HOME: "/tmp" } });
    const code = await run(["service", "--platform", "systemd"], deps);
    expect(code).toBe(0);
  });

  it("captured output contains [Unit]", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s), env: { HOME: "/tmp" } });
    await run(["service", "--platform", "systemd"], deps);
    expect(captured.join("")).toContain("[Unit]");
  });

  it("captured output contains ExecStart=", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s), env: { HOME: "/tmp" } });
    await run(["service", "--platform", "systemd"], deps);
    expect(captured.join("")).toContain("ExecStart=");
  });

  it("does NOT call mainLoopFn", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s), env: { HOME: "/tmp" } });
    await run(["service", "--platform", "systemd"], deps);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });
});

describe("run(['service','--platform','launchd'])", () => {
  it("returns 0", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s), env: { HOME: "/tmp" } });
    const code = await run(["service", "--platform", "launchd"], deps);
    expect(code).toBe(0);
  });

  it("captured output contains <plist", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s), env: { HOME: "/tmp" } });
    await run(["service", "--platform", "launchd"], deps);
    expect(captured.join("")).toContain("<plist");
  });
});

describe("run(['service']) — #118 stop-timeout sizing", () => {
  it("sizes the stop-timeout to the largest QUEUED ticket timeout, not just the default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-svc-"));
    const inbox = join(dir, "inbox");
    mkdirSync(inbox, { recursive: true });
    // A ticket whose per-ticket override (180 min) far exceeds the 30-min default.
    writeFileSync(join(inbox, "big.md"), "---\ntimeout_minutes: 180\n---\nbody\n");
    const captured: string[] = [];
    const cfg = {
      queueRoot: dir,
      defaultTimeoutMinutes: 30,
    } as unknown as Config;
    const deps = makeDeps({
      printFn: (s) => captured.push(s),
      loadConfigFn: () => cfg,
      env: { HOME: dir },
    });
    try {
      await run(["service", "--platform", "systemd"], deps);
      // 180-min ticket + 10-min drain margin = 190 min = 11400 s. The old
      // default-only sizing (30+10 = 40 min → 2400 s) would SIGKILL it mid-drain.
      expect(captured.join("")).toContain("TimeoutStopSec=11400");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the default when the queue holds nothing longer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-svc-"));
    mkdirSync(join(dir, "inbox"), { recursive: true });
    // A short ticket (10 min) must NOT shrink the window below the default.
    writeFileSync(join(dir, "inbox", "small.md"), "---\ntimeout_minutes: 10\n---\nbody\n");
    const captured: string[] = [];
    const cfg = {
      queueRoot: dir,
      defaultTimeoutMinutes: 30,
    } as unknown as Config;
    const deps = makeDeps({
      printFn: (s) => captured.push(s),
      loadConfigFn: () => cfg,
      env: { HOME: dir },
    });
    try {
      await run(["service", "--platform", "systemd"], deps);
      // max(30, 10) + 10 = 40 min → 2400 s.
      expect(captured.join("")).toContain("TimeoutStopSec=2400");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// lock path derivation
// ---------------------------------------------------------------------------

describe("lock path derivation", () => {
  // Synthetic `/sbxroot/...` HOMEs, not `/tmp/...`: since F4 the derivation
  // canonicalizes the config DIRECTORY, and on macOS `/tmp` is a symlink into
  // `/private/tmp`, so a `/tmp`-rooted expectation would assert the
  // pre-canonicalization spelling. A non-existent path canonicalizes to
  // itself, which is exactly what makes these pins path-pure.
  it("derives lock path as worker.lock in the resolved config directory (env-driven, not --config)", async () => {
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({
      acquireLockFn,
      loadConfigFn: vi.fn(() => stubConfig()),
      env: { HOME: "/sbxroot/foo" },
    });
    await run(["start"], deps);
    expect(acquireLockFn).toHaveBeenCalledWith(join("/sbxroot/foo", ".junco", "worker.lock"));
  });

  it("uses the resolved config directory (env-only default, no cwd probe)", async () => {
    // No cwd probe left: with no config on disk, resolution lands on the
    // canonical ~/.junco/config.json for the injected HOME.
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({ acquireLockFn, env: { HOME: "/sbxroot/junco-default-home" } });
    await run(["start"], deps);
    expect(acquireLockFn).toHaveBeenCalledWith(
      join("/sbxroot/junco-default-home", ".junco", "worker.lock"),
    );
  });

  it("JUNCO_CONFIG relocates both the config and the worker.lock beside it", async () => {
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({
      acquireLockFn,
      loadConfigFn: vi.fn(() => stubConfig()),
      env: { HOME: "/sbxroot/foo", JUNCO_CONFIG: "/sbxroot/elsewhere/cfg.json" },
    });
    await run(["start"], deps);
    expect(acquireLockFn).toHaveBeenCalledWith(join("/sbxroot/elsewhere", "worker.lock"));
  });
});

// ---------------------------------------------------------------------------
// Dispatch CLI subcommands — M6-T2
// ---------------------------------------------------------------------------

/**
 * The shared Config fixture, for tests that touch the real FS (inbox-path,
 * submit, init). dataDir/queueRoot are overridden per test in
 * freshDispatchVault() so they track that test's own tmpdir.
 */
const DISPATCH_CONFIG_BASE: Omit<Config, "dataDir" | "queueRoot"> = makeConfig(
  {
    // placeholders — freshDispatchVault() overwrites both with its own tmpdir
    dataDir: "",
    queueRoot: "",
    worktreeRoot: "/tmp/worktrees",
    tools: ["read"],
    criticEnabled: false,
    planLintEnabled: false,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: true,
  },
  {
    github: {
      enabled: false,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos: [],
      requireApproval: true,
      plannerModelId: null,
      externalReposRoot: "/tmp/junco-test-external",
    },
    botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
  },
);

let dispatchTmpDirs: string[] = [];

function freshDispatchVault(extraConfig: Record<string, unknown> = {}): {
  cfg: Config;
  vaultRoot: string;
  configPath: string;
} {
  const vaultRoot = mkdtempSync(join(tmpdir(), "junco-cli-dispatch-"));
  dispatchTmpDirs.push(vaultRoot);
  const cfg: Config = {
    ...DISPATCH_CONFIG_BASE,
    dataDir: vaultRoot,
    queueRoot: join(vaultRoot, "Junco"),
  };
  // write a real config.json at the canonical ~/.junco/config.json location
  // (HOME=vaultRoot for these tests) so loadConfig can load it. `extraConfig`
  // (e.g. `{ planSets: { enabled: true } }`) is merged in for tests that need
  // a feature toggle on — submit --plan tests go through this real disk
  // config, never a loadConfigFn override.
  const configPath = join(vaultRoot, ".junco", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ vaultRoot, juncoSubdir: "Junco", ...extraConfig }),
    "utf8",
  );
  return { cfg, vaultRoot, configPath };
}

afterEach(() => {
  for (const d of dispatchTmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  dispatchTmpDirs = [];
});

// --- inbox-path ---

describe("run(['inbox-path'])", () => {
  it("returns 0", async () => {
    const { vaultRoot } = freshDispatchVault();
    const captured: string[] = [];
    const code = await run(["inbox-path"], {
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(code).toBe(0);
  });

  it("prints output ending with /inbox\\n", async () => {
    const { vaultRoot } = freshDispatchVault();
    const captured: string[] = [];
    await run(["inbox-path"], {
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    const out = captured.join("");
    expect(out.trimEnd()).toMatch(/\/inbox$/);
    expect(out).toMatch(/\n$/);
  });
});

// --- schema ---

describe("run(['schema'])", () => {
  it("returns 0", async () => {
    const captured: string[] = [];
    const code = await run(["schema"], {
      printFn: (s) => captured.push(s),
    });
    expect(code).toBe(0);
  });

  it("printed output parses as JSON", async () => {
    const captured: string[] = [];
    await run(["schema"], { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("parsed JSON has a title field", async () => {
    const captured: string[] = [];
    await run(["schema"], { printFn: (s) => captured.push(s) });
    const parsed = JSON.parse(captured.join(""));
    expect(parsed.title).toBeTruthy();
  });

  it("does NOT call loadConfigFn (schema is static)", async () => {
    const loadConfigFn = vi.fn(() => ({}) as Config);
    await run(["schema"], { loadConfigFn });
    expect(loadConfigFn).not.toHaveBeenCalled();
  });
});

// --- submit (stdin) ---

describe("run(['submit', '-']) — stdin", () => {
  const TICKET_CONTENT = `---\nid: cli-stdin-test\npriority: normal\n---\n\n# Test ticket\n`;

  it("returns 0", async () => {
    const { vaultRoot } = freshDispatchVault();
    const captured: string[] = [];
    const code = await run(["submit", "-"], {
      printFn: (s) => captured.push(s),
      readStdinFn: async () => TICKET_CONTENT,
      env: { HOME: vaultRoot },
    });
    expect(code).toBe(0);
  });

  it("prints 'submitted: ...'", async () => {
    const { vaultRoot } = freshDispatchVault();
    const captured: string[] = [];
    await run(["submit", "-"], {
      printFn: (s) => captured.push(s),
      readStdinFn: async () => TICKET_CONTENT,
      env: { HOME: vaultRoot },
    });
    expect(captured.join("")).toMatch(/submitted:/);
  });

  it("the ticket lands in the inbox", async () => {
    const { vaultRoot } = freshDispatchVault();
    const captured: string[] = [];
    await run(["submit", "-"], {
      printFn: (s) => captured.push(s),
      readStdinFn: async () => TICKET_CONTENT,
      env: { HOME: vaultRoot },
    });
    const expected = join(vaultRoot, "Junco", "inbox", "cli-stdin-test.md");
    expect(existsSync(expected)).toBe(true);
  });

  // Dangling-edge warning (spec 2026-08-20, #T9 review fix): submit never
  // refuses on a depends_on id that resolves nowhere, but warns on stderr —
  // best-effort, wrapped in try/catch so it can never turn a successful
  // submit into a failure (Task 3's ticketState/findTicketFile rethrow
  // non-ENOENT fs errors, which is exactly what that wrapper guards against).
  it("warns on stderr when depends_on references no queued or finished ticket", async () => {
    const { vaultRoot } = freshDispatchVault();
    const captured: string[] = [];
    const errLines: string[] = [];
    // Precedent: "start's refusal prints the failure to stderr" (above) — capture
    // into a plain array from mockImplementation rather than reading
    // errSpy.mock.calls after mockRestore(), which internally mockReset()s and
    // wipes the recorded calls.
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errLines.push(String(s));
      return true;
    });
    let code: number;
    try {
      code = await run(["submit", "-"], {
        printFn: (s) => captured.push(s),
        readStdinFn: async () => "---\nid: kid\ndepends_on: [ghost]\n---\n",
        env: { HOME: vaultRoot },
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(code).toBe(0);
    expect(captured.join("")).toMatch(/submitted:/);
    expect(errLines.join("")).toContain(
      "junco submit: warning — depends_on references no queued or finished ticket: ghost (the ticket will wait until they exist)",
    );
  });

  it("does not warn on stderr when the ticket has no depends_on", async () => {
    const { vaultRoot } = freshDispatchVault();
    const captured: string[] = [];
    const errLines: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errLines.push(String(s));
      return true;
    });
    try {
      await run(["submit", "-"], {
        printFn: (s) => captured.push(s),
        readStdinFn: async () => TICKET_CONTENT,
        env: { HOME: vaultRoot },
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(errLines.join("")).not.toContain("junco submit: warning");
  });
});

// --- submit (no file arg) ---

describe("run(['submit']) — missing file argument", () => {
  it("returns 2", async () => {
    const { vaultRoot } = freshDispatchVault();
    const captured: string[] = [];
    const code = await run(["submit"], {
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(code).toBe(2);
  });
});

// --- submit --plan (Task 12, spec 2026-08-20 Layer 2): the local CLI door
// that compiles an approved junco-plan fence into child tickets. ---

describe("run(['submit', '--plan', ...]) — plan-set CLI door", () => {
  function wrapFence(fence: string): string {
    return `# Test plan\n\n\`\`\`junco-plan\n${fence.trimEnd()}\n\`\`\`\n`;
  }

  const TWO_TASK_FENCE =
    "version: 1\n" +
    "tasks:\n" +
    "  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}\n" +
    "  - {id: b, title: T B, depends_on: [a], description: Build B., acceptance: [works]}\n";

  it("submit --plan compiles a set into the inbox", async () => {
    const { vaultRoot } = freshDispatchVault({ planSets: { enabled: true, maxTasks: 10 } });
    const planFile = join(vaultRoot, "my-plan.md");
    writeFileSync(planFile, wrapFence(TWO_TASK_FENCE), "utf8");
    const repoDir = join(vaultRoot, "repo");
    const captured: string[] = [];
    const code = await run(["submit", "--plan", planFile, "--repo", repoDir], {
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    const out = captured.join("");
    expect(code).toBe(0);
    expect(out).toMatch(/^plan set plan-my-plan \(2 tasks, rev [0-9a-f]{12}\)\n/);
    expect((out.match(/^submitted:/gm) ?? []).length).toBe(2);

    const inboxDir = join(vaultRoot, "Junco", "inbox");
    const aPath = join(inboxDir, "plan-my-plan-a.md");
    const bPath = join(inboxDir, "plan-my-plan-b.md");
    expect(existsSync(aPath)).toBe(true);
    expect(existsSync(bPath)).toBe(true);
    expect(readFileSync(bPath, "utf8")).toContain("depends_on: [plan-my-plan-a]");
  });

  it("submit --plan refuses compile errors whole and dispatches nothing", async () => {
    const { vaultRoot } = freshDispatchVault({ planSets: { enabled: true, maxTasks: 10 } });
    const planFile = join(vaultRoot, "bad-plan.md");
    const badFence =
      "version: 1\n" +
      "tasks:\n" +
      "  - {id: a, title: T A, depends_on: [a], description: Build A., acceptance: [works]}\n" +
      "  - {id: a, title: T A2, depends_on: [], description: Build A2., acceptance: [works]}\n";
    writeFileSync(planFile, wrapFence(badFence), "utf8");
    const repoDir = join(vaultRoot, "repo");
    const errLines: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errLines.push(String(s));
      return true;
    });
    let code: number;
    try {
      code = await run(["submit", "--plan", planFile, "--repo", repoDir], {
        printFn: () => {},
        env: { HOME: vaultRoot },
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(code).toBe(1);
    const errorLines = errLines
      .join("")
      .split("\n")
      .filter((l) => l.includes("plan error:"));
    expect(errorLines.length).toBeGreaterThanOrEqual(2);

    const inboxDir = join(vaultRoot, "Junco", "inbox");
    expect(existsSync(inboxDir) ? readdirSync(inboxDir) : []).toEqual([]);
  });

  it("submit --plan without --repo or with planSets disabled fails with guidance", async () => {
    // missing --repo (planSets enabled)
    {
      const { vaultRoot } = freshDispatchVault({ planSets: { enabled: true, maxTasks: 10 } });
      const planFile = join(vaultRoot, "plan.md");
      writeFileSync(planFile, wrapFence(TWO_TASK_FENCE), "utf8");
      const errLines: string[] = [];
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
        errLines.push(String(s));
        return true;
      });
      let code: number;
      try {
        code = await run(["submit", "--plan", planFile], {
          printFn: () => {},
          env: { HOME: vaultRoot },
        });
      } finally {
        errSpy.mockRestore();
      }
      expect(code).toBe(2);
      expect(errLines.join("")).toContain("Usage: junco submit --plan");
    }

    // planSets disabled (--repo present)
    {
      const { vaultRoot } = freshDispatchVault({ planSets: { enabled: false } });
      const planFile = join(vaultRoot, "plan.md");
      writeFileSync(planFile, wrapFence(TWO_TASK_FENCE), "utf8");
      const repoDir = join(vaultRoot, "repo");
      const errLines: string[] = [];
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
        errLines.push(String(s));
        return true;
      });
      let code: number;
      try {
        code = await run(["submit", "--plan", planFile, "--repo", repoDir], {
          printFn: () => {},
          env: { HOME: vaultRoot },
        });
      } finally {
        errSpy.mockRestore();
      }
      expect(code).toBe(1);
      expect(errLines.join("")).toContain(
        "junco submit: plan sets are disabled — set planSets.enabled in config.json",
      );
    }
  });

  it("resubmitting the same plan with all children already queued prints the already-queued line and exits 0", async () => {
    const { vaultRoot } = freshDispatchVault({ planSets: { enabled: true, maxTasks: 10 } });
    const planFile = join(vaultRoot, "dup-plan.md");
    const oneTaskFence =
      "version: 1\n" +
      "tasks:\n" +
      "  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}\n";
    writeFileSync(planFile, wrapFence(oneTaskFence), "utf8");
    const repoDir = join(vaultRoot, "repo");

    const first = await run(["submit", "--plan", planFile, "--repo", repoDir], {
      printFn: () => {},
      env: { HOME: vaultRoot },
    });
    expect(first).toBe(0);

    const captured: string[] = [];
    const second = await run(["submit", "--plan", planFile, "--repo", repoDir], {
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(second).toBe(0);
    expect(captured.join("")).toContain(
      "plan set plan-dup-plan: all 1 tickets already in the queue",
    );
  });

  // I3 (#298 review round 2): before this branch, a per-child submit throw
  // was fatal — uncaught, exit 1, nothing else dispatched. This branch
  // CONTAINS the throw inside submitPlanSet (so siblings still land), but
  // silently returning 0 afterward would hide the failure from an operator
  // (and from any script checking the exit code) with no signal short of
  // re-reading the daemon log.
  it("submit --plan surfaces a stranded child on stderr and exits nonzero, but still lands its siblings", async () => {
    const { vaultRoot } = freshDispatchVault({ planSets: { enabled: true, maxTasks: 10 } });
    const planFile = join(vaultRoot, "stranded-plan.md");
    writeFileSync(planFile, wrapFence(TWO_TASK_FENCE), "utf8");
    const repoDir = join(vaultRoot, "repo");
    const captured: string[] = [];
    const errLines: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errLines.push(String(s));
      return true;
    });
    let code: number;
    try {
      code = await run(["submit", "--plan", planFile, "--repo", repoDir], {
        printFn: (s) => captured.push(s),
        env: { HOME: vaultRoot },
        submitPlanFn: (c, content, opts, submitDeps) => {
          if (opts?.idHint === "plan-stranded-plan-b") throw new Error("disk full");
          return submitTicket(c, content, opts, submitDeps);
        },
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(code).toBe(1);
    expect(errLines.join("")).toContain(
      "junco submit: plan set plan-stranded-plan: failed to submit plan-stranded-plan-b",
    );

    // Contained, not aborted: "a" still landed despite "b"'s submit throwing.
    const inboxDir = join(vaultRoot, "Junco", "inbox");
    expect(existsSync(join(inboxDir, "plan-stranded-plan-a.md"))).toBe(true);
    expect(existsSync(join(inboxDir, "plan-stranded-plan-b.md"))).toBe(false);
    expect(captured.join("")).toContain("submitted:");
  });

  // Fix wave C, item 2: the PRECEDING test strands "b" on the supersede run
  // itself (exit 1 — the operator sees it immediately). This test covers the
  // NEXT thing an operator naturally tries: re-running the SAME (unedited)
  // file again. Before this fix that re-run reported
  // "all 2 tickets already in the queue" and exited 0 — while "b" sat
  // unrecoverable in failed/ with a `superseded:` marker (supersedeUnclaimed
  // already disposed it; `junco retry --all` skips superseded-marked files
  // too) and the strict policy (no edit ⇒ no supersede) never resubmits a
  // `failed` child on its own.
  it("an unchanged re-run after a supersede-then-stranded child does NOT report success — it surfaces the stranded child and exits nonzero", async () => {
    const { vaultRoot } = freshDispatchVault({ planSets: { enabled: true, maxTasks: 10 } });
    const planFile = join(vaultRoot, "cross-plan.md");
    writeFileSync(planFile, wrapFence(TWO_TASK_FENCE), "utf8");
    const repoDir = join(vaultRoot, "repo");

    // Run 1: v1 fans out "a" and "b" cleanly.
    const first = await run(["submit", "--plan", planFile, "--repo", repoDir], {
      printFn: () => {},
      env: { HOME: vaultRoot },
    });
    expect(first).toBe(0);

    // Edit the plan (v2: different body → different hash, same task ids).
    const editedFence =
      "version: 1\n" +
      "tasks:\n" +
      "  - {id: a, title: T A, depends_on: [], description: Build A v2., acceptance: [works]}\n" +
      "  - {id: b, title: T B, depends_on: [a], description: Build B v2., acceptance: [works]}\n";
    writeFileSync(planFile, wrapFence(editedFence), "utf8");

    // Run 2: supersedes — disposes both unclaimed v1 children into failed/
    // with a `superseded:` marker, then fans out v2. "a" lands; "b"'s submit
    // throws (a transient error, contained per-child) and is left stranded.
    const errLines2: string[] = [];
    const errSpy2 = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errLines2.push(String(s));
      return true;
    });
    let second: number;
    try {
      second = await run(["submit", "--plan", planFile, "--repo", repoDir], {
        printFn: () => {},
        env: { HOME: vaultRoot },
        submitPlanFn: (c, content, opts, submitDeps) => {
          if (opts?.idHint === "plan-cross-plan-b") throw new Error("disk full");
          return submitTicket(c, content, opts, submitDeps);
        },
      });
    } finally {
      errSpy2.mockRestore();
    }
    expect(second).toBe(1);
    expect(errLines2.join("")).toContain("failed to submit plan-cross-plan-b");

    const inboxDir = join(vaultRoot, "Junco", "inbox");
    const failedDir = join(vaultRoot, "Junco", "failed");
    expect(existsSync(join(inboxDir, "plan-cross-plan-a.md"))).toBe(true);
    expect(existsSync(join(inboxDir, "plan-cross-plan-b.md"))).toBe(false);
    const strandedFailed = readdirSync(failedDir).filter((f) => f.includes("plan-cross-plan-b"));
    expect(strandedFailed.length).toBe(1);
    expect(readFileSync(join(failedDir, strandedFailed[0]), "utf8")).toMatch(/superseded:/);

    // Run 3: the SAME (unedited) file — hash is unchanged, so `supersede` is
    // false and the strict policy applies. "b" is skipped (it's `failed`, not
    // `absent`), so `submitted`/`stranded` are both empty. This must NOT read
    // as a clean no-op: "b" is genuinely stuck.
    const captured3: string[] = [];
    const errLines3: string[] = [];
    const errSpy3 = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errLines3.push(String(s));
      return true;
    });
    let third: number;
    try {
      third = await run(["submit", "--plan", planFile, "--repo", repoDir], {
        printFn: (s) => captured3.push(s),
        env: { HOME: vaultRoot },
      });
    } finally {
      errSpy3.mockRestore();
    }
    expect(third).toBe(1);
    expect(captured3.join("")).not.toContain("already in the queue");
    expect(errLines3.join("")).toContain("plan-cross-plan-b is stranded");
    expect(errLines3.join("")).toContain(planFile); // names the remedy: edit this file and re-run

    // "b" is still exactly where it was — no phantom resubmit, no silent drop.
    expect(existsSync(join(inboxDir, "plan-cross-plan-b.md"))).toBe(false);
    expect(readdirSync(failedDir).filter((f) => f.includes("plan-cross-plan-b")).length).toBe(1);
  });

  // #298: planId is derived from the FILENAME, so a re-run with an edited
  // plan always collides with the previous record. Without a supersede, the
  // record gets clobbered to the new hash while the v1 child stays queued
  // under the identical ticket id — and submitPlanSet's absent-only guard
  // then silently skips it, so the record's rev advertises a revision the
  // queue does not actually contain.
  it("re-submitting an edited plan supersedes the unclaimed old children", async () => {
    const { vaultRoot } = freshDispatchVault({ planSets: { enabled: true, maxTasks: 10 } });
    const planFile = join(vaultRoot, "p.md");
    const repoDir = join(vaultRoot, "repo");
    const fenceV1 =
      "version: 1\n" +
      "tasks:\n" +
      "  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}\n";
    writeFileSync(planFile, wrapFence(fenceV1), "utf8");

    const first = await run(["submit", "--plan", planFile, "--repo", repoDir], {
      printFn: () => {},
      env: { HOME: vaultRoot },
    });
    expect(first).toBe(0);

    const inboxDir = join(vaultRoot, "Junco", "inbox");
    const failedDir = join(vaultRoot, "Junco", "failed");
    expect(existsSync(join(inboxDir, "plan-p-a.md"))).toBe(true);

    // Edit the plan: same task id "a" (same ticketId), different body (a
    // different hash) — the v1 child never ran, so it must be disposed.
    const fenceV2 =
      "version: 1\n" +
      "tasks:\n" +
      "  - {id: a, title: T A, depends_on: [], description: Build A better., acceptance: [works]}\n";
    writeFileSync(planFile, wrapFence(fenceV2), "utf8");

    const captured: string[] = [];
    const second = await run(["submit", "--plan", planFile, "--repo", repoDir], {
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(second).toBe(0);
    expect(captured.join("")).toContain("superseded 1 unclaimed ticket(s)");

    // The v1 child that never ran is now in failed/ with a superseded marker.
    const failedFiles = existsSync(failedDir) ? readdirSync(failedDir) : [];
    expect(failedFiles.length).toBe(1);
    expect(readFileSync(join(failedDir, failedFiles[0]), "utf8")).toMatch(/superseded:/);

    // The v2 child is queued under the same ticket id.
    expect(existsSync(join(inboxDir, "plan-p-a.md"))).toBe(true);
  });

  // #298 review round 1 — Important #1: a sibling that genuinely FAILED (as
  // opposed to one this call's own supersedeUnclaimed disposed) must ALSO
  // resubmit on a hash-changing re-run. Reachable without any crash: v1 fans
  // out a+b; "a" runs and fails for real; "b" never claims. Before this fix,
  // only the ids `supersedeUnclaimed` happened to dispose were force-
  // resubmitted — a genuinely-failed sibling (never in that array, since
  // supersedeUnclaimed only touches inbox/) stayed skipped, so the record
  // advertised a revision the queue never actually received.
  it("a genuinely failed sibling (not merely disposed) is resubmitted on a hash-changing re-run", async () => {
    const { vaultRoot } = freshDispatchVault({ planSets: { enabled: true, maxTasks: 10 } });
    const planFile = join(vaultRoot, "q.md");
    const repoDir = join(vaultRoot, "repo");
    const fenceV1 =
      "version: 1\n" +
      "tasks:\n" +
      "  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}\n" +
      "  - {id: b, title: T B, depends_on: [], description: Build B., acceptance: [works]}\n";
    writeFileSync(planFile, wrapFence(fenceV1), "utf8");

    const first = await run(["submit", "--plan", planFile, "--repo", repoDir], {
      printFn: () => {},
      env: { HOME: vaultRoot },
    });
    expect(first).toBe(0);

    const inboxDir = join(vaultRoot, "Junco", "inbox");
    const failedDir = join(vaultRoot, "Junco", "failed");
    const aPath = join(inboxDir, "plan-q-a.md");
    const bPath = join(inboxDir, "plan-q-b.md");
    expect(existsSync(aPath)).toBe(true);
    expect(existsSync(bPath)).toBe(true);

    // "a" runs and genuinely fails (an ordinary execution failure, no
    // `superseded:` marker) — "b" never claims and stays untouched in inbox.
    mkdirSync(failedDir, { recursive: true });
    const aContent = readFileSync(aPath, "utf8");
    writeFileSync(
      join(failedDir, "plan-q-a.md"),
      `${aContent.trimEnd()}\n\n---\n<!-- junco-result\nstatus: failed\n-->\n\n## Result\n\n> boom\n`,
      "utf8",
    );
    rmSync(aPath);

    // Edit the plan (v2: different body → different hash, same task ids).
    const fenceV2 =
      "version: 1\n" +
      "tasks:\n" +
      "  - {id: a, title: T A, depends_on: [], description: Build A better., acceptance: [works]}\n" +
      "  - {id: b, title: T B, depends_on: [], description: Build B better., acceptance: [works]}\n";
    writeFileSync(planFile, wrapFence(fenceV2), "utf8");

    const captured: string[] = [];
    const second = await run(["submit", "--plan", planFile, "--repo", repoDir], {
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(second).toBe(0);

    // Both the genuinely-failed "a" AND the disposed-unclaimed "b" resubmit
    // under the new revision — this is the bug reproduced via `failed` state
    // instead of `inbox` state.
    expect(existsSync(aPath)).toBe(true);
    expect(existsSync(bPath)).toBe(true);
    expect(readFileSync(aPath, "utf8")).toContain("Build A better.");
    expect(readFileSync(bPath, "utf8")).toContain("Build B better.");
    expect((captured.join("").match(/^submitted:/gm) ?? []).length).toBe(2);

    // The old genuine-failure record is left as audit, untouched.
    expect(existsSync(join(failedDir, "plan-q-a.md"))).toBe(true);
    expect(readFileSync(join(failedDir, "plan-q-a.md"), "utf8")).not.toContain("superseded:");
  });

  // #298: the printed path was reconstructed as `<inbox>/<id>.md` rather than
  // the real destination `submitTicket` returned — a uniqueDest rename would
  // print a path that doesn't exist.
  it("prints the real destination path returned by submitTicket", async () => {
    const { vaultRoot } = freshDispatchVault({ planSets: { enabled: true, maxTasks: 10 } });
    const planFile = join(vaultRoot, "my-plan.md");
    writeFileSync(planFile, wrapFence(TWO_TASK_FENCE), "utf8");
    const repoDir = join(vaultRoot, "repo");
    const captured: string[] = [];
    const code = await run(["submit", "--plan", planFile, "--repo", repoDir], {
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(code).toBe(0);

    const inboxDir = join(vaultRoot, "Junco", "inbox");
    const expectedA = join(inboxDir, "plan-my-plan-a.md");
    const expectedB = join(inboxDir, "plan-my-plan-b.md");
    const out = captured.join("");
    expect(out).toContain(`submitted: ${expectedA}\n`);
    expect(out).toContain(`submitted: ${expectedB}\n`);
    expect(existsSync(expectedA)).toBe(true);
    expect(existsSync(expectedB)).toBe(true);
  });
});

// --- init (removed — dashboard FTUE is the interactive path, `config init`
// the headless scaffold; see tests/dashboardCmd.test.ts + tests/configCmd.test.ts) ---

describe("run(['init'])", () => {
  it("init is gone: unknown subcommand, exit 2", async () => {
    const { vaultRoot } = freshDispatchVault(); // config present — routing must not matter
    const code = await run(["init"], { printFn: () => {}, env: { HOME: vaultRoot } });
    expect(code).toBe(2);
  });
});

// An unknown flag must not crash: strict parseArgs throws
// ERR_PARSE_ARGS_UNKNOWN_OPTION, which would otherwise escape to the top-level
// fatal catch (exit 1 + structured error log). run() catches it and returns a
// graceful usage error (exit 2 + the parse message + USAGE on stderr) for
// EVERY unknown flag — e.g. the removed `junco init --yes` scripted form.
describe("run — unknown flags", () => {
  function captureStderr(): { text: () => string; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
    return { text: () => lines.join(""), restore: () => spy.mockRestore() };
  }

  it("`init --yes` exits 2, naming the unknown option and showing usage", async () => {
    const cap = captureStderr();
    let code: number;
    try {
      code = await run(["init", "--yes"], { printFn: () => {} });
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.text()).toContain("--yes");
    expect(cap.text()).toContain("Usage: junco");
  });

  it("a bare unknown top-level flag exits 2 (never silently routes to start/dashboard)", async () => {
    const cap = captureStderr();
    let code: number;
    try {
      code = await run(["--definitely-not-a-flag"], { printFn: () => {} });
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.text()).toContain("--definitely-not-a-flag");
  });
});

describe("run(['dashboard']) — routing", () => {
  it("routes `dashboard` to runDashboardFn with the loaded config when one exists", async () => {
    const { cfg } = freshDispatchVault(); // the file's existing full-Config helper
    let got: Config | null = null;
    const code = await run(["dashboard"], {
      env: { HOME: "/x" },
      existsFn: () => true, // config present → config-loaded path
      loadConfigFn: () => cfg,
      runDashboardFn: async (c) => {
        got = c;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(got).not.toBeNull();
  });

  it("routes `dashboard` with NO config to the FTUE path (null cfg, config never loaded)", async () => {
    let got: Config | null | undefined = undefined;
    const code = await run(["dashboard"], {
      env: { HOME: "/x" },
      existsFn: () => false, // no config → dashboard hosts the wizard
      // FTUE gate (#273): "nothing is running" — never touch the real lock
      // file or the real health port from a unit test.
      readLockHolderFn: () => null,
      fetchHealthFn: async () => null,
      loadConfigFn: () => {
        throw new Error("config must not be loaded on the FTUE path");
      },
      runDashboardFn: async (c) => {
        got = c;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(got).toBeNull();
  });
});

describe("run(['outbox'])", () => {
  it("returns 0 and prints 'outbox empty' when nothing is queued", async () => {
    const { cfg, vaultRoot } = freshDispatchVault();
    const cfgWithDataDir: Config = { ...cfg, dataDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["outbox"], {
      loadConfigFn: () => cfgWithDataDir,
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(code).toBe(0);
    expect(captured.join("")).toBe("outbox empty\n");
  });

  it("routes `outbox flush` to the flush path (exit 0 on a clean flush of nothing)", async () => {
    const { cfg, vaultRoot } = freshDispatchVault();
    const cfgWithDataDir: Config = { ...cfg, dataDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["outbox", "flush"], {
      loadConfigFn: () => cfgWithDataDir,
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(code).toBe(0);
    expect(captured.join("")).toMatch(/sent 0 · dead 0 · remaining 0/);
  });

  it("outbox flush attaches bot auth and hands the attached config to the flush path", async () => {
    // Flush replays daemon-enqueued ops (comments, label flips, pushes, PR
    // creates) — it must speak as the bot, not the operator running the flush.
    let seen: Config | undefined;
    const withBotAuthFn = vi.fn(async (c: Config) => ({ ...c, ghAuth: GH_AUTH_CTX }));
    const runOutboxCommandFn = vi.fn(async (c: Config) => {
      seen = c;
      return 0;
    });
    const code = await run(["outbox", "flush"], makeDeps({ withBotAuthFn, runOutboxCommandFn }));
    expect(code).toBe(0);
    expect(withBotAuthFn).toHaveBeenCalledTimes(1);
    expect(seen?.ghAuth?.login).toBe(GH_AUTH_CTX.login);
  });

  it("outbox flush refuses (exit 1) when bot auth resolution throws — never replays as human", async () => {
    const runOutboxCommandFn = vi.fn(async () => 0);
    const deps = makeDeps({
      withBotAuthFn: async () => {
        throw new Error("botAccount.enabled is true but no working gh login exists");
      },
      runOutboxCommandFn,
    });
    const code = await run(["outbox", "flush"], deps);
    expect(code).toBe(1);
    expect(runOutboxCommandFn).not.toHaveBeenCalled();
  });

  it("bare outbox listing is local-only — does NOT attach bot auth", async () => {
    const runOutboxCommandFn = vi.fn(async () => 0);
    const deps = makeDeps({ runOutboxCommandFn });
    const code = await run(["outbox"], deps);
    expect(code).toBe(0);
    expect(deps.withBotAuthFn).not.toHaveBeenCalled();
    expect(runOutboxCommandFn).toHaveBeenCalledTimes(1);
  });
});

describe("run(['unwatch'])", () => {
  it("routes 'unwatch <nwo> --plan' to the injected command with values.plan === true", async () => {
    let seenArgs: string[] | undefined;
    let seenValues: { plan: boolean } | undefined;
    const runUnwatchCommandFn = vi.fn(
      async (_c: Config, args: string[], values: { plan: boolean }) => {
        seenArgs = args;
        seenValues = values;
        return 0;
      },
    );
    // Strict parseArgs must accept --plan (would throw ERR_PARSE_ARGS_UNKNOWN_OPTION,
    // surfacing as exit 2, if the option weren't registered).
    const code = await run(["unwatch", "acme/api", "--plan"], makeDeps({ runUnwatchCommandFn }));
    expect(code).toBe(0);
    expect(runUnwatchCommandFn).toHaveBeenCalledTimes(1);
    expect(seenArgs).toEqual(["acme/api"]);
    expect(seenValues).toEqual({ plan: true });
  });

  it("bare 'unwatch <nwo>' (no --plan) passes plan: false", async () => {
    const runUnwatchCommandFn = vi.fn(async () => 0);
    const code = await run(["unwatch", "acme/api"], makeDeps({ runUnwatchCommandFn }));
    expect(code).toBe(0);
    expect(runUnwatchCommandFn).toHaveBeenCalledWith(
      expect.anything(),
      ["acme/api"],
      { plan: false },
      expect.anything(),
    );
  });

  it("propagates the injected command's exit code", async () => {
    const runUnwatchCommandFn = vi.fn(async () => 1);
    const code = await run(["unwatch", "acme/api"], makeDeps({ runUnwatchCommandFn }));
    expect(code).toBe(1);
  });
});

describe("run(['prs'])", () => {
  it("returns 0 and prints the no-watched-repos guidance when none are configured", async () => {
    const { cfg, vaultRoot } = freshDispatchVault();
    const cfgWithDataDir: Config = { ...cfg, dataDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["prs"], {
      loadConfigFn: () => cfgWithDataDir,
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(code).toBe(0);
    expect(captured.join("")).toBe(
      "no watched repositories — add github.repos to config.json or watch one from the dashboard\n",
    );
  });
});

describe("run(['assess']) — routing", () => {
  it("routes `assess <path> --auto-plan` to runAssessCommand, threading the flag into the queued ticket", async () => {
    const { cfg, vaultRoot } = freshDispatchVault();
    const repoDir = mkdtempSync(join(tmpdir(), "junco-cli-assess-repo-"));
    const cfgWithDataDir: Config = { ...cfg, dataDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["assess", repoDir, "--auto-plan"], {
      loadConfigFn: () => cfgWithDataDir,
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(code).toBe(0);

    const inboxDir = join(vaultRoot, "Junco", "inbox");
    const files = readdirSync(inboxDir).filter((f) => f.startsWith("assess-"));
    expect(files).toHaveLength(1);
    const content = readFileSync(join(inboxDir, files[0]), "utf8");
    expect(content).toContain("auto_plan: true");
    expect(content).toContain(`repo: ${JSON.stringify(repoDir)}`);
    expect(captured.join("")).toMatch(/auto-plan/i);
  });

  it("no target -> exit 2, usage line", async () => {
    const { cfg, vaultRoot } = freshDispatchVault();
    const cfgWithDataDir: Config = { ...cfg, dataDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["assess"], {
      loadConfigFn: () => cfgWithDataDir,
      printFn: (s) => captured.push(s),
      env: { HOME: vaultRoot },
    });
    expect(code).toBe(2);
    expect(captured.join("")).toMatch(/usage/i);
  });
});

// `skill install` follows the dispatch/outbox precedent: a CliDeps seam
// (`runSkillInstallCommandFn`) so tests never fall through to the real lazy
// import — the real skillCmd.js resolves `--harness <registry name>` dirs
// against the REAL os.homedir() (not this run()'s injected env.HOME), so an
// unmocked exercise risks touching the actual machine's ~/.claude/skills.
describe("run(['skill']) — routing", () => {
  it("routes `skill install --harness claude` to runSkillInstallCommandFn with { harness: ['claude'] }", async () => {
    const runSkillInstallCommandFn = vi.fn(
      async (_configPath: string, _opts: { harness: string[] }) => 0,
    );
    const code = await run(["skill", "install", "--harness", "claude"], {
      env: { HOME: "/x" },
      runSkillInstallCommandFn,
    });
    expect(code).toBe(0);
    expect(runSkillInstallCommandFn).toHaveBeenCalledTimes(1);
    const [configPathArg, opts] = runSkillInstallCommandFn.mock.calls[0];
    expect(typeof configPathArg).toBe("string");
    expect(opts).toEqual({ harness: ["claude"] });
  });

  it("bare `skill` exits 2 with the usage line, never reaching runSkillInstallCommandFn", async () => {
    const runSkillInstallCommandFn = vi.fn(async () => 0);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
    let code: number;
    try {
      code = await run(["skill"], { env: { HOME: "/x" }, runSkillInstallCommandFn });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(2);
    expect(lines.join("")).toContain("Usage: junco skill install");
    expect(runSkillInstallCommandFn).not.toHaveBeenCalled();
  });
});

describe("run(['restart']) — routing", () => {
  it("routes `restart` to runRestartFn with the RESOLVED config path (config validated first)", async () => {
    const { cfg } = freshDispatchVault();
    let gotPath: string | null = null;
    let loaded = false;
    const code = await run(["restart"], {
      env: { HOME: "/x" },
      loadConfigFn: () => {
        loaded = true;
        return cfg;
      },
      runRestartFn: async (p) => {
        gotPath = p;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(loaded).toBe(true); // broken config fails fast before any kick
    expect(gotPath).toBe(join("/x", ".junco", "config.json"));
  });

  it("a broken config aborts before the restart fn runs", async () => {
    let ran = false;
    const code = await run(["restart"], {
      env: { HOME: "/x" },
      loadConfigFn: () => {
        throw new Error("bad config");
      },
      runRestartFn: async () => {
        ran = true;
        return 0;
      },
    });
    expect(code).not.toBe(0);
    expect(ran).toBe(false);
  });
});

describe("run(['data', <verb>]) — verb validation", () => {
  it("an unknown data verb exits 2 with usage, never loading config or running a view", async () => {
    let loaded = false;
    const captured: string[] = [];
    const code = await run(["data", "bogus"], {
      loadConfigFn: () => {
        loaded = true;
        return stubConfig();
      },
      printFn: (s) => captured.push(s),
    });
    expect(code).toBe(2);
    expect(captured.join("")).toContain("Usage: junco data");
    // Neither the view nor migrate ran: the stub `{}` config would have made
    // either one throw, and config must not even be loaded for a bad verb.
    expect(loaded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatch subcommand — SDD Task 12
// ---------------------------------------------------------------------------

describe("run(['dispatch', ref])", () => {
  it("happy path prints the ticket + fork info", async () => {
    const captured: string[] = [];
    const code = await run(["dispatch", "up/stream#7"], {
      loadConfigFn: () => ({}) as Config,
      printFn: (s) => captured.push(s),
      dispatchIssueFn: async () => ({
        id: "gh-up-stream-7",
        destPath: "/inbox/gh-up-stream-7.md",
        external: true,
        clonePath: "/ext/up/stream",
        forkNwo: "me/stream",
      }),
    });
    expect(code).toBe(0);
    const out = captured.join("");
    expect(out).toContain("dispatched: /inbox/gh-up-stream-7.md");
    expect(out).toContain("fork: me/stream");
  });

  it("missing ref is usage error 2; a throwing core is exit 1", async () => {
    expect(await run(["dispatch"], {})).toBe(2);
    expect(
      await run(["dispatch", "x#1"], {
        loadConfigFn: () => ({}) as Config,
        dispatchIssueFn: async () => {
          throw new Error("boom");
        },
      }),
    ).toBe(1);
  });

  it("does NOT call loadConfigFn when the ref is missing (usage error short-circuits)", async () => {
    const loadConfigFn = vi.fn(() => ({}) as Config);
    await run(["dispatch"], { loadConfigFn });
    expect(loadConfigFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// auth subcommand — gh-bot-account Task 9. The cli.ts block lazy-imports
// authCmd with NO injectable dep (deps: {}), so these exercise the real
// routing into runAuthCommand; process.stderr is spied (the :409 precedent)
// because runAuthCommand's printErr defaults to process.stderr.write.
// ---------------------------------------------------------------------------

describe("run(['auth']) — routing", () => {
  async function runCapturingStderr(
    argv: string[],
    deps: CliDeps = {},
  ): Promise<{ code: number; err: string }> {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      lines.push(String(s));
      return true;
    });
    try {
      const code = await run(argv, deps);
      return { code, err: lines.join("") };
    } finally {
      spy.mockRestore();
    }
  }

  it("`auth login` with no config on disk routes into runAuthCommand: exit 1 + dashboard hint", async () => {
    const { code, err } = await runCapturingStderr(["auth", "login"], {
      env: { HOME: "/nonexistent/junco-cli-auth" },
    });
    expect(code).toBe(1);
    expect(err).toContain("junco dashboard");
  });

  it("verb-free `auth` is a usage error: exit 2 + the auth usage line", async () => {
    const { code, err } = await runCapturingStderr(["auth"], {
      env: { HOME: "/nonexistent/junco-cli-auth" },
    });
    expect(code).toBe(2);
    expect(err).toMatch(/usage: junco auth login/i);
  });
});

describe("--config deprecation", () => {
  it("--config is parsed, ignored, and warns on stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-cli-"));
    const configPath = join(dir, ".junco", "config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ vaultRoot: dir, juncoSubdir: "tickets" }));
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let out = "";
    const code = await run(["inbox-path", "--config", "/somewhere/else/config.json"], {
      printFn: (s) => (out += s),
      env: { HOME: dir },
    });
    expect(code).toBe(0);
    expect(out.trim()).toBe(join(dir, "tickets", "inbox")); // canonical config won, not the flag
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("--config is deprecated");
    errSpy.mockRestore();
  });
});
