import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { PrList } from "../src/tui/components/PrList.js";
import { MAX_PR_BADGE_LEN } from "../src/tui/prState.js";
import type { DashPr } from "../src/tui/prState.js";

const pr = (n: number, title: string): DashPr =>
  ({
    number: n,
    title,
    url: "u",
    headRefName: "junco/x",
    baseRefName: "main",
    isDraft: false,
    state: "OPEN",
    reviewDecision: null,
    mergeable: null,
    mergeStateStatus: null,
    checks: { pass: 2, fail: 0, pending: 0, total: 2 },
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T11:00:00Z",
    mergedAt: null,
    author: "junco-bot",
    labels: [],
    nwo: "acme/site",
  }) as DashPr;

const props = {
  prs: [pr(1, "one"), pr(22, "two")],
  selected: 0,
  focused: true,
  height: 20,
  now: new Date("2026-07-20T12:00:00Z"),
  staleAt: null,
  window: { start: 0, end: 2 },
};

describe("columnar PrList", () => {
  it("renders header labels incl. repo and checks (showNwo)", () => {
    const { lastFrame } = render(<PrList {...props} />);
    const f = lastFrame() ?? "";
    for (const label of ["#", "title", "repo", "checks", "state", "age"]) {
      expect(f).toContain(label);
    }
  });
  it("omits the repo column when showNwo is false", () => {
    const { lastFrame } = render(<PrList {...props} showNwo={false} />);
    expect(lastFrame()).not.toContain("repo");
  });
  it("badge width covers the longest pr badge", () => {
    expect(MAX_PR_BADGE_LEN).toBeGreaterThanOrEqual("checks-failing".length);
  });
});
