import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFollowUp, makeTurnHook, parkDrafts } from "../src/chat/chatDrafts.js";
import { extractDrafts } from "../src/chat/fenceExtract.js";
import { draftFilePath, listChatDrafts } from "../src/chat/draftStore.js";
import { ChatSession } from "../src/chat/chatSession.js";
import type { SessionManagerMode } from "../src/agent/session.js";
import { makeConfig } from "./helpers/config.js";
import { fakeChatSession } from "./helpers/fakeSession.js";

function cfgAt(root: string) {
  return makeConfig({
    dataDir: root,
    queueRoot: join(root, "queue"),
    worktreeRoot: join(root, "wt"),
    tools: ["read"],
    criticEnabled: false,
    planLintEnabled: true,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: true,
  });
}
const sess = { slug: "acme__api", key: "acme/api", cwd: "/repo", nwo: "acme/api" };
const ctx = { repo: "/repo", nwo: "acme/api", planSetsEnabled: true };
const CLEAN_BODY = readFileSync(
  new URL("./fixtures/clean-ticket-body.md", import.meta.url),
  "utf8",
);
const routeInbox = async () => ({
  destination: "inbox" as const,
  reasons: ["github disabled"],
  watchedNwo: null,
  carriedTimeout: null,
  discarded: [],
});

describe("parkDrafts (spec 2026-09-01 §6.2)", () => {
  // The REAL decideRoute, not a fake: makeConfig ships github.enabled false,
  // which is decideRoute's own deterministic short-circuit (no git, no fs), so
  // this case pins that the frontmatter junco parks — `repo:` the checkout
  // PATH (R17), never the nwo — is frontmatter the real router accepts and
  // carries. The parked bytes are what `junco submit` would later read.
  it("lints and routes each file with the real decideRoute, writes the draft, marks lintFailed on an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    expect(cfg.github.enabled).toBe(false);
    const clean = extractDrafts(
      "````junco-ticket\n---\nid: ok\n---\n" + CLEAN_BODY + "\n````",
      ctx,
    );
    const [d] = await parkDrafts(cfg, sess, clean, {});
    expect(d!.lintFailed).toBe(false);
    expect(d!.files[0]!.route).toMatchObject({
      destination: "inbox",
      reasons: ["github.enabled is off"],
      watchedNwo: null,
    });
    // repo: is the session cwd, and it is a key the issue route CARRIES —
    // decideRoute never lists it among the keys it would discard.
    expect(d!.files[0]!.route!.discarded).not.toContain("repo");
    expect(d!.files[0]!.content).toContain("repo: /repo");
    expect(d!.files[0]!.content).not.toContain("repo: acme/api");
    expect(readFileSync(draftFilePath(cfg, d!.id, d!.files[0]!.name), "utf8")).toBe(
      d!.files[0]!.content,
    );
    expect(d!.id.startsWith("acme__api-")).toBe(true);
    expect(listChatDrafts(cfg).map((x) => x.id)).toEqual([d!.id]);
    const dirty = extractDrafts(
      "````junco-ticket\n---\nid: bad\n---\n# Bad\n\n## Steps\n\n### Step 1 — run the tests\n\n1. cd src && npm test\n````",
      ctx,
    );
    const [b] = await parkDrafts(cfg, sess, dirty, { routeFn: routeInbox });
    expect(b!.lintFailed).toBe(true);
    expect(b!.files[0]!.lint.some((v) => v.severity === "error")).toBe(true);
  });
  it("a set's unknown depends_on is a WARNING, never a block; extraction problems are errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    const set = extractDrafts(
      [
        "````junco-ticket\n---\nid: a\n---\n" + CLEAN_BODY + "\n````",
        "````junco-ticket\n---\nid: b\ndepends_on: [ghost]\n---\n" + CLEAN_BODY + "\n````",
      ].join("\n"),
      ctx,
    );
    const [d] = await parkDrafts(cfg, sess, set, { routeFn: routeInbox });
    expect(d!.kind).toBe("ticketSet");
    expect(d!.lintFailed).toBe(false);
    expect(d!.files[1]!.lint.find((v) => v.rule === "depends_on_sibling")?.severity).toBe(
      "warning",
    );
    const bad = extractDrafts("````junco-ticket\n---\nid: z\ninvestigate: {}\n---\n# Z\n````", ctx);
    const [z] = await parkDrafts(cfg, sess, bad, { routeFn: routeInbox });
    expect(z!.lintFailed).toBe(true);
    expect(z!.files[0]!.lint[0]).toMatchObject({
      rule: "chat_extract",
      severity: "error",
      message: "investigate.issue is required",
    });
  });
  it("audit/investigate skip plan lint and carry commandArgs; planSet lints through the compiler", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    const [a] = await parkDrafts(
      cfg,
      sess,
      extractDrafts(
        "````junco-ticket\n---\nid: a\naudit:\n  auto_plan: true\n---\n# Audit\n````",
        ctx,
      ),
    );
    expect(a!.kind).toBe("audit");
    expect(a!.commandArgs).toEqual(["audit", "acme/api", "--auto-plan"]);
    expect(a!.lintFailed).toBe(false);
    const [p] = await parkDrafts(
      cfg,
      sess,
      extractDrafts("```junco-plan\nversion: 1\ntasks: []\n```", ctx),
    );
    expect(p!.kind).toBe("planSet");
    expect(p!.lintFailed).toBe(true); // an empty task list is a compiler error
  });
});

describe("lintFollowUp + makeTurnHook (spec 2026-09-01 §6.3)", () => {
  it("lintFollowUp is null when clean and names every violation otherwise", () => {
    expect(lintFollowUp([])).toBeNull();
    const text = lintFollowUp([
      {
        id: "d",
        key: "k",
        slug: "s",
        kind: "ticket",
        cwd: "/r",
        nwo: null,
        createdAt: "t",
        lintFailed: true,
        blocked: null,
        routeOverride: "auto",
        commandArgs: null,
        files: [
          {
            name: "x.md",
            content: "",
            route: null,
            droppedKeys: [],
            lint: [{ rule: "no_cd_in_verification", severity: "error", message: "cd in step 1" }],
          },
        ],
      },
    ]);
    expect(text).toContain("[error] no_cd_in_verification: cd in step 1");
    expect(text).toMatch(/re-emit/i);
  });

  it("the hook parks, records junco_chat_draft, returns a followUp once, and on the retry replaces the failed draft", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    const fakeSm = async (mode: SessionManagerMode) =>
      "create" in mode
        ? { manager: {}, file: join(mode.create.dir, "sdk") }
        : { manager: {}, file: mode.open.file };
    const session = new ChatSession(
      {
        cfg,
        key: "acme/api",
        kind: "watched",
        cwd: "/repo",
        nwo: "acme/api",
        dir: join(root, "data", "chats", "acme__api"),
      },
      { makeSessionManager: fakeSm, sessionFactoryFor: () => fakeChatSession([]) },
    );
    await session.ensureMeta();
    const hook = makeTurnHook(() => cfg, { routeFn: routeInbox });
    const bad =
      "````junco-ticket\n---\nid: bad\n---\n# Bad\n\n## Steps\n\n### Step 1 — run the tests\n\n1. cd src && npm test\n````";
    const r1 = await hook(
      session,
      {
        mode: "prompt",
        status: "ok",
        abortReason: null,
        errorMessage: null,
        usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
        durationMs: 1,
        finalText: bad,
        allText: bad,
      },
      "operator",
    );
    expect(r1 && "followUp" in r1 && typeof r1.followUp).toBe("string");
    const first = listChatDrafts(cfg);
    expect(first).toHaveLength(1);
    expect(first[0]!.lintFailed).toBe(true);
    const good = "````junco-ticket\n---\nid: good\n---\n" + CLEAN_BODY + "\n````";
    const r2 = await hook(
      session,
      {
        mode: "prompt",
        status: "ok",
        abortReason: null,
        errorMessage: null,
        usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
        durationMs: 1,
        finalText: good,
        allText: good,
      },
      "auto_lint",
    );
    expect(r2 === undefined || !("followUp" in r2) || r2.followUp === undefined).toBe(true);
    const after = listChatDrafts(cfg);
    expect(after).toHaveLength(1);
    expect(after[0]!.lintFailed).toBe(false);
    expect(after[0]!.id).not.toBe(first[0]!.id);
    const recs = readFileSync(session.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; status: string })
      .filter((x) => x.type === "junco_chat_draft");
    expect(recs.map((x) => x.status)).toEqual(["lint_failed", "parked"]);
  });

  it("a still-failing retry parks lintFailed and returns no further followUp", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-park-"));
    const cfg = cfgAt(root);
    const fakeSm = async (mode: SessionManagerMode) =>
      "create" in mode
        ? { manager: {}, file: join(mode.create.dir, "sdk") }
        : { manager: {}, file: mode.open.file };
    const session = new ChatSession(
      {
        cfg,
        key: "acme/api",
        kind: "watched",
        cwd: "/repo",
        nwo: "acme/api",
        dir: join(root, "data", "chats", "acme__api"),
      },
      { makeSessionManager: fakeSm, sessionFactoryFor: () => fakeChatSession([]) },
    );
    await session.ensureMeta();
    const hook = makeTurnHook(() => cfg, { routeFn: routeInbox });
    const bad =
      "````junco-ticket\n---\nid: bad\n---\n# Bad\n\n## Steps\n\n### Step 1 — run the tests\n\n1. cd src && npm test\n````";
    const zero = { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 };
    await hook(
      session,
      {
        mode: "prompt",
        status: "ok",
        abortReason: null,
        errorMessage: null,
        usage: zero,
        durationMs: 1,
        finalText: bad,
        allText: bad,
      },
      "operator",
    );
    const r2 = await hook(
      session,
      {
        mode: "prompt",
        status: "ok",
        abortReason: null,
        errorMessage: null,
        usage: zero,
        durationMs: 1,
        finalText: bad,
        allText: bad,
      },
      "auto_lint",
    );
    expect(r2 === undefined || !("followUp" in r2) || r2.followUp === undefined).toBe(true);
    expect(listChatDrafts(cfg)).toHaveLength(1);
    expect(listChatDrafts(cfg)[0]!.lintFailed).toBe(true);
  });
});
