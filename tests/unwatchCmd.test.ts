import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "./helpers/config.js";
import { writeWatchlist, readWatchlist, type WatchlistEntry } from "../src/watchlist.js";
import { dataTreePaths } from "../src/dataTree.js";
import type { Config } from "../src/types.js";
import { isUnder, planUnwatch } from "../src/unwatchCmd.js";

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

describe("isUnder", () => {
  it("prefix-compares with a separator guard on synthetic paths", () => {
    expect(isUnder("/sbxroot/clones/watched/a/b", "/sbxroot/clones/watched")).toBe(true);
    expect(isUnder("/sbxroot/clones/watched", "/sbxroot/clones/watched")).toBe(false);
    expect(isUnder("/sbxroot/clones/watched-evil/x", "/sbxroot/clones/watched")).toBe(false);
  });
});
