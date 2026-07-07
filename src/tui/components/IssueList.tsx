import React, { useRef } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { windowSlice } from "../window.js";
import { deriveState, stateMeta, type DashIssue } from "../state.js";
import { Spinner } from "./Spinner.js";

export function relTime(iso: string, now: Date): string {
  const ms = now.getTime() - (Date.parse(iso) || now.getTime());
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m <= 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface IssueListProps {
  issues: DashIssue[]; // already filtered by the App
  trigger: string;
  selected: number;
  focused: boolean;
  refreshing: boolean;
  filter: string;
  filtering: boolean;
  height: number;
  now: Date;
}

/** Pane 2: windowed issue rows with full-row selection bars and aligned
 * metadata. Replaces IssueTable. */
export function IssueList({
  issues,
  trigger,
  selected,
  focused,
  refreshing,
  filter,
  filtering,
  height,
  now,
}: IssueListProps): React.JSX.Element {
  const listHeight = Math.max(1, height - 4); // borders + title + position line
  const prev = useRef(0);
  const { start, end } = windowSlice(issues.length, listHeight, selected, prev.current);
  prev.current = start;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
    >
      <Text bold color={focused ? theme.accent : undefined}>
        2 issues · {issues.length}
        {filter !== "" && (
          <Text color={theme.accent} bold={filtering}>
            {" "}
            /{filter}
          </Text>
        )}
        {refreshing && (
          <>
            {" "}
            <Spinner />
          </>
        )}
      </Text>
      {issues.length === 0 && filter !== "" && (
        <Text dimColor>no issues match /{filter} — esc clears the filter</Text>
      )}
      {issues.length === 0 && filter === "" && (
        <Text dimColor>
          no open issues — create one on GitHub, then select it here and press d to dispatch
        </Text>
      )}
      {issues.slice(start, end).map((iss, i) => {
        const idx = start + i;
        const sel = idx === selected;
        const st = deriveState(iss.labels, trigger);
        const meta = stateMeta(st);
        return (
          <Box
            key={iss.number}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            gap={1}
          >
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text color={meta.color}>{meta.glyph}</Text>
            <Text dimColor={!sel}>{`#${iss.number}`.padStart(5)}</Text>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate">{iss.title}</Text>
            </Box>
            <Text color={meta.color}>{meta.badge}</Text>
            <Text dimColor>{relTime(iss.updatedAt, now)}</Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {issues.length > listHeight && (
        <Text dimColor>
          {Math.min(selected + 1, issues.length)}/{issues.length}
        </Text>
      )}
    </Box>
  );
}
