import { describe, it, expect } from "vitest";
import { runChatTurn, TurnDeadline } from "../src/chat/chatTurn.js";
import { fakeChatSession, chatScriptText } from "./helpers/fakeSession.js";

describe("runChatTurn (spec 2026-09-01 §3)", () => {
  it("idle session: prompts, forwards every event to emit, sums usage, returns the text", async () => {
    const s = await fakeChatSession([chatScriptText("answer", 0.25)])();
    const seen: string[] = [];
    const r = await runChatTurn(s, {
      text: "q",
      timeoutMs: 5_000,
      emit: (e) => seen.push((e as { type: string }).type),
    });
    expect(r.mode).toBe("prompt");
    expect(r.status).toBe("ok");
    expect(r.finalText).toBe("answer");
    expect(r.usage.costUsd).toBe(0.25);
    expect(r.usage.input).toBe(1);
    expect(seen).toEqual([
      "message_start",
      "message_update",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
    expect(s.prompts).toEqual(["q"]);
    expect(s.disposed).toBe(false); // the session lives on
  });

  it("streaming session: steers instead of prompting and returns immediately", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 200 }])();
    const first = runChatTurn(s, { text: "one", timeoutMs: 5_000, emit: () => {} });
    expect(s.isStreaming).toBe(true);
    const r = await runChatTurn(s, { text: "two", timeoutMs: 5_000, emit: () => {} });
    expect(r.mode).toBe("steer");
    expect(s.steers).toEqual(["two"]);
    expect(s.prompts).toEqual(["one"]);
    await s.abort();
    await first;
  });

  it("timeout: soft-aborts and reports abortReason timeout", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 10_000 }])();
    const r = await runChatTurn(s, {
      text: "slow",
      timeoutMs: 20,
      emit: () => {},
      abortGraceMs: 50,
    });
    expect(r.status).toBe("aborted");
    expect(r.abortReason).toBe("timeout");
    expect(s.aborted).toBe(1);
  });

  it("operator abort via AbortSignal reports abortReason operator", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 10_000 }])();
    const ctrl = new AbortController();
    const p = runChatTurn(s, {
      text: "x",
      timeoutMs: 10_000,
      emit: () => {},
      abortSignal: ctrl.signal,
      abortGraceMs: 50,
    });
    ctrl.abort();
    const r = await p;
    expect(r.status).toBe("aborted");
    expect(r.abortReason).toBe("operator");
  });

  it("a pre-aborted signal skips the turn entirely (no prompt, no abort call)", async () => {
    const s = await fakeChatSession([chatScriptText("never")])();
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runChatTurn(s, {
      text: "x",
      timeoutMs: 1_000,
      emit: () => {},
      abortSignal: ctrl.signal,
    });
    expect(r.status).toBe("aborted");
    expect(r.abortReason).toBe("operator");
    expect(s.prompts).toEqual([]);
    expect(s.aborted).toBe(0);
  });

  it("a thrown provider error becomes status error with the message", async () => {
    const s = await fakeChatSession([
      { events: [], throws: "fetch failed: 429 too many requests" },
    ])();
    const r = await runChatTurn(s, { text: "x", timeoutMs: 1_000, emit: () => {} });
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("429");
  });

  it("a throwing emit never breaks the turn (best-effort observability)", async () => {
    const s = await fakeChatSession([chatScriptText("fine")])();
    const r = await runChatTurn(s, {
      text: "x",
      timeoutMs: 1_000,
      emit: () => {
        throw new Error("sink broke");
      },
    });
    expect(r.status).toBe("ok");
    expect(r.finalText).toBe("fine");
  });

  it("unsubscribes when done: later events do not reach emit", async () => {
    const s = await fakeChatSession([chatScriptText("a"), chatScriptText("b")])();
    const seen: string[] = [];
    await runChatTurn(s, {
      text: "1",
      timeoutMs: 1_000,
      emit: (e) => seen.push((e as { type: string }).type),
    });
    const n = seen.length;
    await s.prompt("raw"); // outside any turn
    expect(seen.length).toBe(n);
  });
});

describe("TurnDeadline", () => {
  it("fires after ms, minus nothing when never paused", async () => {
    let fired = 0;
    const d = new TurnDeadline(20);
    d.arm(() => fired++);
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(1);
  });

  it("a paused span does not count: pause/resume defers the fire by the pause length", async () => {
    let t = 0;
    const now = () => t;
    let fired = 0;
    const d = new TurnDeadline(100, now);
    d.arm(() => fired++);
    t = 40;
    d.pause();
    expect(d.remainingMs).toBe(60);
    expect(d.paused).toBe(true);
    t = 10_000; // an hour with the operator
    d.resume();
    expect(d.remainingMs).toBe(60);
    expect(fired).toBe(0);
    d.clear();
  });

  it("runChatTurn with a paused deadline does not time out; resuming it does", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 10_000 }])();
    const deadline = new TurnDeadline(30);
    deadline.pause();
    const p = runChatTurn(s, {
      text: "slow",
      timeoutMs: 30,
      emit: () => {},
      abortGraceMs: 20,
      deadline,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(s.aborted).toBe(0); // still paused → no timeout fired
    deadline.resume();
    const r = await p;
    expect(r.abortReason).toBe("timeout");
  });

  // #481: `remaining` is 0 after a fire and a leftover budget after clear(),
  // so a re-armed instance would fire immediately or run on a stale clock.
  // No caller reuses one; the guard makes a reuse inert rather than a trap.
  it("is one-shot: re-arming after a fire or a clear never fires again", async () => {
    let fired = 0;
    const d = new TurnDeadline(10);
    d.arm(() => fired++);
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(1);
    d.arm(() => fired++);
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(1);

    let cleared = 0;
    const c = new TurnDeadline(10);
    c.arm(() => cleared++);
    c.clear();
    c.arm(() => cleared++);
    // A pause/resume cycle must not revive it either.
    c.pause();
    c.resume();
    await new Promise((r) => setTimeout(r, 40));
    expect(cleared).toBe(0);
  });
});
