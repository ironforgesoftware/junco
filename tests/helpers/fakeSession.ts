/**
 * tests/helpers/fakeSession.ts — the shared scriptable `AgentSessionLike` fakes.
 *
 * Replaces three copies of the same fixtures: tests/analyzeFlow.test.ts and
 * tests/assessFlow.test.ts carried byte-identical `fakeSession` /
 * `fakeMultiMessageSession` / `throwingSession` blocks (analyzeFlow's copy even
 * carried a comment pointing at assessFlow's), and tests/runOnce.test.ts had a
 * fourth and fifth (`fakeFactory`, a local `fakeSession`) differing only in the
 * emitted text and the prompt() delay.
 *
 * DELIVERY TIMING IS LOAD-BEARING — do not "fix" it. Events are queued in a
 * microtask *at subscribe time*, not from prompt(), and prompt() resolves only
 * after a real macrotask (setTimeout). `runAgent` subscribes, then awaits
 * prompt(), then unsubscribes, so the whole event burst lands inside the awaited
 * prompt. An instant-resolve prompt() or emitting synchronously from subscribe()
 * changes what the flow tests are exercising.
 *
 * NOT here on purpose: tests/critic.test.ts's fakes. Those are push-based (a
 * `listeners[]` array driven from prompt()) because critic drives the session
 * synchronously — a real structural difference, not duplication.
 */
import type { AgentEvent, AgentSessionLike, ChatSessionLike } from "../../src/agent/session.js";

/** A factory as the flow `deps.sessionFactoryFor` seam returns one. */
export type FakeSessionFactory = () => Promise<AgentSessionLike>;

/** Fake SDK events are hand-rolled shapes, not full `AgentEvent` unions. */
type Emit = (event: AgentEvent) => void;
const emit = (l: Emit, event: unknown): void => l(event as AgentEvent);

/**
 * Builds a session whose subscribe() queues `events` (built lazily so each
 * subscriber gets its own objects) and whose prompt() resolves after
 * `promptDelayMs`. The returned unsubscribe suppresses any not-yet-delivered
 * event, which is why the burst is queued rather than emitted synchronously.
 */
function makeSession(build: (l: Emit) => void, promptDelayMs: number): FakeSessionFactory {
  return async () => ({
    subscribe(l: (event: AgentEvent) => void) {
      let live = true;
      queueMicrotask(() => {
        if (!live) return;
        build((e) => {
          if (live) l(e);
        });
      });
      return () => {
        live = false;
      };
    },
    async prompt() {
      await new Promise((r) => setTimeout(r, promptDelayMs));
    },
    dispose() {},
    abort: async () => {},
  });
}

/**
 * The single-message fake: one `text_delta` carrying `finalText`, then a
 * `turn_end` whose usage reports `costUsd` at `usage.cost.total` (the SDK's own
 * USD figure — `RunAccumulator` folds it into `RunResult.usage.costUsd`, which
 * is what a `deps.spend` wire records), then `agent_end`.
 */
export function fakeSession(finalText: string, costUsd = 0, promptDelayMs = 1): FakeSessionFactory {
  return makeSession((l) => {
    emit(l, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: finalText },
    });
    emit(l, {
      type: "turn_end",
      message: {
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2, cost: { total: costUsd } },
      },
    });
    emit(l, { type: "agent_end", messages: [], willRetry: false });
  }, promptDelayMs);
}

/**
 * A scriptable session that emits each of `messages` as its own assistant
 * message (message_start + text_delta), reproducing #36's finalText =
 * last-message-only while allText keeps the whole run.
 */
export function fakeMultiMessageSession(messages: string[], promptDelayMs = 1): FakeSessionFactory {
  return makeSession((l) => {
    for (const m of messages) {
      emit(l, { type: "message_start", message: { role: "assistant" } });
      emit(l, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: m } });
    }
    emit(l, {
      type: "turn_end",
      message: {
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
      },
    });
    emit(l, { type: "agent_end", messages: [], willRetry: false });
  }, promptDelayMs);
}

/** A session whose prompt() throws — the Q&A transient-failure signature. */
export function throwingSession(message = "fetch failed: ECONNREFUSED"): FakeSessionFactory {
  return async () => ({
    subscribe() {
      return () => {};
    },
    async prompt() {
      throw new Error(message);
    },
    dispose() {},
    abort: async () => {},
  });
}

/** One prompt()'s worth of scripted events (chat seam, spec 2026-09-01). */
export interface ChatScript {
  events: unknown[];
  /** prompt() resolves after this many ms (default 1) unless aborted. */
  delayMs?: number;
  /** prompt() rejects with this message instead of emitting. */
  throws?: string;
  /**
   * Invoke the session's ONE registered custom tool (spec 2026-09-03 §3.2)
   * instead of emitting canned text: prompt() calls
   * `customTools[0].execute(id, args, signal)` and resolves when it returns,
   * then emits the tool's own result text as the turn's answer.
   */
  toolCall?: { id: string; args?: Record<string, unknown> };
}

/** The SDK's `ToolDefinition`, the parts a `toolCall` step needs — structural
 * on purpose so this helper stays free of any src/chat import. */
interface FakeCustomTool {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/** What the session factory was handed — `SessionOverrides` satisfies it
 * structurally, so a test can pass the overrides straight through. */
export interface FakeChatToolHost {
  customTools?: unknown[];
}

export interface FakeChatSession extends ChatSessionLike {
  prompts: string[];
  steers: string[];
  aborted: number;
  disposed: boolean;
  /** One entry per `toolCall` step that ran: the tool's result text and
   *  whether its per-call signal had fired by the time it returned. */
  toolCalls: Array<{ id: string; text: string; signalAborted: boolean }>;
}

/** message_start + one text_delta + turn_end(usage, costUsd) + agent_end +
 * agent_settled — the shape a completed assistant turn has on the wire. */
export function chatScriptText(text: string, costUsd = 0): ChatScript {
  return {
    events: [
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
      },
      {
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text }],
          usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2, cost: { total: costUsd } },
        },
        toolResults: [],
      },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ],
  };
}

/** Like chatScriptText, but the model reasons natively first: a
 * `thinking_delta` (content block 0) precedes the `text_delta` (block 1) —
 * the shape that makes `chat.thinkTags: "auto"` stop splitting `<think>` tags
 * (spec 2026-09-06 §2.1). */
export function chatScriptThinking(thinking: string, text: string, costUsd = 0): ChatScript {
  const base = chatScriptText(text, costUsd);
  return {
    events: [
      base.events[0],
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinking },
      },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: text },
      },
      ...base.events.slice(2),
    ],
  };
}

/** A step that CALLS the registered `junco_submit` (#477) rather than
 * emitting canned text — the only fake that crosses the SDK's tool boundary,
 * so the handshake's in-turn properties are provable without a live model. */
export function chatScriptToolCall(id: string, args: Record<string, unknown> = {}): ChatScript {
  return { events: [], toolCall: { id, args } };
}

/**
 * PUSH-based (unlike makeSession above): events are emitted from prompt(), to
 * whoever is subscribed at that moment, because a chat session is prompted
 * many times over its life. `messages` grows by two per completed prompt.
 *
 * `host` is the `SessionOverrides` the factory was handed; a `toolCall` step
 * runs `host.customTools[0]` with a per-call AbortSignal that abort() fires,
 * exactly as the SDK aborts a running tool's signal.
 */
export function fakeChatSession(
  scripts: ChatScript[],
  host: FakeChatToolHost = {},
): () => Promise<FakeChatSession> {
  return async () => {
    const listeners = new Set<(e: AgentEvent) => void>();
    let streaming = false;
    let resolveAbort: (() => void) | null = null;
    let toolAbort: AbortController | null = null;
    let turn = 0;
    const s: FakeChatSession = {
      prompts: [],
      steers: [],
      aborted: 0,
      disposed: false,
      toolCalls: [],
      messages: [],
      get isStreaming() {
        return streaming;
      },
      get isIdle() {
        return !streaming;
      },
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      async prompt(text: string) {
        s.prompts.push(text);
        const script = scripts[turn++] ?? { events: [] };
        streaming = true;
        // Set up the abort signal SYNCHRONOUSLY, before any await, so a
        // caller that awaits abort() immediately after (not yet) awaiting
        // prompt() — as tests do — can't race past the point where
        // resolveAbort exists. Resolving abortSignal early is fine: the
        // Promise.race below picks it up whenever it later runs.
        let resolveAbortSignal!: () => void;
        const abortSignal = new Promise<void>((r) => (resolveAbortSignal = r));
        resolveAbort = resolveAbortSignal;
        const ctl = new AbortController();
        toolAbort = ctl;
        try {
          if (script.throws) throw new Error(script.throws);
          s.messages.push({ role: "user", content: text });
          await new Promise<void>((r) => queueMicrotask(r));
          for (const e of script.events) for (const l of listeners) l(e as AgentEvent);
          if (script.toolCall) {
            const tool = (host.customTools ?? [])[0] as FakeCustomTool | undefined;
            if (tool === undefined)
              throw new Error("fakeChatSession: a toolCall step needs a registered custom tool");
            const r = await tool.execute(
              script.toolCall.id,
              script.toolCall.args ?? {},
              ctl.signal,
            );
            const out = r.content.map((c) => c.text).join("");
            s.toolCalls.push({
              id: script.toolCall.id,
              text: out,
              signalAborted: ctl.signal.aborted,
            });
            // The model relays the tool result as its answer — the same
            // message shape a plain scripted turn ends with.
            for (const e of chatScriptText(out).events)
              for (const l of listeners) l(e as AgentEvent);
          }
          let timer: ReturnType<typeof setTimeout>;
          await Promise.race([
            new Promise<void>((r) => (timer = setTimeout(r, script.delayMs ?? 1))),
            abortSignal,
          ]);
          clearTimeout(timer!);
          s.messages.push({ role: "assistant", content: "" });
        } finally {
          streaming = false;
          resolveAbort = null;
          toolAbort = null;
        }
      },
      async steer(text: string) {
        s.steers.push(text);
      },
      async abort() {
        s.aborted++;
        // The SDK aborts the RUNNING TOOL's own signal as well as the run —
        // the belt to ChatSession.abort()'s braces (spec 2026-09-03 §3.3).
        toolAbort?.abort();
        resolveAbort?.();
      },
      dispose() {
        s.disposed = true;
        listeners.clear();
      },
    };
    return s;
  };
}
