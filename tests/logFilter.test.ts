import { describe, it, expect } from "vitest";
import { filterEntries, distinctTickets, cycleLevel, levelRank } from "../src/tui/logFilter.js";
import type { LogEntry } from "../src/logReader.js";

const e = (o: Partial<LogEntry>): LogEntry => ({
  ts: null,
  level: "info",
  ticket: null,
  msg: "",
  fields: {},
  raw: "",
  ...o,
});

describe("levelRank / cycleLevel", () => {
  it("ranks null as info and orders debug<info<warn<error", () => {
    expect(levelRank(null)).toBe(levelRank("info"));
    expect(levelRank("debug")).toBeLessThan(levelRank("warn"));
    expect(levelRank("error")).toBeGreaterThan(levelRank("warn"));
  });
  it("cycles debug→info→warn→error→debug", () => {
    expect((["debug", "info", "warn", "error"] as const).map(cycleLevel)).toEqual([
      "info",
      "warn",
      "error",
      "debug",
    ]);
  });
});

describe("filterEntries", () => {
  const es = [
    e({ level: "debug", msg: "d" }),
    e({ level: "info", ticket: "junco-46", msg: "claimed" }),
    e({ level: "warn", ticket: "junco-46", msg: "guard nudge", fields: { action: "nudge" } }),
    e({ level: "error", ticket: "junco-47", msg: "push failed" }),
    e({ level: null, msg: "raw crash" }),
  ];
  it("applies a level threshold (null counts as info)", () => {
    expect(
      filterEntries(es, { minLevel: "warn", ticket: null, search: "" }).map((x) => x.msg),
    ).toEqual(["guard nudge", "push failed"]);
  });
  it("filters by ticket", () => {
    expect(
      filterEntries(es, { minLevel: "debug", ticket: "junco-46", search: "" }).map((x) => x.msg),
    ).toEqual(["claimed", "guard nudge"]);
  });
  it("substring-searches msg, ticket, and fields case-insensitively", () => {
    expect(
      filterEntries(es, { minLevel: "debug", ticket: null, search: "NUDGE" }).map((x) => x.msg),
    ).toEqual(["guard nudge"]);
    expect(
      filterEntries(es, { minLevel: "debug", ticket: null, search: "junco-47" }).map((x) => x.msg),
    ).toEqual(["push failed"]);
  });
});

describe("distinctTickets", () => {
  it("returns sorted unique non-null tickets", () => {
    expect(
      distinctTickets([
        e({ ticket: "b" }),
        e({ ticket: null }),
        e({ ticket: "a" }),
        e({ ticket: "b" }),
      ]),
    ).toEqual(["a", "b"]);
  });
});
