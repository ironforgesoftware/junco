/** Pure breakpoint math for the fullscreen workspace. The chrome is exactly
 * 3 rows (header + the two footer rows, spec 2026-09-02 §3 — a live toast
 * paints OVER the footer's actions row rather than claiming a row of its own)
 * — bodyRows is what panes may fill; the total frame must never exceed
 * terminal rows (Ink redraws duplicate otherwise). */
export const MIN_COLS = 60;
export const MIN_ROWS = 14;
export const WIDE_COLS = 110;
const RAIL_WIDTH = 26;
const PREVIEW_CAP = 60;
export const CHROME_ROWS = 3;

export type LayoutMode = "wide" | "medium" | "tooSmall";
export interface Layout {
  mode: LayoutMode;
  railWidth: number;
  previewWidth: number;
  bodyRows: number;
}

export function computeLayout(columns: number, rows: number): Layout {
  const bodyRows = Math.max(0, rows - CHROME_ROWS);
  if (columns < MIN_COLS || rows < MIN_ROWS) {
    return { mode: "tooSmall", railWidth: 0, previewWidth: 0, bodyRows };
  }
  if (columns >= WIDE_COLS) {
    return {
      mode: "wide",
      railWidth: RAIL_WIDTH,
      previewWidth: Math.min(PREVIEW_CAP, Math.floor(columns * 0.4)),
      bodyRows,
    };
  }
  return { mode: "medium", railWidth: RAIL_WIDTH, previewWidth: 0, bodyRows };
}
