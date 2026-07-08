/**
 * Tests for src/cli.ts — `run(argv, deps)` pure function.
 *
 * TDD for M4-T5: junco start daemon command + singleton-lock wiring.
 * All collaborators (lock, signals, mainLoop, runOnce, loadConfig) are
 * injected via CliDeps — no real fs / daemon / signals / timers.
 */

import { describe, it, expect, vi, type MockedFunction, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
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
      ["service", "--platform", "systemd", "--config", "/tmp/config.toml"],
      deps,
    );
    expect(code).toBe(0);
  });

  it("captured output contains [Unit]", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    await run(["service", "--platform", "systemd", "--config", "/tmp/config.toml"], deps);
    expect(captured.join("")).toContain("[Unit]");
  });

  it("captured output contains ExecStart=", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    await run(["service", "--platform", "systemd", "--config", "/tmp/config.toml"], deps);
    expect(captured.join("")).toContain("ExecStart=");
  });

  it("does NOT call mainLoopFn", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    await run(["service", "--platform", "systemd", "--config", "/tmp/config.toml"], deps);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });
});

describe("run(['service','--platform','launchd'])", () => {
  it("returns 0", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    const code = await run(
      ["service", "--platform", "launchd", "--config", "/tmp/config.toml"],
      deps,
    );
    expect(code).toBe(0);
  });

  it("captured output contains <plist", async () => {
    const captured: string[] = [];
    const deps = makeDeps({ printFn: (s) => captured.push(s) });
    await run(["service", "--platform", "launchd", "--config", "/tmp/config.toml"], deps);
    expect(captured.join("")).toContain("<plist");
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
  github: {
    enabled: false,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
  },
  assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm" },
};

let dispatchTmpDirs: string[] = [];

function freshDispatchVault(): { cfg: Config; vaultRoot: string; configPath: string } {
  const vaultRoot = mkdtempSync(join(tmpdir(), "junco-cli-dispatch-"));
  dispatchTmpDirs.push(vaultRoot);
  const cfg: Config = { ...DISPATCH_CONFIG_BASE, vaultRoot };
  // write a real config.toml so loadConfig can load it
  const configPath = join(vaultRoot, "config.toml");
  writeFileSync(configPath, `vault_root = "${vaultRoot}"\njunco_subdir = "Junco"\n`, "utf8");
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
    const wizard = vi.fn(async () => 0);
    const code = await run(["init", "--config", "/nope/config.toml"], {
      existsFn: () => false,
      runInitWizardFn: wizard,
      printFn: () => {},
    });
    expect(code).toBe(0);
    expect(wizard).toHaveBeenCalledTimes(1);
    expect(wizard.mock.calls[0][1]).toEqual({ yes: false });
  });

  it("passes --yes through to the wizard", async () => {
    const wizard = vi.fn(async () => 0);
    await run(["init", "--yes", "--config", "/nope/config.toml"], {
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
      const code = await run(["init", "--config", "/nope/config.toml"], {
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
    const code = await run(["dashboard", "--config", "/x/config.toml"], {
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
      "no watched repositories — add [[github.repos]] to config.toml or watch one from the dashboard\n",
    );
  });
});

describe("run(['restart']) — routing", () => {
  it("routes `restart` to runRestartFn with the RESOLVED config path (config validated first)", async () => {
    const { cfg } = freshDispatchVault();
    let gotPath: string | null = null;
    let loaded = false;
    const code = await run(["restart", "--config", "/x/config.toml"], {
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
    expect(gotPath).toBe("/x/config.toml");
  });

  it("a broken config aborts before the restart fn runs", async () => {
    let ran = false;
    const code = await run(["restart", "--config", "/x/config.toml"], {
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
