/**
 * markdown/render — blocks (blocks.ts) → `TranscriptRow[]` for TranscriptBody
 * (spec 2026-09-06 §4.2). Pure: no Ink, no SDK; the highlighter is an
 * injected function so tests use a fake and the real one (Pi's
 * `highlightCode`, through the agent/session.ts seam) arrives in Task 14.
 *
 * Row shapes: headings are tone `bold` with the `#` stripped; lists get a
 * `• ` / `1. ` marker with a hanging indent (nested items two columns in);
 * quotes a `│ ` bar, tone `dim`; a rule is `───` across the width; fences are
 * the highlighter's lines verbatim (ANSI and all — TranscriptBody paints rows
 * with `wrap="truncate-end"`, so an over-wide line is clipped, never wrapped,
 * and `wrapText` never sees an escape sequence) or the raw lines when there is
 * no highlighter or it declines; a table is its raw lines. Prose goes through
 * transcriptRender's `wrapText`; inline emphasis markers are stripped and the
 * text rendered plain, inline code keeps its backticks (v1 — no `segments`).
 *
 * Streaming: `MdCache` holds the rows of every CLOSED block by index, keyed on
 * the block's source text. A frame re-renders only the open tail; the closed
 * rows come back as the same objects, so a memoized row list sees them as
 * unchanged. A width or highlighter change drops the cache wholesale.
 */
import { MIN_WIDTH, wrapText, type TranscriptRow } from "../../transcriptRender.js";
import { parseBlocks, type MdBlock } from "./blocks.js";

/** Returns the highlighted lines (ANSI allowed) or null to fall back to raw. */
export type HighlightFn = (code: string, lang: string | null) => string[] | null;

export interface MdCacheEntry {
  source: string;
  rows: TranscriptRow[];
}

export interface MdCache {
  width: number;
  highlight: HighlightFn | undefined;
  /** Closed-block index → its rows; `entries.length` is the closed-block count. */
  entries: MdCacheEntry[];
}

export const createMdCache = (): MdCache => ({ width: 0, highlight: undefined, entries: [] });

export interface RenderMarkdownOpts {
  /** Wrap column; values below transcriptRender's MIN_WIDTH are raised to it. */
  width: number;
  highlight?: HighlightFn;
  cache?: MdCache;
}

const CODE_SPAN = /(`[^`\n]+`)/;

/** `[text](url)` → `text (url)` (or just the text when the two coincide). */
const stripLinks = (s: string): string =>
  s.replace(
    /!?\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g,
    (_m: string, label: string, url: string) =>
      url === "" || url === label ? label : `${label} (${url})`,
  );

const stripEmphasis = (s: string): string =>
  s
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\*(?=\S)([^*]*?\S)\*/g, "$1")
    // `_` only counts at a word edge, so snake_case identifiers survive.
    .replace(/(?<![A-Za-z0-9])_(?=\S)([^_]*?\S)_(?![A-Za-z0-9])/g, "$1");

/** Inline pass: emphasis and link syntax stripped outside code spans; a code
 * span is kept verbatim, backticks included. */
export const inlineText = (s: string): string =>
  s
    .split(CODE_SPAN)
    .map((part, i) => (i % 2 === 1 ? part : stripEmphasis(stripLinks(part))))
    .join("");

const row = (text: string, tone?: TranscriptRow["tone"]): TranscriptRow =>
  tone === undefined ? { text } : { text, tone };

/** Wrap `text` under `prefix`, continuation rows indented to the prefix width. */
const hanging = (
  prefix: string,
  text: string,
  width: number,
  tone?: TranscriptRow["tone"],
): TranscriptRow[] => {
  const pad = " ".repeat(prefix.length);
  return wrapText(text, Math.max(1, width - prefix.length)).map((line, i) =>
    row(`${i === 0 ? prefix : pad}${line}`, tone),
  );
};

const renderList = (block: MdBlock & { kind: "list" }, width: number): TranscriptRow[] => {
  const rows: TranscriptRow[] = [];
  block.items.forEach((item, i) => {
    const marker = block.ordered ? `${block.start + i}. ` : "• ";
    rows.push(...hanging(marker, inlineText(item.text), width));
    item.children.forEach((child, j) => {
      const sub = child.ordered ? `  ${j + 1}. ` : "  • ";
      rows.push(...hanging(sub, inlineText(child.text), width));
    });
  });
  return rows;
};

const renderFence = (
  block: MdBlock & { kind: "fence" },
  highlight: HighlightFn | undefined,
): TranscriptRow[] => {
  if (block.lines.length === 0) return [];
  const lines = highlight?.(block.lines.join("\n"), block.lang) ?? block.lines;
  return lines.map((text) => row(text));
};

const renderBlock = (
  block: MdBlock,
  width: number,
  highlight: HighlightFn | undefined,
): TranscriptRow[] => {
  switch (block.kind) {
    case "paragraph":
      return wrapText(inlineText(block.text), width).map((t) => row(t));
    case "heading":
      return wrapText(inlineText(block.text), width).map((t) => row(t, "bold"));
    case "list":
      return renderList(block, width);
    case "quote":
      return wrapText(inlineText(block.text), Math.max(1, width - 2)).map((t) =>
        row(`│ ${t}`, "dim"),
      );
    case "fence":
      return renderFence(block, highlight);
    case "rule":
      return [row("─".repeat(width), "dim")];
    case "table":
      return block.lines.map((t) => row(t));
  }
};

/** Block `index` with its separator: one blank row before every block but the
 * first. The separator belongs to the block so a cached entry is complete. */
const renderAt = (
  block: MdBlock,
  index: number,
  width: number,
  highlight: HighlightFn | undefined,
): TranscriptRow[] => {
  const rows = renderBlock(block, width, highlight);
  return index > 0 && rows.length > 0 ? [row(""), ...rows] : rows;
};

export function renderMarkdown(text: string, opts: RenderMarkdownOpts): TranscriptRow[] {
  const width = Math.max(MIN_WIDTH, opts.width);
  const { closed, open } = parseBlocks(text);
  const cache = opts.cache;
  if (cache && (cache.width !== width || cache.highlight !== opts.highlight)) {
    cache.width = width;
    cache.highlight = opts.highlight;
    cache.entries = [];
  }
  const out: TranscriptRow[] = [];
  closed.forEach((block, i) => {
    const hit = cache?.entries[i];
    if (hit && hit.source === block.source) {
      out.push(...hit.rows);
      return;
    }
    const rows = renderAt(block, i, width, opts.highlight);
    if (cache) cache.entries[i] = { source: block.source, rows };
    out.push(...rows);
  });
  if (cache) cache.entries.length = closed.length;
  if (open) out.push(...renderAt(open, closed.length, width, opts.highlight));
  return out;
}
