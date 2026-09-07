import { describe, it, expect } from "vitest";
import { makeLiveTurn, type LiveTurnOpts } from "../src/chat/liveTurn.js";
import type { ChatBusRecord, ChatDeltaRecord, ChatToolRecord } from "../src/chat/liveBlocks.js";
import { CHAT_TOOL_OUTPUT_CAP, CHAT_TOOL_RESULT_CAP } from "../src/chat/liveBlocks.js";
import { j, msgUpdate, toolEndId, toolStartId } from "./helpers/transcriptFixtures.js";

// -- local SDK builders (event objects, not lines) ---------------------------

const ev = (line: string): unknown => JSON.parse(line);
const text = (delta: string, contentIndex = 0): unknown =>
  ev(msgUpdate("text_delta", delta, contentIndex));
const think = (delta: string, contentIndex = 0): unknown =>
  ev(msgUpdate("thinking_delta", delta, contentIndex));
/** message_update / thinking_end (pi-ai types.d.ts:427-428: `contentIndex` only). */
const thinkEnd = (contentIndex = 0): unknown =>
  ev(j({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex } }));
/** tool_execution_update (pi-agent-core types.d.ts:402-406): `partialResult` is an
 * AgentToolResult whose `content` is the CUMULATIVE output so far (bash.js:252-263). */
const toolUpdate = (id: string, name: string, cumulative: string): unknown =>
  ev(
    j({
      type: "tool_execution_update",
      toolCallId: id,
      toolName: name,
      args: {},
      partialResult: { content: [{ type: "text", text: cumulative }], details: undefined },
    }),
  );
/** bash_execution_update (agent-session.d.ts:102-105): `{ id?: string; delta: string }`. */
const bashUpdate = (delta: string, id?: string): unknown =>
  ev(j({ type: "bash_execution_update", ...(id === undefined ? {} : { id }), delta }));

const opts = (over: Partial<LiveTurnOpts> = {}): LiveTurnOpts => ({
  turn: "t1",
  now: () => 1_700_000_000_000,
  thinkTags: "on",
  ...over,
});

const deltas = (recs: ChatBusRecord[]): ChatDeltaRecord[] =>
  recs.filter((r): r is ChatDeltaRecord => r.type === "junco_chat_delta");
const tools = (recs: ChatBusRecord[]): ChatToolRecord[] =>
  recs.filter((r): r is ChatToolRecord => r.type === "junco_chat_tool");
/** Coalesce adjacent same-kind/same-index deltas so chunking is invisible. */
const joined = (recs: ChatBusRecord[]): { kind: string; contentIndex: number; delta: string }[] => {
  const out: { kind: string; contentIndex: number; delta: string }[] = [];
  for (const d of deltas(recs)) {
    const last = out[out.length - 1];
    if (last && last.kind === d.kind && last.contentIndex === d.contentIndex) last.delta += d.delta;
    else out.push({ kind: d.kind, contentIndex: d.contentIndex, delta: d.delta });
  }
  return out;
};

describe("liveTurn (spec 2026-09-06 §1.2, §2.3)", () => {
  it("text-only turn: one delta per chunk, contentIndex and turn preserved", () => {
    const lt = makeLiveTurn(opts());
    const r1 = lt.observe(text("Hel", 0));
    const r2 = lt.observe(text("lo", 0));
    const r3 = lt.observe(text("!", 2));
    expect(r1).toEqual([
      { type: "junco_chat_delta", turn: "t1", seq: 1, kind: "text", contentIndex: 0, delta: "Hel" },
    ]);
    expect(r2).toEqual([
      { type: "junco_chat_delta", turn: "t1", seq: 2, kind: "text", contentIndex: 0, delta: "lo" },
    ]);
    expect(r3).toEqual([
      { type: "junco_chat_delta", turn: "t1", seq: 3, kind: "text", contentIndex: 2, delta: "!" },
    ]);
    expect(lt.finish()).toEqual([]);
    expect(lt.partial()).toEqual({
      type: "junco_chat_partial",
      turn: "t1",
      seq: 3,
      blocks: [
        { kind: "text", contentIndex: 0, text: "Hello" },
        { kind: "text", contentIndex: 2, text: "!" },
      ],
    });
  });

  it("tag turn under `on`: thinking then text pieces; partial() shows the thinking block done once text starts", () => {
    const lt = makeLiveTurn(opts({ thinkTags: "on", now: () => Date.UTC(2026, 8, 6, 12, 0, 0) }));
    const all: ChatBusRecord[] = [];
    all.push(...lt.observe(text("<think>\nplan", 0)));
    // Still inside the block: thinking-only so far, not done.
    const p1 = lt.partial();
    expect(p1.blocks).toEqual([
      {
        kind: "thinking",
        contentIndex: 0,
        text: "plan",
        done: false,
        startedAt: "2026-09-06T12:00:00.000Z",
      },
    ]);
    all.push(...lt.observe(text(" more\n</think>ans", 0)));
    all.push(...lt.observe(text("wer", 0)));
    all.push(...lt.finish());
    expect(joined(all)).toEqual([
      { kind: "thinking", contentIndex: 0, delta: "plan more" },
      { kind: "text", contentIndex: 0, delta: "answer" },
    ]);
    const p2 = lt.partial();
    expect(p2.blocks).toEqual([
      {
        kind: "thinking",
        contentIndex: 0,
        text: "plan more",
        done: true,
        startedAt: "2026-09-06T12:00:00.000Z",
      },
      { kind: "text", contentIndex: 0, text: "answer" },
    ]);
    // Tags never reach the wire.
    for (const d of deltas(all)) expect(d.delta).not.toMatch(/<\/?think>/);
  });

  it("finish() flushes the splitter's held tail", () => {
    const lt = makeLiveTurn(opts({ thinkTags: "on" }));
    expect(lt.observe(text("hello <thin", 0))).toEqual([
      {
        type: "junco_chat_delta",
        turn: "t1",
        seq: 1,
        kind: "text",
        contentIndex: 0,
        delta: "hello ",
      },
    ]);
    expect(lt.partial().blocks).toEqual([{ kind: "text", contentIndex: 0, text: "hello " }]);
    expect(lt.finish()).toEqual([
      {
        type: "junco_chat_delta",
        turn: "t1",
        seq: 2,
        kind: "text",
        contentIndex: 0,
        delta: "<thin",
      },
    ]);
    expect(lt.partial().blocks).toEqual([{ kind: "text", contentIndex: 0, text: "hello <thin" }]);
  });

  it("finish() leaves an unclosed tag block as thinking", () => {
    const lt = makeLiveTurn(opts({ thinkTags: "on" }));
    const all = [...lt.observe(text("<think>cut off", 0)), ...lt.finish()];
    expect(joined(all)).toEqual([{ kind: "thinking", contentIndex: 0, delta: "cut off" }]);
  });

  it("`auto`: native thinking_delta disables the split even if later text contains <think>", () => {
    const lt = makeLiveTurn(opts({ thinkTags: "auto" }));
    const all: ChatBusRecord[] = [];
    all.push(...lt.observe(think("reason", 0)));
    all.push(...lt.observe(thinkEnd(0)));
    all.push(...lt.observe(text("say <think>literal</think> ok", 1)));
    all.push(...lt.finish());
    expect(joined(all)).toEqual([
      { kind: "thinking", contentIndex: 0, delta: "reason" },
      { kind: "text", contentIndex: 1, delta: "say <think>literal</think> ok" },
    ]);
    const blocks = lt.partial().blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      kind: "thinking",
      contentIndex: 0,
      text: "reason",
      done: true,
    });
    expect(blocks[1]).toEqual({
      kind: "text",
      contentIndex: 1,
      text: "say <think>literal</think> ok",
    });
  });

  it("`auto` without native thinking splits tags like `on`", () => {
    const lt = makeLiveTurn(opts({ thinkTags: "auto" }));
    const all = [...lt.observe(text("<think>a</think>b", 0)), ...lt.finish()];
    expect(joined(all)).toEqual([
      { kind: "thinking", contentIndex: 0, delta: "a" },
      { kind: "text", contentIndex: 0, delta: "b" },
    ]);
  });

  it("`off` never splits", () => {
    const lt = makeLiveTurn(opts({ thinkTags: "off" }));
    const all = [...lt.observe(text("<think>a</think>b", 0)), ...lt.finish()];
    expect(joined(all)).toEqual([{ kind: "text", contentIndex: 0, delta: "<think>a</think>b" }]);
    expect(lt.partial().blocks).toEqual([
      { kind: "text", contentIndex: 0, text: "<think>a</think>b" },
    ]);
  });

  it("native thinking: thinking_end marks the block done; a text delta while open also does", () => {
    const a = makeLiveTurn(opts({ thinkTags: "auto" }));
    a.observe(think("r", 0));
    expect(a.partial().blocks[0]).toMatchObject({ kind: "thinking", done: false });
    expect(a.observe(thinkEnd(0))).toEqual([]);
    expect(a.partial().blocks[0]).toMatchObject({ kind: "thinking", done: true });

    const b = makeLiveTurn(opts({ thinkTags: "auto" }));
    b.observe(think("r", 0));
    b.observe(text("t", 1));
    expect(b.partial().blocks).toEqual([
      expect.objectContaining({ kind: "thinking", contentIndex: 0, done: true }),
      { kind: "text", contentIndex: 1, text: "t" },
    ]);
  });

  it("tool lifecycle: start / cumulative partialResult → delta output / end with result", () => {
    const lt = makeLiveTurn(opts());
    const s = lt.observe(ev(toolStartId("c1", "bash", { command: "ls" })));
    expect(s).toEqual([
      {
        type: "junco_chat_tool",
        turn: "t1",
        seq: 1,
        id: "c1",
        phase: "start",
        name: "bash",
        args: { command: "ls" },
      },
    ]);
    // bash.js sends the cumulative snapshot each time; only the suffix crosses the wire.
    expect(lt.observe(toolUpdate("c1", "bash", ""))).toEqual([]);
    expect(lt.observe(toolUpdate("c1", "bash", "a\n"))).toEqual([
      { type: "junco_chat_tool", turn: "t1", seq: 2, id: "c1", phase: "output", output: "a\n" },
    ]);
    expect(lt.observe(toolUpdate("c1", "bash", "a\nb\n"))).toEqual([
      { type: "junco_chat_tool", turn: "t1", seq: 3, id: "c1", phase: "output", output: "b\n" },
    ]);
    // An identical snapshot is not re-sent.
    expect(lt.observe(toolUpdate("c1", "bash", "a\nb\n"))).toEqual([]);
    expect(lt.partial().blocks).toEqual([
      {
        kind: "tool",
        id: "c1",
        name: "bash",
        args: { command: "ls" },
        output: "a\nb\n",
        result: null,
        isError: false,
        truncated: false,
        done: false,
      },
    ]);
    expect(lt.observe(ev(toolEndId("c1", "bash", "a\nb\n", false)))).toEqual([
      {
        type: "junco_chat_tool",
        turn: "t1",
        seq: 4,
        id: "c1",
        phase: "end",
        result: "a\nb\n",
        isError: false,
        truncated: false,
      },
    ]);
    expect(lt.partial().blocks[0]).toMatchObject({
      kind: "tool",
      result: "a\nb\n",
      done: true,
      isError: false,
    });
  });

  it("tool end: isError flows through and a non-text content block is named, not dropped", () => {
    const lt = makeLiveTurn(opts());
    lt.observe(ev(toolStartId("c1", "read", { path: "x" })));
    const end = ev(
      j({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "read",
        result: { content: [{ type: "image", data: "..." }] },
        isError: true,
      }),
    );
    expect(tools(lt.observe(end))[0]).toMatchObject({
      phase: "end",
      result: "[image block]",
      isError: true,
    });
    expect(lt.partial().blocks[0]).toMatchObject({ isError: true, done: true });
  });

  it("bash_execution_update: `delta` appends to the running tool by id, else the open tool", () => {
    const lt = makeLiveTurn(opts());
    lt.observe(ev(toolStartId("c1", "bash", { command: "ls" })));
    expect(lt.observe(bashUpdate("x", "c1"))).toEqual([
      { type: "junco_chat_tool", turn: "t1", seq: 2, id: "c1", phase: "output", output: "x" },
    ]);
    expect(lt.observe(bashUpdate("y"))).toEqual([
      { type: "junco_chat_tool", turn: "t1", seq: 3, id: "c1", phase: "output", output: "y" },
    ]);
    expect(lt.observe(bashUpdate(""))).toEqual([]);
    expect(lt.partial().blocks[0]).toMatchObject({ kind: "tool", output: "xy" });
    // No open tool → nothing to attach to.
    lt.observe(ev(toolEndId("c1", "bash", "xy")));
    expect(lt.observe(bashUpdate("z"))).toEqual([]);
    expect(lt.partial().blocks[0]).toMatchObject({ output: "xy" });
  });

  it("output cap: the rolling output drops from the head and flags truncated", () => {
    const lt = makeLiveTurn(opts({ outputCap: 10 }));
    lt.observe(ev(toolStartId("c1", "bash", {})));
    lt.observe(bashUpdate("0123456", "c1"));
    expect(lt.partial().blocks[0]).toMatchObject({ output: "0123456", truncated: false });
    const r = lt.observe(bashUpdate("789abcd", "c1"));
    // The wire record is still delta-only.
    expect(tools(r)[0]).toMatchObject({ phase: "output", output: "789abcd" });
    // "0123456789abcd" (14 chars) → the last 10.
    expect(lt.partial().blocks[0]).toMatchObject({ output: "456789abcd", truncated: true });
    expect((lt.partial().blocks[0] as { output: string }).output).toHaveLength(10);
    // A single oversized delta keeps only its tail.
    lt.observe(bashUpdate("ABCDEFGHIJKLMNOP", "c1"));
    expect(lt.partial().blocks[0]).toMatchObject({ output: "GHIJKLMNOP", truncated: true });
  });

  it("output cap default is CHAT_TOOL_OUTPUT_CAP", () => {
    const lt = makeLiveTurn(opts());
    lt.observe(ev(toolStartId("c1", "bash", {})));
    lt.observe(bashUpdate("x".repeat(CHAT_TOOL_OUTPUT_CAP), "c1"));
    expect(lt.partial().blocks[0]).toMatchObject({ truncated: false });
    lt.observe(bashUpdate("y", "c1"));
    const b = lt.partial().blocks[0] as { output: string; truncated: boolean };
    expect(b.truncated).toBe(true);
    expect(b.output).toHaveLength(CHAT_TOOL_OUTPUT_CAP);
    expect(b.output.endsWith("y")).toBe(true);
  });

  it("result cap: the end record's result is cut and flagged; the block keeps the cut copy", () => {
    const lt = makeLiveTurn(opts({ resultCap: 5 }));
    lt.observe(ev(toolStartId("c1", "read", {})));
    const r = tools(lt.observe(ev(toolEndId("c1", "read", "0123456789"))))[0];
    expect(r).toMatchObject({ phase: "end", result: "01234", truncated: true, isError: false });
    expect(lt.partial().blocks[0]).toMatchObject({ result: "01234", truncated: true, done: true });
    // An exact-cap result is not flagged.
    const lt2 = makeLiveTurn(opts({ resultCap: 5 }));
    lt2.observe(ev(toolStartId("c1", "read", {})));
    expect(tools(lt2.observe(ev(toolEndId("c1", "read", "01234"))))[0]).toMatchObject({
      result: "01234",
      truncated: false,
    });
  });

  it("result cap default is CHAT_TOOL_RESULT_CAP", () => {
    const lt = makeLiveTurn(opts());
    lt.observe(ev(toolStartId("c1", "read", {})));
    const r = tools(
      lt.observe(ev(toolEndId("c1", "read", "x".repeat(CHAT_TOOL_RESULT_CAP + 1)))),
    )[0];
    expect(r.truncated).toBe(true);
    expect(r.result).toHaveLength(CHAT_TOOL_RESULT_CAP);
  });

  it("tool end without a start still yields a block and an end record", () => {
    const lt = makeLiveTurn(opts());
    const r = lt.observe(ev(toolEndId("c9", "grep", "hit")));
    expect(tools(r)[0]).toMatchObject({ id: "c9", phase: "end", result: "hit" });
    expect(lt.partial().blocks).toEqual([
      expect.objectContaining({ kind: "tool", id: "c9", name: "grep", result: "hit", done: true }),
    ]);
  });

  it("seq is monotonic across record kinds and carried by partial()", () => {
    const lt = makeLiveTurn(opts({ thinkTags: "on" }));
    expect(lt.seq).toBe(0);
    expect(lt.partial().seq).toBe(0);
    const all: ChatBusRecord[] = [];
    all.push(...lt.observe(text("<think>a</think>b", 0)));
    all.push(...lt.observe(ev(toolStartId("c1", "bash", {}))));
    all.push(...lt.observe(bashUpdate("o", "c1")));
    all.push(...lt.observe(ev(toolEndId("c1", "bash", "o"))));
    all.push(...lt.observe(text("c", 1)));
    all.push(...lt.finish());
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all.map((r) => r.seq)).toEqual(all.map((_, i) => i + 1));
    expect(lt.seq).toBe(all.length);
    expect(lt.partial().seq).toBe(all.length);
    for (const r of all) expect(r.turn).toBe("t1");
  });

  it("contentIndex is unique per turn: a post-tool message restarting at 0 gets a fresh block", () => {
    // The SDK's contentIndex restarts at 0 for every assistant message
    // (message_start: pi-agent-core types.d.ts:387-388).
    const lt = makeLiveTurn(opts({ thinkTags: "on" }));
    const msgStart = (role = "assistant"): unknown =>
      ev(j({ type: "message_start", message: { role, content: [] } }));
    expect(lt.observe(msgStart())).toEqual([]);
    lt.observe(text("first", 0));
    lt.observe(ev(toolStartId("c1", "bash", {})));
    lt.observe(ev(toolEndId("c1", "bash", "out")));
    // A non-assistant message_start (a tool result) does not move the base.
    expect(lt.observe(msgStart("toolResult"))).toEqual([]);
    expect(lt.observe(msgStart())).toEqual([]);
    const r = lt.observe(text("second", 0));
    expect(r).toEqual([
      {
        type: "junco_chat_delta",
        turn: "t1",
        seq: 4,
        kind: "text",
        contentIndex: 1,
        delta: "second",
      },
    ]);
    lt.finish();
    expect(lt.partial().blocks).toEqual([
      { kind: "text", contentIndex: 0, text: "first" },
      expect.objectContaining({ kind: "tool", id: "c1", done: true }),
      { kind: "text", contentIndex: 1, text: "second" },
    ]);
  });

  it("the base skips past the highest index seen, not the block count", () => {
    const lt = makeLiveTurn(opts({ thinkTags: "auto" }));
    lt.observe(think("r", 0));
    lt.observe(text("a", 2));
    lt.observe(ev(toolStartId("c1", "read", {})));
    lt.observe(ev(toolEndId("c1", "read", "x")));
    lt.observe(ev(j({ type: "message_start", message: { role: "assistant", content: [] } })));
    expect(deltas(lt.observe(text("b", 0)))[0]).toMatchObject({ contentIndex: 3 });
    expect(deltas(lt.observe(think("s", 1)))[0]).toMatchObject({ contentIndex: 4 });
    expect(lt.observe(thinkEnd(1))).toEqual([]);
    expect(
      lt.partial().blocks.map((b) => (b.kind === "tool" ? "tool" : `${b.kind}:${b.contentIndex}`)),
    ).toEqual(["thinking:0", "text:2", "tool", "text:3", "thinking:4"]);
    expect(lt.partial().blocks[4]).toMatchObject({ kind: "thinking", done: true });
  });

  it("blocks are kept in first-seen order across kinds", () => {
    const lt = makeLiveTurn(opts({ thinkTags: "auto" }));
    lt.observe(think("r", 0));
    lt.observe(text("a", 1));
    lt.observe(ev(toolStartId("c1", "bash", {})));
    lt.observe(text("b", 1));
    lt.observe(text("c", 2));
    expect(
      lt
        .partial()
        .blocks.map((b) => (b.kind === "tool" ? "tool:c1" : `${b.kind}:${b.contentIndex}`)),
    ).toEqual(["thinking:0", "text:1", "tool:c1", "text:2"]);
    expect(lt.partial().blocks[1]).toEqual({ kind: "text", contentIndex: 1, text: "ab" });
  });

  it("partial() returns fresh objects: mutating a snapshot does not leak into the next", () => {
    const lt = makeLiveTurn(opts());
    lt.observe(text("a", 0));
    lt.observe(ev(toolStartId("c1", "bash", { command: "ls" })));
    const p1 = lt.partial();
    (p1.blocks[0] as { text: string }).text = "MUTATED";
    (p1.blocks[1] as { output: string }).output = "MUTATED";
    p1.blocks.length = 0;
    const p2 = lt.partial();
    expect(p2.blocks).toEqual([
      { kind: "text", contentIndex: 0, text: "a" },
      expect.objectContaining({ kind: "tool", id: "c1", output: "" }),
    ]);
    expect(p2).not.toBe(p1);
    expect(p2.blocks).not.toBe(p1.blocks);
  });

  it("unknown, malformed, and non-object events → [] and no blocks", () => {
    const lt = makeLiveTurn(opts());
    for (const e of [
      ev(j({ type: "message_start", message: {} })),
      ev(j({ type: "turn_end", message: {}, toolResults: [] })),
      ev(j({ type: "agent_end" })),
      ev(
        j({
          type: "message_update",
          assistantMessageEvent: { type: "text_start", contentIndex: 0 },
        }),
      ),
      ev(
        j({
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{" },
        }),
      ),
      ev(j({ type: "message_update" })),
      ev(
        j({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: 5, contentIndex: 0 },
        }),
      ),
      ev(j({ type: "tool_execution_update", toolCallId: "c1", partialResult: null })),
      ev(j({ type: "bash_execution_update" })),
      ev(j({ type: "tool_execution_start" })),
      ev(j({ type: "junco_chat_turn_end" })),
      null,
      undefined,
      42,
      "text_delta",
      [],
    ]) {
      expect(lt.observe(e)).toEqual([]);
    }
    expect(lt.seq).toBe(0);
    expect(lt.partial().blocks).toEqual([]);
    expect(lt.finish()).toEqual([]);
  });
});
