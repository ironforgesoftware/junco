import React, { useRef } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { windowSlice } from "../window.js";
import { stateMeta, type IssueLifecycle } from "../state.js";
import type { QueueSnapshot } from "../queueSnapshot.js";
import { queueLabel } from "../queueFmt.js";
import { QUEUE_CARD_ROWS } from "../geometry.js";

export interface RailRepo {
  nwo: string;
  fromConfig: boolean;
  counts: Partial<Record<IssueLifecycle, number>>;
}

export interface RailProps {
  repos: RailRepo[];
  selected: number;
  focused: boolean;
  queue: QueueSnapshot | null;
  width: number;
  height: number;
}

const COUNT_ORDER: IssueLifecycle[] = ["plan-ready", "working", "failed"];

/** Pane 1: watched repos on top, a compact queue card pinned below.
 * Absorbs the old RepoList and QueueStrip. */
export function Rail({
  repos,
  selected,
  focused,
  queue,
  width,
  height,
}: RailProps): React.JSX.Element {
  // height budget: 2 border rows + title + optional position line + queue card
  const listHeight = Math.max(1, height - 2 - 1 - 1 - QUEUE_CARD_ROWS);
  const prev = useRef(0);
  const { start, end } = windowSlice(repos.length, listHeight, selected, prev.current);
  prev.current = start;
  const running = queue?.running ?? [];
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      width={width}
      height={height}
    >
      <Text bold color={focused ? theme.accent : undefined}>
        1 repos
      </Text>
      {repos.length === 0 && <Text dimColor>none — press w to add</Text>}
      {repos.slice(start, end).map((r, i) => {
        const idx = start + i;
        const sel = idx === selected;
        const badges = COUNT_ORDER.filter((s) => (r.counts[s] ?? 0) > 0)
          .map((s) => `${r.counts[s]}${stateMeta(s).glyph}`)
          .join(" ");
        return (
          <Box key={r.nwo} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate">
              {r.nwo}
              {r.fromConfig ? " (cfg)" : ""}
              {badges ? `  ${badges}` : ""}
            </Text>
          </Box>
        );
      })}
      {repos.length > listHeight && (
        <Text dimColor>
          {selected + 1}/{repos.length}
        </Text>
      )}
      <Box flexGrow={1} />
      <Text dimColor>{"─".repeat(Math.max(1, width - 4))}</Text>
      <Text bold>queue</Text>
      {queue === null && <Text dimColor>loading…</Text>}
      {queue?.error != null && (
        <Text dimColor wrap="truncate-end">
          unavailable: {queue.error}
        </Text>
      )}
      {queue !== null && queue.error === null && (
        <>
          {running.length === 0 && queue.waiting.length === 0 && queue.daemonUp && (
            <Text dimColor>idle</Text>
          )}
          {running.slice(0, 1).map((r) => (
            <Text key={r.id} wrap="truncate">
              <Text color={theme.info}>◐ </Text>
              {queueLabel(r.github, r.id)}
              {r.turns !== null ? <Text dimColor> turn {r.turns}</Text> : null}
            </Text>
          ))}
          {running.length > 1 && <Text dimColor>+{running.length - 1} more running</Text>}
          {queue.waiting.length > 0 && <Text dimColor>{queue.waiting.length} waiting</Text>}
          {!queue.daemonUp && <Text color={theme.warn}>daemon ○ down</Text>}
        </>
      )}
    </Box>
  );
}
