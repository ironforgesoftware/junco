import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { bumpRender } from "../renderCount.js";
import { theme } from "../theme.js";
import {
  fmtRunOutcome,
  renderTranscriptRows,
  MIN_WIDTH,
  type RowTone,
  type TranscriptRow,
} from "../../transcriptRender.js";
import { toolCallIds } from "../../transcriptSummary.js";
import type { TranscriptState } from "../hooks/useTranscript.js";
import { TranscriptBody, bodyWindow, toneProps } from "./TranscriptBody.js";

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

/** The transcript view (fullscreen, in the review view's slot). Mirrors
 * CommandOutput's shape: header, body (TranscriptBody), footer. Memoized
 * (perf pass #259 discipline). */
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
  // Memoized: the row list depends only on the summary and the render options,
  // but every scroll keystroke re-renders this component — re-rendering a
  // 3000-row transcript from scratch on each `]` is the one hot path here.
  const rows: TranscriptRow[] = useMemo(
    () =>
      state.summary === null
        ? []
        : renderTranscriptRows(state.summary, {
            width: textWidth,
            showThinking: state.showThinking,
            expanded: state.expanded,
          }),
    [state.summary, state.showThinking, state.expanded, textWidth],
  );
  // Ticket transcripts have no drafts, so the cursor space is tool calls
  // only — not Task 13's anchorIds (which also carries draft anchors).
  const anchors = state.summary === null ? [] : toolCallIds(state.summary);
  const { start, end } = bodyWindow({
    rows,
    anchors,
    cursor: state.cursor,
    follow: state.follow,
    scroll,
    visible,
  });
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
      <TranscriptBody
        rows={rows}
        anchors={anchors}
        cursor={state.cursor}
        follow={state.follow}
        scroll={scroll}
        visible={visible}
        focused={focused}
        onScrollMax={onScrollMax}
        onRowPress={onRowPress}
      />
      <Text dimColor wrap="truncate">
        ↑/↓ tool · enter expand · [/] scroll · t thinking{live ? " · f follow" : ""}
        {rows.length > 0 ? ` · ${start + 1}–${end}/${rows.length}` : ""}
      </Text>
    </Box>
  );
});
