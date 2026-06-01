/**
 * Tests for src/daemon.ts — StopFlag, sleepInterruptible, installSignalHandlers,
 * mainLoop.  Written FIRST (TDD).  No real fs / network / timers — every
 * side-effecting collaborator is injected.
 *
 * Port of worker.py StopFlag / _sleep_interruptible / main_loop /
 * _install_signal_handlers.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Config } from "../src/types.js";
import type { StopFlagLike } from "../src/health.js";
import {
  StopFlag,
  sleepInterruptible,
  installSignalHandlers,
  mainLoop,
  type MainLoopDeps,
} from "../src/daemon.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: "/tmp/vault",
    juncoSubdir: "Junco",
    omlx: { url: "http://127.0.0.1:1234/v1", apiKey: "test-key" },
    modelId: "omlx/test-model",
    tools: [],
    defaultTimeoutMinutes: 30,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
    supervisorEnabled: false,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    ghBin: "gh",
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: "/tmp/worktrees",
    removeWorktreeOnSuccess: true,
    draftByDefault: true,
    defaultLabels: [],
    verifyEnabled: true,
    verifyCommandTimeout: 60,
    verifyBlockOnFail: false,
    criticEnabled: true,
    criticMaxRetries: 1,
    criticThinking: "minimal",
    planLintEnabled: true,
    planLintBlockOnError: true,
    planLintCheckLabels: true,
    commitLeftoversEnabled: false,
    ...overrides,
  };
}

/**
 * A "stub" set of MainLoopDeps where every collaborator is a no-op spy.  The
 * default sleep resolves immediately so the poll loop never blocks on real
 * timers.  Callers override `runOnceFn` / `sleep` to drive the loop and reach
 * the stop condition.
 */
function makeDeps(overrides: Partial<MainLoopDeps> = {}): {
  deps: Required<MainLoopDeps>;
} {
  const deps: Required<MainLoopDeps> = {
    runOnceFn: vi.fn(async () => false),
    recoverOrphansFn: vi.fn(() => {}),
    pruneFn: vi.fn(() => {}),
    waitForOmlxFn: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    mkdirs: vi.fn(() => {}),
    ...overrides,
  };
  return { deps };
}

// ---------------------------------------------------------------------------
// StopFlag
// ---------------------------------------------------------------------------

describe("StopFlag", () => {
  it("starts not-requested", () => {
    const stop = new StopFlag();
    expect(stop.requested).toBe(false);
  });

  it("requestStop() flips requested to true", () => {
    const stop = new StopFlag();
    stop.requestStop();
    expect(stop.requested).toBe(true);
  });

  it("calling requestStop() twice stays true and logs only once", async () => {
    const { log } = await import("../src/logging.js");
    const spy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const stop = new StopFlag();
      stop.requestStop();
      stop.requestStop();
      expect(stop.requested).toBe(true);
      const stopLogs = spy.mock.calls.filter((c) =>
        String(c[0]).includes("stop requested"),
      );
      expect(stopLogs).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// sleepInterruptible
// ---------------------------------------------------------------------------

describe("sleepInterruptible", () => {
  it("returns ~immediately when stop already requested", async () => {
    const stop = new StopFlag();
    stop.requestStop();
    let calls = 0;
    const setTimeoutFn = ((cb: () => void) => {
      calls++;
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const start = Date.now();
    await sleepInterruptible(5, stop, { setTimeoutFn });
    expect(Date.now() - start).toBeLessThan(100);
    // Already stopped → loop never schedules a timer.
    expect(calls).toBe(0);
  });

  it("resolves after the requested duration when not stopped", async () => {
    const stop = new StopFlag();
    // Real tiny duration; keep well under the test timeout.
    const start = Date.now();
    await sleepInterruptible(0.01, stop);
    expect(Date.now() - start).toBeLessThan(100);
    expect(stop.requested).toBe(false);
  });

  it("polls in <=1s increments (never sleeps longer than 1s at a step)", async () => {
    const stop = new StopFlag();
    const waits: number[] = [];
    // Fake timer: record the requested delay.  Resolve synchronously, but flip
    // the stop flag after a few increments so the loop terminates without busy-
    // spinning against the real monotonic clock (the deadline is wall-clock).
    const setTimeoutFn = ((cb: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      if (waits.length >= 3) stop.requestStop();
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    await sleepInterruptible(60, stop, { setTimeoutFn });
    expect(waits.length).toBeGreaterThan(0);
    for (const w of waits) {
      expect(w).toBeLessThanOrEqual(1000);
    }
  });

  it("honors a mid-sleep stop (resolves well before the full duration)", async () => {
    const stop = new StopFlag();
    let ticks = 0;
    // Flip the stop flag after the 2nd scheduled increment.
    const setTimeoutFn = ((cb: () => void) => {
      ticks++;
      if (ticks === 2) stop.requestStop();
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    await sleepInterruptible(5, stop, { setTimeoutFn });
    // 5s would be >=5 increments at <=1s each; we stopped at the 2nd.
    expect(ticks).toBeLessThan(5);
    expect(stop.requested).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// installSignalHandlers
// ---------------------------------------------------------------------------

describe("installSignalHandlers", () => {
  it("SIGINT sets stop.requested and uninstall removes the listener", () => {
    const before = process.listenerCount("SIGINT");
    const stop = new StopFlag();
    const uninstall = installSignalHandlers(stop);
    try {
      process.emit("SIGINT");
      expect(stop.requested).toBe(true);
    } finally {
      uninstall();
    }
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("SIGTERM sets stop.requested and uninstall removes the listener", () => {
    const before = process.listenerCount("SIGTERM");
    const stop = new StopFlag();
    const uninstall = installSignalHandlers(stop);
    try {
      process.emit("SIGTERM");
      expect(stop.requested).toBe(true);
    } finally {
      uninstall();
    }
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("uninstall removes both SIGINT and SIGTERM listeners back to baseline", () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const stop = new StopFlag();
    const uninstall = installSignalHandlers(stop);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    uninstall();
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });
});

// ---------------------------------------------------------------------------
// mainLoop
// ---------------------------------------------------------------------------

describe("mainLoop", () => {
  it("runs startup steps exactly once, in order, before the first runOnce", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    const order: string[] = [];

    const { deps } = makeDeps({
      mkdirs: vi.fn(() => {
        order.push("mkdirs");
      }),
      recoverOrphansFn: vi.fn(() => {
        order.push("recover");
      }),
      pruneFn: vi.fn(() => {
        order.push("prune");
      }),
      waitForOmlxFn: vi.fn(async () => {
        order.push("wait");
      }),
      runOnceFn: vi.fn(async () => {
        order.push("runOnce");
        return false;
      }),
      // First idle sleep requests stop → loop exits after one runOnce.
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(order.slice(0, 5)).toEqual([
      "mkdirs",
      "recover",
      "prune",
      "wait",
      "runOnce",
    ]);
    expect(deps.mkdirs).toHaveBeenCalledTimes(1);
    expect(deps.recoverOrphansFn).toHaveBeenCalledTimes(1);
    expect(deps.pruneFn).toHaveBeenCalledTimes(1);
    expect(deps.pruneFn).toHaveBeenCalledWith(cfg.worktreeRoot);
    expect(deps.waitForOmlxFn).toHaveBeenCalledTimes(1);
    expect(deps.waitForOmlxFn).toHaveBeenCalledWith(cfg, stop);
  });

  it("once=true breaks after a single handled task; sleep never called", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    const { deps } = makeDeps({
      runOnceFn: vi.fn(async () => true),
    });

    await mainLoop(cfg, stop, { once: true }, deps);

    expect(deps.runOnceFn).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    // A handled task in once mode does not request stop itself; the break does.
  });

  it("daemon mode loops until stop is requested", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    let n = 0;
    const { deps } = makeDeps({
      runOnceFn: vi.fn(async () => {
        n++;
        if (n >= 4) {
          stop.requestStop();
          return false;
        }
        return true;
      }),
      // sleep resolves immediately (and is only reached when runOnce is false).
      sleep: vi.fn(async () => {}),
    });

    await mainLoop(cfg, stop, {}, deps);

    // 3 handled (continue) + 1 unhandled that requests stop = 4 calls.
    expect(deps.runOnceFn).toHaveBeenCalledTimes(4);
  });

  it("logs idle exactly once across consecutive empty polls", async () => {
    const { log } = await import("../src/logging.js");
    const spy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const cfg = makeConfig();
      const stop = new StopFlag();
      let polls = 0;
      const { deps } = makeDeps({
        runOnceFn: vi.fn(async () => false),
        // Let two idle polls happen, then stop.
        sleep: vi.fn(async () => {
          polls++;
          if (polls >= 2) stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      const idleLogs = spy.mock.calls.filter((c) => String(c[0]) === "idle");
      expect(idleLogs).toHaveLength(1);
      // sleep ran for both idle polls.
      expect(deps.sleep).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-arms the idle flag after a handled task (idle can log again)", async () => {
    const { log } = await import("../src/logging.js");
    const spy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const cfg = makeConfig();
      const stop = new StopFlag();
      // Sequence: idle, handled, idle, then stop on the 2nd idle sleep.
      const results = [false, true, false];
      let i = 0;
      let sleeps = 0;
      const { deps } = makeDeps({
        runOnceFn: vi.fn(async () => results[Math.min(i++, results.length - 1)]),
        sleep: vi.fn(async () => {
          sleeps++;
          if (sleeps >= 2) stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      const idleLogs = spy.mock.calls.filter((c) => String(c[0]) === "idle");
      // Idle logged before the handled task, then re-armed and logged again.
      expect(idleLogs).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not enter the loop at all if stop is requested before startup completes", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    const { deps } = makeDeps({
      waitForOmlxFn: vi.fn(async () => {
        stop.requestStop();
      }),
      runOnceFn: vi.fn(async () => false),
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(deps.runOnceFn).not.toHaveBeenCalled();
  });
});
