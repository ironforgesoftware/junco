import { describe, it, expect } from "vitest";
import {
  LINK_LINE_ROW,
  PANE_CONTENT_ROW,
  SYSTEM_BLOCK_ROWS,
  listRowsHeight,
  railListHeight,
} from "../src/tui/geometry.js";

describe("geometry", () => {
  it("mirrors the rail repo-row budget: borders + title + position line + system block", () => {
    expect(SYSTEM_BLOCK_ROWS).toBe(6); // one titled Rule ("system") + five rows
    expect(railListHeight(30)).toBe(30 - 4 - SYSTEM_BLOCK_ROWS);
    expect(railListHeight(5)).toBe(1); // clamps at 1, never 0/negative
  });

  it("mirrors the IssueList/PrList row budget: borders + title + header strip + position line", () => {
    expect(listRowsHeight(27)).toBe(22);
    expect(listRowsHeight(3)).toBe(1);
  });

  it("pins the pane-relative anchor rows", () => {
    expect(PANE_CONTENT_ROW).toBe(2); // border(0) + title(1)
    expect(LINK_LINE_ROW).toBe(3); // border(0) + title(1) + heading(2)
  });
});
