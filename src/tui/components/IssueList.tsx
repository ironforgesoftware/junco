import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { deriveState, stateMeta, type DashIssue } from "../state.js";
import { Spinner } from "./Spinner.js";
import { fmtClock } from "../queueFmt.js";
import { ClickableBox } from "../ClickableBox.js";

export function relTime(iso: string, now: Date): string {
  const ms = now.getTime() - (Date.parse(iso) || now.getTime());
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m <= 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** relTime with a seconds tier below one minute — the pane freshness stamp.
 * Future timestamps clamp to 0s (the 2s poll clock can lag the fetch clock). */
export function relTimeShort(iso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - (Date.parse(iso) || now.getTime()));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return relTime(iso, now);
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
  /** listIssues' cache-served fetchedAt (offline) — null when the list is fresh. */
  staleAt: string | null;
  window: { start: number; end: number };
  /** Mouse: press on an issue row (registry index into the filtered list). */
  onRowPress?: (index: number) => void;
  /** Mouse: press on the pane background (no row). */
  onPanePress?: () => void;
  /** Mouse: wheel over the pane (down → +1, up → −1). */
  onWheel?: (dir: 1 | -1) => void;
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
  staleAt,
  window,
  onRowPress,
  onPanePress,
  onWheel,
}: IssueListProps): React.JSX.Element {
  return (
    <ClickableBox
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
      onPress={onPanePress}
      onWheel={onWheel}
    >
      <Text bold color={focused ? theme.accent : undefined}>
        issues · {issues.length}
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
        {staleAt !== null && <Text color={theme.warn}> offline · {fmtClock(staleAt)}</Text>}
      </Text>
      {issues.length === 0 && filter !== "" && (
        <Text dimColor>no issues match /{filter} — esc clears the filter</Text>
      )}
      {issues.length === 0 && filter === "" && (
        <Text dimColor>
          no open issues — create one on GitHub, then select it here and press d to dispatch
        </Text>
      )}
      {issues.slice(window.start, window.end).map((iss, i) => {
        const idx = window.start + i;
        const sel = idx === selected;
        const st = deriveState(iss.labels, trigger);
        const meta = stateMeta(st);
        return (
          <ClickableBox
            key={iss.number}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            hoverBg={sel ? theme.selectionBg : theme.hoverBg}
            gap={1}
            onPress={onRowPress ? () => onRowPress(idx) : undefined}
          >
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text color={meta.color}>{meta.glyph}</Text>
            <Text dimColor={!sel}>{`#${iss.number}`.padStart(5)}</Text>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate">{iss.title}</Text>
            </Box>
            <Text color={meta.color}>{meta.badge}</Text>
            <Text dimColor>{relTime(iss.updatedAt, now)}</Text>
          </ClickableBox>
        );
      })}
      <Box flexGrow={1} />
      {issues.length > window.end - window.start && (
        <Text dimColor>
          {Math.min(selected + 1, issues.length)}/{issues.length}
        </Text>
      )}
    </ClickableBox>
  );
}
