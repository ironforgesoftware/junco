import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { stateMeta, type IssueLifecycle } from "../state.js";
import type { QueueSnapshot } from "../queueSnapshot.js";
import { queueLabel, fmtAssessIndicator, oldestQueuedAt, fmtAgeShort } from "../queueFmt.js";
import { ClickableBox } from "../ClickableBox.js";
import type { AssessHistory } from "../../assessHistory.js";

export interface RailRepo {
  nwo: string;
  fromConfig: boolean;
  counts: Partial<Record<IssueLifecycle, number>>;
  /** Per-repo assess history (#193); null → never assessed. */
  assess?: AssessHistory | null;
}

export interface RailProps {
  repos: RailRepo[];
  selected: number;
  focused: boolean;
  queue: QueueSnapshot | null;
  width: number;
  height: number;
  /** Polled wall clock for the assess age column — NOT a live clock. */
  now: Date;
  window: { start: number; end: number };
  /** Mouse: press on a repo row (registry index into repos). */
  onRowPress?: (index: number) => void;
  /** Mouse: press on the pane background (no row). */
  onPanePress?: () => void;
  /** Mouse: wheel over the pane (down → +1, up → −1). */
  onWheel?: (dir: 1 | -1) => void;
}

const COUNT_ORDER: IssueLifecycle[] = ["plan-ready", "working", "failed"];

/** Reserved columns for the assess indicator. The slot is flexShrink={0} with
 * this as a MINIMUM, so the rare over-long value (`99d+! 99+⚠`) grows the slot
 * and shrinks the nwo instead of overflowing the pane. */
const ASSESS_COL = 8;

/** Pane 1: watched repos on top, a compact queue card pinned below.
 * Absorbs the old RepoList and QueueStrip. */
export function Rail({
  repos,
  selected,
  focused,
  queue,
  width,
  height,
  now,
  window,
  onRowPress,
  onPanePress,
  onWheel,
}: RailProps): React.JSX.Element {
  const running = queue?.running ?? [];
  const oldestWaiting = queue !== null ? oldestQueuedAt(queue.waiting) : null;
  return (
    <ClickableBox
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      width={width}
      height={height}
      onPress={onPanePress}
      onWheel={onWheel}
    >
      <Text bold color={focused ? theme.accent : undefined}>
        1 repos
      </Text>
      {repos.length === 0 && <Text dimColor>none — press w to add</Text>}
      {repos.slice(window.start, window.end).map((r, i) => {
        const idx = window.start + i;
        const sel = idx === selected;
        const badges = COUNT_ORDER.filter((s) => (r.counts[s] ?? 0) > 0)
          .map((s) => `${r.counts[s]}${stateMeta(s).glyph}`)
          .join(" ");
        return (
          <ClickableBox
            key={r.nwo}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            hoverBg={sel ? theme.selectionBg : theme.hoverBg}
            onPress={onRowPress ? () => onRowPress(idx) : undefined}
          >
            {/* Pinned: the ▌ NO_COLOR selection fallback (theme.ts:4). Without
                flexShrink={0} Ink squeezes it to zero on a long nwo — the row then
                has no visible selection at all (#193). */}
            <Box flexShrink={0}>
              <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            </Box>
            {/* Shrinks: nwo + (cfg) + lifecycle badges truncate together, exactly as
                they already did before the indicator existed. */}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate">
                {r.nwo}
                {r.fromConfig ? " (cfg)" : ""}
                {badges ? `  ${badges}` : ""}
              </Text>
            </Box>
            {/* Pinned: the assess column is the point of the row — it must never be
                the thing that truncates. */}
            <Box flexShrink={0} minWidth={ASSESS_COL} justifyContent="flex-end">
              <Text dimColor={!sel}>{fmtAssessIndicator(r.assess ?? null, now)}</Text>
            </Box>
          </ClickableBox>
        );
      })}
      {repos.length > window.end - window.start && (
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
          {queue.stats?.gate != null && queue.stats.gate.state !== "ok" && (
            <Text color={theme.warn} wrap="truncate">
              ▸ paused — {queue.stats.gate.state.replace(/_/g, " ")}
            </Text>
          )}
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
          {queue.waiting.length > 0 && (
            <Text dimColor>
              {queue.waiting.length} waiting
              {oldestWaiting !== null ? ` · oldest ${fmtAgeShort(oldestWaiting, now)}` : ""}
            </Text>
          )}
          {!queue.daemonUp && <Text color={theme.warn}>daemon ○ down</Text>}
        </>
      )}
    </ClickableBox>
  );
}
