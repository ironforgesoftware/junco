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
import { migrateStateTree, pendingMigrations, stateTreeMigrations } from "../src/dataMigrate.js";
import { makeConfig as baseConfig } from "./helpers/config.js";

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
