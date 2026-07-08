import { describe, it, expect } from "vitest";
import { computeLayout } from "../src/tui/layout.js";
import { hitTest, type HitContext } from "../src/tui/hitTest.js";

// Medium: 100×30 → bodyRows 27, rail [0,26), middle [26,100), no preview.
const medium = (over: Partial<HitContext> = {}): HitContext => ({
  layout: computeLayout(100, 30),
  columns: 100,
  view: "main",
  repoCount: 2,
  listCount: 3,
  railStart: 0,
  listStart: 0,
  hasPreviewTarget: false,
  ...over,
});
// Wide: 130×30 → previewWidth min(60, 52) = 52 → preview [78, 130).
const wide = (over: Partial<HitContext> = {}): HitContext => ({
  ...medium({ hasPreviewTarget: true }),
  layout: computeLayout(130, 30),
  columns: 130,
  ...over,
});

describe("hitTest — main view", () => {
  it("chrome rows are dead: header (y=0), toast, footer", () => {
    expect(hitTest(medium(), 5, 0)).toEqual({ type: "none" });
    expect(hitTest(medium(), 5, 28)).toEqual({ type: "none" });
    expect(hitTest(medium(), 5, 29)).toEqual({ type: "none" });
  });
  it("rail rows resolve to repoRow with the window offset applied", () => {
    // body starts y=1; first content row = 1 + PANE_CONTENT_ROW = 3
    expect(hitTest(medium(), 5, 3)).toEqual({ type: "repoRow", index: 0 });
    // repoCount must cover index 5 — the clamp (repoCount - railStart) is part of the contract
    expect(hitTest(medium({ repoCount: 8, railStart: 4 }), 5, 4)).toEqual({
      type: "repoRow",
      index: 5,
    });
  });
  it("rail off-row (title/border/queue card) focuses pane 1", () => {
    expect(hitTest(medium(), 5, 1)).toEqual({ type: "pane", pane: 1 });
    expect(hitTest(medium(), 5, 6)).toEqual({ type: "pane", pane: 1 }); // below last repo (repoCount 2), inside the budget
    expect(hitTest(medium(), 5, 26)).toEqual({ type: "pane", pane: 1 }); // queue card zone
  });
  it("middle rows resolve to issueRow; off-row focuses pane 2", () => {
    expect(hitTest(medium(), 30, 3)).toEqual({ type: "issueRow", index: 0 });
    expect(hitTest(medium(), 30, 5)).toEqual({ type: "issueRow", index: 2 });
    expect(hitTest(medium(), 30, 6)).toEqual({ type: "pane", pane: 2 }); // below the 3 rows
    expect(hitTest(medium({ listCount: 0 }), 30, 3)).toEqual({ type: "pane", pane: 2 });
  });
  it("wide: preview band, link line at LINK_LINE_ROW when a card is shown", () => {
    expect(hitTest(wide(), 80, 4)).toEqual({ type: "linkLine" }); // y = 1 + 3
    expect(hitTest(wide(), 80, 6)).toEqual({ type: "pane", pane: 3 });
    expect(hitTest(wide({ hasPreviewTarget: false }), 80, 4)).toEqual({ type: "pane", pane: 3 });
  });
  it("medium: no preview band — x up to the right edge is the middle pane", () => {
    expect(hitTest(medium(), 99, 3)).toEqual({ type: "issueRow", index: 0 });
  });
  it("tooSmall layout swallows everything", () => {
    expect(hitTest(medium({ layout: computeLayout(50, 10) }), 5, 3)).toEqual({ type: "none" });
  });
});

describe("hitTest — prs view", () => {
  it("middle rows resolve to prRow; rail and dead zones are none", () => {
    expect(hitTest(medium({ view: "prs" }), 30, 3)).toEqual({ type: "prRow", index: 0 });
    expect(hitTest(medium({ view: "prs" }), 5, 3)).toEqual({ type: "none" });
    expect(hitTest(medium({ view: "prs" }), 30, 6)).toEqual({ type: "none" });
  });
  it("wide: PrPreview link line resolves; elsewhere in the band is none", () => {
    expect(hitTest(wide({ view: "prs" }), 80, 4)).toEqual({ type: "linkLine" });
    expect(hitTest(wide({ view: "prs" }), 80, 6)).toEqual({ type: "none" });
  });
});
