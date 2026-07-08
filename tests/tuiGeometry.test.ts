import { describe, it, expect } from "vitest";
import {
  LINK_LINE_ROW,
  PANE_CONTENT_ROW,
  QUEUE_CARD_ROWS,
  listRowsHeight,
  railListHeight,
} from "../src/tui/geometry.js";

describe("geometry", () => {
  it("mirrors the Rail row budget: borders + title + position line + queue card", () => {
    // Rail.tsx historically computed max(1, height − 2 − 1 − 1 − QUEUE_CARD_ROWS).
    expect(railListHeight(27)).toBe(27 - 4 - QUEUE_CARD_ROWS);
    expect(railListHeight(5)).toBe(1); // clamps at 1, never 0/negative
  });

  it("mirrors the IssueList/PrList row budget: borders + title + position line", () => {
    expect(listRowsHeight(27)).toBe(23);
    expect(listRowsHeight(3)).toBe(1);
  });

  it("pins the pane-relative anchor rows", () => {
    expect(PANE_CONTENT_ROW).toBe(2); // border(0) + title(1)
    expect(LINK_LINE_ROW).toBe(3); // border(0) + title(1) + heading(2)
  });
});
