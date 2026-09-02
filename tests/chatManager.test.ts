import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatManager, type ChatManagerDeps } from "../src/chat/chatManager.js";
import { makeConfig } from "./helpers/config.js";
import { fakeChatSession, chatScriptText } from "./helpers/fakeSession.js";
import type { SessionManagerMode } from "../src/agent/session.js";
import type { GateStatus } from "../src/providerGate.js";
import type { ProviderFailureClass } from "../src/providerFailure.js";

function fakeGate(block: string | null = null) {
  const failures: Array<[ProviderFailureClass, string]> = [];
  const budget: Array<[number, string]> = [];
  return {
    failures,
    budget,
    claimBlockReason: () => block,
    status: (): GateStatus => ({
      state: block ? "rate_limited" : "ok",
      reason: block,
      since: null,
      until: block ? "2026-09-01T18:00:00.000Z" : null,
    }),
    reportFailure: (cls: ProviderFailureClass, reason: string) => failures.push([cls, reason]),
    reportBudgetExhausted: (untilMs: number, reason: string) => budget.push([untilMs, reason]),
  };
}
function fakeSpend(today = 0) {
  const calls: number[] = [];
  return {
    calls,
    recordUsd: (u: number) => calls.push(u),
    todayUsd: () => today,
    nextMidnightMs: () => 1_900_000_000_000,
  };
}
const fakeSm = async (mode: SessionManagerMode) => {
  if ("create" in mode) {
    const file = join(mode.create.dir, "sdk.jsonl");
    writeFileSync(file, "");
    return { manager: {}, file };
  }
  return { manager: {}, file: mode.open.file };
};

function setup(over: Partial<ChatManagerDeps> = {}, scripts = [chatScriptText("hi", 0.3)]) {
  const root = mkdtempSync(join(tmpdir(), "junco-cm-"));
  const cfg = makeConfig({
    dataDir: root,
    queueRoot: join(root, "queue"),
    worktreeRoot: join(root, "wt"),
    tools: ["read", "grep", "bash"],
    criticEnabled: false,
    planLintEnabled: false,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: true,
  });
  const gate = fakeGate();
  const spend = fakeSpend();
  const factory = fakeChatSession(scripts);
  const m = new ChatManager({
    cfg: () => cfg,
    gate,
    spend,
    resolveCwd: async () => ({ ok: true, cwd: root, kind: "watched", nwo: "acme/api" }),
    session: { makeSessionManager: fakeSm, sessionFactoryFor: () => factory },
    abortGraceMs: 20,
    ...over,
  });
  return { m, cfg, gate, spend, root };
}

const lines = (p: string) =>
  readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("ChatManager (spec 2026-09-01 §2.4, §4)", () => {
  it("prompt runs a turn, records spend once, counts, and fires onTurnComplete", async () => {
    const done: string[] = [];
    const { m, spend } = setup({
      onTurnComplete: async (_s, r, src) => void done.push(`${src}:${r.status}`),
    });
    const r = await m.prompt("acme/api", "hello");
    expect(r).toEqual({ ok: true, value: { mode: "prompt" } });
    expect(spend.calls).toEqual([0.3]);
    expect(done).toEqual(["operator:ok"]);
    const h = m.health();
    expect(h.turns).toBe(1);
    expect(h.costUsd).toBeCloseTo(0.3);
    expect(h.sessions[0]).toMatchObject({
      key: "acme/api",
      slug: "acme__api",
      streaming: false,
      turns: 1,
    });
  });

  it("a throwing onTurnComplete never fails the prompt (the hook is best-effort)", async () => {
    const { m, spend } = setup({
      onTurnComplete: () => Promise.reject(new Error("draft parking exploded")),
    });
    const r = await m.prompt("acme/api", "hello");
    expect(r).toEqual({ ok: true, value: { mode: "prompt" } });
    expect(spend.calls).toEqual([0.3]);
    expect(m.health().turns).toBe(1);
  });

  it("gate-blocked: no model call, a junco_chat_turn_rejected record with until, mode rejected", async () => {
    const { m } = setup({ gate: fakeGate("rate limited: 429") });
    const s = await m.get("acme/api");
    expect(s.ok).toBe(true);
    const r = await m.prompt("acme/api", "hello");
    expect(r).toEqual({ ok: true, value: { mode: "rejected" } });
    const recs = lines((s as { value: { transcriptPath: string } }).value.transcriptPath);
    const rej = recs.find((x) => x.type === "junco_chat_turn_rejected");
    expect(rej).toMatchObject({ reason: "rate limited: 429", until: "2026-09-01T18:00:00.000Z" });
    expect(recs.some((x) => x.type === "junco_chat_turn_start")).toBe(false);
  });

  it("budget exhausted: reports into the gate first (live dailyBudgetUsd), then rejects", async () => {
    const { cfg, root } = setup();
    const gate = fakeGate();
    // The real gate latches budget_exhausted on reportBudgetExhausted; mimic that.
    const latching = {
      ...gate,
      claimBlockReason: () => (gate.budget.length > 0 ? gate.budget[0]![1] : null),
    };
    const m = new ChatManager({
      cfg: () => ({ ...cfg, dailyBudgetUsd: 5 }),
      gate: latching,
      spend: fakeSpend(10),
      resolveCwd: async () => ({ ok: true, cwd: root, kind: "watched", nwo: "acme/api" }),
      session: { makeSessionManager: fakeSm, sessionFactoryFor: () => fakeChatSession([]) },
    });
    const r = await m.prompt("acme/api", "hello");
    expect(gate.budget).toHaveLength(1);
    expect(gate.budget[0]![1]).toBe("daily budget $5.00 reached ($10.00 spent)");
    expect(r).toEqual({ ok: true, value: { mode: "rejected" } });
  });

  it("a gate-class provider failure during a turn reports into the gate (symmetric with tickets)", async () => {
    const { m, gate } = setup({}, [{ events: [], throws: "fetch failed: 429 too many requests" }]);
    const r = await m.prompt("acme/api", "hello");
    expect(r).toEqual({ ok: true, value: { mode: "prompt" } });
    expect(gate.failures).toEqual([["rate_limit", "fetch failed: 429 too many requests"]]);
  });

  it("an unknown-class failure does not touch the gate", async () => {
    const { m, gate } = setup({}, [{ events: [], throws: "something odd" }]);
    await m.prompt("acme/api", "hello");
    expect(gate.failures).toEqual([]);
  });

  it("chat.enabled=false → chat_disabled; unknown key → unknown_key", async () => {
    const { cfg } = setup();
    const off = new ChatManager({
      cfg: () => ({ ...cfg, chat: { ...cfg.chat, enabled: false } }),
      gate: fakeGate(),
      spend: fakeSpend(),
    });
    expect(await off.prompt("acme/api", "x")).toEqual({ ok: false, error: "chat_disabled" });
    const unknown = new ChatManager({
      cfg: () => cfg,
      gate: fakeGate(),
      spend: fakeSpend(),
      resolveCwd: async () => ({ ok: false, error: "unknown_key" }),
    });
    expect(await unknown.get("nobody/nothing")).toEqual({ ok: false, error: "unknown_key" });
  });

  it("subscribe replays from `since` then goes live; abort aborts; fresh resets", async () => {
    const { m } = setup({}, [
      chatScriptText("a"),
      { events: [], delayMs: 10_000 },
      chatScriptText("c"),
    ]);
    await m.prompt("acme/api", "one");
    const live: string[] = [];
    const sub = await m.subscribe("acme/api", 0, {
      onLine: (l) => live.push(JSON.parse(l).type),
      onEnd: () => {},
    });
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;
    expect(sub.value.replay.map((r) => JSON.parse(r.line).type)).toContain("junco_chat_turn_end");
    const p = m.prompt("acme/api", "two");
    await vi.waitFor(() => expect(m.status("acme/api")?.streaming).toBe(true));
    expect(await m.abort("acme/api")).toEqual({ ok: true, value: { aborted: true } });
    await p;
    expect(live).toContain("junco_chat_turn_aborted");
    expect(await m.abort("acme/api")).toEqual({ ok: true, value: { aborted: false } });
    expect(await m.fresh("acme/api")).toEqual({ ok: true, value: null });
    expect(m.status("acme/api")?.turns).toBe(0);
  });

  it("note appends a junco_chat_draft record with a server ts", async () => {
    const { m } = setup();
    const s = await m.get("acme/api");
    if (!s.ok) throw new Error("no session");
    const r = await m.note("acme/api", {
      type: "junco_chat_draft",
      draftId: "d1",
      kind: "ticket",
      status: "submitted",
      ids: ["t1"],
      destination: "inbox",
    });
    expect(r).toEqual({ ok: true, value: null });
    const recs = lines(s.value.transcriptPath);
    const note = recs.find((x) => x.type === "junco_chat_draft");
    expect(note).toMatchObject({ draftId: "d1", status: "submitted", destination: "inbox" });
    expect(typeof note.ts).toBe("string");
  });

  it("drain aborts every streaming session and ends every subscriber", async () => {
    const { m } = setup({}, [{ events: [], delayMs: 10_000 }]);
    const ends: string[] = [];
    await m.subscribe("acme/api", 0, { onLine: () => {}, onEnd: (r) => ends.push(r) });
    const p = m.prompt("acme/api", "slow");
    await vi.waitFor(() => expect(m.status("acme/api")?.streaming).toBe(true));
    await m.drain();
    await p;
    expect(ends).toEqual(["daemon_stopped"]);
    expect(m.health().sessions[0]?.streaming).toBe(false);
  });
});
