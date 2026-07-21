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
import type { AgentEvent, AgentSessionLike } from "../../src/agent/session.js";

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
