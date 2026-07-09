import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { IssueList, relTime, relTimeShort } from "../src/tui/components/IssueList.js";
import { filterIssues, type DashIssue } from "../src/tui/state.js";
import { windowSlice } from "../src/tui/window.js";
import { listRowsHeight } from "../src/tui/geometry.js";

const NOW = new Date("2026-07-07T14:00:00Z");
const iss = (number: number, title: string, labels: string[] = ["junco"]): DashIssue => ({
  number,
  title,
  labels,
  updatedAt: "2026-07-07T13:00:00Z",
  url: `https://github.com/a/b/issues/${number}`,
});

describe("filterIssues", () => {
  const list = [
    iss(52, "Fix reef colors", ["junco", "junco:plan-ready"]),
    iss(61, "Add tide tables"),
  ];
  it("matches number, title, and badge, case-insensitively", () => {
    expect(filterIssues(list, "#52", "junco").map((i) => i.number)).toEqual([52]);
    expect(filterIssues(list, "TIDE", "junco").map((i) => i.number)).toEqual([61]);
    expect(filterIssues(list, "plan-ready", "junco").map((i) => i.number)).toEqual([52]);
  });
  it("empty query returns the input unchanged", () => {
    expect(filterIssues(list, "  ", "junco")).toBe(list);
  });
});

describe("relTime", () => {
  it("buckets minutes/hours/days", () => {
    expect(relTime("2026-07-07T13:59:40Z", NOW)).toBe("now");
    expect(relTime("2026-07-07T13:00:00Z", NOW)).toBe("60m");
    expect(relTime("2026-07-06T14:00:00Z", NOW)).toBe("24h");
    expect(relTime("2026-07-04T14:00:00Z", NOW)).toBe("3d");
  });
});

describe("relTimeShort", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  it("seconds tier below one minute, then defers to relTime tiers", () => {
    expect(relTimeShort("2026-07-08T11:59:48Z", now)).toBe("12s");
    expect(relTimeShort("2026-07-08T11:59:01Z", now)).toBe("59s");
    expect(relTimeShort("2026-07-08T11:59:00Z", now)).toBe("1m");
    expect(relTimeShort("2026-07-08T09:00:00Z", now)).toBe("3h"); // relTime's hour tier
    expect(relTimeShort("2026-07-06T12:00:00Z", now)).toBe("2d"); // 48h → relTime's day tier
  });
  it("clamps future timestamps to 0s (poll clock races fetch clock)", () => {
    expect(relTimeShort("2026-07-08T12:00:05Z", now)).toBe("0s");
  });
});

describe("IssueList", () => {
  const three = [
    iss(52, "Fix reef colors", ["junco", "junco:plan-ready"]),
    iss(46, "Bleaching alert", ["junco", "junco:working"]),
    iss(61, "Add tide tables"),
  ];
  it("numbered title with count, selection bar, badges, reltime", () => {
    const f = render(
      <IssueList
        issues={three}
        trigger="junco"
        selected={0}
        focused={true}
        refreshing={false}
        filter=""
        filtering={false}
        height={20}
        now={NOW}
        staleAt={null}
        window={{ start: 0, end: three.length }}
      />,
    ).lastFrame()!;
    expect(f).toContain("2 issues · 3");
    expect(f).toContain("▌");
    expect(f).toContain("#52");
    expect(f).toContain("plan-ready");
    expect(f).toContain("60m");
    expect(f).not.toContain("offline ·");
  });
  it("staleAt renders an offline badge with the cached-at clock time; null hides it", () => {
    const f = render(
      <IssueList
        issues={three}
        trigger="junco"
        selected={0}
        focused={true}
        refreshing={false}
        filter=""
        filtering={false}
        height={20}
        now={NOW}
        staleAt="2026-07-07T14:00:00Z"
        window={{ start: 0, end: three.length }}
      />,
    ).lastFrame()!;
    expect(f).toContain("offline ·");
    expect(f).toMatch(/offline · \d{2}:\d{2}/);
  });
  it("filter chip renders in the title while active", () => {
    const f = render(
      <IssueList
        issues={[three[0]]}
        trigger="junco"
        selected={0}
        focused={true}
        refreshing={false}
        filter="reef"
        filtering={true}
        height={20}
        now={NOW}
        staleAt={null}
        window={{ start: 0, end: 1 }}
      />,
    ).lastFrame()!;
    expect(f).toContain("/reef");
  });
  it("no-match filter empty state names the query and the way out", () => {
    const f = render(
      <IssueList
        issues={[]}
        trigger="junco"
        selected={0}
        focused={true}
        refreshing={false}
        filter="zzz"
        filtering={false}
        height={20}
        now={NOW}
        staleAt={null}
        window={{ start: 0, end: 0 }}
      />,
    ).lastFrame()!;
    expect(f).toContain("no issues match /zzz");
    expect(f).toContain("esc");
  });
  it("windows to height with a position indicator", () => {
    const many = Array.from({ length: 40 }, (_, i) => iss(i + 1, `Issue number ${i + 1}`));
    const f = render(
      <IssueList
        issues={many}
        trigger="junco"
        selected={39}
        focused={true}
        refreshing={false}
        filter=""
        filtering={false}
        height={12}
        now={NOW}
        staleAt={null}
        window={windowSlice(many.length, listRowsHeight(12), 39, 0)}
      />,
    ).lastFrame()!;
    expect(f).toContain("Issue number 40");
    expect(f).not.toContain("Issue number 1 "); // note trailing space — #1's row, not #10+
    expect(f).toContain("40/40");
  });
});
