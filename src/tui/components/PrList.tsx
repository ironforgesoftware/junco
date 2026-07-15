import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { derivePrState, prStateMeta, type DashPr } from "../prState.js";
import { fmtClock } from "../queueFmt.js";
import { relTime } from "./IssueList.js";
import { ClickableBox } from "../ClickableBox.js";

function checksToString(checks: {
  pass: number;
  fail: number;
  pending: number;
  total: number;
}): string {
  const parts: string[] = [];
  if (checks.fail > 0) parts.push(`✗${checks.fail}`);
  if (checks.pass > 0) parts.push(`✓${checks.pass}`);
  if (checks.pending > 0) parts.push(`◍${checks.pending}`);
  return parts.join(" ");
}

/** Widest the dim repo cell may grow; longer nwos truncate from the start so
 * the repo-name tail (the discriminating part) stays visible. Exported so
 * callers composing their own title (pane 3's repo-scoped monitor) can mirror
 * this same clamp instead of inventing a second budget. */
export const NWO_MAX_WIDTH = 24;

export interface PrListProps {
  prs: DashPr[]; // already sorted by the App
  selected: number; // index into prs
  focused: boolean;
  height: number;
  now: Date;
  staleAt: string | null; // any repo served from cache → oldest fetchedAt
  window: { start: number; end: number };
  showNwo?: boolean; // show nwo cell; default true for multi-repo view
  title?: string; // pane title; default "p pull requests · N"
  emptyText?: string; // empty-state message; default the cross-repo copy below
  /** Mouse: press on a PR row (registry index into prs). */
  onRowPress?: (index: number) => void;
  /** Mouse: press on the pane background (no row). */
  onPanePress?: () => void;
  /** Mouse: wheel over the pane (down → +1, up → −1). */
  onWheel?: (dir: 1 | -1) => void;
}

/** Pane 2: windowed PR rows with full-row selection bars and aligned
 * metadata. Selection list for PRs across watched repos. */
export function PrList({
  prs,
  selected,
  focused,
  height,
  now,
  staleAt,
  window,
  showNwo = true,
  title,
  emptyText,
  onRowPress,
  onPanePress,
  onWheel,
}: PrListProps): React.JSX.Element {
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
      <Text bold color={focused ? theme.accent : undefined} wrap="truncate">
        {title ?? `p pull requests · ${prs.length}`}
        {staleAt !== null && <Text color={theme.warn}> offline · {fmtClock(staleAt)}</Text>}
      </Text>
      {prs.length === 0 && (
        <Text dimColor>
          {emptyText ??
            "no junco PRs found across watched repos — junco opens PRs from dispatched tickets"}
        </Text>
      )}
      {prs.slice(window.start, window.end).map((prItem, i) => {
        const idx = window.start + i;
        const sel = idx === selected;
        const st = derivePrState(prItem);
        const meta = prStateMeta(st);
        const checksStr = checksToString(prItem.checks);
        const checksColor =
          prItem.checks.fail > 0
            ? theme.error
            : prItem.checks.pending > 0
              ? theme.warn
              : theme.success;

        // Every cell except the title is flexShrink 0 (the Chrome.tsx header-chip
        // guarantee): a row must never wrap to a second line, or the height and
        // windowing math above corrupts. The title is the ONLY flexible cell.
        return (
          <ClickableBox
            key={`${prItem.nwo}#${prItem.number}`}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            hoverBg={sel ? theme.selectionBg : theme.hoverBg}
            gap={1}
            onPress={onRowPress ? () => onRowPress(idx) : undefined}
          >
            <Box flexShrink={0}>
              <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={meta.color}>{meta.glyph}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor={!sel}>{`#${prItem.number}`.padStart(5)}</Text>
            </Box>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate">{prItem.title}</Text>
            </Box>
            {showNwo && (
              <Box flexShrink={0} width={Math.min(prItem.nwo.length, NWO_MAX_WIDTH)}>
                <Text dimColor wrap="truncate-start">
                  {prItem.nwo}
                </Text>
              </Box>
            )}
            {checksStr !== "" && (
              <Box flexShrink={0}>
                <Text color={checksColor}>{checksStr}</Text>
              </Box>
            )}
            <Box flexShrink={0}>
              <Text color={meta.color}>{meta.badge}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{relTime(prItem.updatedAt, now)}</Text>
            </Box>
          </ClickableBox>
        );
      })}
      <Box flexGrow={1} />
      {prs.length > window.end - window.start && (
        <Text dimColor>
          {Math.min(selected + 1, prs.length)}/{prs.length}
        </Text>
      )}
    </ClickableBox>
  );
}
