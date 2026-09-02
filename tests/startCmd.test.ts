/**
 * Tests for src/startCmd.ts — `runStartCommand(configPath, opts, deps)` called
 * DIRECTLY, without cli.ts's argv parsing in the way.
 *
 * cli.test.ts already pins the same behaviours through `run(['start'])`; these
 * pin them at the module's own boundary, which is what the extraction bought.
 * Every seam (worker lock, the two shared-root claims, signal handlers,
 * mainLoop, the config watcher, bot auth) is injected — nothing here touches a
 * real pidfile, a real fs.watch, or the maintainer's live ~/.junco.
 */

import { describe, it, expect, vi, type MockedFunction } from "vitest";
import type { Config } from "../src/types.js";
import type { SingletonLock } from "../src/lock.js";
import { runStartCommand, type StartCmdDeps } from "../src/startCmd.js";

/** Minimal stub Config — the injected mainLoop ignores it. `dataDir`/`queueRoot`
 *  are synthetic `/sbxroot/...` paths (daemonLockPaths resolve()s both), and
 *  `legacy` is populated so the startup configDeprecations() scan has something
 *  to read. */
function stubConfig(): Config {
  return {
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

function makeFakeLock(): SingletonLock & { release: ReturnType<typeof vi.fn<() => void>> } {
  return { path: "/sbxroot/worker.lock", release: vi.fn<() => void>() };
}

/** Happy-path deps: every side effect faked, nothing real acquired. */
function makeDeps(overrides: Partial<StartCmdDeps> = {}): StartCmdDeps {
  return {
    loadConfigFn: vi.fn(() => stubConfig()),
    acquireLockFn: vi.fn(() => makeFakeLock()),
    acquireTreeLockFn: vi.fn(() => makeFakeLock()),
    acquireQueueLockFn: vi.fn(() => makeFakeLock()),
    installSignalHandlersFn: vi.fn(() => vi.fn()),
    mainLoopFn: vi.fn(async () => {}),
    watchConfigFn: vi.fn(() => ({ close: vi.fn() })),
    withBotAuthFn: vi.fn(async (c: Config) => c),
    readLockHolderFn: vi.fn(() => null),
    ...overrides,
  };
}

const CONFIG_PATH = "/sbxroot/.junco/config.json";

describe("runStartCommand — happy path", () => {
  it("returns 0 and runs mainLoop exactly once with once=false", async () => {
    const deps = makeDeps();
    expect(await runStartCommand(CONFIG_PATH, {}, deps)).toBe(0);
    expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
    const [, , opts] = (deps.mainLoopFn as MockedFunction<any>).mock.calls[0];
    expect(opts).toMatchObject({ once: false });
  });

  it("threads once=true through to mainLoop", async () => {
    const deps = makeDeps();
    await runStartCommand(CONFIG_PATH, { once: true }, deps);
    const [, , opts] = (deps.mainLoopFn as MockedFunction<any>).mock.calls[0];
    expect(opts).toMatchObject({ once: true });
  });

  it("hands back all three claims and uninstalls the signal handlers", async () => {
    const worker = makeFakeLock();
    const tree = makeFakeLock();
    const queue = makeFakeLock();
    const uninstall = vi.fn();
    await runStartCommand(
      CONFIG_PATH,
      {},
      makeDeps({
        acquireLockFn: vi.fn(() => worker),
        acquireTreeLockFn: vi.fn(() => tree),
        acquireQueueLockFn: vi.fn(() => queue),
        installSignalHandlersFn: vi.fn(() => uninstall),
      }),
    );
    expect(worker.release).toHaveBeenCalledTimes(1);
    expect(tree.release).toHaveBeenCalledTimes(1);
    expect(queue.release).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it("shares ONE provider gate between the watcher's onApplied and mainLoop's deps", async () => {
    const watchConfigFn = vi.fn(() => ({ close: vi.fn() }));
    const deps = makeDeps({ watchConfigFn });
    await runStartCommand(CONFIG_PATH, {}, deps);
    const [, , watchDeps] = (watchConfigFn as MockedFunction<any>).mock.calls[0];
    const [, , , mainLoopDeps] = (deps.mainLoopFn as MockedFunction<any>).mock.calls[0];
    const clearSpy = vi.spyOn(mainLoopDeps.gate, "clearLatched");
    watchDeps.onApplied();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

describe("runStartCommand — refusals", () => {
  it("exits 0 without starting anything when the worker lock is held", async () => {
    const acquireTreeLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({ acquireLockFn: vi.fn(() => null), acquireTreeLockFn });
    expect(await runStartCommand(CONFIG_PATH, {}, deps)).toBe(0);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
    expect(deps.installSignalHandlersFn).not.toHaveBeenCalled();
    expect(acquireTreeLockFn).not.toHaveBeenCalled();
  });

  it("refuses a held data-root claim (exit 0), names the holder pid, and hands back the worker lock", async () => {
    const worker = makeFakeLock();
    const errLines: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errLines.push(String(s));
      return true;
    });
    let code: number;
    try {
      code = await runStartCommand(
        CONFIG_PATH,
        {},
        makeDeps({
          acquireLockFn: vi.fn(() => worker),
          acquireTreeLockFn: vi.fn(() => null),
          readLockHolderFn: vi.fn(() => 4242),
        }),
      );
    } finally {
      errSpy.mockRestore();
    }
    expect(code).toBe(0);
    expect(errLines.join("")).toContain("already claims this data root");
    expect(errLines.join("")).toContain("pid 4242");
    expect(worker.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a held queue-root claim (exit 0) and hands back both claims it took", async () => {
    const worker = makeFakeLock();
    const tree = makeFakeLock();
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let code: number;
    try {
      code = await runStartCommand(
        CONFIG_PATH,
        {},
        makeDeps({
          acquireLockFn: vi.fn(() => worker),
          acquireTreeLockFn: vi.fn(() => tree),
          acquireQueueLockFn: vi.fn(() => null),
        }),
      );
    } finally {
      errSpy.mockRestore();
    }
    expect(code).toBe(0);
    expect(worker.release).toHaveBeenCalledTimes(1);
    expect(tree.release).toHaveBeenCalledTimes(1);
  });

  it("refuses (exit 1) when bot auth resolution throws, before any lock is taken", async () => {
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let code: number;
    try {
      code = await runStartCommand(
        CONFIG_PATH,
        {},
        makeDeps({
          acquireLockFn,
          withBotAuthFn: vi.fn(async () => {
            throw new Error("bot not authed");
          }),
        }),
      );
    } finally {
      errSpy.mockRestore();
    }
    expect(code).toBe(1);
    expect(acquireLockFn).not.toHaveBeenCalled();
  });

  it("returns 1 when mainLoop throws, still releasing every claim", async () => {
    const worker = makeFakeLock();
    const uninstall = vi.fn();
    const code = await runStartCommand(
      CONFIG_PATH,
      {},
      makeDeps({
        acquireLockFn: vi.fn(() => worker),
        installSignalHandlersFn: vi.fn(() => uninstall),
        mainLoopFn: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    );
    expect(code).toBe(1);
    expect(worker.release).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it("survives a watcher that fails to start — hot-reload off, daemon still runs", async () => {
    const deps = makeDeps({
      watchConfigFn: vi.fn(() => {
        throw new Error("EMFILE");
      }),
    });
    expect(await runStartCommand(CONFIG_PATH, {}, deps)).toBe(0);
    expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
  });
});
