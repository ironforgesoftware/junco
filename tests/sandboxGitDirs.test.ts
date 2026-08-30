import { describe, it, expect } from "vitest";
import { resolveGitDirs } from "../src/agent/sandbox/gitDirs.js";
import type { git } from "../src/git.js";

const cfg = { gitBin: "/sbxroot/bin/git" };

type GitFn = typeof git;

function fakeGit(reply: { code: number; stdout: string } | Error, calls: unknown[][] = []) {
  const fn: GitFn = async (_c, args, opts) => {
    calls.push([args, opts?.cwd]);
    if (reply instanceof Error) throw reply;
    return { code: reply.code, stdout: reply.stdout, stderr: "" };
  };
  return { fn, calls };
}

describe("resolveGitDirs (#320)", () => {
  it("parses the two absolute paths git prints, in order", async () => {
    const g = fakeGit({
      code: 0,
      stdout: "/sbxroot/repo/.git/worktrees/tree\n/sbxroot/repo/.git\n",
    });
    const dirs = await resolveGitDirs(cfg, "/sbxroot/work/tree", g.fn);
    expect(dirs).toEqual({
      gitDir: "/sbxroot/repo/.git/worktrees/tree",
      commonDir: "/sbxroot/repo/.git",
    });
    expect(g.calls[0]?.[0]).toEqual([
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ]);
    expect(g.calls[0]?.[1]).toBe("/sbxroot/work/tree"); // run IN the agent's cwd
  });

  it("returns null when git exits non-zero (not a repository)", async () => {
    const g = fakeGit({ code: 128, stdout: "" });
    expect(await resolveGitDirs(cfg, "/sbxroot/plain-dir", g.fn)).toBeNull();
  });

  it("returns null when the spawn itself fails (missing cwd or binary)", async () => {
    const g = fakeGit(new Error("spawn ENOENT"));
    expect(await resolveGitDirs(cfg, "/sbxroot/missing", g.fn)).toBeNull();
  });

  it("returns null on malformed output (fewer than two lines)", async () => {
    const g = fakeGit({ code: 0, stdout: "/sbxroot/repo/.git\n" });
    expect(await resolveGitDirs(cfg, "/sbxroot/work/tree", g.fn)).toBeNull();
  });

  it("returns null when an old git echoes the unknown --path-format flag (three lines, exit 0)", async () => {
    const g = fakeGit({
      code: 0,
      stdout: "--path-format=absolute\n/sbxroot/repo/.git/worktrees/tree\n/sbxroot/repo/.git\n",
    });
    expect(await resolveGitDirs(cfg, "/sbxroot/work/tree", g.fn)).toBeNull();
  });

  it("returns null when a line is not an absolute path", async () => {
    const g = fakeGit({ code: 0, stdout: ".git/worktrees/tree\n/sbxroot/repo/.git\n" });
    expect(await resolveGitDirs(cfg, "/sbxroot/work/tree", g.fn)).toBeNull();
  });
});
