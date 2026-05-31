import { describe, it, expect } from "vitest";
import { RunAccumulator } from "../src/agent/runResult.js";

describe("RunAccumulator", () => {
  it("collects final text, tool calls, usage and stopReason from events", () => {
    const acc = new RunAccumulator();
    acc.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } } as any);
    acc.observe({ type: "tool_execution_end", toolName: "read", args: { path: "/x" }, isError: false } as any);
    acc.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } } as any);
    acc.observe({ type: "turn_end", turnIndex: 0, message: { stopReason: "stop", usage: { input: 10, output: 3, cacheRead: 1, total: 14 } } } as any);
    acc.observe({ type: "agent_end", messages: [], willRetry: false } as any);
    const r = acc.result(123);
    expect(r.finalText).toBe("Hello world");
    expect(r.toolCalls).toEqual([{ name: "read", args: { path: "/x" } }]);
    expect(r.usage).toEqual({ input: 10, output: 3, cacheRead: 1, total: 14 });
    expect(r.stopReason).toBe("stop");
    expect(r.durationMs).toBe(123);
    expect(r.timedOut).toBe(false);
  });

  it("sums usage across multiple turns", () => {
    const acc = new RunAccumulator();
    acc.observe({ type: "turn_end", message: { usage: { input: 5, output: 2, cacheRead: 0, total: 7 } } } as any);
    acc.observe({ type: "turn_end", message: { usage: { input: 3, output: 1, cacheRead: 0, total: 4 } } } as any);
    expect(acc.result(0).usage).toEqual({ input: 8, output: 3, cacheRead: 0, total: 11 });
  });
});
