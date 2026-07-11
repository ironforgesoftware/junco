import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ReviewView, type ReviewState } from "../src/tui/components/ReviewView.js";
import type { PendingComment } from "../src/commentReview.js";

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

const DRAFT: PendingComment = {
  id: "analyze-o-r-5",
  nwo: "o/r",
  issue: 5,
  issueTitle: "Broken build",
  external: false,
  repoPath: "/x",
  createdAt: "2026-07-09T00:00:00.000Z",
  draft: "This is the analysis.\nSecond line.",
  footer: true,
};

// 10 distinct lines, no footer — long enough that the preview window (rows -
// 2 = 6 lines at height 10) can't show it all, so scrolling is observable.
const LONG_DRAFT: PendingComment = {
  ...DRAFT,
  footer: false,
  draft: Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"),
};

function state(over: Partial<ReviewState>): ReviewState {
  return {
    loading: false,
    error: null,
    batches: [BATCH as never],
    drafts: [],
    cursor: 0,
    open: null,
    ...over,
  };
}

describe("ReviewView", () => {
  it("batch-list mode lists batches with nwo + count", () => {
    const { lastFrame } = render(<ReviewView state={state({})} height={20} focused />);
    expect(lastFrame()).toContain("o/r");
    expect(lastFrame()).toContain("2"); // finding count
  });
  it("checklist mode shows findings with check glyphs and severity", () => {
    const s = state({
      open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set(["f1"]) },
    });
    const frame = render(<ReviewView state={s} height={20} focused />).lastFrame() ?? "";
    expect(frame).toContain("SQL injection");
    expect(frame).toContain("stale dep");
    expect(frame).toMatch(/\[x\].*SQL injection/); // f1 checked
    expect(frame).toMatch(/\[ \].*stale dep/); // f2 unchecked
  });
  it("empty state renders a hint", () => {
    expect(
      render(
        <ReviewView state={state({ batches: [], drafts: [], cursor: 0 })} height={20} focused />,
      ).lastFrame(),
    ).toContain("no pending");
  });

  it("list mode renders a draft row with a comment badge and nwo#issue", () => {
    const s = state({ batches: [], drafts: [DRAFT], cursor: 0 });
    const frame = render(<ReviewView state={s} height={20} focused />).lastFrame() ?? "";
    expect(frame).toContain("o/r#5");
    expect(frame).toContain("comment"); // badge column
    expect(frame).toContain("This is the analysis."); // first non-empty draft line
  });

  it("draft-row comment badge is right-aligned, after the flexing preview text — matching the batch rows' far-right count column", () => {
    const s = state({ batches: [], drafts: [DRAFT], cursor: 0 });
    const frame = render(<ReviewView state={s} height={20} focused />).lastFrame() ?? "";
    const previewIdx = frame.indexOf("This is the analysis.");
    const badgeIdx = frame.indexOf("comment");
    expect(previewIdx).toBeGreaterThan(-1);
    expect(badgeIdx).toBeGreaterThan(previewIdx);
  });

  it("draft preview renders the header, body, and dimmed footer line when footer:true", () => {
    const s = state({
      batches: [],
      drafts: [DRAFT],
      cursor: 0,
      open: { kind: "draft", draftIdx: 0, scroll: 0 },
    });
    const frame = render(<ReviewView state={s} height={20} focused />).lastFrame() ?? "";
    expect(frame).toContain("o/r#5");
    expect(frame).toContain("Broken build"); // issueTitle in header
    expect(frame).toContain("owned"); // external|owned in header
    expect(frame).toContain("This is the analysis.");
    expect(frame).toContain("Second line.");
    expect(frame).toContain("Analysis drafted with"); // ANALYSIS_FOOTER
    expect(frame).toContain("post"); // hint row
  });

  it("draft preview scroll is top-anchored: one keypress (scroll+1) moves the window by exactly one line", () => {
    const base = { batches: [], drafts: [LONG_DRAFT], cursor: 0 };
    const atZero =
      render(
        <ReviewView
          state={state({ ...base, open: { kind: "draft", draftIdx: 0, scroll: 0 } })}
          height={10}
          focused
        />,
      ).lastFrame() ?? "";
    const atOne =
      render(
        <ReviewView
          state={state({ ...base, open: { kind: "draft", draftIdx: 0, scroll: 1 } })}
          height={10}
          focused
        />,
      ).lastFrame() ?? "";
    // height=10 → rows=8, no footer → bodyRows=6: scroll=0 shows line-0..line-5.
    expect(atZero).toContain("line-0");
    expect(atZero).not.toContain("line-6");
    // A cursor-centering window would leave this unchanged (dead-zone) until
    // scroll passed rows/2; top-anchored moves it after a single keypress.
    expect(atOne).not.toContain("line-0");
    expect(atOne).toContain("line-6");
  });

  it("draft preview omits the footer line when footer:false", () => {
    const s = state({
      batches: [],
      drafts: [{ ...DRAFT, footer: false }],
      cursor: 0,
      open: { kind: "draft", draftIdx: 0, scroll: 0 },
    });
    const frame = render(<ReviewView state={s} height={20} focused />).lastFrame() ?? "";
    expect(frame).toContain("This is the analysis.");
    expect(frame).not.toContain("Analysis drafted with");
  });

  it("combined empty state hints at drafting a comment", () => {
    const frame =
      render(
        <ReviewView state={state({ batches: [], drafts: [], cursor: 0 })} height={20} focused />,
      ).lastFrame() ?? "";
    expect(frame).toContain("draft a comment");
  });
});
