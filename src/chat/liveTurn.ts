/**
 * Per-turn accumulator for the dashboard chat stream: Pi SDK events in, slim
 * bus-only records out (`junco_chat_delta` / `junco_chat_tool`), and the
 * `junco_chat_partial` snapshot a late subscriber gets first.
 *
 * Spec: docs/superpowers/specs/2026-09-06-chat-streaming-design.md §1.2 (the
 * event table), §1.3 (per-frame cost), §2.1 (`auto` think-tag semantics), §2.3
 * (the two caps).
 *
 * Pure: no I/O, no timers, `now` injected. Block text is kept as `string[]`
 * chunks and joined only in `partial()` (§1.3 — the quadratic serialization
 * the old raw `message_update` fan-out paid is gone), and `partial()` returns
 * fresh objects, never the internal ones.
 *
 * SDK shapes relied on (verified against the installed `.d.ts`):
 * - `message_update.assistantMessageEvent` `text_delta` / `thinking_delta`
 *   `{ contentIndex, delta }`, `thinking_end` `{ contentIndex }`
 *   (pi-ai `dist/types.d.ts:404-428`).
 * - `tool_execution_start { toolCallId, toolName, args }`,
 *   `tool_execution_update { toolCallId, toolName, args, partialResult }`,
 *   `tool_execution_end { toolCallId, toolName, result, isError }`
 *   (pi-agent-core `dist/types.d.ts:397-412`). `partialResult` is an
 *   `AgentToolResult` (`types.d.ts:317-334`) and the bash tool sends the
 *   CUMULATIVE output snapshot in it, not a delta (pi-coding-agent
 *   `dist/core/tools/bash.js:252-263`), so the accumulator diffs against the
 *   last snapshot to keep the wire record delta-only. A snapshot that does
 *   not extend the last one (the tool's own head-truncation kicked in) goes
 *   out whole with `replace: true` and replaces the rolling output here too
 *   (#507); an identical snapshot emits nothing.
 * - `bash_execution_update { id?: string; delta: string }` (pi-coding-agent
 *   `dist/core/agent-session.d.ts:102-105`) — emitted only by
 *   `AgentSession.executeBash` (operator `!` commands, `agent-session.js:2368`),
 *   which the chat session never calls (`chatSession.ts` drives `prompt()`
 *   only), so in chat this event should never fire. The routing is
 *   DEFENSIVE: `id` is the caller's optional tag, not a `toolCallId`; the
 *   delta goes to the tool block with that id when one exists, else to the
 *   most recent still-running tool block, and is dropped when no tool is
 *   running — a stray delta lands somewhere visible rather than vanishing.
 *
 * A thinking block is marked `done` on `thinking_end`, on the first text
 * delta (§1.2 row 3), and by `finish()`; whichever comes first stamps
 * `doneAt` from `now` so a late subscriber's `partial()` carries the fold
 * duration (#511).
 */
import {
  CHAT_TOOL_OUTPUT_CAP,
  CHAT_TOOL_RESULT_CAP,
  type ChatBusRecord,
  type ChatDeltaRecord,
  type ChatPartialRecord,
  type ChatToolRecord,
  type LiveBlock,
} from "./liveBlocks.js";
import { makeThinkSplitter, type SplitPiece, type ThinkSplitter } from "./thinkSplitter.js";

export interface LiveTurnOpts {
  turn: string;
  /** ms epoch; stamps `startedAt` / `doneAt` on thinking blocks. */
  now: () => number;
  thinkTags: "auto" | "on" | "off";
  /** Chars of a tool's final `result` put on the wire (default CHAT_TOOL_RESULT_CAP). */
  resultCap?: number;
  /** Chars of streamed tool `output` kept per block, tail-preserving (default CHAT_TOOL_OUTPUT_CAP). */
  outputCap?: number;
}

export interface LiveTurn {
  /** Feed one SDK event; returns the bus records to publish, in order. */
  observe(event: unknown): ChatBusRecord[];
  /** Records to flush at turn end (the splitter's held tail). */
  finish(): ChatBusRecord[];
  /** The snapshot record for a late subscriber (spec §1.1). */
  partial(): ChatPartialRecord;
  /** Per-turn counter of emitted records; the partial carries the current value. */
  readonly seq: number;
}

// -- internal block state -----------------------------------------------------

interface TextState {
  kind: "text";
  contentIndex: number;
  chunks: string[];
}
interface ThinkingState {
  kind: "thinking";
  contentIndex: number;
  chunks: string[];
  done: boolean;
  startedAt: string;
  doneAt?: string;
}
interface ToolState {
  kind: "tool";
  id: string;
  name: string;
  args: unknown;
  /** Rolling output, tail-preserving under `outputCap`. */
  chunks: string[];
  outputLen: number;
  /** Last cumulative `partialResult` text seen, to diff the next one into a delta. */
  lastSnapshot: string;
  result: string | null;
  isError: boolean;
  truncated: boolean;
  done: boolean;
}
type BlockState = TextState | ThinkingState | ToolState;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Text of a tool result's `content` blocks — mirrors `resultFromContent` in
 * `src/transcriptSummary.ts` so a live card and the summary name a non-text
 * block the same way. */
function contentText(content: unknown): string {
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
  return parts.join("\n");
}

export function makeLiveTurn(opts: LiveTurnOpts): LiveTurn {
  const { turn, now, thinkTags } = opts;
  const resultCap = opts.resultCap ?? CHAT_TOOL_RESULT_CAP;
  const outputCap = opts.outputCap ?? CHAT_TOOL_OUTPUT_CAP;

  let seq = 0;
  /** `${kind}:${contentIndex}` / `tool:${id}` → state; Map iteration is insertion order. */
  const blocks = new Map<string, BlockState>();
  let splitter: ThinkSplitter | null = null;
  let sawNative = false;
  /**
   * The SDK's `contentIndex` restarts at 0 for every assistant message, so a
   * turn with a tool call in the middle sees two "content block 0"s. Emitted
   * indices are made unique per TURN: `base` moves past the highest index
   * emitted so far on every assistant `message_start` (pi-agent-core
   * `types.d.ts:387-388`, `message.role` per pi-ai `types.d.ts:307-308`),
   * and every delta carries `base + event.contentIndex`.
   */
  let base = 0;
  let maxIndex = -1;
  const effectiveIndex = (sdkIndex: number): number => {
    const idx = base + sdkIndex;
    if (idx > maxIndex) maxIndex = idx;
    return idx;
  };
  const onMessageStart = (e: Record<string, unknown>): ChatBusRecord[] => {
    if (isRecord(e.message) && e.message.role === "assistant") base = maxIndex + 1;
    return [];
  };

  const splitting = (): boolean => thinkTags === "on" || (thinkTags === "auto" && !sawNative);

  // Two stampers rather than one generic: `Omit` over the record union keeps
  // only the common keys, so a per-kind signature is what checks the fields.
  const deltaRec = (r: Omit<ChatDeltaRecord, "type" | "turn" | "seq">): ChatDeltaRecord => ({
    type: "junco_chat_delta",
    turn,
    seq: ++seq,
    ...r,
  });
  const toolRec = (r: Omit<ChatToolRecord, "type" | "turn" | "seq">): ChatToolRecord => ({
    type: "junco_chat_tool",
    turn,
    seq: ++seq,
    ...r,
  });

  // -- text / thinking ------------------------------------------------------

  const textBlock = (contentIndex: number): TextState => {
    const key = `text:${contentIndex}`;
    let b = blocks.get(key) as TextState | undefined;
    if (!b) {
      b = { kind: "text", contentIndex, chunks: [] };
      blocks.set(key, b);
    }
    return b;
  };
  const iso = (): string => new Date(now()).toISOString();
  const thinkingBlock = (contentIndex: number): ThinkingState => {
    const key = `thinking:${contentIndex}`;
    let b = blocks.get(key) as ThinkingState | undefined;
    if (!b) {
      b = { kind: "thinking", contentIndex, chunks: [], done: false, startedAt: iso() };
      blocks.set(key, b);
    }
    return b;
  };
  /** Marks a thinking block done once; the first close owns `doneAt`. */
  const markDone = (b: ThinkingState): void => {
    if (b.done) return;
    b.done = true;
    b.doneAt = iso();
  };
  /** A text delta closes every open thinking block (spec §1.2 row 3). */
  const closeThinking = (): void => {
    for (const b of blocks.values()) if (b.kind === "thinking") markDone(b);
  };

  const pieceRecords = (pieces: SplitPiece[], contentIndex: number): ChatBusRecord[] => {
    const out: ChatBusRecord[] = [];
    for (const p of pieces) {
      if (p.delta === "") continue;
      if (p.kind === "thinking") {
        thinkingBlock(contentIndex).chunks.push(p.delta);
      } else {
        closeThinking();
        textBlock(contentIndex).chunks.push(p.delta);
      }
      out.push(deltaRec({ kind: p.kind, contentIndex, delta: p.delta }));
    }
    return out;
  };

  /** Index of the text block the splitter is currently feeding; its held tail
   * belongs to that block when flushed. */
  let splitIndex = 0;
  const flushSplitter = (): ChatBusRecord[] => {
    if (!splitter) return [];
    const pieces = splitter.end();
    return pieceRecords(pieces, splitIndex);
  };

  const onTextDelta = (delta: string, contentIndex: number): ChatBusRecord[] => {
    if (delta === "") return [];
    if (!splitting()) {
      // `auto` flipped to raw after native reasoning arrived: release anything
      // the splitter still holds before passing text straight through.
      const flushed = flushSplitter();
      splitter = null;
      return [...flushed, ...pieceRecords([{ kind: "text", delta }], contentIndex)];
    }
    const out: ChatBusRecord[] = [];
    if (splitter && splitIndex !== contentIndex) out.push(...flushSplitter());
    splitter ??= makeThinkSplitter();
    splitIndex = contentIndex;
    out.push(...pieceRecords(splitter.push(delta), contentIndex));
    return out;
  };

  const onThinkingDelta = (delta: string, contentIndex: number): ChatBusRecord[] => {
    sawNative = true;
    if (delta === "") return [];
    thinkingBlock(contentIndex).chunks.push(delta);
    return [deltaRec({ kind: "thinking", contentIndex, delta })];
  };

  const onMessageUpdate = (e: Record<string, unknown>): ChatBusRecord[] => {
    const ame = e.assistantMessageEvent;
    if (!isRecord(ame)) return [];
    const sdkIndex = num(ame.contentIndex);
    if (sdkIndex === null) return [];
    const contentIndex = effectiveIndex(sdkIndex);
    switch (ame.type) {
      case "text_delta": {
        const delta = str(ame.delta);
        return delta === null ? [] : onTextDelta(delta, contentIndex);
      }
      case "thinking_delta": {
        const delta = str(ame.delta);
        return delta === null ? [] : onThinkingDelta(delta, contentIndex);
      }
      case "thinking_end": {
        const b = blocks.get(`thinking:${contentIndex}`);
        if (b && b.kind === "thinking") markDone(b);
        return [];
      }
      default:
        return [];
    }
  };

  // -- tools ----------------------------------------------------------------

  const toolBlock = (id: string, name: string | null, args: unknown): ToolState => {
    const key = `tool:${id}`;
    let b = blocks.get(key) as ToolState | undefined;
    if (!b) {
      b = {
        kind: "tool",
        id,
        name: name ?? "",
        args,
        chunks: [],
        outputLen: 0,
        lastSnapshot: "",
        result: null,
        isError: false,
        truncated: false,
        done: false,
      };
      blocks.set(key, b);
    }
    return b;
  };

  /** Drop from the head of the rolling output until it fits `outputCap`. */
  const trimOutput = (b: ToolState): void => {
    while (b.outputLen > outputCap) {
      const over = b.outputLen - outputCap;
      const head = b.chunks[0]!;
      b.truncated = true;
      if (head.length <= over) {
        b.chunks.shift();
        b.outputLen -= head.length;
      } else {
        b.chunks[0] = head.slice(over);
        b.outputLen -= over;
      }
    }
  };

  /** Append a delta to the rolling output, dropping from the head past `outputCap`. */
  const appendOutput = (b: ToolState, delta: string): ChatBusRecord[] => {
    if (delta === "") return [];
    b.chunks.push(delta);
    b.outputLen += delta.length;
    trimOutput(b);
    return [toolRec({ id: b.id, phase: "output", output: delta })];
  };

  /** Replace the rolling output with a whole snapshot (#507); the wire record
   * says `replace: true` so the client overwrites instead of appending. The
   * snapshot is the new head, so `truncated` restarts from it. */
  const replaceOutput = (b: ToolState, snapshot: string): ChatBusRecord[] => {
    b.chunks = [snapshot];
    b.outputLen = snapshot.length;
    b.truncated = false;
    trimOutput(b);
    return [toolRec({ id: b.id, phase: "output", output: snapshot, replace: true })];
  };

  const lastOpenTool = (): ToolState | null => {
    let found: ToolState | null = null;
    for (const b of blocks.values()) if (b.kind === "tool" && !b.done) found = b;
    return found;
  };

  const onToolStart = (e: Record<string, unknown>): ChatBusRecord[] => {
    const id = str(e.toolCallId);
    if (id === null) return [];
    const name = str(e.toolName);
    const b = toolBlock(id, name, e.args);
    if (name !== null) b.name = name;
    b.args = e.args;
    return [toolRec({ id, phase: "start", name: b.name, args: b.args })];
  };

  const onToolUpdate = (e: Record<string, unknown>): ChatBusRecord[] => {
    const id = str(e.toolCallId);
    if (id === null || !isRecord(e.partialResult)) return [];
    const b = toolBlock(id, str(e.toolName), e.args);
    const snapshot = contentText(e.partialResult.content);
    // Cumulative snapshot → suffix delta (an identical one is an empty delta,
    // nothing emitted). One that does not extend the last (the tool's own
    // head-truncation kicked in) replaces, so the client never doubles the
    // prefix (#507).
    const extends_ = snapshot.startsWith(b.lastSnapshot);
    const last = b.lastSnapshot;
    b.lastSnapshot = snapshot;
    return extends_ ? appendOutput(b, snapshot.slice(last.length)) : replaceOutput(b, snapshot);
  };

  const onBashUpdate = (e: Record<string, unknown>): ChatBusRecord[] => {
    const delta = str(e.delta);
    if (delta === null) return [];
    const id = str(e.id);
    const byId = id === null ? undefined : blocks.get(`tool:${id}`);
    const b = byId && byId.kind === "tool" ? byId : lastOpenTool();
    return b ? appendOutput(b, delta) : [];
  };

  const onToolEnd = (e: Record<string, unknown>): ChatBusRecord[] => {
    const id = str(e.toolCallId);
    if (id === null) return [];
    const b = toolBlock(id, str(e.toolName), e.args);
    const full = contentText(isRecord(e.result) ? e.result.content : e.result);
    const cut = full.length > resultCap;
    b.result = cut ? full.slice(0, resultCap) : full;
    b.isError = e.isError === true;
    if (cut) b.truncated = true;
    b.done = true;
    return [
      toolRec({
        id,
        phase: "end",
        result: b.result,
        isError: b.isError,
        truncated: cut,
      }),
    ];
  };

  // -- public surface -------------------------------------------------------

  const observe = (event: unknown): ChatBusRecord[] => {
    if (!isRecord(event)) return [];
    switch (event.type) {
      case "message_start":
        return onMessageStart(event);
      case "message_update":
        return onMessageUpdate(event);
      case "tool_execution_start":
        return onToolStart(event);
      case "tool_execution_update":
        return onToolUpdate(event);
      case "bash_execution_update":
        return onBashUpdate(event);
      case "tool_execution_end":
        return onToolEnd(event);
      default:
        return [];
    }
  };

  const finish = (): ChatBusRecord[] => {
    const out = flushSplitter();
    splitter = null;
    closeThinking();
    return out;
  };

  const partial = (): ChatPartialRecord => {
    const out: LiveBlock[] = [];
    for (const b of blocks.values()) {
      switch (b.kind) {
        case "text":
          out.push({ kind: "text", contentIndex: b.contentIndex, text: b.chunks.join("") });
          break;
        case "thinking":
          out.push({
            kind: "thinking",
            contentIndex: b.contentIndex,
            text: b.chunks.join(""),
            done: b.done,
            startedAt: b.startedAt,
            ...(b.doneAt === undefined ? {} : { doneAt: b.doneAt }),
          });
          break;
        case "tool":
          out.push({
            kind: "tool",
            id: b.id,
            name: b.name,
            args: b.args,
            output: b.chunks.join(""),
            result: b.result,
            isError: b.isError,
            truncated: b.truncated,
            done: b.done,
          });
          break;
      }
    }
    return { type: "junco_chat_partial", turn, seq, blocks: out };
  };

  return {
    observe,
    finish,
    partial,
    get seq() {
      return seq;
    },
  };
}
