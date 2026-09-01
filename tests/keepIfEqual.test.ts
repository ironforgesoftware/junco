// tests/keepIfEqual.test.ts
import { describe, it, expect } from "vitest";
import { keepIfEqual, keepIfEqualBy, wholeMinutes } from "../src/tui/hooks/keepIfEqual.js";

describe("keepIfEqual", () => {
  it("returns the previous reference when the next value is structurally equal", () => {
    const prev = { a: 1, rows: [{ id: "x", n: null }] };
    const next = { a: 1, rows: [{ id: "x", n: null }] };
    expect(keepIfEqual(prev, next)).toBe(prev);
  });
  it("returns the next value when anything differs", () => {
    const prev = { a: 1, rows: [{ id: "x" }] };
    const next = { a: 1, rows: [{ id: "y" }] };
    expect(keepIfEqual(prev, next)).toBe(next);
  });
  it("null → value adopts the value; value → null adopts null", () => {
    const v = { a: 1 };
    expect(keepIfEqual<{ a: number } | null>(null, v)).toBe(v);
    expect(keepIfEqual<{ a: number } | null>(v, null)).toBe(null);
  });
  it("is strict: 1 vs '1' and undefined vs missing key differ", () => {
    expect(keepIfEqual<unknown>({ a: 1 }, { a: "1" })).toEqual({ a: "1" });
    expect(keepIfEqual<unknown>({ a: undefined }, {})).toEqual({});
  });
});

describe("keepIfEqualBy", () => {
  it("compares through the key: equal keys keep prev even when raw values differ", () => {
    const prev = { uptime: 61 };
    const next = { uptime: 119 };
    expect(keepIfEqualBy(prev, next, (v) => wholeMinutes(v.uptime))).toBe(prev);
  });
  it("different keys adopt next", () => {
    const prev = { uptime: 61 };
    const next = { uptime: 120 };
    expect(keepIfEqualBy(prev, next, (v) => wholeMinutes(v.uptime))).toBe(next);
  });
});

describe("wholeMinutes", () => {
  it("floors to minutes and passes null through", () => {
    expect(wholeMinutes(0)).toBe(0);
    expect(wholeMinutes(59)).toBe(0);
    expect(wholeMinutes(60)).toBe(1);
    expect(wholeMinutes(4242)).toBe(70);
    expect(wholeMinutes(null)).toBe(null);
  });
});
