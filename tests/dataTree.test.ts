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
import {
  defaultUserConfigPath,
  legacyConfigPath,
  configPathOverride,
  resolveConfigPath,
} from "../src/config.js";
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

  it("exposes chats and chatDrafts in both layouts (spec 2026-09-01 §1.1)", () => {
    const flat = dataTreePaths(makeConfig({ dataDir: "/sbxroot/data" }));
    expect(flat.chats).toBe("/sbxroot/data/chats");
    expect(flat.chatDrafts).toBe("/sbxroot/data/chat-drafts");
    const v2 = dataTreePaths(makeConfig({ dataDir: "/sbxroot/home/.junco", dataLayout: "v2" }));
    expect(v2.chats).toBe("/sbxroot/home/.junco/data/chats");
    expect(v2.chatDrafts).toBe("/sbxroot/home/.junco/data/chat-drafts");
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

  it("v2: denies the root and allows back the clones/worktrees depth, not the cache/ tier", () => {
    const cfg = LAYOUT_FIXTURES.v2.cfg();
    const deny = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
    expect(deny.dirs).toEqual(
      expect.arrayContaining([
        "/sbxroot/home/.junco", // wholesale
        "/sbxroot/home/.junco/queue",
        "/sbxroot/home/.junco/cache/mirror",
        "/sbxroot/home/.junco/cache/github-cache",
      ]),
    );
    // #311: the allow-back stops at clones/. `cache/` itself is NOT allowed
    // back — it holds `cache/update-check.json`, a deny FILE, and bwrap cannot
    // mask a file that does not exist yet, so buildPolicy refuses an allow
    // above one. Nothing else in `cache/` needs an allow-back: worktrees comes
    // in by name below, mirror/github-cache/update-check.json stay covered by
    // the wholesale root deny on every backend.
    expect(deny.allowDirs).toContain("/sbxroot/home/.junco/cache/clones");
    expect(deny.allowDirs).not.toContain("/sbxroot/home/.junco/cache");
    expect(deny.allowDirs).toContain("/sbxroot/home/.junco/cache/worktrees");
    // Layer 2 (final review 2026-08-22): the daemon-state subtrees are ALSO
    // denied at their own depth, so a mis-set allow-back pointed at a whole
    // tier can't out-specify them. The root deny is what covers anything not
    // listed; these are what survive an allow-back moving.
    expect(deny.dirs).toEqual(
      expect.arrayContaining([
        "/sbxroot/home/.junco/data/outbox",
        "/sbxroot/home/.junco/data/transcripts",
        "/sbxroot/home/.junco/data/plans",
        "/sbxroot/home/.junco/data/history",
        "/sbxroot/home/.junco/data/assess-history",
        "/sbxroot/home/.junco/review/assess",
        "/sbxroot/home/.junco/review/comments",
        "/sbxroot/home/.junco/logs",
        "/sbxroot/home/.junco/queue/inbox",
      ]),
    );
    // …but the agent's execution roots are never denied by name — they are
    // allow-backs, and a Layer-2 entry for one would be self-defeating.
    expect(deny.dirs).not.toContain("/sbxroot/home/.junco/cache/clones/watched");
    expect(deny.dirs).not.toContain("/sbxroot/home/.junco/cache/worktrees");
    expect(deny.dirs).not.toContain("/sbxroot/home/.junco/skills"); // see sandboxDenyPaths' doc comment
    expect(deny.files).toContain("/sbxroot/home/.junco/config.json");
    expect(deny.files).toContain("/sbxroot/home/.junco/migrate.lock");
    // I-3 (final review 2026-08-05): the legacy XDG config path is denied
    // too, since an un-migrated machine's daemon actually reads it — the
    // ACTIVE config, not the canonical one, may hold model.apiKey.
    expect(deny.files).toContain(legacyConfigPath({ HOME: "/sbxroot/home" }));
  });

  it("denies the ACTIVE config under a JUNCO_CONFIG override — it may hold model.apiKey (#275)", () => {
    const cfg = makeConfig({
      dataDir: "/sbxroot/home/.junco",
      queueRoot: "/sbxroot/home/.junco/queue",
      dataLayout: "v2",
    });
    const env = { HOME: "/sbxroot/home", JUNCO_CONFIG: "/srv/junco/ci.json" };
    const deny = sandboxDenyPaths(cfg, env);
    // Seatbelt is broadly `(allow file-read*)` with named denies, so an
    // un-denied override is an outright agent-readable API key.
    expect(deny.files).toContain("/srv/junco/ci.json");
    // The two fixed paths stay denied — the override is an addition, never a
    // replacement (a machine can be mid-migration under an override too).
    expect(deny.files).toContain("/sbxroot/home/.junco/config.json");
    expect(deny.files).toContain(legacyConfigPath(env));
    // The deny list must be the SAME spelling resolveConfigPath uses: two
    // independent spellings of the override would drift, and a drift here is
    // a silently readable model.apiKey. Pinned against a tilde value, where a
    // naive `env.JUNCO_CONFIG` would leak an unexpanded "~/ci.json".
    const tildeEnv = { HOME: "/sbxroot/home", JUNCO_CONFIG: "~/ci.json" };
    expect(sandboxDenyPaths(cfg, tildeEnv).files).toContain(
      resolveConfigPath({ existsFn: () => true, env: tildeEnv }),
    );
    expect(sandboxDenyPaths(cfg, tildeEnv).files).toContain(configPathOverride(tildeEnv));
    // No override: nothing extra, and certainly no undefined in the list.
    const plain = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
    expect(plain.files).toEqual(deny.files.filter((f) => f !== "/srv/junco/ci.json"));
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

  // Final review 2026-08-22 (I-2), reproduced verbatim: `allowDirs` re-allows
  // git.worktreeRoot / github.externalReposRoot BY NAME (both are legacy-
  // overridable and may sit inside the root but outside the tier that covers
  // them), so an operator who points either at v2's whole `data/` tier creates
  // an allow-back that out-specifies any deny living only at the root. The
  // pre-#277 enumeration kept those subtrees denied under exactly this
  // configuration; the Layer-2 denies are what keep that true now.
  const V2_ROOT = "/sbxroot/home/.junco";
  const v2With = (overrides: Partial<Config>): Config =>
    makeConfig({
      dataDir: V2_ROOT,
      queueRoot: join(V2_ROOT, "queue"),
      worktreeRoot: join(V2_ROOT, "cache/worktrees"),
      dataLayout: "v2",
      github: {
        ...makeConfig().github,
        externalReposRoot: join(V2_ROOT, "cache/clones/external"),
      },
      ...overrides,
    });

  // The `data/` tier holds `data/spend.json` and `data/metrics.json`, both
  // written lazily — so an allow-back over it is the #311 shape, and since the
  // guard landed the policy is refused instead of quietly meaning three
  // different things on three backends. The Layer-2 denies below still cover
  // the DIRECTORY half of I-2; this covers the file half.
  it("a legacy override pointed at the v2 data/ tier is refused, not silently accepted", () => {
    const misset: [string, Config][] = [
      ["git.worktreeRoot", v2With({ worktreeRoot: join(V2_ROOT, "data") })],
      [
        "github.externalReposRoot",
        v2With({ github: { ...makeConfig().github, externalReposRoot: join(V2_ROOT, "data") } }),
      ],
    ];
    for (const [key, cfg] of misset) {
      expect(
        () => agentReadRules(cfg, join(V2_ROOT, "data", "tkt-1")),
        `${key} = <root>/data must be refused: it is an allow-back above the spend/metrics receipts`,
      ).toThrow(/is an ancestor of denied file/);
    }
  });

  // Final review 2026-08-22 (I-2), reproduced verbatim: `allowDirs` re-allows
  // git.worktreeRoot / github.externalReposRoot BY NAME (both are legacy-
  // overridable and may sit inside the root but outside the tier that covers
  // them), so an operator who points either at a whole tier creates an
  // allow-back that out-specifies any deny living only at the root. The
  // pre-#277 enumeration kept those subtrees denied under exactly this
  // configuration; the Layer-2 denies are what keep that true now. Pointed at
  // `review/` rather than `data/` because that tier holds only DIRECTORIES —
  // #311 refuses an allow-back over a tier holding a receipt file outright, and
  // this test is about what happens when the policy is buildable.
  it("a legacy override pointed at a whole v2 tier cannot re-expose daemon state", () => {
    const misset: [string, Config][] = [
      ["git.worktreeRoot", v2With({ worktreeRoot: join(V2_ROOT, "review") })],
      [
        "github.externalReposRoot",
        v2With({ github: { ...makeConfig().github, externalReposRoot: join(V2_ROOT, "review") } }),
      ],
    ];

    for (const [key, cfg] of misset) {
      const p = dataTreePaths(cfg);
      // The agent's cwd as that misconfiguration would actually place it.
      const rules = agentReadRules(cfg, join(V2_ROOT, "review", "tkt-1"));
      const DENIED: [string, string][] = [
        ["assess review queue", join(p.reviewAssess, "owner__repo.json")],
        ["comment review queue", join(p.reviewComments, "owner__repo.json")],
        ["transcripts", join(p.transcripts, "tkt-1.jsonl")],
        ["plan-set record", join(p.plans, "set-1.json")],
        ["outbox op", join(p.outbox, "op-1.json")],
        ["task history", join(p.history, "tasks-2026-08.jsonl")],
        ["assess history", join(p.assessHistory, "owner__repo.json")],
        ["spend receipt", p.spendFile],
      ];
      for (const [what, path] of DENIED) {
        expect(
          resolveRead(path, rules),
          `${key} = <root>/review must not re-expose ${what} (${path})`,
        ).toBe("deny");
      }
      // The tier itself IS allowed back — that is the operator's stated intent,
      // and the point of the fix is that it costs them only what they asked for.
      expect(resolveRead(join(V2_ROOT, "review", "tkt-1", "src/a.ts"), rules)).toBe("allow");
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

  // #311, the machine-checked replacement for a hand-maintained invariant.
  // "Never put a deny FILE inside an allow-back" used to be upheld by prose
  // (sandboxDenyPaths' doc comment carried it as an ACCEPTED RESIDUAL for v2's
  // cache/update-check.json) — the exact class of thing #277 existed to
  // retire. buildPolicy now refuses such a policy, so the guard here is that
  // no layout hands it one: the allow-backs stay at the clones/worktrees depth
  // and never widen to a tier that holds a receipt.
  it("never allows back a tier that contains a denied file", () => {
    for (const layout of ["flat", "v2"] as const) {
      const f = LAYOUT_FIXTURES[layout];
      const cfg = f.cfg();
      const { files, allowDirs } = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
      for (const file of files) {
        for (const allow of allowDirs) {
          expect(
            file.startsWith(allow + "/"),
            `[${layout}] ${file} is denied but sits inside the allow-back ${allow} — bwrap ` +
              `cannot mask a file that does not exist yet, so it would be readable there`,
          ).toBe(false);
        }
      }
      // …and the policy the agent actually gets is therefore constructible.
      expect(() => agentReadRules(cfg, f.cwd)).not.toThrow();
    }
  });

  it("denies the chat session store and parked drafts by name in both layouts", () => {
    for (const dataLayout of ["flat", "v2"] as const) {
      const cfg = makeConfig({
        dataDir: "/sbxroot/data",
        queueRoot: "/sbxroot/data/queue",
        dataLayout,
      });
      const p = dataTreePaths(cfg);
      const { dirs } = sandboxDenyPaths(cfg);
      expect(dirs).toContain(p.chats);
      expect(dirs).toContain(p.chatDrafts);
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

  // Final review 2026-08-22 (I-1). github-cache was created lazily on the TUI's
  // first cache write (tui/ghClient.ts), against this module's own eager-tree
  // invariant — and under v2 it was a DENY target sitting inside the then-
  // `cache/` allow-back, so on a tree where the TUI had never cached anything
  // bwrap skipped its tmpfs (it skips a deny whose target is absent) while
  // `cache/` stayed ro-bound: opening the TUI mid-run put token-fetched GitHub
  // data in the agent's readable view. #311 narrowed that allow-back to
  // `cache/clones`, so the root deny covers this path again — the eager mkdir
  // is still required for any tier a legacy override allows back by name.
  it("materializes github-cache eagerly in both layouts (it is a deny target, not a lazy cache)", () => {
    const madeFor = (cfg: Config): string[] => {
      const made: string[] = [];
      ensureDataTree(cfg, {
        mkdirFn: (d) => made.push(d),
        existsFn: () => false,
        writeFn: () => {},
      });
      return made;
    };
    expect(
      madeFor(makeConfig({ dataDir: "/sbxroot/data", queueRoot: "/sbxroot/data/queue" })),
    ).toContain("/sbxroot/data/github-cache");
    expect(
      madeFor(
        makeConfig({
          dataDir: "/sbxroot/home/.junco",
          queueRoot: "/sbxroot/home/.junco/queue",
          dataLayout: "v2",
        }),
      ),
    ).toContain("/sbxroot/home/.junco/cache/github-cache");
  });

  it("materializes chats and the chat-drafts archives eagerly (deny targets, never lazy)", () => {
    const made: string[] = [];
    const deps = {
      mkdirFn: (d: string) => made.push(d),
      existsFn: () => false,
      writeFn: () => {},
    };
    ensureDataTree(
      makeConfig({ dataDir: "/sbxroot/data", queueRoot: "/sbxroot/data/queue" }),
      deps,
    );
    expect(made).toContain("/sbxroot/data/chats");
    expect(made).toContain("/sbxroot/data/chat-drafts/submitted");
    expect(made).toContain("/sbxroot/data/chat-drafts/discarded");
  });

  // The general form of I-1, so the next deny that moves inside an allow-back
  // can't reintroduce it: a deny whose target is absent is SKIPPED by bwrap
  // (agent/sandbox/backend.ts — it cannot create a mountpoint under the ro root
  // bind), which is only harmless while the wholesale root tmpfs still covers
  // the path. A deny DIRECTORY inside an allow-back has lost that cover, so it
  // must exist at spawn time — i.e. ensureDataTree has to materialize it.
  // (The deny FILE case has no such repair — see #311 — and buildPolicy refuses
  // the shape outright instead; tests/sandboxPolicy.test.ts owns that half.)
  //
  // The two shipped layouts no longer nest a deny inside an allow-back at all
  // since #311 moved v2's allow-back down to `cache/clones`, so the third case
  // is what keeps this non-vacuous: a legacy override pointed at the whole
  // `review/` tier, which is buildable (that tier holds only directories) and
  // is exactly the configuration this invariant exists for.
  it("materializes every deny target that sits inside an allow-back", () => {
    let checked = 0;
    const cases: [string, Config][] = [
      ["flat", LAYOUT_FIXTURES.flat.cfg()],
      ["v2", LAYOUT_FIXTURES.v2.cfg()],
      [
        "v2 + worktreeRoot=<root>/review",
        makeConfig({
          dataDir: "/sbxroot/home/.junco",
          queueRoot: "/sbxroot/home/.junco/queue",
          worktreeRoot: "/sbxroot/home/.junco/review",
          dataLayout: "v2",
          github: {
            ...makeConfig().github,
            externalReposRoot: "/sbxroot/home/.junco/cache/clones/external",
          },
        }),
      ],
    ];
    for (const [label, cfg] of cases) {
      const made: string[] = [];
      ensureDataTree(cfg, {
        mkdirFn: (d) => made.push(d),
        existsFn: () => false,
        writeFn: () => {},
      });
      const { dirs, allowDirs } = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
      const insideAnAllowBack = dirs.filter((d) =>
        allowDirs.some((a) => d === a || d.startsWith(a + "/")),
      );
      for (const d of insideAnAllowBack) {
        checked++;
        // `made` records the literal mkdir argument and every mkdir is
        // recursive, so a deny dir is materialized either directly or by a
        // deeper archive under it (review/assess ← review/assess/filed).
        expect(
          made.some((m) => m === d || m.startsWith(d + "/")),
          `[${label}] ${d} is denied INSIDE an allow-back but ensureDataTree never creates it — bwrap would skip its mount while it is absent`,
        ).toBe(true);
      }
    }
    // Non-vacuity: the review/ override nests reviewAssess + reviewComments.
    expect(checked).toBeGreaterThanOrEqual(2);
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
