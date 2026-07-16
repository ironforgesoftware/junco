import { describe, it, expect } from "vitest";
import { theme, toastColor } from "../src/tui/theme.js";
import { windowSlice, maxScroll, clampScroll } from "../src/tui/window.js";
import { computeLayout, WIDE_COLS, MIN_COLS, MIN_ROWS, CHROME_ROWS } from "../src/tui/layout.js";

describe("theme", () => {
  it("exposes the slate & rose tokens", () => {
    expect(theme.accent).toBe("#eb6f92");
    expect(theme.selectionBg).toBe("#2a2e3a");
    expect(toastColor("error")).toBe(theme.error);
    expect(toastColor("success")).toBe(theme.success);
    expect(toastColor("info")).toBe(theme.info);
  });
});

describe("windowSlice (follow-the-cursor)", () => {
  it("shows everything when it fits", () => {
    expect(windowSlice(5, 10, 2, 0)).toEqual({ start: 0, end: 5 });
  });
  it("keeps the window still while the cursor moves inside it", () => {
    expect(windowSlice(20, 5, 6, 4)).toEqual({ start: 4, end: 9 });
  });
  it("follows the cursor down minimally", () => {
    expect(windowSlice(20, 5, 9, 4)).toEqual({ start: 5, end: 10 });
  });
  it("follows the cursor up minimally", () => {
    expect(windowSlice(20, 5, 3, 4)).toEqual({ start: 3, end: 8 });
  });
  it("clamps a stale prevStart when the list shrinks", () => {
    expect(windowSlice(6, 5, 5, 10)).toEqual({ start: 1, end: 6 });
  });
  it("degenerate inputs return empty", () => {
    expect(windowSlice(0, 5, 0, 0)).toEqual({ start: 0, end: 0 });
    expect(windowSlice(5, 0, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("maxScroll / clampScroll (bottom stop)", () => {
  it("content that fits never scrolls", () => {
    expect(maxScroll(3, 10)).toBe(0);
    expect(clampScroll(99, 3, 10)).toBe(0);
  });
  it("an exact fit never scrolls", () => {
    expect(maxScroll(10, 10)).toBe(0);
  });
  it("stops with the last row at the viewport bottom", () => {
    expect(maxScroll(20, 5)).toBe(15);
    expect(clampScroll(999, 20, 5)).toBe(15);
  });
  it("passes an in-range offset through untouched", () => {
    expect(clampScroll(7, 20, 5)).toBe(7);
  });
  it("clamps a negative offset to the top", () => {
    expect(clampScroll(-3, 20, 5)).toBe(0);
  });
  it("collapses a stale offset when the list shrinks under it", () => {
    expect(clampScroll(50, 12, 12)).toBe(0);
    expect(clampScroll(50, 14, 12)).toBe(2);
  });
  it("degenerate inputs return 0", () => {
    expect(maxScroll(0, 5)).toBe(0);
    expect(maxScroll(5, 0)).toBe(0);
    expect(clampScroll(4, 0, 5)).toBe(0);
    expect(clampScroll(4, 5, 0)).toBe(0);
  });
});

describe("computeLayout", () => {
  it("wide at ≥110 cols: rail 26, preview 40% capped 60", () => {
    const l = computeLayout(120, 30);
    expect(l).toEqual({
      mode: "wide",
      railWidth: 26,
      previewWidth: 48,
      bodyRows: 30 - CHROME_ROWS,
    });
    expect(computeLayout(200, 30).previewWidth).toBe(60); // cap
  });
  it("medium between 60 and 109 cols", () => {
    expect(computeLayout(100, 30)).toEqual({
      mode: "medium",
      railWidth: 26,
      previewWidth: 0,
      bodyRows: 27,
    });
  });
  it("tooSmall under 60 cols or 14 rows", () => {
    expect(computeLayout(MIN_COLS - 1, 30).mode).toBe("tooSmall");
    expect(computeLayout(120, MIN_ROWS - 1).mode).toBe("tooSmall");
  });
  it("boundary values are exact", () => {
    expect(computeLayout(WIDE_COLS, 14).mode).toBe("wide");
    expect(computeLayout(WIDE_COLS - 1, 14).mode).toBe("medium");
    expect(computeLayout(60, 14).mode).toBe("medium");
  });
});
