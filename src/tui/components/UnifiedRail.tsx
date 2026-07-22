/**
 * Pane 1 of the unified view: every repo junco knows about on top (windowed),
 * the five system rows pinned below (absorbing the old queue card). One
 * selection index spans the whole row union — `selected` and `onRowPress`
 * both speak ABSOLUTE indices into `rows` (repo prefix, then system rows).
 * Spec: docs/superpowers/specs/2026-07-20-tui-unified-view-design.md §2.
 */

import React from "react";
import { Box, Text } from "ink";
import { bumpRender } from "../renderCount.js";
import { theme } from "../theme.js";
import { stateMeta, type IssueLifecycle } from "../state.js";
import { fmtAssessIndicator } from "../queueFmt.js";
import { ClickableBox } from "../ClickableBox.js";
import { Rule } from "./primitives/Rule.js";
import { sectionBadge, truncStart, SOURCE_TAG } from "./sections.js";
import { SYSTEM_SECTIONS, type RailRow } from "../railModel.js";
import type { LocalCheap, LocalHeavy } from "../localSnapshot.js";
import type { AssessHistory } from "../../assessHistory.js";

export interface UnifiedRailProps {
  rows: RailRow[];
  /** Absolute index into `rows` (repo prefix + system tail). */
  selected: number;
  focused: boolean;
  /** System badges (queue/outbox/daemon) + the gate ⚠ suffix. */
  cheap: LocalCheap | null;
  /** Worktree ⚑ badge. */
  heavy: LocalHeavy | null;
  /** Lifecycle badge counts for a watched nwo row (App derives from issues). */
  issueCounts: (nwo: string) => Partial<Record<IssueLifecycle, number>>;
  /** Per-repo assess history; null → never assessed (#193). */
  assess: (nwo: string) => AssessHistory | null;
  width: number;
  height: number;
  /** Polled wall clock for the assess age column — NOT a live clock. */
  now: Date;
  /** Window over the REPO prefix only; system rows are always visible. */
  window: { start: number; end: number };
  /** Mouse: press on a row (ABSOLUTE index into rows). */
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

/** Memoized (perf pass, spec 2026-07-21-tui-app-decomposition task 16) — this
 * pane is mounted for every view App renders (main/prs/repoDetail/…), so it is
 * on screen for essentially every poll tick. */
export const UnifiedRail = React.memo(function UnifiedRail({
  rows,
  selected,
  focused,
  cheap,
  heavy,
  issueCounts,
  assess,
  width,
  height,
  now,
  window,
  onRowPress,
  onPanePress,
  onWheel,
}: UnifiedRailProps): React.JSX.Element {
  bumpRender("UnifiedRail"); // no-op unless JUNCO_RENDER_COUNT=1 (perf-pass measurement seam)
  const repoRows = rows.filter((r) => r.kind === "repo");
  const repoCount = repoRows.length;
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
        repos
      </Text>
      {repoCount === 0 && <Text dimColor>none — press w to add</Text>}
      {repoRows.slice(window.start, window.end).map((row, i) => {
        const idx = window.start + i; // absolute: repo prefix starts at 0
        const sel = idx === selected;
        const repo = row.kind === "repo" ? row.repo : null;
        if (repo === null) return null; // unreachable (filtered above)
        const badges =
          repo.nwo !== null && repo.watched
            ? COUNT_ORDER.filter((s) => (issueCounts(repo.nwo ?? "")[s] ?? 0) > 0)
                .map((s) => `${issueCounts(repo.nwo ?? "")[s]}${stateMeta(s).glyph}`)
                .join(" ")
            : "";
        const label =
          repo.nwo !== null && repo.watched ? repo.nwo : truncStart(repo.path, width - 10);
        const tag = repo.fromConfig ? " (cfg)" : repo.watched ? "" : ` ${SOURCE_TAG[repo.source]}`;
        return (
          <ClickableBox
            key={repo.key}
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
            {/* Shrinks: label + tag + lifecycle badges truncate together. */}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate" dimColor={!repo.watched && !sel}>
                {label}
                {tag}
                {badges ? `  ${badges}` : ""}
              </Text>
            </Box>
            {/* Pinned: the assess column must never be the thing that truncates.
                Local-only rows have no assess history — the slot renders blank
                so the column stays aligned. */}
            <Box flexShrink={0} minWidth={ASSESS_COL} justifyContent="flex-end">
              <Text dimColor={!sel}>
                {repo.nwo !== null && repo.watched ? fmtAssessIndicator(assess(repo.nwo), now) : ""}
              </Text>
            </Box>
          </ClickableBox>
        );
      })}
      {repoCount > window.end - window.start && (
        <Text dimColor>
          {Math.min(selected, repoCount - 1) + 1}/{repoCount}
        </Text>
      )}
      <Box flexGrow={1} />
      <Rule title="system" width={Math.max(1, width - 4)} />
      {SYSTEM_SECTIONS.map((s, i) => {
        const idx = repoCount + i; // absolute index into rows
        const sel = idx === selected;
        let badge = sectionBadge(s, cheap, heavy);
        if (
          s === "queue" &&
          cheap?.queue.stats?.gate != null &&
          cheap.queue.stats.gate.state !== "ok"
        ) {
          badge = `${badge} ⚠`.trim();
        }
        return (
          <ClickableBox
            key={s}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            hoverBg={sel ? theme.selectionBg : theme.hoverBg}
            onPress={onRowPress ? () => onRowPress(idx) : undefined}
          >
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate">
              {s}
              {badge ? `  ${badge}` : ""}
            </Text>
          </ClickableBox>
        );
      })}
    </ClickableBox>
  );
});
