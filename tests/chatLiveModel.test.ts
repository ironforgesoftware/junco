import { describe, it, expect } from "vitest";
import {
  applyLiveRecord,
  startLiveTurn,
  CHAT_TOOL_OUTPUT_CAP,
  CHAT_TOOL_RESULT_CAP,
  type LiveBlock,
  type LiveTurnState,
} from "../src/chat/liveBlocks.js";
import { chatDelta, chatPartial, chatTool, chatTurnStart } from "./helpers/transcriptFixtures.js";

/** The reducer is fed PARSED records (the SSE client already split and parsed lines). */
const rec = (line: string): unknown => JSON.parse(line) as unknown;
const NOW = () => "2026-09-06T10:00:00.000Z";

function apply(state: LiveTurnState | null, ...lines: string[]): LiveTurnState | null {
  let s = state;
  for (const line of lines) s = applyLiveRecord(s, rec(line), NOW);
  return s;
}
const nonNull = (s: LiveTurnState | null): LiveTurnState => {
  if (s === null) throw new Error("expected a live state");
  return s;
};

describe("startLiveTurn", () => {
  it("returns an empty state scoped to the turn", () => {
    const s = startLiveTurn("t7");
    expect(s).toEqual({ turn: "t7", seq: 0, blocks: [], expanded: new Set(), dropped: 0 });
  });
  it("is what the caller builds from junco_chat_turn_start (turn ?? ts)", () => {
    const start = rec(chatTurnStart({ turn: "t9" })) as { turn: string; ts: string };
    expect(startLiveTurn(start.turn ?? start.ts).turn).toBe("t9");
  });
});

describe("applyLiveRecord: text and thinking deltas (spec 2026-09-06 §3.2)", () => {
  it("appends consecutive deltas to the (kind, contentIndex) block", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatDelta({ seq: 1, delta: "hel" }),
        chatDelta({ seq: 2, delta: "lo" }),
      ),
    );
    expect(s.blocks).toEqual([{ kind: "text", contentIndex: 0, text: "hello" }]);
    expect(s.seq).toBe(2);
    expect(s.dropped).toBe(0);
  });
  it("creates blocks in contentIndex order regardless of arrival order", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatDelta({ seq: 1, contentIndex: 2, delta: "c" }),
        chatDelta({ seq: 2, contentIndex: 0, delta: "a" }),
        chatDelta({ seq: 3, contentIndex: 1, delta: "b" }),
        chatDelta({ seq: 4, contentIndex: 0, delta: "a2" }),
      ),
    );
    expect(
      s.blocks.map((b) => (b.kind === "tool" ? b.name : `${b.contentIndex}:${b.text}`)),
    ).toEqual(["0:aa2", "1:b", "2:c"]);
  });
  it("orders thinking before text at an equal contentIndex", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatDelta({ seq: 1, kind: "text", contentIndex: 0, delta: "answer" }),
        chatDelta({ seq: 2, kind: "thinking", contentIndex: 0, delta: "plan" }),
      ),
    );
    expect(s.blocks.map((b) => b.kind)).toEqual(["thinking", "text"]);
  });
  it("a thinking block starts open, stamped with startedAt from the injected clock", () => {
    const s = nonNull(
      apply(startLiveTurn("t1"), chatDelta({ seq: 1, kind: "thinking", delta: "p" })),
    );
    expect(s.blocks).toEqual([
      { kind: "thinking", contentIndex: 0, text: "p", done: false, startedAt: NOW() },
    ]);
  });
  it("a text delta marks every open thinking block done (belt and braces)", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatDelta({ seq: 1, kind: "thinking", contentIndex: 0, delta: "plan" }),
        chatDelta({ seq: 2, kind: "text", contentIndex: 1, delta: "answer" }),
      ),
    );
    expect(s.blocks).toEqual([
      { kind: "thinking", contentIndex: 0, text: "plan", done: true, startedAt: NOW() },
      { kind: "text", contentIndex: 1, text: "answer" },
    ]);
  });
  it("a thinking delta does not close an open thinking block", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatDelta({ seq: 1, kind: "thinking", delta: "a" }),
        chatDelta({ seq: 2, kind: "thinking", delta: "b" }),
      ),
    );
    expect(s.blocks[0]).toMatchObject({ kind: "thinking", text: "ab", done: false });
  });
});

describe("applyLiveRecord: seq dedupe and turn scoping", () => {
  it("drops a delta with seq <= state.seq and returns the SAME object", () => {
    const s1 = nonNull(apply(startLiveTurn("t1"), chatDelta({ seq: 2, delta: "x" })));
    const s2 = applyLiveRecord(s1, rec(chatDelta({ seq: 2, delta: "dup" })), NOW);
    const s3 = applyLiveRecord(s1, rec(chatDelta({ seq: 1, delta: "old" })), NOW);
    expect(s2).toBe(s1);
    expect(s3).toBe(s1);
    expect(s1.blocks).toEqual([{ kind: "text", contentIndex: 0, text: "x" }]);
  });
  it("dedupes against the seq a partial installed", () => {
    const s = nonNull(
      apply(
        null,
        chatPartial({ seq: 5, blocks: [{ kind: "text", contentIndex: 0, text: "snap" }] }),
        chatDelta({ seq: 5, delta: "-dup" }),
        chatDelta({ seq: 3, delta: "-old" }),
        chatDelta({ seq: 6, delta: "-new" }),
      ),
    );
    expect(s.blocks).toEqual([{ kind: "text", contentIndex: 0, text: "snap-new" }]);
    expect(s.seq).toBe(6);
  });
  it("drops a delta for another turn and returns the same object", () => {
    const s1 = startLiveTurn("t1");
    const s2 = applyLiveRecord(s1, rec(chatDelta({ turn: "t2", seq: 1, delta: "x" })), NOW);
    expect(s2).toBe(s1);
  });
  it("drops a delta when there is no live state", () => {
    expect(applyLiveRecord(null, rec(chatDelta({ seq: 1 })), NOW)).toBeNull();
  });
  it("drops a tool record for another turn or a stale seq", () => {
    const s1 = nonNull(apply(startLiveTurn("t1"), chatTool({ seq: 3, phase: "start" })));
    expect(applyLiveRecord(s1, rec(chatTool({ turn: "t2", seq: 4, phase: "start" })), NOW)).toBe(
      s1,
    );
    expect(
      applyLiveRecord(s1, rec(chatTool({ seq: 3, phase: "output", output: "late" })), NOW),
    ).toBe(s1);
  });
});

describe("applyLiveRecord: junco_chat_partial replaces wholesale", () => {
  const blocks: LiveBlock[] = [
    { kind: "thinking", contentIndex: 0, text: "p", done: true, startedAt: NOW() },
    { kind: "text", contentIndex: 1, text: "snap" },
  ];
  it("replaces blocks and seq when the turn matches, keeping expanded and dropped", () => {
    const s0: LiveTurnState = {
      ...nonNull(apply(startLiveTurn("t1"), chatDelta({ seq: 1, delta: "stale" }))),
      expanded: new Set(["c1"]),
      dropped: 2,
    };
    const s = nonNull(apply(s0, chatPartial({ turn: "t1", seq: 9, blocks })));
    expect(s.blocks).toEqual(blocks);
    expect(s.seq).toBe(9);
    expect(s.turn).toBe("t1");
    expect(s.expanded).toEqual(new Set(["c1"]));
    expect(s.dropped).toBe(2);
    expect(s0.blocks[0]).toEqual({ kind: "text", contentIndex: 0, text: "stale" });
  });
  it("starts a state from a partial when there is none", () => {
    const s = nonNull(apply(null, chatPartial({ turn: "t3", seq: 4, blocks })));
    expect(s).toEqual({ turn: "t3", seq: 4, blocks, expanded: new Set(), dropped: 0 });
  });
  it("starts a fresh state when the partial names a different turn", () => {
    const s0: LiveTurnState = { ...startLiveTurn("t1"), expanded: new Set(["c1"]), dropped: 3 };
    const s = nonNull(apply(s0, chatPartial({ turn: "t2", seq: 1, blocks })));
    expect(s).toEqual({ turn: "t2", seq: 1, blocks, expanded: new Set(), dropped: 0 });
  });
});

describe("applyLiveRecord: junco_chat_tool phases", () => {
  it("start creates a tool block in arrival order after existing blocks", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatDelta({ seq: 1, delta: "let me look" }),
        chatTool({ seq: 2, id: "c1", phase: "start", name: "read", args: { path: "a" } }),
      ),
    );
    expect(s.blocks[1]).toEqual({
      kind: "tool",
      id: "c1",
      name: "read",
      args: { path: "a" },
      output: "",
      result: null,
      isError: false,
      truncated: false,
      done: false,
    });
    expect(s.seq).toBe(2);
  });
  it("output appends to the tool block by id", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatTool({ seq: 1, phase: "start" }),
        chatTool({ seq: 2, phase: "output", output: "line1\n" }),
        chatTool({ seq: 3, phase: "output", output: "line2\n" }),
      ),
    );
    expect(s.blocks[0]).toMatchObject({ kind: "tool", output: "line1\nline2\n", done: false });
  });
  it("output is a rolling cap: drops from the head at CHAT_TOOL_OUTPUT_CAP and flags truncated", () => {
    const head = "H".repeat(CHAT_TOOL_OUTPUT_CAP - 10);
    const tail = "T".repeat(20);
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatTool({ seq: 1, phase: "start" }),
        chatTool({ seq: 2, phase: "output", output: head }),
        chatTool({ seq: 3, phase: "output", output: tail }),
      ),
    );
    const b = s.blocks[0];
    if (b?.kind !== "tool") throw new Error("expected a tool block");
    expect(b.output.length).toBe(CHAT_TOOL_OUTPUT_CAP);
    expect(b.output.endsWith(tail)).toBe(true);
    expect(b.output.startsWith("H")).toBe(true);
    expect(b.truncated).toBe(true);
  });
  it("end sets result/isError/done and honours the daemon's truncated flag", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatTool({ seq: 1, phase: "start" }),
        chatTool({ seq: 2, phase: "end", result: "ok", isError: true, truncated: true }),
      ),
    );
    expect(s.blocks[0]).toMatchObject({
      kind: "tool",
      result: "ok",
      isError: true,
      truncated: true,
      done: true,
    });
  });
  it("end caps result at CHAT_TOOL_RESULT_CAP and marks truncated", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatTool({ seq: 1, phase: "start" }),
        chatTool({ seq: 2, phase: "end", result: "R".repeat(CHAT_TOOL_RESULT_CAP + 5) }),
      ),
    );
    const b = s.blocks[0];
    if (b?.kind !== "tool") throw new Error("expected a tool block");
    expect(b.result?.length).toBe(CHAT_TOOL_RESULT_CAP);
    expect(b.truncated).toBe(true);
    expect(b.done).toBe(true);
  });
  it("end without a result leaves result null (done, not an error)", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatTool({ seq: 1, phase: "start" }),
        chatTool({ seq: 2, phase: "end" }),
      ),
    );
    expect(s.blocks[0]).toMatchObject({ result: null, isError: false, done: true });
  });
  it("output/end for an unknown tool id is counted as dropped, not applied", () => {
    const s0 = nonNull(apply(startLiveTurn("t1"), chatTool({ seq: 1, phase: "start", id: "c1" })));
    const s = nonNull(apply(s0, chatTool({ seq: 2, phase: "output", id: "zz", output: "x" })));
    expect(s.blocks).toEqual(s0.blocks);
    expect(s.dropped).toBe(1);
    expect(s.seq).toBe(2);
  });
  it("a tool start does not close an open thinking block; only text does", () => {
    const s = nonNull(
      apply(
        startLiveTurn("t1"),
        chatDelta({ seq: 1, kind: "thinking", delta: "p" }),
        chatTool({ seq: 2, phase: "start" }),
      ),
    );
    expect(s.blocks[0]).toMatchObject({ kind: "thinking", done: false });
  });
});

describe("applyLiveRecord: malformed records and purity", () => {
  it("counts a malformed record as dropped on a NEW object with everything else unchanged", () => {
    const s0 = nonNull(apply(startLiveTurn("t1"), chatDelta({ seq: 1, delta: "x" })));
    for (const bad of [
      { type: "junco_chat_delta", turn: "t1", seq: 2 }, // no kind/delta
      { type: "junco_chat_delta", turn: "t1", seq: "2", kind: "text", contentIndex: 0, delta: "y" },
      { type: "junco_chat_tool", turn: "t1", seq: 2, id: "c1", phase: "explode" },
      { type: "junco_chat_partial", turn: "t1", seq: 2, blocks: "nope" },
      { type: "junco_chat_partial", turn: "t1", seq: 2, blocks: [{ kind: "text" }] },
      { type: "junco_chat_delta" },
      "a string",
      null,
      42,
    ]) {
      const s = nonNull(applyLiveRecord(s0, bad, NOW));
      expect(s).not.toBe(s0);
      expect(s.dropped).toBe(1);
      expect(s.seq).toBe(1);
      expect(s.blocks).toBe(s0.blocks);
      expect(s.turn).toBe("t1");
      expect(s.expanded).toBe(s0.expanded);
    }
  });
  it("a malformed record with no live state leaves it null", () => {
    expect(applyLiveRecord(null, { type: "junco_chat_delta" }, NOW)).toBeNull();
  });
  it("ignores records that are not live-turn records (same object)", () => {
    const s0 = startLiveTurn("t1");
    expect(applyLiveRecord(s0, rec(chatTurnStart()), NOW)).toBe(s0);
    expect(applyLiveRecord(s0, { type: "junco_chat_turn_end" }, NOW)).toBe(s0);
    expect(applyLiveRecord(s0, { type: "message_end" }, NOW)).toBe(s0);
  });
  it("never mutates the input state: untouched blocks keep identity, the changed one is new", () => {
    const s0 = nonNull(
      apply(
        startLiveTurn("t1"),
        chatDelta({ seq: 1, contentIndex: 0, delta: "a" }),
        chatDelta({ seq: 2, contentIndex: 1, delta: "b" }),
      ),
    );
    const frozenBlocks = s0.blocks;
    const frozen0 = s0.blocks[0];
    const s1 = nonNull(apply(s0, chatDelta({ seq: 3, contentIndex: 1, delta: "b2" })));
    expect(s0.blocks).toBe(frozenBlocks);
    expect(s0.blocks[1]).toEqual({ kind: "text", contentIndex: 1, text: "b" });
    expect(s1.blocks).not.toBe(frozenBlocks);
    expect(s1.blocks[0]).toBe(frozen0);
    expect(s1.blocks[1]).toEqual({ kind: "text", contentIndex: 1, text: "bb2" });
  });
});
