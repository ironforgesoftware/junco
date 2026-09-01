import { describe, it, expect } from "vitest";
import { runChatTurn } from "../src/chat/chatTurn.js";
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
