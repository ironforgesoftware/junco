import React from "react";
import { Box, Text } from "ink";
import { bumpRender } from "../renderCount.js";
import { theme } from "../theme.js";
import { clampScroll, maxScroll } from "../window.js";
import { Scrollbar } from "./primitives/Scrollbar.js";
import { ClickableBox } from "../ClickableBox.js";
import {
  fmtRunOutcome,
  renderTranscriptRows,
  MIN_WIDTH,
  type RowTone,
  type TranscriptRow,
} from "../../transcriptRender.js";
import { toolCallIds } from "../../transcriptSummary.js";
import type { TranscriptState } from "../hooks/useTranscript.js";

export interface TranscriptViewProps {
  state: TranscriptState;
  scroll: number;
  height: number;
  /** Terminal columns — the renderer wraps prose to fit inside the border. */
  width: number;
  focused: boolean;
  onScrollMax?: (max: number) => void;
  /** Mouse press on a tool row: its index in `toolCallIds(summary)`. */
  onRowPress?: (anchorIdx: number) => void;
}

function headerStatus(s: TranscriptState): { text: string; tone?: RowTone } {
  if (s.error !== null) return { text: s.error, tone: "error" };
  if (s.summary === null)
    return s.expectLive
      ? { text: "waiting for the agent to start…", tone: "dim" }
      : { text: "loading…", tone: "dim" };
  if (s.summary.live) return { text: s.follow ? "◐ live · follow" : "◐ live", tone: "accent" };
  const last = s.summary.runs[s.summary.runs.length - 1];
  return last === undefined ? { text: "empty", tone: "dim" } : fmtRunOutcome(last, false);
}

function toneProps(tone: RowTone | undefined): {
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

/** The transcript view (fullscreen, in the review view's slot). Mirrors
 * CommandOutput's shape: header, sliced rows + Scrollbar, footer. Window math
 * mirrors QueueView: base at `scroll` (or the tail while `follow`), then nudge
 * so the cursor's tool row stays visible. Memoized (perf pass #259 discipline). */
export const TranscriptView = React.memo(function TranscriptView({
  state,
  scroll,
  height,
  width,
  focused,
  onScrollMax,
  onRowPress,
}: TranscriptViewProps): React.JSX.Element {
  bumpRender("TranscriptView");
  // Reserved rows: borders ×2, header, footer.
  const visible = Math.max(1, height - 4);
  // Borders (2) + paddingX (2) + scrollbar column (1) + cursor gutter (1).
  const textWidth = Math.max(MIN_WIDTH, width - 6);
  const rows: TranscriptRow[] =
    state.summary === null
      ? []
      : renderTranscriptRows(state.summary, {
          width: textWidth,
          showThinking: state.showThinking,
          expanded: state.expanded,
        });
  const anchors = state.summary === null ? [] : toolCallIds(state.summary);
  const anchorId = anchors[state.cursor];
  const anchorRow = anchorId === undefined ? -1 : rows.findIndex((r) => r.anchor === anchorId);
  onScrollMax?.(maxScroll(rows.length, visible));
  let start = state.follow
    ? maxScroll(rows.length, visible)
    : clampScroll(scroll, rows.length, visible);
  if (!state.follow && anchorRow >= 0) {
    if (anchorRow < start) start = anchorRow;
    else if (anchorRow >= start + visible) start = anchorRow - visible + 1;
  }
  const end = Math.min(start + visible, rows.length);
  const status = headerStatus(state);
  const runs = state.summary?.runs.length ?? 0;
  const live = state.summary?.live === true;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      height={height}
      flexGrow={1}
    >
      <Text bold wrap="truncate">
        transcript · {state.id}
        {runs > 0 ? ` · ${runs} run${runs === 1 ? "" : "s"}` : ""} ·{" "}
        <Text {...toneProps(status.tone)}>{status.text}</Text>
      </Text>
      <Box flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {rows.slice(start, end).map((row, i) => {
            const isAnchor = row.anchor !== undefined && row.anchor === anchorId;
            const idx = row.anchor === undefined ? -1 : anchors.indexOf(row.anchor);
            return (
              <ClickableBox
                key={start + i}
                hoverBg={row.anchor !== undefined ? theme.hoverBg : undefined}
                onPress={row.anchor !== undefined && onRowPress ? () => onRowPress(idx) : undefined}
              >
                <Text
                  wrap="truncate-end"
                  backgroundColor={isAnchor && focused ? theme.selectionBg : undefined}
                  {...toneProps(row.tone)}
                >
                  <Text color={theme.accent}>{isAnchor ? "▌" : " "}</Text>
                  {row.text || " "}
                </Text>
              </ClickableBox>
            );
          })}
        </Box>
        <Scrollbar offset={start} viewport={visible} total={rows.length} height={visible} />
      </Box>
      <Text dimColor wrap="truncate">
        ↑/↓ tool · enter expand · [/] scroll · t thinking{live ? " · f follow" : ""}
        {rows.length > 0 ? ` · ${start + 1}–${end}/${rows.length}` : ""}
      </Text>
    </Box>
  );
});
