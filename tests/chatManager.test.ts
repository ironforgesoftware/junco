import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatManager, type ChatManagerDeps } from "../src/chat/chatManager.js";
import type { ChatCwdError } from "../src/chat/chatCwd.js";
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

/** Admission AND the detached turn — what `await m.prompt(...)` meant before
 * Ruling R33 made the route answer on admission. */
async function runTurn(
  m: ChatManager,
  key: string,
  text: string,
): Promise<{ ok: boolean; mode?: string; error?: string }> {
  const r = await m.prompt(key, text);
  if (!r.ok) return { ok: false, error: r.error };
  await r.value.done;
  return { ok: true, mode: r.value.mode };
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
    const r = await runTurn(m, "acme/api", "hello");
    expect(r).toEqual({ ok: true, mode: "prompt" });
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
    const r = await runTurn(m, "acme/api", "hello");
    expect(r).toEqual({ ok: true, mode: "prompt" });
    expect(spend.calls).toEqual([0.3]);
    expect(m.health().turns).toBe(1);
  });

  it("prompt answers on ADMISSION; the turn, its spend and its hook run inside `done` (R33)", async () => {
    const hook: string[] = [];
    const { m, spend } = setup({ onTurnComplete: async () => void hook.push("ran") }, [
      { ...chatScriptText("hi", 0.3), delayMs: 40 },
    ]);
    const r = await m.prompt("acme/api", "hello");
    expect(r.ok && r.value.mode).toBe("prompt");
    // The route has its answer while the model is still streaming.
    expect(m.status("acme/api")?.streaming).toBe(true);
    expect(m.health().turns).toBe(0);
    expect(spend.calls).toEqual([]);
    expect(hook).toEqual([]);
    if (!r.ok) return;
    await r.value.done;
    expect(m.health().turns).toBe(1);
    expect(spend.calls).toEqual([0.3]);
    expect(hook).toEqual(["ran"]);
  });

  it("gate-blocked: no model call, a junco_chat_turn_rejected record with until, mode rejected", async () => {
    const { m } = setup({ gate: fakeGate("rate limited: 429") });
    const s = await m.get("acme/api");
    expect(s.ok).toBe(true);
    const r = await runTurn(m, "acme/api", "hello");
    expect(r).toEqual({ ok: true, mode: "rejected" });
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
    const r = await runTurn(m, "acme/api", "hello");
    expect(gate.budget).toHaveLength(1);
    expect(gate.budget[0]![1]).toBe("daily budget $5.00 reached ($10.00 spent)");
    expect(r).toEqual({ ok: true, mode: "rejected" });
  });

  it("a gate-class provider failure during a turn reports into the gate (symmetric with tickets)", async () => {
    const { m, gate } = setup({}, [{ events: [], throws: "fetch failed: 429 too many requests" }]);
    const r = await runTurn(m, "acme/api", "hello");
    expect(r).toEqual({ ok: true, mode: "prompt" });
    expect(gate.failures).toEqual([["rate_limit", "fetch failed: 429 too many requests"]]);
  });

  it("an unknown-class failure does not touch the gate", async () => {
    const { m, gate } = setup({}, [{ events: [], throws: "something odd" }]);
    await runTurn(m, "acme/api", "hello");
    expect(gate.failures).toEqual([]);
  });

  it("concurrent get() for an unseen key resolves the cwd once and shares one session", async () => {
    const { cfg, root } = setup();
    let calls = 0;
    const m = new ChatManager({
      cfg: () => cfg,
      gate: fakeGate(),
      spend: fakeSpend(),
      resolveCwd: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, cwd: root, kind: "watched", nwo: "acme/api" };
      },
      session: { makeSessionManager: fakeSm, sessionFactoryFor: () => fakeChatSession([]) },
    });
    const [a, b] = await Promise.all([m.get("acme/api"), m.get("acme/api")]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).toBe(b.value);
    expect(calls).toBe(1);
    expect(m.health().sessions).toHaveLength(1);
  });

  it("a failed concurrent get() is not cached: both callers see it and the next get retries", async () => {
    const { cfg } = setup();
    let calls = 0;
    const m = new ChatManager({
      cfg: () => cfg,
      gate: fakeGate(),
      spend: fakeSpend(),
      resolveCwd: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { ok: false, error: "unknown_key" };
      },
    });
    const [a, b] = await Promise.all([m.get("acme/api"), m.get("acme/api")]);
    expect(a).toEqual({ ok: false, error: "unknown_key" });
    expect(b).toEqual({ ok: false, error: "unknown_key" });
    expect(calls).toBe(1);
    expect(m.health().sessions).toHaveLength(0);
    // pending was cleared, so a later call resolves again rather than
    // replaying a stale rejection forever.
    expect(await m.get("acme/api")).toEqual({ ok: false, error: "unknown_key" });
    expect(calls).toBe(2);
  });

  it("chat.enabled=false → chat_disabled; unknown key → unknown_key", async () => {
    const { cfg } = setup();
    const off = new ChatManager({
      cfg: () => ({ ...cfg, chat: { ...cfg.chat, enabled: false } }),
      gate: fakeGate(),
      spend: fakeSpend(),
    });
    expect(await runTurn(off, "acme/api", "x")).toEqual({ ok: false, error: "chat_disabled" });
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
    await runTurn(m, "acme/api", "one");
    const live: string[] = [];
    const sub = await m.subscribe("acme/api", 0, {
      onLine: (l) => live.push(JSON.parse(l).type),
      onEnd: () => {},
    });
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;
    expect(sub.value.replay.map((r) => JSON.parse(r.line).type)).toContain("junco_chat_turn_end");
    const p = await m.prompt("acme/api", "two");
    await vi.waitFor(() => expect(m.status("acme/api")?.streaming).toBe(true));
    expect(await m.abort("acme/api")).toEqual({ ok: true, value: { aborted: true } });
    if (p.ok) await p.value.done;
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

  it("sends the hook's followUp once, as source auto_lint, and never chains a second one", async () => {
    const seen: string[] = [];
    const { m } = setup(
      {
        onTurnComplete: async (_s, _r, src) => {
          seen.push(src);
          return src === "operator" ? { followUp: "fix the lint" } : undefined;
        },
      },
      [chatScriptText("first"), chatScriptText("second")],
    );
    await runTurn(m, "acme/api", "hello");
    expect(seen).toEqual(["operator", "auto_lint"]);
    expect(m.health().turns).toBe(2);
  });

  it("drain aborts every streaming session, awaits its detached turn, and ends every subscriber", async () => {
    const hook: string[] = [];
    const { m } = setup({ onTurnComplete: async () => void hook.push("ran") }, [
      { events: [], delayMs: 10_000 },
    ]);
    const ends: string[] = [];
    await m.subscribe("acme/api", 0, { onLine: () => {}, onEnd: (r) => ends.push(r) });
    const p = await m.prompt("acme/api", "slow");
    await vi.waitFor(() => expect(m.status("acme/api")?.streaming).toBe(true));
    await m.drain();
    // R33: the tail outlives the response, so shutdown is what waits for it.
    expect(hook).toEqual(["ran"]);
    expect(ends).toEqual(["daemon_stopped"]);
    expect(m.health().sessions[0]?.streaming).toBe(false);
    if (p.ok) await p.value.done;
  });

  it("a prompt that lands once drain() has started is refused, and rebuilds nothing (#446)", async () => {
    let built = 0;
    const factory = fakeChatSession([chatScriptText("hi", 0.1), chatScriptText("again", 0.1)]);
    const { m } = setup({
      session: {
        makeSessionManager: fakeSm,
        sessionFactoryFor: () => async () => {
          built++;
          return factory();
        },
      },
    });
    expect(await runTurn(m, "acme/api", "one")).toEqual({ ok: true, mode: "prompt" });
    expect(built).toBe(1);
    // Mid-drain: `drain()` has bumped the generation and disposed the SDK
    // session, so admitting this would rebuild one that nothing disposes.
    const draining = m.drain();
    expect(await m.prompt("acme/api", "two")).toEqual({ ok: false, error: "draining" });
    await draining;
    expect(await m.prompt("acme/api", "three")).toEqual({ ok: false, error: "draining" });
    expect(built).toBe(1);
  });

  it("drain() is bounded by a grace, not by the turn timeout (#446)", async () => {
    let entered = false;
    let release!: () => void;
    const stuck = new Promise<void>((r) => (release = r));
    const { m } = setup({
      drainGraceMs: 30,
      onTurnComplete: async () => {
        entered = true;
        await stuck;
      },
    });
    const p = await m.prompt("acme/api", "hello");
    expect(p.ok).toBe(true);
    // The tail is wedged in the draft hook — a turn tail that never settles.
    await vi.waitFor(() => expect(entered).toBe(true));
    const started = Date.now();
    await m.drain();
    expect(Date.now() - started).toBeLessThan(2_000);
    release();
    if (p.ok) await p.value.done;
  });
});

describe("ChatManager watchlist reconciliation (#452, #453)", () => {
  /** A movable/removable watchlist entry behind the `resolveCwd` seam. */
  function movable(initial: string) {
    const state: { cwd: string; error: ChatCwdError | null } = { cwd: initial, error: null };
    const resolveCwd: ChatManagerDeps["resolveCwd"] = async () =>
      state.error === null
        ? { ok: true, cwd: state.cwd, kind: "watched", nwo: "acme/api" }
        : { ok: false, error: state.error };
    return { state, resolveCwd };
  }
  const tmp = (): string => mkdtempSync(join(tmpdir(), "junco-cm-cwd-"));

  it("reconcile drains and drops a session whose repo has left the watchlist (#452)", async () => {
    const { state, resolveCwd } = movable(tmp());
    const { m } = setup({ resolveCwd });
    const ends: string[] = [];
    await m.subscribe("acme/api", 0, { onLine: () => {}, onEnd: (r) => ends.push(r) });
    await runTurn(m, "acme/api", "hello");
    expect(m.health().sessions).toHaveLength(1);

    state.error = "unknown_key"; // `junco unwatch acme/api`, or a config reload
    await m.reconcile();
    expect(m.health().sessions).toEqual([]);
    expect(ends).toEqual(["daemon_stopped"]);
    // ...and the next verb 404s instead of resurrecting it on the removed dir.
    expect(await m.prompt("acme/api", "again")).toEqual({ ok: false, error: "unknown_key" });
  });

  it("reconcile keeps a session whose checkout is merely absent right now", async () => {
    const { state, resolveCwd } = movable(tmp());
    const { m } = setup({ resolveCwd });
    await runTurn(m, "acme/api", "hello");
    // Still watched — the clone is just being re-created. Not an eviction.
    state.error = "no_checkout";
    await m.reconcile();
    expect(m.health().sessions).toHaveLength(1);
  });
});

describe("ChatManager.decide (spec 2026-09-03 §3.3)", () => {
  it("settles a pending confirmation and reports false for an unknown id", async () => {
    const { m } = setup();
    const got = await m.get("acme/api");
    if (!got.ok) throw new Error(got.error);
    await got.value.ensureMeta();
    const p = got.value.confirmSubmit({ commandId: "c1", draftId: "d", ids: [], route: "inbox" });
    expect(await m.decide("acme/api", "zzz", "run")).toEqual({
      ok: true,
      value: { settled: false },
    });
    expect(await m.decide("acme/api", "c1", "run")).toEqual({ ok: true, value: { settled: true } });
    expect(await p).toBe("run");
  });

  it("answers a disabled chat the way every other verb does", async () => {
    const { cfg } = setup();
    const off = new ChatManager({
      cfg: () => ({ ...cfg, chat: { ...cfg.chat, enabled: false } }),
      gate: fakeGate(),
      spend: fakeSpend(),
    });
    expect(await off.decide("acme/api", "c1", "run")).toEqual({
      ok: false,
      error: "chat_disabled",
    });
  });
});
