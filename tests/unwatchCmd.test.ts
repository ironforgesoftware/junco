import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "./helpers/config.js";
import { writeWatchlist, readWatchlist, type WatchlistEntry } from "../src/watchlist.js";
import { dataTreePaths } from "../src/dataTree.js";
import type { Config } from "../src/types.js";
import {
  isUnder,
  planUnwatch,
  runUnwatch,
  githubCacheFilesFor,
  type UnwatchPlan,
} from "../src/unwatchCmd.js";
import { repoDiscriminator } from "../src/worktree.js";
import { enqueueOp } from "../src/githubOutbox.js";
import { writePending } from "../src/assessReview.js";
import { writeDraft } from "../src/commentReview.js";
import { recordRun, historyFilePath } from "../src/assessHistory.js";
import { cachePathFor, prCachePathFor } from "../src/tui/ghClient.js";

/** Tmpdir data tree + full Config. `configRepos` populates cfg.github.repos. */
function makeTree(opts: { configRepos?: { nwo: string; path: string }[] } = {}): {
  root: string;
  cfg: Config;
} {
  const root = mkdtempSync(join(tmpdir(), "junco-unwatch-"));
  const cfg = makeConfig(
    {
      dataDir: join(root, "data"),
      queueRoot: join(root, "queue"),
      worktreeRoot: join(root, "worktrees"),
      tools: [],
      criticEnabled: false,
      planLintEnabled: false,
      verifyEnabled: false,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: false,
    },
    {
      github: {
        enabled: true,
        triggerLabel: "junco",
        askLabel: "junco:ask",
        pollIntervalSeconds: 60,
        repos: opts.configRepos ?? [],
        requireApproval: true,
        plannerModelId: null,
        externalReposRoot: join(root, "data", "cache", "clones", "external"),
      },
    },
  );
  mkdirSync(dataTreePaths(cfg).queue.inbox, { recursive: true });
  mkdirSync(dataTreePaths(cfg).queue.processing, { recursive: true });
  mkdirSync(cfg.worktreeRoot, { recursive: true });
  return { root, cfg };
}

/** Register `nwo` in the watchlist pointing at `path` (created on disk unless absent:true). */
function watch(
  cfg: Config,
  nwo: string,
  path: string,
  o: { external?: boolean; absent?: boolean } = {},
): void {
  if (!o.absent) mkdirSync(path, { recursive: true });
  const entry: WatchlistEntry = { nwo, path, ...(o.external ? { external: true } : {}) };
  const file = dataTreePaths(cfg).watchlistFile;
  writeWatchlist(file, [...readWatchlist(file).entries, entry]);
}

/** Minimal PR-flow ticket file. */
function writeTicket(dir: string, id: string, repoPath: string): string {
  const p = join(dir, `${id}.md`);
  writeFileSync(p, `---\nid: ${id}\nrepo: ${repoPath}\n---\n\nDo the thing.\n`, "utf8");
  return p;
}

describe("planUnwatch — refusals and clone classification", () => {
  it("refuses a config-defined repo", () => {
    const { cfg } = makeTree({ configRepos: [{ nwo: "acme/api", path: "/config/api" }] });
    expect(planUnwatch(cfg, "acme/api")).toEqual({ ok: false, reason: "config-defined" });
    expect(planUnwatch(cfg, "ACME/API")).toEqual({ ok: false, reason: "config-defined" }); // ci
  });

  it("refuses when the watchlist is unreadable", () => {
    const { cfg } = makeTree();
    const file = dataTreePaths(cfg).watchlistFile;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");
    expect(planUnwatch(cfg, "acme/api")).toEqual({ ok: false, reason: "watchlist-unreadable" });
  });

  it("classifies a clone under clones/watched as managed (deleted)", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("watched");
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
    expect(out.plan.items).toContainEqual({ kind: "clone", path: clone });
    expect(out.plan.kept).toEqual([]);
    expect(out.plan.blocked).toBeNull();
  });

  it("classifies a clone under externalReposRoot as managed, external flows through", () => {
    const { cfg } = makeTree();
    const clone = join(cfg.github.externalReposRoot, "acme", "api");
    watch(cfg, "acme/api", clone, { external: true });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.external).toBe(true);
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
  });

  it("keeps a user-supplied path — never a clone item", () => {
    const { root, cfg } = makeTree();
    const mine = join(root, "my-checkout");
    watch(cfg, "acme/api", mine);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.clone).toEqual({ path: mine, managed: false });
    expect(out.plan.items.filter((i) => i.kind === "clone")).toEqual([]);
    expect(out.plan.kept).toEqual([`clone (user-owned): ${mine}`]);
  });
});

describe("planUnwatch — queue and worktrees", () => {
  it("enumerates inbox tickets targeting the repo and skips others", () => {
    const { root, cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const inbox = dataTreePaths(cfg).queue.inbox;
    const mine = writeTicket(inbox, "fix-1", clone);
    writeTicket(inbox, "other-1", join(root, "elsewhere"));
    writeFileSync(join(inbox, "qa-1.md"), "---\nid: qa-1\n---\n\nQ&A, no repo.\n", "utf8");
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items.filter((i) => i.kind === "inbox-ticket")).toEqual([
      { kind: "inbox-ticket", path: mine, detail: "fix-1" },
    ]);
  });

  it("includes the worktree namespace dir when present", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items).toContainEqual({ kind: "worktrees", path: ns });
  });

  it("a processing/ ticket for the repo blocks; other repos' don't", () => {
    const { root, cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const processing = dataTreePaths(cfg).queue.processing;
    writeTicket(processing, "other-live", join(root, "elsewhere"));
    expect(
      (planUnwatch(cfg, "acme/api") as { ok: true; plan: UnwatchPlan }).plan.blocked,
    ).toBeNull();
    writeTicket(processing, "live-1", clone);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.blocked).toEqual({ ticketId: "live-1" });
  });
});

describe("isUnder", () => {
  it("prefix-compares with a separator guard on synthetic paths", () => {
    expect(isUnder("/sbxroot/clones/watched/a/b", "/sbxroot/clones/watched")).toBe(true);
    expect(isUnder("/sbxroot/clones/watched", "/sbxroot/clones/watched")).toBe(false);
    expect(isUnder("/sbxroot/clones/watched-evil/x", "/sbxroot/clones/watched")).toBe(false);
  });
});

describe("planUnwatch — nwo-keyed stores", () => {
  it("enumerates outbox ops by nwo and by push repoPath; dead/ untouched", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "ACME/api", issue: 7, body: "hi" });
    enqueueOp(cfg, "prflow", { kind: "push", repoPath: clone, branch: "feat/x" });
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "other/repo", issue: 1, body: "no" });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items.filter((i) => i.kind === "outbox-op")).toHaveLength(2);
  });

  it("enumerates pending reviews, assess history, mirror, github-cache", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    writePending(cfg, {
      id: "assess-acme-api",
      nwo: "acme/api",
      external: false,
      autoPlan: false,
      repoPath: clone,
      createdAt: "2026-08-19T00:00:00Z",
      findings: [],
    });
    writeDraft(cfg, {
      id: "analyze-acme-api-1",
      nwo: "acme/api",
      issue: 3,
      issueTitle: "Something broke",
      external: false,
      repoPath: clone,
      createdAt: "2026-08-19T00:00:00Z",
      draft: "Looks like a regression.",
      footer: true,
    });
    recordRun(cfg, "acme/api", { ok: true, at: "2026-08-19T00:00:00Z", found: 0, parked: 0 });
    mkdirSync(join(dataTreePaths(cfg).mirror, "acme", "api"), { recursive: true });
    mkdirSync(dataTreePaths(cfg).githubCache, { recursive: true });
    writeFileSync(cachePathFor(cfg, "acme/api"), "{}", "utf8");
    writeFileSync(prCachePathFor(cfg, "acme/api"), "{}", "utf8");
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    const kinds = out.plan.items.map((i) => i.kind);
    for (const k of ["assess-review", "comment-review", "assess-history", "mirror", "github-cache"])
      expect(kinds).toContain(k);
    expect(out.plan.items.filter((i) => i.kind === "github-cache")).toHaveLength(2);
  });

  it("github-cache naming never drifts from ghClient (pin)", () => {
    const { cfg } = makeTree();
    const out = githubCacheFilesFor(cfg, "acme/api");
    expect(out).toEqual([cachePathFor(cfg, "acme/api"), prCachePathFor(cfg, "acme/api")]);
  });

  it("assessHistory's historyFilePath matches what recordRun/planUnwatch see", () => {
    const { cfg } = makeTree();
    watch(cfg, "acme/api", join(dataTreePaths(cfg).clonesWatched, "acme", "api"));
    recordRun(cfg, "acme/api", { ok: true, at: "2026-08-19T00:00:00Z", found: 1, parked: 1 });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items).toContainEqual({
      kind: "assess-history",
      path: historyFilePath(cfg, "acme/api"),
    });
  });
});

describe("planUnwatch — residue mode (nwo not in watchlist)", () => {
  it("sweeps nwo-keyed traces and a leftover managed clone + its worktrees", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    mkdirSync(clone, { recursive: true });
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("residue");
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
    const kinds = out.plan.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["clone", "worktrees", "outbox-op"]));
  });

  it("no clone, no traces → empty plan (nothing to clean)", () => {
    const { cfg } = makeTree();
    const out = planUnwatch(cfg, "ghost/repo");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("residue");
    expect(out.plan.items).toEqual([]);
    expect(out.plan.clone).toBeNull();
  });

  it("a processing ticket targeting the residue clone blocks", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    mkdirSync(clone, { recursive: true });
    writeTicket(dataTreePaths(cfg).queue.processing, "live-9", clone);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.blocked).toEqual({ ticketId: "live-9" });
  });
});

describe("runUnwatch", () => {
  it("refuses blocked without deleting anything", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    writeTicket(dataTreePaths(cfg).queue.processing, "live-1", clone);
    const res = await runUnwatch(cfg, "acme/api");
    expect(res).toMatchObject({
      ok: false,
      refused: "blocked",
      blockedTicketId: "live-1",
      watchlistRemoved: false,
    });
    expect(readWatchlist(dataTreePaths(cfg).watchlistFile).entries).toHaveLength(1);
    expect(existsSync(clone)).toBe(true);
  });

  it("deletes watchlist entry first, clone last; user clone kept + git worktree prune", async () => {
    const { root, cfg } = makeTree();
    const mine = join(root, "my-checkout");
    watch(cfg, "acme/api", mine);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(mine));
    mkdirSync(ns, { recursive: true });
    const gitCalls: [string[], string][] = [];
    const res = await runUnwatch(cfg, "acme/api", {
      gitFn: async (args, cwd) => (gitCalls.push([args, cwd]), { code: 0, stdout: "" }),
    });
    expect(res.ok).toBe(true);
    expect(res.watchlistRemoved).toBe(true);
    expect(readWatchlist(dataTreePaths(cfg).watchlistFile).entries).toEqual([]);
    expect(existsSync(ns)).toBe(false);
    expect(existsSync(mine)).toBe(true); // user clone survives
    expect(gitCalls).toEqual([[["worktree", "prune"], mine]]);
    expect(res.summary.find((s) => s.kind === "clone")?.outcome).toBe("kept");
  });

  it("one failing deletion doesn't strand the rest; ok:false with the failure row", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const t = writeTicket(dataTreePaths(cfg).queue.inbox, "fix-1", clone);
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" });
    const res = await runUnwatch(cfg, "acme/api", {
      unlinkFn: (p) => {
        if (p === t) throw new Error("EACCES boom");
        unlinkSync(p);
      },
    });
    expect(res.ok).toBe(false);
    expect(res.summary.find((s) => s.kind === "inbox-ticket")).toMatchObject({ outcome: "failed" });
    expect(res.summary.filter((s) => s.outcome === "deleted").map((s) => s.kind)).toEqual(
      expect.arrayContaining(["watchlist-entry", "outbox-op", "clone"]),
    );
    expect(existsSync(clone)).toBe(false);
  });

  it("worktree namespace removal happens under the advisory lock; a held lock fails only that row", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    const res = await runUnwatch(cfg, "acme/api", { acquireLockFn: () => null });
    expect(res.ok).toBe(false);
    expect(res.summary.find((s) => s.kind === "worktrees")).toMatchObject({ outcome: "failed" });
    expect(existsSync(ns)).toBe(true);
    expect(existsSync(clone)).toBe(false); // the rest still ran
  });

  it("residue run with nothing to clean succeeds with an empty summary", async () => {
    const { cfg } = makeTree();
    const res = await runUnwatch(cfg, "ghost/repo");
    expect(res).toMatchObject({ ok: true, refused: null, watchlistRemoved: false, summary: [] });
  });
});
