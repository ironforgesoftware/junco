import { describe, expect, it } from "vitest";
import { deriveMnemonics, type MnemonicOption } from "../src/tui/mnemonics.js";

const o = (id: string, over: Partial<MnemonicOption> = {}): MnemonicOption => ({
  id,
  label: id,
  ...over,
});
const derive = (opts: MnemonicOption[], ctx: Parameters<typeof deriveMnemonics>[1] = {}) =>
  deriveMnemonics(opts, ctx);
const byId = (r: ReturnType<typeof deriveMnemonics>, id: string) => r.find((d) => d.id === id)!;

describe("deriveMnemonics", () => {
  it("claims first letters in list order; conflicts cascade to remaining letters", () => {
    const r = derive([o("approve"), o("analyze"), o("assess")]);
    expect(byId(r, "approve")).toMatchObject({ key: "a", charIndex: 0 });
    expect(byId(r, "analyze")).toMatchObject({ key: "n", charIndex: 1 });
    // assess: a taken → s (first remaining letter); charIndex = first 's' in label
    expect(byId(r, "assess")).toMatchObject({ key: "s", charIndex: 1 });
  });

  it("word-initials outrank remaining letters for multi-word labels", () => {
    const r = derive([o("add", { label: "add" }), o("addRepo", { label: "add repo" })]);
    expect(byId(r, "addRepo")).toMatchObject({ key: "r", charIndex: 4 }); // 'r' of "repo"
  });

  it("guarded options walk the same sequence UPPERCASED", () => {
    const r = derive([o("delete", { guarded: true }), o("dispatch")]);
    expect(byId(r, "delete")).toMatchObject({ key: "D", charIndex: 0 });
    expect(byId(r, "dispatch")).toMatchObject({ key: "d", charIndex: 0 }); // case-distinct
  });

  it("reserved keys are claimed first and never derivable", () => {
    const r = derive([o("queue"), o("quit")], { reserved: new Map([["quit", "q"]]) });
    expect(byId(r, "quit")).toMatchObject({ key: "q", charIndex: 0 });
    expect(byId(r, "queue")).toMatchObject({ key: "u", charIndex: 1 }); // q reserved → u
  });

  it("a reserved key absent from its label yields charIndex null", () => {
    const r = derive([o("help")], { reserved: new Map([["help", "?"]]) });
    expect(byId(r, "help")).toMatchObject({ key: "?", charIndex: null });
  });

  it("excluded letters are skipped", () => {
    const r = derive([o("level")], { excluded: new Set(["l"]) });
    expect(byId(r, "level")).toMatchObject({ key: "e", charIndex: 1 });
  });

  it("exhaustion falls back to the first unclaimed a–z with charIndex null", () => {
    // "ab" and "ba" claim a,b; "ab" again has nothing left in-label.
    const r = derive([
      o("x1", { label: "ab" }),
      o("x2", { label: "ba" }),
      o("x3", { label: "ab" }),
    ]);
    expect(byId(r, "x3")).toMatchObject({ key: "c", charIndex: null });
  });

  it("charIndex matches case-insensitively (labels may capitalize)", () => {
    const r = derive([o("prs", { label: "PRs" })]);
    expect(byId(r, "prs")).toMatchObject({ key: "p", charIndex: 0 });
  });

  it("is deterministic and side-effect free", () => {
    const opts = [o("one"), o("two"), o("three")];
    expect(derive(opts)).toEqual(derive(opts));
  });
});
