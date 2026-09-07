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
  type ChatCommandRecord,
  type ChatDraftRecord,
  type ChatSessionResetRecord,
  type DraftKind,
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

interface ToolCallSummary {
  /** toolCallId — the cursor/expand identity. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** null = not returned yet (live) or lost (truncated file). */
  result: ToolResultSummary | null;
}

interface TurnSummary {
  /** 0-based; the guard records' `turnIndex` space. */
  index: number;
  /** Built from tool_execution_* after the last turn_end (no text/usage yet). */
  provisional: boolean;
  thinking: string | null;
  text: string | null;
  toolCalls: ToolCallSummary[];
  usage: { input: number; output: number } | null;
}

interface RunEnd {
  stopReason: string | null;
  errorMessage: string | null;
  timedOut: boolean;
  abortedByGuard: boolean;
  /** null for the v1 agent_end fallback. */
  durationMs: number | null;
  /** null for v1. */
  usage: Usage | null;
}

/** Chat-only side records (spec 2026-09-01 §1.3), rendered one row each. */
type ChatNote =
  | { kind: "rejected"; reason: string; until: string | null; ts: string }
  | {
      kind: "draft";
      draftId: string;
      draftKind: DraftKind;
      status: ChatDraftRecord["status"];
      ids: string[];
      destination: ChatDraftRecord["destination"];
      ts: string;
    }
  | {
      kind: "command";
      commandId: string;
      command: "submit";
      draftId: string;
      ids: string[];
      route: "inbox" | "issue";
      status: ChatCommandRecord["status"];
      exitCode: number | null;
      output: string | null;
      detail: string | null;
      ts: string;
    }
  | { kind: "reset"; reason: ChatSessionResetRecord["reason"]; ts: string }
  | { kind: "degraded"; ts: string }
  | { kind: "compaction"; phase: "start" | "end"; ts: string | null };

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
  /** junco_chat_prompt text that opened this run (chat runs only). */
  prompt: string | null;
  /** Chat-only side records attached to this run, rendered one row each. */
  notes: ChatNote[];
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

interface SummaryReducerState {
  open: RunSummary | null;
  /** Opened by junco_run_start → agent_end must not close it. */
  framed: boolean;
  provisional: TurnSummary | null;
  /** Set by junco_chat_prompt, consumed by the NEXT junco_chat_turn_start
   * (a steer prompt lands on the already-open run instead — spec §1.3). */
  pendingPrompt: string | null;
}

/**
 * The transcript reducer, exposed step-wise (spec 2026-09-06 §3.3): `push`
 * folds one line into the builder's own `out`/`st`; `result()` derives the
 * summary the whole-ring `summarizeTranscript` would return for the lines
 * pushed so far — on a copy, so the live/provisional tail is never written
 * into the builder's open run, and a summary handed out earlier is never
 * touched by a later `push`.
 */
export class SummaryBuilder {
  private readonly out: TranscriptSummary = {
    ticketId: null,
    version: null,
    runs: [],
    live: false,
    invalidLines: 0,
  };
  // Reducer state lives on one object (not fields narrowed per method) so
  // the helpers below never trip TS's captured-variable narrowing.
  private readonly st: SummaryReducerState = {
    open: null,
    framed: false,
    provisional: null,
    pendingPrompt: null,
  };

  private closeRun(end: RunEnd | null): void {
    const st = this.st;
    if (st.open === null) return;
    if (st.provisional !== null) st.open.turns.push(st.provisional);
    st.provisional = null;
    st.open.end = end;
    st.open = null;
  }

  private openRun(start: RunStartRecord | null): RunSummary {
    this.closeRun(null); // a run_start over an open run: the open one is truncated
    const run: RunSummary = {
      index: this.out.runs.length + 1,
      flow: start?.flow ?? null,
      modelId: start?.modelId ?? null,
      startedAt: start?.ts ?? null,
      end: null,
      turns: [],
      guardDecisions: [],
      toolCallCount: 0,
      prompt: null,
      notes: [],
    };
    this.out.runs.push(run);
    this.st.open = run;
    this.st.framed = start !== null;
    return run;
  }

  private ensureRun(): RunSummary {
    return this.st.open ?? this.openRun(null);
  }

  // A note lands on the open run, else on the last run (a draft record
  // follows its turn's end record, spec §3); a note before ANY run gets a
  // prompt-less run that is closed immediately, so it renders and the
  // transcript is not reported live.
  private noteRun(): RunSummary {
    if (this.st.open !== null) return this.st.open;
    const last = this.out.runs[this.out.runs.length - 1];
    if (last !== undefined) return last;
    const run = this.openRun(null);
    run.flow = "chat";
    this.closeRun(V1_END);
    return run;
  }

  /** Fold one transcript line in. A blank line is a no-op. */
  push(line: string): void {
    if (line.trim() === "") return;
    const p = parseTranscriptLine(line);
    if (p.kind === "invalid") {
      this.out.invalidLines++;
      return;
    }
    if (p.kind === "junco") {
      const r = p.record;
      switch (r.type) {
        case "junco_meta":
          this.out.ticketId = r.ticketId;
          this.out.version = r.version;
          break;
        case "junco_run_start":
          this.openRun(r);
          break;
        case "junco_run_end":
          this.ensureRun();
          this.closeRun({
            stopReason: r.stopReason,
            errorMessage: r.errorMessage,
            timedOut: r.timedOut,
            abortedByGuard: r.abortedByGuard,
            durationMs: r.durationMs,
            usage: r.usage,
          });
          break;
        case "junco_guard_decision":
          this.ensureRun().guardDecisions.push(r);
          break;
        case "junco_chat_prompt":
          // A prompt opens the NEXT run's frame; a steer lands on the open one.
          if (r.mode === "steer" && this.st.open !== null) break;
          this.st.pendingPrompt = r.text;
          break;
        case "junco_chat_turn_start": {
          const run = this.openRun({
            type: "junco_run_start",
            flow: "chat",
            body: "",
            cwd: "",
            modelId: r.modelId,
            tools: r.tools,
            timeoutMs: r.timeoutMs,
            guard: { enabled: false },
            ts: r.ts,
          });
          run.prompt = this.st.pendingPrompt;
          this.st.pendingPrompt = null;
          break;
        }
        case "junco_chat_turn_end":
          this.ensureRun();
          this.closeRun({
            stopReason: r.status === "ok" ? "stop" : "error",
            errorMessage: r.errorMessage,
            timedOut: false,
            abortedByGuard: false,
            durationMs: r.durationMs,
            usage: r.usage,
          });
          break;
        case "junco_chat_turn_aborted":
          this.ensureRun();
          this.closeRun({
            stopReason: `aborted:${r.reason}`,
            errorMessage: null,
            timedOut: r.reason === "timeout",
            abortedByGuard: false,
            durationMs: null,
            usage: null,
          });
          break;
        case "junco_chat_turn_rejected":
          this.noteRun().notes.push({
            kind: "rejected",
            reason: r.reason,
            until: r.until,
            ts: r.ts,
          });
          break;
        case "junco_chat_draft":
          this.noteRun().notes.push({
            kind: "draft",
            draftId: r.draftId,
            draftKind: r.kind,
            status: r.status,
            ids: r.ids,
            destination: r.destination,
            ts: r.ts,
          });
          break;
        case "junco_chat_command": {
          const note: ChatNote = {
            kind: "command",
            commandId: r.commandId,
            command: r.command,
            draftId: r.draftId,
            ids: r.ids,
            route: r.route,
            status: r.status,
            exitCode: r.exitCode,
            output: r.output,
            detail: r.detail,
            ts: r.ts,
          };
          // One row per command: the terminal record replaces the proposed
          // one wherever it sits (the daemon-restart `expired` stamp lands
          // before any new run opens, so the proposal may be in an earlier run).
          const replaced = this.out.runs.some((run) => {
            const i = run.notes.findIndex(
              (n) => n.kind === "command" && n.commandId === r.commandId,
            );
            if (i === -1) return false;
            run.notes[i] = note;
            return true;
          });
          if (!replaced) this.noteRun().notes.push(note);
          break;
        }
        case "junco_chat_session_reset":
          this.noteRun().notes.push({ kind: "reset", reason: r.reason, ts: r.ts });
          break;
        case "junco_chat_transcript_degraded":
          this.noteRun().notes.push({ kind: "degraded", ts: r.ts });
          break;
        default:
          break; // forward compat: an unknown junco_* record is ignored
      }
      return;
    }
    const e = p.event;
    switch (e.type) {
      case "agent_start":
        if (this.st.open === null) this.openRun(null);
        break;
      case "agent_end":
        if (this.st.open !== null && !this.st.framed) this.closeRun(V1_END);
        break;
      case "compaction_start":
      case "compaction_end":
        this.ensureRun().notes.push({
          kind: "compaction",
          phase: e.type === "compaction_start" ? "start" : "end",
          ts: null,
        });
        break;
      case "tool_execution_start": {
        const run = this.ensureRun();
        this.st.provisional ??= {
          index: run.turns.length,
          provisional: true,
          thinking: null,
          text: null,
          toolCalls: [],
          usage: null,
        };
        this.st.provisional.toolCalls.push({
          id: str(e.toolCallId) ?? "",
          name: str(e.toolName) ?? "?",
          args: isRecord(e.args) ? e.args : {},
          result: null,
        });
        run.toolCallCount++;
        break;
      }
      case "tool_execution_end": {
        const call = this.st.provisional?.toolCalls.find((c) => c.id === e.toolCallId);
        if (call)
          call.result = resultFromContent(
            isRecord(e.result) ? e.result.content : undefined,
            e.isError === true,
          );
        break;
      }
      case "turn_end": {
        const run = this.ensureRun();
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
        if (this.st.provisional !== null) {
          run.toolCallCount -= this.st.provisional.toolCalls.length;
          this.st.provisional = null;
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

  /**
   * The summary for everything pushed so far. The open run's provisional turn
   * and `live` are RE-DERIVED on a copy: `runs` is cloned one level deep (each
   * run's arrays too — `noteRun` and the non-local command replacement write
   * into closed runs), and the open run additionally gets `st.provisional`
   * appended to its `turns`. The builder's own `st.open.turns` is never pushed
   * to here, so calling `result()` twice does not double the tail.
   */
  result(): TranscriptSummary {
    const { open, provisional } = this.st;
    const runs = this.out.runs.map((run) => {
      const turns =
        run === open && provisional !== null
          ? [
              ...run.turns,
              { ...provisional, toolCalls: provisional.toolCalls.map((c) => ({ ...c })) },
            ]
          : [...run.turns];
      return { ...run, turns, guardDecisions: [...run.guardDecisions], notes: [...run.notes] };
    });
    return { ...this.out, runs, live: open !== null };
  }
}

export function summarizeTranscript(lines: string[]): TranscriptSummary {
  const b = new SummaryBuilder();
  for (const line of lines) b.push(line);
  return b.result();
}

/** The incremental reducer's carried state — opaque to callers. */
export type SummaryState = SummaryBuilder;

/**
 * Incremental counterpart of `summarizeTranscript` (spec 2026-09-06 §3.3):
 * folds `line` into `state` (a fresh builder when null) and returns the
 * summary a whole-ring recompute would give — `tests/transcriptSummaryIncremental.test.ts`
 * pins the equality at every prefix. `state` is authoritative; `_prev` is the
 * summary the caller holds, accepted so the call site reads as a reducer
 * (`{summary, state} = extendSummary(summary, state, line)`) and never mutated.
 */
export function extendSummary(
  _prev: TranscriptSummary | null,
  state: SummaryState | null,
  line: string,
): { summary: TranscriptSummary; state: SummaryState } {
  const b = state ?? new SummaryBuilder();
  b.push(line);
  return { summary: b.result(), state: b };
}

/** Every tool call id in file order — the transcript view's cursor index space. */
export function toolCallIds(s: TranscriptSummary): string[] {
  return s.runs.flatMap((r) => r.turns.flatMap((t) => t.toolCalls.map((c) => c.id)));
}

export const draftAnchor = (draftId: string): string => `draft:${draftId}`;
export const commandAnchor = (commandId: string): string => `cmd:${commandId}`;

/** Tool ids ∪ draft/command anchors in file order — the chat view's cursor space. */
export function anchorIds(s: TranscriptSummary): string[] {
  const out: string[] = [];
  for (const r of s.runs) {
    for (const t of r.turns) for (const c of t.toolCalls) out.push(c.id);
    for (const n of r.notes) {
      if (n.kind === "draft") out.push(draftAnchor(n.draftId));
      else if (n.kind === "command") out.push(commandAnchor(n.commandId));
    }
  }
  return out;
}
