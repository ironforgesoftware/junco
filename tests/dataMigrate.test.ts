/**
 * Tests for src/dataMigrate.ts — journaled, idempotent, in-place migration of
 * old-name state subdirs into the unified data tree (spec 2026-07-16 §7).
 * Written FIRST (TDD). Real mkdtempSync tmp roots — same pattern as
 * tests/dataTree.test.ts / other repo fs-touching suites.
 */

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/types.js";
import {
  migrateStateTree,
  pendingMigrations,
  stateTreeMigrations,
  flatToV2Pairs,
  migrationTargetRoot,
  dataRootPairs,
  pendingConfigRelocation,
} from "../src/dataMigrate.js";
import { makeConfig as baseConfig } from "./helpers/config.js";
import { dataTreePaths } from "../src/dataTree.js";
import { rewritePath } from "../src/migratePathRewrite.js";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "junco-dm-"));
}

/** Full-Config fixture (same shape as tests/daemon.test.ts's makeConfig), but
 * — unlike that fixture — derives queueRoot/github.externalReposRoot from
 * dataDir by default, matching real resolveConfig's non-legacy behavior: this
 * suite's migrations only make sense relative to a single tmp-root dataDir,
 * so "external" must default to "<dataDir>/clones/external" rather than an
 * unrelated fixed path. Callers still override either field wholesale via
 * `overrides`. Defaults to the flat layout: migrateStateTree's whole purpose
 * is moving a pre-existing (pre-flip) old-name tree into dataTree.ts's
 * current names — every fixture below builds that flat old-name tree. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? "/tmp/vault/state";
  return baseConfig(
    {
      dataDir,
      queueRoot: join(dataDir, "queue"),
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
        externalReposRoot: join(dataDir, "clones", "external"),
      },
      botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
      ...overrides,
    },
  );
}

const base = makeConfig();

describe("migrateStateTree", () => {
  it("renames every old-name subdir into the new tree and journals", () => {
    const root = freshRoot();
    mkdirSync(join(root, "assess-review", "filed"), { recursive: true });
    writeFileSync(join(root, "assess-review", "a.json"), "{}");
    mkdirSync(join(root, "github-outbox", "dead"), { recursive: true });
    mkdirSync(join(root, "repos", "o", "r"), { recursive: true });
    mkdirSync(join(root, "external", "o2"), { recursive: true });
    mkdirSync(join(root, "comment-review"), { recursive: true });
    writeFileSync(join(root, "github-watchlist.json"), "[]");
    const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
    expect(existsSync(join(root, "review/assess/a.json"))).toBe(true);
    expect(existsSync(join(root, "review/assess/filed"))).toBe(true);
    expect(existsSync(join(root, "outbox/dead"))).toBe(true);
    expect(existsSync(join(root, "clones/watched/o/r"))).toBe(true);
    expect(existsSync(join(root, "clones/external/o2"))).toBe(true);
    expect(existsSync(join(root, "review/comments"))).toBe(true);
    expect(existsSync(join(root, "watchlist.json"))).toBe(true);
    expect(existsSync(join(root, "assess-review"))).toBe(false);
    expect(res.conflicts).toEqual([]);
    const journal = JSON.parse(readFileSync(join(root, "migrated.json"), "utf8"));
    expect(journal.steps.filter((s: { action: string }) => s.action === "renamed").length).toBe(6);
  });

  it("is idempotent — a second run is all noops", () => {
    const root = freshRoot();
    mkdirSync(join(root, "github-outbox"), { recursive: true });
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    migrateStateTree(cfg);
    const res2 = migrateStateTree(cfg);
    expect(res2.steps.every((s) => s.action === "noop")).toBe(true);
  });

  it("empty destination is removed and the rename proceeds (crash-after-mkdir)", () => {
    const root = freshRoot();
    mkdirSync(join(root, "assess-review"), { recursive: true });
    writeFileSync(join(root, "assess-review", "a.json"), "{}");
    mkdirSync(join(root, "review", "assess"), { recursive: true }); // empty dst
    const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
    expect(existsSync(join(root, "review/assess/a.json"))).toBe(true);
    expect(res.conflicts).toEqual([]);
  });

  it("recursively-empty nested dst scaffolding (ensureDataTree's own tree) is repaired", () => {
    // The real-world shape: ensureDataTree materialized the NEW tree (nested,
    // dirs only) while the old-name dir still holds the data — e.g. a version
    // rollback or an old CLI writing post-upgrade. A flat-emptiness check
    // sees review/assess containing "filed" and declares a permanent
    // conflict; the fix treats a dst with zero FILES anywhere as repairable.
    const root = freshRoot();
    mkdirSync(join(root, "assess-review"), { recursive: true });
    writeFileSync(join(root, "assess-review", "a.json"), "{}");
    mkdirSync(join(root, "review", "assess", "filed"), { recursive: true }); // nested, file-free
    mkdirSync(join(root, "comment-review"), { recursive: true });
    writeFileSync(join(root, "comment-review", "draft.json"), "{}");
    mkdirSync(join(root, "review", "comments", "posted"), { recursive: true });
    mkdirSync(join(root, "review", "comments", "discarded"), { recursive: true });
    const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
    expect(res.conflicts).toEqual([]);
    expect(existsSync(join(root, "review/assess/a.json"))).toBe(true);
    expect(existsSync(join(root, "review/comments/draft.json"))).toBe(true);
    expect(existsSync(join(root, "assess-review"))).toBe(false);
    expect(existsSync(join(root, "comment-review"))).toBe(false);
    // The empty scaffolding was replaced wholesale by the renamed src (which
    // held no filed/posted dirs) — nothing fabricates them back here.
    expect(existsSync(join(root, "review/assess/filed"))).toBe(false);
  });

  it("nested dst with ONE file anywhere inside → skipped-conflict, nothing destroyed", () => {
    const root = freshRoot();
    mkdirSync(join(root, "comment-review"), { recursive: true });
    writeFileSync(join(root, "comment-review", "draft.json"), "{}");
    mkdirSync(join(root, "review", "comments", "posted"), { recursive: true });
    writeFileSync(join(root, "review", "comments", "posted", "deep.json"), "{}");
    const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
    expect(res.conflicts).toHaveLength(1);
    expect(existsSync(join(root, "comment-review", "draft.json"))).toBe(true);
    expect(existsSync(join(root, "review", "comments", "posted", "deep.json"))).toBe(true);
  });

  it("non-empty both sides → skipped-conflict, nothing destroyed", () => {
    const root = freshRoot();
    mkdirSync(join(root, "assess-review"), { recursive: true });
    writeFileSync(join(root, "assess-review", "old.json"), "{}");
    mkdirSync(join(root, "review", "assess"), { recursive: true });
    writeFileSync(join(root, "review", "assess", "new.json"), "{}");
    const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
    expect(res.conflicts).toHaveLength(1);
    expect(existsSync(join(root, "assess-review/old.json"))).toBe(true);
    expect(existsSync(join(root, "review/assess/new.json"))).toBe(true);
  });

  it("watchlist file→file conflict: dst exists alone → skipped-conflict (no empty-dir repair)", () => {
    const root = freshRoot();
    writeFileSync(join(root, "github-watchlist.json"), '["old"]');
    writeFileSync(join(root, "watchlist.json"), '["new"]');
    const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
    const step = res.steps.find((s) => s.from.endsWith("github-watchlist.json"));
    expect(step?.action).toBe("skipped-conflict");
    expect(res.conflicts).toHaveLength(1);
    expect(readFileSync(join(root, "watchlist.json"), "utf8")).toBe('["new"]');
    expect(existsSync(join(root, "github-watchlist.json"))).toBe(true);
  });

  it("src missing → noop, dst untouched", () => {
    const root = freshRoot();
    mkdirSync(join(root, "review", "assess"), { recursive: true });
    writeFileSync(join(root, "review", "assess", "keep.json"), "{}");
    const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
    const step = res.steps.find((s) => s.to.endsWith("review/assess"));
    expect(step?.action).toBe("noop");
    expect(existsSync(join(root, "review/assess/keep.json"))).toBe(true);
  });

  it("legacy-overridden subtrees are excluded from the migration list", () => {
    const root = freshRoot();
    const cfg = makeConfig({
      dataDir: root,
      queueRoot: join(root, "queue"),
      github: { ...base.github, externalReposRoot: "/sbxroot/custom-ext" },
      legacy: {
        vaultRoot: false,
        stateDir: false,
        worktreeRoot: false,
        externalReposRoot: true,
        dataRoot: false,
        ghConfigDir: false,
      },
    });
    expect(pendingMigrations(cfg).some((m) => m.from.endsWith("/external"))).toBe(false);
    expect(stateTreeMigrations(cfg).some((m) => m.from.endsWith("/external"))).toBe(false);
  });

  it("journal accumulates across separate migration runs (append, not overwrite)", () => {
    const root = freshRoot();
    mkdirSync(join(root, "github-outbox"), { recursive: true });
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    migrateStateTree(cfg); // renames github-outbox -> outbox
    // Simulate a later, separate legacy directory appearing (e.g. an operator
    // restoring an old backup) and a second migration run picking it up.
    mkdirSync(join(root, "comment-review"), { recursive: true });
    migrateStateTree(cfg); // renames comment-review -> review/comments
    const journal = JSON.parse(readFileSync(join(root, "migrated.json"), "utf8"));
    const renamed = journal.steps.filter((s: { action: string }) => s.action === "renamed");
    expect(renamed.length).toBe(2);
    expect(renamed.some((s: { from: string }) => s.from.endsWith("github-outbox"))).toBe(true);
    expect(renamed.some((s: { from: string }) => s.from.endsWith("comment-review"))).toBe(true);
  });

  it("does not re-append an identical skipped-conflict on every run (startup would grow the journal forever)", () => {
    const root = freshRoot();
    // A permanent conflict: files on both sides.
    mkdirSync(join(root, "assess-review"), { recursive: true });
    writeFileSync(join(root, "assess-review", "old.json"), "{}");
    mkdirSync(join(root, "review", "assess"), { recursive: true });
    writeFileSync(join(root, "review", "assess", "new.json"), "{}");
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    migrateStateTree(cfg);
    migrateStateTree(cfg);
    migrateStateTree(cfg);
    const journal = JSON.parse(readFileSync(join(root, "migrated.json"), "utf8"));
    const conflicts = journal.steps.filter(
      (s: { action: string }) => s.action === "skipped-conflict",
    );
    expect(conflicts).toHaveLength(1); // journaled once, not once per startup
  });

  it("never journals routine noops — a from-scratch dataDir with nothing to migrate writes no journal", () => {
    const root = freshRoot();
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const res = migrateStateTree(cfg);
    expect(res.steps.every((s) => s.action === "noop")).toBe(true);
    expect(existsSync(join(root, "migrated.json"))).toBe(false);
  });

  it("journals steps completed before a mid-run fs error (receipts survive the throw)", () => {
    const root = freshRoot();
    // First pair (assess-review) will rename cleanly; the third pair
    // (github-outbox) hits a simulated EACCES mid-run. The filesystem stays
    // consistent (rename is atomic, the failed pair is left in place), but
    // the receipt for the pair that DID move must still land in
    // migrated.json — on the next run its src is gone, so the step resolves
    // to "noop" and the journal entry could never be back-filled.
    mkdirSync(join(root, "assess-review"), { recursive: true });
    writeFileSync(join(root, "assess-review", "a.json"), "{}");
    mkdirSync(join(root, "github-outbox"), { recursive: true });
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const boom = (from: string, to: string): void => {
      if (from.endsWith("github-outbox")) {
        const e = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      }
      renameSync(from, to);
    };
    expect(() => migrateStateTree(cfg, { renameFn: boom })).toThrow(/EACCES/);
    // The first pair really did move on disk before the throw...
    expect(existsSync(join(root, "review/assess/a.json"))).toBe(true);
    expect(existsSync(join(root, "github-outbox"))).toBe(true); // failed pair untouched
    // ...and its receipt survived the aborted run.
    const journal = JSON.parse(readFileSync(join(root, "migrated.json"), "utf8"));
    const renamed = journal.steps.filter((s: { action: string }) => s.action === "renamed");
    expect(renamed).toHaveLength(1);
    expect(renamed[0].from.endsWith("assess-review")).toBe(true);
  });

  it("a journal-write failure after a migration error does not mask the original error (#197.1)", () => {
    const root = freshRoot();
    // assess-review renames cleanly (one completed step to journal), then
    // github-outbox's rename throws — and the finally's journal write throws too.
    mkdirSync(join(root, "assess-review"), { recursive: true });
    writeFileSync(join(root, "assess-review", "a.json"), "{}");
    mkdirSync(join(root, "github-outbox"), { recursive: true });
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const boom = (from: string, to: string): void => {
      if (from.endsWith("github-outbox")) throw new Error("ORIGINAL migration error");
      renameSync(from, to);
    };
    const writeBoom = (): void => {
      throw new Error("JOURNAL write error");
    };
    const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    expect(() =>
      migrateStateTree(cfg, {
        renameFn: boom,
        writeFileFn: writeBoom,
        logFn: (msg, fields) => logged.push({ msg, fields }),
      }),
    ).toThrow("ORIGINAL migration error"); // NOT the journal error
    expect(logged).toHaveLength(1);
    expect(logged[0].msg).toMatch(/journal write failed/);
    expect(String(logged[0].fields?.error)).toMatch(/JOURNAL write error/);
  });

  it("a journal-write failure on the clean path still propagates (#197.1)", () => {
    const root = freshRoot();
    mkdirSync(join(root, "github-outbox"), { recursive: true }); // renames cleanly
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const writeBoom = (): void => {
      throw new Error("JOURNAL write error");
    };
    const logged: string[] = [];
    expect(() =>
      migrateStateTree(cfg, { writeFileFn: writeBoom, logFn: (m) => logged.push(m) }),
    ).toThrow("JOURNAL write error"); // no in-flight error to preserve → propagate
    expect(logged).toHaveLength(0); // not swallowed-and-logged
  });

  it("corrupt journal is treated as fresh rather than thrown", () => {
    const root = freshRoot();
    writeFileSync(join(root, "migrated.json"), "{ not json");
    mkdirSync(join(root, "github-outbox"), { recursive: true });
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    expect(() => migrateStateTree(cfg)).not.toThrow();
    const journal = JSON.parse(readFileSync(join(root, "migrated.json"), "utf8"));
    expect(journal.version).toBe(1);
    expect(journal.steps.filter((s: { action: string }) => s.action === "renamed").length).toBe(1);
  });
});

describe("stateTreeMigrations", () => {
  it("lists all 6 pairs when nothing is legacy-overridden", () => {
    const cfg = makeConfig({ dataDir: "/sbxroot/data", queueRoot: "/sbxroot/data/queue" });
    expect(stateTreeMigrations(cfg)).toHaveLength(6);
  });
});

describe("flatToV2Pairs", () => {
  it("maps the whole flat tree; in-place skips identity pairs", () => {
    const cross = flatToV2Pairs("/old", "/new");
    expect(cross).toContainEqual({ from: "/old/queue", to: "/new/queue" });
    expect(cross).toContainEqual({ from: "/old/outbox", to: "/new/data/outbox" });
    expect(cross).toContainEqual({ from: "/old/clones", to: "/new/cache/clones" });
    expect(cross).toContainEqual({ from: "/old/worker.log", to: "/new/logs/worker.log" });
    expect(cross).toContainEqual({
      from: "/old/update-check.json",
      to: "/new/cache/update-check.json",
    });
    const inPlace = flatToV2Pairs("/r", "/r");
    expect(inPlace.map((p) => p.from)).not.toContain("/r/queue"); // identity — already home
    expect(inPlace).toContainEqual({ from: "/r/outbox", to: "/r/data/outbox" });
  });

  it("review/watchlist.json/migrated.json are identity-named in both layouts — only the root changes", () => {
    const cross = flatToV2Pairs("/old", "/new");
    expect(cross).toContainEqual({ from: "/old/review", to: "/new/review" });
    expect(cross).toContainEqual({ from: "/old/watchlist.json", to: "/new/watchlist.json" });
    expect(cross).toContainEqual({ from: "/old/migrated.json", to: "/new/migrated.json" });
  });

  it("moves the plan-set records tree", () => {
    const pairs = flatToV2Pairs("/from", "/to");
    expect(pairs).toContainEqual({ from: join("/from", "plans"), to: join("/to", "data/plans") });
  });

  it("covers every layout key (guards against a forgotten tree)", () => {
    // A new LAYOUTS entry with no pair here is silently left behind by a
    // cross-root migrate AND blocks the legacy-root rmdir. Keep this list in
    // sync deliberately rather than discovering the gap in production.
    const pairs = flatToV2Pairs("/from", "/to").map((p) => p.from);
    for (const key of [
      "queue",
      "review",
      "outbox",
      "assess-history",
      "history",
      "transcripts",
      "plans",
      "clones",
      "worktrees",
      "github-cache",
      "mirror",
    ]) {
      expect(pairs, `missing pair for ${key}`).toContain(join("/from", key));
    }
  });

  it("derived completeness guard (fix-wave review Minor 1): every dataTreePaths field that differs between layouts is reachable through a flatToV2Pairs entry", () => {
    // The list above restates LAYOUTS' key names by hand — exactly the
    // failure mode that let the "plans" gap through before #283's fix-wave
    // review (a brand-new LAYOUTS entry is only caught here if someone
    // remembers to add it to this list too). This guard DERIVES the key set
    // instead: build dataTreePaths for a flat and a v2 config sharing the
    // same root/queueRoot/external-repos-root/worktreeRoot, diff every
    // resolved string field, and assert each flat-layout value the diff
    // surfaces is reachable through SOME flatToV2Pairs entry — reusing
    // `rewritePath` (the exact path-boundary matching logic the real
    // rewrite phase runs, migratePathRewrite.ts) rather than a second
    // hand-rolled "startsWith" check. Holding root/queueRoot/external/
    // worktree constant across both fixtures isolates exactly the fields
    // LAYOUTS actually drives — everything else (root itself, queue.*,
    // clonesExternal, worktrees, watchlistFile, migratedFile, skills,
    // reviewAssess/reviewComments — the last two identity-named across
    // layouts, only the root changes) is IDENTICAL between the two configs
    // and so never appears in the diff, which is correct: those either
    // don't move at all, or their "only the root changes" pairing is
    // already covered by the dedicated test above.
    const root = "/sbxroot/data";
    const shared = { dataDir: root, queueRoot: join(root, "queue") };
    const flatPaths = dataTreePaths(makeConfig({ ...shared, dataLayout: "flat" }));
    const v2Paths = dataTreePaths(makeConfig({ ...shared, dataLayout: "v2" }));
    const pairs = flatToV2Pairs(root, "/sbxroot/target");

    const diffs = diffStringFields(
      flatPaths as unknown as Record<string, unknown>,
      v2Paths as unknown as Record<string, unknown>,
    ).filter(
      // logsDir aliases the bare root in the flat layout (LAYOUTS.flat.logs
      // is "." — there is no distinct logs/ directory pre-migration), so it
      // has no flatToV2Pairs entry BY DESIGN — nothing to rename because it
      // was never a distinct subdirectory to begin with. logFile (the actual
      // file that DOES move, join(root, "worker.log") -> .../logs/worker.log)
      // is still covered by the loop below.
      ([field]) => field !== "logsDir",
    );

    // Sanity: the diff actually found the layout-driven fields — an empty
    // diff would make the loop below vacuous.
    expect(diffs.length).toBeGreaterThanOrEqual(10);

    for (const [field, flatValue] of diffs) {
      expect(
        rewritePath(flatValue, pairs),
        `dataTreePaths.${field} = ${flatValue} is not covered by any flatToV2Pairs entry`,
      ).not.toBeNull();
    }
  });
});

/** Recursively diffs two same-shaped plain-object/string trees, collecting
 * `[dotted.path, aValue]` for every leaf where the two disagree. Used only by
 * the derived completeness guard above. */
function diffStringFields(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  prefix = "",
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const key of Object.keys(a)) {
    const av = a[key];
    const bv = b[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof av === "string" && typeof bv === "string") {
      if (av !== bv) out.push([path, av]);
    } else if (av && bv && typeof av === "object" && typeof bv === "object") {
      out.push(
        ...diffStringFields(av as Record<string, unknown>, bv as Record<string, unknown>, path),
      );
    }
  }
  return out;
}

describe("pendingMigrations", () => {
  it("filters to only pairs whose source currently exists", () => {
    const root = freshRoot();
    mkdirSync(join(root, "github-outbox"), { recursive: true });
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    const pending = pendingMigrations(cfg);
    expect(pending).toHaveLength(1);
    expect(pending[0].from).toBe(join(root, "github-outbox"));
  });
});

describe("migrationTargetRoot", () => {
  it("resolves to juncoHome(env) when legacy.dataRoot, else stays at cfg.dataDir", () => {
    const legacyCfg = makeConfig({
      dataDir: "/sbxroot/legacy-data-root",
      queueRoot: "/sbxroot/legacy-data-root/queue",
      legacy: {
        vaultRoot: false,
        stateDir: false,
        worktreeRoot: false,
        externalReposRoot: false,
        dataRoot: true,
        ghConfigDir: false,
      },
    });
    expect(migrationTargetRoot(legacyCfg, { HOME: "/sbxroot/home" })).toBe(
      join("/sbxroot/home", ".junco"),
    );

    const v2Cfg = makeConfig({
      dataDir: "/sbxroot/v2-root",
      queueRoot: "/sbxroot/v2-root/queue",
    });
    expect(migrationTargetRoot(v2Cfg, { HOME: "/sbxroot/home" })).toBe("/sbxroot/v2-root");
  });
});

describe("pendingMigrations — single-root layout pairs (2026-08-03 plan)", () => {
  it("a legacy/flat dataRoot config's pending list includes the flat outbox -> canonical data/outbox pair", () => {
    const legacyRoot = "/sbxroot/legacy-data-root";
    const cfg = makeConfig({
      dataDir: legacyRoot,
      queueRoot: join(legacyRoot, "queue"),
      legacy: {
        vaultRoot: false,
        stateDir: false,
        worktreeRoot: false,
        externalReposRoot: false,
        dataRoot: true,
        ghConfigDir: false,
      },
    });
    const env = { HOME: "/sbxroot/home" };
    const canonicalRoot = join("/sbxroot/home", ".junco");
    const pending = pendingMigrations(cfg, (p) => p === join(legacyRoot, "outbox"), env);
    expect(pending).toContainEqual({
      from: join(legacyRoot, "outbox"),
      to: join(canonicalRoot, "data", "outbox"),
    });
  });

  it("a genuinely-v2 dataDir (nothing flat-shaped left on disk) reports no layout pairs", () => {
    const root = "/sbxroot/v2-root";
    const cfg = makeConfig({
      dataDir: root,
      queueRoot: join(root, "queue"),
      dataLayout: "v2",
    });
    expect(cfg.legacy.dataRoot).toBe(false);
    // existsFn reports the V2 shape as present (data/outbox) — exactly what a
    // real fully-migrated v2 tree looks like on disk — never the flat names
    // dataRootPairs actually probes (outbox, assess-history, ...).
    const pending = pendingMigrations(cfg, (p) => p === join(root, "data", "outbox"), {
      HOME: "/sbxroot/home",
    });
    expect(pending).toEqual([]);
  });

  it("backward-compatible: the 2-arg call (no env) still works, defaulting env to process.env", () => {
    const root = freshRoot();
    mkdirSync(join(root, "github-outbox"), { recursive: true });
    const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
    // Same assertion as the very first pendingMigrations test above — proves
    // the new 3rd (env) param doesn't disturb the existing 2-arg call shape.
    const pending = pendingMigrations(cfg, (p) => p === join(root, "github-outbox"));
    expect(pending).toHaveLength(1);
  });

  // Reopened case (a) — task-6 review: an explicit, NON-legacy dataDir that's
  // still flat-shaped on disk has a genuinely pending in-place v2 restructure
  // too — dataRootPairs (shared with dataMigrateCmd.ts's actual mover) is
  // purely existence-driven, with no cfg.legacy.dataRoot/cfg.dataLayout gate.
  it("an explicit, non-legacy flat dataDir with real flat content on disk reports its own pending in-place v2 restructure", () => {
    const root = "/sbxroot/explicit-flat-root";
    const cfg = makeConfig({
      dataDir: root,
      queueRoot: join(root, "queue"),
      dataLayout: "flat",
    });
    expect(cfg.legacy.dataRoot).toBe(false); // NOT a legacy-root fallback
    const pending = pendingMigrations(cfg, (p) => p === join(root, "outbox"), {
      HOME: "/sbxroot/home",
    });
    expect(pending).toContainEqual({
      from: join(root, "outbox"),
      to: join(root, "data", "outbox"),
    });
  });

  // Reopened case (b) — task-6 review: the resumed-migration scenario the
  // migration task itself was built to survive. legacy.dataRoot has ALREADY
  // flipped false (loadConfig's resolveDataRoot sees the target root has a
  // marker and resolves cfg.dataDir straight to it), but a straggler pair is
  // still sitting in the FIXED legacy root — dataRootPairs probes that fixed
  // path independently of the flag (fixedLegacyRoot only keys off targetRoot
  // === juncoHome(env)), so the straggler must still surface here.
  it("a resumed migration (legacy.dataRoot already false, target root resolved) still reports a straggler left in the fixed legacy root", () => {
    const env = { HOME: "/sbxroot/home" };
    const targetRoot = join("/sbxroot/home", ".junco"); // == juncoHome(env)
    const fixedLegacy = join("/sbxroot/home", ".local", "state", "junco");
    const cfg = makeConfig({
      dataDir: targetRoot, // resolution already flipped to the canonical root
      queueRoot: join(targetRoot, "queue"),
      dataLayout: "v2",
    });
    expect(cfg.legacy.dataRoot).toBe(false);
    const pending = pendingMigrations(
      cfg,
      (p) => p === join(fixedLegacy, "outbox"), // only the straggler exists
      env,
    );
    expect(pending).toContainEqual({
      from: join(fixedLegacy, "outbox"),
      to: join(targetRoot, "data", "outbox"),
    });
  });
});

/**
 * Item 6 (#281): when BOTH source roots hold the same flat-named pair, the
 * old dedupe let `cfg.dataDir` take the target slot and dropped the legacy
 * candidate from the returned array entirely — so run 1 exited 0 having never
 * planned, moved, journaled or reported the straggler, and run 2 (the slot now
 * uncontested) hit a populated destination and reported `skipped-conflict`
 * with exit 1. Both pending sources must now be represented, with the loser
 * marked `contendedBy` so the mover reports it as a plan-time conflict instead
 * of merging two roots onto one destination.
 */
describe("dataRootPairs — both roots pend the same target (item 6, #281)", () => {
  const env = { HOME: "/sbxroot/home" };
  const targetRoot = join("/sbxroot/home", ".junco");
  const fixedLegacy = join("/sbxroot/home", ".local", "state", "junco");
  const cfg = makeConfig({
    dataDir: targetRoot, // resolution already flipped to the canonical root
    queueRoot: join(targetRoot, "queue"),
    dataLayout: "flat",
  });

  it("keeps BOTH pending sources and marks the loser contendedBy the winner", () => {
    const contested = new Set([join(targetRoot, "outbox"), join(fixedLegacy, "outbox")]);
    const pairs = dataRootPairs(cfg, targetRoot, fixedLegacy, (p) => contested.has(p));
    const forTarget = pairs.filter((p) => p.to === join(targetRoot, "data", "outbox"));
    expect(forTarget).toHaveLength(2);
    // The winner is the dataDir source (probed first) — unmarked.
    expect(forTarget[0]).toEqual({
      from: join(targetRoot, "outbox"),
      to: join(targetRoot, "data", "outbox"),
      pending: true,
    });
    // The legacy straggler survives, explicitly marked as contended.
    const loser = forTarget.find((p) => p.from === join(fixedLegacy, "outbox"));
    expect(loser).toBeDefined();
    expect(loser?.pending).toBe(true);
    expect(loser?.contendedBy).toBe(join(targetRoot, "outbox"));
    // Winners precede their contended partner — the mover's guard depends on
    // seeing the claim before the loser comes round.
    expect(pairs.indexOf(forTarget[0])).toBeLessThan(pairs.indexOf(loser!));
  });

  it("pendingMigrations (doctor / junco data --json) reports both stragglers, not one", () => {
    const contested = new Set([join(targetRoot, "outbox"), join(fixedLegacy, "outbox")]);
    const pending = pendingMigrations(cfg, (p) => contested.has(p), env);
    expect(pending).toContainEqual({
      from: join(targetRoot, "outbox"),
      to: join(targetRoot, "data", "outbox"),
    });
    expect(pending).toContainEqual({
      from: join(fixedLegacy, "outbox"),
      to: join(targetRoot, "data", "outbox"),
    });
  });

  it("an ordinary machine (one source pending) still gets exactly one, unmarked pair per target", () => {
    // Only the legacy root holds the pair — the inert dataDir candidate is
    // still deduped away, so no duplicate 'nothing to move' lines appear.
    const pairs = dataRootPairs(cfg, targetRoot, fixedLegacy, (p) =>
      p.startsWith(join(fixedLegacy, "")),
    );
    const forTarget = pairs.filter((p) => p.to === join(targetRoot, "data", "outbox"));
    expect(forTarget).toHaveLength(1);
    expect(forTarget[0].from).toBe(join(fixedLegacy, "outbox"));
    expect(forTarget[0].contendedBy).toBeUndefined();
    // And nothing anywhere in the list is marked when nothing is contested.
    expect(pairs.every((p) => p.contendedBy === undefined)).toBe(true);
    // Single-source machine (no legacy root at all): one pair per target.
    const single = dataRootPairs(cfg, targetRoot, null, () => true);
    expect(new Set(single.map((p) => p.to)).size).toBe(single.length);
    expect(single.every((p) => p.contendedBy === undefined)).toBe(true);
  });

  it("neither source pending: still one inert pair per target, unmarked", () => {
    const pairs = dataRootPairs(cfg, targetRoot, fixedLegacy, () => false);
    expect(new Set(pairs.map((p) => p.to)).size).toBe(pairs.length);
    expect(pairs.every((p) => !p.pending && p.contendedBy === undefined)).toBe(true);
  });
});

/**
 * Item 11 (#281): the ONE spelling of "is a config relocation pending", shared
 * by the mover (`runDataMigrate`'s phase-9 gate) and the two read-only
 * reporters (`junco doctor`, `junco data`). Before this existed both reporters
 * were silent about a config still sitting at the legacy XDG path — they told
 * the operator the migration was complete while it demonstrably was not.
 *
 * The `JUNCO_CONFIG` guard (#307) is the load-bearing half: an explicitly-named
 * config is DELIBERATELY never relocated, so reporting one as "pending" would
 * raise a warning `junco data migrate` correctly refuses to clear — run after
 * run, forever. A second spelling of that guard living in the reporters is
 * exactly the drift this function exists to prevent.
 */
describe("pendingConfigRelocation (item 11, #281)", () => {
  const env = { HOME: "/sbxroot/home" };
  const legacy = join("/sbxroot/home", ".config", "junco", "config.json");
  const canonical = join("/sbxroot/home", ".junco", "config.json");

  it("reports the pair when this run's config is at the legacy XDG path", () => {
    expect(pendingConfigRelocation(legacy, env)).toEqual({ from: legacy, to: canonical });
  });

  it("reports nothing for a config already at the canonical path", () => {
    expect(pendingConfigRelocation(canonical, env)).toBeNull();
  });

  it("reports nothing under a JUNCO_CONFIG override that names exactly the legacy path", () => {
    // The whole point of the guard: JUNCO_CONFIG accepts any value, the legacy
    // path included, and an explicitly-named config is never relocated. A
    // "pending" here would be a warning no migrate run can ever clear.
    expect(pendingConfigRelocation(legacy, { ...env, JUNCO_CONFIG: legacy })).toBeNull();
  });

  it("reports nothing under a JUNCO_CONFIG override naming an unrelated path", () => {
    const named = "/sbxroot/elsewhere/junco.json";
    expect(pendingConfigRelocation(named, { ...env, JUNCO_CONFIG: named })).toBeNull();
  });

  it("treats an empty/whitespace JUNCO_CONFIG as unset (same rule as configPathOverride)", () => {
    expect(pendingConfigRelocation(legacy, { ...env, JUNCO_CONFIG: "   " })).toEqual({
      from: legacy,
      to: canonical,
    });
  });

  it("honours XDG_CONFIG_HOME when deriving the legacy path", () => {
    const xdg = "/sbxroot/xdg";
    const xdgLegacy = join(xdg, "junco", "config.json");
    expect(pendingConfigRelocation(xdgLegacy, { ...env, XDG_CONFIG_HOME: xdg })).toEqual({
      from: xdgLegacy,
      to: canonical,
    });
  });
});
