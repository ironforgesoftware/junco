/** Terminal hyperlinks for the preview cards' ↗ line and the chat's markdown links. */
import type { RowLink } from "../transcriptRender.js";

/** OSC 8 hyperlink: cmd/ctrl+click opens `url` in terminals that support it
 * (iTerm2, Ghostty, WezTerm, kitty); others render `text` plainly. BEL
 * terminator — the most widely accepted form. Applied via Ink <Transform>
 * (post-layout) so width math never sees the escapes. */
export function hyperlink(text: string, url: string): string {
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

/** `owner/repo#123` from a GitHub issue/PR url — compact display text that
 * survives narrow previews. Non-GitHub-shaped urls fall back scheme-less. */
export function shortResourceRef(url: string): string {
  const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : url.replace(/^https?:\/\//, "");
}

/**
 * A markdown row's links applied to its painted line (F3, #512): each link's
 * `text (url)` — or bare `text` when the url part wrapped away or the link
 * was its own url — becomes an OSC 8 hyperlink around `text`; with `dimUrl`
 * the `(url)` is dimmed (SGR 2 … 22). Runs inside TranscriptBody's Ink
 * <Transform>, post-layout: both escapes are zero-width, so the width math
 * that wrapped and truncated the row never sees them. SGR 22 also ends bold,
 * so the caller passes `dimUrl` false on a bold or already-dim row. A link
 * whose text is not on the line (wrapped onto the next row, or truncated) is
 * left plain — the `(url)` still reads.
 */
export function linkifyLine(line: string, links: readonly RowLink[], dimUrl: boolean): string {
  let out = line;
  for (const { text, url } of links) {
    if (text === "") continue;
    const full = `${text} (${url})`;
    const i = out.indexOf(full);
    if (i >= 0) {
      const tail = dimUrl ? `\u001b[2m(${url})\u001b[22m` : `(${url})`;
      out = `${out.slice(0, i)}${hyperlink(text, url)} ${tail}${out.slice(i + full.length)}`;
      continue;
    }
    const j = out.indexOf(text);
    if (j >= 0) out = `${out.slice(0, j)}${hyperlink(text, url)}${out.slice(j + text.length)}`;
  }
  return out;
}
