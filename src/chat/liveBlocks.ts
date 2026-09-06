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
 * Pure: types, constants, and the client reducer (`applyLiveRecord`, spec
 * §3.2) — no I/O. The only clock is the injectable `now` (a thinking block's
 * `startedAt` when the client creates it from a delta).
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

/**
 * The client's view of the in-flight turn (spec §3.2). `seq` is the highest
 * applied record seq (dedupe after a `junco_chat_partial` snapshot);
 * `expanded` holds the tool-card ids the operator opened; `dropped` counts
 * malformed records so the UI can show it.
 */
export interface LiveTurnState {
  turn: string;
  seq: number;
  blocks: LiveBlock[];
  expanded: ReadonlySet<string>;
  dropped: number;
}

/** Fresh state for a turn; the caller builds it from `junco_chat_turn_start` (`turn ?? ts`). */
export function startLiveTurn(turn: string): LiveTurnState {
  return { turn, seq: 0, blocks: [], expanded: new Set(), dropped: 0 };
}

/**
 * Pure reducer over PARSED bus records. Returns the SAME object when nothing
 * changed (a dropped duplicate, another turn's record, a non-live record) so
 * the caller can skip a frame; never mutates `state` or its blocks — the one
 * changed block is a new object in a new array, untouched blocks keep identity.
 *
 * - `junco_chat_partial` replaces `blocks`/`seq` wholesale when `turn`
 *   matches (keeping `expanded`/`dropped`); a null state or a different turn
 *   starts a fresh state from it (an older turn is undetectable without
 *   ordering, so "differs" means replace).
 * - `junco_chat_delta` drops on turn mismatch or `seq <= state.seq`; else
 *   appends to the `(kind, contentIndex)` block, creating it in `contentIndex`
 *   order (thinking before text at an equal index, always after any tool block
 *   already present). A text delta marks every open thinking block `done`.
 * - `junco_chat_tool` per phase: `start` appends a block; `output` appends
 *   with a rolling `CHAT_TOOL_OUTPUT_CAP` (head dropped, `truncated`); `end`
 *   sets `result` (capped at `CHAT_TOOL_RESULT_CAP`), `isError`, `done`.
 * - Malformed (or a phase for an unknown tool id) → `dropped + 1` on a new
 *   object, everything else unchanged. Turn start/end are the caller's.
 *
 * Caps are in UTF-16 code units, the same unit the daemon's wire copy is
 * measured in for the client's purposes — a safety net, not the byte cap.
 */
export function applyLiveRecord(
  state: LiveTurnState | null,
  record: unknown,
  now: () => string = () => new Date().toISOString(),
): LiveTurnState | null {
  if (!isRecord(record)) return state === null ? null : dropped(state);
  switch (record.type) {
    case "junco_chat_partial":
      return applyPartial(state, record);
    case "junco_chat_delta":
      return state === null ? null : applyDelta(state, record, now);
    case "junco_chat_tool":
      return state === null ? null : applyTool(state, record);
    default:
      return state;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const dropped = (state: LiveTurnState): LiveTurnState => ({
  ...state,
  dropped: state.dropped + 1,
});

function isLiveBlock(v: unknown): v is LiveBlock {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case "text":
      return isNum(v.contentIndex) && isStr(v.text);
    case "thinking":
      return isNum(v.contentIndex) && isStr(v.text) && isBool(v.done) && isStr(v.startedAt);
    case "tool":
      return (
        isStr(v.id) &&
        isStr(v.name) &&
        "args" in v &&
        isStr(v.output) &&
        (v.result === null || isStr(v.result)) &&
        isBool(v.isError) &&
        isBool(v.truncated) &&
        isBool(v.done)
      );
    default:
      return false;
  }
}

function applyPartial(
  state: LiveTurnState | null,
  rec: Record<string, unknown>,
): LiveTurnState | null {
  const { turn, seq, blocks } = rec;
  if (!isStr(turn) || !isNum(seq) || !Array.isArray(blocks) || !blocks.every(isLiveBlock)) {
    return state === null ? null : dropped(state);
  }
  // Snapshot blocks are copied so the reducer never aliases the record.
  const copy = blocks.map((b) => ({ ...b }));
  if (state === null || state.turn !== turn) {
    return { turn, seq, blocks: copy, expanded: new Set(), dropped: 0 };
  }
  return { ...state, seq, blocks: copy };
}

/** Sort key for content blocks: contentIndex, then thinking before text. */
const rank = (b: { kind: "text" | "thinking"; contentIndex: number }): number =>
  b.contentIndex * 2 + (b.kind === "thinking" ? 0 : 1);

function applyDelta(
  state: LiveTurnState,
  rec: Record<string, unknown>,
  now: () => string,
): LiveTurnState {
  const { turn, seq, kind, contentIndex, delta } = rec;
  if (
    !isStr(turn) ||
    !isNum(seq) ||
    (kind !== "text" && kind !== "thinking") ||
    !isNum(contentIndex) ||
    !isStr(delta)
  ) {
    return dropped(state);
  }
  if (turn !== state.turn || seq <= state.seq) return state;

  let blocks: LiveBlock[] = state.blocks;
  if (kind === "text") {
    // Belt and braces against a missing thinking_end (spec §3.2).
    blocks = blocks.map((b) => (b.kind === "thinking" && !b.done ? { ...b, done: true } : b));
  }
  const at = blocks.findIndex((b) => b.kind === kind && b.contentIndex === contentIndex);
  if (at >= 0) {
    const cur = blocks[at] as Extract<LiveBlock, { kind: "text" | "thinking" }>;
    const next = { ...cur, text: cur.text + delta } as LiveBlock;
    blocks = blocks === state.blocks ? [...blocks] : blocks;
    blocks[at] = next;
  } else {
    const fresh: LiveBlock =
      kind === "text"
        ? { kind, contentIndex, text: delta }
        : { kind, contentIndex, text: delta, done: false, startedAt: now() };
    // Insert after the last block that does not sort after it; tool blocks
    // never sort after a new content block (they mark an earlier message).
    let i = blocks.length;
    while (i > 0) {
      const prev = blocks[i - 1] as LiveBlock;
      if (prev.kind === "tool" || rank(prev) <= rank(fresh)) break;
      i--;
    }
    blocks = [...blocks.slice(0, i), fresh, ...blocks.slice(i)];
  }
  return { ...state, seq, blocks };
}

function applyTool(state: LiveTurnState, rec: Record<string, unknown>): LiveTurnState {
  const { turn, seq, id, phase } = rec;
  if (
    !isStr(turn) ||
    !isNum(seq) ||
    !isStr(id) ||
    (phase !== "start" && phase !== "output" && phase !== "end")
  ) {
    return dropped(state);
  }
  if (turn !== state.turn || seq <= state.seq) return state;

  if (phase === "start") {
    if (!isStr(rec.name)) return dropped(state);
    const fresh: LiveBlock = {
      kind: "tool",
      id,
      name: rec.name,
      args: rec.args,
      output: "",
      result: null,
      isError: false,
      truncated: false,
      done: false,
    };
    return { ...state, seq, blocks: [...state.blocks, fresh] };
  }

  const at = state.blocks.findIndex((b) => b.kind === "tool" && b.id === id);
  if (at < 0) return { ...dropped(state), seq };
  const cur = state.blocks[at] as Extract<LiveBlock, { kind: "tool" }>;
  let next: LiveBlock;
  if (phase === "output") {
    if (!isStr(rec.output)) return dropped(state);
    const joined = cur.output + rec.output;
    const over = joined.length - CHAT_TOOL_OUTPUT_CAP;
    next =
      over > 0
        ? { ...cur, output: joined.slice(over), truncated: true }
        : { ...cur, output: joined };
  } else {
    if (rec.result !== undefined && !isStr(rec.result)) return dropped(state);
    const raw = rec.result ?? null;
    const capped = raw !== null && raw.length > CHAT_TOOL_RESULT_CAP;
    next = {
      ...cur,
      result: capped ? raw.slice(0, CHAT_TOOL_RESULT_CAP) : raw,
      isError: rec.isError === true,
      truncated: cur.truncated || rec.truncated === true || capped,
      done: true,
    };
  }
  const blocks = [...state.blocks];
  blocks[at] = next;
  return { ...state, seq, blocks };
}
