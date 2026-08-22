/**
 * Tests for src/daemon.ts — StopFlag, sleepInterruptible, installSignalHandlers,
 * mainLoop.  Written FIRST (TDD).  No real fs / network / timers — every
 * side-effecting collaborator is injected.
 *
 * Port of worker.py StopFlag / _sleep_interruptible / main_loop /
 * _install_signal_handlers.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/types.js";
import { executeClaimed, type ClaimedWork } from "../src/runOnce.js";
import type { HealthServerHandle, HealthServerOpts } from "../src/healthServer.js";
import { metrics } from "../src/metrics.js";
import { enqueueOp, outboxDepth } from "../src/githubOutbox.js";
import { makeConfigHolder } from "../src/configWatcher.js";
import { dataTreePaths, sandboxDenyPaths } from "../src/dataTree.js";
import { migrateStateTree } from "../src/dataMigrate.js";
import { ProviderGate, type GateStatus } from "../src/providerGate.js";
import type { ProviderFailureClass } from "../src/providerFailure.js";
import { makeSpendLedger } from "../src/spendLedger.js";
import {
  StopFlag,
  sleepInterruptible,
  installSignalHandlers,
  mainLoop,
  runScheduler,
  overlayFrozenRestartFields,
  type MainLoopDeps,
} from "../src/daemon.js";
import { makeConfig as baseConfig } from "./helpers/config.js";

// Phase-3 Task 4: intercept runOnce/executeClaimed exactly as daemon.ts sees
// them (both are genuine cross-module imports from runOnce.js, so Vitest's
// module registry can redirect them — see the "spend ledger wiring" describe
// below). Each box defaults to a PASSTHROUGH to the real implementation
// (wired up inside the factory below), so every OTHER test in this file that
// never touches these boxes is completely unaffected; only the spend-wiring
// tests swap `.current` to a spy for the duration of one test.
const runOnceBox = vi.hoisted(() => ({ current: null as unknown as (...a: any[]) => any }));
const executeClaimedBox = vi.hoisted(() => ({ current: null as unknown as (...a: any[]) => any }));
vi.mock("../src/runOnce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runOnce.js")>();
  runOnceBox.current = actual.runOnce;
  executeClaimedBox.current = actual.executeClaimed;
  return {
    ...actual,
    runOnce: (...args: unknown[]) => runOnceBox.current(...args),
    executeClaimed: (...args: unknown[]) => executeClaimedBox.current(...args),
  };
});

/** A fake health-server handle whose close() is a spy — never binds a port. */
function makeFakeHealthHandle(): HealthServerHandle {
  return {
    port: 12345,
    url: "http://127.0.0.1:12345",
    close: vi.fn(async () => {}),
  };
}

/** Minimal fake gate: same Pick-shape pattern as runOnce.test.ts's fakeGate (a
 * plain object — no need for the real latching state machine), extended with
 * claimBlockReason/status for the daemon's own local checks (gatedReady + the
 * health server's gateStatus). `blockReason: null` never blocks claiming. */
function fakeGate(blockReason: string | null): {
  claimBlockReason: () => string | null;
  status: () => GateStatus;
  reportFailure: (cls: ProviderFailureClass, reason: string) => void;
  reportSuccess: () => void;
  notBeforeIso: () => string;
  reportBudgetExhausted: (untilMs: number, reason: string) => void;
} {
  return {
    claimBlockReason: () => blockReason,
    status: () => ({
      state: blockReason ? "auth_error" : "ok",
      reason: blockReason,
      since: null,
      until: null,
    }),
    reportFailure: () => {},
    reportSuccess: () => {},
    notBeforeIso: () => "2099-01-01T00:00:00.000Z",
    reportBudgetExhausted: () => {},
  };
}

/** Minimal fake spend ledger (Phase-3 Task 4): a plain object satisfying
 * `Pick<SpendLedger, "recordUsd" | "todayUsd" | "nextMidnightMs">` — same
 * shape-only pattern as fakeGate, no need to pull in the real persisted-file
 * ledger for wiring tests. `todayUsd` defaults to 0 (under any budget) so
 * existing callers that don't care about the budget gate (Phase-3 Task 5) are
 * unaffected. */
function fakeSpend(todayUsd = 0): {
  calls: number[];
  recordUsd: (usd: number) => void;
  todayUsd: () => number;
  nextMidnightMs: () => number;
} {
  const calls: number[] = [];
  return {
    calls,
    recordUsd(usd: number) {
      calls.push(usd);
    },
    todayUsd: () => todayUsd,
    // An hour in the future by REAL wall-clock time — safe against gates
    // built with the default (unfaked) `now: () => Date.now()`, which would
    // otherwise auto-expire a just-latched budget_exhausted state instantly
    // if this returned a fixed past instant like 0.
    nextMidnightMs: () => Date.now() + 3_600_000,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return baseConfig(
    {
      dataDir: "/tmp/vault/state",
      queueRoot: "/tmp/vault/Junco",
      worktreeRoot: "/tmp/worktrees",
      tools: [],
      criticEnabled: true,
      planLintEnabled: true,
      verifyEnabled: true,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: true,
    },
    {
      dataLayout: "flat", // every dataTreePaths-derived path assertion below is flat-shaped
      planLintBlockOnError: true,
      planLintCheckLabels: true,
      healthPort: 0, // ephemeral; the health server is faked, never binds
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
      ...overrides,
    },
  );
}

/**
 * A "stub" set of MainLoopDeps where every collaborator is a no-op spy.  The
 * default sleep resolves immediately so the poll loop never blocks on real
 * timers.  Callers override `runOnceFn` / `sleep` to drive the loop and reach
 * the stop condition.
 *
 * `configHolder` stays optional (unlike every other field) — it's the Task 6
 * live-reload seam, and most tests exercise the no-holder fallback path (see
 * "mainLoop reads the holder each iteration" for the holder-set case).
 */
type StubMainLoopDeps = Required<Omit<MainLoopDeps, "configHolder">> &
  Pick<MainLoopDeps, "configHolder">;

function makeDeps(overrides: Partial<MainLoopDeps> = {}): {
  deps: StubMainLoopDeps;
} {
  const deps: StubMainLoopDeps = {
    runOnceFn: vi.fn(async () => false),
    claimFn: vi.fn(async () => null),
    executeFn: vi.fn(async () => {}),
    recoverOrphansFn: vi.fn(() => {}),
    pruneFn: vi.fn(() => {}),
    waitForEndpointFn: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    // Real migrateStateTree touches the filesystem; these fixture dataDirs
    // ("/tmp/vault/state" etc.) aren't real tmp roots, so default every test
    // to a no-op migration unless a test overrides it to exercise the wiring.
    migrateFn: vi.fn(() => ({ steps: [], conflicts: [] })),
    // Fake migrate lock — the real acquirePidfileLock would mkdir the fixture
    // dataDir and write a real lock file (#197.2). Tests exercising the lock
    // override this.
    migrateLockFn: vi.fn(() => ({ release: vi.fn() })),
    mkdirs: vi.fn(() => {}),
    // Never creates/repairs/warns by default — the "all-quiet" report, which
    // also keeps the daemon's post-mkdirs info log silent for every OTHER
    // test in this file (see "logs the skill-link report..." for the
    // non-quiet case).
    ensureSkillLinksFn: vi.fn(() => ({ entries: [] })),
    // Default fake — never binds a real port. Tests that exercise the health
    // lifecycle pass their own spy + a healthEnabled:true config.
    startHealthServerFn: vi.fn(async () => makeFakeHealthHandle()),
    bridgeSweepFn: vi.fn(async () => 0),
    outboxDrainFn: vi.fn(async () => ({ sent: 0, dead: 0, remaining: 0, offline: false })),
    depSweepFn: vi.fn(async () => ({ stamped: 0, cascaded: 0 })),
    // Never blocks by default — most tests don't care about the gate at all;
    // override with fakeGate(reason) to exercise blocked-claim behavior.
    gate: fakeGate(null),
    // Most tests don't care about spend at all; override with fakeSpend() (or
    // `undefined` to exercise mainLoop's own default-ledger construction).
    spend: fakeSpend(),
    // Most tests don't care about metrics.json at all; override with a fake
    // { write, flush } spy pair (or `undefined` to exercise mainLoop's own
    // default-writer construction, Task 3).
    metricsWriter: { write: vi.fn(), flush: vi.fn() },
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
// overlayFrozenRestartFields
// ---------------------------------------------------------------------------

describe("overlayFrozenRestartFields", () => {
  it('pins every reload:"restart" lever to frozen; passes live-kind fields through', () => {
    const frozen = makeConfig({
      dataDir: "/frozen/state",
      queueRoot: "/frozen/vault/FrozenJunco",
      legacy: {
        vaultRoot: true,
        stateDir: false,
        worktreeRoot: false,
        externalReposRoot: false,
        dataRoot: false,
        ghConfigDir: false,
      },
      maxConcurrent: 1,
      healthEnabled: false,
      healthHost: "127.0.0.1",
      healthPort: 8787,
      logToFile: false,
      transcriptsEnabled: false,
      pollIntervalSeconds: 15,
      github: {
        ...makeConfig().github,
        enabled: false,
        triggerLabel: "frozen-trigger",
        askLabel: "frozen-ask",
      },
    });
    const live = makeConfig({
      dataDir: "/live/state",
      queueRoot: "/live/vault/LiveJunco",
      legacy: {
        vaultRoot: false,
        stateDir: true,
        worktreeRoot: false,
        externalReposRoot: false,
        dataRoot: false,
        ghConfigDir: false,
      },
      maxConcurrent: 10,
      healthEnabled: true,
      healthHost: "0.0.0.0",
      healthPort: 9999,
      logToFile: true,
      transcriptsEnabled: true,
      pollIntervalSeconds: 42,
      model: { ...makeConfig().model, id: "model-v2" },
      github: {
        ...makeConfig().github,
        enabled: true,
        triggerLabel: "live-trigger",
        askLabel: "live-ask",
      },
    });

    const result = overlayFrozenRestartFields(frozen, live);

    // Restart-kind flat fields: pinned to frozen, never the live edit.
    expect(result.dataDir).toBe(frozen.dataDir);
    expect(result.queueRoot).toBe(frozen.queueRoot);
    expect(result.legacy).toEqual(frozen.legacy);
    expect(result.maxConcurrent).toBe(frozen.maxConcurrent);
    expect(result.healthEnabled).toBe(frozen.healthEnabled);
    expect(result.healthHost).toBe(frozen.healthHost);
    expect(result.healthPort).toBe(frozen.healthPort);
    expect(result.logToFile).toBe(frozen.logToFile);
    expect(result.transcriptsEnabled).toBe(frozen.transcriptsEnabled);
    expect(result.github.enabled).toBe(frozen.github.enabled);
    // github.triggerLabel/askLabel are reload:"restart" — the reporter bakes in
    // the label prefix at startup, so they must be frozen too (#162).
    expect(result.github.triggerLabel).toBe(frozen.github.triggerLabel);
    expect(result.github.askLabel).toBe(frozen.github.askLabel);

    // Live-kind fields: pass through from live.
    expect(result.pollIntervalSeconds).toBe(live.pollIntervalSeconds);
    expect(result.model.id).toBe(live.model.id);
  });

  it("pins the dataDir-derived worktreeRoot/externalReposRoot — a live dataDir edit must not move them", () => {
    // Neither legacy override key is set, so both roots derive from dataDir —
    // which is reload:"restart". Without the pin, a live dataDir/stateDir edit
    // would move NEW worktrees + external-clone resolution while the queue,
    // transcripts, etc. stay frozen (the #186 partial-application class).
    const frozen = makeConfig({
      dataDir: "/frozen/state",
      worktreeRoot: "/frozen/state/worktrees",
      github: { ...makeConfig().github, externalReposRoot: "/frozen/state/clones/external" },
    });
    const live = makeConfig({
      dataDir: "/live/state",
      worktreeRoot: "/live/state/worktrees",
      github: { ...makeConfig().github, externalReposRoot: "/live/state/clones/external" },
    });

    const result = overlayFrozenRestartFields(frozen, live);

    expect(result.worktreeRoot).toBe("/frozen/state/worktrees");
    expect(result.github.externalReposRoot).toBe("/frozen/state/clones/external");
  });

  it("pins dataLayout to frozen — a live edit that probes a differently-shaped root must not pair the frozen dataDir with a mismatched layout (C1)", () => {
    // dataLayout is dataDir-derived, exactly like worktreeRoot/externalReposRoot
    // above: a frozen FLAT root (a live 0.9 tree) must never see its
    // dataTreePaths()-derived paths (outbox/transcripts/history/logFile/...)
    // move to data/cache/logs subpaths just because a live config reload
    // happens to resolve a DIFFERENT root as v2. makeConfig's ballast gives
    // frozen/live the same dataLayout by default, so this test states both
    // explicitly and DIFFERENTLY — the one regression test daemon.test.ts's
    // existing overlay coverage cannot catch by accident.
    const frozen = makeConfig({
      dataDir: "/frozen/legacy-junco",
      dataLayout: "flat",
      worktreeRoot: "/frozen/legacy-junco/worktrees", // the flat derived default
    });
    const live = makeConfig({
      dataDir: "/frozen/legacy-junco", // same root — only the resolved layout differs
      dataLayout: "v2",
      worktreeRoot: "/frozen/legacy-junco/cache/worktrees",
    });

    const result = overlayFrozenRestartFields(frozen, live);

    expect(result.dataLayout).toBe("flat");
    expect(result.dataLayout).toBe(frozen.dataLayout);

    // The effective on-disk shape stays flat: no path acquires a data/cache/
    // logs prefix inside the live 0.9 tree.
    const paths = dataTreePaths(result);
    expect(paths.outbox).toBe("/frozen/legacy-junco/outbox");
    expect(paths.transcripts).toBe("/frozen/legacy-junco/transcripts");
    expect(paths.history).toBe("/frozen/legacy-junco/history");
    expect(paths.logFile).toBe("/frozen/legacy-junco/worker.log");
    expect(paths.outbox).not.toContain("/data/");
    expect(paths.logFile).not.toContain("/logs/");

    // The sandbox lists (also layout-derived, read per-run off this same
    // overlaid config — src/agent/session.ts) still describe the REAL flat
    // tree rather than a nonexistent v2 one, so containment doesn't silently
    // widen. Since #277 the deny side is the root wholesale, and the
    // layout-specific part is the ALLOW-BACK: flat allows worktrees/ and
    // clones/ back, v2 would have allowed a `cache/` tier that does not exist
    // in this 0.9 tree — allowing it here would have opened nothing, but
    // failing to allow the flat roots would wall the agent out of its worktree.
    const deny = sandboxDenyPaths(result);
    expect(deny.dirs).toContain("/frozen/legacy-junco");
    expect(deny.files).toContain("/frozen/legacy-junco/worker.log");
    expect(deny.allowDirs).toContain("/frozen/legacy-junco/worktrees");
    expect(deny.allowDirs).toContain("/frozen/legacy-junco/clones");
    expect(deny.allowDirs).not.toContain("/frozen/legacy-junco/cache");
  });

  it("an explicitly-set legacy override keeps its own live-reload semantics", () => {
    // git.worktreeRoot / github.externalReposRoot are reload:"live" levers —
    // when the LIVE parse sets them explicitly, the edit hot-applies; only the
    // dataDir-DERIVED values are pinned.
    const frozen = makeConfig({
      dataDir: "/frozen/state",
      worktreeRoot: "/frozen/state/worktrees",
      github: { ...makeConfig().github, externalReposRoot: "/frozen/state/clones/external" },
    });
    const live = makeConfig({
      dataDir: "/frozen/state",
      worktreeRoot: "/custom/wt",
      github: { ...makeConfig().github, externalReposRoot: "/custom/ext" },
      legacy: {
        vaultRoot: false,
        stateDir: false,
        worktreeRoot: true,
        externalReposRoot: true,
        dataRoot: false,
        ghConfigDir: false,
      },
    });

    const result = overlayFrozenRestartFields(frozen, live);

    expect(result.worktreeRoot).toBe("/custom/wt");
    expect(result.github.externalReposRoot).toBe("/custom/ext");
  });

  it("pins the frozen botAccount and ghAuth — a live botAccount.enabled flip can't drop the bot identity mid-run", () => {
    const frozenCtx = {
      configDir: "/frozen/gh",
      login: "junco-agent",
      email: "987654+junco-agent@users.noreply.github.com",
      credentialHelper: "!gh auth git-credential",
    };
    const frozen = makeConfig({
      botAccount: { enabled: true, configDir: "/frozen/gh" },
      ghAuth: frozenCtx,
    });
    // A hot edit disables the bot and (naturally) carries no runtime-resolved
    // ghAuth — the exact silent-revert hazard the freeze exists to prevent.
    const live = makeConfig({
      botAccount: { enabled: false, configDir: "/live/gh" },
    });

    const result = overlayFrozenRestartFields(frozen, live);

    // botAccount.enabled AND botAccount.configDir are both reload:"restart".
    expect(result.botAccount).toEqual(frozen.botAccount);
    // The attached identity survives the flip — child gh/git keep authenticating
    // as the bot until an actual restart re-resolves it.
    expect(result.ghAuth).toEqual(frozenCtx);
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
      // migrate BEFORE mkdirs is load-bearing (Task 4): an eager
      // ensureDataTree would fabricate empty destinations for every
      // old-name pair, turning routine renames into the crash-repair path.
      migrateFn: vi.fn(() => {
        order.push("migrate");
        return { steps: [], conflicts: [] };
      }),
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

    expect(order.slice(0, 6)).toEqual(["migrate", "mkdirs", "recover", "prune", "wait", "runOnce"]);
    expect(deps.migrateFn).toHaveBeenCalledTimes(1);
    expect(deps.mkdirs).toHaveBeenCalledTimes(1);
    expect(deps.recoverOrphansFn).toHaveBeenCalledTimes(1);
    expect(deps.pruneFn).toHaveBeenCalledTimes(1);
    expect(deps.pruneFn).toHaveBeenCalledWith(cfg.worktreeRoot);
    expect(deps.waitForEndpointFn).toHaveBeenCalledTimes(1);
    expect(deps.waitForEndpointFn).toHaveBeenCalledWith(cfg, stop);
  });

  it("skips the startup migration when migrate.lock is held by a concurrent migrate (#197.2)", async () => {
    const { log } = await import("../src/logging.js");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const cfg = makeConfig();
      const stop = new StopFlag();
      const { deps } = makeDeps({
        migrateLockFn: () => null, // another migrate holds the lock
        migrateFn: vi.fn(() => ({ steps: [], conflicts: [] })),
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      expect(deps.migrateFn).not.toHaveBeenCalled();
      const warned = warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("state-tree migration skipped"),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("runs the startup migration under migrate.lock and releases it (#197.2)", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    const release = vi.fn();
    const migrateLockFn = vi.fn(() => ({ release }));
    const { deps } = makeDeps({
      migrateLockFn,
      migrateFn: vi.fn(() => ({ steps: [], conflicts: [] })),
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    // migrateLockFn now takes the lock FILE path itself (dataTreePaths(cfg)
    // .migrateLockFile), not the bare data dir — call shape only; the value
    // is identical to the old join(cfg.dataDir, "migrate.lock") today.
    expect(migrateLockFn).toHaveBeenCalledWith(dataTreePaths(cfg).migrateLockFile);
    expect(deps.migrateFn).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("logs one warn per state-tree migration conflict at startup", async () => {
    const { log } = await import("../src/logging.js");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const cfg = makeConfig();
      const stop = new StopFlag();
      const { deps } = makeDeps({
        migrateFn: vi.fn(() => ({
          steps: [
            {
              from: "/d/assess-review",
              to: "/d/review/assess",
              action: "skipped-conflict" as const,
            },
            {
              from: "/d/comment-review",
              to: "/d/review/comments",
              action: "skipped-conflict" as const,
            },
          ],
          conflicts: [
            "/d/assess-review -> /d/review/assess: destination already exists and is not empty",
            "/d/comment-review -> /d/review/comments: destination already exists and is not empty",
          ],
        })),
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      const conflictWarns = warnSpy.mock.calls.filter(
        (c) => String(c[0]) === "state-tree migration conflict; manual resolution required",
      );
      expect(conflictWarns).toHaveLength(2);
      expect(conflictWarns[0]?.[1]).toEqual({
        conflict:
          "/d/assess-review -> /d/review/assess: destination already exists and is not empty",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs one info receipt per RENAMED migration pair at startup (worker.log evidence)", async () => {
    const { log } = await import("../src/logging.js");
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const cfg = makeConfig();
      const stop = new StopFlag();
      const { deps } = makeDeps({
        migrateFn: vi.fn(() => ({
          steps: [
            { from: "/d/github-outbox", to: "/d/outbox", action: "renamed" as const },
            { from: "/d/repos", to: "/d/clones/watched", action: "noop" as const },
          ],
          conflicts: [],
        })),
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      const renameLogs = infoSpy.mock.calls.filter((c) =>
        String(c[0]).includes("state-tree migration: renamed"),
      );
      expect(renameLogs).toHaveLength(1); // one per renamed pair, none for noops
      expect(renameLogs[0]?.[1]).toEqual({ from: "/d/github-outbox", to: "/d/outbox" });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("startup migration never relocates a legacy-fallback root — only migrateStateTree's same-directory pairs run, `junco data migrate`'s cross-root move never fires (P2.T5)", async () => {
    // WHY this is safe by construction, not just by convention: config.ts's
    // resolveDataRoot FORCES dataLayout to "flat" for ANY root adopted via
    // the legacy fallback (its "IMPORTANT RULING" — a marker-less legacy root
    // can never be misread as v2 and routed through v2-shaped paths). Every
    // path migrateStateTree's pair list (stateTreeMigrations) touches is
    // dataTreePaths(cfg)-derived, i.e. rooted at cfg.dataDir — it never
    // computes a path under a DIFFERENT root. The actual root-mover,
    // flatToV2Pairs (src/dataMigrate.ts, driven only from
    // src/dataMigrateCmd.ts's `junco data migrate`), is a separate exported
    // function daemon.ts never imports or calls — deps.migrateFn's default is
    // migrateStateTree, full stop. So even at startup against a real
    // legacy-fallback root, the old-name pairs can only rename IN PLACE,
    // never relocate to juncoHome(env).
    const root = mkdtempSync(join(tmpdir(), "junco-daemon-startup-safety-"));
    try {
      mkdirSync(join(root, "github-outbox"), { recursive: true });
      const cfg = makeConfig({
        dataDir: root,
        queueRoot: join(root, "queue"),
        legacy: {
          vaultRoot: false,
          stateDir: false,
          worktreeRoot: false,
          externalReposRoot: false,
          dataRoot: true, // the legacy-fallback shape P2.T5 adds
          ghConfigDir: false,
        },
      });
      expect(cfg.dataLayout).toBe("flat"); // the ruling that keeps this safe

      const stop = new StopFlag();
      const { deps } = makeDeps({
        migrateFn: migrateStateTree, // the REAL function — same one daemon.ts wires by default
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      // The old-name pair really did rename — but stayed under the SAME root.
      expect(existsSync(join(root, "outbox"))).toBe(true);
      expect(existsSync(join(root, "github-outbox"))).toBe(false);

      // Nothing was ever created at a DIFFERENT root — the v2-shaped
      // destinations flatToV2Pairs would compute (data/, cache/, logs/, or a
      // sibling ~/.junco entirely) never materialize from a startup pass.
      expect(existsSync(join(root, "data"))).toBe(false);
      expect(existsSync(join(root, "cache"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("runs ensureSkillLinks once at startup, after the data tree ensure", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    const calls: string[] = [];
    const { deps } = makeDeps({
      mkdirs: vi.fn(() => {
        calls.push("tree");
      }),
      ensureSkillLinksFn: vi.fn(() => {
        calls.push("links");
        return { entries: [] };
      }),
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(calls).toEqual(["tree", "links"]);
  });

  it("passes the frozen startup cfg to ensureSkillLinksFn", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    const ensureSkillLinksFn = vi.fn(() => ({ entries: [] }));
    const { deps } = makeDeps({
      ensureSkillLinksFn,
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(ensureSkillLinksFn).toHaveBeenCalledTimes(1);
    expect(ensureSkillLinksFn).toHaveBeenCalledWith(cfg);
  });

  it("logs the skill-link report at info only when it carries created/repaired/failure entries", async () => {
    const { log } = await import("../src/logging.js");
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const cfg = makeConfig();
      const stop = new StopFlag();
      const created = { path: "/d/skills/claude/junco-dispatch", kind: "created" as const };
      const failed = {
        path: "/d/skills",
        kind: "target-missing" as const,
        detail: "/pkg/skills",
      };
      const { deps } = makeDeps({
        ensureSkillLinksFn: vi.fn(() => ({ entries: [created, failed] })),
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      const linkLogs = infoSpy.mock.calls.filter((c) => String(c[0]) === "skill links ensured");
      expect(linkLogs).toHaveLength(1);
      expect(linkLogs[0]?.[1]).toEqual({ entries: [created, failed] });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("logs nothing for skill links when the report is all-quiet (only ok / harness-not-installed entries)", async () => {
    const { log } = await import("../src/logging.js");
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const cfg = makeConfig();
      const stop = new StopFlag();
      const { deps } = makeDeps({
        ensureSkillLinksFn: vi.fn(() => ({
          entries: [
            { path: "/d/skills/pi/junco-dispatch", kind: "ok" as const },
            { path: "/h/.codex/skills", kind: "harness-not-installed" as const },
          ],
        })),
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      const linkLogs = infoSpy.mock.calls.filter((c) => String(c[0]) === "skill links ensured");
      expect(linkLogs).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// mainLoop — provider gate wiring (Task 10)
// ---------------------------------------------------------------------------

describe("mainLoop — provider gate wiring", () => {
  it("a latched gate blocks claiming via the DEFAULT runOnceFn (serial mode): inbox untouched + pause warn logged", async () => {
    const { log } = await import("../src/logging.js");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const root = mkdtempSync(join(tmpdir(), "junco-daemon-gate-serial-"));
      const j = join(root, "Junco");
      for (const d of ["inbox", "processing", "done", "failed"]) {
        mkdirSync(join(j, d), { recursive: true });
      }
      writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
      const cfg = makeConfig({ queueRoot: j });
      const stop = new StopFlag();
      const { deps } = makeDeps({
        // Leave runOnceFn undefined so mainLoop builds its own default, which
        // is exactly the wiring under test (readyFn: gatedReady, gate).
        runOnceFn: undefined,
        gate: fakeGate("auth_error: bad key"),
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      // The ticket was never claimed — still sitting in inbox, never moved to
      // processing/.
      expect(readdirSync(join(j, "inbox"))).toHaveLength(1);
      expect(readdirSync(join(j, "processing"))).toHaveLength(0);
      const warned = warnSpy.mock.calls.some(
        (c) => String(c[0]) === "claiming paused by provider gate",
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a latched gate blocks claiming via the DEFAULT claimFn (scheduler mode, max_concurrent>1): inbox untouched + pause warn logged", async () => {
    const { log } = await import("../src/logging.js");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const root = mkdtempSync(join(tmpdir(), "junco-daemon-gate-sched-"));
      const j = join(root, "Junco");
      for (const d of ["inbox", "processing", "done", "failed"]) {
        mkdirSync(join(j, d), { recursive: true });
      }
      writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
      const cfg = makeConfig({ queueRoot: j, maxConcurrent: 2, pollIntervalSeconds: 0.001 });
      const stop = new StopFlag();
      const { deps } = makeDeps({
        // Leave claimFn/executeFn undefined so runScheduler builds its own
        // default claimFn (claimNextTask), which is threaded `readyFn: gatedReady`.
        claimFn: undefined,
        executeFn: undefined,
        gate: fakeGate("auth_error: bad key"),
        sleep: vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 1));
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      expect(readdirSync(join(j, "inbox"))).toHaveLength(1);
      expect(readdirSync(join(j, "processing"))).toHaveLength(0);
      const warned = warnSpy.mock.calls.some(
        (c) => String(c[0]) === "claiming paused by provider gate",
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs the pause warn once per gate transition, not once per poll (#180)", async () => {
    const { log } = await import("../src/logging.js");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});
    let captured: { readyFn?: () => Promise<boolean> } | undefined;
    const realRunOnce = runOnceBox.current;
    runOnceBox.current = vi.fn(
      async (_c: Config, runDeps: { readyFn?: () => Promise<boolean> }) => {
        captured = runDeps;
        return false;
      },
    );
    try {
      const cfg = makeConfig();
      const stop = new StopFlag();
      const { deps } = makeDeps({
        runOnceFn: undefined,
        gate: fakeGate("auth_error: bad key"),
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      expect(captured?.readyFn).toBeDefined();
      // Three blocked polls against the same latch: the warn fires exactly once
      // (on the ok→auth_error transition); later polls drop to debug.
      await captured!.readyFn!();
      await captured!.readyFn!();
      await captured!.readyFn!();
      const warns = warnSpy.mock.calls.filter(
        (c) => String(c[0]) === "claiming paused by provider gate",
      );
      expect(warns).toHaveLength(1);
      const debugs = debugSpy.mock.calls.filter(
        (c) => String(c[0]) === "claiming still paused by provider gate",
      );
      expect(debugs.length).toBeGreaterThanOrEqual(2);
    } finally {
      runOnceBox.current = realRunOnce;
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("wires the health server's readinessProbe to the cached probe and gateStatus to the gate", async () => {
    const cfg = makeConfig({ healthEnabled: true });
    const stop = new StopFlag();
    const handle = makeFakeHealthHandle();
    const startHealthServerFn = vi.fn(async (_opts: HealthServerOpts) => handle);
    const gate = fakeGate("auth_error: bad key");
    const { deps } = makeDeps({
      startHealthServerFn,
      gate,
      runOnceFn: vi.fn(async () => false),
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    const arg = startHealthServerFn.mock.calls[0]![0]!;
    expect(typeof arg.readinessProbe).toBe("function");
    expect(typeof arg.gateStatus).toBe("function");
    expect(arg.gateStatus!()).toEqual(gate.status());
  });

  it("wires the health server's spendStatus to the ledger + live dailyBudgetUsd (Phase-3 Task 6)", async () => {
    const cfg = makeConfig({ healthEnabled: true, dailyBudgetUsd: 7.5 });
    const stop = new StopFlag();
    const handle = makeFakeHealthHandle();
    const startHealthServerFn = vi.fn(async (_opts: HealthServerOpts) => handle);
    const spend = fakeSpend(2.25);
    const { deps } = makeDeps({
      startHealthServerFn,
      spend,
      runOnceFn: vi.fn(async () => false),
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    const arg = startHealthServerFn.mock.calls[0]![0]!;
    expect(typeof arg.spendStatus).toBe("function");
    expect(arg.spendStatus!()).toEqual({ todayUsd: 2.25, dailyBudgetUsd: 7.5 });
  });
});

// ---------------------------------------------------------------------------
// mainLoop — daily budget gate wiring (Phase 3 Task 5)
//
// gatedReady is an internal closure (not exported), so — same technique as
// the spend-ledger-wiring block below — these tests leave runOnceFn
// undefined (mainLoop builds its own default wrapping the REAL runOnce with
// `readyFn: gatedReady`) and intercept runOnceBox.current to capture the
// `readyFn` daemon.ts actually constructed. Calling that captured readyFn
// directly exercises the real budget-check + gate wiring without needing a
// real agent session to drive an actual claim through to completion.
// ---------------------------------------------------------------------------

describe("mainLoop — daily budget gate wiring (Phase 3 Task 5)", () => {
  it("dailyBudgetUsd = 0 never consults the spend ledger", async () => {
    const cfg = makeConfig({ dailyBudgetUsd: 0 });
    const stop = new StopFlag();
    const spend = {
      recordUsd: vi.fn(),
      todayUsd: vi.fn(() => 999),
      nextMidnightMs: vi.fn(() => 0),
    };
    let captured: { readyFn?: () => Promise<boolean> } | undefined;
    const realRunOnce = runOnceBox.current;
    runOnceBox.current = vi.fn(
      async (_c: Config, runDeps: { readyFn?: () => Promise<boolean> }) => {
        captured = runDeps;
        return false;
      },
    );
    try {
      const { deps } = makeDeps({
        runOnceFn: undefined,
        spend,
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      expect(captured?.readyFn).toBeDefined();
      await captured!.readyFn!();
      expect(spend.todayUsd).not.toHaveBeenCalled();
    } finally {
      runOnceBox.current = realRunOnce;
    }
  });

  it("dailyBudgetUsd exceeded blocks claiming via the DEFAULT runOnceFn, with the budget reason logged", async () => {
    const { log } = await import("../src/logging.js");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const root = mkdtempSync(join(tmpdir(), "junco-daemon-budget-serial-"));
      const j = join(root, "Junco");
      for (const d of ["inbox", "processing", "done", "failed"]) {
        mkdirSync(join(j, d), { recursive: true });
      }
      writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
      const cfg = makeConfig({ queueRoot: j, dailyBudgetUsd: 3 });
      const stop = new StopFlag();
      // A real gate (not the static fakeGate) so reportBudgetExhausted
      // actually latches state that claimBlockReason() then observes.
      const gate = new ProviderGate({ retryBackoffSeconds: 60 });
      const spend = fakeSpend(5); // 5.00 spent, cap is 3.00
      const { deps } = makeDeps({
        // Leave runOnceFn undefined so mainLoop builds its own default, which
        // is exactly the wiring under test (readyFn: gatedReady, gate, spend).
        runOnceFn: undefined,
        gate,
        spend,
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      // The ticket was never claimed — still sitting in inbox, never moved to
      // processing/.
      expect(readdirSync(join(j, "inbox"))).toHaveLength(1);
      expect(readdirSync(join(j, "processing"))).toHaveLength(0);
      const warned = warnSpy.mock.calls.some(
        (c) => String(c[0]) === "claiming paused by provider gate",
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("blocks claiming with a real ProviderGate + SpendLedger once exceeded, and resumes once BOTH the gate's until and the ledger's calendar day roll past midnight", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-daemon-budget-real-"));
    const stateDir = join(root, "state");
    const cfg = makeConfig({ dataDir: stateDir, dailyBudgetUsd: 3 });
    const stop = new StopFlag();

    // Single shared, mutable clock driving BOTH the gate's auto-expiry and
    // the ledger's local-calendar-day rollover — exactly like production,
    // where both default to the same Date.now().
    let t = new Date(2026, 0, 1, 12, 0, 0, 0).getTime(); // noon, Jan 1
    const spend = makeSpendLedger(stateDir, { now: () => t });
    spend.recordUsd(5); // over the 3.00 cap
    const gate = new ProviderGate({ retryBackoffSeconds: 60, now: () => t });

    let captured: { readyFn?: () => Promise<boolean> } | undefined;
    const realRunOnce = runOnceBox.current;
    runOnceBox.current = vi.fn(
      async (_c: Config, runDeps: { readyFn?: () => Promise<boolean> }) => {
        captured = runDeps;
        return false;
      },
    );
    try {
      const { deps } = makeDeps({
        runOnceFn: undefined,
        gate,
        spend,
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);
      expect(captured?.readyFn).toBeDefined();

      // Poll while still over budget: the gate latches to budget_exhausted
      // and claiming is blocked.
      await captured!.readyFn!();
      expect(gate.status().state).toBe("budget_exhausted");
      expect(gate.claimBlockReason()).not.toBeNull();
      // The cap is formatted with .toFixed(2), matching the spent amount's
      // formatting — "$3" (not "$3.00") would misleadingly imply the cap is
      // less precisely tracked than the spend it's being compared against.
      expect(gate.status().reason).toBe("daily budget $3.00 reached ($5.00 spent)");

      // Advance the shared clock past midnight: the ledger's calendar day
      // rolls over to 0 spent AND the gate's own `until` (next local
      // midnight) auto-expires — both driven by the same clock.
      t = new Date(2026, 0, 2, 0, 0, 1, 0).getTime();
      await captured!.readyFn!();
      expect(gate.status().state).toBe("ok");
      expect(gate.claimBlockReason()).toBeNull();
    } finally {
      runOnceBox.current = realRunOnce;
    }
  });
});

// ---------------------------------------------------------------------------
// mainLoop — spend ledger wiring (Phase 3 Task 4)
//
// There is no sessionFactoryFor seam at the daemon layer (MainLoopDeps/
// SchedulerDeps only expose abortSignal/reporter/gate/spend to the default
// runOnceFn/executeFn closures), so a real agent session can't be driven
// through mainLoop the way runOnce.test.ts/prFlow.test.ts exercise recordUsd
// end-to-end. Instead these tests intercept runOnce/executeClaimed (the
// runOnceBox/executeClaimedBox passthrough boxes declared at the top of this
// file) to inspect the deps object daemon.ts actually constructs — proving
// both the DEFAULT ledger's construction (absent deps.spend, built from
// cfg.dataDir) and its threading into both the serial and scheduler paths.
// ---------------------------------------------------------------------------

describe("mainLoop — spend ledger wiring (Phase 3 Task 4)", () => {
  // Each test below swaps runOnceBox.current/executeClaimedBox.current to a
  // spy for its own duration and restores the REAL implementation in a
  // `finally` — the boxes must stay on the real passthrough for every other
  // test in this file (see the vi.mock factory at the top).

  it("serial mode: absent deps.spend → mainLoop builds a REAL makeSpendLedger(cfg.dataDir) and threads it into the DEFAULT runOnceFn", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-daemon-spend-serial-"));
    const stateDir = join(root, "state");
    const cfg = makeConfig({ dataDir: stateDir });
    const stop = new StopFlag();
    const captured: unknown[] = [];
    const realRunOnce = runOnceBox.current;
    runOnceBox.current = vi.fn(async (_c: Config, runDeps: unknown) => {
      captured.push(runDeps);
      return false; // no work claimed — never touches the fs beyond this
    });
    try {
      const { deps } = makeDeps({
        runOnceFn: undefined,
        spend: undefined,
        sleep: vi.fn(async () => {
          stop.requestStop();
        }),
      });

      await mainLoop(cfg, stop, {}, deps);

      expect(captured).toHaveLength(1);
      const passedSpend = (captured[0] as { spend?: { recordUsd: (usd: number) => void } }).spend;
      expect(passedSpend).toBeDefined();
      expect(typeof passedSpend?.recordUsd).toBe("function");
      // Prove it's a genuinely WORKING makeSpendLedger(cfg.dataDir) instance
      // (not a stub) — record through it and read the persisted file back.
      passedSpend!.recordUsd(1.5);
      const ledger = JSON.parse(readFileSync(join(stateDir, "spend.json"), "utf8")) as {
        usd: number;
      };
      expect(ledger.usd).toBeCloseTo(1.5);
    } finally {
      runOnceBox.current = realRunOnce;
    }
  });

  it("scheduler mode (max_concurrent>1): absent deps.spend → mainLoop builds a REAL ledger and threads it into the DEFAULT executeFn", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-daemon-spend-sched-"));
    const j = join(root, "Junco");
    for (const d of ["inbox", "processing", "done", "failed"]) {
      mkdirSync(join(j, d), { recursive: true });
    }
    writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
    const stateDir = join(root, "state");
    const cfg = makeConfig({
      queueRoot: j,
      dataDir: stateDir,
      maxConcurrent: 2,
      pollIntervalSeconds: 0.001,
    });
    const stop = new StopFlag();
    const captured: unknown[] = [];
    const realExecuteClaimed = executeClaimedBox.current;
    executeClaimedBox.current = vi.fn(async (_c: Config, _w: ClaimedWork, execDeps: unknown) => {
      captured.push(execDeps);
      stop.requestStop();
    });
    try {
      const { deps } = makeDeps({
        // Leave claimFn/executeFn undefined so runScheduler builds its own
        // defaults (claimNextTask claims the real ticket above; the default
        // executeFn is exactly the wiring under test).
        claimFn: undefined,
        executeFn: undefined,
        spend: undefined,
        sleep: vi.fn(async () => {}),
      });

      await mainLoop(cfg, stop, {}, deps);

      expect(captured).toHaveLength(1);
      const passedSpend = (captured[0] as { spend?: { recordUsd: (usd: number) => void } }).spend;
      expect(passedSpend).toBeDefined();
      expect(typeof passedSpend?.recordUsd).toBe("function");
      passedSpend!.recordUsd(2.25);
      const ledger = JSON.parse(readFileSync(join(stateDir, "spend.json"), "utf8")) as {
        usd: number;
      };
      expect(ledger.usd).toBeCloseTo(2.25);
    } finally {
      executeClaimedBox.current = realExecuteClaimed;
    }
  });

  it("threads an explicitly-provided spend ledger through unchanged (no default construction) in both modes", async () => {
    const spend = fakeSpend();

    // Serial mode.
    {
      const root = mkdtempSync(join(tmpdir(), "junco-daemon-spend-explicit-serial-"));
      const cfg = makeConfig({ dataDir: join(root, "state") });
      const stop = new StopFlag();
      const captured: unknown[] = [];
      const realRunOnce = runOnceBox.current;
      runOnceBox.current = vi.fn(async (_c: Config, runDeps: unknown) => {
        captured.push(runDeps);
        return false;
      });
      try {
        const { deps } = makeDeps({
          runOnceFn: undefined,
          spend,
          sleep: vi.fn(async () => {
            stop.requestStop();
          }),
        });
        await mainLoop(cfg, stop, {}, deps);
        expect((captured[0] as { spend?: unknown }).spend).toBe(spend);
      } finally {
        runOnceBox.current = realRunOnce;
      }
    }

    // Scheduler mode.
    {
      const root = mkdtempSync(join(tmpdir(), "junco-daemon-spend-explicit-sched-"));
      const j = join(root, "Junco");
      for (const d of ["inbox", "processing", "done", "failed"]) {
        mkdirSync(join(j, d), { recursive: true });
      }
      writeFileSync(join(j, "inbox", "t.md"), "---\nid: t\n---\nq\n", "utf8");
      const cfg = makeConfig({
        queueRoot: j,
        dataDir: join(root, "state"),
        maxConcurrent: 2,
        pollIntervalSeconds: 0.001,
      });
      const stop = new StopFlag();
      const captured: unknown[] = [];
      const realExecuteClaimed = executeClaimedBox.current;
      executeClaimedBox.current = vi.fn(async (_c: Config, _w: ClaimedWork, execDeps: unknown) => {
        captured.push(execDeps);
        stop.requestStop();
      });
      try {
        const { deps } = makeDeps({
          claimFn: undefined,
          executeFn: undefined,
          spend,
          sleep: vi.fn(async () => {}),
        });
        await mainLoop(cfg, stop, {}, deps);
        expect((captured[0] as { spend?: unknown }).spend).toBe(spend);
      } finally {
        executeClaimedBox.current = realExecuteClaimed;
      }
    }
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

  it("mainLoop reads the holder each iteration (live reload reaches next runOnce)", async () => {
    const seen: number[] = [];
    const holder = makeConfigHolder({ ...makeConfig(), pollIntervalSeconds: 1 });
    const stop = new StopFlag();
    let n = 0;
    const runOnceFn = async (c: Config) => {
      seen.push(c.pollIntervalSeconds);
      if (n === 0) holder.current = { ...holder.current, pollIntervalSeconds: 99 };
      if (++n >= 2) stop.requestStop();
      return true; // handled → loop continues without sleeping to idle
    };
    await mainLoop(
      holder.current,
      stop,
      {},
      {
        configHolder: holder,
        runOnceFn,
        sleep: async () => {
          await new Promise((r) => setTimeout(r, 1));
        },
        recoverOrphansFn: () => {},
        pruneFn: () => {},
        waitForEndpointFn: async () => {},
        migrateFn: () => ({ steps: [], conflicts: [] }),
        mkdirs: () => {},
        startHealthServerFn: async () => null as unknown as HealthServerHandle,
      },
    );
    expect(seen).toEqual([1, 99]);
  });

  it("mainLoop hot-applies a live lever edit but pins a restart-kind lever to the frozen startup cfg", async () => {
    // A live edit to model.id (reload:"live") must reach the very next
    // runOnceFn; a simultaneous edit to queueRoot (reload:"restart") must
    // NEVER reach it — runOnce derives queue paths from cfg.queueRoot, so a
    // hot-applied edit there would silently move the daemon onto a different
    // (likely nonexistent) queue mid-run.
    const startCfg = makeConfig({ queueRoot: "/frozen/queue", pollIntervalSeconds: 1 });
    const holder = makeConfigHolder(startCfg);
    const stop = new StopFlag();
    const seenQueueRoots: string[] = [];
    const seenModelIds: string[] = [];
    let n = 0;
    const runOnceFn = async (c: Config) => {
      seenQueueRoots.push(c.queueRoot);
      seenModelIds.push(c.model.id);
      if (n === 0) {
        holder.current = {
          ...holder.current,
          queueRoot: "/live/queue", // restart-kind — must NOT reach the next runOnceFn
          model: { ...holder.current.model, id: "model-v2" }, // live-kind — must
        };
      }
      if (++n >= 2) stop.requestStop();
      return true; // handled → loop continues without sleeping to idle
    };
    await mainLoop(
      startCfg,
      stop,
      {},
      {
        configHolder: holder,
        runOnceFn,
        // Real macrotask tick — an instant-resolve fake sleep starves the
        // scheduler's setTimeout-based waits in other suites; mirrored here
        // for consistency even though this loop never reaches idle sleep.
        sleep: async () => {
          await new Promise((r) => setTimeout(r, 1));
        },
        recoverOrphansFn: () => {},
        pruneFn: () => {},
        waitForEndpointFn: async () => {},
        migrateFn: () => ({ steps: [], conflicts: [] }),
        mkdirs: () => {},
        startHealthServerFn: async () => null as unknown as HealthServerHandle,
      },
    );
    expect(seenModelIds).toEqual([startCfg.model.id, "model-v2"]);
    expect(seenQueueRoots).toEqual([startCfg.queueRoot, startCfg.queueRoot]);
  });

  it("writes metrics at startup and flushes on shutdown", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    const metricsWriter = { write: vi.fn(), flush: vi.fn() };
    const { deps } = makeDeps({
      metricsWriter,
      runOnceFn: vi.fn(async () => false),
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    // Once right after metrics.markStarted() at startup, once again in the
    // shutdown finally — the two unconditional flush points (Task 3).
    expect(metricsWriter.flush.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Every call carries a real snapshot (the daemon passes metrics.snapshot(),
    // never the singleton itself).
    for (const [snap] of metricsWriter.flush.mock.calls) {
      expect(snap).toMatchObject({ pid: process.pid });
    }
  });

  it("writes metrics on the poll tick", async () => {
    const cfg = makeConfig();
    const stop = new StopFlag();
    const metricsWriter = { write: vi.fn(), flush: vi.fn() };
    const { deps } = makeDeps({
      metricsWriter,
      runOnceFn: vi.fn(async () => false),
      sleep: vi.fn(async () => {
        stop.requestStop();
      }),
    });

    await mainLoop(cfg, stop, {}, deps);

    expect(metricsWriter.write).toHaveBeenCalled();
    expect(metricsWriter.write.mock.calls[0]![0]).toMatchObject({ pid: process.pid });
  });

  it("never follows a live dataDir reload to a different metrics file", async () => {
    // NOTE: this does NOT discriminate binding the writer to the frozen `cfg`
    // vs. to `activeCfg()` — activeCfg() itself runs the live holder value
    // through overlayFrozenRestartFields, which unconditionally pins dataDir
    // (and dataLayout) back to the frozen value, so activeCfg().dataDir
    // always equals cfg.dataDir inside mainLoop. On top of that,
    // MetricsWriter bakes its path into a closure at construction, so a
    // single construction site can't move mid-run regardless of which cfg
    // it reads. What this guards is the regression shape where a writer is
    // (re)constructed from a raw, un-pinned deps.configHolder.current.dataDir
    // read that bypasses overlayFrozenRestartFields entirely.
    const root = mkdtempSync(join(tmpdir(), "junco-daemon-metrics-frozen-"));
    const stateDir = join(root, "state");
    const reloadedDir = join(root, "reloaded");
    const startCfg = makeConfig({ dataDir: stateDir, pollIntervalSeconds: 1 });
    const holder = makeConfigHolder(startCfg);
    const stop = new StopFlag();
    let n = 0;
    const runOnceFn = async () => {
      if (n === 0) {
        // dataDir is restart-kind — this live edit must NOT move the metrics
        // file mid-run (see overlayFrozenRestartFields).
        holder.current = { ...holder.current, dataDir: reloadedDir };
      }
      if (++n >= 2) stop.requestStop();
      return true; // handled → loop continues without sleeping to idle
    };
    const { deps } = makeDeps({
      metricsWriter: undefined, // mainLoop builds a REAL makeMetricsWriter(cfg.dataDir)
      runOnceFn,
      sleep: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 1));
      }),
    });

    await mainLoop(startCfg, stop, {}, { ...deps, configHolder: holder });

    // Startup flush + shutdown flush both land in the FROZEN stateDir.
    const metricsPath = join(stateDir, "metrics.json");
    expect(existsSync(metricsPath)).toBe(true);
    const snap = JSON.parse(readFileSync(metricsPath, "utf8")) as { pid: number };
    expect(snap.pid).toBe(process.pid);
    // Never at the reloaded dataDir.
    expect(existsSync(join(reloadedDir, "metrics.json"))).toBe(false);
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
    const cfg = makeConfig({ queueRoot: j, maxConcurrent: 2, pollIntervalSeconds: 0.001 });
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

  it("live per-ticket cfg reaches newly-claimed tickets while the concurrency ceiling stays frozen (Fix B + Fix C)", async () => {
    // Fix B: claimFn/executeFn read `configHolder.current` each dispatch, so a
    // mid-run edit (e.g. model.id) reaches the very next claim/execute — not
    // just tickets claimed after a fresh runScheduler() call.
    // Fix C: the inner while's concurrency ceiling reads the FROZEN `cfg`
    // this scheduler was invoked with, never `configHolder.current` — a live
    // edit to worker.max_concurrent (a `reload:"restart"` lever) must NOT
    // silently widen the pool mid-run.
    const cfg = makeConfig({ maxConcurrent: 2, pollIntervalSeconds: 0.001 });
    const holder = makeConfigHolder(cfg);
    const stop = new StopFlag();
    const queue = [
      fakeWork("a", null),
      fakeWork("b", null),
      fakeWork("c", null),
      fakeWork("d", null),
      fakeWork("e", null),
    ];
    let running = 0;
    let peak = 0;
    let finished = 0;
    let mutated = false;
    const claimedModelIds: string[] = [];
    const executedModelIds: string[] = [];

    const claimFn = async (c: Config) => {
      const w = queue.shift();
      if (!w) {
        if (queue.length === 0 && running === 0) stop.requestStop();
        return null;
      }
      claimedModelIds.push(c.model.id);
      return w;
    };
    const executeFn = async (c: Config, w: ClaimedWork) => {
      executedModelIds.push(c.model.id);
      running++;
      peak = Math.max(peak, running);
      if (w.ticket.id === "a" && !mutated) {
        mutated = true;
        // Bump BOTH a live lever (model.id) and the restart-kind lever
        // (maxConcurrent) in the same edit — Fix B says the former must
        // reach the next dispatch; Fix C says the latter must not.
        holder.current = {
          ...holder.current,
          maxConcurrent: 10,
          model: { ...holder.current.model, id: "model-v2" },
        };
      }
      await new Promise((r) => setTimeout(r, w.ticket.id === "a" ? 30 : 5));
      running--;
      finished++;
    };

    await runScheduler(
      cfg,
      stop,
      {},
      { claimFn, executeFn, sleep: tickSleep, configHolder: holder },
    );

    expect(finished).toBe(5);
    expect(claimedModelIds).toHaveLength(5);
    expect(executedModelIds).toHaveLength(5);
    // Fix B: only ticket "a" (claimed/executed before the edit) saw the
    // original model id — every ticket claimed/executed after it picked up
    // the LIVE value, including "b", which was already in flight in the same
    // dispatch burst as the edit.
    expect(claimedModelIds[0]).toBe(cfg.model.id);
    expect(executedModelIds[0]).toBe(cfg.model.id);
    expect(claimedModelIds.slice(1).every((id) => id === "model-v2")).toBe(true);
    expect(executedModelIds.slice(1).every((id) => id === "model-v2")).toBe(true);
    // Fix C: holder.current.maxConcurrent became 10 mid-run, but the pool
    // never grew past the FROZEN cfg.maxConcurrent (2) runScheduler started
    // with — never more than 2 tasks ran at once.
    expect(peak).toBe(2);
  });

  it("dependency-gated claim: real claimNextTask (no claimFn stub) skips a blocked child and claims only the free ticket", async () => {
    // Honest home for this coverage: unlike every other test in this describe
    // block, claimFn is left undefined so runScheduler falls back to the real
    // claimNextTask — exercising the dependency gate (spec 2026-08-20) through
    // the actual scheduler dispatch path, not a scripted stand-in. Only
    // executeFn is stubbed (a spy), so this never touches the Pi SDK.
    const root = mkdtempSync(join(tmpdir(), "junco-daemon-dep-"));
    const j = join(root, "Junco");
    for (const d of ["inbox", "processing", "done", "failed"]) {
      mkdirSync(join(j, d), { recursive: true });
    }
    writeFileSync(
      join(j, "inbox", "blocked.md"),
      "---\nid: blocked\ndepends_on: [ghost]\n---\nBody\n",
      "utf8",
    );
    writeFileSync(join(j, "inbox", "free.md"), "---\nid: free\n---\nBody\n", "utf8");
    const cfg = makeConfig({ queueRoot: j, maxConcurrent: 2, pollIntervalSeconds: 0.001 });
    const stop = new StopFlag();
    const executed: string[] = [];
    const executeFn = async (_c: Config, w: ClaimedWork): Promise<void> => {
      executed.push(w.ticket.id);
    };
    // Stop after the first poll. A real macrotask tick, not an instant
    // resolve — sleep() is reached on every path through the poll body
    // (idle branch or the Promise.race-with-inflight branch), so calling
    // requestStop() here reliably ends the run after one pass.
    const stopAfterFirstPoll = async (): Promise<void> => {
      stop.requestStop();
      await new Promise((r) => setTimeout(r, 1));
    };
    await runScheduler(cfg, stop, {}, { executeFn, sleep: stopAfterFirstPoll });
    expect(executed).toEqual(["free"]); // the blocked child was never dispatched
    expect(readdirSync(join(j, "inbox"))).toEqual(["blocked.md"]); // still parked, unclaimed
  });

  it("writes metrics on the poll tick (Task 3, scheduler's own poll site)", async () => {
    const cfg = makeConfig({ maxConcurrent: 2, pollIntervalSeconds: 0.001 });
    const stop = new StopFlag();
    const metricsWriter = { write: vi.fn() };
    const claimFn = async () => {
      stop.requestStop();
      return null;
    };
    await runScheduler(cfg, stop, {}, { claimFn, sleep: tickSleep, metricsWriter });
    expect(metricsWriter.write).toHaveBeenCalled();
    expect(metricsWriter.write.mock.calls[0]![0]).toMatchObject({ pid: process.pid });
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
   * throttle), so these tests use a real tmp dataDir rather than a fake. */
  const tmpStateDir = (): string => mkdtempSync(join(tmpdir(), "junco-daemon-obx-"));

  it("github disabled + depth > 0: drain fn is called on the throttle cadence", async () => {
    const cfg = makeConfig({ dataDir: tmpStateDir(), github: disabledGithub(3600) });
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
    const cfg = makeConfig({ github: disabledGithub(3600) }); // no dataDir override → depth 0
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
    const cfg = makeConfig({ dataDir: tmpStateDir(), github: enabledGithub(3600) });
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
    const cfg = makeConfig({ dataDir: tmpStateDir(), github: disabledGithub(60) });
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
      dataDir: tmpStateDir(),
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

// ---------------------------------------------------------------------------
// mainLoop — dependency sweep wiring (spec 2026-08-20)
// ---------------------------------------------------------------------------

describe("dependency sweep wiring (spec 2026-08-20)", () => {
  it("serial loop runs the dep sweep each eligible tick, throttled by mergePollSeconds", async () => {
    const stop = new StopFlag();
    let polls = 0;
    const depSweepFn = vi.fn(async () => ({ stamped: 0, cascaded: 0 }));
    const { deps } = makeDeps({
      depSweepFn,
      sleep: vi.fn(async () => {
        if (++polls >= 2) stop.requestStop();
        await new Promise((r) => setTimeout(r, 1)); // real tick — scheduler-test gotcha
      }),
    });
    // Throttle window spans both polls → exactly one sweep.
    await mainLoop(makeConfig(), stop, {}, deps);
    expect(depSweepFn).toHaveBeenCalledTimes(1);
  });

  it("mergePollSeconds: 0 override sweeps every poll", async () => {
    const stop = new StopFlag();
    let polls = 0;
    const depSweepFn = vi.fn(async () => ({ stamped: 0, cascaded: 0 }));
    const { deps } = makeDeps({
      depSweepFn,
      sleep: vi.fn(async () => {
        if (++polls >= 2) stop.requestStop();
        await new Promise((r) => setTimeout(r, 1));
      }),
    });
    await mainLoop(
      makeConfig({ planSets: { enabled: false, mergePollSeconds: 0, maxTasks: 10 } }),
      stop,
      {},
      deps,
    );
    expect(depSweepFn).toHaveBeenCalledTimes(2);
  });

  it("scheduler mode (maxConcurrent > 1) also sweeps", async () => {
    const stop = new StopFlag();
    const depSweepFn = vi.fn(async () => ({ stamped: 0, cascaded: 0 }));
    const { deps } = makeDeps({
      depSweepFn,
      sleep: vi.fn(async () => {
        stop.requestStop();
        await new Promise((r) => setTimeout(r, 1));
      }),
    });
    await mainLoop(makeConfig({ maxConcurrent: 2 }), stop, {}, deps);
    expect(depSweepFn).toHaveBeenCalled();
  });

  it("a throwing sweep is contained (loop keeps polling)", async () => {
    const stop = new StopFlag();
    let polls = 0;
    const { deps } = makeDeps({
      depSweepFn: vi.fn(async () => {
        throw new Error("boom");
      }),
      sleep: vi.fn(async () => {
        if (++polls >= 2) stop.requestStop();
        await new Promise((r) => setTimeout(r, 1));
      }),
    });
    await expect(mainLoop(makeConfig(), stop, {}, deps)).resolves.toBeUndefined();
    expect(polls).toBeGreaterThanOrEqual(2);
  });
});
