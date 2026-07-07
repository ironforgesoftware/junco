import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  outboxPaths,
  enqueueOp,
  listOps,
  outboxDepth,
  flushOutbox,
  tryOrEnqueue,
  isOffline,
  MAX_OP_ATTEMPTS,
  OUTBOX_MARKER_PREFIX,
  type OutboxOp,
} from "../src/githubOutbox.js";
import { GitOpError } from "../src/git.js";
import type { Config } from "../src/types.js";

function cfgAt(root: string): Config {
  return { stateDir: root } as unknown as Config;
}
const LABELS = {
  kind: "labels",
  nwo: "a/b",
  issue: 7,
  add: ["junco:approved"],
  remove: [],
} as const;

describe("outbox store", () => {
  it("enqueue writes one atomic JSON file; list round-trips the envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-"));
    const cfg = cfgAt(root);
    const id = enqueueOp(cfg, "dashboard", { ...LABELS });
    const files = readdirSync(outboxPaths(cfg).dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${id}.json`);
    const [stored] = listOps(cfg);
    expect(stored.origin).toBe("dashboard");
    expect(stored.issueKey).toBe("a/b#7");
    expect(stored.attempts).toBe(0);
    expect(stored.op).toMatchObject({ kind: "labels", add: ["junco:approved"] });
    expect(Date.parse(stored.createdAt)).toBeGreaterThan(0);
  });

  it("list is FIFO by filename even with same-millisecond enqueues", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx2-"));
    const cfg = cfgAt(root);
    const t = new Date("2026-07-07T10:00:00Z");
    const deps = { nowFn: () => t };
    const a = enqueueOp(cfg, "reporter", { ...LABELS }, deps);
    const b = enqueueOp(cfg, "reporter", { ...LABELS, issue: 8 }, deps);
    const c = enqueueOp(cfg, "reporter", { ...LABELS, issue: 9 }, deps);
    expect(listOps(cfg).map((s) => s.id)).toEqual([a, b, c]); // seq breaks the tie
  });

  it("issueKey is null for push ops; depth counts only .json in the live dir", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx3-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "prflow", { kind: "push", repoPath: "/r", branch: "junco/x" });
    writeFileSync(join(outboxPaths(cfg).dir, "junk.txt"), "x");
    expect(listOps(cfg)[0].issueKey).toBeNull();
    expect(outboxDepth(cfg)).toBe(1);
  });

  it("unparseable op files are skipped, not fatal", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx4-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    writeFileSync(join(outboxPaths(cfg).dir, "0000-bad.json"), "{nope");
    expect(listOps(cfg)).toHaveLength(1);
  });

  it("missing dir (fresh install) → empty list, depth 0", () => {
    const cfg = cfgAt(join(tmpdir(), "junco-obx-nonexistent-xyz"));
    expect(listOps(cfg)).toEqual([]);
    expect(outboxDepth(cfg)).toBe(0);
  });
});

const NET_ERR = new GitOpError("gh failed", "connect: network is unreachable", 1);
const PERM_ERR = new GitOpError("gh failed", "HTTP 404: Not Found", 1);

/** Scriptable gh/git fakes: each call records argv; behavior comes from a
 * queue of responses or a handler function. */
function fakes(handler: (tool: "gh" | "git", args: string[]) => { stdout?: string } | void) {
  const calls: { tool: string; args: string[] }[] = [];
  const ghFn = (async (_cfg: unknown, args: string[]) => {
    calls.push({ tool: "gh", args });
    return { code: 0, stdout: "", stderr: "", ...(handler("gh", args) ?? {}) };
  }) as never;
  const gitFn = (async (_cfg: unknown, args: string[]) => {
    calls.push({ tool: "git", args });
    return { code: 0, stdout: "", stderr: "", ...(handler("git", args) ?? {}) };
  }) as never;
  return { calls, ghFn, gitFn };
}

describe("isOffline / tryOrEnqueue", () => {
  it("classifies exactly GitOpError + network stderr", () => {
    expect(isOffline(NET_ERR)).toBe(true);
    expect(isOffline(PERM_ERR)).toBe(false);
    expect(isOffline(new Error("connect: network is unreachable"))).toBe(false); // not GitOpError
  });
  it("live success → sent, nothing stored; offline → queued; permanent → rethrow", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-t-"));
    const cfg = cfgAt(root);
    expect(await tryOrEnqueue(cfg, "reporter", { ...LABELS }, async () => {})).toBe("sent");
    expect(outboxDepth(cfg)).toBe(0);
    expect(
      await tryOrEnqueue(cfg, "reporter", { ...LABELS }, async () => {
        throw NET_ERR;
      }),
    ).toBe("queued");
    expect(outboxDepth(cfg)).toBe(1);
    await expect(
      tryOrEnqueue(cfg, "reporter", { ...LABELS }, async () => {
        throw PERM_ERR;
      }),
    ).rejects.toThrow("HTTP 404");
    expect(outboxDepth(cfg)).toBe(1); // permanent error did NOT enqueue
  });
});

describe("flushOutbox", () => {
  it("labels op → one gh issue edit; file deleted on success", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f1-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", {
      kind: "labels",
      nwo: "a/b",
      issue: 7,
      add: ["x"],
      remove: ["y"],
    });
    const f = fakes(() => undefined);
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r).toMatchObject({ sent: 1, dead: 0, remaining: 0, offline: false });
    expect(f.calls[0].args).toEqual([
      "issue",
      "edit",
      "7",
      "--repo",
      "a/b",
      "--add-label",
      "x",
      "--remove-label",
      "y",
    ]);
    expect(outboxDepth(cfg)).toBe(0);
  });

  it("comment op appends the marker and skips when the marker already exists upstream", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f2-"));
    const cfg = cfgAt(root);
    const id = enqueueOp(cfg, "reporter", { kind: "comment", nwo: "a/b", issue: 7, body: "hello" });
    let posted = 0;
    const f = fakes((tool, args) => {
      if (tool === "gh" && args[0] === "api") return { stdout: `${OUTBOX_MARKER_PREFIX}${id} -->` };
      if (tool === "gh" && args[0] === "issue" && args[1] === "comment") posted++;
      return undefined;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r.sent).toBe(1);
    expect(posted).toBe(0); // marker found → treated as already delivered
  });

  it("offline mid-flush stops everything, attempts untouched, remaining counted", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f3-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    enqueueOp(cfg, "dashboard", { ...LABELS, issue: 8 });
    const f = fakes(() => {
      throw NET_ERR;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r).toMatchObject({ sent: 0, dead: 0, remaining: 2, offline: true });
    expect(listOps(cfg).every((s) => s.attempts === 0)).toBe(true);
  });

  it("permanent failure increments attempts and dead-letters at MAX_OP_ATTEMPTS", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f4-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const f = fakes(() => {
      throw PERM_ERR;
    });
    for (let i = 1; i < MAX_OP_ATTEMPTS; i++) {
      const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
      expect(r).toMatchObject({ sent: 0, dead: 0, remaining: 1 });
      expect(listOps(cfg)[0].attempts).toBe(i);
      expect(listOps(cfg)[0].lastError).toContain("404");
    }
    const last = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(last).toMatchObject({ dead: 1, remaining: 0 });
    expect(outboxDepth(cfg)).toBe(0);
    expect(readdirSync(outboxPaths(cfg).dead)).toHaveLength(1);
  });

  it("pr composite: push → create → finalize comment → labels, with checkpoint resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f5-"));
    const cfg = {
      stateDir: root,
      github: { triggerLabel: "junco" },
    } as unknown as Config;
    enqueueOp(cfg, "prflow", {
      kind: "pr",
      repoPath: "/repo",
      branch: "junco/fix-7",
      nwo: "a/b",
      issue: 7,
      base: "main",
      title: "Fix things",
      bodyText: "the body",
      draft: false,
      labels: [],
      reviewers: [],
      finalize: { ticketId: "gh-a-b-7", status: "completed", finalText: "did the thing" },
      pushed: false,
      prUrl: null,
    });
    // First flush: push succeeds, `pr create` dies offline → checkpoint pushed:true
    const f1 = fakes((tool, args) => {
      if (tool === "git") return undefined; // push ok
      if (args[0] === "pr" && args[1] === "create") throw NET_ERR;
      return undefined;
    });
    const r1 = await flushOutbox(cfg, { ghFn: f1.ghFn, gitFn: f1.gitFn });
    expect(r1.offline).toBe(true);
    const cp = listOps(cfg)[0].op as Extract<OutboxOp, { kind: "pr" }>;
    expect(cp.pushed).toBe(true);
    expect(cp.prUrl).toBeNull();
    // Second flush: everything succeeds; push must NOT run again
    let pushes = 0;
    const posted: string[] = [];
    const f2 = fakes((tool, args) => {
      if (tool === "git" && args.includes("push")) {
        pushes++;
        return undefined;
      }
      if (args[0] === "pr" && args[1] === "create")
        return { stdout: "https://github.com/a/b/pull/9\n" };
      if (args[0] === "api") return { stdout: "" }; // no marker upstream
      if (args[0] === "issue" && args[1] === "comment") {
        posted.push(args.join(" "));
        return undefined;
      }
      return undefined;
    });
    const r2 = await flushOutbox(cfg, { ghFn: f2.ghFn, gitFn: f2.gitFn });
    expect(r2).toMatchObject({ sent: 1, offline: false, remaining: 0 });
    expect(pushes).toBe(0); // checkpoint respected
    expect(posted).toHaveLength(1);
    const labelCall = f2.calls.find((c) => c.args[0] === "issue" && c.args[1] === "edit");
    expect(labelCall!.args).toContain("junco:done");
    expect(labelCall!.args).toContain("junco:working");
  });

  it("pr create 'already exists' resolves the URL via pr view", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f6-"));
    const cfg = { stateDir: root, github: { triggerLabel: "junco" } } as unknown as Config;
    enqueueOp(cfg, "prflow", {
      kind: "pr",
      repoPath: "/repo",
      branch: "junco/x",
      nwo: "a/b",
      issue: null,
      base: "main",
      title: "t",
      bodyText: "b",
      draft: false,
      labels: [],
      reviewers: [],
      finalize: null,
      pushed: true,
      prUrl: null,
    });
    const f = fakes((tool, args) => {
      if (args[0] === "pr" && args[1] === "create")
        throw new GitOpError("gh failed", "a pull request for branch already exists", 1);
      if (args[0] === "pr" && args[1] === "view")
        return { stdout: "https://github.com/a/b/pull/3\n" };
      return undefined;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r.sent).toBe(1);
  });
});
