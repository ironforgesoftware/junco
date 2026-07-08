/** Terminal hyperlinks for the preview cards' ↗ line. */

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
