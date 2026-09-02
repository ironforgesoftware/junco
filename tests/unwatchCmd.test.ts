import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readWatchlist } from "../src/watchlist.js";
import { dataTreePaths } from "../src/dataTree.js";
import {
  isUnder,
  planUnwatch,
  runUnwatch,
  runUnwatchCommand,
  type UnwatchPlan,
} from "../src/unwatchCmd.js";
import { repoDiscriminator } from "../src/worktree.js";
import { enqueueOp, outboxPaths } from "../src/githubOutbox.js";
import { writePending } from "../src/assessReview.js";
import { writeDraft } from "../src/commentReview.js";
import { recordRun, historyFilePath } from "../src/assessHistory.js";
import { cachePathFor, prCachePathFor } from "../src/githubCachePaths.js";
import { chatSlug } from "../src/chat/chatKey.js";
import {
  draftFilesDir,
  draftJsonPath,
  writeChatDraft,
  type PendingDraft,
} from "../src/chat/draftStore.js";
import { makeTree, watch, writeTicket } from "./helpers/unwatchTree.js";

/** Minimal parked-draft fixture (mirrors tests/draftStore.test.ts's own). */
function chatDraft(id: string, key: string, over: Partial<PendingDraft> = {}): PendingDraft {
  const slug = chatSlug(key);
  return {
    id,
    key,
    slug,
    kind: "ticket",
    files: [
      { name: "t.md", content: "---\nid: t\n---\n# T\n", lint: [], route: null, droppedKeys: [] },
    ],
    cwd: "/repo",
    nwo: key,
    createdAt: "2026-09-01T00:00:00.000Z",
    lintFailed: false,
    blocked: null,
    routeOverride: "auto",
    commandArgs: null,
    ...over,
  };
}

describe("planUnwatch — refusals and clone classification", () => {
  it("refuses a config-defined repo", () => {
    const { cfg } = makeTree({ configRepos: [{ nwo: "acme/api", path: "/config/api" }] });
    expect(planUnwatch(cfg, "acme/api")).toEqual({ ok: false, reason: "config-defined" });
    expect(planUnwatch(cfg, "ACME/API")).toEqual({ ok: false, reason: "config-defined" }); // ci
  });

  it("refuses when the watchlist is unreadable", () => {
    const { cfg } = makeTree();
    const file = dataTreePaths(cfg).watchlistFile;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");
    expect(planUnwatch(cfg, "acme/api")).toEqual({ ok: false, reason: "watchlist-unreadable" });
  });

  it("classifies a clone under clones/watched as managed (deleted)", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("watched");
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
    expect(out.plan.items).toContainEqual({ kind: "clone", path: clone });
    expect(out.plan.kept).toEqual([]);
    expect(out.plan.blocked).toBeNull();
  });

  it("classifies a clone under externalReposRoot as managed, external flows through", () => {
    const { cfg } = makeTree();
    const clone = join(cfg.github.externalReposRoot, "acme", "api");
    watch(cfg, "acme/api", clone, { external: true });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.external).toBe(true);
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
  });

  it("keeps a user-supplied path — never a clone item", () => {
    const { root, cfg } = makeTree();
    const mine = join(root, "my-checkout");
    watch(cfg, "acme/api", mine);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.clone).toEqual({ path: mine, managed: false });
    expect(out.plan.items.filter((i) => i.kind === "clone")).toEqual([]);
    expect(out.plan.kept).toEqual([`clone (user-owned): ${mine}`]);
  });
});

describe("planUnwatch — queue and worktrees", () => {
  it("enumerates inbox tickets targeting the repo and skips others", () => {
    const { root, cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const inbox = dataTreePaths(cfg).queue.inbox;
    const mine = writeTicket(inbox, "fix-1", clone);
    writeTicket(inbox, "other-1", join(root, "elsewhere"));
    writeFileSync(join(inbox, "qa-1.md"), "---\nid: qa-1\n---\n\nQ&A, no repo.\n", "utf8");
    // repo: "" must never canonPath to process cwd and accidentally match.
    writeFileSync(
      join(inbox, "empty-repo.md"),
      '---\nid: empty-repo\nrepo: ""\n---\n\nBlank repo.\n',
      "utf8",
    );
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items.filter((i) => i.kind === "inbox-ticket")).toEqual([
      { kind: "inbox-ticket", path: mine, detail: "fix-1" },
    ]);
    expect(out.plan.blocked).toBeNull(); // the empty-repo ticket never blocks either
  });

  it("includes the worktree namespace dir when present", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items).toContainEqual({ kind: "worktrees", path: ns });
  });

  it("a processing/ ticket for the repo blocks; other repos' don't", () => {
    const { root, cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const processing = dataTreePaths(cfg).queue.processing;
    writeTicket(processing, "other-live", join(root, "elsewhere"));
    expect(
      (planUnwatch(cfg, "acme/api") as { ok: true; plan: UnwatchPlan }).plan.blocked,
    ).toBeNull();
    writeTicket(processing, "live-1", clone);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.blocked).toEqual({ ticketId: "live-1" });
  });
});

describe("isUnder", () => {
  it("prefix-compares with a separator guard on synthetic paths", () => {
    expect(isUnder("/sbxroot/clones/watched/a/b", "/sbxroot/clones/watched")).toBe(true);
    expect(isUnder("/sbxroot/clones/watched", "/sbxroot/clones/watched")).toBe(false);
    expect(isUnder("/sbxroot/clones/watched-evil/x", "/sbxroot/clones/watched")).toBe(false);
  });
});

describe("planUnwatch — nwo-keyed stores", () => {
  it("enumerates outbox ops by nwo and by push repoPath; dead/ untouched", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "ACME/api", issue: 7, body: "hi" });
    enqueueOp(cfg, "prflow", { kind: "push", repoPath: clone, branch: "feat/x" });
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "other/repo", issue: 1, body: "no" });
    const dead = outboxPaths(cfg).dead;
    mkdirSync(dead, { recursive: true });
    const deadOp = join(dead, "1-0000-dead-comment.json");
    writeFileSync(
      deadOp,
      JSON.stringify({
        id: "1-0000-dead-comment",
        createdAt: "2026-08-19T00:00:00Z",
        origin: "dashboard",
        issueKey: "acme/api#7",
        attempts: 3,
        lastError: "boom",
        op: { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" },
      }),
      "utf8",
    );
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items.filter((i) => i.kind === "outbox-op")).toHaveLength(2);
    expect(out.plan.items.some((i) => i.path === deadOp)).toBe(false); // dead/ untouched by planning
    expect(existsSync(deadOp)).toBe(true);

    const res = await runUnwatch(cfg, "acme/api");
    expect(res.ok).toBe(true);
    expect(existsSync(deadOp)).toBe(true); // dead/ untouched by execution too
  });

  it("enumerates pending reviews, assess history, mirror, github-cache", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    writePending(cfg, {
      id: "assess-acme-api",
      nwo: "acme/api",
      external: false,
      autoPlan: false,
      repoPath: clone,
      createdAt: "2026-08-19T00:00:00Z",
      findings: [],
    });
    writeDraft(cfg, {
      id: "analyze-acme-api-1",
      nwo: "acme/api",
      issue: 3,
      issueTitle: "Something broke",
      external: false,
      repoPath: clone,
      createdAt: "2026-08-19T00:00:00Z",
      draft: "Looks like a regression.",
      footer: true,
    });
    recordRun(cfg, "acme/api", {
      ok: true,
      at: "2026-08-19T00:00:00Z",
      value: { found: 0, parked: 0 },
    });
    mkdirSync(join(dataTreePaths(cfg).mirror, "acme", "api"), { recursive: true });
    mkdirSync(dataTreePaths(cfg).githubCache, { recursive: true });
    writeFileSync(cachePathFor(cfg, "acme/api"), "{}", "utf8");
    writeFileSync(prCachePathFor(cfg, "acme/api"), "{}", "utf8");
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    const kinds = out.plan.items.map((i) => i.kind);
    for (const k of ["assess-review", "comment-review", "assess-history", "mirror", "github-cache"])
      expect(kinds).toContain(k);
    expect(out.plan.items.filter((i) => i.kind === "github-cache")).toHaveLength(2);
  });

  it("enumerates the chat session dir and a parked draft for this key; skips other keys' drafts", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const slug = chatSlug("acme/api");
    const chatDir = join(dataTreePaths(cfg).chats, slug);
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, "transcript.jsonl"), "", "utf8");
    writeChatDraft(cfg, chatDraft("acme__api-1", "acme/api"));
    writeChatDraft(cfg, chatDraft("other-repo-1", "other/repo"));
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items).toContainEqual({ kind: "chat-session", path: chatDir });
    expect(out.plan.items).toContainEqual({
      kind: "chat-draft",
      path: draftJsonPath(cfg, "acme__api-1"),
      detail: "acme__api-1",
    });
    expect(out.plan.items.some((i) => i.kind === "chat-draft" && i.detail === "other-repo-1")).toBe(
      false,
    );
  });

  it("no chat session dir on disk → no chat-session item", () => {
    const { cfg } = makeTree();
    watch(cfg, "acme/api", join(dataTreePaths(cfg).clonesWatched, "acme", "api"));
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items.some((i) => i.kind === "chat-session")).toBe(false);
  });

  it("assessHistory's historyFilePath matches what recordRun/planUnwatch see", () => {
    const { cfg } = makeTree();
    watch(cfg, "acme/api", join(dataTreePaths(cfg).clonesWatched, "acme", "api"));
    recordRun(cfg, "acme/api", {
      ok: true,
      at: "2026-08-19T00:00:00Z",
      value: { found: 1, parked: 1 },
    });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items).toContainEqual({
      kind: "assess-history",
      path: historyFilePath(cfg, "acme/api"),
    });
  });
});

describe("planUnwatch — residue mode (nwo not in watchlist)", () => {
  it("sweeps nwo-keyed traces and a leftover managed clone + its worktrees", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    mkdirSync(clone, { recursive: true });
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("residue");
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
    const kinds = out.plan.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["clone", "worktrees", "outbox-op"]));
  });

  it("no clone, no traces → empty plan (nothing to clean)", () => {
    const { cfg } = makeTree();
    const out = planUnwatch(cfg, "ghost/repo");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("residue");
    expect(out.plan.items).toEqual([]);
    expect(out.plan.clone).toBeNull();
  });

  it("a processing ticket targeting the residue clone blocks", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    mkdirSync(clone, { recursive: true });
    writeTicket(dataTreePaths(cfg).queue.processing, "live-9", clone);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.blocked).toEqual({ ticketId: "live-9" });
  });

  it("finds an orphaned worktree namespace when the managed clone is already gone", async () => {
    // Reachable via a prior partial run: worktrees deletion failed (advisory
    // lock held) while the clone — later in runUnwatch's deletion order — was
    // removed. repoDiscriminator hashes the clone PATH STRING (worktree.ts:80-84),
    // never checking existence, so the namespace is still derivable from the
    // candidate clone path even though nothing is on disk at that path any more.
    const { cfg } = makeTree();
    const clonePath = join(dataTreePaths(cfg).clonesWatched, "acme", "api"); // never created
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clonePath));
    mkdirSync(ns, { recursive: true });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("residue");
    expect(out.plan.clone).toBeNull();
    expect(out.plan.items).toContainEqual({ kind: "worktrees", path: ns });

    const res = await runUnwatch(cfg, "acme/api");
    expect(res.ok).toBe(true);
    expect(existsSync(ns)).toBe(false);
  });

  it("probes clonesExternal when clonesWatched has nothing; finds the clone and its namespace", () => {
    const { cfg } = makeTree();
    const clone = join(cfg.github.externalReposRoot, "acme", "api");
    mkdirSync(clone, { recursive: true });
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("residue");
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
    expect(out.plan.items).toContainEqual({ kind: "clone", path: clone });
    expect(out.plan.items).toContainEqual({ kind: "worktrees", path: ns });
  });
});

describe("runUnwatch", () => {
  it("refuses blocked without deleting anything", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    writeTicket(dataTreePaths(cfg).queue.processing, "live-1", clone);
    const res = await runUnwatch(cfg, "acme/api");
    expect(res).toMatchObject({
      ok: false,
      refused: "blocked",
      blockedTicketId: "live-1",
      watchlistRemoved: false,
    });
    expect(readWatchlist(dataTreePaths(cfg).watchlistFile).entries).toHaveLength(1);
    expect(existsSync(clone)).toBe(true);
  });

  it("deletes watchlist entry first, clone last; user clone kept + git worktree prune", async () => {
    const { root, cfg } = makeTree();
    const mine = join(root, "my-checkout");
    watch(cfg, "acme/api", mine);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(mine));
    mkdirSync(ns, { recursive: true });
    const gitCalls: [string[], string][] = [];
    const res = await runUnwatch(cfg, "acme/api", {
      gitFn: async (args, cwd) => (gitCalls.push([args, cwd]), { code: 0, stdout: "" }),
    });
    expect(res.ok).toBe(true);
    expect(res.watchlistRemoved).toBe(true);
    expect(readWatchlist(dataTreePaths(cfg).watchlistFile).entries).toEqual([]);
    expect(existsSync(ns)).toBe(false);
    expect(existsSync(mine)).toBe(true); // user clone survives
    expect(gitCalls).toEqual([[["worktree", "prune"], mine]]);
    expect(res.summary.find((s) => s.kind === "clone")?.outcome).toBe("kept");
  });

  it("interleaved deletion order: watchlist rewritten before the first deletion; worktrees before clone; clone last", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    writeTicket(dataTreePaths(cfg).queue.inbox, "fix-1", clone);
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" });
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });

    const calls: string[] = [];
    let watchlistEmptyBeforeFirstDelete: boolean | null = null;
    const noteFirstCall = (): void => {
      if (watchlistEmptyBeforeFirstDelete === null) {
        watchlistEmptyBeforeFirstDelete =
          readWatchlist(dataTreePaths(cfg).watchlistFile).entries.length === 0;
      }
    };

    const res = await runUnwatch(cfg, "acme/api", {
      unlinkFn: (p) => {
        noteFirstCall();
        calls.push(p);
        unlinkSync(p);
      },
      rmFn: (p) => {
        noteFirstCall();
        calls.push(p);
        rmSync(p, { recursive: true, force: true });
      },
    });

    expect(res.ok).toBe(true);
    // The watchlist entry is rewritten (step 1) before ANY unlinkFn/rmFn call fires.
    expect(watchlistEmptyBeforeFirstDelete).toBe(true);
    const wtIdx = calls.indexOf(ns);
    const cloneIdx = calls.indexOf(clone);
    expect(wtIdx).toBeGreaterThanOrEqual(0);
    expect(cloneIdx).toBe(calls.length - 1); // the managed clone is the LAST recorded call
    expect(wtIdx).toBeLessThan(cloneIdx); // worktrees removed before the clone
  });

  it("one failing deletion doesn't strand the rest; ok:false with the failure row", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const t = writeTicket(dataTreePaths(cfg).queue.inbox, "fix-1", clone);
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" });
    const res = await runUnwatch(cfg, "acme/api", {
      unlinkFn: (p) => {
        if (p === t) throw new Error("EACCES boom");
        unlinkSync(p);
      },
    });
    expect(res.ok).toBe(false);
    expect(res.summary.find((s) => s.kind === "inbox-ticket")).toMatchObject({ outcome: "failed" });
    expect(res.summary.filter((s) => s.outcome === "deleted").map((s) => s.kind)).toEqual(
      expect.arrayContaining(["watchlist-entry", "outbox-op", "clone"]),
    );
    expect(existsSync(clone)).toBe(false);
  });

  it("worktree namespace removal happens under the advisory lock; a held lock fails only that row", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    const res = await runUnwatch(cfg, "acme/api", { acquireLockFn: () => null });
    expect(res.ok).toBe(false);
    expect(res.summary.find((s) => s.kind === "worktrees")).toMatchObject({ outcome: "failed" });
    expect(existsSync(ns)).toBe(true);
    expect(existsSync(clone)).toBe(false); // the rest still ran
  });

  it("residue run with nothing to clean succeeds with an empty summary", async () => {
    const { cfg } = makeTree();
    const res = await runUnwatch(cfg, "ghost/repo");
    expect(res).toMatchObject({ ok: true, refused: null, watchlistRemoved: false, summary: [] });
  });

  it("deletes the chat session dir and the draft's JSON + files dir", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const chatDir = join(dataTreePaths(cfg).chats, chatSlug("acme/api"));
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, "transcript.jsonl"), "", "utf8");
    writeChatDraft(cfg, chatDraft("acme__api-1", "acme/api"));
    const res = await runUnwatch(cfg, "acme/api");
    expect(res.ok).toBe(true);
    expect(existsSync(chatDir)).toBe(false);
    expect(existsSync(draftJsonPath(cfg, "acme__api-1"))).toBe(false);
    expect(existsSync(draftFilesDir(cfg, "acme__api-1"))).toBe(false);
    expect(res.summary.map((s) => s.kind)).toEqual(
      expect.arrayContaining(["chat-session", "chat-draft"]),
    );
  });
});

describe("runUnwatchCommand", () => {
  const capture = () => {
    const out: string[] = [];
    return { out, printFn: (s: string) => out.push(s) };
  };

  it("--plan prints the PlanOutcome as one JSON line, exit 0", async () => {
    const { cfg } = makeTree();
    watch(cfg, "acme/api", join(dataTreePaths(cfg).clonesWatched, "acme", "api"));
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["acme/api"], { plan: true }, { printFn })).toBe(0);
    const parsed = JSON.parse(out.join("").trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.plan.nwo).toBe("acme/api");
  });

  it("--plan on a refusal prints the refusal JSON, exit 1", async () => {
    const { cfg } = makeTree({ configRepos: [{ nwo: "acme/api", path: "/config/api" }] });
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["acme/api"], { plan: true }, { printFn })).toBe(1);
    expect(JSON.parse(out.join("").trim())).toEqual({ ok: false, reason: "config-defined" });
  });

  it("--plan on a blocked plan still exits 0 (planning isn't a failure)", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    writeTicket(dataTreePaths(cfg).queue.processing, "live-1", clone);
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["acme/api"], { plan: true }, { printFn })).toBe(0);
    const parsed = JSON.parse(out.join("").trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.plan.blocked).toEqual({ ticketId: "live-1" });
  });

  it("bad args → usage, exit 2", async () => {
    const { cfg } = makeTree();
    const { printFn } = capture();
    expect(await runUnwatchCommand(cfg, [], { plan: false }, { printFn })).toBe(2);
    expect(await runUnwatchCommand(cfg, ["not-an-nwo"], { plan: false }, { printFn })).toBe(2);
  });

  it("execute success headline + rows, exit 0; blocked exits 1", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["acme/api"], { plan: false }, { printFn })).toBe(0);
    expect(out[0]).toMatch(/^unwatched acme\/api: deleted \d+ item\(s\)\n$/);
    expect(out.slice(1).every((l) => /^  (deleted|kept|failed): \S/.test(l))).toBe(true);
  });

  it("refuses config-defined with the exact headline, exit 1", async () => {
    const { cfg } = makeTree({ configRepos: [{ nwo: "acme/api", path: "/config/api" }] });
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["acme/api"], { plan: false }, { printFn })).toBe(1);
    expect(out).toEqual(["junco unwatch: acme/api is defined in config.json — remove it there\n"]);
  });

  it("refuses an unreadable watchlist with the exact headline, exit 1", async () => {
    const { cfg } = makeTree();
    const file = dataTreePaths(cfg).watchlistFile;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["acme/api"], { plan: false }, { printFn })).toBe(1);
    expect(out).toEqual(["junco unwatch: watchlist unreadable — fix it before writing\n"]);
  });

  it("blocked prints the exact headline with the ticket id, exit 1", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    writeTicket(dataTreePaths(cfg).queue.processing, "live-1", clone);
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["acme/api"], { plan: false }, { printFn })).toBe(1);
    expect(out).toEqual([
      "junco unwatch: acme/api has a ticket in flight (live-1) — wait for it to finish\n",
    ]);
  });

  it("empty summary prints 'nothing to clean', exit 0", async () => {
    const { cfg } = makeTree();
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["ghost/repo"], { plan: false }, { printFn })).toBe(0);
    expect(out).toEqual(["junco unwatch: nothing to clean for ghost/repo\n"]);
  });

  it("any failed deletion headlines the failure count, exit 1", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const t = writeTicket(dataTreePaths(cfg).queue.inbox, "fix-1", clone);
    const { out, printFn } = capture();
    expect(
      await runUnwatchCommand(
        cfg,
        ["acme/api"],
        { plan: false },
        {
          printFn,
          unlinkFn: (p) => {
            if (p === t) throw new Error("EACCES boom");
            unlinkSync(p);
          },
        },
      ),
    ).toBe(1);
    expect(out[0]).toBe("junco unwatch: 1 deletion(s) failed for acme/api\n");
    expect(out).toContainEqual("  failed: inbox-ticket fix-1\n");
  });
});
