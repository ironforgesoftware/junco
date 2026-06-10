/**
 * Tests for src/daemon.ts — StopFlag, sleepInterruptible, installSignalHandlers,
 * mainLoop.  Written FIRST (TDD).  No real fs / network / timers — every
 * side-effecting collaborator is injected.
 *
 * Port of worker.py StopFlag / _sleep_interruptible / main_loop /
 * _install_signal_handlers.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { Config } from "../src/types.js";
import type { HealthServerHandle } from "../src/healthServer.js";
import { metrics } from "../src/metrics.js";
import {
  StopFlag,
  sleepInterruptible,
  installSignalHandlers,
  mainLoop,
  type MainLoopDeps,
} from "../src/daemon.js";

/** A fake health-server handle whose close() is a spy — never binds a port. */
function makeFakeHealthHandle(): HealthServerHandle {
  return {
    port: 12345,
    url: "http://127.0.0.1:12345",
    close: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: "/tmp/vault",
    juncoSubdir: "Junco",
    model: {
      id: "omlx/test-model",
      modelsJson: null,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "test-key",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 49152,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevel: "medium",
      compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
    },
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
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 0,
    logLevel: "info",
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
    waitForEndpointFn: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    mkdirs: vi.fn(() => {}),
    // Default fake — never binds a real port. Tests that exercise the health
    // lifecycle pass their own spy + a healthEnabled:true config.
    startHealthServerFn: vi.fn(async () => makeFakeHealthHandle()),
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
      const stopLogs = spy.mock.calls.filter((c) => String(c[0]).includes("stop requested"));
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
      waitForEndpointFn: vi.fn(async () => {
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

    expect(order.slice(0, 5)).toEqual(["mkdirs", "recover", "prune", "wait", "runOnce"]);
    expect(deps.mkdirs).toHaveBeenCalledTimes(1);
    expect(deps.recoverOrphansFn).toHaveBeenCalledTimes(1);
    expect(deps.pruneFn).toHaveBeenCalledTimes(1);
    expect(deps.pruneFn).toHaveBeenCalledWith(cfg.worktreeRoot);
    expect(deps.waitForEndpointFn).toHaveBeenCalledTimes(1);
    expect(deps.waitForEndpointFn).toHaveBeenCalledWith(cfg, stop);
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
      waitForEndpointFn: vi.fn(async () => {
        stop.requestStop();
      }),
      runOnceFn: vi.fn(async () => false),
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(deps.runOnceFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mainLoop — observability wiring (metrics + health lifecycle)
// ---------------------------------------------------------------------------

describe("mainLoop — observability", () => {
  // The metrics singleton is process-wide; reset so pollCount assertions start
  // from a clean slate and don't leak into other suites.
  beforeEach(() => metrics.reset());
  afterEach(() => metrics.reset());

  it("records at least one poll while looping", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    const { deps } = makeDeps({
      runOnceFn: vi.fn(async () => false),
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(metrics.snapshot().pollCount).toBeGreaterThan(0);
    expect(metrics.snapshot().startedAt).not.toBeNull();
  });

  it("starts the health server once at boot and closes it after the loop ends (healthEnabled:true)", async () => {
    const cfg = makeConfig({ healthEnabled: true });
    const stop = new StopFlag();
    const handle = makeFakeHealthHandle();
    const startHealthServerFn = vi.fn(async () => handle);
    const { deps } = makeDeps({
      startHealthServerFn,
      runOnceFn: vi.fn(async () => false),
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(startHealthServerFn).toHaveBeenCalledTimes(1);
    // It receives the configured host/port + the metrics singleton + a probe.
    const arg = startHealthServerFn.mock.calls[0][0];
    expect(arg.host).toBe(cfg.healthHost);
    expect(arg.port).toBe(cfg.healthPort);
    expect(arg.metrics).toBe(metrics);
    expect(typeof arg.readinessProbe).toBe("function");
    // Closed exactly once, AFTER the loop exits.
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("does not start the health server when healthEnabled:false", async () => {
    const cfg = makeConfig({ healthEnabled: false });
    const stop = new StopFlag();
    const startHealthServerFn = vi.fn(async () => makeFakeHealthHandle());
    const { deps } = makeDeps({
      startHealthServerFn,
      runOnceFn: vi.fn(async () => false),
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(startHealthServerFn).not.toHaveBeenCalled();
  });

  it("a health-server start failure does NOT crash the daemon (logs warn, continues, no close)", async () => {
    const { log } = await import("../src/logging.js");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const cfg = makeConfig({ healthEnabled: true });
      const stop = new StopFlag();
      const startHealthServerFn = vi.fn(async () => {
        throw new Error("EADDRINUSE");
      });
      const runOnceFn = vi.fn(async () => false);
      const { deps } = makeDeps({
        startHealthServerFn,
        runOnceFn,
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      // Must resolve (not reject) — the daemon survives a health-start failure.
      await expect(mainLoop(cfg, stop, {}, deps)).resolves.toBeUndefined();

      // Loop still ran.
      expect(runOnceFn).toHaveBeenCalled();
      // A warning was logged for the failed start.
      const warned = warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("health endpoint failed to start"),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("closes the health server even when the poll loop throws (finally)", async () => {
    const cfg = makeConfig({ healthEnabled: true });
    const stop = new StopFlag();
    const handle = makeFakeHealthHandle();
    const startHealthServerFn = vi.fn(async () => handle);
    const boom = new Error("runOnce blew up mid-loop");
    const { deps } = makeDeps({
      startHealthServerFn,
      runOnceFn: vi.fn(async () => {
        throw boom;
      }),
    });

    // The throw propagates (the daemon process would exit 1), but the health
    // server must still be closed by the finally — no leaked port.
    await expect(mainLoop(cfg, stop, {}, deps)).rejects.toBe(boom);
    expect(startHealthServerFn).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});
