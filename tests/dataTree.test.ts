/**
 * Tests for src/dataTree.ts — the single source of truth for the unified data
 * tree's shape (spec 2026-07-16 §4): dataTreePaths derives every subdir from
 * Config, and ensureDataTree materializes the whole tree eagerly with a
 * self-gitignoring root. Written FIRST (TDD).
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Config } from "../src/types.js";
import { dataTreePaths, ensureDataTree, sandboxDenyPaths } from "../src/dataTree.js";
import { makeConfig as baseConfig } from "./helpers/config.js";

/** Full-Config fixture (same shape as tests/daemon.test.ts's makeConfig) —
 * only dataDir/queueRoot/worktreeRoot/github.externalReposRoot/legacy matter
 * for these tests. */
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
      healthPort: 0, // never binds (healthEnabled: false), so claim no real port
      planLintBlockOnError: true,
      planLintCheckLabels: true,
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

describe("dataTreePaths", () => {
  it("derives every path from dataDir and honors legacy-overridable roots", () => {
    const cfg = makeConfig({
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/data/queue",
      worktreeRoot: "/sbxroot/wt-legacy",
    });
    const p = dataTreePaths(cfg);
    expect(p.root).toBe("/sbxroot/data");
    expect(p.queue.inbox).toBe("/sbxroot/data/queue/inbox");
    expect(p.reviewAssess).toBe("/sbxroot/data/review/assess");
    expect(p.reviewComments).toBe("/sbxroot/data/review/comments");
    expect(p.outbox).toBe("/sbxroot/data/outbox");
    expect(p.mirror).toBe("/sbxroot/data/mirror");
    expect(p.clonesWatched).toBe("/sbxroot/data/clones/watched");
    expect(p.worktrees).toBe("/sbxroot/wt-legacy"); // legacy override respected
    expect(p.assessHistory).toBe("/sbxroot/data/assess-history");
    expect(p.history).toBe("/sbxroot/data/history");
    expect(p.transcripts).toBe("/sbxroot/data/transcripts");
    expect(p.watchlistFile).toBe("/sbxroot/data/watchlist.json");
    expect(p.migratedFile).toBe("/sbxroot/data/migrated.json");
    expect(p.migrateLockFile).toBe("/sbxroot/data/migrate.lock");
  });

  it("registers update-check.json at the root and denies it to the sandbox", () => {
    const cfg = makeConfig({ dataDir: "/sbxroot/data", queueRoot: "/sbxroot/data/queue" });
    const p = dataTreePaths(cfg);
    expect(p.updateCheckFile).toBe("/sbxroot/data/update-check.json");
    expect(sandboxDenyPaths(cfg).files).toContain(p.updateCheckFile);
  });

  it("exposes githubCache and logsDir (flat: logs at the root)", () => {
    const cfg = makeConfig({ dataDir: "/sbxroot/state" });
    const p = dataTreePaths(cfg);
    expect(p.githubCache).toBe("/sbxroot/state/github-cache");
    expect(p.logsDir).toBe("/sbxroot/state");
    expect(p.logFile).toBe(join(p.logsDir, "worker.log"));
  });
});

describe("sandboxDenyPaths", () => {
  it("denies the daemon-state subtrees and root receipt files, never worktrees/ or clones/", () => {
    const cfg = makeConfig({
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/data/queue",
      worktreeRoot: "/sbxroot/data/worktrees",
      github: { ...makeConfig().github, externalReposRoot: "/sbxroot/data/clones/external" },
    });
    const deny = sandboxDenyPaths(cfg);
    expect(deny.dirs).toContain("/sbxroot/data/queue");
    expect(deny.dirs).toContain("/sbxroot/data/review");
    expect(deny.dirs).toContain("/sbxroot/data/outbox");
    expect(deny.dirs).toContain("/sbxroot/data/mirror");
    expect(deny.dirs).toContain("/sbxroot/data/assess-history");
    expect(deny.dirs).toContain("/sbxroot/data/history");
    expect(deny.dirs).toContain("/sbxroot/data/transcripts");
    expect(deny.dirs).toContain("/sbxroot/data/github-cache");
    expect(deny.files).toContain("/sbxroot/data/watchlist.json");
    expect(deny.files).toContain("/sbxroot/data/spend.json");
    expect(deny.files).toContain("/sbxroot/data/metrics.json");
    expect(deny.files).toContain("/sbxroot/data/worker.log");
    expect(deny.files).toContain("/sbxroot/data/migrated.json");
    // The agent's own execution roots stay readable: never the dataDir root,
    // never worktrees/ (the agent's cwd lives there), never clones/.
    const all = [...deny.dirs, ...deny.files];
    expect(all).not.toContain("/sbxroot/data");
    expect(all.some((p) => p.startsWith("/sbxroot/data/worktrees"))).toBe(false);
    expect(all.some((p) => p.startsWith("/sbxroot/data/clones"))).toBe(false);
  });

  it("denies the legacy vault queue root when vaultRoot is set (tickets are sensitive wherever they live)", () => {
    const cfg = makeConfig({
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/vault/Junco",
      legacy: { vaultRoot: true, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    });
    expect(sandboxDenyPaths(cfg).dirs).toContain("/sbxroot/vault/Junco");
  });
});

describe("ensureDataTree", () => {
  it("mkdirs the full tree incl. archives/dead and writes the * gitignore once", () => {
    const made: string[] = [];
    const writes: Record<string, string> = {};
    const existing = new Set<string>();
    const deps = {
      mkdirFn: (d: string) => made.push(d),
      existsFn: (p: string) => existing.has(p),
      writeFn: (p: string, s: string) => {
        writes[p] = s;
      },
    };
    const cfg = makeConfig({ dataDir: "/sbxroot/data", queueRoot: "/sbxroot/data/queue" });
    ensureDataTree(cfg, deps);
    for (const d of [
      "/sbxroot/data/queue/inbox",
      "/sbxroot/data/queue/processing",
      "/sbxroot/data/queue/done",
      "/sbxroot/data/queue/failed",
      "/sbxroot/data/review/assess/filed",
      "/sbxroot/data/review/comments/posted",
      "/sbxroot/data/review/comments/discarded",
      "/sbxroot/data/outbox/dead",
      "/sbxroot/data/mirror",
      "/sbxroot/data/clones/watched",
      "/sbxroot/data/assess-history",
      "/sbxroot/data/history",
      "/sbxroot/data/transcripts",
    ])
      expect(made).toContain(d);
    expect(writes["/sbxroot/data/.gitignore"]).toBe("*\n");
    // second run with the gitignore present: no rewrite
    existing.add("/sbxroot/data/.gitignore");
    const before = Object.keys(writes).length;
    ensureDataTree(cfg, deps);
    expect(Object.keys(writes).length).toBe(before);
  });

  it("does NOT create legacy-overridden roots outside dataDir", () => {
    const made: string[] = [];
    const cfg = makeConfig({
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/elsewhere/Junco",
      legacy: { vaultRoot: true, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    });
    ensureDataTree(cfg, { mkdirFn: (d) => made.push(d), existsFn: () => false, writeFn: () => {} });
    expect(made).toContain("/sbxroot/elsewhere/Junco/inbox"); // queue is still ensured (daemon needs it)
    expect(made.some((d) => d.startsWith("/sbxroot/data/queue"))).toBe(false); // but not a phantom default queue
  });
});
