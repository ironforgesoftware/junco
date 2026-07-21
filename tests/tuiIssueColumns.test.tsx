import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { IssueList } from "../src/tui/components/IssueList.js";
import { MAX_STATE_BADGE_LEN } from "../src/tui/state.js";
import { listRowsHeight } from "../src/tui/geometry.js";
import type { DashIssue } from "../src/tui/state.js";

const issues: DashIssue[] = [
  { number: 7, title: "short", labels: [], updatedAt: "2026-07-20T11:00:00Z", url: "u" },
  { number: 123, title: "longer title", labels: [], updatedAt: "2026-07-20T10:00:00Z", url: "u" },
] as DashIssue[];

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
      },
    ] as DashIssue[];
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
