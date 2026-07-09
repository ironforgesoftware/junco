import { describe, it, expect } from "vitest";
import { RunAccumulator } from "../src/agent/runResult.js";

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
    expect(r.usage).toEqual({ input: 10, output: 3, cacheRead: 1, total: 14 });
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
    expect(acc.result(0).usage).toEqual({ input: 8, output: 3, cacheRead: 0, total: 11 });
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
