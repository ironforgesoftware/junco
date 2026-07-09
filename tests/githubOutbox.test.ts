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
  outboxDepth,
  deadCount,
  flushOutbox,
  tryOrEnqueue,
  isOffline,
  ensureFindingLabels,
  MAX_OP_ATTEMPTS,
  OUTBOX_MARKER_PREFIX,
  FLUSH_LOCK_FILENAME,
  type OutboxOp,
} from "../src/githubOutbox.js";
import { findingMarker, FINDING_LABEL_SPECS } from "../src/findings.js";
import { GitOpError } from "../src/git.js";
import type { Config } from "../src/types.js";

function cfgAt(root: string): Config {
  return { stateDir: root } as unknown as Config;
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
    const cfg = { stateDir: root, github: { triggerLabel: "junco" } } as unknown as Config;
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
