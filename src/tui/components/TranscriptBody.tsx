/**
 * The rows/scrollbar/cursor-gutter block shared by TranscriptView (ticket
 * transcripts) and ChatView (spec 2026-09-01 §8.2): extracted verbatim out of
 * TranscriptView so both surfaces render the SAME row list with the SAME
 * cursor/follow/scroll mechanics — a ticket transcript's cursor space is
 * `toolCallIds`, a chat transcript's is `anchorIds` (Task 13's draft
 * anchors), but the windowing and paint logic below don't care which.
 */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { bumpRender } from "../renderCount.js";
import { ClickableBox } from "../ClickableBox.js";
import { Scrollbar } from "./primitives/Scrollbar.js";
import { clampScroll, maxScroll } from "../window.js";
import type { RowTone, TranscriptRow } from "../../transcriptRender.js";

export function toneProps(tone: RowTone | undefined): {
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
} {
  switch (tone) {
    case "dim":
      return { dimColor: true };
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

export interface TranscriptBodyProps {
  rows: TranscriptRow[];
  /** The cursor's index space (toolCallIds or anchorIds). */
  anchors: string[];
  cursor: number;
  follow: boolean;
  scroll: number;
  visible: number;
  focused: boolean;
  onScrollMax?: (max: number) => void;
  onRowPress?: (anchorIdx: number) => void;
  /** Scrollbar click/drag: an absolute first-row offset. Must be a STABLE
   * callback — a fresh arrow every render would defeat this component's memo. */
  onScrollTo?: (offset: number) => void;
}

/** Window math mirrors QueueView: base at `scroll` (or the tail while
 * `follow`), then nudge so the cursor's anchor row stays visible. Returns the
 * window so the caller's footer can print `start–end/total`. */
export function bodyWindow(
  p: Pick<TranscriptBodyProps, "rows" | "anchors" | "cursor" | "follow" | "scroll" | "visible">,
): { start: number; end: number; anchorId: string | undefined } {
  const anchorId = p.anchors[p.cursor];
  const anchorRow = anchorId === undefined ? -1 : p.rows.findIndex((r) => r.anchor === anchorId);
  let start = p.follow
    ? maxScroll(p.rows.length, p.visible)
    : clampScroll(p.scroll, p.rows.length, p.visible);
  if (!p.follow && anchorRow >= 0) {
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
  return (
    <Box flexGrow={1}>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        {p.rows.slice(start, end).map((row, i) => {
          const isAnchor = row.anchor !== undefined && row.anchor === anchorId;
          const idx = row.anchor === undefined ? -1 : p.anchors.indexOf(row.anchor);
          return (
            <ClickableBox
              key={start + i}
              hoverBg={row.anchor !== undefined ? theme.hoverBg : undefined}
              onPress={
                row.anchor !== undefined && p.onRowPress ? () => p.onRowPress!(idx) : undefined
              }
            >
              <Text
                wrap="truncate-end"
                backgroundColor={isAnchor && p.focused ? theme.selectionBg : undefined}
                {...toneProps(row.tone)}
              >
                <Text color={theme.accent}>{isAnchor ? "▌" : " "}</Text>
                {row.text || " "}
              </Text>
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
