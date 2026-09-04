// tests/tuiTheme.test.ts — the footer's segment → colour mapping (spec
// 2026-09-02 §3.4). Frames carry no ANSI off a TTY (chalk's level is 0), so
// this pure mapping is the only place a test can see what the renderer paints.
import { describe, it, expect } from "vitest";
import { theme, segmentColors } from "../src/tui/theme.js";
import { footerSegments, type FooterChip } from "../src/tui/footerModel.js";

const seg = (chip: FooterChip, i = 0) => footerSegments(chip)[i]!;

describe("segmentColors (#465: neither pair leans on the terminal's default fg)", () => {
  it("a keycap states BOTH halves — a dark slate fill can no longer carry dark default text", () => {
    const keycap = seg({
      kind: "structural",
      id: "enter",
      key: "enter",
      label: "preview",
      charIndex: null,
      guarded: false,
    });
    expect(keycap.keycap).toBe(true);
    expect(segmentColors(keycap)).toEqual({
      color: theme.keycapFg,
      backgroundColor: theme.keycapBg,
    });
  });
  it("a pill states both halves too, as it always did", () => {
    const pill = seg({
      kind: "pill",
      id: "chat",
      key: "c",
      label: "chat",
      charIndex: 0,
      guarded: false,
    });
    expect(segmentColors(pill)).toEqual({ color: theme.pillFg, backgroundColor: theme.accent });
  });
  it("an accented mnemonic letter colours the text only; plain text takes neither", () => {
    const chip: FooterChip = {
      kind: "mnemonic",
      id: "refresh",
      key: "r",
      label: "refresh",
      charIndex: 0,
      guarded: false,
    };
    expect(segmentColors(seg(chip, 0))).toEqual({ color: theme.accent });
    expect(segmentColors(seg(chip, 1))).toEqual({});
  });
  it("the two explicit foregrounds sit on the opposite side of their fill", () => {
    // keycapFg is light on a dark fill, pillFg dark on the accent — stated,
    // not inherited, so a light terminal theme renders both the same way.
    expect(theme.keycapFg).not.toBe(theme.keycapBg);
    expect(theme.pillFg).not.toBe(theme.accent);
  });
});
