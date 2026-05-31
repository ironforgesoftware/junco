import { describe, it, expect } from "vitest";
import { runAgent } from "../src/agent/session.js";

// A fake AgentSession: records prompts, emits scripted events to all listeners
// when prompted, and resolves prompt() afterward (mirroring the real SDK, whose
// prompt() resolves once the agent loop finishes).
function fakeSession(events: any[]) {
  const listeners: ((e: any) => void)[] = [];
  return {
    prompted: [] as string[],
    subscribe(l: (e: any) => void) {
      listeners.push(l);
      return () => {};
    },
    async prompt(text: string) {
      (this as any).prompted.push(text);
      for (const e of events) listeners.forEach((l) => l(e));
    },
    dispose() {},
    abort: async () => {},
  };
}

describe("runAgent", () => {
  it("runs the prompt and maps events to a RunResult", async () => {
    const events = [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } },
      { type: "turn_end", message: { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 } } },
      { type: "agent_end", messages: [], willRetry: false },
    ];
    const session = fakeSession(events);
    const result = await runAgent({
      body: "ping",
      cwd: "/tmp",
      timeoutMs: 1000,
      createSession: async () => session as any,
    });
    expect(session.prompted).toEqual(["ping"]);
    expect(result.finalText).toBe("ok");
    expect(result.stopReason).toBe("stop");
    expect(result.usage.total).toBe(2);
    expect(result.timedOut).toBe(false);
  });

  it("records an error when prompt() throws and still disposes the session", async () => {
    let disposed = false;
    const session = {
      subscribe(_l: (e: any) => void) {
        return () => {};
      },
      async prompt(_text: string): Promise<void> {
        throw new Error("boom");
      },
      dispose() {
        disposed = true;
      },
      abort: async () => {},
    };
    const result = await runAgent({
      body: "ping",
      cwd: "/tmp",
      timeoutMs: 1000,
      createSession: async () => session as any,
    });
    expect(result.errorMessage).toBe("boom");
    expect(disposed).toBe(true);
  });

  it("flips timedOut and aborts when the timeout fires before prompt() resolves", async () => {
    let aborted = false;
    let resolvePrompt: (() => void) | undefined;
    const session = {
      subscribe(_l: (e: any) => void) {
        return () => {};
      },
      prompt(_text: string): Promise<void> {
        // Never resolves on its own; only the abort() unblocks it.
        return new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      },
      dispose() {},
      abort: async () => {
        aborted = true;
        resolvePrompt?.();
      },
    };
    const result = await runAgent({
      body: "ping",
      cwd: "/tmp",
      timeoutMs: 5,
      createSession: async () => session as any,
    });
    expect(aborted).toBe(true);
    expect(result.timedOut).toBe(true);
  });
});
