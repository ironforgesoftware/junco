/**
 * Shared JSONL transcript-line fixtures.
 *
 * A recorded transcript is a JSONL file of Pi SDK events (all non-delta —
 * session.ts skips `message_update`) interleaved with junco's own `junco_*`
 * records. Every builder here returns ONE line (no trailing newline), so a
 * fixture transcript is just a `string[]` — exactly what `replayTranscript`
 * consumes, and what a CLI splits a real file into.
 *
 * The `junco_*` builders are typed against `src/agent/transcriptSchema.ts`, so
 * a record-shape change breaks the fixtures at compile time instead of drifting
 * silently. SDK events are untyped by design (they are the SDK's shape, mirrored
 * from the citations in `src/agent/guardManager.ts`).
 */
import type {
  GuardDecisionRecord,
  MetaRecord,
  RunEndRecord,
  RunStartRecord,
} from "../../src/agent/transcriptSchema.js";

const TS = "2026-08-16T00:00:00.000Z";

export const j = (o: unknown): string => JSON.stringify(o);

// -- SDK events --------------------------------------------------------------

export const msgStart = (): string =>
  j({ type: "message_start", message: { role: "assistant", content: [] } });

/** A whole assistant message with one text block — the rep-guard input a v1 transcript has. */
export const msgEnd = (text: string): string =>
  j({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

/** Same, with caller-supplied content blocks (`text` and/or `thinking`). */
export const msgEndBlocks = (content: unknown[], role = "assistant"): string =>
  j({ type: "message_end", message: { role, content } });

export const toolStart = (name: string, args: unknown): string =>
  j({ type: "tool_execution_start", toolCallId: "c", toolName: name, args });

export const toolEnd = (name: string, isError = false): string =>
  j({ type: "tool_execution_end", toolCallId: "c", toolName: name, result: {}, isError });

export const turnEnd = (output = 10): string =>
  j({ type: "turn_end", message: { role: "assistant", usage: { output } }, toolResults: [] });

export const agentEnd = (): string => j({ type: "agent_end", messages: [], willRetry: false });

export const agentStart = (): string => j({ type: "agent_start" });

/** tool_execution_start with a caller-chosen id (the `c`-only builders above
 * predate result matching; the summary keys results by toolCallId). */
export const toolStartId = (id: string, name: string, args: unknown): string =>
  j({ type: "tool_execution_start", toolCallId: id, toolName: name, args });

export const toolEndId = (id: string, name: string, text: string, isError = false): string =>
  j({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name,
    result: { content: [{ type: "text", text }] },
    isError,
  });

/** A complete assistant turn_end — thinking/text/toolCall content blocks plus
 * the turn's toolResults, the exact SDK shape the transcript viewer reduces. */
export const turnEndFull = (o: {
  thinking?: string;
  text?: string;
  calls?: { id: string; name: string; args: unknown; result?: string; isError?: boolean }[];
  usage?: { input: number; output: number };
}): string =>
  j({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [
        ...(o.thinking !== undefined ? [{ type: "thinking", thinking: o.thinking }] : []),
        ...(o.text !== undefined ? [{ type: "text", text: o.text }] : []),
        ...(o.calls ?? []).map((c) => ({
          type: "toolCall",
          id: c.id,
          name: c.name,
          arguments: c.args,
        })),
      ],
      usage: o.usage ?? { input: 1, output: 1 },
    },
    toolResults: (o.calls ?? [])
      .filter((c) => c.result !== undefined)
      .map((c) => ({
        role: "toolResult",
        toolCallId: c.id,
        toolName: c.name,
        content: [{ type: "text", text: c.result }],
        isError: c.isError ?? false,
      })),
  });

// -- junco records -----------------------------------------------------------

export const metaLine = (overrides: Partial<MetaRecord> = {}): string =>
  j({
    type: "junco_meta",
    version: 2,
    ticketId: "t-1",
    createdAt: TS,
    ...overrides,
  } satisfies MetaRecord);

export const runStart = (overrides: Partial<RunStartRecord> = {}): string =>
  j({
    type: "junco_run_start",
    flow: "qa",
    body: "b",
    cwd: "/w",
    modelId: "m",
    tools: [],
    timeoutMs: 1000,
    guard: { enabled: true },
    ts: TS,
    ...overrides,
  } satisfies RunStartRecord);

export const runEnd = (overrides: Partial<RunEndRecord> = {}): string =>
  j({
    type: "junco_run_end",
    errorMessage: null,
    stopReason: "end_turn",
    timedOut: false,
    abortedByGuard: false,
    usage: { input: 1, output: 1, cacheRead: 0, total: 2, costUsd: 0 },
    durationMs: 5,
    ts: TS,
    ...overrides,
  } satisfies RunEndRecord);

export const guardDecision = (overrides: Partial<GuardDecisionRecord> = {}): string =>
  j({
    type: "junco_guard_decision",
    kind: "tool_call_loop",
    action: "nudge",
    detail: "tool=bash count=3",
    turnIndex: 0,
    nudgeMessage: "stop looping",
    ts: TS,
    ...overrides,
  } satisfies GuardDecisionRecord);

// -- composite streams -------------------------------------------------------

/**
 * `repeats` turns that each run the SAME `bash` call. `ToolCallLoopGuard`'s
 * bash threshold is 3 (DEFAULT_TOOL_LOOP_THRESHOLDS in src/agent/guards.ts), so
 * the default trips on the third `tool_execution_start` — at `turnIndex` 2,
 * since the two preceding turns each closed with a `turn_end`.
 */
export function toolLoopStream(repeats = 3, args: unknown = { command: "ls" }): string[] {
  const lines: string[] = [];
  for (let i = 0; i < repeats; i++) {
    lines.push(toolStart("bash", args), toolEnd("bash"), turnEnd());
  }
  return lines;
}

/** Turn index at which `toolLoopStream()`'s default 3-call loop trips. */
export const TOOL_LOOP_TRIP_TURN = 2;

/**
 * A paragraph engineered to trip `RepetitionGuard` (src/agent/guards.ts):
 * 100 chars per line × 40 = 4000 chars (≥ minChars 1000); the guard's 2000-char
 * tail then contains its own 200-char probe 10 times (≥ threshold 4), and the
 * probe has far more than the 10 distinct characters the triviality filter wants.
 */
const REPEAT_LINE =
  "the quick brown fox jumps over the lazy dog and repeats itself endlessly".padEnd(99, ".") + "\n";

export const repetitiveText = (repeats = 40): string => REPEAT_LINE.repeat(repeats);
