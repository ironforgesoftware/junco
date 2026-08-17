/**
 * tests/replayParity.test.ts — live/replay decision-parity.
 *
 * Proves that `replayTranscript()`, fed the exact transcript `runEnveloped()`
 * wrote for a REAL live run (through `runAgent`'s real GuardManager wiring),
 * reproduces the same guard decisions the live path made. The live path is
 * the reference: per task-9-brief.md, any divergence found here is a bug in
 * `replay.ts`, never in the live path.
 *
 * The session fake below is test-local, modeled on
 * tests/helpers/fakeSession.ts's internal (non-exported) `makeSession`: its
 * exported builders (`fakeSession`/`fakeMultiMessageSession`) never emit
 * `message_end`, which replay needs — the live GuardManager consumes
 * `message_update` deltas, replay consumes `message_end`'s full text — so
 * this fake emits BOTH, kept in sync (deltas that concatenate to the
 * message_end content). That cross-representation agreement is exactly what
 * this test certifies.
 */
import { describe, it, expect } from "vitest";
import { runEnveloped, guardOptionsFromConfig } from "../src/agent/runEnvelope.js";
import { replayTranscript } from "../src/agent/replay.js";
import type { AgentEvent, AgentSessionLike } from "../src/agent/session.js";
import { makeConfig, type ConfigSeams } from "./helpers/config.js";

const seams: ConfigSeams = {
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/queue",
  worktreeRoot: "/sbxroot/wts",
  tools: [],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: true,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
};

// One shared Config for BOTH the live run and the replay's guard options —
// guaranteeing the same supervisor policy on both sides by construction
// rather than by two independent makeConfig() calls staying in sync.
const cfg = makeConfig(seams, { transcriptsEnabled: true });

function memorySink(lines: string[]) {
  return () => ({
    write: (l: string) => lines.push(l.trimEnd()),
    end: () => {},
  });
}

// -- test-local session fake -------------------------------------------------
// DELIVERY TIMING mirrors fakeSession.ts's makeSession (load-bearing there,
// preserved here on purpose): events queue in a microtask at subscribe()
// time, and prompt() resolves only after a real macrotask. runAgent
// subscribes, then awaits prompt(), then unsubscribes — so the whole event
// burst lands inside the awaited prompt.
type Emit = (event: AgentEvent) => void;
const emit = (l: Emit, event: unknown): void => l(event as AgentEvent);

function makeLiveSession(
  build: (l: Emit) => void,
  promptDelayMs = 1,
): () => Promise<AgentSessionLike> {
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
 * One realistic assistant turn: message_start, streamed text_delta chunks
 * that concatenate to `text`, an optional tool call, a message_end carrying
 * the SAME full `text` (the live/replay cross-representation agreement),
 * then turn_end with usage well under the output budget.
 */
function emitTurn(l: Emit, text: string, tool?: { name: string; args: unknown }): void {
  emit(l, { type: "message_start", message: { role: "assistant", content: [] } });
  const mid = Math.max(1, Math.floor(text.length / 2));
  emit(l, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text.slice(0, mid) },
  });
  emit(l, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text.slice(mid) },
  });
  if (tool) {
    emit(l, {
      type: "tool_execution_start",
      toolCallId: "c",
      toolName: tool.name,
      args: tool.args,
    });
    emit(l, {
      type: "tool_execution_end",
      toolCallId: "c",
      toolName: tool.name,
      result: {},
      isError: false,
    });
  }
  emit(l, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  emit(l, {
    type: "turn_end",
    message: { role: "assistant", usage: { output: 10 } },
    toolResults: [],
  });
}

/**
 * Three turns, each calling the SAME `bash` command with identical args —
 * trips ToolCallLoopGuard (bash threshold 3, DEFAULT_TOOL_LOOP_THRESHOLDS in
 * src/agent/guards.ts) on the third tool_execution_start. turnIndex only
 * advances on turn_end (guardManager.ts's onTurnEnd), so the trip lands at
 * turnIndex 2 — mirroring transcriptFixtures.ts's TOOL_LOOP_TRIP_TURN.
 * supervisorBudgetPerKind defaults to 1 (tests/helpers/config.ts), so the
 * first trip is a NUDGE, not a kill — exactly one guard decision.
 */
function loopingFakeSession(): () => Promise<AgentSessionLike> {
  return makeLiveSession((l) => {
    for (let i = 0; i < 3; i++) {
      emitTurn(l, `Let me check the files (attempt ${i}).`, {
        name: "bash",
        args: { command: "ls -la" },
      });
    }
    emit(l, { type: "agent_end", messages: [], willRetry: false });
  });
}

/** One ordinary turn, no tool calls, short text — nothing trips any guard. */
function cleanFakeSession(): () => Promise<AgentSessionLike> {
  return makeLiveSession((l) => {
    emitTurn(l, "All good here, nothing more to do.");
    emit(l, { type: "agent_end", messages: [], willRetry: false });
  });
}

describe("live/replay decision parity", () => {
  it("replay reproduces the live path's decisions from its own transcript", async () => {
    const lines: string[] = [];
    const liveDecisions: Array<{ action: string; kind: string; turnIndex: number }> = [];
    await runEnveloped(
      cfg,
      { ticketId: "parity-1", flow: "qa", body: "go", cwd: "/w", timeoutMs: 5000 },
      {
        createSession: loopingFakeSession(),
        onGuardDecision: (d) =>
          liveDecisions.push({ action: d.action, kind: d.kind, turnIndex: d.turnIndex }),
        transcriptSink: memorySink(lines),
        fileExists: () => false,
      },
    );

    // Sanity: the scripted stream actually tripped the guard exactly once,
    // as a nudge (budgetPerKind=1 → first trip nudges, doesn't kill).
    expect(liveDecisions).toEqual([{ action: "nudge", kind: "tool_call_loop", turnIndex: 2 }]);

    const report = replayTranscript(lines, { guard: guardOptionsFromConfig(cfg) });

    expect(report.version).toBe(2);
    expect(report.identical).toBe(true);
    expect(
      report.runs[0].replayed.map((r) => ({
        action: r.decision.action,
        kind: r.decision.kind,
        turnIndex: r.decision.turnIndex,
      })),
    ).toEqual(liveDecisions);
  });

  it("parity holds for a no-decision run", async () => {
    const lines: string[] = [];
    const liveDecisions: Array<{ action: string; kind: string; turnIndex: number }> = [];
    await runEnveloped(
      cfg,
      { ticketId: "parity-2", flow: "qa", body: "go", cwd: "/w", timeoutMs: 5000 },
      {
        createSession: cleanFakeSession(),
        onGuardDecision: (d) =>
          liveDecisions.push({ action: d.action, kind: d.kind, turnIndex: d.turnIndex }),
        transcriptSink: memorySink(lines),
        fileExists: () => false,
      },
    );

    expect(liveDecisions).toEqual([]);

    const report = replayTranscript(lines, { guard: guardOptionsFromConfig(cfg) });

    expect(report.version).toBe(2);
    expect(report.identical).toBe(true);
    expect(report.runs[0].recorded).toEqual([]);
    expect(report.runs[0].replayed).toEqual([]);
  });
});
