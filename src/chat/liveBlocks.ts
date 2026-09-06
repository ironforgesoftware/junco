/**
 * Live-turn vocabulary shared by the daemon (`chatSession.ts` / `liveTurn.ts`)
 * and the dashboard client (`useChat.ts`): the in-flight turn as a list of
 * blocks, plus the three **bus-only** records that carry it over SSE.
 *
 * Spec: docs/superpowers/specs/2026-09-06-chat-streaming-design.md §1.1.
 *
 * These records are never written to the transcript file and never carry an
 * SSE `id` (`Last-Event-ID` always names a persisted line). That is why they
 * live here and not in `src/agent/transcriptSchema.ts`: the schema is the
 * persisted vocabulary, and `ChatWriteRecord` (derived from `ChatRecord`)
 * must not be able to write one of these. `parseTranscriptLine` still
 * classifies them as `{ kind: "junco" }` on the wire — consumers narrow on
 * `record.type`.
 *
 * Pure: types and constants only, no I/O. The reducer (`applyLiveRecord`)
 * lands with the client state work (plan Task 8).
 */

/** One block of the in-flight turn, in content order. */
export type LiveBlock =
  | { kind: "text"; contentIndex: number; text: string }
  | { kind: "thinking"; contentIndex: number; text: string; done: boolean; startedAt: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      output: string;
      result: string | null;
      isError: boolean;
      truncated: boolean;
      done: boolean;
    };

/**
 * One provider chunk, re-tagged. `contentIndex` is the SDK's content-block
 * index so interleaved text/thinking blocks keep their order; `seq` is a
 * per-turn counter the client uses to drop duplicates after a snapshot.
 */
export interface ChatDeltaRecord {
  type: "junco_chat_delta";
  turn: string;
  seq: number;
  kind: "text" | "thinking";
  contentIndex: number;
  delta: string;
}

/**
 * Tool lifecycle, compact. `args` is the SDK's parsed args object; `output`
 * is the streamed partial output; `result` is the final text, truncated by
 * the daemon to `CHAT_TOOL_RESULT_CAP` bytes with `truncated: true`.
 */
export interface ChatToolRecord {
  type: "junco_chat_tool";
  turn: string;
  seq: number;
  id: string;
  phase: "start" | "output" | "end";
  name?: string;
  args?: unknown;
  output?: string;
  result?: string;
  isError?: boolean;
  truncated?: boolean;
}

/**
 * The in-flight turn as of subscribe time. Sent first, before any live
 * frame, only while a turn is streaming; `blocks` is the same shape the
 * client keeps, so applying it is a replace, not a merge.
 */
export interface ChatPartialRecord {
  type: "junco_chat_partial";
  turn: string;
  seq: number;
  blocks: LiveBlock[];
}

/** The bus-only records: typed, but not writable through `writeRecord`. */
export type ChatBusRecord = ChatDeltaRecord | ChatToolRecord | ChatPartialRecord;

/** Bytes of a tool's final `result` the daemon puts on the wire (spec §2.3). */
export const CHAT_TOOL_RESULT_CAP = 8_192;
/** Bytes of streamed tool `output` the daemon keeps per tool block (spec §2.3). */
export const CHAT_TOOL_OUTPUT_CAP = 32_768;
