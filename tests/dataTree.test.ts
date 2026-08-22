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
import { legacyConfigPath } from "../src/config.js";
import { makeConfig as baseConfig } from "./helpers/config.js";

/** Full-Config fixture (same shape as tests/daemon.test.ts's makeConfig) —
 * only dataDir/queueRoot/worktreeRoot/github.externalReposRoot/legacy matter
 * for these tests. Defaults to the flat layout: every existing test below
 * predates the layout flip and asserts the pre-flip (flat) shape verbatim;
 * pass `{ dataLayout: "v2" }` in overrides to exercise the v2 shape. */
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
      dataLayout: "flat",
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

  it("v2 layout: data/cache/logs subtrees", () => {
    const cfg = makeConfig({
      dataDir: "/sbxroot/home/.junco",
      queueRoot: "/sbxroot/home/.junco/queue",
      dataLayout: "v2",
    });
    const p = dataTreePaths(cfg);
    expect(p.outbox).toBe("/sbxroot/home/.junco/data/outbox");
    expect(p.transcripts).toBe("/sbxroot/home/.junco/data/transcripts");
    expect(p.plans).toBe("/sbxroot/home/.junco/data/plans");
    expect(p.spendFile).toBe("/sbxroot/home/.junco/data/spend.json");
    expect(p.clonesWatched).toBe("/sbxroot/home/.junco/cache/clones/watched");
    expect(p.githubCache).toBe("/sbxroot/home/.junco/cache/github-cache");
    expect(p.updateCheckFile).toBe("/sbxroot/home/.junco/cache/update-check.json");
    expect(p.mirror).toBe("/sbxroot/home/.junco/cache/mirror");
    expect(p.logFile).toBe("/sbxroot/home/.junco/logs/worker.log");
    expect(p.logsDir).toBe("/sbxroot/home/.junco/logs");
    expect(p.queue.inbox).toBe("/sbxroot/home/.junco/queue/inbox"); // unchanged at root
    expect(p.watchlistFile).toBe("/sbxroot/home/.junco/watchlist.json");
  });

  it("flat layout keeps every 0.9 path byte-identical", () => {
    const cfg = makeConfig({ dataDir: "/sbxroot/state", dataLayout: "flat" });
    const p = dataTreePaths(cfg);
    expect(p.outbox).toBe("/sbxroot/state/outbox");
    expect(p.logFile).toBe("/sbxroot/state/worker.log");
    expect(p.updateCheckFile).toBe("/sbxroot/state/update-check.json");
  });

  it("exposes skills as <root>/skills in both layouts", () => {
    const flat = dataTreePaths(makeConfig({ dataDir: "/sbxroot/state", dataLayout: "flat" }));
    expect(flat.skills).toBe(join("/sbxroot/state", "skills"));
    const v2 = dataTreePaths(
      makeConfig({
        dataDir: "/sbxroot/home/.junco",
        queueRoot: "/sbxroot/home/.junco/queue",
        dataLayout: "v2",
      }),
    );
    expect(v2.skills).toBe(join("/sbxroot/home/.junco", "skills"));
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
    expect(deny.dirs).toContain("/sbxroot/data/plans");
    expect(deny.files).toContain("/sbxroot/data/watchlist.json");
    expect(deny.files).toContain("/sbxroot/data/spend.json");
    expect(deny.files).toContain("/sbxroot/data/metrics.json");
    expect(deny.files).toContain("/sbxroot/data/worker.log");
    expect(deny.files).toContain("/sbxroot/data/migrated.json");
    expect(deny.files).toContain("/sbxroot/data/migrate.lock");
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
      legacy: {
        vaultRoot: true,
        stateDir: false,
        worktreeRoot: false,
        externalReposRoot: false,
        dataRoot: false,
        ghConfigDir: false,
      },
    });
    expect(sandboxDenyPaths(cfg).dirs).toContain("/sbxroot/vault/Junco");
  });

  it("denies the daemon-private subtrees, the config file, and logs — never cache/ or the root", () => {
    const cfg = makeConfig({
      dataDir: "/sbxroot/home/.junco",
      queueRoot: "/sbxroot/home/.junco/queue",
      dataLayout: "v2",
    });
    const deny = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
    expect(deny.dirs).toEqual(
      expect.arrayContaining([
        "/sbxroot/home/.junco/queue",
        "/sbxroot/home/.junco/review",
        "/sbxroot/home/.junco/data/outbox",
        "/sbxroot/home/.junco/data/transcripts",
        "/sbxroot/home/.junco/data/plans",
        "/sbxroot/home/.junco/cache/github-cache",
        "/sbxroot/home/.junco/cache/mirror",
        "/sbxroot/home/.junco/logs",
      ]),
    );
    expect(deny.files).toContain("/sbxroot/home/.junco/config.json");
    expect(deny.files).toContain("/sbxroot/home/.junco/migrate.lock");
    // I-3 (final review 2026-08-05): the legacy XDG config path is denied
    // too, since an un-migrated machine's daemon actually reads it — the
    // ACTIVE config, not the canonical one, may hold model.apiKey.
    expect(deny.files).toContain(legacyConfigPath({ HOME: "/sbxroot/home" }));
    // never an ancestor of the agent's writable roots (backend.ts:42-53 invariant):
    for (const d of deny.dirs) {
      expect("/sbxroot/home/.junco/cache/worktrees".startsWith(d + "/")).toBe(false);
      expect("/sbxroot/home/.junco/cache/clones".startsWith(d + "/")).toBe(false);
    }
    expect(deny.dirs).not.toContain("/sbxroot/home/.junco");
    expect(deny.dirs).not.toContain("/sbxroot/home/.junco/cache");
  });

  // Drift guard (#277): sandboxDenyPaths is a hand-maintained enumeration —
  // it cannot simply deny the root, because the agent's own cwd
  // (cache/worktrees) and git object reads (cache/clones) live under it. That
  // makes it prone to silent omission: `plans` joined the data tree with the
  // plan-sets work and stayed agent-readable until 2026-08-21. This test fails
  // when a NEW DataTreePaths field is neither denied nor listed as exempt, so
  // the choice has to be made deliberately rather than forgotten.
  it("classifies every data-tree entry as denied or deliberately exempt", () => {
    const cfg = makeConfig({
      dataDir: "/sbxroot/home/.junco",
      queueRoot: "/sbxroot/home/.junco/queue",
      worktreeRoot: "/sbxroot/home/.junco/cache/worktrees",
      dataLayout: "v2",
      github: {
        ...makeConfig().github,
        externalReposRoot: "/sbxroot/home/.junco/cache/clones/external",
      },
    });
    const paths = dataTreePaths(cfg);
    const deny = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
    const denied = [...deny.dirs, ...deny.files];

    // Each entry must stay agent-READABLE, with the reason it has to.
    const EXEMPT: Record<string, string> = {
      root: "CRITICAL invariant: ancestor of the agent's writable roots",
      queue: "not a path (Paths object) — denied via cfg.queueRoot",
      worktrees: "the agent's own cwd",
      clonesWatched: "git object reads from the watched clone",
      clonesExternal: "git object reads from external clones",
      skills:
        "symlink to the INSTALLED PACKAGE's public skills/ dir — canonicalize() " +
        "realpaths it, so a deny here would land on the junco install, not the data tree",
    };

    const covered = (v: string) => denied.some((d) => v === d || v.startsWith(d + "/"));

    for (const [field, value] of Object.entries(paths)) {
      if (field in EXEMPT) continue;
      expect(
        typeof value,
        `DataTreePaths.${field} is new and unclassified: deny it in sandboxDenyPaths, or add it to EXEMPT with the reason it must stay agent-readable`,
      ).toBe("string");
      expect(
        covered(value as string),
        `DataTreePaths.${field} (${String(value)}) is neither denied nor exempt — deny it in sandboxDenyPaths, or add it to EXEMPT with the reason it must stay agent-readable`,
      ).toBe(true);
    }
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

  it("mkdirs logs/ under a v2 layout so the first log write never races the directory", () => {
    const made: string[] = [];
    const cfg = makeConfig({
      dataDir: "/sbxroot/home/.junco",
      queueRoot: "/sbxroot/home/.junco/queue",
      dataLayout: "v2",
    });
    ensureDataTree(cfg, { mkdirFn: (d) => made.push(d), existsFn: () => false, writeFn: () => {} });
    expect(made).toContain("/sbxroot/home/.junco/logs");
  });

  it("does NOT create legacy-overridden roots outside dataDir", () => {
    const made: string[] = [];
    const cfg = makeConfig({
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/elsewhere/Junco",
      legacy: {
        vaultRoot: true,
        stateDir: false,
        worktreeRoot: false,
        externalReposRoot: false,
        dataRoot: false,
        ghConfigDir: false,
      },
    });
    ensureDataTree(cfg, { mkdirFn: (d) => made.push(d), existsFn: () => false, writeFn: () => {} });
    expect(made).toContain("/sbxroot/elsewhere/Junco/inbox"); // queue is still ensured (daemon needs it)
    expect(made.some((d) => d.startsWith("/sbxroot/data/queue"))).toBe(false); // but not a phantom default queue
  });
});
