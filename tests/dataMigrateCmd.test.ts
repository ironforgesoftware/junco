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
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/types.js";
import { runDataMigrate } from "../src/dataMigrateCmd.js";
import { loadConfig } from "../src/config.js";
import { acquirePidfileLock } from "../src/pidfileLock.js";
import { makeConfig as baseConfig } from "./helpers/config.js";

function freshRoot(prefix = "junco-dmc-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Full-Config fixture — same shape as tests/dataMigrate.test.ts's makeConfig. */
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
      healthEnabled: true,
      removeWorktreeOnSuccess: true,
    },
    {
      dataLayout: "flat", // every fixture below is a pre-existing (pre-flip) tree
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
      legacy: {
        vaultRoot: true,
        stateDir: false,
        worktreeRoot: false,
        externalReposRoot: false,
        dataRoot: false,
        ghConfigDir: false,
      },
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

describe("runDataMigrate — daemon pidfile refusal (health-disabled daemons)", () => {
  it("refuses when <config dir>/worker.lock is held by a live pid, even with /health unreachable", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}", "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    // Hold the daemon's pidfile with THIS live process — the exact state a
    // healthEnabled:false daemon leaves: /health rejects, worker.lock is live.
    const daemonLock = acquirePidfileLock(join(root, "worker.lock"));
    expect(daemonLock).not.toBeNull();
    try {
      let renameCalls = 0;
      const out: string[] = [];
      const code = await runDataMigrate(
        cfg,
        configPath,
        { dryRun: false, force: false },
        {
          fetchFn: fetchDown(),
          renameFn: () => {
            renameCalls++;
          },
          printFn: (s) => out.push(s),
        },
      );

      expect(code).toBe(1);
      expect(renameCalls).toBe(0);
      expect(out.join("")).toMatch(/refus/i);
      expect(out.join("")).toMatch(/worker\.lock/);
      // Never reached the migration-lock step.
      expect(existsSync(join(dataDir, "migrate.lock"))).toBe(false);
    } finally {
      daemonLock?.release();
    }
  });

  it("--force skips the pidfile check too", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}", "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    const daemonLock = acquirePidfileLock(join(root, "worker.lock"));
    expect(daemonLock).not.toBeNull();
    try {
      const out: string[] = [];
      const code = await runDataMigrate(
        cfg,
        configPath,
        { dryRun: false, force: true },
        { printFn: (s) => out.push(s) },
      );
      expect(code).toBe(0);
    } finally {
      daemonLock?.release();
    }
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

  it("moves the legacy vaultRoot queue to <targetRoot>/queue (queue phase is target-root aware even when the rest of the tree also relocates)", async () => {
    const root = trackRoot(freshRoot());
    const vaultRoot = join(root, "vault");
    mkdirSync(join(vaultRoot, "Junco", "inbox"), { recursive: true });
    writeFileSync(join(vaultRoot, "Junco", "inbox", "t1.md"), "---\nid: t1\n---\nbody\n", "utf8");
    // A state-tree subdir to exercise migrateStateTree/pendingMigrations too.
    // No flat-layout marker needed here (contrast an earlier revision of this
    // fixture, which added a `transcripts` dir for exactly that reason):
    // assembleConfig now forces dataLayout to "flat" for ANY root adopted via
    // the legacy fallback, marker-less or not (config.ts's legacyDataRoot
    // ruling) — a marker-less legacy root can no longer be misclassified v2.
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
    expect(cfg.legacy.dataRoot).toBe(true);
    expect(cfg.dataDir).toBe(join(tmpHome, ".local", "state", "junco"));
    const targetRoot = join(tmpHome, ".junco");

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);

    // Ticket physically moved — to the TARGET root's queue, not cfg.dataDir's
    // (legacy.dataRoot is also set here, so the whole tree relocates).
    expect(existsSync(join(vaultRoot, "Junco", "inbox", "t1.md"))).toBe(false);
    expect(existsSync(join(targetRoot, "queue", "inbox", "t1.md"))).toBe(true);
    expect(readFileSync(join(targetRoot, "queue", "inbox", "t1.md"), "utf8")).toBe(
      "---\nid: t1\n---\nbody\n",
    );

    // State tree migrated too, and relocated under data/.
    expect(existsSync(join(targetRoot, "data", "outbox"))).toBe(true);
    expect(existsSync(join(cfg.dataDir, "outbox"))).toBe(false);
    expect(existsSync(join(cfg.dataDir, "github-outbox"))).toBe(false);

    // The legacy root is fully vacated and removed.
    expect(existsSync(cfg.dataDir)).toBe(false);

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
    expect(reloaded.legacy.dataRoot).toBe(false);
    expect(reloaded.queueRoot).toBe(join(targetRoot, "queue"));
    expect(reloaded.dataDir).toBe(targetRoot);
    expect(reloaded.dataLayout).toBe("v2");

    expect(out.join("")).toMatch(/receipt/i);
    expect(out.join("")).toMatch(/data root:/);
  });

  it("relocates the legacy flat tree into ~/.junco's v2 shape (queue/state-tree/gh creds), journals at the target, removes the emptied legacy root — and a second run is a no-op", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    const targetRoot = join(tmpHome, ".junco");

    // Queue already lives at the flat root's own queue/ (no vaultRoot override).
    mkdirSync(join(legacyRoot, "queue", "inbox"), { recursive: true });
    writeFileSync(join(legacyRoot, "queue", "inbox", "t1.md"), "---\nid: t1\n---\nbody\n", "utf8");

    // I-1 (final review 2026-08-05): every real legacy root also holds the
    // self-written `.gitignore` (`ensureDataTree`'s own scaffold) — omitting
    // it here would let the happy-path test pass without exercising the
    // ENOTEMPTY the real rmdir hits on every actual machine.
    writeFileSync(join(legacyRoot, ".gitignore"), "*\n", "utf8");

    // Old-name state-tree subdir: normalizes to clones/watched (migrateStateTree),
    // THEN relocates under cache/clones via flatToV2Pairs' single `clones` pair.
    mkdirSync(join(legacyRoot, "repos", "acme", "repo"), { recursive: true });
    writeFileSync(join(legacyRoot, "repos", "acme", "repo", "file.txt"), "hi", "utf8");

    // github-outbox normalizes to outbox, then relocates to data/outbox.
    mkdirSync(join(legacyRoot, "github-outbox"), { recursive: true });

    // worker.log relocates to logs/worker.log.
    writeFileSync(join(legacyRoot, "worker.log"), "log line\n", "utf8");

    // Legacy bot gh creds (~/.config/junco/gh) relocate to ~/.junco/gh.
    const legacyGh = join(tmpHome, ".config", "junco", "gh");
    mkdirSync(legacyGh, { recursive: true });
    writeFileSync(join(legacyGh, "hosts.yml"), "github.com:\n  oauth_token: x\n", "utf8");

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg = loadConfig(configPath);
    expect(cfg.legacy.dataRoot).toBe(true);
    expect(cfg.legacy.ghConfigDir).toBe(true);
    expect(cfg.dataDir).toBe(legacyRoot);
    expect(cfg.dataLayout).toBe("flat");

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);

    // queue
    expect(existsSync(join(targetRoot, "queue", "inbox", "t1.md"))).toBe(true);

    // data (state-tree normalize, then relocate)
    expect(existsSync(join(targetRoot, "data", "outbox"))).toBe(true);

    // cache (state-tree normalize repos->clones/watched, then relocate clones->cache/clones)
    expect(
      existsSync(join(targetRoot, "cache", "clones", "watched", "acme", "repo", "file.txt")),
    ).toBe(true);

    // logs
    expect(existsSync(join(targetRoot, "logs", "worker.log"))).toBe(true);
    expect(readFileSync(join(targetRoot, "logs", "worker.log"), "utf8")).toBe("log line\n");

    // gh creds
    expect(existsSync(join(targetRoot, "gh", "hosts.yml"))).toBe(true);
    expect(existsSync(legacyGh)).toBe(false);

    // journal ends up ONLY at the TARGET root — migrateStateTree wrote it at
    // the OLD root (cfg.dataDir), and the migrated.json pair's legacy-side
    // self-reference (task review round 2) merges those steps into the
    // target journal and removes the legacy file, rather than renaming it.
    expect(existsSync(join(targetRoot, "migrated.json"))).toBe(true);
    expect(existsSync(join(legacyRoot, "migrated.json"))).toBe(false);
    const journal = JSON.parse(readFileSync(join(targetRoot, "migrated.json"), "utf8")) as {
      steps: Array<{ from: string; action: string }>;
    };
    const renamed = journal.steps.filter((s) => s.action === "renamed");
    expect(renamed.some((s) => s.from.endsWith("repos"))).toBe(true);
    expect(renamed.some((s) => s.from.endsWith("github-outbox"))).toBe(true);

    // legacy root fully vacated and removed.
    expect(existsSync(legacyRoot)).toBe(false);

    // config.json: default dataDir (the TARGET), no explicit key written.
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(raw.dataDir).toBeUndefined();

    expect(out.join("")).toMatch(/receipt/i);
    expect(out.join("")).toMatch(/data root:/);
    expect(out.join("")).toMatch(/gh config:/);

    // Round-trips cleanly: the reloaded config now resolves canonically.
    const reloaded = loadConfig(configPath);
    expect(reloaded.legacy.dataRoot).toBe(false);
    expect(reloaded.legacy.ghConfigDir).toBe(false);
    expect(reloaded.dataDir).toBe(targetRoot);
    expect(reloaded.dataLayout).toBe("v2");

    // Second run against the reloaded (now-canonical) config: nothing left to
    // move, no-op.
    const out2: string[] = [];
    const code2 = await runDataMigrate(
      reloaded,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out2.push(s) },
    );
    expect(code2).toBe(0);
    expect(out2.join("")).toMatch(/data root: nothing to move/);
    expect(out2.join("")).toMatch(/gh config: nothing to move/);
    expect(out2.join("")).toMatch(/queue: nothing to move/);
  });

  it("#283: rewrites the watchlist entry and the queue ticket's repo:/workdir: to point at the relocated clone, receipted under 'path rewrite:'", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    const targetRoot = join(tmpHome, ".junco");

    // A watched clone under the flat root's "clones" name — relocates to
    // <targetRoot>/cache/clones via flatToV2Pairs' single `clones` pair, same
    // move exercised by the "relocates the legacy flat tree" test above.
    const legacyClone = join(legacyRoot, "clones", "watched", "acme", "repo");
    mkdirSync(legacyClone, { recursive: true });
    writeFileSync(join(legacyClone, "marker.txt"), "hi", "utf8");

    // The dynamic watchlist points at that clone by absolute path.
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(
      join(legacyRoot, "watchlist.json"),
      JSON.stringify([{ nwo: "acme/repo", path: legacyClone }], null, 2) + "\n",
      "utf8",
    );

    // A live queue ticket referencing the same clone via repo:/workdir: —
    // exact emitter quoting style (repo: ${JSON.stringify(path)}).
    mkdirSync(join(legacyRoot, "queue", "inbox"), { recursive: true });
    const ticketRaw =
      "---\n" +
      "id: t1\n" +
      `repo: ${JSON.stringify(legacyClone)}\n` +
      `workdir: ${JSON.stringify(legacyClone)}\n` +
      "---\n" +
      "Fix the thing.\n";
    writeFileSync(join(legacyRoot, "queue", "inbox", "t1.md"), ticketRaw, "utf8");

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = loadConfig(configPath);
    expect(cfg.legacy.dataRoot).toBe(true);

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );
    expect(code).toBe(0);

    const newClone = join(targetRoot, "cache", "clones", "watched", "acme", "repo");
    expect(existsSync(join(newClone, "marker.txt"))).toBe(true);

    // Watchlist rewritten in place at its new location.
    const watchlist = JSON.parse(
      readFileSync(join(targetRoot, "watchlist.json"), "utf8"),
    ) as Array<{
      nwo: string;
      path: string;
    }>;
    expect(watchlist).toEqual([{ nwo: "acme/repo", path: newClone }]);

    // Ticket rewritten in place at its new location — both repo: and
    // workdir:, byte-identical elsewhere (id:, delimiters, body).
    const ticketPath = join(targetRoot, "queue", "inbox", "t1.md");
    expect(existsSync(ticketPath)).toBe(true);
    const ticketOut = readFileSync(ticketPath, "utf8");
    expect(ticketOut).toBe(
      "---\n" +
        "id: t1\n" +
        `repo: ${JSON.stringify(newClone)}\n` +
        `workdir: ${JSON.stringify(newClone)}\n` +
        "---\n" +
        "Fix the thing.\n",
    );

    // 3 paths: the watchlist entry, plus repo: and workdir: in the ticket —
    // across 2 files (the watchlist and the ticket).
    expect(out.join("")).toMatch(/path rewrite:\n\s+3 path\(s\) rewritten across 2 file\(s\)/);

    // A second run is a no-op: nothing left to move, so the map is empty and
    // the rewrite phase reports nothing to rewrite (idempotent).
    const reloaded = loadConfig(configPath);
    const out2: string[] = [];
    const code2 = await runDataMigrate(
      reloaded,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out2.push(s) },
    );
    expect(code2).toBe(0);
    expect(out2.join("")).toMatch(/path rewrite: nothing to rewrite/);
    expect(readFileSync(ticketPath, "utf8")).toBe(ticketOut);
  });

  it("task-3: rewrites repoPath in pending assess/comment records, plan-set records, and push/pr outbox ops (dead/ included), leaving labels ops untouched", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    const targetRoot = join(tmpHome, ".junco");

    const legacyClone = join(legacyRoot, "clones", "watched", "acme", "repo");
    mkdirSync(legacyClone, { recursive: true });
    writeFileSync(join(legacyClone, "marker.txt"), "hi", "utf8");

    // Pending assess batch — review/assess is identity-named under v2, so
    // only the root changes.
    mkdirSync(join(legacyRoot, "review", "assess"), { recursive: true });
    const assessBatch = {
      id: "assess-acme-repo-1",
      nwo: "acme/repo",
      external: false,
      autoPlan: false,
      repoPath: legacyClone,
      createdAt: "2026-01-01T00:00:00.000Z",
      findings: [],
    };
    writeFileSync(
      join(legacyRoot, "review", "assess", "assess-acme-repo-1.json"),
      JSON.stringify(assessBatch, null, 2) + "\n",
      "utf8",
    );

    // Pending comment draft — review/comments, same identity-named root.
    mkdirSync(join(legacyRoot, "review", "comments"), { recursive: true });
    const commentDraft = {
      id: "analyze-acme-repo-1",
      nwo: "acme/repo",
      issue: 9,
      issueTitle: "Something",
      external: false,
      repoPath: legacyClone,
      createdAt: "2026-01-01T00:00:00.000Z",
      draft: "body",
      footer: true,
    };
    writeFileSync(
      join(legacyRoot, "review", "comments", "analyze-acme-repo-1.json"),
      JSON.stringify(commentDraft, null, 2) + "\n",
      "utf8",
    );

    // Plan-set record — plans/ (flat) -> data/plans (v2).
    mkdirSync(join(legacyRoot, "plans"), { recursive: true });
    const planRecord = {
      v: 1,
      planId: "plan1",
      hash: "h1",
      repoPath: legacyClone,
      github: { nwo: "acme/repo", issue: 5 },
      tasks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      statusCommentId: null,
      degradedPosted: false,
      lastLabel: null,
      closed: false,
    };
    writeFileSync(
      join(legacyRoot, "plans", "plan1.json"),
      JSON.stringify(planRecord, null, 2) + "\n",
      "utf8",
    );

    // Outbox ops — outbox/ (flat) -> data/outbox (v2); a push op, a pr op, a
    // labels op (no path — must stay untouched), and a dead-lettered push op.
    mkdirSync(join(legacyRoot, "outbox", "dead"), { recursive: true });
    const pushOp = {
      id: "1-0000-aaaa-push",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: "prflow",
      issueKey: null,
      attempts: 0,
      lastError: null,
      op: { kind: "push", repoPath: legacyClone, branch: "feat/x" },
    };
    writeFileSync(
      join(legacyRoot, "outbox", "1-0000-aaaa-push.json"),
      JSON.stringify(pushOp, null, 2),
      "utf8",
    );
    const prOp = {
      id: "2-0000-bbbb-pr",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: "prflow",
      issueKey: "acme/repo#3",
      attempts: 0,
      lastError: null,
      op: {
        kind: "pr",
        repoPath: legacyClone,
        branch: "feat/x",
        nwo: "acme/repo",
        issue: 3,
        base: "main",
        title: "t",
        bodyText: "b",
        draft: false,
        labels: [],
        reviewers: [],
        finalize: null,
        pushed: false,
        prUrl: null,
      },
    };
    writeFileSync(
      join(legacyRoot, "outbox", "2-0000-bbbb-pr.json"),
      JSON.stringify(prOp, null, 2),
      "utf8",
    );
    const labelsOp = {
      id: "3-0000-cccc-labels",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: "dashboard",
      issueKey: "acme/repo#4",
      attempts: 0,
      lastError: null,
      op: { kind: "labels", nwo: "acme/repo", issue: 4, add: ["x"], remove: [] },
    };
    const labelsRaw = JSON.stringify(labelsOp, null, 2);
    writeFileSync(join(legacyRoot, "outbox", "3-0000-cccc-labels.json"), labelsRaw, "utf8");
    const deadOp = {
      id: "4-0000-dddd-push",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: "prflow",
      issueKey: null,
      attempts: 3,
      lastError: "boom",
      op: { kind: "push", repoPath: legacyClone, branch: "feat/y" },
    };
    writeFileSync(
      join(legacyRoot, "outbox", "dead", "4-0000-dddd-push.json"),
      JSON.stringify(deadOp, null, 2),
      "utf8",
    );

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = loadConfig(configPath);
    expect(cfg.legacy.dataRoot).toBe(true);

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );
    expect(code).toBe(0);

    const newClone = join(targetRoot, "cache", "clones", "watched", "acme", "repo");

    const assessOut = JSON.parse(
      readFileSync(join(targetRoot, "review", "assess", "assess-acme-repo-1.json"), "utf8"),
    ) as typeof assessBatch;
    expect(assessOut).toEqual({ ...assessBatch, repoPath: newClone });

    const commentOut = JSON.parse(
      readFileSync(join(targetRoot, "review", "comments", "analyze-acme-repo-1.json"), "utf8"),
    ) as typeof commentDraft;
    expect(commentOut).toEqual({ ...commentDraft, repoPath: newClone });

    const planOut = JSON.parse(
      readFileSync(join(targetRoot, "data", "plans", "plan1.json"), "utf8"),
    ) as typeof planRecord;
    expect(planOut).toEqual({ ...planRecord, repoPath: newClone });

    const pushFile = join(targetRoot, "data", "outbox", "1-0000-aaaa-push.json");
    const pushOut = JSON.parse(readFileSync(pushFile, "utf8")) as typeof pushOp;
    expect(pushOut).toEqual({ ...pushOp, op: { ...pushOp.op, repoPath: newClone } });

    const prFile = join(targetRoot, "data", "outbox", "2-0000-bbbb-pr.json");
    const prOut = JSON.parse(readFileSync(prFile, "utf8")) as typeof prOp;
    expect(prOut).toEqual({ ...prOp, op: { ...prOp.op, repoPath: newClone } });

    const deadFile = join(targetRoot, "data", "outbox", "dead", "4-0000-dddd-push.json");
    const deadOut = JSON.parse(readFileSync(deadFile, "utf8")) as typeof deadOp;
    expect(deadOut).toEqual({ ...deadOp, op: { ...deadOp.op, repoPath: newClone } });

    // The labels op carries no path — byte-identical, not even touched.
    expect(
      readFileSync(join(targetRoot, "data", "outbox", "3-0000-cccc-labels.json"), "utf8"),
    ).toBe(labelsRaw);

    // 6 paths rewritten (assess, comment, plan, push, pr, dead push) across 6 files.
    expect(out.join("")).toMatch(/path rewrite:\n\s+6 path\(s\) rewritten across 6 file\(s\)/);

    // Minor 6 (fix-wave review): a second full run is a no-op for these four
    // newer stores too, not just the watchlist/ticket pair the "#283" test
    // above already covers — true by construction (idempotence rule 4,
    // migratePathRewrite.ts), but previously unexercised.
    const assessRaw = readFileSync(
      join(targetRoot, "review", "assess", "assess-acme-repo-1.json"),
      "utf8",
    );
    const commentRaw = readFileSync(
      join(targetRoot, "review", "comments", "analyze-acme-repo-1.json"),
      "utf8",
    );
    const planRaw = readFileSync(join(targetRoot, "data", "plans", "plan1.json"), "utf8");
    const pushRaw = readFileSync(pushFile, "utf8");
    const prRaw = readFileSync(prFile, "utf8");
    const deadRaw = readFileSync(deadFile, "utf8");

    const reloaded = loadConfig(configPath);
    const out2: string[] = [];
    const code2 = await runDataMigrate(
      reloaded,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out2.push(s) },
    );
    expect(code2).toBe(0);
    expect(out2.join("")).toMatch(/path rewrite: nothing to rewrite/);

    expect(
      readFileSync(join(targetRoot, "review", "assess", "assess-acme-repo-1.json"), "utf8"),
    ).toBe(assessRaw);
    expect(
      readFileSync(join(targetRoot, "review", "comments", "analyze-acme-repo-1.json"), "utf8"),
    ).toBe(commentRaw);
    expect(readFileSync(join(targetRoot, "data", "plans", "plan1.json"), "utf8")).toBe(planRaw);
    expect(readFileSync(pushFile, "utf8")).toBe(pushRaw);
    expect(readFileSync(prFile, "utf8")).toBe(prRaw);
    expect(readFileSync(deadFile, "utf8")).toBe(deadRaw);
  });

  it("Important 2 (fix-wave, #283): resumes the rewrite phase from the durable journal — a stale path from a run that died before this phase still gets rewritten", async () => {
    const targetRoot = join(tmpHome, ".junco");
    const root = trackRoot(freshRoot());

    // Simulate the START of "run 2": run 1 already renamed a tree and
    // durably journaled it (appendJournal runs in a `finally`), but the
    // process died before reaching the path-rewrite phase — so the
    // watchlist/ticket, though already physically relocated to targetRoot,
    // still hold the OLD prefix in their CONTENT.
    const staleClonesRoot = join(tmpHome, ".local", "state", "junco", "clones");
    const newClonesRoot = join(targetRoot, "cache", "clones");
    mkdirSync(join(targetRoot, "data"), { recursive: true }); // v2-layout marker
    writeFileSync(
      join(targetRoot, "migrated.json"),
      JSON.stringify(
        { version: 1, steps: [{ from: staleClonesRoot, to: newClonesRoot, action: "renamed" }] },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const staleClone = join(staleClonesRoot, "watched", "acme", "repo");
    writeFileSync(
      join(targetRoot, "watchlist.json"),
      JSON.stringify([{ nwo: "acme/repo", path: staleClone }], null, 2) + "\n",
      "utf8",
    );
    mkdirSync(join(targetRoot, "queue", "inbox"), { recursive: true });
    const staleTicket =
      "---\n" + "id: t1\n" + `repo: ${JSON.stringify(staleClone)}\n` + "---\nFix the thing.\n";
    writeFileSync(join(targetRoot, "queue", "inbox", "t1.md"), staleTicket, "utf8");

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = loadConfig(configPath);
    // Nothing pending anywhere else — the ONLY way this run could see the
    // stale prefix is by reading it back out of the durable journal.
    expect(cfg.legacy.dataRoot).toBe(false);
    expect(cfg.dataDir).toBe(targetRoot);
    expect(cfg.dataLayout).toBe("v2");

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/data root: nothing to move/);
    expect(out.join("")).toMatch(/queue: nothing to move/);

    const newClone = join(newClonesRoot, "watched", "acme", "repo");
    const watchlist = JSON.parse(
      readFileSync(join(targetRoot, "watchlist.json"), "utf8"),
    ) as Array<{
      nwo: string;
      path: string;
    }>;
    expect(watchlist).toEqual([{ nwo: "acme/repo", path: newClone }]);

    const ticketOut = readFileSync(join(targetRoot, "queue", "inbox", "t1.md"), "utf8");
    expect(ticketOut).toBe(
      "---\n" + "id: t1\n" + `repo: ${JSON.stringify(newClone)}\n` + "---\nFix the thing.\n",
    );
    expect(out.join("")).toMatch(/path rewrite:\n\s+2 path\(s\) rewritten across 2 file\(s\)/);
  });

  it("I-1: leaves an operator-customized legacy-root .gitignore in place and reports it as a leftover, rather than removing it", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    mkdirSync(legacyRoot, { recursive: true });
    // NOT junco's own scaffold content — an operator customized it.
    writeFileSync(join(legacyRoot, ".gitignore"), "*.local\n", "utf8");

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = loadConfig(configPath);

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0); // an unremoved root is reported, not a conflict exit
    expect(existsSync(join(legacyRoot, ".gitignore"))).toBe(true);
    expect(readFileSync(join(legacyRoot, ".gitignore"), "utf8")).toBe("*.local\n");
    expect(existsSync(legacyRoot)).toBe(true);
    expect(out.join("")).toMatch(/not removed — still contains: \.gitignore/);
  });

  it("N3: unlinks a leftover skills symlink mount before the rmdir, so the legacy root is actually removed", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    mkdirSync(legacyRoot, { recursive: true });
    // skillLinks.ts recreates <root>/skills as a symlink at every daemon
    // startup. A migrated mount's target is the old package dir — its
    // existence is irrelevant here, since existsFn (which follows links)
    // must never be what identifies it; only lstat can.
    symlinkSync(join(root, "nonexistent-skills-target"), join(legacyRoot, "skills"));

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = loadConfig(configPath);

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);
    expect(existsSync(legacyRoot)).toBe(false);
    expect(out.join("")).toMatch(/removed legacy root/);
  });

  it("N3: a real directory (not a symlink) at the legacy skills path is left alone and reported as a leftover", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    // NOT a symlink — an actual directory sitting at that path, holding a
    // real file. Must never be unlinked.
    mkdirSync(join(legacyRoot, "skills"), { recursive: true });
    writeFileSync(join(legacyRoot, "skills", "real-file.txt"), "hi", "utf8");

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = loadConfig(configPath);

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);
    expect(existsSync(join(legacyRoot, "skills", "real-file.txt"))).toBe(true);
    expect(existsSync(legacyRoot)).toBe(true);
    expect(out.join("")).toMatch(/not removed — still contains: skills/);
  });

  it("--dry-run prints the cross-root plan and moves nothing", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    mkdirSync(join(legacyRoot, "github-outbox"), { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg = loadConfig(configPath);
    expect(cfg.legacy.dataRoot).toBe(true);

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: true, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);
    expect(existsSync(join(tmpHome, ".junco"))).toBe(false);
    expect(existsSync(join(legacyRoot, "github-outbox"))).toBe(true);
    expect(out.join("")).toMatch(/dry-run/);
    expect(out.join("")).toMatch(/data root:/);
  });

  // Important 4 (task review): on a cross-root machine, migrateStateTree
  // (phase 4) writes its journal at cfg.dataDir — the data-root move (phase
  // 5, which would relocate it to the target) never gets a chance to run
  // when phase 4 itself throws. The "interrupted" receipt must point at the
  // journal that ACTUALLY exists, not the target's (which may not exist at
  // all yet).
  it("Important 4: the cross-root 'interrupted' receipt points at cfg.dataDir's journal, not the target's", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    mkdirSync(join(legacyRoot, "github-outbox"), { recursive: true });
    const targetRoot = join(tmpHome, ".junco");
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg = loadConfig(configPath);
    expect(cfg.legacy.dataRoot).toBe(true);

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      {
        fetchFn: fetchDown(),
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
    expect(text).toMatch(/interrupted/);
    expect(text).toContain(join(legacyRoot, "migrated.json"));
    expect(text).not.toContain(join(targetRoot, "migrated.json"));
    // The throw came before the data-root move phase ever ran.
    expect(existsSync(join(targetRoot, "migrated.json"))).toBe(false);
  });
});

describe("runDataMigrate — config relocation (I-2, final review 2026-08-05)", () => {
  let originalHome: string | undefined;
  let originalXdgConfigHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    tmpHome = freshRoot("junco-dmc-cfgmove-");
    process.env.HOME = tmpHome;
    delete process.env.XDG_CONFIG_HOME; // hermetic: pin legacyConfigPath to $HOME/.config
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("relocates a legacy-XDG config to the canonical ~/.junco/config.json, journals it, and resolution picks it up next run", async () => {
    const legacyConfigDir = join(tmpHome, ".config", "junco");
    mkdirSync(legacyConfigDir, { recursive: true });
    const configPath = join(legacyConfigDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg = loadConfig(configPath);
    const canonical = join(tmpHome, ".junco", "config.json");

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(configPath)).toBe(false);
    expect(JSON.parse(readFileSync(canonical, "utf8")).model).toEqual({ id: "test-model" });
    expect(out.join("")).toContain(`config:\n  moved ${configPath} -> ${canonical}`);

    // Journaled at the target root, same as every other pair.
    const journal = JSON.parse(readFileSync(join(tmpHome, ".junco", "migrated.json"), "utf8")) as {
      steps: Array<{ from: string; to: string; action: string }>;
    };
    expect(
      journal.steps.some(
        (s) => s.from === configPath && s.to === canonical && s.action === "renamed",
      ),
    ).toBe(true);

    // Resolution finds the relocated file next run — the split-brain the
    // whole plan exists to prevent never opens back up.
    const { resolveConfigPath } = await import("../src/config.js");
    expect(resolveConfigPath({ env: { HOME: tmpHome } })).toBe(canonical);

    // Re-run is a no-op: configPath now resolves canonically, so
    // configPathIsLegacy is false and the phase never re-fires.
    const reloaded = loadConfig(canonical);
    const out2: string[] = [];
    const code2 = await runDataMigrate(
      reloaded,
      canonical,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out2.push(s) },
    );
    expect(code2).toBe(0);
    expect(out2.join("")).toContain("config: nothing to relocate");
  });

  it("never overwrites an existing canonical config — receipted as a conflict, both files left untouched, exit 1", async () => {
    const legacyConfigDir = join(tmpHome, ".config", "junco");
    mkdirSync(legacyConfigDir, { recursive: true });
    const configPath = join(legacyConfigDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "legacy-model" } }), "utf8");

    const canonicalDir = join(tmpHome, ".junco");
    mkdirSync(canonicalDir, { recursive: true });
    const canonical = join(canonicalDir, "config.json");
    writeFileSync(canonical, JSON.stringify({ model: { id: "canonical-model" } }), "utf8");

    const cfg = loadConfig(configPath);
    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(1);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(canonical)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8")).model).toEqual({ id: "legacy-model" });
    expect(JSON.parse(readFileSync(canonical, "utf8")).model).toEqual({ id: "canonical-model" });
    expect(out.join("")).toMatch(/config:\n {2}.*skipped-conflict/);
    expect(out.join("")).toMatch(/canonical config already exists — not overwritten/);
  });

  it("--dry-run prints the pending config move and touches nothing", async () => {
    const legacyConfigDir = join(tmpHome, ".config", "junco");
    mkdirSync(legacyConfigDir, { recursive: true });
    const configPath = join(legacyConfigDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg = loadConfig(configPath);
    const canonical = join(tmpHome, ".junco", "config.json");

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: true, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);
    expect(out.join("")).toContain(`config: ${configPath} -> ${canonical}`);
    expect(existsSync(canonical)).toBe(false);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(tmpHome, ".junco"))).toBe(false); // dry-run never mkdirs
  });
});

describe("runDataMigrate — resume after interruption or conflict (Critical 1)", () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = freshRoot("junco-dmc-resume-home-");
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("a crash mid-loop leaves a durable journal, and a re-run picks up exactly the stragglers (filesystem-driven resume)", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    const targetRoot = join(tmpHome, ".junco");

    // Several independent flatToV2Pairs pairs so a crash after the FIRST one
    // (which alone flips loadConfig's resolution to the target — dataRootHasTree
    // only needs one marker) still leaves real work behind.
    mkdirSync(join(legacyRoot, "queue", "inbox"), { recursive: true });
    writeFileSync(join(legacyRoot, "queue", "inbox", "t1.md"), "ticket\n", "utf8");
    writeFileSync(join(legacyRoot, "watchlist.json"), "[]", "utf8");
    mkdirSync(join(legacyRoot, "transcripts"), { recursive: true });
    writeFileSync(join(legacyRoot, "transcripts", "t1.jsonl"), "{}", "utf8");

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg1 = loadConfig(configPath);
    expect(cfg1.legacy.dataRoot).toBe(true);

    // Simulate a crash: the first pair (queue) renames cleanly, the second
    // (watchlist.json) throws (process killed / EIO) — transcripts is never
    // even attempted this run. Scoped to ONLY the watchlist.json pair's
    // destination (not a call-counter) so the fault injection does NOT also
    // break appendJournal's own tmp+rename in the `finally` — otherwise the
    // journal write would ALSO fail this run (swallowed by the #197.1-style
    // guard, since it's not the first error), and the test would prove
    // nothing about journaling actually surviving the crash.
    const watchlistTarget = join(targetRoot, "watchlist.json");
    const crashingRename = (from: string, to: string): void => {
      if (to === watchlistTarget) {
        const e = new Error("SIMULATED CRASH (EIO)") as NodeJS.ErrnoException;
        e.code = "EIO";
        throw e;
      }
      renameSync(from, to);
    };

    const out1: string[] = [];
    const code1 = await runDataMigrate(
      cfg1,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out1.push(s), renameFn: crashingRename },
    );
    expect(code1).toBe(1);
    expect(out1.join("")).toMatch(/SIMULATED CRASH/);

    // The first pair really did move...
    expect(existsSync(join(targetRoot, "queue", "inbox", "t1.md"))).toBe(true);
    // ...but the rest are still stuck at the legacy root, untouched.
    expect(existsSync(join(legacyRoot, "watchlist.json"))).toBe(true);
    expect(existsSync(join(legacyRoot, "transcripts"))).toBe(true);

    // The journal itself survived the crash — appendJournal's own tmp+rename
    // was never touched by the injected fault, so the "queue" pair's outcome
    // is durably recorded at the target BEFORE run 2 ever starts.
    expect(existsSync(join(targetRoot, "migrated.json"))).toBe(true);
    const journal1 = JSON.parse(readFileSync(join(targetRoot, "migrated.json"), "utf8")) as {
      steps: Array<{ from: string; to: string; action: string }>;
    };
    expect(journal1.steps.some((s) => s.action === "renamed" && s.from.endsWith("queue"))).toBe(
      true,
    );

    // A fresh reload: dataRootHasTree(~/.junco) is now true (queue/ landed),
    // so legacy.dataRoot has ALREADY flipped to false — exactly the trap
    // Critical 1 closes.
    const cfg2 = loadConfig(configPath);
    expect(cfg2.legacy.dataRoot).toBe(false);

    const out2: string[] = [];
    const code2 = await runDataMigrate(
      cfg2,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out2.push(s) },
    );

    expect(code2).toBe(0);
    expect(existsSync(join(targetRoot, "watchlist.json"))).toBe(true);
    // transcripts -> data/transcripts in the v2 shape.
    expect(existsSync(join(targetRoot, "data", "transcripts", "t1.jsonl"))).toBe(true);
    expect(existsSync(legacyRoot)).toBe(false); // fully cleaned up now
  });

  it("a conflicted pair is retried (not silently dropped) on the next run, while an already-completed sibling pair is not re-touched", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    const targetRoot = join(tmpHome, ".junco");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "watchlist.json"), '["legacy"]', "utf8");
    mkdirSync(join(legacyRoot, "transcripts"), { recursive: true });
    writeFileSync(join(legacyRoot, "transcripts", "t1.jsonl"), "{}", "utf8");

    // A pre-existing FILE at the target's watchlist.json destination — a
    // genuine, permanent conflict (isRecursivelyEmptyDir hits ENOTDIR).
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, "watchlist.json"), '["target-already-here"]', "utf8");

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg1 = loadConfig(configPath);
    expect(cfg1.legacy.dataRoot).toBe(true);

    const out1: string[] = [];
    const code1 = await runDataMigrate(
      cfg1,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out1.push(s) },
    );
    expect(code1).toBe(1);
    expect(out1.join("")).toMatch(/skipped-conflict/);
    // transcripts moved fine despite the sibling conflict (-> data/transcripts).
    expect(existsSync(join(targetRoot, "data", "transcripts", "t1.jsonl"))).toBe(true);
    expect(existsSync(join(legacyRoot, "transcripts"))).toBe(false);
    // watchlist.json conflict: NEITHER side touched.
    expect(readFileSync(join(legacyRoot, "watchlist.json"), "utf8")).toBe('["legacy"]');
    expect(readFileSync(join(targetRoot, "watchlist.json"), "utf8")).toBe(
      '["target-already-here"]',
    );

    // Reload: transcripts landing under data/ already flips resolution
    // (dataRootHasTree matches on the "data" parent existing at the target).
    const cfg2 = loadConfig(configPath);
    expect(cfg2.legacy.dataRoot).toBe(false);

    const out2: string[] = [];
    const code2 = await runDataMigrate(
      cfg2,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out2.push(s) },
    );

    // Still conflicted — reported again, not silently swallowed as "nothing
    // to move".
    expect(code2).toBe(1);
    expect(out2.join("")).toMatch(/skipped-conflict/);
    expect(readFileSync(join(legacyRoot, "watchlist.json"), "utf8")).toBe('["legacy"]');
    expect(readFileSync(join(targetRoot, "watchlist.json"), "utf8")).toBe(
      '["target-already-here"]',
    );
    // The legacy root still holds the unresolved file, so removal correctly refuses.
    expect(existsSync(legacyRoot)).toBe(true);
  });

  // Task review round 2 (Important): flatToV2Pairs' `migrated.json` pair's
  // destination IS the exact file this run's own journal write lands at. A
  // mid-loop crash AFTER an earlier pair (queue) has already been journaled
  // to the target, but BEFORE the migrated.json pair itself is reached,
  // leaves the target journal pre-populated — reproducing the review's exact
  // trigger: on the next run, migrateStateTree's OWN journal (still sitting
  // untouched at the legacy root from run 1's phase 4) must MERGE into that
  // pre-existing target journal, not conflict against it forever.
  it("the migrated.json pair merges into a pre-existing target journal instead of deadlocking on itself", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    const targetRoot = join(tmpHome, ".junco");

    // Queue (array position 0) — succeeds in run 1, journaled, and alone
    // flips resolution for run 2.
    mkdirSync(join(legacyRoot, "queue", "inbox"), { recursive: true });
    writeFileSync(join(legacyRoot, "queue", "inbox", "t1.md"), "ticket\n", "utf8");
    // watchlist.json (position 2) — the pair whose crash keeps the loop from
    // ever reaching migrated.json (position 3) or outbox (position 4) in run 1.
    writeFileSync(join(legacyRoot, "watchlist.json"), "[]", "utf8");
    // An old-name state-tree dir: migrateStateTree (phase 4, runs BEFORE
    // phase 5's crash) normalizes it to "outbox" and writes its OWN journal
    // to legacyRoot/migrated.json — this is what's still sitting there,
    // untouched, when run 2's migrated.json pair is reached.
    mkdirSync(join(legacyRoot, "github-outbox"), { recursive: true });

    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg1 = loadConfig(configPath);
    expect(cfg1.legacy.dataRoot).toBe(true);

    // Fault injection scoped to ONLY watchlist.json's destination — queue's
    // move AND appendJournal's own tmp+rename for the finally's journal
    // write both proceed via the real renameSync.
    const watchlistTarget = join(targetRoot, "watchlist.json");
    const crashingRename = (from: string, to: string): void => {
      if (to === watchlistTarget) {
        const e = new Error("SIMULATED CRASH (EIO)") as NodeJS.ErrnoException;
        e.code = "EIO";
        throw e;
      }
      renameSync(from, to);
    };

    const out1: string[] = [];
    const code1 = await runDataMigrate(
      cfg1,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out1.push(s), renameFn: crashingRename },
    );
    expect(code1).toBe(1);

    // The target journal already exists after run 1 (queue's outcome), and
    // the LEGACY journal (migrateStateTree's, from phase 4) is untouched —
    // exactly the setup the review's deadlock scenario needs.
    expect(existsSync(join(targetRoot, "migrated.json"))).toBe(true);
    expect(existsSync(join(legacyRoot, "migrated.json"))).toBe(true);
    expect(existsSync(join(legacyRoot, "watchlist.json"))).toBe(true); // never reached
    expect(existsSync(join(legacyRoot, "outbox"))).toBe(true); // never reached either

    const cfg2 = loadConfig(configPath);
    expect(cfg2.legacy.dataRoot).toBe(false); // resolution already flipped

    const out2: string[] = [];
    const code2 = await runDataMigrate(
      cfg2,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out2.push(s) },
    );

    // The OLD (buggy) behavior: exit 1, "migrated.json ... skipped-conflict",
    // forever. The FIX: clean merge, exit 0.
    expect(code2).toBe(0);
    expect(out2.join("")).not.toMatch(/skipped-conflict/);
    expect(out2.join("")).toMatch(/merged/);

    // One journal, at the target only, holding entries from BOTH runs and
    // BOTH sources (this run's data-root moves AND the merged-in legacy
    // state-tree journal).
    expect(existsSync(join(legacyRoot, "migrated.json"))).toBe(false);
    const journal = JSON.parse(readFileSync(join(targetRoot, "migrated.json"), "utf8")) as {
      steps: Array<{ from: string; to: string; action: string }>;
    };
    const renamed = journal.steps.filter((s) => s.action === "renamed");
    expect(renamed.some((s) => s.from.endsWith("queue"))).toBe(true); // run 1
    // "github-outbox".endsWith("outbox") too, so disambiguate the state-tree
    // (merged-in) entry from the data-root move's own "outbox" entry by `to`.
    expect(renamed.some((s) => s.from.endsWith("github-outbox"))).toBe(true); // merged-in
    expect(renamed.some((s) => s.from.endsWith("watchlist.json"))).toBe(true); // run 2
    expect(renamed.some((s) => s.to.endsWith(join("data", "outbox")))).toBe(true); // run 2

    // Fully cleaned up.
    expect(existsSync(legacyRoot)).toBe(false);
  });
});

describe("runDataMigrate — vaultRoot + legacy dataRoot collision (Critical 2)", () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = freshRoot("junco-dmc-collision-home-");
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("replicates the maintainer's live machine shape: vault queue with a ticket + a STRAY legacy-root queue — vault tickets land at target, the stray is reported as a conflict, nothing is merged or deleted, re-run is stable", async () => {
    const root = trackRoot(freshRoot());
    const vaultRoot = join(root, "vault");
    mkdirSync(join(vaultRoot, "Junco", "inbox"), { recursive: true });
    writeFileSync(join(vaultRoot, "Junco", "inbox", "t1.md"), "vault ticket\n", "utf8");

    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    mkdirSync(join(legacyRoot, "queue", "inbox"), { recursive: true });
    writeFileSync(join(legacyRoot, "queue", "inbox", "a.md"), "stray a\n", "utf8");
    writeFileSync(join(legacyRoot, "queue", "inbox", "b.md"), "stray b\n", "utf8");

    const targetRoot = join(tmpHome, ".junco");

    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ vaultRoot, juncoSubdir: "Junco", model: { id: "test-model" } }),
      "utf8",
    );

    const cfg1 = loadConfig(configPath);
    expect(cfg1.legacy.vaultRoot).toBe(true);
    expect(cfg1.legacy.dataRoot).toBe(true);

    const out1: string[] = [];
    const code1 = await runDataMigrate(
      cfg1,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out1.push(s) },
    );

    // The vault ticket landed at the target — phase 3's real output.
    expect(existsSync(join(targetRoot, "queue", "inbox", "t1.md"))).toBe(true);

    // The stray legacy-root queue is untouched — NOTHING deleted, NOTHING merged.
    expect(readFileSync(join(legacyRoot, "queue", "inbox", "a.md"), "utf8")).toBe("stray a\n");
    expect(readFileSync(join(legacyRoot, "queue", "inbox", "b.md"), "utf8")).toBe("stray b\n");
    expect(existsSync(join(targetRoot, "queue", "inbox", "a.md"))).toBe(false);
    expect(existsSync(join(targetRoot, "queue", "inbox", "b.md"))).toBe(false);

    // Reported as a conflict, not silently dropped.
    expect(code1).toBe(1);
    expect(out1.join("")).toMatch(/skipped-conflict/);
    expect(out1.join("")).toMatch(/vaultRoot queue move/);

    // Legacy root not removed (queue/ still inside it).
    expect(existsSync(legacyRoot)).toBe(true);

    // Re-run is stable: config.json already lost the vaultRoot key (phase 8
    // ran despite the conflict, same as any other non-fatal conflict), so
    // this reload no longer treats the vault as legacy — the SAME conflict
    // is still caught, now via the ordinary non-empty-destination check
    // rather than the vaultRoot special-case, and nothing new happens.
    const cfg2 = loadConfig(configPath);
    const out2: string[] = [];
    const code2 = await runDataMigrate(
      cfg2,
      configPath,
      { dryRun: false, force: false },
      { fetchFn: fetchDown(), printFn: (s) => out2.push(s) },
    );

    expect(code2).toBe(1);
    expect(out2.join("")).toMatch(/skipped-conflict/);
    expect(readFileSync(join(legacyRoot, "queue", "inbox", "a.md"), "utf8")).toBe("stray a\n");
    expect(readFileSync(join(legacyRoot, "queue", "inbox", "b.md"), "utf8")).toBe("stray b\n");
    expect(existsSync(join(targetRoot, "queue", "inbox", "t1.md"))).toBe(true); // untouched
  });
});

describe("runDataMigrate — cross-root lock interlock (Important 3)", () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = freshRoot("junco-dmc-lock-home-");
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("refuses when a concurrent daemon holds the LEGACY root's migrate.lock (daemon hasn't reloaded config yet)", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    mkdirSync(join(legacyRoot, "github-outbox"), { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg = loadConfig(configPath);
    expect(cfg.legacy.dataRoot).toBe(true);

    // Simulate a daemon whose OWN cfg.dataDir still resolves to the legacy
    // root (hasn't reloaded config since the migration started) holding ITS
    // migrate.lock there.
    const daemonSideLock = acquirePidfileLock(join(legacyRoot, "migrate.lock"));
    expect(daemonSideLock).not.toBeNull();
    try {
      const out: string[] = [];
      const code = await runDataMigrate(
        cfg,
        configPath,
        { dryRun: false, force: false },
        { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
      );
      expect(code).toBe(1);
      expect(out.join("")).toMatch(/another migrate is running/);
      // Nothing moved — refused before any pair processing.
      expect(existsSync(join(legacyRoot, "github-outbox"))).toBe(true);
    } finally {
      daemonSideLock?.release();
    }
  });

  it("refuses when a concurrent daemon holds the TARGET root's migrate.lock (daemon already reloaded post-migration config)", async () => {
    const root = trackRoot(freshRoot());
    const legacyRoot = join(tmpHome, ".local", "state", "junco");
    mkdirSync(join(legacyRoot, "github-outbox"), { recursive: true });
    const targetRoot = join(tmpHome, ".junco");
    mkdirSync(targetRoot, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");

    const cfg = loadConfig(configPath);
    expect(cfg.legacy.dataRoot).toBe(true);

    const daemonSideLock = acquirePidfileLock(join(targetRoot, "migrate.lock"));
    expect(daemonSideLock).not.toBeNull();
    try {
      const out: string[] = [];
      const code = await runDataMigrate(
        cfg,
        configPath,
        { dryRun: false, force: false },
        { fetchFn: fetchDown(), printFn: (s) => out.push(s) },
      );
      expect(code).toBe(1);
      expect(out.join("")).toMatch(/another migrate is running/);
      expect(existsSync(join(legacyRoot, "github-outbox"))).toBe(true);
    } finally {
      daemonSideLock?.release();
    }
  });
});

describe("runDataMigrate — in-place v2 restructure (explicit dataDir, still flat-shaped)", () => {
  it("restructures a flat explicit dataDir into the v2 shape without touching its root, and writes dataDir explicitly", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "mydata");
    mkdirSync(join(dataDir, "outbox"), { recursive: true });
    writeFileSync(join(dataDir, "outbox", "op1.json"), "{}", "utf8");
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });
    expect(cfg.dataLayout).toBe("flat");
    expect(cfg.legacy.dataRoot).toBe(false);

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: true },
      { printFn: (s) => out.push(s) },
    );

    expect(code).toBe(0);
    expect(existsSync(join(dataDir, "data", "outbox", "op1.json"))).toBe(true);
    expect(existsSync(join(dataDir, "outbox"))).toBe(false);
    // The root itself never moves for an in-place restructure.
    expect(existsSync(dataDir)).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(raw.dataDir).toBe(dataDir); // non-default root — written explicitly
  });
});

describe("runDataMigrate — data-root move conflicts", () => {
  it("a non-empty destination is a skipped-conflict — reported, both sides left untouched, exit 1", async () => {
    const root = trackRoot(freshRoot());
    const dataDir = join(root, "mydata");
    mkdirSync(join(dataDir, "outbox"), { recursive: true });
    writeFileSync(join(dataDir, "outbox", "old.json"), "old", "utf8");
    mkdirSync(join(dataDir, "data", "outbox"), { recursive: true });
    writeFileSync(join(dataDir, "data", "outbox", "new.json"), "new", "utf8");
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: { id: "test-model" } }), "utf8");
    const cfg = makeConfig({ dataDir, queueRoot: join(dataDir, "queue") });

    const out: string[] = [];
    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: true },
      { printFn: (s) => out.push(s) },
    );

    expect(code).toBe(1);
    expect(out.join("")).toMatch(/skipped-conflict/);
    expect(out.join("")).toMatch(/conflict/i);
    expect(existsSync(join(dataDir, "outbox", "old.json"))).toBe(true);
    expect(existsSync(join(dataDir, "data", "outbox", "new.json"))).toBe(true);
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
      legacy: {
        vaultRoot: true,
        stateDir: false,
        worktreeRoot: false,
        externalReposRoot: false,
        dataRoot: false,
        ghConfigDir: false,
      },
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

  // #196: the fsync pass must run AFTER the copy (dest exists) and BEFORE the
  // source is deleted (source still exists) — copy+fsync+verify+delete order.
  it("fsyncs copied files between the verify and the source delete", async () => {
    const root = trackRoot(freshRoot());
    const vaultRoot = join(root, "vault");
    const srcFile = join(vaultRoot, "Junco", "inbox", "t1.md");
    mkdirSync(join(vaultRoot, "Junco", "inbox"), { recursive: true });
    writeFileSync(srcFile, "ticket body", "utf8");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ vaultRoot, juncoSubdir: "Junco" }), "utf8");
    const cfg = makeConfig({
      dataDir,
      queueRoot: join(vaultRoot, "Junco"),
      legacy: {
        vaultRoot: true,
        stateDir: false,
        worktreeRoot: false,
        externalReposRoot: false,
        dataRoot: false,
        ghConfigDir: false,
      },
    });
    const renameFn = (from: string, to: string): void => {
      if (to.includes(join("data", "queue"))) {
        const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      renameSync(from, to);
    };

    const destFile = join(dataDir, "queue", "inbox", "t1.md");
    const syncedFilePaths: string[] = [];
    let sawDestBeforeSourceGone = false;
    const syncPathFn = (p: string): void => {
      if (p === destFile) {
        syncedFilePaths.push(p);
        // Ordering invariant: dest already copied AND source not yet deleted.
        sawDestBeforeSourceGone = existsSync(destFile) && existsSync(srcFile);
      }
    };

    const code = await runDataMigrate(
      cfg,
      configPath,
      { dryRun: false, force: true },
      { printFn: () => {}, renameFn, syncPathFn },
    );

    expect(code).toBe(0);
    expect(syncedFilePaths).toContain(destFile); // the copied file was fsync'd
    expect(sawDestBeforeSourceGone).toBe(true); // sync ran after copy, before delete
    expect(existsSync(srcFile)).toBe(false); // source removed only afterwards
    expect(readFileSync(destFile, "utf8")).toBe("ticket body");
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
