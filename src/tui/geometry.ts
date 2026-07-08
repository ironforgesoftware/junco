/**
 * Pure pane-geometry math shared by the components that render rows and the
 * mouse hit-tester that resolves clicks back onto them. ONE source of truth:
 * when a pane's row budget changes here, rendering and hit-testing move
 * together instead of drifting.
 */

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
