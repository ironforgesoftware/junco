/**
 * Real-git confirmation harness for runUnwatch: a real `git init` repo stands
 * in for a KEPT user-owned clone (not under a managed clones/ root — see
 * classifyClone in src/unwatchCmd.ts), a real `git worktree add` populates the
 * unwatch namespace dir, and runUnwatch runs with its DEFAULT gitFn (real
 * `git`, not the fake used everywhere else in tests/unwatchCmd.test.ts).
 * Confirms two things a fake gitFn can't: `rmSync` on the namespace dir really
 * does leave `.git/worktrees/<id>` registrations behind, and the best-effort
 * `git worktree prune` step really does clear them.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runUnwatch } from "../src/unwatchCmd.js";
import { repoDiscriminator } from "../src/worktree.js";
import { makeTree, watch } from "./helpers/unwatchTree.js";

/** execFileSync with a deterministic git identity (see tests/helpers/gitHarness.ts's
 * `run` — CI sets user.* globally, but local runs must not depend on ~/.gitconfig). */
const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CI",
      GIT_AUTHOR_EMAIL: "ci@example.com",
      GIT_COMMITTER_NAME: "CI",
      GIT_COMMITTER_EMAIL: "ci@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });

describe("runUnwatch against real git state", () => {
  it("removes a real worktree namespace; kept user clone gets pruned registrations", async () => {
    const { root, cfg } = makeTree();
    const mine = join(root, "my-checkout");
    mkdirSync(mine, { recursive: true });
    g(mine, "init", "-b", "main");
    g(mine, "config", "user.email", "ci@example.com");
    g(mine, "config", "user.name", "CI");
    g(mine, "config", "commit.gpgsign", "false");
    g(mine, "commit", "--allow-empty", "-m", "seed");
    watch(cfg, "acme/api", mine);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(mine));
    mkdirSync(ns, { recursive: true });
    g(mine, "worktree", "add", join(ns, "ticket-1"), "-b", "junco/ticket-1");
    // Sanity: the worktree really is registered before runUnwatch touches anything.
    expect(g(mine, "worktree", "list")).toContain("ticket-1");

    const res = await runUnwatch(cfg, "acme/api"); // default gitFn — real git

    expect(res.ok).toBe(true);
    expect(existsSync(ns)).toBe(false); // namespace dir gone
    expect(existsSync(mine)).toBe(true); // user checkout survives
    // rmSync on `ns` left a stale `.git/worktrees/ticket-1` registration behind;
    // the best-effort `git worktree prune` step (unwatchCmd.ts's step 6) clears it.
    expect(g(mine, "worktree", "list")).not.toContain("ticket-1");
    expect(res.summary.find((s) => s.kind === "clone")).toMatchObject({
      outcome: "kept",
      path: mine,
    });
  });
});
