import React, { useRef } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { windowSlice } from "../window.js";
import { derivePrState, prStateMeta, type DashPr } from "../prState.js";
import { fmtClock } from "../queueFmt.js";
import { relTime } from "./IssueList.js";

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
 * the repo-name tail (the discriminating part) stays visible. */
const NWO_MAX_WIDTH = 24;

export interface PrListProps {
  prs: DashPr[]; // already sorted by the App
  selected: number; // index into prs
  focused: boolean;
  height: number;
  now: Date;
  staleAt: string | null; // any repo served from cache → oldest fetchedAt
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
}: PrListProps): React.JSX.Element {
  const listHeight = Math.max(1, height - 4); // borders + title + position line
  const prev = useRef(0);
  const { start, end } = windowSlice(prs.length, listHeight, selected, prev.current);
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
        p pull requests · {prs.length}
        {staleAt !== null && <Text color={theme.warn}> offline · {fmtClock(staleAt)}</Text>}
      </Text>
      {prs.length === 0 && (
        <Text dimColor>
          no junco PRs found across watched repos — junco opens PRs from dispatched tickets
        </Text>
      )}
      {prs.slice(start, end).map((prItem, i) => {
        const idx = start + i;
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
          <Box
            key={`${prItem.nwo}#${prItem.number}`}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            gap={1}
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
            <Box flexShrink={0} width={Math.min(prItem.nwo.length, NWO_MAX_WIDTH)}>
              <Text dimColor wrap="truncate-start">
                {prItem.nwo}
              </Text>
            </Box>
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
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {prs.length > listHeight && (
        <Text dimColor>
          {Math.min(selected + 1, prs.length)}/{prs.length}
        </Text>
      )}
    </Box>
  );
}
