import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { cachePathFor, prCachePathFor, githubCacheFilesFor } from "../src/githubCachePaths.js";
import { dataTreePaths } from "../src/dataTree.js";
import type { Config } from "../src/types.js";

// Only dataDir is read (see the long comment on `queue` in dataTree.ts for why
// dataTreePaths tolerates this narrow fixture).
const cfg = { dataDir: "/sbxroot/junco" } as unknown as Config;
const dir = dataTreePaths(cfg).githubCache;

// #359: these names used to live twice — once in tui/ghClient.ts, once
// hand-copied into unwatchCmd.ts — with a drift-pin test standing between
// them. One module now owns them, so the pin that matters is the literal
// name: renaming one orphans every installed tree's cache, and `junco
// unwatch` would stop sweeping the file the dashboard still writes.
describe("githubCachePaths", () => {
  it("keys both files by owner__repo so the nwo's `/` never becomes a path separator", () => {
    expect(cachePathFor(cfg, "acme/api")).toBe(join(dir, "issues-acme__api.json"));
    expect(prCachePathFor(cfg, "acme/api")).toBe(join(dir, "prs-acme__api.json"));
  });

  it("githubCacheFilesFor is every cache file one repo owns", () => {
    expect(githubCacheFilesFor(cfg, "acme/api")).toEqual([
      join(dir, "issues-acme__api.json"),
      join(dir, "prs-acme__api.json"),
    ]);
  });
});
