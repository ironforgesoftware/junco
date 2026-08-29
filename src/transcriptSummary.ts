/**
 * transcriptSummary — reduces a per-ticket JSONL transcript
 * (`<dataDir>/data/transcripts/<id>.jsonl`) to the model the transcript
 * viewer renders (transcriptRender.ts): runs → turns → tool calls with their
 * results. Pure by design, like transcriptSchema.ts: no fs, no Pi SDK —
 * `junco transcript` and the dashboard both hand it `string[]`.
 *
 * Run boundaries follow agent/replay.ts: a v2 run is framed by
 * `junco_run_start`/`junco_run_end`; an unframed (v1) run by
 * `agent_start`/`agent_end`. `turn_end` is the authoritative per-turn record
 * (SDK: `message.content` blocks + `toolResults[]`, matched by toolCallId);
 * `tool_execution_start/end` build a PROVISIONAL turn between turn_ends so a
 * live view shows activity as it happens and a crash-truncated file keeps its
 * partial last turn. `message_end` is ignored — for the assistant role it
 * duplicates turn_end and would double-count.
 */
import type { Usage } from "./types.js";
import {
  parseTranscriptLine,
  type FlowKind,
  type GuardDecisionRecord,
  type RunStartRecord,
} from "./agent/transcriptSchema.js";

export interface ToolResultSummary {
  /** Text blocks joined with "\n"; a non-text block renders as `[<type> block]`. */
  text: string;
  /** `text.split("\n").length`, 0 for "". */
  lines: number;
  isError: boolean;
}

export interface ToolCallSummary {
  /** toolCallId — the cursor/expand identity. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** null = not returned yet (live) or lost (truncated file). */
  result: ToolResultSummary | null;
}

export interface TurnSummary {
  /** 0-based; the guard records' `turnIndex` space. */
  index: number;
  /** Built from tool_execution_* after the last turn_end (no text/usage yet). */
  provisional: boolean;
  thinking: string | null;
  text: string | null;
  toolCalls: ToolCallSummary[];
  usage: { input: number; output: number } | null;
}

export interface RunEnd {
  stopReason: string | null;
  errorMessage: string | null;
  timedOut: boolean;
  abortedByGuard: boolean;
  /** null for the v1 agent_end fallback. */
  durationMs: number | null;
  /** null for v1. */
  usage: Usage | null;
}

export interface RunSummary {
  /** 1-based, for "run 2/4". */
  index: number;
  flow: FlowKind | null;
  modelId: string | null;
  startedAt: string | null;
  /** null while live, or for a run the next run_start closed (truncated). */
  end: RunEnd | null;
  turns: TurnSummary[];
  guardDecisions: GuardDecisionRecord[];
  toolCallCount: number;
}

export interface TranscriptSummary {
  ticketId: string | null;
  version: number | null;
  runs: RunSummary[];
  /** The last run has no end record — the file is still being written. */
  live: boolean;
  /** Torn/malformed lines skipped. */
  invalidLines: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Text of a tool result's content blocks — the shape shared by
 * `tool_execution_end.result.content` and `turn_end.toolResults[i].content`. */
function resultFromContent(content: unknown, isError: boolean): ToolResultSummary {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isRecord(b)) continue;
      const text = str(b.text);
      parts.push(b.type === "text" && text !== null ? text : `[${str(b.type) ?? "unknown"} block]`);
    }
  } else if (typeof content === "string") {
    parts.push(content);
  }
  const text = parts.join("\n");
  return { text, lines: text === "" ? 0 : text.split("\n").length, isError };
}

function usageOf(v: unknown): { input: number; output: number } | null {
  if (!isRecord(v)) return null;
  const n = (x: unknown): number => (typeof x === "number" ? x : 0);
  return { input: n(v.input), output: n(v.output) };
}

const V1_END: RunEnd = {
  stopReason: null,
  errorMessage: null,
  timedOut: false,
  abortedByGuard: false,
  durationMs: null,
  usage: null,
};

export function summarizeTranscript(lines: string[]): TranscriptSummary {
  const out: TranscriptSummary = {
    ticketId: null,
    version: null,
    runs: [],
    live: false,
    invalidLines: 0,
  };
  // Reducer state lives on one object (not `let`s) so the closures below
  // never trip TS's captured-variable narrowing.
  const st: { open: RunSummary | null; framed: boolean; provisional: TurnSummary | null } = {
    open: null,
    framed: false, // opened by junco_run_start → agent_end must not close it
    provisional: null,
  };

  const closeRun = (end: RunEnd | null): void => {
    if (st.open === null) return;
    if (st.provisional !== null) st.open.turns.push(st.provisional);
    st.provisional = null;
    st.open.end = end;
    st.open = null;
  };
  const openRun = (start: RunStartRecord | null): RunSummary => {
    closeRun(null); // a run_start over an open run: the open one is truncated
    const run: RunSummary = {
      index: out.runs.length + 1,
      flow: start?.flow ?? null,
      modelId: start?.modelId ?? null,
      startedAt: start?.ts ?? null,
      end: null,
      turns: [],
      guardDecisions: [],
      toolCallCount: 0,
    };
    out.runs.push(run);
    st.open = run;
    st.framed = start !== null;
    return run;
  };
  const ensureRun = (): RunSummary => st.open ?? openRun(null);

  for (const line of lines) {
    if (line.trim() === "") continue;
    const p = parseTranscriptLine(line);
    if (p.kind === "invalid") {
      out.invalidLines++;
      continue;
    }
    if (p.kind === "junco") {
      const r = p.record;
      switch (r.type) {
        case "junco_meta":
          out.ticketId = r.ticketId;
          out.version = r.version;
          break;
        case "junco_run_start":
          openRun(r);
          break;
        case "junco_run_end":
          ensureRun();
          closeRun({
            stopReason: r.stopReason,
            errorMessage: r.errorMessage,
            timedOut: r.timedOut,
            abortedByGuard: r.abortedByGuard,
            durationMs: r.durationMs,
            usage: r.usage,
          });
          break;
        case "junco_guard_decision":
          ensureRun().guardDecisions.push(r);
          break;
        default:
          break; // forward compat: an unknown junco_* record is ignored
      }
      continue;
    }
    const e = p.event;
    switch (e.type) {
      case "agent_start":
        if (st.open === null) openRun(null);
        break;
      case "agent_end":
        if (st.open !== null && !st.framed) closeRun(V1_END);
        break;
      case "tool_execution_start": {
        const run = ensureRun();
        st.provisional ??= {
          index: run.turns.length,
          provisional: true,
          thinking: null,
          text: null,
          toolCalls: [],
          usage: null,
        };
        st.provisional.toolCalls.push({
          id: str(e.toolCallId) ?? "",
          name: str(e.toolName) ?? "?",
          args: isRecord(e.args) ? e.args : {},
          result: null,
        });
        run.toolCallCount++;
        break;
      }
      case "tool_execution_end": {
        const call = st.provisional?.toolCalls.find((c) => c.id === e.toolCallId);
        if (call)
          call.result = resultFromContent(
            isRecord(e.result) ? e.result.content : undefined,
            e.isError === true,
          );
        break;
      }
      case "turn_end": {
        const run = ensureRun();
        const msg = isRecord(e.message) ? e.message : {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        const thinking: string[] = [];
        const text: string[] = [];
        const toolCalls: ToolCallSummary[] = [];
        for (const b of content) {
          if (!isRecord(b)) continue;
          if (b.type === "thinking" && typeof b.thinking === "string") thinking.push(b.thinking);
          else if (b.type === "text" && typeof b.text === "string") text.push(b.text);
          else if (b.type === "toolCall")
            toolCalls.push({
              id: str(b.id) ?? "",
              name: str(b.name) ?? "?",
              args: isRecord(b.arguments) ? b.arguments : {},
              result: null,
            });
        }
        const results = Array.isArray(e.toolResults) ? e.toolResults : [];
        for (const r of results) {
          if (!isRecord(r)) continue;
          const call = toolCalls.find((c) => c.id === r.toolCallId);
          if (call) call.result = resultFromContent(r.content, r.isError === true);
        }
        if (st.provisional !== null) {
          run.toolCallCount -= st.provisional.toolCalls.length;
          st.provisional = null;
        }
        run.toolCallCount += toolCalls.length;
        run.turns.push({
          index: run.turns.length,
          provisional: false,
          thinking: thinking.length > 0 ? thinking.join("\n") : null,
          text: text.length > 0 ? text.join("\n") : null,
          toolCalls,
          usage: usageOf(msg.usage),
        });
        break;
      }
      default:
        break;
    }
  }
  if (st.open !== null) {
    if (st.provisional !== null) st.open.turns.push(st.provisional);
    out.live = true;
  }
  return out;
}

/** Every tool call id in file order — the transcript view's cursor index space. */
export function toolCallIds(s: TranscriptSummary): string[] {
  return s.runs.flatMap((r) => r.turns.flatMap((t) => t.toolCalls.map((c) => c.id)));
}
