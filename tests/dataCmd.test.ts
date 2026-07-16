/**
 * Tests for src/dataCmd.ts — `junco data`: a pure, read-only view of the
 * unified data tree (resolved paths, live counts, legacy-override
 * provenance, pending migrations, config deprecations). Real mkdtempSync tmp
 * roots — same pattern as tests/dataMigrateCmd.test.ts. Written FIRST (TDD).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/types.js";
import { runData } from "../src/dataCmd.js";

const tmpDirs: string[] = [];

function freshRoot(prefix = "junco-dc-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Full-Config fixture — same shape as tests/dataMigrateCmd.test.ts's makeConfig. */
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
    worktreeRoot: join(dataDir, "worktrees"),
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

/** LOCAL "YYYY-MM-DD" — same construction as src/spendLedger.ts's
 * localDateString (getFullYear/getMonth/getDate, NOT toISOString/UTC). */
function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Builds the brief's Step-1 fixture tree: 2 inbox tickets, 1 pending assess
 * JSON + 1 filed, 1 dead outbox op, absent mirror, plus a legacy
 * `assess-review/` leftover so `pendingMigrations` reports it. */
function buildFixtureTree(root: string): void {
  mkdirSync(join(root, "queue", "inbox"), { recursive: true });
  mkdirSync(join(root, "queue", "processing"), { recursive: true });
  mkdirSync(join(root, "queue", "done"), { recursive: true });
  mkdirSync(join(root, "queue", "failed"), { recursive: true });
  writeFileSync(join(root, "queue", "inbox", "one.md"), "---\npriority: normal\n---\nbody");
  writeFileSync(join(root, "queue", "inbox", "two.md"), "---\npriority: normal\n---\nbody");

  mkdirSync(join(root, "review", "assess", "filed"), { recursive: true });
  writeFileSync(
    join(root, "review", "assess", "batch1.json"),
    JSON.stringify({
      id: "batch1",
      nwo: "owner/repo",
      external: false,
      autoPlan: false,
      repoPath: "/tmp/owner-repo",
      createdAt: "2026-01-01T00:00:00Z",
      findings: [],
    }),
  );
  writeFileSync(
    join(root, "review", "assess", "filed", "batch0.json"),
    JSON.stringify({ id: "batch0" }),
  );

  // ensureDataTree eagerly creates review/comments (+ archives) too — mirror
  // that here so the "comments" node exercises the populated-but-empty path
  // rather than "(absent)".
  mkdirSync(join(root, "review", "comments", "posted"), { recursive: true });
  mkdirSync(join(root, "review", "comments", "discarded"), { recursive: true });

  mkdirSync(join(root, "outbox", "dead"), { recursive: true });
  writeFileSync(
    join(root, "outbox", "dead", "1-0000-abcd-comment.json"),
    JSON.stringify({ id: "1-0000-abcd-comment" }),
  );

  // mirror: deliberately absent — no mkdir.

  // assess-history: one per-repo history file (one .json per repo).
  mkdirSync(join(root, "assess-history"), { recursive: true });
  writeFileSync(
    join(root, "assess-history", "owner-repo.json"),
    JSON.stringify({
      id: "owner/repo",
      lastSuccessAt: "2026-07-16T00:00:00.000Z",
      lastFound: 0,
      lastParked: 0,
      lastFailureAt: null,
      lastFailureReason: null,
    }),
  );

  // Legacy pre-unification leftover: triggers pendingMigrations() for the
  // assess-review -> review/assess pair (src/dataMigrate.ts stateTreeMigrations).
  mkdirSync(join(root, "assess-review"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Text mode
// ---------------------------------------------------------------------------

describe("runData — text mode", () => {
  it("prints queue counts as '<box> <n>' per box, counting only .md files", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    const code = runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(code).toBe(0);
    expect(out).toContain("inbox 2");
    expect(out).toContain("processing 0");
    expect(out).toContain("done 0");
    expect(out).toContain("failed 0");
  });

  it("prints review/assess pending+filed counts, padded to align with 'comments'", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).toContain("assess    1 pending · 1 filed");
    expect(out).toContain("comments  0 pending · 0 posted · 0 discarded");
    expect(out).toContain("assess-history 1 repos");
  });

  it("prints the outbox dead-op count as 'dead 1', excluding the dead file from the live op count", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).toContain("dead 1");
    expect(out).toContain("ops 0");
  });

  it("marks the absent mirror directory with '(absent)'", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    expect(existsSync(join(root, "mirror"))).toBe(false);
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).toMatch(/mirror\s+\(absent\)/);
  });

  it("suffixes a legacy-overridden root with ' ← legacy override: <key>  [deprecated]'", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({
      dataDir: root,
      queueRoot: join(root, "queue"),
      legacy: { vaultRoot: true, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).toContain(" ← legacy override: vaultRoot  [deprecated]");
  });

  it("omits the legacy suffix entirely when no root is legacy-overridden", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).not.toContain("legacy override");
  });

  it("prints a final unmigrated-warning block for a pending legacy dir (assess-review/)", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).toContain(
      `⚠ unmigrated: ${join(root, "assess-review")} → ${join(root, "review", "assess")} ` +
        `(run 'junco data migrate')`,
    );
  });

  it("prints no unmigrated block when nothing legacy is pending", () => {
    const root = freshRoot();
    // A tree with none of the old pre-unification dirs present.
    mkdirSync(join(root, "queue", "inbox"), { recursive: true });
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).not.toContain("⚠ unmigrated");
  });

  it("surfaces configDeprecations() when a legacy key is set", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({
      dataDir: root,
      queueRoot: join(root, "queue"),
      legacy: { vaultRoot: true, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).toContain("deprecations:");
    expect(out).toContain("vaultRoot/juncoSubdir are deprecated");
  });

  it("prints file-count + total bytes for transcripts/", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    mkdirSync(join(root, "transcripts"), { recursive: true });
    writeFileSync(join(root, "transcripts", "t1.jsonl"), "x".repeat(500));
    writeFileSync(join(root, "transcripts", "t2.jsonl"), "x".repeat(500));
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).toContain("2 files · 1000 B");
  });

  it("prints today's USD from a spend.json dated today", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    writeFileSync(join(root, "spend.json"), JSON.stringify({ date: localToday(), usd: 3.5 }));
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).toContain("$3.50 today");
  });

  it("reports $0.00 today for a STALE spend.json (previous local day) — todayUsd semantics", () => {
    // src/spendLedger.ts read(): a non-matching date is a day rollover → 0.
    // `junco data` must agree with todayUsd(), not reprint yesterday's total.
    const root = freshRoot();
    buildFixtureTree(root);
    writeFileSync(join(root, "spend.json"), JSON.stringify({ date: "2020-01-01", usd: 42 }));
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    const out = captured.join("");
    expect(out).toContain("$0.00 today");
    expect(out).not.toContain("$42.00");
  });
});

// ---------------------------------------------------------------------------
// --json mode
// ---------------------------------------------------------------------------

describe("runData — --json mode", () => {
  it("emits parseable JSON with the same numbers as the text view", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    const code = runData(cfg, { json: true }, { printFn: (s) => captured.push(s) });
    expect(code).toBe(0);
    const parsed = JSON.parse(captured.join("")) as {
      root: string;
      paths: Record<string, unknown>;
      counts: {
        queue: { inbox: number; processing: number; done: number; failed: number };
        reviewAssess: { pending: number; filed: number };
        assessHistory: { repos: number };
        outbox: { ops: number; dead: number };
        mirror: { repos: number; files: number };
      };
      legacy: Record<string, boolean>;
      pendingMigrations: Array<{ from: string; to: string }>;
      deprecations: string[];
    };
    expect(parsed.root).toBe(root);
    expect(parsed.counts.queue.inbox).toBe(2);
    expect(parsed.counts.queue.processing).toBe(0);
    expect(parsed.counts.reviewAssess).toEqual({ pending: 1, filed: 1 });
    expect(parsed.counts.assessHistory).toEqual({ repos: 1 });
    expect(parsed.counts.outbox).toEqual({ ops: 0, dead: 1 });
    expect(parsed.counts.mirror).toEqual({ repos: 0, files: 0 });
    expect(parsed.pendingMigrations).toEqual([
      { from: join(root, "assess-review"), to: join(root, "review", "assess") },
    ]);
  });

  it("spend.json USD parity with text mode: today's value, 0 when stale", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });

    writeFileSync(join(root, "spend.json"), JSON.stringify({ date: localToday(), usd: 3.5 }));
    const fresh: string[] = [];
    runData(cfg, { json: true }, { printFn: (s) => fresh.push(s) });
    const freshParsed = JSON.parse(fresh.join("")) as { counts: { spendFile: { usd: number } } };
    expect(freshParsed.counts.spendFile.usd).toBe(3.5);

    writeFileSync(join(root, "spend.json"), JSON.stringify({ date: "2020-01-01", usd: 42 }));
    const stale: string[] = [];
    runData(cfg, { json: true }, { printFn: (s) => stale.push(s) });
    const staleParsed = JSON.parse(stale.join("")) as { counts: { spendFile: { usd: number } } };
    expect(staleParsed.counts.spendFile.usd).toBe(0);
  });

  it("reflects legacy overrides and deprecations in the JSON shape", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const cfg = makeConfig({
      dataDir: root,
      queueRoot: join(root, "queue"),
      legacy: { vaultRoot: true, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    });
    const captured: string[] = [];
    runData(cfg, { json: true }, { printFn: (s) => captured.push(s) });
    const parsed = JSON.parse(captured.join("")) as {
      legacy: { vaultRoot: boolean };
      deprecations: string[];
    };
    expect(parsed.legacy.vaultRoot).toBe(true);
    expect(parsed.deprecations.some((d) => d.includes("vaultRoot/juncoSubdir"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Purity — junco data must never mutate the filesystem
// ---------------------------------------------------------------------------

describe("runData — never mutates", () => {
  it("does not create any directory for a dataDir that does not exist yet", () => {
    const parent = freshRoot();
    const root = join(parent, "never-created");
    expect(existsSync(root)).toBe(false);
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const captured: string[] = [];
    const code = runData(cfg, { json: false }, { printFn: (s) => captured.push(s) });
    expect(code).toBe(0);
    // The root itself, and every subtree, must still be absent afterward.
    expect(existsSync(root)).toBe(false);
  });

  it("does not add/remove any file inside an existing tree (readdir snapshot unchanged)", () => {
    const root = freshRoot();
    buildFixtureTree(root);
    const before = readdirSync(join(root, "review", "assess")).sort();
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    runData(cfg, { json: false }, { printFn: () => {} });
    runData(cfg, { json: true }, { printFn: () => {} });
    const after = readdirSync(join(root, "review", "assess")).sort();
    expect(after).toEqual(before);
  });
});
