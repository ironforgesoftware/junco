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
}

export interface FakeChatSession extends ChatSessionLike {
  prompts: string[];
  steers: string[];
  aborted: number;
  disposed: boolean;
}

/** message_start + one text_delta + turn_end(usage, costUsd) + agent_end +
 * agent_settled — the shape a completed assistant turn has on the wire. */
export function chatScriptText(text: string, costUsd = 0): ChatScript {
  return {
    events: [
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
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

/**
 * PUSH-based (unlike makeSession above): events are emitted from prompt(), to
 * whoever is subscribed at that moment, because a chat session is prompted
 * many times over its life. `messages` grows by two per completed prompt.
 */
export function fakeChatSession(scripts: ChatScript[]): () => Promise<FakeChatSession> {
  return async () => {
    const listeners = new Set<(e: AgentEvent) => void>();
    let streaming = false;
    let resolveAbort: (() => void) | null = null;
    let turn = 0;
    const s: FakeChatSession = {
      prompts: [],
      steers: [],
      aborted: 0,
      disposed: false,
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
        try {
          if (script.throws) throw new Error(script.throws);
          s.messages.push({ role: "user", content: text });
          await new Promise<void>((r) => queueMicrotask(r));
          for (const e of script.events) for (const l of listeners) l(e as AgentEvent);
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
        }
      },
      async steer(text: string) {
        s.steers.push(text);
      },
      async abort() {
        s.aborted++;
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
