import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent, apiBaseUrl, splitModelId } from "../src/agent/session.js";
import { GuardManager } from "../src/agent/guardManager.js";

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
      {
        type: "turn_end",
        message: {
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
        },
      },
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
});

// A fake session for guard-driven tests: emits `events` to listeners when the
// INITIAL prompt arrives. Records every prompt (text + options). Once aborted,
// stops emitting and resolves the in-flight initial prompt (mirroring the real
// SDK, whose abort() halts the run and resolves prompt()).
function guardFakeSession(events: any[]) {
  const listeners: ((e: any) => void)[] = [];
  let aborted = false;
  let resolveInitial: (() => void) | undefined;
  const self = {
    prompts: [] as { text: string; options?: any }[],
    aborted: false,
    subscribe(l: (e: any) => void) {
      listeners.push(l);
      return () => {};
    },
    prompt(text: string, options?: any): Promise<void> {
      self.prompts.push({ text, options });
      // Only the INITIAL prompt drives the event stream; steered nudge prompts
      // are fire-and-forget injections that don't re-emit the script.
      if (self.prompts.length > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveInitial = resolve;
        // Emit synchronously after returning to the caller is unnecessary here;
        // emit on next microtask so `subscribe` is fully wired.
        queueMicrotask(() => {
          for (const e of events) {
            if (aborted) break;
            listeners.forEach((l) => l(e));
          }
          // Initial run finishes naturally if not aborted mid-stream.
          if (!aborted) resolve();
        });
      });
    },
    dispose() {},
    abort(): Promise<void> {
      aborted = true;
      self.aborted = true;
      resolveInitial?.();
      return Promise.resolve();
    },
  };
  return self;
}

describe("runAgent (guard manager)", () => {
  it("injects a nudge (steer) when a guard trips", async () => {
    // 3 identical bash calls → tool_call_loop nudge on the 3rd.
    const args = { command: "ls -la" };
    const events = [
      { type: "tool_execution_start", toolName: "bash", args },
      { type: "tool_execution_start", toolName: "bash", args },
      { type: "tool_execution_start", toolName: "bash", args },
      { type: "agent_end", messages: [], willRetry: false },
    ];
    const session = guardFakeSession(events);
    const result = await runAgent({
      body: "do work",
      cwd: "/tmp",
      timeoutMs: 1000,
      createSession: async () => session as any,
      guardManager: new GuardManager(),
    });
    // The nudge prompt was injected with streamingBehavior: "steer".
    expect(session.prompts[0].text).toBe("do work");
    const nudge = session.prompts.find((p) => p.options?.streamingBehavior === "steer");
    expect(nudge).toBeDefined();
    expect(nudge!.text).toContain("JUNCO NOTICE");
    expect(nudge!.text).toContain("bash");
    // A single nudge is not a kill — no errorMessage.
    expect(result.errorMessage).toBeNull();
    expect(session.aborted).toBe(false);
  });

  it("aborts the run and records the kill reason on escalation", async () => {
    // Output budget over 12000 in a turn → kill (output_budget always kills).
    const events = [
      { type: "turn_end", message: { usage: { output: 99999, input: 0, totalTokens: 99999 } } },
      // Trailing events should NOT be observed after the abort/kill.
      { type: "tool_execution_start", toolName: "bash", args: { command: "x" } },
      { type: "agent_end", messages: [], willRetry: false },
    ];
    const session = guardFakeSession(events);
    const result = await runAgent({
      body: "do work",
      cwd: "/tmp",
      timeoutMs: 1000,
      createSession: async () => session as any,
      guardManager: new GuardManager({ outputBudgetPerTurn: 12000 }),
    });
    expect(session.aborted).toBe(true);
    expect(result.errorMessage).toContain("supervisor kill");
    expect(result.errorMessage).toContain("output_budget");
    // Not flagged as a timeout (it was a guard kill, not the wall-clock timer).
    expect(result.timedOut).toBe(false);
  });

  it("preserves M1 behavior when no guardManager is passed", async () => {
    // Identical to the basic runAgent test, just asserting no injection happens.
    const args = { command: "ls" };
    const events = [
      { type: "tool_execution_start", toolName: "bash", args },
      { type: "tool_execution_start", toolName: "bash", args },
      { type: "tool_execution_start", toolName: "bash", args },
      { type: "agent_end", messages: [], willRetry: false },
    ];
    const session = guardFakeSession(events);
    const result = await runAgent({
      body: "do work",
      cwd: "/tmp",
      timeoutMs: 1000,
      createSession: async () => session as any,
    });
    expect(session.prompts).toHaveLength(1); // only the initial prompt, no nudge
    expect(session.aborted).toBe(false);
    expect(result.errorMessage).toBeNull();
  });
});

describe("apiBaseUrl", () => {
  it("strips a trailing /models to get the API base", () => {
    expect(apiBaseUrl("http://127.0.0.1:1234/v1/models")).toBe("http://127.0.0.1:1234/v1");
    expect(apiBaseUrl("http://127.0.0.1:1234/v1/models/")).toBe("http://127.0.0.1:1234/v1");
  });
  it("leaves an API-base URL unchanged", () => {
    expect(apiBaseUrl("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234/v1");
  });
});

describe("splitModelId", () => {
  it("splits on the first slash into provider + id", () => {
    expect(splitModelId("omlx/Qwen3.6-27B-oQ8-mtp")).toEqual({
      provider: "omlx",
      modelId: "Qwen3.6-27B-oQ8-mtp",
    });
  });
  it("preserves slashes in the model id (multi-segment)", () => {
    expect(splitModelId("openrouter/anthropic/claude")).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude",
    });
  });
  it("defaults provider to omlx when there is no slash", () => {
    expect(splitModelId("bare-model")).toEqual({ provider: "omlx", modelId: "bare-model" });
  });
});

describe("runAgent (timeout)", () => {
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

// The models.json (file) path of makePiSessionFactory relies on the SDK's
// ModelRegistry.create(authStorage, path) resolving a provider+model from a
// Pi-style models.json. This exercises that contract WITHOUT a live model
// (building the registry from a file does no network I/O).
describe("models.json file path — SDK resolution", () => {
  it("ModelRegistry.create resolves a provider+model from a Pi models.json", async () => {
    const { ModelRegistry, AuthStorage } = await import("@earendil-works/pi-coding-agent");
    const dir = mkdtempSync(join(tmpdir(), "junco-mj-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(
        p,
        JSON.stringify({
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:1234/v1",
              api: "openai-completions",
              apiKey: "1234",
              compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true },
              models: [
                {
                  id: "my-model",
                  name: "My Model",
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 200000,
                  maxTokens: 8192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  compat: { thinkingFormat: "qwen-chat-template" },
                },
              ],
            },
          },
        }),
      );
      const registry = ModelRegistry.create(AuthStorage.inMemory(), p);
      const model = registry.find("omlx", "my-model");
      expect(model).toBeTruthy();
      expect(model!.contextWindow).toBe(200000);
      expect(model!.maxTokens).toBe(8192);
      expect(model!.reasoning).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
