import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ReviewView, type ReviewState } from "../src/tui/components/ReviewView.js";

const BATCH = {
  id: "assess-x-1",
  nwo: "o/r",
  external: true,
  autoPlan: false,
  repoPath: "/x",
  createdAt: "2026-07-09T00:00:00.000Z",
  findings: [
    {
      fingerprint: "f1",
      kind: "code",
      severity: "high",
      ruleId: "R",
      title: "SQL injection",
      description: "",
      references: [],
    },
    {
      fingerprint: "f2",
      kind: "code",
      severity: "low",
      ruleId: "R",
      title: "stale dep",
      description: "",
      references: [],
    },
  ],
};
function state(over: Partial<ReviewState>): ReviewState {
  return { loading: false, error: null, batches: [BATCH as never], cursor: 0, open: null, ...over };
}

describe("ReviewView", () => {
  it("batch-list mode lists batches with nwo + count", () => {
    const { lastFrame } = render(<ReviewView state={state({})} height={20} focused />);
    expect(lastFrame()).toContain("o/r");
    expect(lastFrame()).toContain("2"); // finding count
  });
  it("checklist mode shows findings with check glyphs and severity", () => {
    const s = state({ open: { batchIdx: 0, findingCursor: 0, checked: new Set(["f1"]) } });
    const frame = render(<ReviewView state={s} height={20} focused />).lastFrame() ?? "";
    expect(frame).toContain("SQL injection");
    expect(frame).toContain("stale dep");
    expect(frame).toMatch(/\[x\].*SQL injection/); // f1 checked
    expect(frame).toMatch(/\[ \].*stale dep/); // f2 unchecked
  });
  it("empty state renders a hint", () => {
    expect(
      render(
        <ReviewView state={state({ batches: [], cursor: 0 })} height={20} focused />,
      ).lastFrame(),
    ).toContain("no pending");
  });
});
