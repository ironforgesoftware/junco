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
  ChatCommandRecord,
  ChatDraftRecord,
  ChatPromptRecord,
  ChatSessionResetRecord,
  ChatTurnAbortedRecord,
  ChatTurnEndRecord,
  ChatTurnRejectedRecord,
  ChatTurnStartRecord,
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
 * the turn's toolResults, the exact SDK shape the transcript viewer reduces.
 * `null` (as well as omitted) suppresses a block — some chat fixtures pass
 * `thinking: null` explicitly to mean "no thinking on this turn". */
export const turnEndFull = (o: {
  thinking?: string | null;
  text?: string | null;
  calls?: { id: string; name: string; args: unknown; result?: string; isError?: boolean }[];
  usage?: { input: number; output: number };
}): string =>
  j({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [
        ...(o.thinking != null ? [{ type: "thinking", thinking: o.thinking }] : []),
        ...(o.text != null ? [{ type: "text", text: o.text }] : []),
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

// -- chat records (spec 2026-09-01 §1.3) -------------------------------------

export const chatPrompt = (over: Partial<ChatPromptRecord> = {}): string =>
  j({
    type: "junco_chat_prompt",
    text: "why is the build slow?",
    mode: "prompt",
    source: "operator",
    ts: TS,
    ...over,
  } satisfies ChatPromptRecord);
export const chatTurnStart = (over: Partial<ChatTurnStartRecord> = {}): string =>
  j({
    type: "junco_chat_turn_start",
    modelId: "local/m1",
    tools: ["read", "grep"],
    timeoutMs: 60_000,
    ts: TS,
    ...over,
  } satisfies ChatTurnStartRecord);
export const chatTurnEnd = (over: Partial<ChatTurnEndRecord> = {}): string =>
  j({
    type: "junco_chat_turn_end",
    status: "ok",
    errorClass: null,
    errorMessage: null,
    usage: { input: 3, output: 4, cacheRead: 0, total: 7, costUsd: 0.01 },
    durationMs: 1500,
    ts: TS,
    ...over,
  } satisfies ChatTurnEndRecord);
export const chatTurnAborted = (over: Partial<ChatTurnAbortedRecord> = {}): string =>
  j({
    type: "junco_chat_turn_aborted",
    reason: "operator",
    ts: TS,
    ...over,
  } satisfies ChatTurnAbortedRecord);
export const chatTurnRejected = (over: Partial<ChatTurnRejectedRecord> = {}): string =>
  j({
    type: "junco_chat_turn_rejected",
    reason: "rate limited",
    until: "2026-09-01T18:00:00.000Z",
    ts: TS,
    ...over,
  } satisfies ChatTurnRejectedRecord);
export const chatDraft = (over: Partial<ChatDraftRecord> = {}): string =>
  j({
    type: "junco_chat_draft",
    draftId: "acme__api-20260901-120000-1",
    kind: "ticket",
    status: "parked",
    ids: ["add-cache"],
    destination: null,
    ts: TS,
    ...over,
  } satisfies ChatDraftRecord);
export const chatCommand = (over: Partial<ChatCommandRecord> = {}): string =>
  j({
    type: "junco_chat_command",
    commandId: "call_1",
    command: "submit",
    draftId: "acme__api-20260901-120000-1",
    ids: ["add-readme"],
    route: "inbox",
    status: "proposed",
    exitCode: null,
    output: null,
    detail: null,
    ts: TS,
    ...over,
  } satisfies ChatCommandRecord);
export const chatReset = (over: Partial<ChatSessionResetRecord> = {}): string =>
  j({
    type: "junco_chat_session_reset",
    reason: "corrupt",
    ts: TS,
    ...over,
  } satisfies ChatSessionResetRecord);
export const compactionStart = (): string => j({ type: "compaction_start", reason: "threshold" });
export const compactionEnd = (): string =>
  j({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });

// -- composite streams -------------------------------------------------------

/** One complete v2 run: meta, frame, a tool call streamed then confirmed by
 * turn_end — the "existing ticket transcripts render byte-identically"
 * fixture shared by tests/transcriptSummary.test.ts and
 * tests/transcriptRender.test.ts (spec 2026-09-01 §1.3's chat work must not
 * change a single byte of this). */
export function v2RunLines(): string[] {
  const CALL = { id: "c1", name: "find", args: { pattern: "*" }, result: "a\nb" };
  return [
    metaLine(),
    runStart({ flow: "assess", modelId: "local/m1", ts: "2026-08-29T01:02:47.000Z" }),
    agentStart(),
    toolStartId("c1", "find", { pattern: "*" }),
    toolEndId("c1", "find", "a\nb"),
    turnEndFull({ thinking: "hmm", text: "done", calls: [CALL], usage: { input: 10, output: 5 } }),
    agentEnd(),
    runEnd({ stopReason: "stop", durationMs: 1234 }),
  ];
}

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
