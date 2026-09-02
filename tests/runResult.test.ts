import { describe, it, expect } from "vitest";
import { RunAccumulator, emptyRunResult } from "../src/agent/runResult.js";

// Event shapes below mirror the REAL Pi SDK: tool args arrive on
// `tool_execution_start` (end carries `result`), and usage uses `totalTokens`.

describe("RunAccumulator", () => {
  it("collects final text, tool calls, usage and stopReason from events", () => {
    const acc = new RunAccumulator();
    acc.observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    } as any);
    acc.observe({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/x" },
    } as any);
    acc.observe({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      result: "ok",
      isError: false,
    } as any);
    acc.observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    } as any);
    acc.observe({
      type: "turn_end",
      turnIndex: 0,
      message: {
        stopReason: "stop",
        usage: { input: 10, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 14 },
      },
    } as any);
    acc.observe({ type: "agent_end", messages: [], willRetry: false } as any);
    const r = acc.result(123);
    expect(r.finalText).toBe("Hello world");
    expect(r.toolCalls).toEqual([{ name: "read", args: { path: "/x" } }]);
    expect(r.usage).toEqual({ input: 10, output: 3, cacheRead: 1, total: 14, costUsd: 0 });
    expect(r.stopReason).toBe("stop");
    expect(r.durationMs).toBe(123);
    expect(r.timedOut).toBe(false);
  });

  it("sums usage (totalTokens) across multiple turns", () => {
    const acc = new RunAccumulator();
    acc.observe({
      type: "turn_end",
      message: { usage: { input: 5, output: 2, cacheRead: 0, totalTokens: 7 } },
    } as any);
    acc.observe({
      type: "turn_end",
      message: { usage: { input: 3, output: 1, cacheRead: 0, totalTokens: 4 } },
    } as any);
    expect(acc.result(0).usage).toEqual({
      input: 8,
      output: 3,
      cacheRead: 0,
      total: 11,
      costUsd: 0,
    });
  });

  it("records multiple tool calls in order and ignores tool_execution_end for args", () => {
    const acc = new RunAccumulator();
    acc.observe({ type: "tool_execution_start", toolName: "read", args: { p: 1 } } as any);
    acc.observe({
      type: "tool_execution_end",
      toolName: "read",
      result: "x",
      isError: false,
    } as any);
    acc.observe({ type: "tool_execution_start", toolName: "bash", args: { cmd: "ls" } } as any);
    expect(acc.result(0).toolCalls).toEqual([
      { name: "read", args: { p: 1 } },
      { name: "bash", args: { cmd: "ls" } },
    ]);
  });

  it("captures error via setError and the timedOut flag", () => {
    const acc = new RunAccumulator();
    acc.setError("boom");
    const r = acc.result(500, true);
    expect(r.errorMessage).toBe("boom");
    expect(r.timedOut).toBe(true);
  });

  it("falls back to input+output when a turn omits totalTokens", () => {
    const acc = new RunAccumulator();
    acc.observe({
      type: "turn_end",
      message: { usage: { input: 6, output: 4, cacheRead: 0 } },
    } as any);
    expect(acc.result(0).usage.total).toBe(10);
  });

  it("sums usage.cost.total (USD) across turns into costUsd", () => {
    const acc = new RunAccumulator();
    acc.observe({
      type: "turn_end",
      message: { usage: { input: 10, output: 5, cost: { total: 0.0123 } } },
    } as any);
    acc.observe({
      type: "turn_end",
      message: { usage: { input: 10, output: 5, cost: { total: 0.0123 } } },
    } as any);
    expect(acc.result(0).usage.costUsd).toBeCloseTo(0.0246);
  });

  it("defaults costUsd to 0 when a turn's usage omits cost", () => {
    const acc = new RunAccumulator();
    acc.observe({
      type: "turn_end",
      message: { usage: { input: 6, output: 4, cacheRead: 0 } },
    } as any);
    expect(acc.result(0).usage.costUsd).toBe(0);
  });
});

describe("auto_retry_end — retry exhaustion surfaces into errorMessage (#129)", () => {
  it("maps auto_retry_end.finalError onto errorMessage", () => {
    const acc = new RunAccumulator();
    acc.observe({
      type: "auto_retry_end",
      finalError: "model call failed after 5 retries: 503 Service Unavailable",
    } as any);
    expect(acc.result(0).errorMessage).toBe(
      "model call failed after 5 retries: 503 Service Unavailable",
    );
  });

  it("stringifies a non-string finalError", () => {
    const acc = new RunAccumulator();
    acc.observe({ type: "auto_retry_end", finalError: new Error("boom") } as any);
    expect(acc.result(0).errorMessage).toBe("Error: boom");
  });

  it("leaves errorMessage null when auto_retry_end has no finalError", () => {
    const acc = new RunAccumulator();
    acc.observe({ type: "auto_retry_end", willRetry: true } as any);
    expect(acc.result(0).errorMessage).toBeNull();
  });
});

describe("auto_retry_end — a SUCCESSFUL recovery clears the poisoned errorMessage", () => {
  // The SDK emits turn_end for the ERRORED assistant message BEFORE deciding
  // to retry, then — when the retry SUCCEEDS — auto_retry_end with
  // success:true and no finalError (agent-session.d.ts: `{ type:
  // "auto_retry_end"; success: boolean; attempt: number; finalError?: string
  // }`, verified against node_modules/@earendil-works/pi-coding-agent). Junco's
  // turn_end fallback (null-guarded first-wins, above) had already captured
  // the transient error; without this clear it survives forever, poisoning a
  // successfully-recovered run's errorMessage.
  it("clears the turn_end-captured error when auto_retry_end reports success:true", () => {
    const acc = new RunAccumulator();
    acc.observe({
      type: "turn_end",
      message: { errorMessage: "429 overloaded" },
    } as any);
    expect(acc.result(0).errorMessage).toBe("429 overloaded"); // sanity: captured first
    acc.observe({ type: "auto_retry_end", success: true, attempt: 1 } as any);
    expect(acc.result(0).errorMessage).toBeNull();
  });

  it("still lets finalError win when auto_retry_end reports failure (success:false)", () => {
    const acc = new RunAccumulator();
    acc.observe({
      type: "turn_end",
      message: { errorMessage: "429 overloaded" },
    } as any);
    acc.observe({
      type: "auto_retry_end",
      success: false,
      attempt: 5,
      finalError: "final error after retries",
    } as any);
    expect(acc.result(0).errorMessage).toBe("final error after retries");
  });
});

describe("finalText — last assistant message (#36)", () => {
  const msgStart = (role: string) => ({ type: "message_start", message: { role } }) as any;
  const delta = (t: string) =>
    ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: t } }) as any;

  it("keeps only the LAST assistant message as finalText, not the whole run", () => {
    const acc = new RunAccumulator();
    acc.observe(msgStart("assistant"));
    acc.observe(delta("I'll start by reading the code."));
    acc.observe(msgStart("assistant"));
    acc.observe(delta("Now I'll run the tests."));
    acc.observe(msgStart("assistant"));
    acc.observe(delta("All done — fixed the bug and the suite is green."));
    expect(acc.result(0).finalText).toBe("All done — fixed the bug and the suite is green.");
  });

  it("falls back to the last NON-empty message when the final message has no text", () => {
    const acc = new RunAccumulator();
    acc.observe(msgStart("assistant"));
    acc.observe(delta("the real summary"));
    // Tool-call-only assistant message: starts but produces no text deltas.
    acc.observe(msgStart("assistant"));
    expect(acc.result(0).finalText).toBe("the real summary");
  });

  it("does not reset on user or toolResult message boundaries", () => {
    // message_start fires for user, assistant, AND toolResult messages (SDK
    // MessageStartEvent) — only an assistant boundary starts a new message.
    const acc = new RunAccumulator();
    acc.observe(msgStart("assistant"));
    acc.observe(delta("part one. "));
    acc.observe(msgStart("toolResult"));
    acc.observe(msgStart("user"));
    acc.observe(delta("part two."));
    expect(acc.result(0).finalText).toBe("part one. part two.");
  });

  it("still accumulates the whole stream when no message_start events arrive", () => {
    // Back-compat with partial event shapes: without boundaries, behavior is
    // the pre-#36 concatenation.
    const acc = new RunAccumulator();
    acc.observe(delta("a"));
    acc.observe(delta("b"));
    expect(acc.result(0).finalText).toBe("ab");
  });
});

describe("allText — whole-run concatenation (#67)", () => {
  const msgStart = (role: string) => ({ type: "message_start", message: { role } }) as any;
  const delta = (t: string) =>
    ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: t } }) as any;

  it("concatenates every assistant message while finalText stays the LAST one", () => {
    const acc = new RunAccumulator();
    acc.observe(msgStart("assistant"));
    acc.observe(delta("first message"));
    acc.observe(msgStart("assistant"));
    acc.observe(delta("second message"));
    acc.observe(msgStart("assistant"));
    acc.observe(delta("third and final"));
    const r = acc.result(0);
    expect(r.finalText).toBe("third and final");
    expect(r.allText).toBe("first message\nsecond message\nthird and final");
  });

  it("retains a fence emitted BEFORE the last message (the #67 assess bug)", () => {
    const acc = new RunAccumulator();
    acc.observe(msgStart("assistant"));
    acc.observe(delta("```junco-findings\n[]\n```"));
    acc.observe(msgStart("assistant"));
    acc.observe(delta("Confirmed the citations."));
    const r = acc.result(0);
    // finalText (#36) is only the trailing message — the fence is gone.
    expect(r.finalText).toBe("Confirmed the citations.");
    // allText keeps the whole run so findings parsing can still see the fence.
    expect(r.allText).toContain("junco-findings");
    expect(r.allText).toContain("Confirmed the citations.");
  });

  it("equals finalText for a single-message run", () => {
    const acc = new RunAccumulator();
    acc.observe(msgStart("assistant"));
    acc.observe(delta("only message"));
    const r = acc.result(0);
    expect(r.allText).toBe("only message");
    expect(r.finalText).toBe("only message");
  });

  it("is undefined when the run produced no assistant text", () => {
    const acc = new RunAccumulator();
    acc.observe({ type: "tool_execution_start", toolName: "read", args: {} } as any);
    expect(acc.result(0).allText).toBeUndefined();
  });
});

describe("progress tracking", () => {
  it("tracks turns and lastTool as progress", () => {
    const acc = new RunAccumulator();
    acc.observe({ type: "tool_execution_start", toolName: "bash", args: {} } as any);
    acc.observe({
      type: "turn_end",
      message: { usage: { input: 1, output: 2, totalTokens: 3 } },
    } as any);
    acc.observe({ type: "tool_execution_start", toolName: "edit", args: {} } as any);
    expect(acc.progress()).toEqual({ turns: 1, lastTool: "edit", outputTokens: 2 });
  });
});

describe("emptyRunResult", () => {
  it("zeroes every field and carries the reason in errorMessage", () => {
    expect(emptyRunResult("clone failed")).toEqual({
      finalText: "",
      toolCalls: [],
      usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
      stopReason: null,
      errorMessage: "clone failed",
      timedOut: false,
      durationMs: 0,
      abortedByGuard: false,
    });
  });

  it("returns a fresh usage/toolCalls object per call (callers mutate results)", () => {
    const a = emptyRunResult("x");
    const b = emptyRunResult("y");
    expect(a.usage).not.toBe(b.usage);
    expect(a.toolCalls).not.toBe(b.toolCalls);
  });
});
