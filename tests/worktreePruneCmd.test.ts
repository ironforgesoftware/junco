import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorktreePruneCommand, type PruneDeps } from "../src/worktreePruneCmd.js";
import { acquirePidfileLock } from "../src/pidfileLock.js";
import { worktreesLockPath } from "../src/worktree.js";
import type { Config } from "../src/types.js";

const DISCR = "myrepo-abcd1234";

function makeCfg(root: string, healthEnabled = false): Config {
  return {
    vaultRoot: root,
    juncoSubdir: "",
    worktreeRoot: join(root, "worktrees"),
    defaultTimeoutMinutes: 30,
    healthEnabled,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    gitBin: "git",
  } as unknown as Config;
}

/** A fake gitFn: rev-parse yields an absolute common dir; `worktree remove`
 * physically removes the target (simulating real git) so the empty-parent rmdir
 * path is exercised. Records every call for assertions. */
function fakeGit(calls: string[][]): NonNullable<PruneDeps["gitFn"]> {
  return async (args, _cwd) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { code: 0, stdout: "/some/repo/.git\n" };
    if (args[0] === "worktree" && args[1] === "remove") {
      rmSync(args[3], { recursive: true, force: true });
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: "" };
  };
}

function healthFetch(currentTickets: string[]): typeof fetch {
  return (async () =>
    ({
      ok: true,
      json: async () => ({ metrics: { currentTickets } }),
    }) as unknown as Response) as typeof fetch;
}

describe("runWorktreePruneCommand", () => {
  let root: string;
  let cfg: Config;
  let wt: string;
  let parent: string;
  let out: string[];
  let calls: string[][];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-prune-"));
    cfg = makeCfg(root);
    parent = join(cfg.worktreeRoot, DISCR);
    wt = join(parent, "my-ticket"); // slug = "my-ticket"
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(root, "processing"), { recursive: true });
    out = [];
    calls = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a path outside the worktree root → exit 2, no git, dir untouched", async () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    const code = await runWorktreePruneCommand(cfg, [outside], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
    });
    expect(code).toBe(2);
    expect(out.join("")).toMatch(/not under the worktree root/);
    expect(calls).toHaveLength(0);
    expect(existsSync(outside)).toBe(true);
  });

  it("happy path: git worktree remove --force + empty-parent rmdir, exit 0", async () => {
    const code = await runWorktreePruneCommand(cfg, [wt], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
    });
    expect(code).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(parent)).toBe(false); // discriminator parent rmdir'd (was empty)
    expect(out.join("")).toMatch(/pruned:/);
    expect(calls.some((a) => a[0] === "worktree" && a[1] === "remove" && a[2] === "--force")).toBe(
      true,
    );
  });

  it("refuses when a processing/ ticket's slug matches (daemon owns it) → exit 1, no remove", async () => {
    writeFileSync(
      join(root, "processing", "2026-06-10T1200Z__my-ticket.md"),
      "---\nid: my-ticket\n---\nx\n",
      "utf8",
    );
    const code = await runWorktreePruneCommand(cfg, [wt], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
    });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/refusing to prune/);
    expect(existsSync(wt)).toBe(true);
    expect(calls.some((a) => a[0] === "worktree")).toBe(false);
  });

  it("refuses on a /health currentTickets slug match even for an unmapped worktree", async () => {
    // No processing file, no repo reverse-map — the slug alone gates it.
    const code = await runWorktreePruneCommand(makeCfg(root, true), [wt], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
      fetchFn: healthFetch(["my-ticket"]),
    });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/refusing to prune/);
    expect(existsSync(wt)).toBe(true);
    expect(calls.some((a) => a[0] === "worktree")).toBe(false);
  });

  it("daemon down (fetch throws): processing/ scan is authoritative — empty → prunes", async () => {
    const rejectingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const code = await runWorktreePruneCommand(makeCfg(root, true), [wt], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
      fetchFn: rejectingFetch,
    });
    expect(code).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("refuses a discriminator CONTAINER path → exit 2, live child worktree NOT deleted", async () => {
    // `parent` (worktreeRoot/<discriminator>) holds the live child `wt`. It clears
    // path containment and the slug gate (basename is the repo-hash, not a ticket
    // slug). Make the child a genuine worktree (has a `.git` entry) and hand the
    // command a git that CANNOT resolve/remove the container (rev-parse fails, git
    // worktree remove fails) so control reaches the recursive-delete fallback —
    // which must REFUSE rather than recursively erase the container + its child.
    writeFileSync(join(wt, ".git"), "gitdir: /some/repo/.git/worktrees/my-ticket\n", "utf8");
    const containerGit: NonNullable<PruneDeps["gitFn"]> = async (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return { code: 128, stdout: "" };
      return { code: 1, stdout: "" }; // any worktree remove fails on a non-worktree
    };
    const code = await runWorktreePruneCommand(cfg, [parent], {
      printFn: (s) => out.push(s),
      gitFn: containerGit,
    });
    expect(code).toBe(2);
    expect(out.join("")).toMatch(/not a leaf worktree/);
    expect(existsSync(parent)).toBe(true); // container NOT recursively deleted
    expect(existsSync(wt)).toBe(true); // live child NOT deleted
  });

  it("still prunes a .old-<ts> backup via the recursive fallback → exit 0", async () => {
    // A backup dir git cannot `worktree remove` (not a registered worktree). The
    // fallback IS the intended cleanup here — the .old-<ts> name whitelists it, so
    // the container guard must NOT block it.
    const backup = join(parent, "my-ticket.old-1700000000");
    mkdirSync(backup, { recursive: true });
    const backupGit: NonNullable<PruneDeps["gitFn"]> = async (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return { code: 128, stdout: "" };
      return { code: 1, stdout: "" };
    };
    const code = await runWorktreePruneCommand(cfg, [backup], {
      printFn: (s) => out.push(s),
      gitFn: backupGit,
    });
    expect(code).toBe(0);
    expect(existsSync(backup)).toBe(false); // recursive fallback removed it
    expect(out.join("")).toMatch(/pruned:/);
  });

  it("SERIALIZATION: a held worktrees.lock blocks prune → exit 1, no git", async () => {
    // Hold the REAL shared lock (proves the command contends on the same path
    // the daemon takes). Same-process re-acquire inside the command returns null.
    const held = acquirePidfileLock(worktreesLockPath(cfg));
    expect(held).not.toBeNull();
    try {
      const code = await runWorktreePruneCommand(cfg, [wt], {
        printFn: (s) => out.push(s),
        gitFn: fakeGit(calls),
      });
      expect(code).toBe(1);
      expect(out.join("")).toMatch(/another worktree operation is in progress/);
      expect(calls).toHaveLength(0);
      expect(existsSync(wt)).toBe(true);
    } finally {
      held!.release();
    }
  });

  it("no path → usage + exit 2", async () => {
    expect(await runWorktreePruneCommand(cfg, [], { printFn: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toMatch(/Usage: junco worktree prune/);
  });
});
