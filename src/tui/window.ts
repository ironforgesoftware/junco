/** Slice `total` rows to a `height` window that follows `cursor` with minimal
 * movement: the window only moves when the cursor would leave it, and a stale
 * prevStart (list shrank) clamps instead of overflowing. */
export function windowSlice(
  total: number,
  height: number,
  cursor: number,
  prevStart: number,
): { start: number; end: number } {
  if (height <= 0 || total <= 0) return { start: 0, end: 0 };
  const h = Math.min(height, total);
  let start = Math.min(Math.max(prevStart, 0), total - h);
  const c = Math.min(Math.max(cursor, 0), total - 1);
  if (c < start) start = c;
  else if (c >= start + h) start = c - h + 1;
  return { start, end: start + h };
}

/** Largest first-row offset that still fills a `height`-row viewport from
 * `total` rows: the last row lands at the BOTTOM of the viewport, never above
 * it, so blank rows are unreachable. Content that fits gives 0 — no scrolling. */
export function maxScroll(total: number, height: number): number {
  if (height <= 0 || total <= 0) return 0;
  return Math.max(0, total - height);
}

/** Clamp a scroll offset into `[0, maxScroll(total, height)]`. Clamps at BOTH
 * ends: a stale offset left over from a longer list collapses onto the new
 * bottom instead of slicing past it into an empty window. */
export function clampScroll(offset: number, total: number, height: number): number {
  return Math.min(Math.max(offset, 0), maxScroll(total, height));
}
