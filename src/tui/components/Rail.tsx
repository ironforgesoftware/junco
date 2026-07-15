import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { stateMeta, type IssueLifecycle } from "../state.js";
import type { QueueSnapshot } from "../queueSnapshot.js";
import { queueLabel } from "../queueFmt.js";
import { ClickableBox } from "../ClickableBox.js";

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
  window: { start: number; end: number };
  /** Mouse: press on a repo row (registry index into repos). */
  onRowPress?: (index: number) => void;
  /** Mouse: press on the pane background (no row). */
  onPanePress?: () => void;
  /** Mouse: wheel over the pane (down → +1, up → −1). */
  onWheel?: (dir: 1 | -1) => void;
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
  window,
  onRowPress,
  onPanePress,
  onWheel,
}: RailProps): React.JSX.Element {
  const running = queue?.running ?? [];
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
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate">
              {r.nwo}
              {r.fromConfig ? " (cfg)" : ""}
              {badges ? `  ${badges}` : ""}
            </Text>
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
    </ClickableBox>
  );
}
