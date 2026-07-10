import { describe, it, expect } from "vitest";
import {
  LINK_LINE_ROW,
  PANE_CONTENT_ROW,
  QUEUE_CARD_ROWS,
  headerTabBands,
  listRowsHeight,
  railListHeight,
  TAB_BRAND_COLS,
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

describe("headerTabBands", () => {
  it("wide: GITHUB then a 1-col gutter then LOCAL; hit() resolves each band", () => {
    const b = headerTabBands(120);
    expect(b.githubStart).toBe(TAB_BRAND_COLS); // 11
    expect(b.localStart).toBe(TAB_BRAND_COLS + 8 + 1); // 20
    expect(b.hit(11)).toBe("github");
    expect(b.hit(18)).toBe("github"); // last GITHUB col (githubEnd=19 exclusive)
    expect(b.hit(19)).toBeNull(); // gutter
    expect(b.hit(20)).toBe("local");
    expect(b.hit(26)).toBe("local"); // last LOCAL col (localEnd=27 exclusive)
    expect(b.hit(27)).toBeNull();
    expect(b.hit(0)).toBeNull();
    expect(b.hit(10)).toBeNull(); // inside the brand mark
  });

  it("compact (<WIDE_COLS): single-letter slots keep the 60-col header on one row", () => {
    const b = headerTabBands(60);
    expect(b.githubStart).toBe(11);
    expect(b.localStart).toBe(11 + 3 + 1); // 15
    expect(b.hit(11)).toBe("github");
    expect(b.hit(13)).toBe("github"); // githubEnd=14 exclusive
    expect(b.hit(14)).toBeNull();
    expect(b.hit(15)).toBe("local");
    expect(b.hit(17)).toBe("local"); // localEnd=18 exclusive
    expect(b.hit(18)).toBeNull();
  });
});
