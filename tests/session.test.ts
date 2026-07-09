import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
// INITIAL prompt arrives. Records every prompt (text + options). An abort with
// a run in flight stops emitting and resolves the in-flight initial prompt.
// SDK-faithful: abort() is NOT latched — the real SDK's abort() is
// `this.activeRun?.abortController.abort()` (a no-op with no active run), and
// each prompt() creates a fresh AbortController.
function guardFakeSession(events: any[]) {
  const listeners: ((e: any) => void)[] = [];
  let aborted = false;
  let running = false;
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
      running = true;
      aborted = false; // fresh AbortController per prompt, like the real SDK
      return new Promise<void>((resolve) => {
        resolveInitial = resolve;
        // Emit synchronously after returning to the caller is unnecessary here;
        // emit on next microtask so `subscribe` is fully wired.
        queueMicrotask(() => {
          for (const e of events) {
            if (aborted) break;
            listeners.forEach((l) => l(e));
          }
          running = false;
          // Initial run finishes naturally if not aborted mid-stream.
          if (!aborted) resolve();
        });
      });
    },
    dispose() {},
    abort(): Promise<void> {
      // No active run → no-op (the real SDK does not latch aborts).
      if (!running) return Promise.resolve();
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
  it("defaults provider to local when there is no slash", () => {
    expect(splitModelId("bare-model")).toEqual({ provider: "local", modelId: "bare-model" });
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

describe("runAgent (external force-stop)", () => {
  it("an abort signal kills the run with guard-kill (salvage) semantics", async () => {
    const ac = new AbortController();
    let resolvePrompt: (() => void) | undefined;
    const session = {
      subscribe(_l: (e: any) => void) {
        return () => {};
      },
      prompt(_text: string): Promise<void> {
        // Hang until abort(); fire the operator's force-stop mid-run.
        queueMicrotask(() => ac.abort());
        return new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      },
      dispose() {},
      abort: async () => {
        resolvePrompt?.();
      },
    };
    const result = await runAgent({
      body: "ping",
      cwd: "/tmp",
      timeoutMs: 5000,
      createSession: async () => session as any,
      abortSignal: ac.signal,
    });
    expect(result.timedOut).toBe(false);
    expect(result.abortedByGuard).toBe(true); // soft abort → PR-flow salvages
    expect(result.errorMessage).toMatch(/force-stop requested by operator/);
  });

  it("an already-aborted signal skips the run entirely (SDK abort is not latched)", async () => {
    // The real SDK's abort() is `this.activeRun?.abortController.abort()` — a
    // no-op with no active run. So a pre-aborted signal must NOT be handled by
    // calling abort(): the prompt would run the whole session to completion
    // with every guard decision suppressed. runAgent must skip the run.
    const ac = new AbortController();
    ac.abort();
    let created = false;
    let prompted = 0;
    const session = {
      subscribe(_l: (e: any) => void) {
        return () => {};
      },
      prompt(_text: string): Promise<void> {
        prompted++;
        // SDK-faithful: nothing was latched, so a prompt would just run to
        // completion as if no abort had ever been requested.
        return Promise.resolve();
      },
      dispose() {},
      abort: async () => {
        // no active run → no-op (real SDK behavior)
      },
    };
    const result = await runAgent({
      body: "ping",
      cwd: "/tmp",
      timeoutMs: 5000,
      createSession: async () => {
        created = true;
        return session as any;
      },
      abortSignal: ac.signal,
    });
    expect(created).toBe(false); // checked BEFORE createSession()
    expect(prompted).toBe(0); // the run never starts
    expect(result.abortedByGuard).toBe(true);
    expect(result.errorMessage).toMatch(/force-stop/);
  });

  it("a signal aborted during createSession() skips the prompt and disposes", async () => {
    const ac = new AbortController();
    let prompted = 0;
    let disposed = false;
    const session = {
      subscribe(_l: (e: any) => void) {
        return () => {};
      },
      prompt(_text: string): Promise<void> {
        prompted++;
        return Promise.resolve();
      },
      dispose() {
        disposed = true;
      },
      abort: async () => {},
    };
    const result = await runAgent({
      body: "ping",
      cwd: "/tmp",
      timeoutMs: 5000,
      createSession: async () => {
        // The force-stop lands while the session is being built — before the
        // abort listener is attached and before any run is in flight.
        ac.abort();
        return session as any;
      },
      abortSignal: ac.signal,
    });
    expect(prompted).toBe(0); // re-checked before prompt()
    expect(disposed).toBe(true);
    expect(result.abortedByGuard).toBe(true);
    expect(result.errorMessage).toMatch(/force-stop/);
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

describe("runAgent (onProgress)", () => {
  it("fires on turn ends and tool starts with cumulative progress", async () => {
    const snaps: Array<{ turns: number; lastTool: string | null; outputTokens: number }> = [];
    const session = {
      subscribe(l: (e: any) => void) {
        queueMicrotask(() => {
          l({ type: "tool_execution_start", toolName: "read", args: {} });
          l({
            type: "turn_end",
            message: { stopReason: "stop", usage: { input: 1, output: 4, totalTokens: 5 } },
          });
        });
        return () => {};
      },
      async prompt() {
        await new Promise((r) => setTimeout(r, 5));
      },
      dispose() {},
      abort: async () => {},
    };
    await runAgent({
      body: "x",
      cwd: "/tmp",
      timeoutMs: 5000,
      createSession: async () => session as any,
      onProgress: (p) => snaps.push(p),
    });
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toEqual({ turns: 0, lastTool: "read", outputTokens: 0 });
    expect(snaps[1]).toEqual({ turns: 1, lastTool: "read", outputTokens: 4 });
  });
});

describe("runAgent (transcript sidecar)", () => {
  it("streams non-delta events to the transcript path as JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tx-"));
    const txPath = join(dir, "transcripts", "t-1.jsonl");
    const events = [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }, // skipped
      { type: "tool_execution_start", toolName: "read", args: { path: "/a" } },
      {
        type: "turn_end",
        message: { stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 } },
      },
    ];
    const session = fakeSession(events);
    await runAgent({
      body: "x",
      cwd: "/tmp",
      timeoutMs: 5000,
      createSession: async () => session as any,
      transcriptPath: txPath,
    });
    // The write stream flushes asynchronously after end(); give it a beat.
    await new Promise((r) => setTimeout(r, 50));
    const lines = readFileSync(txPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("tool_execution_start");
    expect(JSON.parse(lines[1]).type).toBe("turn_end");
    rmSync(dir, { recursive: true, force: true });
  });

  it("an unwritable transcript path only warns — the run still completes", async () => {
    const session = fakeSession([{ type: "agent_end", messages: [], willRetry: false }]);
    const result = await runAgent({
      body: "x",
      cwd: "/tmp",
      timeoutMs: 5000,
      createSession: async () => session as any,
      transcriptPath: "/dev/null/impossible/t.jsonl",
    });
    expect(result.errorMessage).toBeNull();
  });
});
