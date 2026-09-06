/**
 * CommonMark-style fenced-block helpers shared by every module that reads or
 * writes a tagged ```<tag> block: githubInbox (junco-ticket plan fences),
 * findings (junco-findings), analyzeFlow (junco-comment), and the chat's
 * fenceExtract. Pure string functions with no I/O and no imports, so any
 * module — including the import-cycle-sensitive findings.ts — can depend on
 * it freely.
 */

/** Longest run of consecutive backticks at the START of any line in `text`.
 * Line-anchored is sufficient because the block finders below are themselves
 * line-anchored: only fences that begin a line can open/close a block. Used
 * by callers that REWRAP a body in a fence of their own, which must be
 * longer than any fence the body already contains. */
export function longestBacktickRun(text: string): number {
  let max = 0;
  for (const line of text.split("\n")) {
    const m = /^(`+)/.exec(line);
    if (m && m[1].length > max) max = m[1].length;
  }
  return max;
}

/** Line-range [open, close] (inclusive, into `lines`) of the LAST complete
 * ```<fenceTag> block, fence-length-aware: an opening fence of N backticks
 * (optionally followed by whitespace before the tag, as CommonMark allows) is
 * closed by the first later line that is a run of >= N backticks with no info
 * text, so a block that itself contains a ```bash block does not truncate at
 * the inner fence. Null = no complete block of that tag. */
export function lastFencedBlockRange(
  lines: string[],
  fenceTag: string,
): { open: number; close: number } | null {
  const openRe = new RegExp("^(`{3,})\\s*" + fenceTag + "\\s*$");
  let last: { open: number; close: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = openRe.exec(lines[i]);
    if (!m) continue;
    const n = m[1].length;
    const closeRe = new RegExp("^`{" + n + ",}\\s*$");
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) continue; // no closer → not a complete block; ignore
    last = { open: i, close };
    i = close; // resume scanning after this block's closer
  }
  return last;
}

/** Inner text of the LAST complete ```<fenceTag> block in `text`, or null
 * when no complete block exists. */
export function extractLastFencedBlock(text: string, fenceTag: string): string | null {
  const lines = text.split("\n");
  const range = lastFencedBlockRange(lines, fenceTag);
  return range ? lines.slice(range.open + 1, range.close).join("\n") : null;
}
