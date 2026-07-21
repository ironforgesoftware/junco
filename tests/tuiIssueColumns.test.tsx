import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { IssueList } from "../src/tui/components/IssueList.js";
import { MAX_STATE_BADGE_LEN, isBotAuthored } from "../src/tui/state.js";
import { listRowsHeight } from "../src/tui/geometry.js";
import type { DashIssue } from "../src/tui/state.js";
import { makeDashIssue } from "./helpers/dashFixtures.js";

const issues: DashIssue[] = [
  makeDashIssue({
    number: 7,
    title: "short",
    labels: [],
    updatedAt: "2026-07-20T11:00:00Z",
    url: "u",
  }),
  makeDashIssue({
    number: 123,
    title: "longer title",
    labels: [],
    updatedAt: "2026-07-20T10:00:00Z",
    url: "u",
  }),
];

const props = {
  issues,
  trigger: "junco",
  selected: 0,
  focused: true,
  refreshing: false,
  filter: "",
  filtering: false,
  height: 20,
  // 30m past the brief's literal 12:00 so issue #7 (updated 11:00) is 90m old
  // → relTime's hour bucket ("1h"), not the minute bucket's boundary "60m"
  // (relTime(60m) === "60m" is pinned by tests/tuiIssueList.test.tsx).
  now: new Date("2026-07-20T12:30:00Z"),
  staleAt: null,
  window: { start: 0, end: 2 },
};

describe("columnar IssueList", () => {
  it("renders a header strip with column labels", () => {
    const { lastFrame } = render(<IssueList {...props} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("title");
    expect(f).toContain("state");
    expect(f).toContain("age");
  });
  it("badge column width derives from the meta table", () => {
    expect(MAX_STATE_BADGE_LEN).toBeGreaterThanOrEqual("plan-ready".length);
  });
  it("age cells render inside the fixed right column", () => {
    const { lastFrame } = render(<IssueList {...props} />);
    // pane is bordered — the age cell sits just inside the right border
    expect(lastFrame()).toMatch(/1h\s*│/);
  });
  it("listRowsHeight budgets the header strip", () => {
    expect(listRowsHeight(20)).toBe(15);
  });
  it("truncates 5+-digit issue numbers to preserve row height", () => {
    const largeIssues: DashIssue[] = [
      {
        number: 123456,
        title: "large id",
        labels: [],
        updatedAt: "2026-07-20T11:00:00Z",
        url: "u",
        author: null,
      },
    ];
    const { lastFrame: smallFrame } = render(
      <IssueList {...props} issues={[issues[0]]} window={{ start: 0, end: 1 }} />,
    );
    const { lastFrame: largeFrame } = render(
      <IssueList {...props} issues={largeIssues} window={{ start: 0, end: 1 }} />,
    );
    const smallLines = (smallFrame() ?? "").split("\n").length;
    const largeLines = (largeFrame() ?? "").split("\n").length;
    expect(largeLines).toBe(smallLines);
    expect(largeFrame()).toMatch(/…3456/);
  });
});

describe("isBotAuthored", () => {
  it("true only when author matches botLogin exactly", () => {
    expect(isBotAuthored("junco-bot", "junco-bot")).toBe(true);
  });
  it("false on null author, undefined author, or a mismatch", () => {
    expect(isBotAuthored(null, "junco-bot")).toBe(false);
    expect(isBotAuthored(undefined, "junco-bot")).toBe(false);
    expect(isBotAuthored("human", "junco-bot")).toBe(false);
  });
  it("false when botLogin itself is null or undefined", () => {
    expect(isBotAuthored("junco-bot", null)).toBe(false);
    expect(isBotAuthored("junco-bot", undefined)).toBe(false);
  });
});

describe("bot-authored row rendering", () => {
  it("renders without crashing when botLogin is set on a mix of authors", () => {
    const withAuthors = issues.map((i, idx) => ({
      ...i,
      author: idx === 0 ? "junco-bot" : "human",
    }));
    const { lastFrame } = render(
      <IssueList {...props} issues={withAuthors} botLogin="junco-bot" selected={1} />,
    );
    expect(lastFrame()).toContain("title");
  });
});
