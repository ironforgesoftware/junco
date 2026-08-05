import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enumerateRepos, collectRepoCandidates } from "../src/tui/localSnapshot.js";
import { writeWatchlist, watchlistPath } from "../src/watchlist.js";
import { dataTreePaths } from "../src/dataTree.js";
import type { Config } from "../src/types.js";

/** Minimal Config over a sandboxed dataDir; only the fields the enumerators
 * read are populated (same cast style as queueSnapshot.test.ts). */
function makeCfg(root: string, overrides: Partial<Config> = {}): Config {
  return {
    dataDir: join(root, "state"),
    worktreeRoot: join(root, "wt"),
    gitBin: "git",
    ghBin: "gh",
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    maxConcurrent: 1,
    github: {
      enabled: true,
      repos: [{ nwo: "owner/repo", path: join(root, "cfgrepo") }],
      externalReposRoot: join(root, "external"),
    },
    ...overrides,
  } as unknown as Config;
}

/** A readdirFn fake driven by an explicit dir→entries map ([] for anything
 * unlisted); a listed dir that maps to `THROW` throws (never-throws coverage). */
const THROW = Symbol("throw");
function fakeReaddir(map: Record<string, string[] | typeof THROW>): (d: string) => string[] {
  return (d: string): string[] => {
    const v = map[d];
    if (v === THROW) throw new Error(`readdir boom: ${d}`);
    return v ?? [];
  };
}

/** A gitFn fake: records every invocation, resolves per a per-subcommand table
 * keyed by args.join(" ") substring. Unmatched → code 1, empty stdout. */
function fakeGit(table: { match: RegExp; code: number; stdout: string }[], calls: string[][]) {
  return async (args: string[]): Promise<{ code: number; stdout: string }> => {
    calls.push(args);
    const joined = args.join(" ");
    const hit = table.find((t) => t.match.test(joined));
    return hit ? { code: hit.code, stdout: hit.stdout } : { code: 1, stdout: "" };
  };
}

describe("collectRepoCandidates", () => {
  it("unions config ∪ RAW watchlist (incl external:true) ∪ external walk ∪ clone walk, deduped by resolve(path), first source wins", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsr-"));
    const cfg = makeCfg(root);
    // RAW watchlist: an owned entry AND an external:true fork (resolveWatchedRepos would drop the latter).
    writeWatchlist(watchlistPath(cfg), [
      { nwo: "w/owned", path: join(root, "wrepo") },
      { nwo: "up/stream", path: join(root, "extclone"), external: true },
      { nwo: "owner/repo", path: join(root, "cfgrepo") }, // dup of config → config wins
    ]);
    const clonesDir = dataTreePaths(cfg).clonesWatched;
    const readdirFn = fakeReaddir({
      [cfg.github.externalReposRoot]: ["acme"],
      [join(cfg.github.externalReposRoot, "acme")]: ["widget"],
      [clonesDir]: ["bob"],
      [join(clonesDir, "bob")]: ["tool"],
    });
    const got = collectRepoCandidates(cfg, { readdirFn });
    expect(got.map((c) => [c.source, c.nwoHint])).toEqual([
      ["config", "owner/repo"],
      ["watchlist", "w/owned"],
      ["watchlist", "up/stream"], // external:true survives (raw watchlist)
      ["external", "acme/widget"],
      ["clone", "bob/tool"],
    ]);
    // dedup: config path appears once, not again from the watchlist dup.
    expect(got.filter((c) => c.nwoHint === "owner/repo")).toHaveLength(1);
  });
});

describe("enumerateRepos", () => {
  it("per-repo git: nwo from origin, forkUrl from fork remote, branch@sha, dirty; every git call carries --no-optional-locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsr2-"));
    const cfg = makeCfg(root, {
      github: {
        enabled: true,
        repos: [{ nwo: "owner/repo", path: join(root, "cfgrepo") }],
        externalReposRoot: join(root, "external"),
      },
    } as Partial<Config>);
    const calls: string[][] = [];
    const gitFn = fakeGit(
      [
        { match: /remote get-url origin/, code: 0, stdout: "https://github.com/owner/repo.git\n" },
        { match: /remote get-url fork/, code: 1, stdout: "" }, // owned repo → no fork remote
        { match: /rev-parse --abbrev-ref HEAD/, code: 0, stdout: "main\n" },
        { match: /rev-parse HEAD/, code: 0, stdout: "abc1234def\n" },
        { match: /status --porcelain/, code: 0, stdout: " M src/x.ts\n" },
      ],
      calls,
    );
    const repos = await enumerateRepos(cfg, { readdirFn: fakeReaddir({}), gitFn });
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      nwo: "owner/repo",
      source: "config",
      originUrl: "https://github.com/owner/repo.git",
      forkUrl: null,
      githubUrl: "https://github.com/owner/repo",
      branch: "main",
      headSha: "abc1234def",
      dirty: true,
      error: null,
    });
    // no plain `git status`: every invocation carries the lock-free flag.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain("--no-optional-locks");
  });

  it("never-throws: a throwing gitFn yields a renderable repo with error set, null git fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsr3-"));
    const cfg = makeCfg(root);
    const gitFn = async (): Promise<{ code: number; stdout: string }> => {
      throw new Error("spawn EACCES");
    };
    const repos = await enumerateRepos(cfg, { readdirFn: fakeReaddir({}), gitFn });
    expect(repos).toHaveLength(1);
    expect(repos[0].error).toContain("spawn EACCES");
    expect(repos[0].branch).toBeNull();
    expect(repos[0].nwo).toBe("owner/repo"); // falls back to the nwoHint
  });

  it("never-throws: a throwing readdir on the external/clone walk degrades to config-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsr4-"));
    const cfg = makeCfg(root);
    const gitFn = fakeGit([{ match: /rev-parse HEAD/, code: 0, stdout: "sha\n" }], []);
    const repos = await enumerateRepos(cfg, {
      readdirFn: fakeReaddir({
        [cfg.github.externalReposRoot]: THROW,
        [dataTreePaths(cfg).clonesWatched]: THROW,
      }),
      gitFn,
    });
    expect(repos.map((r) => r.source)).toEqual(["config"]);
  });
});
