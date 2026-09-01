import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ticketState, findTicketFile, sweepDependencies, listWaiting } from "../src/ticketDeps.js";
import { parseTicket } from "../src/ticket.js";
import { parseResultMeta } from "../src/resultMeta.js";
import { log } from "../src/logging.js";
import { makeConfig, type ConfigSeams } from "./helpers/config.js";
import type { Config, Paths } from "../src/types.js";

let root: string;
let paths: Paths;
let seams: ConfigSeams;
let cfg: Config;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "junco-deps-"));
  paths = {
    inbox: join(root, "inbox"),
    processing: join(root, "processing"),
    done: join(root, "done"),
    failed: join(root, "failed"),
  };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
  seams = {
    dataDir: join(root, "data"),
    queueRoot: root,
    worktreeRoot: join(root, "wt"),
    tools: [],
    criticEnabled: false,
    planLintEnabled: false,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: true,
  };
  cfg = makeConfig(seams);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ticketState", () => {
  it("absent when the id is nowhere", () => {
    expect(ticketState(paths, "t1")).toBe("absent");
  });

  it("resolves each directory by exact filename", () => {
    writeFileSync(join(paths.inbox, "t1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("inbox");
  });

  it("matches through the claim-stamp prefix", () => {
    writeFileSync(join(paths.processing, "2026-08-20T1200Z__t1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("processing");
  });

  it("matches worker suffixes: -r1 (requeue) and -2 (uniqueDest)", () => {
    writeFileSync(join(paths.inbox, "t1-r1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("inbox");
    rmSync(join(paths.inbox, "t1-r1.md"));
    writeFileSync(join(paths.done, "2026-08-20T1200Z__t1-2.md"), "x");
    expect(ticketState(paths, "t1")).toBe("done");
  });

  it("does NOT match a different id sharing a prefix", () => {
    writeFileSync(join(paths.done, "t1-extra.md"), "x");
    expect(ticketState(paths, "t1")).toBe("absent");
  });

  it("precedence: done > processing > inbox > failed (satisfaction is monotone)", () => {
    writeFileSync(join(paths.failed, "t1.md"), "x");
    writeFileSync(join(paths.inbox, "t1-r1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("inbox");
    writeFileSync(join(paths.done, "2026-08-20T1200Z__t1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("done");
  });

  it("findTicketFile returns the matched path", () => {
    const p = join(paths.done, "2026-08-20T1200Z__t1.md");
    writeFileSync(p, "x");
    expect(findTicketFile(paths.done, "t1")).toBe(p);
  });

  it("rethrows ENOTDIR when a queue dir path is a file, not a directory", () => {
    // Create a FILE where a directory is expected
    rmSync(paths.done, { recursive: true, force: true });
    writeFileSync(paths.done, "x");
    // ticketState should throw ENOTDIR, not silently return "absent"
    expect(() => ticketState(paths, "t1")).toThrow(/ENOTDIR/);
  });

  it("missing queue directory resolves to absent", () => {
    // Delete the directory
    rmSync(paths.done, { recursive: true, force: true });
    // Should resolve to "absent" (not throw), since ENOENT is expected
    expect(ticketState(paths, "t1")).toBe("absent");
  });
});

describe("sweepDependencies — satisfaction stamping", () => {
  it("no-PR parent in done/ → stamps deps_satisfied", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nBody\n\n---\n<!-- junco-result\nstatus: completed\n-->\n\n## Result\n\nok\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(cfg);
    expect(r.stamped).toBe(1);
    const t = parseTicket("child.md", readFileSync(join(paths.inbox, "child.md"), "utf8"));
    expect(t.depsSatisfied).toEqual(["parent"]);
  });

  it("does not satisfy an edge whose dependency has a queued (not yet opened) offline PR", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_queued: true\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(cfg, { prStateFn: async () => "open" });
    expect(r.stamped).toBe(0);
    expect(existsSync(join(paths.inbox, "child.md"))).toBe(true);
  });

  it("still satisfies an edge whose dependency finished with no PR at all (Q&A ticket)", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(cfg, { prStateFn: async () => "open" });
    expect(r.stamped).toBe(1);
  });

  it("parent with pr_url → merged stamps, open waits", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const open = await sweepDependencies(cfg, { prStateFn: async () => "open" });
    expect(open.stamped).toBe(0);
    const merged = await sweepDependencies(cfg, { prStateFn: async () => "merged" });
    expect(merged.stamped).toBe(1);
  });

  it("unknown PR state (gh error) → waits, never cascades", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(cfg, { prStateFn: async () => "unknown" });
    expect(r).toEqual({ stamped: 0, cascaded: 0 });
    expect(existsSync(join(paths.inbox, "child.md"))).toBe(true);
  });

  it("absent / queued / in-flight dep → waits; ticket with no edges → no-op", async () => {
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [ghost]\n---\n");
    writeFileSync(join(paths.inbox, "plain.md"), "---\nid: plain\n---\n");
    const r = await sweepDependencies(cfg);
    expect(r).toEqual({ stamped: 0, cascaded: 0 });
  });

  it("default prStateFn shells the configured ghBin and maps MERGED", async () => {
    const fakeGh = join(root, "gh");
    writeFileSync(fakeGh, `#!/bin/sh\necho '{"state":"MERGED"}'\n`, { mode: 0o755 });
    const ghCfg = makeConfig(seams, { ghBin: fakeGh });
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(ghCfg);
    expect(r.stamped).toBe(1);
  });

  it("gh probe exiting nonzero warns once and the ticket stays in inbox waiting", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const fakeGh = join(root, "gh-fail");
      writeFileSync(fakeGh, `#!/bin/sh\necho 'gh: auth error' >&2\nexit 1\n`, { mode: 0o755 });
      const ghCfg = makeConfig(seams, { ghBin: fakeGh });
      writeFileSync(
        join(paths.done, "parent.md"),
        "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
      );
      writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
      const r = await sweepDependencies(ghCfg);
      expect(r).toEqual({ stamped: 0, cascaded: 0 });
      expect(existsSync(join(paths.inbox, "child.md"))).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [msg, meta] = warnSpy.mock.calls[0]!;
      expect(String(msg)).toMatch(/PR state probe failed/);
      expect(meta).toMatchObject({ pr: "https://github.com/a/b/pull/7" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("gh probe returning bad JSON warns once and the ticket stays in inbox waiting", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const fakeGh = join(root, "gh-badjson");
      writeFileSync(fakeGh, `#!/bin/sh\necho 'not json'\n`, { mode: 0o755 });
      const ghCfg = makeConfig(seams, { ghBin: fakeGh });
      writeFileSync(
        join(paths.done, "parent.md"),
        "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
      );
      writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
      const r = await sweepDependencies(ghCfg);
      expect(r).toEqual({ stamped: 0, cascaded: 0 });
      expect(existsSync(join(paths.inbox, "child.md"))).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toMatch(/PR state probe failed/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("legitimate open/merged/closed PR states never warn", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      writeFileSync(
        join(paths.done, "parent.md"),
        "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
      );
      writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
      await sweepDependencies(cfg, { prStateFn: async () => "open" });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("two dependents on the same failing PR warn only once per sweep (prCache dedup)", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const fakeGh = join(root, "gh-fail-shared");
      writeFileSync(fakeGh, `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
      const ghCfg = makeConfig(seams, { ghBin: fakeGh });
      writeFileSync(
        join(paths.done, "parent.md"),
        "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
      );
      writeFileSync(join(paths.inbox, "c1.md"), "---\nid: c1\ndepends_on: [parent]\n---\n");
      writeFileSync(join(paths.inbox, "c2.md"), "---\nid: c2\ndepends_on: [parent]\n---\n");
      const r = await sweepDependencies(ghCfg);
      expect(r).toEqual({ stamped: 0, cascaded: 0 });
      const probeWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("PR state probe failed"),
      );
      expect(probeWarnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("two deps resolved in the same pass both stamp, without clobbering (regression)", async () => {
    writeFileSync(
      join(paths.done, "p1.md"),
      "---\nid: p1\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
    );
    writeFileSync(
      join(paths.done, "p2.md"),
      "---\nid: p2\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [p1, p2]\n---\n");
    const r = await sweepDependencies(cfg);
    expect(r.stamped).toBe(2);
    const t = parseTicket("child.md", readFileSync(join(paths.inbox, "child.md"), "utf8"));
    expect([...t.depsSatisfied].sort()).toEqual(["p1", "p2"]);
  });

  it("a dep id that doesn't round-trip through the flow-array upsert is left unconfirmed", async () => {
    // "a,b" is a valid plain YAML scalar in block context (frontmatter `id:`
    // and a quoted `depends_on` entry), but stampSatisfied's upsert writes
    // deps_satisfied as an UNQUOTED flow sequence — `[a,b]` re-parses as two
    // items ["a","b"], not one item "a,b". The post-write verify must catch
    // that and decline to write, leaving the edge unconfirmed forever (rather
    // than looping or silently reporting a stamp that never happened).
    writeFileSync(
      join(paths.done, "a,b.md"),
      "---\nid: a,b\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), '---\nid: child\ndepends_on: ["a,b"]\n---\n');
    const r = await sweepDependencies(cfg);
    expect(r).toEqual({ stamped: 0, cascaded: 0 });
    expect(existsSync(join(paths.inbox, "child.md"))).toBe(true);
    const t = parseTicket("child.md", readFileSync(join(paths.inbox, "child.md"), "utf8"));
    expect(t.depsSatisfied).toEqual([]);
  });
});

describe("sweepDependencies — failure cascade", () => {
  it("failed dep → dependent finalized to failed/ with dependency_failed marker", async () => {
    writeFileSync(join(paths.failed, "parent.md"), "---\nid: parent\n---\n");
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\nBody");
    const r = await sweepDependencies(cfg);
    expect(r.cascaded).toBe(1);
    expect(existsSync(join(paths.inbox, "child.md"))).toBe(false);
    const rec = readFileSync(join(paths.failed, "child.md"), "utf8");
    expect(parseResultMeta(rec).status).toBe("failed");
    expect(parseResultMeta(rec).dependencyFailed).toBe("parent");
  });

  it("cascade is transitive within one sweep", async () => {
    writeFileSync(join(paths.failed, "a.md"), "---\nid: a\n---\n");
    writeFileSync(join(paths.inbox, "b.md"), "---\nid: b\ndepends_on: [a]\n---\n");
    writeFileSync(join(paths.inbox, "c.md"), "---\nid: c\ndepends_on: [b]\n---\n");
    const r = await sweepDependencies(cfg);
    expect(r.cascaded).toBe(2);
    expect(parseResultMeta(readFileSync(join(paths.failed, "c.md"), "utf8")).dependencyFailed).toBe(
      "b",
    );
  });

  it("PR closed without merge → cascade", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(cfg, { prStateFn: async () => "closed" });
    expect(r.cascaded).toBe(1);
    expect(findTicketFile(paths.failed, "child")).not.toBeNull();
  });
});

describe("listWaiting", () => {
  it("reports pending and missing edges per waiting ticket", () => {
    writeFileSync(join(paths.done, "a.md"), "---\nid: a\n---\n");
    writeFileSync(join(paths.inbox, "w.md"), "---\nid: w\ndepends_on: [a, ghost]\n---\n");
    expect(listWaiting(cfg)).toEqual([{ id: "w", pending: ["a", "ghost"], missing: ["ghost"] }]);
  });

  it("forwards parseTicket's both-keys collision warning to the structured log", () => {
    // readWaiting (internal, used by both listWaiting and sweepDependencies)
    // passes log.warn as parseTicket's warnFn — a ticket carrying both the
    // canonical and legacy key for the same flavor must land in worker.log
    // (JSON lines), not as a bare console.warn that would break `junco logs
    // --json`/the TUI log viewer's parse of that stream.
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      writeFileSync(
        join(paths.inbox, "child.md"),
        "---\nid: child\ndepends_on: [ghost]\naudit:\n  auto_plan: true\nassess:\n  auto_plan: false\n---\n",
      );
      listWaiting(cfg);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [msg] = warnSpy.mock.calls[0]!;
      expect(String(msg)).toMatch(/audit/);
      expect(String(msg)).toMatch(/assess/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("readWaiting error stance (internal, via sweepDependencies/listWaiting)", () => {
  it("missing inbox dir (ENOENT) resolves to no waiting tickets, not a throw", async () => {
    rmSync(paths.inbox, { recursive: true, force: true });
    expect(await sweepDependencies(cfg)).toEqual({ stamped: 0, cascaded: 0 });
    expect(listWaiting(cfg)).toEqual([]);
  });

  it("rethrows ENOTDIR when the inbox path is a file, not a directory", async () => {
    rmSync(paths.inbox, { recursive: true, force: true });
    writeFileSync(paths.inbox, "x");
    await expect(sweepDependencies(cfg)).rejects.toThrow(/ENOTDIR/);
    expect(() => listWaiting(cfg)).toThrow(/ENOTDIR/);
  });
});
