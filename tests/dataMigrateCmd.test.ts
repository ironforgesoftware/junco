/**
 * Tests for src/dataMigrateCmd.ts — `junco data migrate` (spec 2026-07-16 §7
 * "Explicit"): explicit, opt-in full unification of the legacy vaultRoot
 * queue + state-tree subdirs + config.json legacy keys. Written FIRST (TDD).
 * Real mkdtempSync tmp roots — same pattern as tests/dataMigrate.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/types.js";
import { runDataMigrate } from "../src/dataMigrateCmd.js";
import { loadConfig } from "../src/config.js";
import { acquirePidfileLock } from "../src/pidfileLock.js";

function freshRoot(prefix = "junco-dmc-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Full-Config fixture — same shape as tests/dataMigrate.test.ts's makeConfig. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? "/tmp/vault/state";
  return {
    dataDir,
    queueRoot: join(dataDir, "queue"),
    legacy: { vaultRoot: false, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    model: {
      id: "omlx/test-model",
      source: "auto",
      baseUrlExplicit: false,
      retry: { maxRetries: null, baseDelayMs: null },
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
    endpointProbe: "auto",
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    dailyBudgetUsd: 0,
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
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    logLevel: "info",
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
      externalReposRoot: join(dataDir, "clones", "external"),
    },
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm" },
    sandbox: {
      enabled: false,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    },
    botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
    ...overrides,
  };
}

/** fetchFn stub: resolves (any status) — "the daemon is up". */
function fetchUp(): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response) as typeof fetch;
}

/** fetchFn stub: rejects — "unreachable", the daemon-down/proceed path. */
function fetchDown(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

const roots: string[] = [];
function trackRoot(r: string): string {
  roots.push(r);
  return r;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("runDataMigrate — dry-run", () => {
  it("prints the plan and performs zero renames/writes, exit 0", async () => {
    const root = trackRoot(freshRoot());
    const vaultRoot = join(root, "vault");
    mkdirSync(join(vaultRoot, "Junco", "inbox"), { recursive: true });
    writeFileSync(join(vaultRoot, "Junco", "inbox", "t1.md"), "ticket\n", "utf8");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    const rawBefore = JSON.stringify({ vaultRoot, juncoSubdir: "Junco" }, null, 2) + "\n";
    writeFileSync(configPath, rawBefore, "utf8");

    const cfg = makeConfig({
      dataDir,
      queueRoot: join(vaultRoot, "Junco"),
      legacy: { vaultRoot: true, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    });

    let renameCalls = 0;
    let writeCalls = 0;
    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: true, force: false },
      {
        fetchFn: fetchDown(),
        renameFn: () => {
          renameCalls++;
        },
        writeFileFn: () => {
          writeCalls++;
        },
        printFn: (s) => out.push(s),
      },
    );

    expect(code).toBe(0);
    expect(renameCalls).toBe(0);
    expect(writeCalls).toBe(0);
    expect(existsSync(join(vaultRoot, "Junco", "inbox", "t1.md"))).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(rawBefore);
    expect(out.join("")).toMatch(/dry-run/);
  });

  it("does not create a non-existent dataDir — a dry-run is not a run (no lock, no mkdir)", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "data"); // never created — the legacy-user case
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}", "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: true, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);
    expect(out.join("")).toMatch(/dry-run/);
    expect(existsSync(dataDir)).toBe(false);
  });
});

describe("runDataMigrate — daemon-up refusal", () => {
  it("refuses (exit 1, no actions) when /health responds — even a non-200", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}", "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    let renameCalls = 0;
    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      {
        fetchFn: fetchUp(),
        renameFn: () => {
          renameCalls++;
        },
        printFn: (s) => out.push(s),
      },
    );

    expect(code).toBe(1);
    expect(renameCalls).toBe(0);
    expect(out.join("")).toMatch(/refus/i);
    // Never even reached the lock-acquisition step.
    expect(existsSync(join(dataDir, "migrate.lock"))).toBe(false);
  });

  it("--force skips the probe entirely, even when fetchFn would report 'up'", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}", "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    let fetchCalls = 0;
    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: true },
      {
        fetchFn: (async () => {
          fetchCalls++;
          return { ok: true } as unknown as Response;
        }) as unknown as typeof fetch,
        printFn: (s) => out.push(s),
      },
    );

    expect(code).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});

describe("runDataMigrate — migration lock", () => {
  it("refuses (exit 1) when another migrate already holds the lock", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}", "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    const held = acquirePidfileLock(join(dataDir, "migrate.lock"));
    expect(held).not.toBeNull();
    try {
      const out: string[] = [];
      const code = await runDataMigrate(
        cfg,
        configPath,
        { dryRun: false, force: true },
        { printFn: (s) => out.push(s) },
      );
      expect(code).toBe(1);
      expect(out.join("")).toMatch(/another migrate is running/);
    } finally {
      held?.release();
    }
  });
});

describe("runDataMigrate — happy path (real tmp dirs, default dataDir)", () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = freshRoot("junco-dmc-home-");
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("moves the legacy queue, migrates the state tree, rewrites config.json, and round-trips via loadConfig", async () => {
    const root = trackRoot(freshRoot());
    const vaultRoot = join(root, "vault");
    mkdirSync(join(vaultRoot, "Junco", "inbox"), { recursive: true });
    writeFileSync(join(vaultRoot, "Junco", "inbox", "t1.md"), "---\nid: t1\n---\nbody\n", "utf8");
    // A state-tree subdir to exercise migrateStateTree/pendingMigrations too.
    mkdirSync(join(tmpHome, ".local", "state", "junco", "github-outbox"), { recursive: true });

    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ vaultRoot, juncoSubdir: "Junco", model: { id: "test-model" } }, null, 2) +
        "\n",
      "utf8",
    );

    const cfg = loadConfig(configPath);
    expect(cfg.legacy.vaultRoot).toBe(true);
    expect(cfg.dataDir).toBe(join(tmpHome, ".local", "state", "junco"));

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);

    // Ticket physically moved.
    expect(existsSync(join(vaultRoot, "Junco", "inbox", "t1.md"))).toBe(false);
    expect(existsSync(join(cfg.dataDir, "queue", "inbox", "t1.md"))).toBe(true);
    expect(readFileSync(join(cfg.dataDir, "queue", "inbox", "t1.md"), "utf8")).toBe(
      "---\nid: t1\n---\nbody\n",
    );

    // State tree migrated too.
    expect(existsSync(join(cfg.dataDir, "outbox"))).toBe(true);
    expect(existsSync(join(cfg.dataDir, "github-outbox"))).toBe(false);

    // config.json lost the legacy keys and gained nothing (default dataDir).
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(raw.vaultRoot).toBeUndefined();
    expect(raw.juncoSubdir).toBeUndefined();
    expect(raw.observability).toBeUndefined();
    expect(raw.dataDir).toBeUndefined();
    expect(raw.model).toEqual({ id: "test-model" }); // untouched unrelated key

    // Round-trips cleanly through the real loadConfig, legacy flags cleared.
    const reloaded = loadConfig(configPath);
    expect(reloaded.legacy.vaultRoot).toBe(false);
    expect(reloaded.queueRoot).toBe(join(cfg.dataDir, "queue"));
    expect(reloaded.dataDir).toBe(cfg.dataDir);

    expect(out.join("")).toMatch(/receipt/i);
  });
});

describe("runDataMigrate — non-default dataDir gets written explicitly", () => {
  it("rewrites observability.stateDir into a literal top-level dataDir", async () => {
    const root = trackRoot(freshRoot());
    const legacyState = join(root, "legacy-state");
    mkdirSync(legacyState, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        { observability: { stateDir: legacyState }, model: { id: "test-model" } },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const cfg = loadConfig(configPath);
    expect(cfg.legacy.stateDir).toBe(true);
    expect(cfg.dataDir).toBe(legacyState);

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(raw.observability).toBeUndefined();
    expect(raw.dataDir).toBe(legacyState);

    const reloaded = loadConfig(configPath);
    expect(reloaded.legacy.stateDir).toBe(false);
    expect(reloaded.dataDir).toBe(legacyState);
  });
});

describe("runDataMigrate — state-tree conflicts", () => {
  it("completes the non-conflicted steps, prints the conflict, then exits 1", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: true },
      {
        printFn: (s) => out.push(s),
        migrateFn: () => ({
          steps: [{ from: "a", to: "b", action: "skipped-conflict" }],
          conflicts: ["a -> b: destination already exists and is not empty"],
        }),
      },
    );

    expect(code).toBe(1);
    expect(out.join("")).toMatch(/conflict/i);
    // The config rewrite (a non-conflicted step) still completed — file stays valid JSON.
    expect(() => JSON.parse(readFileSync(configPath, "utf8"))).not.toThrow();
  });

  it("receipt is honest when migrateFn throws mid-run — journal mentioned, no 'nothing pending' claim", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: true },
      {
        printFn: (s) => out.push(s),
        migrateFn: () => {
          const e = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          e.code = "EACCES";
          throw e;
        },
      },
    );

    expect(code).toBe(1);
    const text = out.join("");
    // migrateStateTree journals completed pairs durably even when it throws
    // mid-run — the receipt must not claim "nothing pending", and must point
    // at the journal instead.
    expect(text).not.toMatch(/state tree: nothing pending/);
    expect(text).toMatch(/interrupted/);
    expect(text).toMatch(/migrated\.json/);
    expect(text).toMatch(/EACCES/);
  });
});

describe("runDataMigrate — EXDEV fallback", () => {
  it("falls back to recursive copy + per-file size verify + delete-source", async () => {
    const root = trackRoot(freshRoot());
    const vaultRoot = join(root, "vault");
    mkdirSync(join(vaultRoot, "Junco", "inbox"), { recursive: true });
    writeFileSync(join(vaultRoot, "Junco", "inbox", "t1.md"), "ticket body", "utf8");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ vaultRoot, juncoSubdir: "Junco" }), "utf8");

    const cfg = makeConfig({
      dataDir,
      queueRoot: join(vaultRoot, "Junco"),
      legacy: { vaultRoot: true, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    });

    // Only the queue-directory rename hits EXDEV; the config atomic
    // tmp+rename (same directory) proceeds via the real renameSync.
    const renameFn = (from: string, to: string): void => {
      if (to.includes(join("data", "queue"))) {
        const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      renameSync(from, to);
    };

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: true },
      { printFn: (s) => out.push(s), renameFn },
    );

    expect(code).toBe(0);
    expect(existsSync(join(vaultRoot, "Junco", "inbox"))).toBe(false); // source removed
    expect(readFileSync(join(dataDir, "queue", "inbox", "t1.md"), "utf8")).toBe("ticket body");
    expect(out.join("")).toMatch(/copied \(cross-device\)/);
  });
});

describe("runDataMigrate — unreadable config.json", () => {
  it("reports a friendly error and exits 1 rather than crashing", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json"); // never written
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: true },
      { printFn: (s) => out.push(s) },
    );

    expect(code).toBe(1);
    expect(out.join("")).toMatch(/junco data migrate:/);
    // Receipt honesty: the rewrite never happened, so the receipt must not
    // claim "no changes needed".
    expect(out.join("")).toMatch(/config\.json: not rewritten/);
    expect(out.join("")).not.toMatch(/no changes needed/);
  });
});
