import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  outboxPaths,
  enqueueOp,
  listOps,
  listOpsFrom,
  listDeadOps,
  outboxDepth,
  deadCount,
  flushOutbox,
  tryOrEnqueue,
  isOffline,
  ensureFindingLabels,
  fetchFindingMarkers,
  withCommentMarker,
  MAX_OP_ATTEMPTS,
  FLUSH_LOCK_FILENAME,
  type OutboxOp,
} from "../src/githubOutbox.js";
import { findingMarker, FINDING_LABEL_SPECS } from "../src/findings.js";
import { PIDFILE_DISCRIMINATOR_PREFIX } from "../src/pidfileLock.js";
import { GitOpError } from "../src/git.js";
import type { Config } from "../src/types.js";
import { writePending, readPending, type PendingAssess } from "../src/assessReview.js";
import { parseResultMeta } from "../src/resultMeta.js";
import { sweepDependencies } from "../src/ticketDeps.js";
import { parseTicket } from "../src/ticket.js";
import { makeConfig, type ConfigSeams } from "./helpers/config.js";

function cfgAt(root: string): Config {
  return { dataDir: root } as unknown as Config;
}
const LABELS: Extract<OutboxOp, { kind: "labels" }> = {
  kind: "labels",
  nwo: "a/b",
  issue: 7,
  add: ["junco:approved"],
  remove: [],
};

/** Build an issue-create StoredOp for the outbox — mirrors the LABELS const
 * above as a per-test fixture with overridable fields. */
function mkIssueCreateOp(
  overrides: Partial<Extract<OutboxOp, { kind: "issue-create" }>> = {},
): OutboxOp {
  const fingerprint = overrides.fingerprint ?? "deadbeefcafebabe";
  return {
    kind: "issue-create",
    nwo: "a/b",
    title: "[high] Vulnerable lodash (GHSA-xxxx-yyyy-zzzz)",
    bodyText: `body text\n\n${findingMarker(fingerprint)}`,
    labels: ["junco:finding", "severity/high"],
    fingerprint,
    ...overrides,
  };
}

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

describe("deadCount", () => {
  it("counts only .json files in the dead/ subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-dead-"));
    const cfg = cfgAt(root);
    const { dead } = outboxPaths(cfg);
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "a.json"), "{}", "utf8");
    writeFileSync(join(dead, "b.json"), "{}", "utf8");
    writeFileSync(join(dead, "notes.txt"), "x", "utf8");
    expect(deadCount(cfg)).toBe(2);
  });

  it("missing dead/ dir (nothing ever dead-lettered) → 0", () => {
    const cfg = cfgAt(join(tmpdir(), "junco-obx-dead-nonexistent-xyz"));
    expect(deadCount(cfg)).toBe(0);
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

  it("comment op dedups on the content marker in the operator's own upstream comment", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f2-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "reporter", { kind: "comment", nwo: "a/b", issue: 7, body: "hello" });
    const ME = "junco-bot";
    // junco's own already-delivered comment carries the content-derived marker.
    const delivered = withCommentMarker("a/b", 7, "hello");
    let posted = 0;
    const f = fakes((tool, args) => {
      if (tool === "gh" && args[0] === "api" && args[1] === "user") return { stdout: `${ME}\n` };
      if (tool === "gh" && args[0] === "api")
        return { stdout: JSON.stringify({ login: ME, body: delivered }) };
      if (tool === "gh" && args[0] === "issue" && args[1] === "comment") posted++;
      return undefined;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r.sent).toBe(1);
    expect(posted).toBe(0); // marker found in our own comment → already delivered
  });

  it("a foreign-author pre-planted marker does NOT suppress junco's own comment (#132)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f2b-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "reporter", { kind: "comment", nwo: "a/b", issue: 7, body: "hello" });
    const ME = "junco-bot";
    // An outsider pre-planted the (content-derivable) marker — but under a
    // different author. Author-scoping must ignore it so junco still posts.
    const foreign = withCommentMarker("a/b", 7, "hello");
    let posted = 0;
    const f = fakes((tool, args) => {
      if (tool === "gh" && args[0] === "api" && args[1] === "user") return { stdout: `${ME}\n` };
      if (tool === "gh" && args[0] === "api")
        return { stdout: JSON.stringify({ login: "attacker", body: foreign }) };
      if (tool === "gh" && args[0] === "issue" && args[1] === "comment") posted++;
      return undefined;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r.sent).toBe(1);
    expect(posted).toBe(1); // foreign marker ignored → junco still posts once
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

  it("concurrent-flusher race: ENOENT from rm after success is a silent skip, not sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-race1-"));
    const cfg = cfgAt(root);
    const stolen = enqueueOp(cfg, "dashboard", { ...LABELS });
    enqueueOp(cfg, "dashboard", { ...LABELS, issue: 8 });
    const f = fakes(() => undefined);
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    const r = await flushOutbox(cfg, {
      ghFn: f.ghFn,
      gitFn: f.gitFn,
      // The other flusher already deleted the first op's file.
      rmFn: (p: string) => {
        if (p.includes(stolen)) throw enoent;
        rmSync(p, { force: true });
      },
    });
    expect(r).toMatchObject({ sent: 1, dead: 0, remaining: 0, offline: false });
    expect(outboxDepth(cfg)).toBe(1); // the stolen file is the other flusher's to remove
  });

  it("concurrent-flusher race: ENOENT from the dead-letter rename skips (no dead count, no throw)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-race2-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const f = fakes(() => {
      throw PERM_ERR;
    });
    // Burn attempts up to MAX-1 with the real rename (rewrite path).
    for (let i = 1; i < MAX_OP_ATTEMPTS; i++)
      await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    const last = await flushOutbox(cfg, {
      ghFn: f.ghFn,
      gitFn: f.gitFn,
      renameFn: () => {
        throw enoent;
      },
    });
    expect(last).toMatchObject({ sent: 0, dead: 0, remaining: 0, offline: false });
  });

  it("mixed pass: op0 dead-letters and op1 goes offline in the same flush", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-mixed-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS }); // issue 7 — will dead-letter
    const f1 = fakes(() => {
      throw PERM_ERR;
    });
    for (let i = 1; i < MAX_OP_ATTEMPTS; i++)
      await flushOutbox(cfg, { ghFn: f1.ghFn, gitFn: f1.gitFn }); // attempts → MAX-1
    enqueueOp(cfg, "dashboard", { ...LABELS, issue: 8 }); // fresh — will hit the network
    const f2 = fakes((_tool, args) => {
      if (args.includes("8")) throw NET_ERR;
      throw PERM_ERR;
    });
    const r = await flushOutbox(cfg, { ghFn: f2.ghFn, gitFn: f2.gitFn });
    expect(r).toMatchObject({ sent: 0, dead: 1, remaining: 1, offline: true });
    expect(readdirSync(outboxPaths(cfg).dead)).toHaveLength(1);
  });

  it("a created PR op that dead-letters preserves its finalize tail as a replayable op (#77)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-77-"));
    const cfg = { dataDir: root, github: { triggerLabel: "junco" } } as unknown as Config;
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
      pushed: true, // push already landed
      prUrl: "https://github.com/a/b/pull/9", // PR already created (checkpointed)
    });

    // Finalize comment posts fine; the done/failed LABEL flip fails permanently
    // (e.g. a token that lost issues:write). Comments are tracked so the dedup
    // across the original + replayed tail can be asserted. The dedup scan is
    // author-scoped, so the fake reports junco's own posted comment as NDJSON
    // {login, body} under the operator login.
    const ME = "junco-bot";
    let commentBody = "";
    let commentPosts = 0;
    const f = fakes((_tool, args) => {
      if (args[0] === "api" && args[1] === "user") return { stdout: `${ME}\n` };
      if (args[0] === "api")
        return { stdout: commentBody ? JSON.stringify({ login: ME, body: commentBody }) : "" };
      if (args[0] === "issue" && args[1] === "comment") {
        commentPosts++;
        const idx = args.indexOf("--body-file");
        commentBody = readFileSync(args[idx + 1], "utf8");
        return undefined;
      }
      if (args[0] === "issue" && args[1] === "edit") throw PERM_ERR;
      return undefined;
    });

    // Burn the original op to dead-letter.
    let res: Awaited<ReturnType<typeof flushOutbox>> | undefined;
    for (let i = 0; i < MAX_OP_ATTEMPTS; i++)
      res = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(res!.dead).toBe(1);
    expect(readdirSync(outboxPaths(cfg).dead)).toHaveLength(1); // original parked in dead/
    expect(commentPosts).toBe(1); // posted once, then deduped across attempts

    // The finalize tail was re-enqueued (bounded, finalizeOnly); its finalize
    // comment dedups on the content-derived marker (stable across original +
    // tail since the body is identical), not the old guessable pr:<url> key.
    const live = listOps(cfg);
    expect(live).toHaveLength(1);
    const tail = live[0].op as Extract<OutboxOp, { kind: "pr" }>;
    expect(tail).toMatchObject({
      finalizeOnly: true,
      pushed: true,
      prUrl: "https://github.com/a/b/pull/9",
      issue: 7,
    });
    expect(tail.finalize).not.toBeNull();

    // Replaying the tail does NOT re-post the finalize comment (dedup by the
    // content-derived marker), and — the label flip still failing — it
    // dead-letters WITHOUT spawning yet another tail (re-enqueue is bounded to one).
    for (let i = 0; i < MAX_OP_ATTEMPTS; i++)
      await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(commentPosts).toBe(1); // no double comment
    expect(outboxDepth(cfg)).toBe(0); // no new tail regenerated
    expect(readdirSync(outboxPaths(cfg).dead)).toHaveLength(2); // original + tail
  });

  it("pr composite: push → create → finalize comment → labels, with checkpoint resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f5-"));
    const cfg = {
      dataDir: root,
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

  it("unknown op kind dead-letters instead of vanishing (version-skew / hand-edited op)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-unknown-"));
    const cfg = cfgAt(root);
    const { dir } = outboxPaths(cfg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "1-0000-aaaa-bogus.json"),
      JSON.stringify({
        id: "1-0000-aaaa-bogus",
        createdAt: new Date().toISOString(),
        origin: "dashboard",
        issueKey: null,
        attempts: 0,
        lastError: null,
        op: { kind: "bogus" },
      }),
      "utf8",
    );
    const f = fakes(() => undefined);
    for (let i = 1; i < MAX_OP_ATTEMPTS; i++) {
      const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
      expect(r).toMatchObject({ sent: 0, dead: 0, remaining: 1, offline: false });
      expect(listOps(cfg)[0].attempts).toBe(i);
      expect(listOps(cfg)[0].lastError).toMatch(/unknown outbox op kind: bogus/);
    }
    const last = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(last).toMatchObject({ sent: 0, dead: 1, remaining: 0 });
    expect(outboxDepth(cfg)).toBe(0); // never counted sent — it dead-lettered
    expect(readdirSync(outboxPaths(cfg).dead)).toHaveLength(1);
    expect(f.calls).toHaveLength(0); // never touched gh/git — rejected before any call
  });

  it("pr create 'already exists' resolves the URL via pr view", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f6-"));
    const cfg = { dataDir: root, github: { triggerLabel: "junco" } } as unknown as Config;
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

  it("replays a push op against its remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-remote1-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "prflow", {
      kind: "push",
      repoPath: "/repo",
      branch: "junco/x",
      remote: "fork",
    });
    const f = fakes(() => undefined);
    await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    const gitCalls = f.calls.filter((c) => c.tool === "git");
    expect(gitCalls[0].args).toEqual(["-C", "/repo", "push", "--set-upstream", "fork", "junco/x"]);
  });

  it("pr op pushes to op.remote and creates with --head op.head", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-remote2-"));
    const cfg = { dataDir: root, github: { triggerLabel: "junco" } } as unknown as Config;
    enqueueOp(cfg, "prflow", {
      kind: "pr",
      repoPath: "/repo",
      branch: "junco/x",
      remote: "fork",
      head: "me:junco/x",
      nwo: "up/stream",
      issue: null,
      base: "main",
      title: "t",
      bodyText: "b",
      draft: true,
      labels: [],
      reviewers: [],
      finalize: null,
      pushed: false,
      prUrl: null,
    });
    const f = fakes((_tool, args) => {
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/up/stream/pull/1\n" };
      }
      return undefined;
    });
    await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    const gitCalls = f.calls.filter((c) => c.tool === "git");
    expect(gitCalls[0].args).toEqual(["-C", "/repo", "push", "--set-upstream", "fork", "junco/x"]);
    const ghCalls = f.calls.filter((c) => c.tool === "gh");
    const create = ghCalls.find((c) => c.args[0] === "pr" && c.args[1] === "create")!;
    expect(create.args).toContain("--head");
    expect(create.args[create.args.indexOf("--head") + 1]).toBe("me:junco/x");
  });

  it("pr op with ticketId writes pr_url back onto the done ticket, clearing pr_queued (#298)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-prurl-"));
    const cfg = {
      dataDir: root,
      queueRoot: root,
      github: { triggerLabel: "junco" },
    } as unknown as Config;
    const doneDir = join(root, "done");
    mkdirSync(doneDir, { recursive: true });
    const donePath = join(doneDir, "t1.md");
    writeFileSync(
      donePath,
      "---\nid: t1\n---\nBody\n\n---\n<!-- junco-result\nstatus: completed\npushed: true\npr_queued: true\n-->\n",
    );
    enqueueOp(cfg, "prflow", {
      kind: "pr",
      repoPath: "/repo",
      branch: "junco/t1",
      nwo: "a/b",
      issue: null,
      base: "main",
      title: "t",
      bodyText: "b",
      draft: false,
      labels: [],
      reviewers: [],
      finalize: null,
      ticketId: "t1",
      pushed: true,
      prUrl: null,
    });
    const f = fakes((_tool, args) => {
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/a/b/pull/42\n" };
      }
      return undefined;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r.sent).toBe(1);
    const after = parseResultMeta(readFileSync(donePath, "utf8"));
    expect(after.prUrl).toBe("https://github.com/a/b/pull/42");
    expect(after.prQueued).toBe(false);
  });

  it("pr op with ticketId whose done file is absent still flushes successfully (#298)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-prurl-absent-"));
    const cfg = {
      dataDir: root,
      queueRoot: root,
      github: { triggerLabel: "junco" },
    } as unknown as Config;
    // No done/ directory or file at all — the ticket may have been retried,
    // archived, or moved by hand since it finalized. The op must still send.
    enqueueOp(cfg, "prflow", {
      kind: "pr",
      repoPath: "/repo",
      branch: "junco/gone",
      nwo: "a/b",
      issue: null,
      base: "main",
      title: "t",
      bodyText: "b",
      draft: false,
      labels: [],
      reviewers: [],
      finalize: null,
      ticketId: "gone",
      pushed: true,
      prUrl: null,
    });
    const f = fakes((_tool, args) => {
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/a/b/pull/43\n" };
      }
      return undefined;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r.sent).toBe(1);
    expect(r.dead).toBe(0);
  });

  it("ops without remote/head replay exactly as before (origin, bare branch)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-remote3-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "prflow", { kind: "push", repoPath: "/repo", branch: "junco/x" });
    const f = fakes(() => undefined);
    await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    const gitCalls = f.calls.filter((c) => c.tool === "git");
    expect(gitCalls[0].args).toEqual([
      "-C",
      "/repo",
      "push",
      "--set-upstream",
      "origin",
      "junco/x",
    ]);
  });

  describe("issue-create op", () => {
    it("replay dedup: marker already present upstream skips create, op consumed", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-obx-ic1-"));
      const cfg = cfgAt(root);
      const fp = "deadbeefcafebabe";
      enqueueOp(cfg, "assess", mkIssueCreateOp({ fingerprint: fp }));
      const f = fakes((_tool, args) => {
        if (args[0] === "issue" && args[1] === "list") {
          return { stdout: JSON.stringify([{ body: `some body\n${findingMarker(fp)}` }]) };
        }
        return undefined;
      });
      const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
      expect(r).toMatchObject({ sent: 1, dead: 0, remaining: 0, offline: false });
      expect(outboxDepth(cfg)).toBe(0);
      expect(
        f.calls.some((c) => c.tool === "gh" && c.args[0] === "issue" && c.args[1] === "create"),
      ).toBe(false);
    });

    it("replay dedup: null issue bodies are tolerated (ignored), a later body's marker still dedups", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-obx-ic1b-"));
      const cfg = cfgAt(root);
      const fp = "deadbeefcafebabe";
      enqueueOp(cfg, "assess", mkIssueCreateOp({ fingerprint: fp }));
      const f = fakes((_tool, args) => {
        if (args[0] === "issue" && args[1] === "list") {
          return {
            stdout: JSON.stringify([{ body: null }, { body: `some body\n${findingMarker(fp)}` }]),
          };
        }
        return undefined;
      });
      const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
      expect(r).toMatchObject({ sent: 1, dead: 0, remaining: 0, offline: false });
      expect(outboxDepth(cfg)).toBe(0);
      expect(
        f.calls.some((c) => c.tool === "gh" && c.args[0] === "issue" && c.args[1] === "create"),
      ).toBe(false);
    });

    it("create path: labels first, then issue list, then issue create with title/body-file/labels", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-obx-ic2-"));
      const cfg = cfgAt(root);
      const op = mkIssueCreateOp({}) as Extract<OutboxOp, { kind: "issue-create" }>;
      enqueueOp(cfg, "assess", op);
      let capturedBody: string | null = null;
      const f = fakes((_tool, args) => {
        if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
        if (args[0] === "issue" && args[1] === "create") {
          const idx = args.indexOf("--body-file");
          capturedBody = readFileSync(args[idx + 1], "utf8");
          return { stdout: "https://github.com/a/b/issues/1\n" };
        }
        return undefined;
      });
      const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
      expect(r).toMatchObject({ sent: 1, dead: 0, remaining: 0, offline: false });

      const kinds = f.calls.map((c) => c.args.slice(0, 2).join(" "));
      expect(kinds).toEqual(["label create", "label create", "issue list", "issue create"]);

      const createCall = f.calls[3];
      expect(createCall.args).toContain("--title");
      expect(createCall.args[createCall.args.indexOf("--title") + 1]).toBe(op.title);
      for (const l of op.labels) expect(createCall.args).toContain(l);
      expect(capturedBody).toBe(op.bodyText);
    });

    it("two duplicate ops in one flush converge to a single issue create", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-obx-ic3-"));
      const cfg = cfgAt(root);
      const fp = "cafebabedeadbeef";
      enqueueOp(cfg, "assess", mkIssueCreateOp({ fingerprint: fp }));
      enqueueOp(cfg, "assess", mkIssueCreateOp({ fingerprint: fp }));
      let recordedBody: string | null = null;
      let createCount = 0;
      const f = fakes((_tool, args) => {
        if (args[0] === "issue" && args[1] === "list") {
          return { stdout: JSON.stringify(recordedBody ? [{ body: recordedBody }] : []) };
        }
        if (args[0] === "issue" && args[1] === "create") {
          createCount++;
          const idx = args.indexOf("--body-file");
          recordedBody = readFileSync(args[idx + 1], "utf8");
          return { stdout: "https://github.com/a/b/issues/2\n" };
        }
        return undefined;
      });
      const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
      expect(r).toMatchObject({ sent: 2, dead: 0, remaining: 0, offline: false });
      expect(createCount).toBe(1);
      expect(outboxDepth(cfg)).toBe(0);
    });

    it("offline: issue list network failure halts the flush, attempts untouched", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-obx-ic4-"));
      const cfg = cfgAt(root);
      enqueueOp(cfg, "assess", mkIssueCreateOp({}));
      const f = fakes((_tool, args) => {
        if (args[0] === "issue" && args[1] === "list") throw NET_ERR;
        return undefined;
      });
      const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
      expect(r).toMatchObject({ sent: 0, dead: 0, remaining: 1, offline: true });
      expect(listOps(cfg)[0].attempts).toBe(0);
    });

    it("dead-letters at MAX_OP_ATTEMPTS when issue create fails with a permanent error", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-obx-ic5-"));
      const cfg = cfgAt(root);
      enqueueOp(cfg, "assess", mkIssueCreateOp({}));
      const f = fakes((_tool, args) => {
        if (args[0] === "issue" && args[1] === "list") return { stdout: "[]" };
        if (args[0] === "issue" && args[1] === "create") throw PERM_ERR;
        return undefined;
      });
      for (let i = 1; i < MAX_OP_ATTEMPTS; i++) {
        const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
        expect(r).toMatchObject({ sent: 0, dead: 0, remaining: 1 });
        expect(listOps(cfg)[0].attempts).toBe(i);
      }
      const last = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
      expect(last).toMatchObject({ dead: 1, remaining: 0 });
      expect(outboxDepth(cfg)).toBe(0);
      expect(readdirSync(outboxPaths(cfg).dead)).toHaveLength(1);
      // Confirms the real issue-create path ran (labels + list) on every
      // attempt, not e.g. an unknown-kind fallthrough that also happens to
      // dead-letter after MAX_OP_ATTEMPTS.
      expect(f.calls.filter((c) => c.args[0] === "issue" && c.args[1] === "list")).toHaveLength(
        MAX_OP_ATTEMPTS,
      );
      expect(
        f.calls.filter((c) => c.args[0] === "label" && c.args[1] === "create"),
      ).not.toHaveLength(0);
    });
  });
});

describe("flushOutbox — flush lock", () => {
  it("second flusher skips cleanly while a live flusher holds the lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-lock1-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    // Simulate a concurrent live flusher: our own pid is definitionally alive
    // (exercises the real default liveness probe).
    const lockPath = join(outboxPaths(cfg).dir, FLUSH_LOCK_FILENAME);
    writeFileSync(lockPath, `${process.pid}\n`, "utf8");
    const f = fakes(() => undefined);
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r).toMatchObject({ sent: 0, dead: 0, remaining: 1, offline: false, skipped: true });
    expect(f.calls).toHaveLength(0); // never touched gh/git
    expect(outboxDepth(cfg)).toBe(1); // the op is the other flusher's to send
    // The lock belongs to the other flusher — the skipper must not release it.
    expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}\n`);
  });

  it("stale lock (dead owner pid) is reclaimed, the flush proceeds, and the lock is released after", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-lock2-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const lockPath = join(outboxPaths(cfg).dir, FLUSH_LOCK_FILENAME);
    writeFileSync(lockPath, "99999\n", "utf8");
    const f = fakes(() => undefined);
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn, pidAliveFn: () => false });
    expect(r).toMatchObject({ sent: 1, dead: 0, remaining: 0, offline: false });
    expect(r.skipped).toBeUndefined();
    expect(outboxDepth(cfg)).toBe(0);
    expect(existsSync(lockPath)).toBe(false); // released in finally
  });

  it("unparseable lock content is stale even when the liveness probe would say alive", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-lock3-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const lockPath = join(outboxPaths(cfg).dir, FLUSH_LOCK_FILENAME);
    writeFileSync(lockPath, "not-a-pid\n", "utf8");
    const f = fakes(() => undefined);
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn, pidAliveFn: () => true });
    expect(r).toMatchObject({ sent: 1, dead: 0, remaining: 0, offline: false });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a normal flush releases the lock even when an op dead-letter path throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-lock4-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const f = fakes(() => {
      throw PERM_ERR;
    });
    // Burn to MAX-1, then make the dead-letter rename explode (non-ENOENT) —
    // the one class flushOutbox still propagates by design.
    for (let i = 1; i < MAX_OP_ATTEMPTS; i++)
      await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    await expect(
      flushOutbox(cfg, {
        ghFn: f.ghFn,
        gitFn: f.gitFn,
        renameFn: () => {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        },
      }),
    ).rejects.toThrow("EACCES");
    // The lock must not leak — the next flusher is not blocked.
    expect(existsSync(join(outboxPaths(cfg).dir, FLUSH_LOCK_FILENAME))).toBe(false);
  });

  it("empty outbox returns zeros without creating the outbox dir or the lock", async () => {
    const root = join(tmpdir(), "junco-obx-lock-nonexistent-xyz");
    const cfg = cfgAt(root);
    const f = fakes(() => undefined);
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r).toMatchObject({ sent: 0, dead: 0, remaining: 0, offline: false });
    expect(existsSync(outboxPaths(cfg).dir)).toBe(false);
  });

  it("recycled owner pid does not block flushes forever (start-time discriminator, #74)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-lock74-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const lockPath = join(outboxPaths(cfg).dir, FLUSH_LOCK_FILENAME);
    // A crashed flusher (pid 4242) left this lock; the OS later recycled pid
    // 4242 to an unrelated LIVE process whose identity differs. The old
    // pid-only lock saw pidAlive(4242)=true and skipped forever.
    writeFileSync(lockPath, `4242\n${PIDFILE_DISCRIMINATOR_PREFIX}crashed-owner-start\n`, "utf8");
    const f = fakes(() => undefined);
    const r = await flushOutbox(cfg, {
      ghFn: f.ghFn,
      gitFn: f.gitFn,
      pidAliveFn: () => true, // pid 4242 is alive (recycled)
      getProcessStartTimeFn: () => `${PIDFILE_DISCRIMINATOR_PREFIX}unrelated-live-start`,
    });
    expect(r).toMatchObject({ sent: 1, dead: 0, remaining: 0, offline: false });
    expect(r.skipped).toBeUndefined(); // reclaimed, not blocked
    expect(existsSync(lockPath)).toBe(false); // released after the flush
  });

  it("steal is atomic — never destroys a racing winner's fresh flush lock (ABA, #68)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-lock68-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const lockPath = join(outboxPaths(cfg).dir, FLUSH_LOCK_FILENAME);
    // We judge this lock stale (recycled pid) ...
    writeFileSync(lockPath, `${process.pid}\n${PIDFILE_DISCRIMINATOR_PREFIX}stale-old\n`, "utf8");
    const CURRENT = `${PIDFILE_DISCRIMINATOR_PREFIX}current-live`;
    const freshLiveContent = `${process.pid}\n${CURRENT}\n`;
    const f = fakes(() => undefined);
    let calls = 0;
    const r = await flushOutbox(cfg, {
      ghFn: f.ghFn,
      gitFn: f.gitFn,
      // During the identity check (call 2 — between judging stale and stealing)
      // a racing starter completes its ENTIRE steal: the lock name now holds a
      // fresh, live, matching pidfile. The rename-aside steal must detect this
      // on post-move verification and LOSE, leaving the winner's lock in place.
      // The naive unlink-in-place steal (#68) destroyed it and let both flush.
      getProcessStartTimeFn: () => {
        calls += 1;
        if (calls === 2) {
          rmSync(lockPath, { force: true });
          writeFileSync(lockPath, freshLiveContent, "utf8");
        }
        return CURRENT;
      },
    });
    expect(r).toMatchObject({ sent: 0, remaining: 1, skipped: true });
    expect(f.calls).toHaveLength(0); // never flushed — the winner is running
    expect(readFileSync(lockPath, "utf8")).toBe(freshLiveContent); // winner preserved
  });
});

describe("fetchFindingMarkers", () => {
  it("scans bodies marker-scoped: any author, all states, no label filter (#221)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-ffm-"));
    const cfg = cfgAt(root);
    const f = fakes((_tool, args) => {
      if (args[0] === "issue" && args[1] === "list") {
        // Two markers from two different authors — indistinguishable in the
        // body-only response, which is exactly the point: dedup keys on the
        // marker, never on who filed it. An identity split (bot daemon /
        // me filings, a fileAs switch) must not blind either scan.
        return {
          stdout: JSON.stringify([
            { body: `x ${findingMarker("deadbeef")} y` },
            { body: `z ${findingMarker("cafe0042")} w` },
          ]),
        };
      }
      return undefined;
    });
    const markers = await fetchFindingMarkers(cfg, "o/r", f.ghFn);
    expect(markers.has("deadbeef")).toBe(true);
    expect(markers.has("cafe0042")).toBe(true);
    // Marker-scoped: the listing must NOT be narrowed to the caller's identity.
    expect(f.calls[0].args).not.toContain("--author");
    expect(f.calls[0].args).not.toContain("@me");
    expect(f.calls[0].args).not.toContain("--label");
    expect(f.calls[0].args).toContain("--state");
    expect(f.calls[0].args).toContain("all");
  });
});

describe("ensureFindingLabels", () => {
  it("known labels get their FINDING_LABEL_SPECS color/description; unknown gets the neutral default; --force present", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-efl-"));
    const cfg = cfgAt(root);
    const f = fakes(() => undefined);
    await ensureFindingLabels(cfg, "a/b", ["junco:finding", "custom-trigger"], f.ghFn);
    expect(f.calls).toHaveLength(2);
    const [, color, description] = FINDING_LABEL_SPECS[0];
    expect(f.calls[0].args).toEqual([
      "label",
      "create",
      "junco:finding",
      "--repo",
      "a/b",
      "--color",
      color,
      "--description",
      description,
      "--force",
    ]);
    expect(f.calls[1].args).toEqual([
      "label",
      "create",
      "custom-trigger",
      "--repo",
      "a/b",
      "--color",
      "ededed",
      "--description",
      "",
      "--force",
    ]);
  });
});

describe("listOpsFrom / listDeadOps", () => {
  it("listDeadOps returns [] when the dead dir has never been created", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxdead-"));
    expect(listDeadOps(cfgAt(root))).toEqual([]);
  });

  it("listDeadOps reads dead/ — sorted by filename, skipping unparseable & non-json", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxdead2-"));
    const cfg = cfgAt(root);
    const dead = outboxPaths(cfg).dead;
    mkdirSync(dead, { recursive: true });
    const opA = {
      id: "ignored-by-list", // listOpsFrom re-derives id from the filename stem
      createdAt: "2026-07-07T00:00:00.000Z",
      origin: "prflow" as const,
      issueKey: "a/b#7",
      attempts: 3,
      lastError: "boom",
      op: { ...LABELS },
    };
    writeFileSync(join(dead, "100-0001-aaaa-labels.json"), JSON.stringify(opA));
    writeFileSync(
      join(dead, "200-0002-bbbb-labels.json"),
      JSON.stringify({ ...opA, lastError: "later" }),
    );
    writeFileSync(join(dead, "garbage.json"), "{ not json");
    writeFileSync(join(dead, "ignore.txt"), "nope");
    const ops = listDeadOps(cfg);
    expect(ops.map((o) => o.id)).toEqual(["100-0001-aaaa-labels", "200-0002-bbbb-labels"]);
    expect(ops[0].path).toBe(join(dead, "100-0001-aaaa-labels.json"));
    expect(ops[1].lastError).toBe("later");
  });

  it("listOps delegates through listOpsFrom (live dir round-trips)", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxlive-"));
    const cfg = cfgAt(root);
    const id = enqueueOp(cfg, "dashboard", { ...LABELS });
    expect(listOpsFrom(outboxPaths(cfg).dir, {}).map((o) => o.id)).toEqual([id]);
    expect(listOps(cfg).map((o) => o.id)).toEqual([id]);
  });
});

describe("flush upgrades queued filed records (#232)", () => {
  const mkGh = (calls: string[][]): unknown =>
    (async (_c: unknown, args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[0] === "issue" && args[1] === "create")
        return { stdout: "https://github.com/a/b/issues/42\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown;

  const parkedBatch = (filedHow: "queued" | "created"): PendingAssess => ({
    id: "assess-a-b-1",
    nwo: "a/b",
    external: false,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-19T00:00:00.000Z",
    findings: [
      {
        fingerprint: "deadbeefcafebabe",
        kind: "code",
        severity: "high",
        ruleId: "R1",
        title: "One",
        description: "d",
        references: [],
      },
    ],
    filed: {
      deadbeefcafebabe: {
        at: "2026-07-19T01:00:00.000Z",
        how: filedHow,
        ...(filedHow === "created" ? { url: "https://github.com/a/b/issues/5" } : {}),
      },
    },
  });

  it("a flushed issue-create upgrades the batch's queued record to created + URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-up-"));
    const cfg = cfgAt(root);
    writePending(cfg, parkedBatch("queued"));
    enqueueOp(cfg, "assess", mkIssueCreateOp());
    const calls: string[][] = [];
    const r = await flushOutbox(cfg, { ghFn: mkGh(calls) as never });
    expect(r.sent).toBe(1);
    const rec = readPending(cfg, "assess-a-b-1").batch?.filed?.deadbeefcafebabe;
    expect(rec?.how).toBe("created");
    expect(rec?.url).toBe("https://github.com/a/b/issues/42");
  });

  it("a marker-deduped flush upgrades queued → deduped, and never touches created", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-up2-"));
    const cfg = cfgAt(root);
    writePending(cfg, parkedBatch("queued"));
    enqueueOp(cfg, "assess", mkIssueCreateOp());
    // The marker already exists upstream → the op dedup-returns without creating.
    const gh = (async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list")
        return {
          stdout: JSON.stringify([{ body: findingMarker("deadbeefcafebabe") }]),
          stderr: "",
          code: 0,
        };
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown;
    await flushOutbox(cfg, { ghFn: gh as never });
    expect(readPending(cfg, "assess-a-b-1").batch?.filed?.deadbeefcafebabe?.how).toBe("deduped");

    // A `created` record is never downgraded by the same dedup-return path.
    const root2 = mkdtempSync(join(tmpdir(), "junco-obx-up3-"));
    const cfg2 = cfgAt(root2);
    writePending(cfg2, parkedBatch("created"));
    enqueueOp(cfg2, "assess", mkIssueCreateOp());
    await flushOutbox(cfg2, { ghFn: gh as never });
    const rec2 = readPending(cfg2, "assess-a-b-1").batch?.filed?.deadbeefcafebabe;
    expect(rec2?.how).toBe("created");
    expect(rec2?.url).toBe("https://github.com/a/b/issues/5");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the actual seam this feature closes (#298). Task 1 taught the
// dependency sweep to WAIT on a `pr_queued` marker; this task (Task 2) teaches
// the outbox flush to clear it by writing the real pr_url back onto the done
// ticket. Each half is covered above in isolation — this drives the whole
// path in one test: flush learns the URL → upserts the done file → the
// dependency sweep then stamps the waiting dependent. Without this junction
// test, both halves could be individually green while the seam between them
// is broken.
// ---------------------------------------------------------------------------
describe("flushOutbox → sweepDependencies: closes the offline PR dependency window (#298)", () => {
  it("a flush that learns pr_url unblocks a dependent parked waiting on pr_queued", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-e2e-"));
    const seams: ConfigSeams = {
      dataDir: join(root, "data"),
      queueRoot: root,
      worktreeRoot: join(root, "wt"),
      tools: [],
      criticEnabled: false,
      planLintEnabled: false,
      verifyEnabled: false,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: true,
    };
    const cfg = makeConfig(seams);
    const inbox = join(root, "inbox");
    const done = join(root, "done");
    mkdirSync(inbox, { recursive: true });
    mkdirSync(done, { recursive: true });

    // The parent finalized DONE offline: its PR is parked in the outbox, so
    // pr_queued is set and there's no pr_url yet (Task 1's marker).
    const parentPath = join(done, "parent.md");
    writeFileSync(
      parentPath,
      "---\nid: parent\n---\nBody\n\n---\n<!-- junco-result\nstatus: completed\npushed: true\npr_queued: true\n-->\n",
    );
    // The dependent is parked in inbox/ waiting on that edge.
    const childPath = join(inbox, "child.md");
    writeFileSync(childPath, "---\nid: child\ndepends_on: [parent]\n---\n");

    // The queued outbox op for the parent's PR, carrying its ticketId.
    enqueueOp(cfg, "prflow", {
      kind: "pr",
      repoPath: "/repo",
      branch: "junco/parent",
      nwo: "a/b",
      issue: null,
      base: "main",
      title: "t",
      bodyText: "b",
      draft: false,
      labels: [],
      reviewers: [],
      finalize: null,
      ticketId: "parent",
      pushed: true,
      prUrl: null,
    });

    // Before the flush: the sweep waits — pr_queued still set, no pr_url.
    const before = await sweepDependencies(cfg, { prStateFn: async () => "merged" });
    expect(before).toEqual({ stamped: 0, cascaded: 0 });
    expect(existsSync(childPath)).toBe(true);
    expect(parseTicket(childPath, readFileSync(childPath, "utf8")).depsSatisfied).toEqual([]);

    // GitHub comes back: the flush opens the PR and learns its URL.
    const f = fakes((_tool, args) => {
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/a/b/pull/99\n" };
      }
      return undefined;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r.sent).toBe(1);

    // The done file's result block now carries the real pr_url, pr_queued cleared.
    const parentMeta = parseResultMeta(readFileSync(parentPath, "utf8"));
    expect(parentMeta.prUrl).toBe("https://github.com/a/b/pull/99");
    expect(parentMeta.prQueued).toBe(false);

    // The sweep can now probe the real PR and stamp the dependent satisfied.
    const after = await sweepDependencies(cfg, { prStateFn: async () => "merged" });
    expect(after).toEqual({ stamped: 1, cascaded: 0 });
    const child = parseTicket(childPath, readFileSync(childPath, "utf8"));
    expect(child.depsSatisfied).toEqual(["parent"]);
  });
});
