import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enumerateWorktrees } from "../src/tui/localSnapshot.js";
import { repoDiscriminator } from "../src/worktree.js";
import type { Config } from "../src/types.js";

function makeCfg(root: string, repoPath: string): Config {
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
      repos: [{ nwo: "owner/repo", path: repoPath }],
      externalReposRoot: join(root, "external"),
    },
  } as unknown as Config;
}

const THROW = Symbol("throw");
function fakeReaddir(map: Record<string, string[] | typeof THROW>): (d: string) => string[] {
  return (d: string): string[] => {
    const v = map[d];
    if (v === THROW) throw new Error(`readdir boom: ${d}`);
    return v ?? [];
  };
}

describe("enumerateWorktrees", () => {
  it("classes live/stale/backup, reverse-maps the discriminator, reads HEAD lock-free; unmatched → repoNwo null", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsw-"));
    const repoPath = join(root, "cfgrepo");
    const cfg = makeCfg(root, repoPath);
    const disc = repoDiscriminator(repoPath); // matched
    const alien = "alien-00000000"; // no candidate maps to it → ⟨unmapped⟩
    const wtRoot = cfg.worktreeRoot;

    const liveWt = join(wtRoot, disc, "gh-owner-repo-1");
    const staleWt = join(wtRoot, disc, "gh-owner-repo-2");
    const backupWt = join(wtRoot, disc, "gh-owner-repo-3.old-1600000000");
    const alienWt = join(wtRoot, alien, "gh-x-y-9");

    const readdirFn = fakeReaddir({
      [wtRoot]: [disc, alien],
      [join(wtRoot, disc)]: [
        "gh-owner-repo-1",
        "gh-owner-repo-2",
        "gh-owner-repo-3.old-1600000000",
      ],
      [join(wtRoot, alien)]: ["gh-x-y-9"],
      [liveWt]: [".git", "src"], // has .git → live
      [staleWt]: ["src"], //          no .git → stale
      [alienWt]: [".git"],
    });
    const calls: string[][] = [];
    const gitFn = async (args: string[]): Promise<{ code: number; stdout: string }> => {
      calls.push(args);
      return { code: 0, stdout: "deadbee\n" };
    };
    const now = new Date("2026-07-09T00:00:00Z");

    const wts = await enumerateWorktrees(cfg, { readdirFn, gitFn, nowFn: () => now });
    const byPath = Object.fromEntries(wts.map((w) => [w.path, w]));

    expect(byPath[liveWt]).toMatchObject({
      kind: "live",
      slug: "gh-owner-repo-1",
      repoPath,
      repoNwo: "owner/repo",
      headSha: "deadbee",
    });
    expect(byPath[staleWt]).toMatchObject({ kind: "stale", repoNwo: "owner/repo" });
    expect(byPath[backupWt]).toMatchObject({
      kind: "backup",
      slug: "gh-owner-repo-3",
      headSha: null,
    });
    expect(byPath[backupWt].ageSeconds).toBe(Math.floor(now.getTime() / 1000) - 1600000000);
    expect(byPath[alienWt]).toMatchObject({ repoPath: null, repoNwo: null, kind: "live" });
    // every HEAD read is lock-free (no plain rev-parse).
    for (const c of calls) expect(c).toContain("--no-optional-locks");
  });

  it("never-throws: a throwing gitFn sets the worktree error but still classifies", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsw2-"));
    const cfg = makeCfg(root, join(root, "cfgrepo"));
    const disc = repoDiscriminator(join(root, "cfgrepo"));
    const readdirFn = fakeReaddir({
      [cfg.worktreeRoot]: [disc],
      [join(cfg.worktreeRoot, disc)]: ["slug-1"],
      [join(cfg.worktreeRoot, disc, "slug-1")]: [".git"],
    });
    const gitFn = async (): Promise<{ code: number; stdout: string }> => {
      throw new Error("git boom");
    };
    const [wt] = await enumerateWorktrees(cfg, { readdirFn, gitFn });
    expect(wt.kind).toBe("live");
    expect(wt.headSha).toBeNull();
    expect(wt.error).toContain("git boom");
  });

  it("missing worktreeRoot → [] (never error)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsw3-"));
    const cfg = makeCfg(root, join(root, "cfgrepo"));
    expect(await enumerateWorktrees(cfg, { readdirFn: fakeReaddir({}) })).toEqual([]);
  });
});
