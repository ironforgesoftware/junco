import { describe, it, expect } from "vitest";
import {
  makeThinkSplitter,
  splitThinkingText,
  type SplitPiece,
} from "../src/chat/thinkSplitter.js";

/** Coalesce adjacent same-kind pieces so chunking is invisible to assertions. */
function join(pieces: SplitPiece[]): SplitPiece[] {
  const out: SplitPiece[] = [];
  for (const p of pieces) {
    if (p.delta === "") continue;
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.delta += p.delta;
    else out.push({ ...p });
  }
  return out;
}
function run(chunks: string[]): SplitPiece[] {
  const s = makeThinkSplitter();
  return join([...chunks.flatMap((c) => s.push(c)), ...s.end()]);
}
/** Every way to cut `s` into `n` chunks. */
function* cuts(s: string, n: number, from = 0): Generator<string[]> {
  if (n === 1) {
    yield [s.slice(from)];
    return;
  }
  for (let i = from + 1; i <= s.length - (n - 1); i++)
    for (const rest of cuts(s, n - 1, i)) yield [s.slice(from, i), ...rest];
}

describe("thinkSplitter (spec 2026-09-06 §2.1)", () => {
  it("splits a whole-string tag pair and trims the block's edges", () => {
    expect(run(["<think>\n plan \n</think>answer"])).toEqual([
      { kind: "thinking", delta: "plan" },
      { kind: "text", delta: "answer" },
    ]);
  });
  it("is chunk-invariant: any 3-way cut of a tagged string yields the same pieces", () => {
    const s = "pre<think>abc</think>post";
    const want = run([s]);
    for (const c of cuts(s, 3)) expect(run(c)).toEqual(want);
  });
  it("is chunk-invariant with whitespace at the block edges", () => {
    const s = "p<think> \na b \n</think>q";
    const want = run([s]);
    expect(want).toEqual([
      { kind: "text", delta: "p" },
      { kind: "thinking", delta: "a b" },
      { kind: "text", delta: "q" },
    ]);
    for (const c of cuts(s, 3)) expect(run(c)).toEqual(want);
  });
  it("releases a false prefix as text", () => {
    expect(run(["<thin", "k you"])).toEqual([{ kind: "text", delta: "<think you" }]);
  });
  it("leaves an unclosed block as thinking at end()", () => {
    expect(run(["<think>cut off"])).toEqual([{ kind: "thinking", delta: "cut off" }]);
  });
  it("passes a bare close tag through as text", () => {
    expect(run(["a</think>b"])).toEqual([{ kind: "text", delta: "a</think>b" }]);
  });
  it("does not nest: a second open inside a block is thinking text", () => {
    expect(run(["<think>a<think>b</think>c"])).toEqual([
      { kind: "thinking", delta: "a<think>b" },
      { kind: "text", delta: "c" },
    ]);
  });
  it("reports sawTag", () => {
    const s = makeThinkSplitter();
    s.push("plain");
    expect(s.sawTag).toBe(false);
    s.push("<think>");
    expect(s.sawTag).toBe(true);
  });
  describe("the newline after a close tag (#509)", () => {
    it("swallows exactly one `\\n` directly after a close tag", () => {
      expect(run(["a<think>b</think>\nc"])).toEqual([
        { kind: "text", delta: "a" },
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: "c" },
      ]);
    });
    it("swallows exactly one `\\r\\n` directly after a close tag", () => {
      expect(run(["a<think>b</think>\r\nc"])).toEqual([
        { kind: "text", delta: "a" },
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: "c" },
      ]);
    });
    it("two newlines keep one", () => {
      expect(run(["<think>b</think>\n\nc"])).toEqual([
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: "\nc" },
      ]);
      expect(run(["<think>b</think>\r\n\r\nc"])).toEqual([
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: "\r\nc" },
      ]);
    });
    it("no newline: the text after the tag is unchanged", () => {
      expect(run(["<think>b</think> c"])).toEqual([
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: " c" },
      ]);
    });
    it("is chunk-invariant: every 2/3/4-way cut of a tag-then-newline string agrees", () => {
      for (const s of ["a<think>b</think>\nc", "a<think>b</think>\r\nc"]) {
        const want = run([s]);
        expect(want).toEqual([
          { kind: "text", delta: "a" },
          { kind: "thinking", delta: "b" },
          { kind: "text", delta: "c" },
        ]);
        for (const n of [2, 3, 4]) for (const c of cuts(s, n)) expect(run(c)).toEqual(want);
      }
    });
    it("holds across a chunk ending exactly at the close tag", () => {
      expect(run(["<think>b</think>", "\nc"])).toEqual([
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: "c" },
      ]);
      expect(run(["<think>b</think>", "\r", "\nc"])).toEqual([
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: "c" },
      ]);
      // A lone `\r` that turns out not to be `\r\n` is released as text.
      expect(run(["<think>b</think>", "\r", "c"])).toEqual([
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: "\rc" },
      ]);
    });
    it("end() releases nothing for the held position", () => {
      expect(run(["<think>b</think>"])).toEqual([{ kind: "thinking", delta: "b" }]);
      expect(run(["<think>b</think>", "\n"])).toEqual([{ kind: "thinking", delta: "b" }]);
      expect(run(["<think>b</think>", "\r"])).toEqual([
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: "\r" },
      ]);
    });
    it("swallows only directly after a close tag, never elsewhere", () => {
      expect(run(["a\n<think>b</think>c\n"])).toEqual([
        { kind: "text", delta: "a\n" },
        { kind: "thinking", delta: "b" },
        { kind: "text", delta: "c\n" },
      ]);
      // A bare close tag is text, so its newline is text too.
      expect(run(["a</think>\nb"])).toEqual([{ kind: "text", delta: "a</think>\nb" }]);
      expect(run(["\n"])).toEqual([{ kind: "text", delta: "\n" }]);
    });
    it("release of the swallowed newline does not leak into a following tag pair", () => {
      expect(run(["<think>a</think>\n<think>b</think>\nc"])).toEqual([
        { kind: "thinking", delta: "ab" },
        { kind: "text", delta: "c" },
      ]);
    });
  });

  it("honours custom tags", () => {
    const s = makeThinkSplitter({ open: "<reasoning>", close: "</reasoning>" });
    const got = join([...s.push("<reasoning>r</reasoning>t<think>x</think>"), ...s.end()]);
    expect(got).toEqual([
      { kind: "thinking", delta: "r" },
      { kind: "text", delta: "t<think>x</think>" },
    ]);
  });
});

describe("splitThinkingText (non-streaming, Task 12)", () => {
  it("splits a finished turn's text into thinking and text", () => {
    expect(splitThinkingText("<think>\nplan\n</think>\nanswer")).toEqual({
      thinking: "plan",
      text: "answer",
    });
  });
  it("inherits the one-newline swallow after the close tag (#509)", () => {
    expect(splitThinkingText("<think>p</think>\r\nanswer").text).toBe("answer");
    expect(splitThinkingText("<think>p</think>\n\nanswer").text).toBe("\nanswer");
    expect(splitThinkingText("<think>p</think>answer").text).toBe("answer");
    expect(splitThinkingText("<think>p</think>").text).toBe("");
  });
  it("returns null thinking when there is no tag", () => {
    expect(splitThinkingText("plain a</think>b")).toEqual({
      thinking: null,
      text: "plain a</think>b",
    });
  });
});
