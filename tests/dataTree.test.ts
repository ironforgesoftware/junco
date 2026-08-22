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
import { defaultUserConfigPath, legacyConfigPath } from "../src/config.js";
import { buildPolicy, readRules } from "../src/agent/sandbox/policy.js";
import { resolveRead } from "../src/agent/sandbox/precedence.js";
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

/** The same tree in both layouts, plus the agent's cwd inside it. `flat` is the
 *  0.9 shape (daemon state and the execution roots are siblings at the root, no
 *  cache/ tier); `v2` is the single-root shape. */
const LAYOUT_FIXTURES = {
  flat: {
    root: "/sbxroot/data",
    cwd: "/sbxroot/data/worktrees/tkt-1",
    cfg: (): Config =>
      makeConfig({
        dataDir: "/sbxroot/data",
        queueRoot: "/sbxroot/data/queue",
        worktreeRoot: "/sbxroot/data/worktrees",
        dataLayout: "flat",
        github: { ...makeConfig().github, externalReposRoot: "/sbxroot/data/clones/external" },
      }),
  },
  v2: {
    root: "/sbxroot/home/.junco",
    cwd: "/sbxroot/home/.junco/cache/worktrees/tkt-1",
    cfg: (): Config =>
      makeConfig({
        dataDir: "/sbxroot/home/.junco",
        queueRoot: "/sbxroot/home/.junco/queue",
        worktreeRoot: "/sbxroot/home/.junco/cache/worktrees",
        dataLayout: "v2",
        github: {
          ...makeConfig().github,
          externalReposRoot: "/sbxroot/home/.junco/cache/clones/external",
        },
      }),
  },
} as const;

/** The read rules the AGENT actually experiences: dataTree's deny + allow-back
 *  lists threaded through buildPolicy exactly the way agent/session.ts does it.
 *  Asserting at this level (rather than on the raw deny list) is the point of
 *  #277 — a deny list that merely *looks* stricter can still widen access once
 *  longest-prefix precedence resolves it. */
function agentReadRules(cfg: Config, cwd: string) {
  const data = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
  return readRules(
    buildPolicy({
      cfg: cfg.sandbox,
      cwd,
      scratchDir: "/sbxroot/scratch",
      home: "/sbxroot/home",
      dataDenyPaths: data,
      dataAllowPaths: data.allowDirs,
      network: false,
    }),
  );
}

describe("sandboxDenyPaths", () => {
  it("denies the data root wholesale and allows the execution roots back (flat: no cache tier)", () => {
    const cfg = LAYOUT_FIXTURES.flat.cfg();
    const deny = sandboxDenyPaths(cfg);
    // #277: the root itself, not a hand-maintained enumeration of its subtrees.
    expect(deny.dirs).toContain("/sbxroot/data");
    // queueRoot stays denied as-is — a legacy vaultRoot queue lives outside the root.
    expect(deny.dirs).toContain("/sbxroot/data/queue");
    // The flat shape has no cache/ tier: worktrees/ and clones/ are allowed back
    // individually, and there is nothing to re-deny inside them.
    expect(deny.allowDirs).toContain("/sbxroot/data/worktrees");
    expect(deny.allowDirs).toContain("/sbxroot/data/clones");
    expect(deny.allowDirs).toContain("/sbxroot/data/clones/external");
    expect(deny.allowDirs).not.toContain("/sbxroot/data/cache");
    // The root receipt files stay enumerated: redundant under the root deny
    // today, but they are the guard for any layout that moves one INTO an
    // allow-back (v2 already does exactly that with cache/update-check.json).
    expect(deny.files).toContain("/sbxroot/data/watchlist.json");
    expect(deny.files).toContain("/sbxroot/data/spend.json");
    expect(deny.files).toContain("/sbxroot/data/metrics.json");
    expect(deny.files).toContain("/sbxroot/data/worker.log");
    expect(deny.files).toContain("/sbxroot/data/migrated.json");
    expect(deny.files).toContain("/sbxroot/data/migrate.lock");
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

  it("v2: denies the root, allows cache/ back, then re-denies mirror and github-cache", () => {
    const cfg = LAYOUT_FIXTURES.v2.cfg();
    const deny = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
    expect(deny.dirs).toEqual(
      expect.arrayContaining([
        "/sbxroot/home/.junco", // wholesale
        "/sbxroot/home/.junco/queue",
        "/sbxroot/home/.junco/cache/mirror", // re-denied INSIDE the allow-back
        "/sbxroot/home/.junco/cache/github-cache",
      ]),
    );
    expect(deny.allowDirs).toContain("/sbxroot/home/.junco/cache");
    // The enumerated daemon-state subtrees are gone — the root deny covers them.
    expect(deny.dirs).not.toContain("/sbxroot/home/.junco/data/outbox");
    expect(deny.dirs).not.toContain("/sbxroot/home/.junco/data/transcripts");
    expect(deny.dirs).not.toContain("/sbxroot/home/.junco/review");
    expect(deny.dirs).not.toContain("/sbxroot/home/.junco/logs");
    expect(deny.files).toContain("/sbxroot/home/.junco/config.json");
    expect(deny.files).toContain("/sbxroot/home/.junco/migrate.lock");
    // I-3 (final review 2026-08-05): the legacy XDG config path is denied
    // too, since an un-migrated machine's daemon actually reads it — the
    // ACTIVE config, not the canonical one, may hold model.apiKey.
    expect(deny.files).toContain(legacyConfigPath({ HOME: "/sbxroot/home" }));
  });

  // The security claims of #277, asserted where the agent experiences them:
  // through resolveRead() over the policy's full rule set, not over the raw
  // deny list. Built for BOTH layouts because they put the same content in
  // different places (flat has no cache/ tier at all).
  it("end-to-end: daemon state is unreadable while the agent's worktree and gitdirs stay readable", () => {
    for (const layout of ["flat", "v2"] as const) {
      const f = LAYOUT_FIXTURES[layout];
      const cfg = f.cfg();
      const p = dataTreePaths(cfg);
      const rules = agentReadRules(cfg, f.cwd);
      const effect = (path: string) => resolveRead(path, rules);

      const DENIED: [string, string][] = [
        [
          "canonical config.json (may hold model.apiKey)",
          defaultUserConfigPath({ HOME: "/sbxroot/home" }),
        ],
        ["legacy XDG config", legacyConfigPath({ HOME: "/sbxroot/home" })],
        ["config.json inside the data root", join(f.root, "config.json")],
        ["mirror", join(p.mirror, "gh/owner/repo.git/HEAD")],
        ["github-cache", join(p.githubCache, "owner__repo/issues.json")],
        ["transcripts", join(p.transcripts, "tkt-1.jsonl")],
        ["queue inbox ticket", join(p.queue.inbox, "tkt-1.md")],
        ["queue processing ticket", join(p.queue.processing, "tkt-1.md")],
        ["outbox op", join(p.outbox, "op-1.json")],
        ["review", join(p.reviewAssess, "owner__repo.json")],
        ["plan-set record", join(p.plans, "set-1.json")],
        ["task history", join(p.history, "tasks-2026-08.jsonl")],
        ["assess history", join(p.assessHistory, "owner__repo.json")],
        ["update-check cache", p.updateCheckFile],
        ["worker.log", p.logFile],
        ["watchlist", p.watchlistFile],
      ];
      for (const [what, path] of DENIED) {
        expect(effect(path), `[${layout}] ${what} must be DENIED (${path})`).toBe("deny");
      }

      const ALLOWED: [string, string][] = [
        ["the agent's own worktree", join(f.cwd, "src/index.ts")],
        ["the worktree's .git pointer", join(f.cwd, ".git")],
        ["the watched clone gitdir", join(p.clonesWatched, "owner__repo.git/objects/pack/x.pack")],
        [
          "the watched clone's linked-worktree gitdir",
          join(p.clonesWatched, "owner__repo.git/worktrees/tkt-1/commondir"),
        ],
        ["the external clone gitdir", join(p.clonesExternal, "owner__repo.git/HEAD")],
      ];
      for (const [what, path] of ALLOWED) {
        expect(effect(path), `[${layout}] ${what} must be READABLE (${path})`).toBe("allow");
      }
    }
  });

  // Drift guard (#277): the deny list is no longer a hand-maintained
  // enumeration of subtrees — it denies the data root wholesale and allows the
  // agent's execution roots back. That kills the old drift mode (`plans` joined
  // the data tree with the plan-sets work and stayed agent-readable until
  // 2026-08-21), but it creates a new one: a field placed OUTSIDE the root, or
  // INSIDE an allow-back, is readable again. So the guard now asserts each
  // field's resolved effect through the real precedence resolver, with DENY as
  // the default expectation — anything that must stay readable has to be listed
  // in READABLE with the reason. It also pins the change itself: drop the root
  // deny and every denied field below flips to "allow".
  it("classifies every data-tree entry as denied or deliberately readable", () => {
    for (const layout of ["flat", "v2"] as const) {
      const f = LAYOUT_FIXTURES[layout];
      const cfg = f.cfg();
      const paths = dataTreePaths(cfg);
      const rules = agentReadRules(cfg, f.cwd);

      // Entries that MUST stay agent-readable, with the reason they have to.
      const READABLE: Record<string, string> = {
        worktrees: "the agent's own cwd lives under it",
        clonesWatched: "git object reads from the watched clone",
        clonesExternal: "git object reads from external clones",
      };

      // `queue` is a Paths object, not a string — assert its four dirs directly
      // instead of exempting the field (the old guard skipped it entirely).
      for (const [name, dir] of Object.entries(paths.queue)) {
        expect(resolveRead(dir, rules), `[${layout}] queue.${name} must be denied`).toBe("deny");
      }

      for (const [field, value] of Object.entries(paths)) {
        if (field === "queue") continue;
        expect(
          typeof value,
          `[${layout}] DataTreePaths.${field} is new and unclassified: it must resolve "deny" under the wholesale root deny, or be listed in READABLE with the reason it must stay agent-readable`,
        ).toBe("string");
        const want = field in READABLE ? "allow" : "deny";
        expect(
          resolveRead(value as string, rules),
          `[${layout}] DataTreePaths.${field} (${String(value)}) must resolve "${want}": either it escaped the wholesale root deny (deny it, or list it in READABLE with a reason), or an allow-back no longer covers it`,
        ).toBe(want);
      }
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
