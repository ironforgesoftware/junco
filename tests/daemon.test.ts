/**
 * Tests for src/daemon.ts — StopFlag, sleepInterruptible, installSignalHandlers,
 * mainLoop.  Written FIRST (TDD).  No real fs / network / timers — every
 * side-effecting collaborator is injected.
 *
 * Port of worker.py StopFlag / _sleep_interruptible / main_loop /
 * _install_signal_handlers.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/types.js";
import { executeClaimed, type ClaimedWork } from "../src/runOnce.js";
import type { HealthServerHandle, HealthServerOpts } from "../src/healthServer.js";
import { metrics } from "../src/metrics.js";
import { enqueueOp, outboxDepth } from "../src/githubOutbox.js";
import {
  StopFlag,
  sleepInterruptible,
  installSignalHandlers,
  mainLoop,
  runScheduler,
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
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
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
    allowedRepoRoots: [],
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
    stateDir: "/tmp/vault/state",
    logToFile: false,
    transcriptsEnabled: false,
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
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm" },
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
    claimFn: vi.fn(async () => null),
    executeFn: vi.fn(async () => {}),
    recoverOrphansFn: vi.fn(() => {}),
    pruneFn: vi.fn(() => {}),
    waitForEndpointFn: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    mkdirs: vi.fn(() => {}),
    // Default fake — never binds a real port. Tests that exercise the health
    // lifecycle pass their own spy + a healthEnabled:true config.
    startHealthServerFn: vi.fn(async () => makeFakeHealthHandle()),
    bridgeSweepFn: vi.fn(async () => 0),
    outboxDrainFn: vi.fn(async () => ({ sent: 0, dead: 0, remaining: 0, offline: false })),
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

  it("StopFlag: requestForceStop aborts the forceSignal and latches requested", () => {
    const f = new StopFlag();
    expect(f.forceSignal.aborted).toBe(false);
    f.requestForceStop();
    expect(f.forceSignal.aborted).toBe(true);
    expect(f.requested).toBe(true);
  });

  it("signal handlers escalate: 1st → graceful stop, 2nd → force stop", () => {
    const stop = new StopFlag();
    const uninstall = installSignalHandlers(stop);
    try {
      process.emit("SIGTERM");
      expect(stop.requested).toBe(true);
      expect(stop.forceSignal.aborted).toBe(false);
      process.emit("SIGTERM");
      expect(stop.forceSignal.aborted).toBe(true);
    } finally {
      uninstall();
    }
  });

  it("a third signal triggers the hard-exit (130) path via the injected exit seam", () => {
    // Belt-and-suspenders: never let a real process.exit tear down the runner,
    // even if the seam were unwired.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as never);
    const exit = vi.fn();
    const stop = new StopFlag();
    const uninstall = installSignalHandlers(stop, { exit });
    try {
      process.emit("SIGTERM"); // 1st → graceful stop
      expect(stop.requested).toBe(true);
      process.emit("SIGTERM"); // 2nd → force stop
      expect(stop.forceSignal.aborted).toBe(true);
      expect(exit).not.toHaveBeenCalled();
      process.emit("SIGTERM"); // 3rd → hard exit
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(130);
      // With the seam injected, the real process.exit is never touched.
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      uninstall();
      exitSpy.mockRestore();
    }
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
    const startHealthServerFn = vi.fn(async (_opts: HealthServerOpts) => handle);
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
    const arg = startHealthServerFn.mock.calls[0]![0]!;
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

// ---------------------------------------------------------------------------
// runScheduler (max_concurrent > 1)
// ---------------------------------------------------------------------------

describe("runScheduler", () => {
  const fakeWork = (id: string, repoKey: string | null): ClaimedWork => ({
    ticket: { id } as ClaimedWork["ticket"],
    claimedPath: `/p/${id}`,
    repoKey,
  });

  // A sleep that yields a real macrotask tick — an instant-resolve fake would
  // starve setTimeout-based fake tasks and spin the scheduler on microtasks.
  const tickSleep = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 1));
  };

  it("runs up to max_concurrent tasks at once and per-repo serializes", async () => {
    const cfg = makeConfig({ maxConcurrent: 2, pollIntervalSeconds: 0.001 });
    const queue = [fakeWork("a", "/repo/X"), fakeWork("b", "/repo/X"), fakeWork("c", "/repo/Y")];
    let peak = 0;
    let running = 0;
    const started: string[] = [];
    const stop = new StopFlag();
    const claimFn = async (_c: Config, o: { skipRepoKeys: Set<string> }) => {
      const i = queue.findIndex((w) => !w.repoKey || !o.skipRepoKeys.has(w.repoKey));
      if (i === -1) {
        if (queue.length === 0 && running === 0) stop.requestStop();
        return null;
      }
      return queue.splice(i, 1)[0];
    };
    const executeFn = async (_c: Config, w: ClaimedWork) => {
      running++;
      peak = Math.max(peak, running);
      started.push(w.ticket.id);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    };
    await runScheduler(cfg, stop, {}, { claimFn, executeFn, sleep: tickSleep });
    expect(started.sort()).toEqual(["a", "b", "c"]);
    expect(peak).toBe(2); // c ran beside a; b waited for repo X to free up
    // b must have started strictly after a finished (same repo).
    expect(started.indexOf("b")).toBeGreaterThan(started.indexOf("a"));
  });

  it("graceful stop drains in-flight work before returning", async () => {
    const cfg = makeConfig({ maxConcurrent: 2, pollIntervalSeconds: 0.001 });
    const stop = new StopFlag();
    let finished = 0;
    let given = false;
    const claimFn = async () => {
      if (given) return null;
      given = true;
      return fakeWork("slow", null);
    };
    const executeFn = async () => {
      stop.requestStop(); // stop arrives mid-task
      await new Promise((r) => setTimeout(r, 30));
      finished++;
    };
    await runScheduler(cfg, stop, {}, { claimFn, executeFn, sleep: tickSleep });
    expect(finished).toBe(1); // drained, not abandoned
  });

  it("a claim-time throw drains in-flight work and does not propagate (no process-killing throw)", async () => {
    // claimNextTask deliberately rethrows non-ENOENT fs errors. That throw must
    // NOT escape runScheduler to cli.ts's process.exit(1) — which would
    // hard-kill every in-flight session with no commit salvage. Instead it is
    // caught and the in-flight set is drained, matching a SIGTERM's graceful
    // drain.
    const cfg = makeConfig({ maxConcurrent: 2, pollIntervalSeconds: 0.001 });
    const stop = new StopFlag();
    let finished = 0;
    let claims = 0;
    const claimFn = async () => {
      claims++;
      if (claims === 1) return fakeWork("slow", null); // first: a long in-flight task
      throw new Error("EIO: non-ENOENT fs error rethrown by claimNextTask");
    };
    const executeFn = async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished++;
    };
    // Must RESOLVE (not reject): a claim throw is caught, not propagated.
    await expect(
      runScheduler(cfg, stop, {}, { claimFn, executeFn, sleep: tickSleep }),
    ).resolves.toBeUndefined();
    expect(finished).toBe(1); // in-flight task drained to completion, not abandoned
  });

  it("once mode claims one task, drains it, and returns", async () => {
    const cfg = makeConfig({ maxConcurrent: 3, pollIntervalSeconds: 0.001 });
    const stop = new StopFlag();
    const claims: string[] = [];
    let done = 0;
    let n = 0;
    const claimFn = async () => {
      n++;
      claims.push(`t${n}`);
      return fakeWork(`t${n}`, null);
    };
    const executeFn = async () => {
      await new Promise((r) => setTimeout(r, 10));
      done++;
    };
    await runScheduler(cfg, stop, { once: true }, { claimFn, executeFn, sleep: tickSleep });
    expect(claims).toEqual(["t1"]);
    expect(done).toBe(1);
  });

  it("a crashing executeFn is logged and does not kill the scheduler", async () => {
    const cfg = makeConfig({ maxConcurrent: 2, pollIntervalSeconds: 0.001 });
    const stop = new StopFlag();
    const queue = [fakeWork("boom", null), fakeWork("ok", null)];
    let okRan = false;
    const claimFn = async () => {
      const w = queue.shift() ?? null;
      if (!w && okRan) stop.requestStop();
      return w;
    };
    const executeFn = async (_c: Config, w: ClaimedWork) => {
      if (w.ticket.id === "boom") throw new Error("kaboom");
      okRan = true;
    };
    await runScheduler(cfg, stop, {}, { claimFn, executeFn, sleep: tickSleep });
    expect(okRan).toBe(true);
  });

  it("a crashing executeClaimed never strands the claimed ticket in processing/", async () => {
    // Real queue dirs + the default claimFn (claimNextTask), with the real
    // executeClaimed whose session factory rejects — the ticket's DISPOSITION
    // must be a requeue (budget permitting), not an indefinite processing/
    // strand while the scheduler keeps looking healthy.
    const root = mkdtempSync(join(tmpdir(), "junco-daemon-crash-"));
    const j = join(root, "Junco");
    for (const d of ["inbox", "processing", "done", "failed"]) {
      mkdirSync(join(j, d), { recursive: true });
    }
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const cfg = makeConfig({ vaultRoot: root, maxConcurrent: 2, pollIntervalSeconds: 0.001 });
    const stop = new StopFlag();
    const executeFn = (c: Config, w: ClaimedWork): Promise<void> =>
      executeClaimed(c, w, {
        sessionFactoryFor: () => async () => {
          throw new Error("model unresolved at session create");
        },
      });
    await runScheduler(cfg, stop, { once: true }, { executeFn, sleep: tickSleep });
    expect(readdirSync(join(j, "processing"))).toHaveLength(0); // not stranded
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    expect(readFileSync(join(j, "inbox", inbox[0]), "utf8")).toMatch(/retry_count: 1/);
  });
});

// ---------------------------------------------------------------------------
// GitHub bridge wiring
// ---------------------------------------------------------------------------

describe("github bridge wiring", () => {
  const bridgeGithub = (pollSeconds: number) => ({
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: pollSeconds,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
    externalReposRoot: "/tmp/junco-test-external",
  });

  it("enabled=false: injected bridgeSweepFn is never called", async () => {
    let sweeps = 0;
    const cfg = makeConfig(); // github.enabled false in fixtures
    const stop = new StopFlag();
    const { deps } = makeDeps({
      runOnceFn: async () => {
        stop.requestStop();
        return false;
      },
      bridgeSweepFn: async () => {
        sweeps++;
        return 0;
      },
    });
    await mainLoop(cfg, stop, {}, deps);
    expect(sweeps).toBe(0);
  });

  it("enabled=true: sweeps on the first poll and throttles within the interval", async () => {
    let sweeps = 0;
    let polls = 0;
    const cfg = makeConfig({ github: bridgeGithub(3600) });
    const stop = new StopFlag();
    const { deps } = makeDeps({
      runOnceFn: async () => {
        polls++;
        if (polls >= 3) stop.requestStop();
        return true; // handled → loop continues without sleeping
      },
      bridgeSweepFn: async () => {
        sweeps++;
        return 0;
      },
    });
    await mainLoop(cfg, stop, {}, deps);
    expect(polls).toBe(3);
    expect(sweeps).toBe(1); // 3600s interval → only the first iteration sweeps
  });

  it("serial loop: a stop landing during the bridge sweep prevents a brand-new claim", async () => {
    // A SIGTERM during the sweep (multi-repo gh calls, seconds) must not be
    // followed by a fresh claim + up to timeout_minutes of NEW work — mirror
    // the scheduler's per-claim stopFlag check.
    const cfg = makeConfig({ github: bridgeGithub(60) });
    const stop = new StopFlag();
    const { deps } = makeDeps({
      bridgeSweepFn: async () => {
        stop.requestStop(); // operator stop arrives mid-sweep
        return 0;
      },
      runOnceFn: vi.fn(async () => true),
    });
    await mainLoop(cfg, stop, {}, deps);
    expect(deps.runOnceFn).not.toHaveBeenCalled();
  });

  it("a sweep error does not crash the loop", async () => {
    const cfg = makeConfig({ github: bridgeGithub(60) });
    const stop = new StopFlag();
    const { deps } = makeDeps({
      runOnceFn: async () => {
        stop.requestStop();
        return false;
      },
      bridgeSweepFn: async () => {
        throw new Error("github down");
      },
    });
    await expect(mainLoop(cfg, stop, {}, deps)).resolves.toBeUndefined();
  });

  it("scheduler mode (max_concurrent > 1) also sweeps", async () => {
    let sweeps = 0;
    const cfg = makeConfig({ github: bridgeGithub(3600), maxConcurrent: 2 });
    const stop = new StopFlag();
    const { deps } = makeDeps({
      claimFn: async () => {
        stop.requestStop();
        return null;
      },
      bridgeSweepFn: async () => {
        sweeps++;
        return 0;
      },
    });
    await mainLoop(cfg, stop, {}, deps as never);
    expect(sweeps).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Local-mode outbox auto-drain (I-1): when the bridge is disabled,
// pollGithubInbox's flush-first sweep never runs, so prFlow's offline
// endgame (which enqueues push/PR/comment ops and promises an automatic
// push in the finalize note) needs its own throttled flusher.
// ---------------------------------------------------------------------------

describe("outbox drain (local mode)", () => {
  const disabledGithub = (pollSeconds: number) => ({
    enabled: false,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: pollSeconds,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
    externalReposRoot: "/tmp/junco-test-external",
  });
  const enabledGithub = (pollSeconds: number) => ({
    ...disabledGithub(pollSeconds),
    enabled: true,
  });

  /** Real fs: enqueueOp/outboxDepth are not injected through MainLoopDeps
   * (they're cheap direct fs calls, mirrored on the bridge sweep's own
   * throttle), so these tests use a real tmp stateDir rather than a fake. */
  const tmpStateDir = (): string => mkdtempSync(join(tmpdir(), "junco-daemon-obx-"));

  it("github disabled + depth > 0: drain fn is called on the throttle cadence", async () => {
    const cfg = makeConfig({ stateDir: tmpStateDir(), github: disabledGithub(3600) });
    enqueueOp(cfg, "reporter", { kind: "push", repoPath: "/r", branch: "junco/x" });
    expect(outboxDepth(cfg)).toBe(1);

    let drains = 0;
    let polls = 0;
    const stop = new StopFlag();
    const { deps } = makeDeps({
      runOnceFn: async () => {
        polls++;
        if (polls >= 3) stop.requestStop();
        return true; // handled → loop continues without sleeping
      },
      outboxDrainFn: async () => {
        drains++;
        return { sent: 1, dead: 0, remaining: 0, offline: false };
      },
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(polls).toBe(3);
    expect(drains).toBe(1); // 3600s interval → only the first iteration drains
  });

  it("github disabled + depth 0: drain fn is never called (nothing to flush)", async () => {
    const cfg = makeConfig({ github: disabledGithub(3600) }); // no stateDir → depth 0
    let drains = 0;
    const stop = new StopFlag();
    const { deps } = makeDeps({
      runOnceFn: async () => {
        stop.requestStop();
        return false;
      },
      outboxDrainFn: async () => {
        drains++;
        return { sent: 0, dead: 0, remaining: 0, offline: false };
      },
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(drains).toBe(0);
  });

  it("github enabled: the standalone drain is never used (the bridge sweep already flushes first)", async () => {
    const cfg = makeConfig({ stateDir: tmpStateDir(), github: enabledGithub(3600) });
    enqueueOp(cfg, "reporter", { kind: "push", repoPath: "/r", branch: "junco/x" });

    let drains = 0;
    const stop = new StopFlag();
    const { deps } = makeDeps({
      runOnceFn: async () => {
        stop.requestStop();
        return false;
      },
      bridgeSweepFn: async () => 0,
      outboxDrainFn: async () => {
        drains++;
        return { sent: 1, dead: 0, remaining: 0, offline: false };
      },
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(drains).toBe(0);
  });

  it("a drain error does not crash the loop", async () => {
    const cfg = makeConfig({ stateDir: tmpStateDir(), github: disabledGithub(60) });
    enqueueOp(cfg, "reporter", { kind: "push", repoPath: "/r", branch: "junco/x" });

    const stop = new StopFlag();
    const { deps } = makeDeps({
      runOnceFn: async () => {
        stop.requestStop();
        return false;
      },
      outboxDrainFn: async () => {
        throw new Error("disk full");
      },
    });

    await expect(mainLoop(cfg, stop, {}, deps)).resolves.toBeUndefined();
  });

  it("scheduler mode (max_concurrent > 1) also drains when github is disabled", async () => {
    const cfg = makeConfig({
      stateDir: tmpStateDir(),
      github: disabledGithub(3600),
      maxConcurrent: 2,
    });
    enqueueOp(cfg, "reporter", { kind: "push", repoPath: "/r", branch: "junco/x" });

    let drains = 0;
    const stop = new StopFlag();
    const { deps } = makeDeps({
      claimFn: async () => {
        stop.requestStop();
        return null;
      },
      outboxDrainFn: async () => {
        drains++;
        return { sent: 1, dead: 0, remaining: 0, offline: false };
      },
    });

    await mainLoop(cfg, stop, {}, deps as never);
    expect(drains).toBe(1);
  });
});
