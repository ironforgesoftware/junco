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
