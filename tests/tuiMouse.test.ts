import { describe, it, expect } from "vitest";
import { MOUSE_DISABLE, MOUSE_ENABLE, isMouseInput, parseMouse } from "../src/tui/mouse.js";

describe("parseMouse", () => {
  it("parses a left-button press to 0-based coords", () => {
    expect(parseMouse("\u001b[<0;30;4M")).toEqual([{ kind: "press", x: 29, y: 3 }]);
  });
  it("parses release (lowercase m)", () => {
    expect(parseMouse("\u001b[<0;30;4m")).toEqual([{ kind: "release", x: 29, y: 3 }]);
  });
  it("parses wheel up/down (64/65), with modifier bits", () => {
    expect(parseMouse("\u001b[<64;10;5M")).toEqual([{ kind: "wheelUp", x: 9, y: 4 }]);
    expect(parseMouse("\u001b[<65;10;5M")).toEqual([{ kind: "wheelDown", x: 9, y: 4 }]);
    expect(parseMouse("\u001b[<69;10;5M")).toEqual([{ kind: "wheelDown", x: 9, y: 4 }]); // shift+wheel
  });
  it("drops right/middle buttons and motion events", () => {
    expect(parseMouse("\u001b[<1;5;5M")).toEqual([]); // middle
    expect(parseMouse("\u001b[<2;5;5M")).toEqual([]); // right
    expect(parseMouse("\u001b[<32;5;5M")).toEqual([]); // motion/drag
  });
  it("handles several events in one chunk and ignores junk around them", () => {
    expect(parseMouse("x\u001b[<0;1;1M\u001b[<0;2;2Mgarbage")).toHaveLength(2);
  });
  it("never throws on malformed input", () => {
    expect(parseMouse("\u001b[<0;1M")).toEqual([]);
    expect(parseMouse("")).toEqual([]);
  });
});

describe("isMouseInput", () => {
  it("matches the ESC-stripped leak shape ink hands to useInput", () => {
    expect(isMouseInput("[<0;30;4M")).toBe(true);
    expect(isMouseInput("[<65;10;5m")).toBe(true);
    expect(isMouseInput("hello")).toBe(false);
    expect(isMouseInput("[")).toBe(false);
  });
});

describe("enable/disable", () => {
  it("uses DECSET 1000 (click+wheel) + 1006 (SGR)", () => {
    expect(MOUSE_ENABLE).toBe("\u001b[?1000;1006h");
    expect(MOUSE_DISABLE).toBe("\u001b[?1000;1006l");
  });
});
