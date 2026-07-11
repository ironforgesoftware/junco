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
import { join } from "node:path";
import type { Config } from "../src/types.js";
import type { SingletonLock } from "../src/lock.js";
import { run } from "../src/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub Config — injected mainLoop / runOnce ignore it. */
function stubConfig(): Config {
  return {} as Config;
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
      loadConfigFn: vi.fn(() => ({ healthEnabled: true, healthHost: "0.0.0.0" }) as Config),
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
      loadConfigFn: vi.fn(() => ({ healthEnabled: true, healthHost: "127.0.0.1" }) as Config),
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
      loadConfigFn: vi.fn(() => ({ healthEnabled: true, healthHost: "" }) as Config),
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
// bare invocation → defaults to start
// ---------------------------------------------------------------------------

describe("run([]) — first-run aware bare invocation", () => {
  it("starts the daemon when a config already exists", async () => {
    const deps = makeDeps({ existsFn: () => true });
    expect(await run([], deps)).toBe(0);
    expect(deps.mainLoopFn).toHaveBeenCalledTimes(1);
  });

  it("runs the setup wizard (not start) when no config exists", async () => {
    const wizard = vi.fn(async () => 0);
    const deps = makeDeps({ existsFn: () => false, runInitWizardFn: wizard });
    expect(await run([], deps)).toBe(0);
    expect(wizard).toHaveBeenCalledTimes(1);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
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
// service subcommand
// ---------------------------------------------------------------------------

describe("run(['service','--platform','systemd'])", () => {
  it("returns 0", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    const code = await run(
      ["service", "--platform", "systemd", "--config", "/tmp/config.json"],
      deps,
    );
    expect(code).toBe(0);
  });

  it("captured output contains [Unit]", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    await run(["service", "--platform", "systemd", "--config", "/tmp/config.json"], deps);
    expect(captured.join("")).toContain("[Unit]");
  });

  it("captured output contains ExecStart=", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    await run(["service", "--platform", "systemd", "--config", "/tmp/config.json"], deps);
    expect(captured.join("")).toContain("ExecStart=");
  });

  it("does NOT call mainLoopFn", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    await run(["service", "--platform", "systemd", "--config", "/tmp/config.json"], deps);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });
});

describe("run(['service','--platform','launchd'])", () => {
  it("returns 0", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    const code = await run(
      ["service", "--platform", "launchd", "--config", "/tmp/config.json"],
      deps,
    );
    expect(code).toBe(0);
  });

  it("captured output contains <plist", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    await run(["service", "--platform", "launchd", "--config", "/tmp/config.json"], deps);
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
      vaultRoot: dir,
      juncoSubdir: "",
      defaultTimeoutMinutes: 30,
    } as unknown as Config;
    const deps = makeDeps({ printFn: (s) => captured.push(s), loadConfigFn: () => cfg });
    try {
      await run(["service", "--platform", "systemd", "--config", join(dir, "config.json")], deps);
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
      vaultRoot: dir,
      juncoSubdir: "",
      defaultTimeoutMinutes: 30,
    } as unknown as Config;
    const deps = makeDeps({ printFn: (s) => captured.push(s), loadConfigFn: () => cfg });
    try {
      await run(["service", "--platform", "systemd", "--config", join(dir, "config.json")], deps);
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
  it("derives lock path as worker.lock in the config file's directory", async () => {
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({
      acquireLockFn,
      loadConfigFn: vi.fn(() => stubConfig()),
    });
    await run(["start", "--config", "/tmp/foo/config.json"], deps);
    expect(acquireLockFn).toHaveBeenCalledWith("/tmp/foo/worker.lock");
  });

  it("uses config file directory (default config.json → cwd/worker.lock)", async () => {
    // With the default "config.json" relative path, the resolved directory
    // must contain worker.lock at the end.
    const acquireLockFn = vi.fn(() => makeFakeLock());
    const deps = makeDeps({ acquireLockFn });
    await run(["start"], deps);
    const [lockArg] = (acquireLockFn as MockedFunction<any>).mock.calls[0];
    expect(lockArg).toMatch(/worker\.lock$/);
  });
});

// ---------------------------------------------------------------------------
// Dispatch CLI subcommands — M6-T2
// ---------------------------------------------------------------------------

/**
 * Full Config object satisfying all required fields for tests that touch the
 * real FS (inbox-path, submit, init).  vaultRoot is overridden per test.
 */
const DISPATCH_CONFIG_BASE: Omit<Config, "vaultRoot"> = {
  juncoSubdir: "Junco",
  model: {
    id: "test-model",
    modelsJson: null,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "test",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 49152,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevel: "medium",
    compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
  },
  tools: ["read"],
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
  verifyEnabled: false,
  verifyCommandTimeout: 60,
  verifyBlockOnFail: false,
  planLintEnabled: false,
  planLintBlockOnError: false,
  planLintCheckLabels: false,
  commitLeftoversEnabled: false,
  criticEnabled: false,
  criticMaxRetries: 1,
  criticThinking: "minimal",
  healthEnabled: false,
  healthHost: "127.0.0.1",
  healthPort: 8787,
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
  sandbox: {
    enabled: false,
    backend: "auto",
    network: "deny",
    extraDenyRead: [],
    extraAllowWrite: [],
  },
};

let dispatchTmpDirs: string[] = [];

function freshDispatchVault(): { cfg: Config; vaultRoot: string; configPath: string } {
  const vaultRoot = mkdtempSync(join(tmpdir(), "junco-cli-dispatch-"));
  dispatchTmpDirs.push(vaultRoot);
  const cfg: Config = { ...DISPATCH_CONFIG_BASE, vaultRoot };
  // write a real config.json so loadConfig can load it
  const configPath = join(vaultRoot, "config.json");
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

describe("run(['inbox-path', '--config', p])", () => {
  it("returns 0", async () => {
    const { configPath } = freshDispatchVault();
    const captured: string[] = [];
    const code = await run(["inbox-path", "--config", configPath], {
      printFn: (s) => captured.push(s),
    });
    expect(code).toBe(0);
  });

  it("prints output ending with /inbox\\n", async () => {
    const { configPath } = freshDispatchVault();
    const captured: string[] = [];
    await run(["inbox-path", "--config", configPath], {
      printFn: (s) => captured.push(s),
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

describe("run(['submit', '-', '--config', p]) — stdin", () => {
  const TICKET_CONTENT = `---\nid: cli-stdin-test\npriority: normal\n---\n\n# Test ticket\n`;

  it("returns 0", async () => {
    const { configPath } = freshDispatchVault();
    const captured: string[] = [];
    const code = await run(["submit", "-", "--config", configPath], {
      printFn: (s) => captured.push(s),
      readStdinFn: async () => TICKET_CONTENT,
    });
    expect(code).toBe(0);
  });

  it("prints 'submitted: ...'", async () => {
    const { configPath } = freshDispatchVault();
    const captured: string[] = [];
    await run(["submit", "-", "--config", configPath], {
      printFn: (s) => captured.push(s),
      readStdinFn: async () => TICKET_CONTENT,
    });
    expect(captured.join("")).toMatch(/submitted:/);
  });

  it("the ticket lands in the inbox", async () => {
    const { configPath, vaultRoot } = freshDispatchVault();
    const captured: string[] = [];
    await run(["submit", "-", "--config", configPath], {
      printFn: (s) => captured.push(s),
      readStdinFn: async () => TICKET_CONTENT,
    });
    const expected = join(vaultRoot, "Junco", "inbox", "cli-stdin-test.md");
    expect(existsSync(expected)).toBe(true);
  });
});

// --- submit (no file arg) ---

describe("run(['submit']) — missing file argument", () => {
  it("returns 2", async () => {
    const { configPath } = freshDispatchVault();
    const captured: string[] = [];
    const code = await run(["submit", "--config", configPath], {
      printFn: (s) => captured.push(s),
    });
    expect(code).toBe(2);
  });
});

// --- init ---

describe("run(['init', '--config', p])", () => {
  it("returns 0", async () => {
    const { configPath } = freshDispatchVault();
    const captured: string[] = [];
    const code = await run(["init", "--config", configPath], {
      printFn: (s) => captured.push(s),
    });
    expect(code).toBe(0);
  });

  it("creates the four queue dirs under the vault", async () => {
    const { configPath, vaultRoot } = freshDispatchVault();
    await run(["init", "--config", configPath], {
      printFn: () => {},
    });
    for (const dir of ["inbox", "processing", "done", "failed"]) {
      expect(existsSync(join(vaultRoot, "Junco", dir))).toBe(true);
    }
  });

  it("prints a summary mentioning dirs", async () => {
    const { configPath } = freshDispatchVault();
    const captured: string[] = [];
    await run(["init", "--config", configPath], {
      printFn: (s) => captured.push(s),
    });
    const out = captured.join("");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("run(['init']) — wizard routing", () => {
  it("runs the wizard when no config exists (and passes yes:false)", async () => {
    const wizard = vi.fn(async (_configPath: string, _opts: { yes?: boolean }) => 0);
    const code = await run(["init", "--config", "/nope/config.json"], {
      existsFn: () => false,
      runInitWizardFn: wizard,
      printFn: () => {},
    });
    expect(code).toBe(0);
    expect(wizard).toHaveBeenCalledTimes(1);
    expect(wizard.mock.calls[0][1]).toEqual({ yes: false });
  });

  it("passes --yes through to the wizard", async () => {
    const wizard = vi.fn(async (_configPath: string, _opts: { yes?: boolean }) => 0);
    await run(["init", "--yes", "--config", "/nope/config.json"], {
      existsFn: () => false,
      runInitWizardFn: wizard,
      printFn: () => {},
    });
    expect(wizard.mock.calls[0][1]).toEqual({ yes: true });
  });

  it("does NOT overwrite an existing config (ensure-dirs only)", async () => {
    const { configPath, vaultRoot } = freshDispatchVault(); // config present
    const before = readFileSync(configPath, "utf8");
    const wizard = vi.fn(async () => 0);
    const code = await run(["init", "--config", configPath], {
      runInitWizardFn: wizard,
      printFn: () => {},
    });
    expect(code).toBe(0);
    expect(wizard).not.toHaveBeenCalled();
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(existsSync(join(vaultRoot, "Junco", "inbox"))).toBe(true);
  });

  it("guards a non-TTY first run (no askFn / wizard / --yes) and writes nothing", async () => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const code = await run(["init", "--config", "/nope/config.json"], {
        existsFn: () => false,
        printFn: () => {},
      });
      expect(code).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origTTY, configurable: true });
    }
  });
});

describe("run(['dashboard']) — routing", () => {
  it("routes `dashboard` to runDashboardFn with the loaded config", async () => {
    const { cfg } = freshDispatchVault(); // the file's existing full-Config helper
    let got: Config | null = null;
    const code = await run(["dashboard", "--config", "/x/config.json"], {
      loadConfigFn: () => cfg,
      runDashboardFn: async (c) => {
        got = c;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(got).not.toBeNull();
  });
});

describe("run(['outbox'])", () => {
  it("returns 0 and prints 'outbox empty' when nothing is queued", async () => {
    const { cfg, configPath, vaultRoot } = freshDispatchVault();
    const cfgWithState: Config = { ...cfg, stateDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["outbox", "--config", configPath], {
      loadConfigFn: () => cfgWithState,
      printFn: (s) => captured.push(s),
    });
    expect(code).toBe(0);
    expect(captured.join("")).toBe("outbox empty\n");
  });

  it("routes `outbox flush` to the flush path (exit 0 on a clean flush of nothing)", async () => {
    const { cfg, configPath, vaultRoot } = freshDispatchVault();
    const cfgWithState: Config = { ...cfg, stateDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["outbox", "flush", "--config", configPath], {
      loadConfigFn: () => cfgWithState,
      printFn: (s) => captured.push(s),
    });
    expect(code).toBe(0);
    expect(captured.join("")).toMatch(/sent 0 · dead 0 · remaining 0/);
  });
});

describe("run(['prs'])", () => {
  it("returns 0 and prints the no-watched-repos guidance when none are configured", async () => {
    const { cfg, configPath, vaultRoot } = freshDispatchVault();
    const cfgWithState: Config = { ...cfg, stateDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["prs", "--config", configPath], {
      loadConfigFn: () => cfgWithState,
      printFn: (s) => captured.push(s),
    });
    expect(code).toBe(0);
    expect(captured.join("")).toBe(
      "no watched repositories — add github.repos to config.json or watch one from the dashboard\n",
    );
  });
});

describe("run(['assess']) — routing", () => {
  it("routes `assess <path> --auto-plan` to runAssessCommand, threading the flag into the queued ticket", async () => {
    const { cfg, configPath, vaultRoot } = freshDispatchVault();
    const repoDir = mkdtempSync(join(tmpdir(), "junco-cli-assess-repo-"));
    const cfgWithState: Config = { ...cfg, stateDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["assess", repoDir, "--auto-plan", "--config", configPath], {
      loadConfigFn: () => cfgWithState,
      printFn: (s) => captured.push(s),
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
    const { cfg, configPath, vaultRoot } = freshDispatchVault();
    const cfgWithState: Config = { ...cfg, stateDir: join(vaultRoot, "state") };
    const captured: string[] = [];
    const code = await run(["assess", "--config", configPath], {
      loadConfigFn: () => cfgWithState,
      printFn: (s) => captured.push(s),
    });
    expect(code).toBe(2);
    expect(captured.join("")).toMatch(/usage/i);
  });
});

describe("run(['restart']) — routing", () => {
  it("routes `restart` to runRestartFn with the RESOLVED config path (config validated first)", async () => {
    const { cfg } = freshDispatchVault();
    let gotPath: string | null = null;
    let loaded = false;
    const code = await run(["restart", "--config", "/x/config.json"], {
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
    expect(gotPath).toBe("/x/config.json");
  });

  it("a broken config aborts before the restart fn runs", async () => {
    let ran = false;
    const code = await run(["restart", "--config", "/x/config.json"], {
      loadConfigFn: () => {
        throw new Error("bad toml");
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
