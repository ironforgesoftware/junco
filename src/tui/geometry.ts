/**
 * Pure pane-geometry math shared by the components that render rows and the
 * mouse hit-tester that resolves clicks back onto them. ONE source of truth:
 * when a pane's row budget changes here, rendering and hit-testing move
 * together instead of drifting.
 */
import { WIDE_COLS } from "./layout.js";

/** Worst-case queue-card rows in the rail: separator + title + running +
 * more-running + waiting + daemon-down. (Moved from Rail.tsx.) */
export const QUEUE_CARD_ROWS = 6;

/** First content row inside a bordered pane, pane-relative
 * (0 = top border, 1 = title row, 2 = first content row). */
export const PANE_CONTENT_ROW = 2;

/** Pane-relative row of the ↗ link line on the preview cards:
 * border(0), title(1), heading(2), link(3). Preview/PrPreview render it
 * there; hitTest resolves clicks on it. */
export const LINK_LINE_ROW = 3;

/** Repo rows the rail can show: borders(2) + title(1) + position line(1)
 * + the pinned queue card. */
export function railListHeight(bodyRows: number): number {
  return Math.max(1, bodyRows - 4 - QUEUE_CARD_ROWS);
}

/** Rows the issue/PR lists can show: borders(2) + title(1) + position line(1). */
export function listRowsHeight(bodyRows: number): number {
  return Math.max(1, bodyRows - 4);
}

export type UiMode = "github" | "local";

/** Columns consumed before the tab segment: paddingX(1) + "🐦 junco" (8 cols
 * wide — the bird emoji is width 2) + the gap(2) before the tabs. Stage E's
 * Header renders the brand in exactly this many columns so the tab click
 * bands below line up with what's drawn. */
export const TAB_BRAND_COLS = 11;

/** Column ranges the GITHUB / LOCAL header tabs occupy, shared by Header
 * (renders the tabs there) and onMouseEvent (resolves a y===0 click back onto
 * a mode) so component and hit-test never drift. Fixed-width slots keep the
 * bands stable regardless of which tab is active; below WIDE_COLS the slots
 * collapse to a single letter so the one-row header survives at 60 cols. */
export function headerTabBands(columns: number): {
  hit(x: number): UiMode | null;
  githubStart: number;
  localStart: number;
} {
  const compact = columns < WIDE_COLS;
  const ghWidth = compact ? 3 : 8; // "[G]" | "[GITHUB]"
  const loWidth = compact ? 3 : 7; // "[L]" | "[LOCAL]"
  const githubStart = TAB_BRAND_COLS;
  const githubEnd = githubStart + ghWidth;
  const localStart = githubEnd + 1; // one-col gutter
  const localEnd = localStart + loWidth;
  return {
    githubStart,
    localStart,
    hit(x: number): UiMode | null {
      if (x >= githubStart && x < githubEnd) return "github";
      if (x >= localStart && x < localEnd) return "local";
      return null;
    },
  };
}
