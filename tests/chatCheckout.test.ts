/**
 * #526 — the chat's checkout fast-forward. Real git (bare remote + clones in
 * tmp): the whole point of this module is what git does, so a fake git would
 * pin the argv and nothing else. Nothing here touches a real watched clone.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneHarness, run } from "./helpers/gitHarness.js";
import { makeConfig } from "./helpers/config.js";
import { dataTreePaths } from "../src/dataTree.js";
import { assertOwnedCheckout, fastForwardChatCheckout } from "../src/chat/chatCheckout.js";
import type { Config } from "../src/types.js";

function setup(opts: { managed?: boolean } = {}): {
  cfg: Config;
  root: string;
  work: string;
  remote: string;
} {
  const root = mkdtempSync(join(tmpdir(), "junco-ck-"));
  const cfg = makeConfig({
    dataDir: root,
    queueRoot: join(root, "queue"),
    worktreeRoot: join(root, "wt"),
    tools: ["read", "grep"],
    criticEnabled: false,
    planLintEnabled: false,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: true,
    chatEnabled: true,
  });
  // Managed ⇔ under the clones root junco owns; unmanaged stands in for a
  // watchlist entry pointing at the operator's own checkout.
  const dest =
    opts.managed === false
      ? join(root, "operator-checkout")
      : join(dataTreePaths(cfg).clonesWatched, "acme");
  mkdirSync(dest, { recursive: true });
  const h = cloneHarness(dest);
  // `git init` + `push -u` leaves origin/HEAD unset; a real clone sets it.
  run(["git", "-C", h.work, "remote", "set-head", "origin", "main"]);
  return { cfg, root, work: h.work, remote: h.remote };
}

/** Push one commit to `remote` from a throwaway clone, so `work` falls behind
 *  AND its own refs/remotes/origin/main goes stale (only a fetch fixes that). */
function advanceRemote(root: string, remote: string, name = "next"): string {
  const other = join(root, `other-${name}`);
  run(["git", "clone", remote, other]);
  writeFileSync(join(other, `${name}.txt`), "x\n");
  run(["git", "-C", other, "add", "."]);
  run(["git", "-C", other, "-c", "commit.gpgsign=false", "commit", "-m", name]);
  run(["git", "-C", other, "push", "origin", "main"]);
  const sha = run(["git", "-C", other, "rev-parse", "HEAD"]).trim();
  rmSync(other, { recursive: true, force: true });
  return sha;
}

const headOf = (repo: string): string => run(["git", "-C", repo, "rev-parse", "HEAD"]).trim();

describe("fastForwardChatCheckout (#526)", () => {
  it("fast-forwards a junco-owned clone that has fallen behind origin's default branch", async () => {
    const { cfg, root, work, remote } = setup();
    const before = headOf(work);
    const pushed = advanceRemote(root, remote);
    expect(headOf(work)).toBe(before); // stale, as observed in the issue

    const out = await fastForwardChatCheckout(cfg, work);

    expect(out).toMatchObject({
      action: "fast_forwarded",
      reason: null,
      branch: "main",
      from: before,
      head: pushed,
      commits: 1,
    });
    expect(headOf(work)).toBe(pushed);
  });

  it("reports up_to_date (and the commit the chat reads) when nothing moved", async () => {
    const { cfg, work } = setup();
    const out = await fastForwardChatCheckout(cfg, work);
    expect(out).toMatchObject({
      action: "up_to_date",
      reason: null,
      branch: "main",
      head: headOf(work),
      from: null,
      commits: 0,
    });
  });

  it("skips a dirty working tree and leaves HEAD where it was", async () => {
    const { cfg, root, work, remote } = setup();
    const before = headOf(work);
    advanceRemote(root, remote);
    writeFileSync(join(work, "README.md"), "operator edit\n");

    const out = await fastForwardChatCheckout(cfg, work);
    expect(out).toMatchObject({ action: "skipped", reason: "dirty", head: before });
    expect(headOf(work)).toBe(before);
  });

  it("skips a detached HEAD", async () => {
    const { cfg, root, work, remote } = setup();
    advanceRemote(root, remote);
    run(["git", "-C", work, "checkout", "--detach", "HEAD"]);
    const before = headOf(work);

    const out = await fastForwardChatCheckout(cfg, work);
    expect(out).toMatchObject({ action: "skipped", reason: "detached", branch: null });
    expect(headOf(work)).toBe(before);
  });

  it("skips a checkout parked on a branch that is not origin's default", async () => {
    const { cfg, root, work, remote } = setup();
    advanceRemote(root, remote);
    run(["git", "-C", work, "checkout", "-b", "wip"]);
    const before = headOf(work);

    const out = await fastForwardChatCheckout(cfg, work);
    expect(out).toMatchObject({
      action: "skipped",
      reason: "not_default_branch",
      branch: "wip",
      head: before,
    });
    expect(headOf(work)).toBe(before);
  });

  it("skips a branch that has diverged (local commits ahead of origin)", async () => {
    const { cfg, root, work, remote } = setup();
    advanceRemote(root, remote);
    writeFileSync(join(work, "local.txt"), "mine\n");
    run(["git", "-C", work, "add", "."]);
    run(["git", "-C", work, "commit", "-m", "local work"]);
    const before = headOf(work);

    const out = await fastForwardChatCheckout(cfg, work);
    expect(out).toMatchObject({ action: "skipped", reason: "diverged", head: before });
    expect(headOf(work)).toBe(before);
  });

  it("skips when origin/HEAD is unset — the default branch is unknowable", async () => {
    const { cfg, root, work, remote } = setup();
    advanceRemote(root, remote);
    run(["git", "-C", work, "remote", "set-head", "origin", "--delete"]);
    const before = headOf(work);

    const out = await fastForwardChatCheckout(cfg, work);
    expect(out).toMatchObject({ action: "skipped", reason: "no_default_branch", head: before });
    expect(headOf(work)).toBe(before);
  });

  it("NEVER touches a path junco does not own, and runs no git at all there", async () => {
    const { cfg, root, work, remote } = setup({ managed: false });
    const before = headOf(work);
    advanceRemote(root, remote);
    const argv: string[][] = [];

    const out = await fastForwardChatCheckout(cfg, work, {
      gitFn: async (_c: unknown, args: string[]) => {
        argv.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(out).toMatchObject({ action: "skipped", reason: "not_managed", head: null });
    expect(argv).toEqual([]);
    expect(headOf(work)).toBe(before);
  });

  it("degrades to the tree as it stands when the fetch fails", async () => {
    const { cfg, work } = setup();
    const before = headOf(work);
    run(["git", "-C", work, "remote", "set-url", "origin", "/nonexistent/gone.git"]);

    const out = await fastForwardChatCheckout(cfg, work, { fetchTimeoutMs: 15_000 });
    expect(out).toMatchObject({ action: "failed", reason: "fetch_failed", head: before });
    expect(headOf(work)).toBe(before);
  });

  it("chat.fastForward: false reports the commit it read and fetches nothing", async () => {
    const { cfg, root, work, remote } = setup();
    const before = headOf(work);
    advanceRemote(root, remote);
    const off: Config = { ...cfg, chat: { ...cfg.chat, fastForward: false } };

    const out = await fastForwardChatCheckout(off, work);
    expect(out).toMatchObject({
      action: "skipped",
      reason: "disabled",
      branch: "main",
      head: before,
    });
    expect(headOf(work)).toBe(before);
  });

  it("reports not_a_repo for a managed path that is not a git checkout", async () => {
    const { cfg } = setup();
    const bare = join(dataTreePaths(cfg).clonesWatched, "acme", "not-a-repo");
    mkdirSync(bare, { recursive: true });
    const out = await fastForwardChatCheckout(cfg, bare);
    expect(out).toMatchObject({ action: "skipped", reason: "not_a_repo", head: null });
  });

  it("the mutation carries its own self-guard, independent of the gate above it", () => {
    // externalRepo.ts's idiom: the destructive step refuses a target outside
    // the roots junco owns, whatever gating upstream believes it applied.
    const unowned = setup({ managed: false });
    expect(() => assertOwnedCheckout(unowned.cfg, unowned.work)).toThrow(/junco does not own/i);
    const owned = setup();
    expect(() => assertOwnedCheckout(owned.cfg, owned.work)).not.toThrow();
    // The clone ROOT itself is not a checkout, and is refused too.
    expect(() => assertOwnedCheckout(owned.cfg, dataTreePaths(owned.cfg).clonesWatched)).toThrow();
  });
});
