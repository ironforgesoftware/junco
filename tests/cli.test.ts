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
import { run } from "../src/cli.js";
import type { CliDeps } from "../src/cli.js";
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
  const uninstallSpy = vi.fn();
  return {
    loadConfigFn: vi.fn(() => stubConfig()),
    acquireLockFn: vi.fn(() => fakeLock),
    installSignalHandlersFn: vi.fn(() => uninstallSpy),
    mainLoopFn: vi.fn(async () => {}),
    runOnceFn: vi.fn(async () => true),
    // Never touch a real fs.watch — the stub config path may not exist on disk.
    watchConfigFn: vi.fn(() => ({ close: vi.fn() })),
    // stubConfig() returns `{}` — no botAccount — so the real withBotAuth
    // would throw reading `.enabled` off undefined. Default to a no-op
    // pass-through; tests that care about bot-auth wiring override it.
    withBotAuthFn: vi.fn(async (c: Config) => c),
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
  it("derives lock path as worker.lock in the resolved config directory (env-driven, not --config)", async () => {
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({
      acquireLockFn,
      loadConfigFn: vi.fn(() => stubConfig()),
      env: { HOME: "/tmp/foo" },
    });
    await run(["start"], deps);
    expect(acquireLockFn).toHaveBeenCalledWith(join("/tmp/foo", ".junco", "worker.lock"));
  });

  it("uses the resolved config directory (env-only default, no cwd probe)", async () => {
    // No cwd probe left: with no config on disk, resolution lands on the
    // canonical ~/.junco/config.json for the injected HOME.
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({ acquireLockFn, env: { HOME: "/tmp/junco-default-home" } });
    await run(["start"], deps);
    expect(acquireLockFn).toHaveBeenCalledWith(
      join("/tmp/junco-default-home", ".junco", "worker.lock"),
    );
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

function freshDispatchVault(): { cfg: Config; vaultRoot: string; configPath: string } {
  const vaultRoot = mkdtempSync(join(tmpdir(), "junco-cli-dispatch-"));
  dispatchTmpDirs.push(vaultRoot);
  const cfg: Config = {
    ...DISPATCH_CONFIG_BASE,
    dataDir: vaultRoot,
    queueRoot: join(vaultRoot, "Junco"),
  };
  // write a real config.json at the canonical ~/.junco/config.json location
  // (HOME=vaultRoot for these tests) so loadConfig can load it.
  const configPath = join(vaultRoot, ".junco", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ vaultRoot, juncoSubdir: "Junco" }), "utf8");
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
