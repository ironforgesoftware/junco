/**
 * Tests for src/cli.ts — `run(argv, deps)` pure function.
 *
 * TDD for M4-T5: junco start daemon command + singleton-lock wiring.
 * All collaborators (lock, signals, mainLoop, runOnce, loadConfig) are
 * injected via CliDeps — no real fs / daemon / signals / timers.
 */

import { describe, it, expect, vi, type MockedFunction } from "vitest";
import type { Config } from "../src/types.js";
import type { SingletonLock } from "../src/lock.js";
import type { StopFlag } from "../src/daemon.js";
import { run } from "../src/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub Config — injected mainLoop / runOnce ignore it. */
function stubConfig(): Config {
  return {} as Config;
}

/** A fake SingletonLock with a spy on release(). */
function makeFakeLock(): SingletonLock & { release: ReturnType<typeof vi.fn> } {
  return {
    path: "/tmp/worker.lock",
    release: vi.fn(),
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
  const uninstallSpy = vi.fn();
  return {
    loadConfigFn: vi.fn(() => stubConfig()),
    acquireLockFn: vi.fn(() => fakeLock),
    installSignalHandlersFn: vi.fn(() => uninstallSpy),
    mainLoopFn: vi.fn(async () => {}),
    runOnceFn: vi.fn(async () => true),
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
// bare invocation → defaults to start
// ---------------------------------------------------------------------------

describe("run([]) — bare invocation defaults to start", () => {
  it("returns 0", async () => {
    const deps = makeDeps();
    expect(await run([], deps)).toBe(0);
  });

  it("calls mainLoopFn (i.e. start path)", async () => {
    const deps = makeDeps();
    await run([], deps);
    expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
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
// lock path derivation
// ---------------------------------------------------------------------------

describe("lock path derivation", () => {
  it("derives lock path as worker.lock in the config file's directory", async () => {
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({
      acquireLockFn,
      loadConfigFn: vi.fn(() => stubConfig()),
    });
    await run(["start", "--config", "/tmp/foo/config.toml"], deps);
    expect(acquireLockFn).toHaveBeenCalledWith("/tmp/foo/worker.lock");
  });

  it("uses config file directory (default config.toml → cwd/worker.lock)", async () => {
    // With the default "config.toml" relative path, the resolved directory
    // must contain worker.lock at the end.
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({ acquireLockFn });
    await run(["start"], deps);
    const [lockArg] = (acquireLockFn as MockedFunction<any>).mock.calls[0];
    expect(lockArg).toMatch(/worker\.lock$/);
  });
});
