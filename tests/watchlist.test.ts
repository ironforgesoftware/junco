import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  watchlistPath,
  readWatchlist,
  writeWatchlist,
  resolveWatchedRepos,
  resolveWatchedReposForPrs,
} from "../src/watchlist.js";
import type { Config } from "../src/types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "junco-wl-"));
}
function cfgWith(stateDir: string, repos: { nwo: string; path: string }[]): Config {
  return {
    dataDir: stateDir,
    github: {
      enabled: true,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos,
      requireApproval: true,
      plannerModelId: null,
      externalReposRoot: "/tmp/junco-test-external",
    },
  } as unknown as Config;
}

describe("watchlistPath", () => {
  it("lives under the state dir", () => {
    expect(watchlistPath(cfgWith("/s", []))).toBe("/s/github-watchlist.json");
  });
});

describe("readWatchlist", () => {
  it("missing file → empty, no error", () => {
    expect(readWatchlist(join(tmp(), "none.json"))).toEqual({ entries: [], error: null });
  });

  it("round-trips writeWatchlist output", () => {
    const f = join(tmp(), "wl.json");
    writeWatchlist(f, [{ nwo: "acme/api", path: "/c/api" }]);
    expect(readWatchlist(f)).toEqual({
      entries: [{ nwo: "acme/api", path: "/c/api" }],
      error: null,
    });
  });

  it("corrupt JSON → empty + error, file untouched", () => {
    const f = join(tmp(), "wl.json");
    writeFileSync(f, "{ not json", "utf8");
    const r = readWatchlist(f);
    expect(r.entries).toEqual([]);
    expect(r.error).toBeTruthy();
    expect(readFileSync(f, "utf8")).toBe("{ not json"); // never clobbered
  });

  it("filters malformed entries (bad nwo, missing path) with an error note", () => {
    const f = join(tmp(), "wl.json");
    writeFileSync(
      f,
      JSON.stringify([
        { nwo: "acme/api", path: "/c" },
        { nwo: "no-slash", path: "/x" },
        { nwo: "a/b" },
      ]),
      "utf8",
    );
    const r = readWatchlist(f);
    expect(r.entries).toEqual([{ nwo: "acme/api", path: "/c" }]);
    expect(r.error).toContain("2 invalid");
  });

  it("rejects entries whose external is not a boolean (fail-closed)", () => {
    const f = join(tmp(), "wl.json");
    writeFileSync(
      f,
      JSON.stringify([
        { nwo: "up/stream", path: "/c/up", external: "true" },
        { nwo: "own/repo", path: "/c/own" },
      ]),
      "utf8",
    );
    const r = readWatchlist(f);
    expect(r.entries).toEqual([{ nwo: "own/repo", path: "/c/own" }]);
    expect(r.error).toMatch(/1 invalid entr/);
  });
});

describe("writeWatchlist", () => {
  it("creates parent dirs and leaves no temp file", () => {
    const dir = tmp();
    const f = join(dir, "deep", "wl.json");
    writeWatchlist(f, []);
    expect(readWatchlist(f)).toEqual({ entries: [], error: null });
    expect(readdirSync(join(dir, "deep")).some((n) => n.includes(".tmp"))).toBe(false);
  });
});

describe("resolveWatchedRepos", () => {
  it("unions config and watchlist, config wins on nwo (case-insensitive)", () => {
    const dir = tmp();
    const cfg = cfgWith(dir, [{ nwo: "acme/api", path: "/config/api" }]);
    writeWatchlist(watchlistPath(cfg), [
      { nwo: "ACME/api", path: "/wl/api" }, // conflict → config wins
      { nwo: "alx/coral", path: "/wl/coral" },
    ]);
    expect(resolveWatchedRepos(cfg)).toEqual([
      { nwo: "acme/api", path: "/config/api" },
      { nwo: "alx/coral", path: "/wl/coral" },
    ]);
  });

  it("watchlist error degrades to config-only", () => {
    const dir = tmp();
    const cfg = cfgWith(dir, [{ nwo: "acme/api", path: "/config/api" }]);
    writeFileSync(watchlistPath(cfg), "boom", "utf8");
    expect(resolveWatchedRepos(cfg)).toEqual([{ nwo: "acme/api", path: "/config/api" }]);
  });

  it("preserves external: true through write/read", () => {
    const file = join(tmp(), "wl.json");
    writeWatchlist(file, [
      { nwo: "up/stream", path: "/c/up", external: true },
      { nwo: "own/repo", path: "/c/own" },
    ]);
    const { entries, error } = readWatchlist(file);
    expect(error).toBeNull();
    expect(entries).toEqual([
      { nwo: "up/stream", path: "/c/up", external: true },
      { nwo: "own/repo", path: "/c/own" },
    ]);
  });

  it("resolveWatchedRepos excludes external entries (bridge never polls them)", () => {
    const dir = tmp();
    const cfg = cfgWith(dir, []);
    writeWatchlist(watchlistPath(cfg), [
      { nwo: "up/stream", path: "/c/up", external: true },
      { nwo: "own/repo", path: "/c/own" },
    ]);
    expect(resolveWatchedRepos(cfg)).toEqual([{ nwo: "own/repo", path: "/c/own" }]);
  });
});

describe("resolveWatchedReposForPrs", () => {
  it("INCLUDES external entries (PR listing wants fork-PR repos) (#131)", () => {
    const dir = tmp();
    const cfg = cfgWith(dir, []);
    writeWatchlist(watchlistPath(cfg), [
      { nwo: "up/stream", path: "/c/up", external: true },
      { nwo: "own/repo", path: "/c/own" },
    ]);
    expect(resolveWatchedReposForPrs(cfg)).toEqual([
      { nwo: "up/stream", path: "/c/up" },
      { nwo: "own/repo", path: "/c/own" },
    ]);
  });

  it("still unions config and watchlist, config wins on nwo (case-insensitive)", () => {
    const dir = tmp();
    const cfg = cfgWith(dir, [{ nwo: "acme/api", path: "/config/api" }]);
    writeWatchlist(watchlistPath(cfg), [
      { nwo: "ACME/api", path: "/wl/api" }, // conflict → config wins
      { nwo: "alx/coral", path: "/wl/coral", external: true },
    ]);
    expect(resolveWatchedReposForPrs(cfg)).toEqual([
      { nwo: "acme/api", path: "/config/api" },
      { nwo: "alx/coral", path: "/wl/coral" },
    ]);
  });
});
