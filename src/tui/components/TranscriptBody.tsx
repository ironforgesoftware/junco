/**
 * The rows/scrollbar/cursor-gutter block shared by TranscriptView (ticket
 * transcripts) and ChatView (spec 2026-09-01 §8.2): extracted verbatim out of
 * TranscriptView so both surfaces render the SAME row list with the SAME
 * cursor/follow/scroll mechanics — a ticket transcript's cursor space is
 * `toolCallIds`, a chat transcript's is `anchorIds` (Task 13's draft
 * anchors), but the windowing and paint logic below don't care which.
 */
import React, { useEffect } from "react";
import { Box, Text, Transform } from "ink";
import { theme } from "../theme.js";
import { linkifyLine } from "../links.js";
import { bumpRender } from "../renderCount.js";
import { ClickableBox } from "../ClickableBox.js";
import { Scrollbar } from "./primitives/Scrollbar.js";
import { clampScroll, maxScroll } from "../window.js";
import type { RowTone, TranscriptRow } from "../../transcriptRender.js";

export function toneProps(tone: RowTone | undefined): {
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
} {
  switch (tone) {
    case "dim":
      return { dimColor: true };
    // Spec 2026-09-06 §4.3: reasoning is set apart from the answer, not
    // merely dimmed like a tool body.
    case "thinking":
      return { dimColor: true, italic: true };
    case "accent":
      return { color: theme.accent };
    case "error":
      return { color: theme.error };
    case "warn":
      return { color: theme.warn };
    case "success":
      return { color: theme.success };
    case "bold":
      return { bold: true };
    default:
      return {};
  }
}

/**
 * The row list as a lazy accessor (spec 2026-09-06 §4.1). ChatView's rows are
 * the finished turns (memoized on the summary alone) followed by the live
 * turn's rows (rebuilt every flush); handing the body a row-count plus
 * `at(i)` instead of a materialized array means a flush never copies the
 * thousand finished rows to append a few live ones. `anchorRow(id)` replaces
 * the old `rows.findIndex(r => r.anchor === id)` so the cursor's reveal need
 * not scan the array either.
 */
export interface RowSource {
  readonly length: number;
  at(i: number): TranscriptRow;
  /** Index of the FIRST row carrying `anchor === id`, or -1. */
  anchorRow(id: string): number;
}

/**
 * Anchor → first row index, memoized by the finished array's identity: the
 * array is a `useMemo` product upstream, so the same object means the same
 * rows, and the map is rebuilt exactly when the memo re-runs. A WeakMap so a
 * discarded row list takes its index with it.
 */
const anchorIndexes = new WeakMap<TranscriptRow[], Map<string, number>>();

function anchorIndex(rows: TranscriptRow[]): Map<string, number> {
  let m = anchorIndexes.get(rows);
  if (m === undefined) {
    m = new Map();
    rows.forEach((r, i) => {
      if (r.anchor !== undefined && !m!.has(r.anchor)) m!.set(r.anchor, i);
    });
    anchorIndexes.set(rows, m);
  }
  return m;
}

/**
 * `a` followed by `b`, copying nothing. Anchor lookup consults `a`'s memoized
 * index, then scans `b` (the live turn — a handful of rows, rebuilt per
 * frame, so indexing it would cost more than the scan).
 */
export function concatRows(a: TranscriptRow[], b: TranscriptRow[]): RowSource {
  return {
    length: a.length + b.length,
    at: (i) => (i < a.length ? a[i] : b[i - a.length]) as TranscriptRow,
    anchorRow: (id) => {
      const hit = anchorIndex(a).get(id);
      if (hit !== undefined) return hit;
      const j = b.findIndex((r) => r.anchor === id);
      return j < 0 ? -1 : a.length + j;
    },
  };
}

/** A single array as a `RowSource` — the adapter for callers with no live half. */
export const arrayRows = (rows: TranscriptRow[]): RowSource => concatRows(rows, []);

export interface TranscriptBodyProps {
  rows: RowSource;
  /** The cursor's index space (toolCallIds or anchorIds). */
  anchors: string[];
  cursor: number;
  follow: boolean;
  scroll: number;
  visible: number;
  focused: boolean;
  /** The window owes the cursor's anchor a visit: set by the owning hook's
   * cursor actions (useChat/useTranscript `moveCursor`/`setCursor`), cleared
   * by the parent's `onReveal` ack once the nudged start is committed as the
   * scroll offset. While it is false the window is `scroll` alone, however
   * far the anchor has been scrolled off screen. */
  reveal: boolean;
  onScrollMax?: (max: number) => void;
  onRowPress?: (anchorIdx: number) => void;
  /** Scrollbar click/drag: an absolute first-row offset. Must be a STABLE
   * callback — a fresh arrow every render would defeat this component's memo. */
  onScrollTo?: (offset: number) => void;
  /** Called once per owed reveal with the start the nudge painted — the
   * parent stores it as the scroll offset and clears `reveal`, so the next
   * render paints the same window from `scroll` alone. Stable, like
   * `onScrollTo`. Without it a reveal stays owed and the window keeps
   * nudging (the pre-2026-09-03 behaviour), which is fine for a caller that
   * never scrolls by rows. */
  onReveal?: (start: number) => void;
}

/** Window math mirrors QueueView: base at `scroll` (or the tail while
 * `follow`), nudged onto the cursor's anchor row while a `reveal` is owed.
 * The nudge used to apply on every render, which was right while ↑/↓ moved
 * the cursor between anchors and wrong once they scrolled rows (the chat, and
 * the transcript's `[`/`]`): any scroll that took the anchor off screen was
 * snapped straight back to it. Returns the window so the caller's footer can
 * print `start–end/total`. */
export function bodyWindow(
  p: Pick<
    TranscriptBodyProps,
    "rows" | "anchors" | "cursor" | "follow" | "scroll" | "visible" | "reveal"
  >,
): { start: number; end: number; anchorId: string | undefined } {
  const anchorId = p.anchors[p.cursor];
  const anchorRow = anchorId === undefined ? -1 : p.rows.anchorRow(anchorId);
  let start = p.follow
    ? maxScroll(p.rows.length, p.visible)
    : clampScroll(p.scroll, p.rows.length, p.visible);
  if (p.reveal && !p.follow && anchorRow >= 0) {
    if (anchorRow < start) start = anchorRow;
    else if (anchorRow >= start + p.visible) start = anchorRow - p.visible + 1;
  }
  return { start, end: Math.min(start + p.visible, p.rows.length), anchorId };
}

/** Memoized (perf pass #259 discipline): a re-render that doesn't change the
 * row list, cursor, scroll, or focus would otherwise repaint a 3000-row
 * transcript from scratch. */
export const TranscriptBody = React.memo(function TranscriptBody(
  p: TranscriptBodyProps,
): React.JSX.Element {
  bumpRender("TranscriptBody");
  const { start, end, anchorId } = bodyWindow(p);
  p.onScrollMax?.(maxScroll(p.rows.length, p.visible));
  // Ack AFTER the nudged frame is committed, so the parent's scroll offset
  // catches up with what was painted and no frame shows the un-nudged window.
  const { reveal, onReveal } = p;
  useEffect(() => {
    if (reveal) onReveal?.(start);
  }, [reveal, onReveal, start]);
  return (
    <Box flexGrow={1}>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        {Array.from({ length: Math.max(0, end - start) }, (_, i) => {
          const row = p.rows.at(start + i);
          const isAnchor = row.anchor !== undefined && row.anchor === anchorId;
          const idx = row.anchor === undefined ? -1 : p.anchors.indexOf(row.anchor);
          // Only a row in the cursor's index space is pressable: a thinking
          // header (transcriptRender.ts's thinkingAnchor) names its row but is
          // not a cursor stop, and pressing it with idx -1 would move the
          // cursor to the first anchor instead.
          const pressable = idx >= 0;
          const tone = toneProps(row.tone);
          const text = (
            <Text
              wrap="truncate-end"
              backgroundColor={isAnchor && p.focused ? theme.selectionBg : undefined}
              {...tone}
            >
              <Text color={theme.accent}>{isAnchor ? "▌" : " "}</Text>
              {row.text || " "}
            </Text>
          );
          // A markdown link row (F3, #512) is painted through <Transform>, the
          // ↗ line's pattern: `linkifyLine` runs post-layout on the wrapped
          // line, so the OSC 8 and the dim `(url)` are invisible to the width
          // math. The dim is skipped on a bold or dim row — SGR 22 would end
          // the row's own intensity mid-line. The Transform's node wraps
          // rather than truncates, which a link row never needs: it is prose,
          // already wrapped to the text width.
          const links = row.links;
          return (
            <ClickableBox
              key={start + i}
              hoverBg={pressable ? theme.hoverBg : undefined}
              onPress={pressable && p.onRowPress ? () => p.onRowPress!(idx) : undefined}
            >
              {links === undefined ? (
                text
              ) : (
                <Transform transform={(s) => linkifyLine(s, links, !tone.bold && !tone.dimColor)}>
                  {text}
                </Transform>
              )}
            </ClickableBox>
          );
        })}
      </Box>
      <Scrollbar
        offset={start}
        viewport={p.visible}
        total={p.rows.length}
        height={p.visible}
        onScrollTo={p.onScrollTo}
      />
    </Box>
  );
});
