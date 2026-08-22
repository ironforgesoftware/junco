/**
 * Tests for src/migratePathRewrite.ts — the #283 fix: `junco data migrate`
 * moves files but never the absolute paths recorded inside them (watchlist
 * `path`, ticket `repo:`/`workdir:`). Pure-helper tests are the brief's
 * exact fixtures (task-2-brief.md Step 1); `rewriteStoredPaths` tests use
 * real mkdtempSync tmp roots, matching tests/dataMigrateCmd.test.ts's style.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  buildPrefixMap,
  dedupeSteps,
  rewritePath,
  rewriteStoredPaths,
  type RewriteDeps,
} from "../src/migratePathRewrite.js";
import type { WatchlistEntry } from "../src/watchlist.js";

describe("buildPrefixMap", () => {
  it("keeps only steps that actually moved", () => {
    const map = buildPrefixMap([
      { from: "/old/clones", to: "/new/cache/clones", action: "renamed" },
      { from: "/old/queue", to: "/new/queue", action: "skipped-conflict" },
      { from: "/old/x", to: "/new/x", action: "noop" },
    ]);
    expect(map).toEqual([{ from: "/old/clones", to: "/new/cache/clones" }]);
  });

  it("orders longest prefix first so a nested pair wins", () => {
    const map = buildPrefixMap([
      { from: "/old", to: "/new", action: "renamed" },
      { from: "/old/clones", to: "/new/cache/clones", action: "renamed" },
    ]);
    expect(map[0].from).toBe("/old/clones");
  });

  it("fix-wave (#283 Critical 1): chains a same-directory state-tree rename into a later data-root move, resolving to the FINAL destination rather than the intermediate hop", () => {
    // Reviewer's exact repro shape: the journal holds BOTH
    // migrateStateTree's phase-4 same-directory normalization
    // (/legacy/repos -> /legacy/clones/watched) and the phase-5/6
    // data-root move of the renamed tree's new parent
    // (/legacy/clones -> /target/cache/clones). A stored value under
    // /legacy/repos matches the state-tree step FIRST; before this fix,
    // rewritePath applied exactly that one hop and stopped, landing the
    // value inside /legacy — the exact root this same run then deletes.
    const map = buildPrefixMap([
      { from: "/legacy/repos", to: "/legacy/clones/watched", action: "renamed" },
      { from: "/legacy/clones", to: "/target/cache/clones", action: "renamed" },
    ]);
    const repos = map.find((p) => p.from === "/legacy/repos");
    expect(repos?.to).toBe("/target/cache/clones/watched");

    // And a single rewritePath call against the closed map now lands a
    // stale value on the true final path in one hop — not the
    // intermediate /legacy/clones/watched/acme/repo.
    expect(rewritePath("/legacy/repos/acme/repo", map)).toBe(
      "/target/cache/clones/watched/acme/repo",
    );
  });

  it("bounds chain resolution and warns rather than looping when the journal contains a cycle", () => {
    const warnings: string[] = [];
    const map = buildPrefixMap(
      [
        { from: "/a", to: "/b", action: "renamed" },
        { from: "/b", to: "/a", action: "renamed" },
      ],
      warnings,
    );
    // Resolution stops rather than looping forever or picking an arbitrary
    // value — each entry is left at its own last non-cyclic (one-hop) value.
    expect(map).toEqual(
      expect.arrayContaining([
        { from: "/a", to: "/b" },
        { from: "/b", to: "/a" },
      ]),
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /cycle/i.test(w))).toBe(true);
  });
});

describe("dedupeSteps", () => {
  it("drops an exact (from, to, action) repeat while keeping the first occurrence", () => {
    const steps = [
      { from: "/old/clones", to: "/new/cache/clones", action: "renamed" as const },
      { from: "/old/clones", to: "/new/cache/clones", action: "renamed" as const },
    ];
    expect(dedupeSteps(steps)).toEqual([
      { from: "/old/clones", to: "/new/cache/clones", action: "renamed" },
    ]);
  });

  it("keeps steps that differ in any one of from/to/action", () => {
    const steps = [
      { from: "/old/a", to: "/new/a", action: "renamed" as const },
      { from: "/old/a", to: "/new/a", action: "skipped-conflict" as const },
      { from: "/old/b", to: "/new/a", action: "renamed" as const },
      { from: "/old/a", to: "/new/b", action: "renamed" as const },
    ];
    expect(dedupeSteps(steps)).toHaveLength(4);
  });
});

describe("rewritePath", () => {
  const map = [{ from: "/old/clones", to: "/new/cache/clones" }];

  it("rewrites a path under a moved prefix", () => {
    expect(rewritePath("/old/clones/o/r", map)).toBe("/new/cache/clones/o/r");
  });

  it("rewrites the prefix itself", () => {
    expect(rewritePath("/old/clones", map)).toBe("/new/cache/clones");
  });

  it("returns null for a path outside every prefix", () => {
    expect(rewritePath("/home/me/dev/foo", map)).toBeNull();
  });

  it("does not match a sibling that merely shares a string prefix", () => {
    expect(rewritePath("/old/clones-backup/x", map)).toBeNull();
  });

  it("is idempotent — an already-rewritten path is left alone", () => {
    expect(rewritePath("/new/cache/clones/o/r", map)).toBeNull();
  });
});

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "junco-mpr-"));
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function realDeps(): RewriteDeps {
  return {
    readFileFn: (p) => readFileSync(p, "utf8"),
    writeFileFn: (p, s) => writeFileSync(p, s, "utf8"),
    readdirFn: (d) => readdirSync(d),
    existsFn: (p) => existsSync(p),
    renameFn: (from, to) => renameSync(from, to),
  };
}

describe("rewriteStoredPaths", () => {
  it("does nothing when the map is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-mpr-"));
    roots.push(root);
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: { inbox: "x", processing: "x", done: "x", failed: "x" } },
      [],
      realDeps(),
    );
    expect(report).toEqual({ rewritten: 0, files: [], warnings: [] });
  });

  it("fix-wave (#283 Critical 1): a watchlist entry AND ticket that predate state-tree normalization land on the FINAL destination, not the legacy root this run then removes", () => {
    // Reviewer's real-filesystem repro, reproduced against the pure
    // functions here: a value under the pre-unification `/legacy/repos`
    // matches the state-tree same-directory step (journaled by phase 4)
    // BEFORE the data-root move (/legacy/clones -> target). A one-hop
    // rewrite (the pre-fix behaviour) would land it at
    // /legacy/clones/watched/acme/repo — still inside /legacy, which the
    // same migrate run then deletes — with the receipt still claiming
    // success.
    const root = freshRoot();
    roots.push(root);
    const watchlistFile = join(root, "watchlist.json");
    const staleRepo = "/legacy/repos/acme/repo";
    const entries: WatchlistEntry[] = [{ nwo: "acme/repo", path: staleRepo }];
    writeFileSync(watchlistFile, JSON.stringify(entries, null, 2) + "\n", "utf8");

    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    writeFileSync(
      ticketPath,
      "---\n" + "id: t1\n" + `repo: ${JSON.stringify(staleRepo)}\n` + "---\nbody\n",
      "utf8",
    );

    const map = buildPrefixMap([
      { from: "/legacy/repos", to: "/legacy/clones/watched", action: "renamed" },
      { from: "/legacy/clones", to: join(root, "cache", "clones"), action: "renamed" },
    ]);

    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: { inbox, processing: "/nope1", done: "/nope2", failed: "/nope3" },
      },
      map,
      realDeps(),
    );

    const finalRepo = join(root, "cache", "clones", "watched", "acme", "repo");
    const intermediateHop = "/legacy/clones/watched/acme/repo";

    expect(report.rewritten).toBe(2);
    expect(report.warnings).toEqual([]);

    const writtenWatchlist = JSON.parse(readFileSync(watchlistFile, "utf8")) as WatchlistEntry[];
    expect(writtenWatchlist).toEqual([{ nwo: "acme/repo", path: finalRepo }]);
    expect(writtenWatchlist[0].path).not.toBe(intermediateHop);

    const writtenTicket = readFileSync(ticketPath, "utf8");
    expect(writtenTicket).toContain(`repo: ${JSON.stringify(finalRepo)}`);
    expect(writtenTicket).not.toContain(intermediateHop);
  });

  it("rewrites a watchlist entry's path under a moved prefix and writes it back", () => {
    const root = freshRoot();
    roots.push(root);
    const watchlistFile = join(root, "watchlist.json");
    const entries: WatchlistEntry[] = [
      { nwo: "acme/repo", path: "/old/clones/watched/acme/repo" },
      { nwo: "other/repo", path: "/untouched/other/repo" },
    ];
    writeFileSync(watchlistFile, JSON.stringify(entries, null, 2) + "\n", "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: { inbox: "x", processing: "x", done: "x", failed: "x" } },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(1);
    expect(report.files).toEqual([watchlistFile]);
    expect(report.warnings).toEqual([]);

    const written = JSON.parse(readFileSync(watchlistFile, "utf8")) as WatchlistEntry[];
    expect(written).toEqual([
      { nwo: "acme/repo", path: join(root, "cache", "clones", "watched", "acme", "repo") },
      { nwo: "other/repo", path: "/untouched/other/repo" },
    ]);
  });

  it("leaves a corrupt watchlist untouched and warns rather than clobbering it", () => {
    const root = freshRoot();
    roots.push(root);
    const watchlistFile = join(root, "watchlist.json");
    writeFileSync(watchlistFile, "{ not json", "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: { inbox: "x", processing: "x", done: "x", failed: "x" } },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(0);
    expect(report.warnings.length).toBe(1);
    expect(readFileSync(watchlistFile, "utf8")).toBe("{ not json");
  });

  it("rewrites repo: and workdir: in a queue ticket, byte-preserving everything else", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const oldRepo = "/old/clones/watched/acme/repo";
    const raw =
      "---\n" +
      `id: t1\n` +
      `repo: ${JSON.stringify(oldRepo)}\n` +
      `workdir: ${JSON.stringify(oldRepo)}\n` +
      `priority: high\n` +
      "---\n" +
      "# Ticket body\n\nThis body mentions repo: casually, not as frontmatter.\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(2);
    expect(report.files).toEqual([ticketPath]);

    const newRepo = join(root, "cache", "clones", "watched", "acme", "repo");
    const written = readFileSync(ticketPath, "utf8");
    expect(written).toBe(
      "---\n" +
        `id: t1\n` +
        `repo: ${JSON.stringify(newRepo)}\n` +
        `workdir: ${JSON.stringify(newRepo)}\n` +
        `priority: high\n` +
        "---\n" +
        "# Ticket body\n\nThis body mentions repo: casually, not as frontmatter.\n",
    );
  });

  it("fix-wave (#283 Important 1a): rewrites unquoted repo:/workdir: — the shape junco's own SHIPPED templates and dispatch skill actually write (templates/task-code.md, skills/junco-dispatch/TEMPLATE.md, examples/*.md)", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const oldRepo = "/old/clones/watched/a/b";
    const raw =
      "---\n" +
      "id: t1\n" +
      `repo: ${oldRepo}\n` +
      `workdir: ${oldRepo}\n` +
      "priority: normal\n" +
      "---\n" +
      "Fix the thing.\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(2);
    expect(report.warnings).toEqual([]);
    const newRepo = join(root, "cache", "clones", "watched", "a", "b");
    expect(readFileSync(ticketPath, "utf8")).toBe(
      "---\n" +
        "id: t1\n" +
        `repo: ${newRepo}\n` +
        `workdir: ${newRepo}\n` +
        "priority: normal\n" +
        "---\n" +
        "Fix the thing.\n",
    );
  });

  it("fix-wave (#283 Important 1a): rewrites single-quoted repo:/workdir:, preserving the quoting style", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const oldRepo = "/old/clones/watched/a/b";
    const raw =
      "---\n" + "id: t1\n" + `repo: '${oldRepo}'\n` + `workdir: '${oldRepo}'\n` + "---\nbody\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(2);
    expect(report.warnings).toEqual([]);
    const newRepo = join(root, "cache", "clones", "watched", "a", "b");
    expect(readFileSync(ticketPath, "utf8")).toBe(
      "---\n" + "id: t1\n" + `repo: '${newRepo}'\n` + `workdir: '${newRepo}'\n` + "---\nbody\n",
    );
  });

  it("fix-wave (#283 Important 1b): warns (naming the file) on a genuinely unparseable value instead of silently reporting nothing", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    // Unterminated double-quote — junco's own emitters never write this, but
    // a hand-edited or corrupted ticket might. Before this fix, this exact
    // shape yielded `rewritten: 0` AND `warnings: []`: total silence on a
    // destructive migration.
    const raw = "---\n" + "id: t1\n" + `repo: "/old/clones/watched/a/b\n` + "---\nbody\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(0);
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/t1\.md/);
    expect(report.warnings[0]).toMatch(/repo/);
    expect(readFileSync(ticketPath, "utf8")).toBe(raw); // never guessed at
  });

  it("fix-wave (#283 Important 1b): rewrites the parseable field and warns for the unparseable one, in the same ticket", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const oldRepo = "/old/clones/watched/a/b";
    const raw =
      "---\n" +
      "id: t1\n" +
      `repo: "${oldRepo}\n` + // malformed: unterminated double quote
      `workdir: ${oldRepo}\n` + // plain — parseable, should rewrite
      "---\nbody\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(1); // only workdir:
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/repo/);
    const newRepo = join(root, "cache", "clones", "watched", "a", "b");
    const written = readFileSync(ticketPath, "utf8");
    expect(written).toContain(`workdir: ${newRepo}`);
    expect(written).toContain(`repo: "${oldRepo}`); // left untouched
  });

  it("fix-wave (#283 Minor 2): a bare repo: with no value is a YAML null, not a broken value — no warning", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const raw =
      "---\n" + "id: t1\n" + "repo:\n" + `workdir: /old/clones/watched/a/b\n` + "---\nbody\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(1); // workdir: only
    expect(report.warnings).toEqual([]); // bare repo: is silent, not a warning
    const newRepo = join(root, "cache", "clones", "watched", "a", "b");
    const written = readFileSync(ticketPath, "utf8");
    expect(written).toContain("repo:\n"); // untouched
    expect(written).toContain(`workdir: ${newRepo}`);
  });

  it("fix-wave (#283 Minor 3): expands a tilde repo: value (the shape junco's SHIPPED templates write) so it matches a moved prefix and rewrites to an absolute path", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const home = homedir();
    const raw = "---\n" + "id: t1\n" + "repo: ~/code/example-app\n" + "---\nbody\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: join(home, "code"), to: join(root, "cache", "code") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(1);
    expect(report.warnings).toEqual([]);
    const newRepo = join(root, "cache", "code", "example-app");
    expect(readFileSync(ticketPath, "utf8")).toContain(`repo: ${newRepo}`);
  });

  it("fix-wave (#283 Minor 3): a tilde repo: value outside every moved prefix is left exactly as written (rule 2 — not this phase's business)", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const raw = "---\n" + "id: t1\n" + "repo: ~/dev/unrelated-project\n" + "---\nbody\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      realDeps(),
    );

    expect(report).toEqual({ rewritten: 0, files: [], warnings: [] });
    expect(readFileSync(ticketPath, "utf8")).toBe(raw);
  });

  it("fix-wave (#283 Important I1): writes a rewritten ticket via tmp+rename, not a bare truncating write", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const oldRepo = "/old/clones/watched/a/b";
    writeFileSync(ticketPath, "---\n" + "id: t1\n" + `repo: ${oldRepo}\n` + "---\nbody\n", "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const seenWrites: string[] = [];
    const seenRenames: Array<[string, string]> = [];
    const deps: RewriteDeps = {
      ...realDeps(),
      writeFileFn: (p, s) => {
        seenWrites.push(p);
        writeFileSync(p, s, "utf8");
      },
      renameFn: (from, to) => {
        seenRenames.push([from, to]);
        renameSync(from, to);
      },
    };
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      deps,
    );

    expect(report.rewritten).toBe(1);
    // Written to a tmp path (not the ticket path itself), then renamed onto it.
    expect(seenWrites).toEqual([expect.stringMatching(/\.t1\.md\.tmp-\d+$/)]);
    expect(seenRenames).toEqual([[seenWrites[0], ticketPath]]);
    expect(readFileSync(ticketPath, "utf8")).toContain(
      `repo: ${join(root, "cache", "clones", "watched", "a", "b")}`,
    );
  });

  it("fix-wave (#283 Important I1): a rewritten JSON record and outbox op are ALSO written via tmp+rename", () => {
    const root = freshRoot();
    roots.push(root);
    const oldRepo = "/old/clones/watched/acme/repo";

    const assessDir = join(root, "review", "assess");
    mkdirSync(assessDir, { recursive: true });
    const batchFile = join(assessDir, "batch1.json");
    writeFileSync(
      batchFile,
      JSON.stringify({ id: "b1", nwo: "acme/repo", repoPath: oldRepo }, null, 2) + "\n",
      "utf8",
    );

    const outboxDir = join(root, "data", "outbox");
    mkdirSync(outboxDir, { recursive: true });
    const pushFile = join(outboxDir, "1-push.json");
    writeFileSync(
      pushFile,
      JSON.stringify(
        { id: "1-push", op: { kind: "push", repoPath: oldRepo, branch: "x" } },
        null,
        2,
      ),
      "utf8",
    );

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const seenRenames: Array<[string, string]> = [];
    const deps: RewriteDeps = {
      ...realDeps(),
      renameFn: (from, to) => {
        seenRenames.push([from, to]);
        renameSync(from, to);
      },
    };
    const report = rewriteStoredPaths({ targetRoot: root, queuePaths: emptyQueuePaths }, map, deps);

    expect(report.rewritten).toBe(2);
    const renamedTo = seenRenames.map(([, to]) => to).sort();
    expect(renamedTo).toEqual([batchFile, pushFile].sort());
    for (const [from] of seenRenames) {
      expect(from).toMatch(/\.tmp-\d+$/);
    }
  });

  it("fix-wave (#283 Important I1): a rename failure surfaces as a receipt warning, not a throw", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const raw = "---\n" + "id: t1\n" + "repo: /old/clones/watched/a/b\n" + "---\nbody\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const deps: RewriteDeps = {
      ...realDeps(),
      renameFn: () => {
        throw new Error("EIO: rename failed");
      },
    };
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      deps,
    );

    expect(report.rewritten).toBe(0);
    expect(report.files).toEqual([]);
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/write failed/);
    expect(readFileSync(ticketPath, "utf8")).toBe(raw); // never partially written
  });

  it("warns when readdirFn throws on an existing queue dir and continues rather than throwing", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true }); // exists — readdirFn will be called
    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const deps: RewriteDeps = {
      ...realDeps(),
      readdirFn: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      deps,
    );

    expect(report.rewritten).toBe(0);
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/inbox/);
  });

  it("is idempotent — rewriting an already-rewritten ticket a second time is a no-op", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    const ticketPath = join(inbox, "t1.md");
    const newRepo = join(root, "cache", "clones", "watched", "acme", "repo");
    const raw = "---\n" + `id: t1\n` + `repo: ${JSON.stringify(newRepo)}\n` + "---\nbody\n";
    writeFileSync(ticketPath, raw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(0);
    expect(report.files).toEqual([]);
    expect(readFileSync(ticketPath, "utf8")).toBe(raw);
  });

  it("warns on an unreadable ticket file and continues rather than throwing", () => {
    const root = freshRoot();
    roots.push(root);
    const inbox = join(root, "queue", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "bad.md"), '---\nrepo: "/old/clones/x"\n---\nbody\n', "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const deps: RewriteDeps = {
      ...realDeps(),
      readFileFn: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox,
          processing: join(root, "nope1"),
          done: join(root, "nope2"),
          failed: join(root, "nope3"),
        },
      },
      map,
      deps,
    );

    expect(report.rewritten).toBe(0);
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/bad\.md/);
  });

  it("skips a queue dir that does not exist without warning", () => {
    const root = freshRoot();
    roots.push(root);
    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      {
        targetRoot: root,
        queuePaths: {
          inbox: join(root, "queue", "inbox"),
          processing: join(root, "queue", "processing"),
          done: join(root, "queue", "done"),
          failed: join(root, "queue", "failed"),
        },
      },
      map,
      realDeps(),
    );
    expect(report).toEqual({ rewritten: 0, files: [], warnings: [] });
  });

  const emptyQueuePaths = {
    inbox: "/nope1",
    processing: "/nope2",
    done: "/nope3",
    failed: "/nope4",
  };

  it("rewrites a pending assess batch's repoPath under review/assess, preserving every other field", () => {
    const root = freshRoot();
    roots.push(root);
    const dir = join(root, "review", "assess");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "batch1.json");
    const oldRepo = "/old/clones/watched/acme/repo";
    const batch = {
      id: "assess-acme-repo-1",
      nwo: "acme/repo",
      external: false,
      autoPlan: false,
      repoPath: oldRepo,
      createdAt: "2026-01-01T00:00:00.000Z",
      findings: [{ title: "x" }],
    };
    writeFileSync(file, JSON.stringify(batch, null, 2) + "\n", "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: emptyQueuePaths },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(1);
    expect(report.files).toEqual([file]);
    expect(report.warnings).toEqual([]);

    const newRepo = join(root, "cache", "clones", "watched", "acme", "repo");
    expect(readFileSync(file, "utf8")).toBe(
      JSON.stringify({ ...batch, repoPath: newRepo }, null, 2) + "\n",
    );
  });

  it("rewrites a pending comment draft's repoPath under review/comments", () => {
    const root = freshRoot();
    roots.push(root);
    const dir = join(root, "review", "comments");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "draft1.json");
    const oldRepo = "/old/clones/watched/acme/repo";
    const draft = {
      id: "analyze-acme-repo-1",
      nwo: "acme/repo",
      issue: 42,
      issueTitle: "Something",
      external: false,
      repoPath: oldRepo,
      createdAt: "2026-01-01T00:00:00.000Z",
      draft: "body text",
      footer: true,
    };
    writeFileSync(file, JSON.stringify(draft, null, 2) + "\n", "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: emptyQueuePaths },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(1);
    expect(report.files).toEqual([file]);
    const newRepo = join(root, "cache", "clones", "watched", "acme", "repo");
    expect(readFileSync(file, "utf8")).toBe(
      JSON.stringify({ ...draft, repoPath: newRepo }, null, 2) + "\n",
    );
  });

  it("rewrites a plan-set record's repoPath under data/plans, leaving its sibling .md file alone", () => {
    const root = freshRoot();
    roots.push(root);
    const dir = join(root, "data", "plans");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "plan1.json");
    const oldRepo = "/old/clones/watched/acme/repo";
    const record = {
      v: 1,
      planId: "plan1",
      hash: "abc123",
      repoPath: oldRepo,
      github: { nwo: "acme/repo", issue: 7 },
      tasks: [{ id: "t1", ticketId: "plan1-t1", dependsOn: [] }],
      createdAt: "2026-01-01T00:00:00.000Z",
      statusCommentId: null,
      degradedPosted: false,
      lastLabel: null,
      closed: false,
    };
    writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
    const mdFile = join(dir, "plan1.md");
    writeFileSync(mdFile, "# plan body\n", "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: emptyQueuePaths },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(1);
    expect(report.files).toEqual([file]);
    const newRepo = join(root, "cache", "clones", "watched", "acme", "repo");
    expect(readFileSync(file, "utf8")).toBe(
      JSON.stringify({ ...record, repoPath: newRepo }, null, 2) + "\n",
    );
    expect(readFileSync(mdFile, "utf8")).toBe("# plan body\n");
  });

  it("rewrites push/pr outbox ops' repoPath, leaves labels/comment/issue-create untouched, and scans dead/ too", () => {
    const root = freshRoot();
    roots.push(root);
    const dir = join(root, "data", "outbox");
    const deadDir = join(dir, "dead");
    mkdirSync(deadDir, { recursive: true });
    const oldRepo = "/old/clones/watched/acme/repo";

    const pushOp = {
      id: "1-0000-aaaa-push",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: "prflow",
      issueKey: null,
      attempts: 0,
      lastError: null,
      op: { kind: "push", repoPath: oldRepo, branch: "feat/x" },
    };
    const pushFile = join(dir, "1-0000-aaaa-push.json");
    // Outbox ops serialize WITHOUT a trailing newline (enqueueOp/flushOutbox).
    writeFileSync(pushFile, JSON.stringify(pushOp, null, 2), "utf8");

    const prOp = {
      id: "2-0000-bbbb-pr",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: "prflow",
      issueKey: "acme/repo#3",
      attempts: 0,
      lastError: null,
      op: {
        kind: "pr",
        repoPath: oldRepo,
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
    const prFile = join(dir, "2-0000-bbbb-pr.json");
    writeFileSync(prFile, JSON.stringify(prOp, null, 2), "utf8");

    const labelsOp = {
      id: "3-0000-cccc-labels",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: "dashboard",
      issueKey: "acme/repo#4",
      attempts: 0,
      lastError: null,
      op: { kind: "labels", nwo: "acme/repo", issue: 4, add: ["x"], remove: [] },
    };
    const labelsFile = join(dir, "3-0000-cccc-labels.json");
    const labelsRaw = JSON.stringify(labelsOp, null, 2);
    writeFileSync(labelsFile, labelsRaw, "utf8");

    const deadOp = {
      id: "4-0000-dddd-push",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: "prflow",
      issueKey: null,
      attempts: 3,
      lastError: "boom",
      op: { kind: "push", repoPath: oldRepo, branch: "feat/y" },
    };
    const deadFile = join(deadDir, "4-0000-dddd-push.json");
    writeFileSync(deadFile, JSON.stringify(deadOp, null, 2), "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: emptyQueuePaths },
      map,
      realDeps(),
    );

    const newRepo = join(root, "cache", "clones", "watched", "acme", "repo");
    expect(report.rewritten).toBe(3); // push, pr, dead push — not labels
    expect(report.files.sort()).toEqual([deadFile, prFile, pushFile].sort());
    expect(report.warnings).toEqual([]);

    // No trailing newline on the rewritten files either — matches every
    // outbox writer's own serialisation.
    expect(readFileSync(pushFile, "utf8")).toBe(
      JSON.stringify({ ...pushOp, op: { ...pushOp.op, repoPath: newRepo } }, null, 2),
    );
    expect(readFileSync(prFile, "utf8")).toBe(
      JSON.stringify({ ...prOp, op: { ...prOp.op, repoPath: newRepo } }, null, 2),
    );
    expect(readFileSync(deadFile, "utf8")).toBe(
      JSON.stringify({ ...deadOp, op: { ...deadOp.op, repoPath: newRepo } }, null, 2),
    );
    // labels op is byte-identical — untouched, not even rewritten.
    expect(readFileSync(labelsFile, "utf8")).toBe(labelsRaw);
  });

  it("leaves a record's repoPath alone when it points somewhere junco never moved (guard)", () => {
    const root = freshRoot();
    roots.push(root);
    const assessDir = join(root, "review", "assess");
    mkdirSync(assessDir, { recursive: true });
    const batchFile = join(assessDir, "batch1.json");
    const untouchedRepo = "/home/me/dev/foo";
    const batch = {
      id: "assess-foo-1",
      nwo: "me/foo",
      external: true,
      autoPlan: false,
      repoPath: untouchedRepo,
      createdAt: "2026-01-01T00:00:00.000Z",
      findings: [],
    };
    const batchRaw = JSON.stringify(batch, null, 2) + "\n";
    writeFileSync(batchFile, batchRaw, "utf8");

    const outboxDir = join(root, "data", "outbox");
    mkdirSync(outboxDir, { recursive: true });
    const pushFile = join(outboxDir, "1-0000-aaaa-push.json");
    const pushOp = {
      id: "1-0000-aaaa-push",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: "prflow",
      issueKey: null,
      attempts: 0,
      lastError: null,
      op: { kind: "push", repoPath: untouchedRepo, branch: "feat/x" },
    };
    const pushRaw = JSON.stringify(pushOp, null, 2);
    writeFileSync(pushFile, pushRaw, "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: emptyQueuePaths },
      map,
      realDeps(),
    );

    expect(report).toEqual({ rewritten: 0, files: [], warnings: [] });
    expect(readFileSync(batchFile, "utf8")).toBe(batchRaw);
    expect(readFileSync(pushFile, "utf8")).toBe(pushRaw);
  });

  it("warns on a corrupt plan-set record and leaves it untouched, continuing the migration", () => {
    const root = freshRoot();
    roots.push(root);
    const dir = join(root, "data", "plans");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ not json", "utf8");

    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: emptyQueuePaths },
      map,
      realDeps(),
    );

    expect(report.rewritten).toBe(0);
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/bad\.json/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("skips review/assess, review/comments, data/plans, and data/outbox dirs that don't exist yet, without warning", () => {
    const root = freshRoot();
    roots.push(root);
    const map = [{ from: "/old/clones", to: join(root, "cache", "clones") }];
    const report = rewriteStoredPaths(
      { targetRoot: root, queuePaths: emptyQueuePaths },
      map,
      realDeps(),
    );
    expect(report).toEqual({ rewritten: 0, files: [], warnings: [] });
  });
});
