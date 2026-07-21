/**
 * Pure pane-geometry math shared by the components that render rows and the
 * App windowing that budgets them. ONE source of truth: when a pane's row
 * budget changes here, every consumer moves together instead of drifting.
 */

/** Pinned system block in the unified rail: one titled Rule ("system",
 * separator + header merged into a single row) + the five section rows
 * (queue/outbox/worktrees/daemon/logs). */
export const SYSTEM_BLOCK_ROWS = 6;

/** First content row inside a bordered pane, pane-relative
 * (0 = top border, 1 = title row, 2 = first content row). */
export const PANE_CONTENT_ROW = 2;

/** Pane-relative row of the ↗ link line on the preview cards:
 * border(0), title(1), heading(2), link(3). Preview/PrPreview render it
 * there (the link line is now its own ClickableBox region). */
export const LINK_LINE_ROW = 3;

/** Repo rows the rail can show: borders(2) + title(1) + position line(1)
 * + the pinned system block. */
export function railListHeight(bodyRows: number): number {
  return Math.max(1, bodyRows - 4 - SYSTEM_BLOCK_ROWS);
}

/** Rows the issue/PR lists can show: borders(2) + title(1) + header strip(1)
 * + position line(1). */
export function listRowsHeight(bodyRows: number): number {
  return Math.max(1, bodyRows - 5);
}

/** Rows a header-less section body (outbox, worktrees) can show: borders(2) +
 * title(1) + position line(1). The issue/PR lists spend one more on their
 * column-header strip — see listRowsHeight. */
export function sectionRowsHeight(bodyRows: number): number {
  return Math.max(1, bodyRows - 4);
}
