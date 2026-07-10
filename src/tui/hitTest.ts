/**
 * Pure click resolver: terminal cell → what's under it. Mirrors the frame
 * that Workspace + the panes render, using the SAME geometry helpers the
 * components consume — the two cannot drift independently.
 * Row map: y=0 header, body y ∈ [1, 1+bodyRows), then toast + footer.
 * Column bands: rail [0, railWidth), middle [railWidth, columns−previewWidth),
 * preview [columns−previewWidth, columns) (wide mode only).
 */

import type { Layout } from "./layout.js";
import {
  LINK_LINE_ROW,
  PANE_CONTENT_ROW,
  listRowsHeight,
  railListHeight,
  headerTabBands,
} from "./geometry.js";
import type { UiMode } from "./geometry.js";

export type HitTarget =
  | { type: "pane"; pane: 1 | 2 | 3 }
  | { type: "repoRow"; index: number }
  | { type: "issueRow"; index: number }
  | { type: "prRow"; index: number }
  | { type: "pane3Row"; index: number }
  | { type: "linkLine" }
  | { type: "modeTab"; mode: UiMode }
  | { type: "none" };

export interface HitContext {
  layout: Layout;
  columns: number;
  /** Two-mode App only: enables header-band resolution at y===0. Absent ⇒
   * legacy single-surface, header row is dead. */
  uiMode?: UiMode;
  /** The row-bearing views resolve rows; the two detail views resolve only
   * their ↗ metadata line. Other views never call this. */
  view: "main" | "prs" | "detail" | "prDetail";
  repoCount: number;
  /** Rows in the middle list — filtered issues (main) or the PR aggregate (prs). */
  listCount: number;
  /** Window starts — the App's lifted windowSlice offsets. */
  railStart: number;
  listStart: number;
  /** Main view: rows in pane 3's repo-scoped PR monitor (a windowed PrList).
   * Unused in the prs view, whose right band is the PrPreview card. */
  pane3Count: number;
  pane3Start: number;
  /** prs view: the PrPreview card is showing, so its ↗ line is clickable.
   * Unused in the main view (pane 3 renders rows there, not a card). */
  hasPreviewTarget: boolean;
}

export function hitTest(ctx: HitContext, x: number, y: number): HitTarget {
  const { layout, columns, view } = ctx;
  if (layout.mode === "tooSmall") return { type: "none" };
  if (y === 0) {
    if (ctx.uiMode === undefined) return { type: "none" };
    const m = headerTabBands(columns).hit(x);
    return m ? { type: "modeTab", mode: m } : { type: "none" };
  }
  const r = y - 1; // pane-relative row: every pane spans the full body height
  if (r < 0 || r >= layout.bodyRows) return { type: "none" };

  if (view === "detail" || view === "prDetail") {
    // Keyboard-owned overlays: only the ↗ metadata line is a mouse target.
    // The card fills the middle slot to the screen edge — no right pane
    // renders in these views, at any width.
    if (x >= layout.railWidth && r === LINK_LINE_ROW) return { type: "linkLine" };
    return { type: "none" };
  }

  if (x < layout.railWidth) {
    if (view === "prs") return { type: "none" }; // rail isn't interactive in the PRs view
    const i = r - PANE_CONTENT_ROW;
    const visible = Math.min(ctx.repoCount - ctx.railStart, railListHeight(layout.bodyRows));
    if (i >= 0 && i < visible) return { type: "repoRow", index: ctx.railStart + i };
    return { type: "pane", pane: 1 };
  }

  if (layout.mode === "wide" && x >= columns - layout.previewWidth) {
    if (view === "prs") {
      // The prs view's right band is the PrPreview card — only its ↗ line acts.
      if (r === LINK_LINE_ROW && ctx.hasPreviewTarget) return { type: "linkLine" };
      return { type: "none" };
    }
    // Main view: pane 3 is the repo-scoped PR monitor, a windowed PrList.
    const i = r - PANE_CONTENT_ROW;
    const visible = Math.min(ctx.pane3Count - ctx.pane3Start, listRowsHeight(layout.bodyRows));
    if (i >= 0 && i < visible) return { type: "pane3Row", index: ctx.pane3Start + i };
    return { type: "pane", pane: 3 };
  }

  const i = r - PANE_CONTENT_ROW;
  const visible = Math.min(ctx.listCount - ctx.listStart, listRowsHeight(layout.bodyRows));
  if (i >= 0 && i < visible) {
    return view === "main"
      ? { type: "issueRow", index: ctx.listStart + i }
      : { type: "prRow", index: ctx.listStart + i };
  }
  return view === "main" ? { type: "pane", pane: 2 } : { type: "none" };
}
