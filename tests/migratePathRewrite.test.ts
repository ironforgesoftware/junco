/**
 * Tests for src/migratePathRewrite.ts — the #283 fix: `junco data migrate`
 * moves files but never the absolute paths recorded inside them (watchlist
 * `path`, ticket `repo:`/`workdir:`). Pure-helper tests are the brief's
 * exact fixtures (task-2-brief.md Step 1); `rewriteStoredPaths` tests use
 * real mkdtempSync tmp roots, matching tests/dataMigrateCmd.test.ts's style.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrefixMap,
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
});
