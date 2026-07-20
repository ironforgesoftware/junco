import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { fmtAge } from "../queueFmt.js";
import { QueueView } from "./QueueView.js";
import { LogView } from "./LogView.js";
import { windowSlice } from "../window.js";
import { listRowsHeight } from "../geometry.js";
import { RAIL_WIDTH, type Layout } from "../layout.js";
import type { LogEntry } from "../../logReader.js";
import {
  sectionBadge,
  truncStart,
  SOURCE_TAG,
  OutboxSection,
  WorktreesSection,
  DaemonSection,
} from "./sections.js";
import type { LocalCheap, LocalHeavy, LocalSection, LocalRepo } from "../localSnapshot.js";

// LocalSection already lives in localSnapshot.ts (it gates the cheap-tick
// `section` option) — re-export rather than redeclare so the union has one
// source of truth.
export type { LocalSection } from "../localSnapshot.js";
export type { UiMode } from "../geometry.js";
// The section bodies + badge derivation moved to sections.tsx (unified-view
// prep); re-export so existing importers keep working.
export { sectionBadge, OutboxSection, WorktreesSection, DaemonSection } from "./sections.js";

const SECTIONS: readonly LocalSection[] = [
  "queue",
  "outbox",
  "repos",
  "worktrees",
  "daemon",
  "logs",
];

/** LOCAL section rail — a fixed 6-row list (never windowed), rendered like the
 * GitHub Rail: `▌` accent cursor + selectionBg on the selected section, border
 * accent when the rail holds focus. Live badges come from the cheap/heavy
 * snapshots; an optional `↻ <age>` stamp is pinned at the bottom so the tall
 * 26-wide column doesn't read as empty. */
export function SectionRail({
  section,
  focus,
  cheap,
  heavy,
  width,
  height,
  now,
  refreshedAt,
  onSectionPress,
}: {
  section: LocalSection;
  focus: "rail" | "body";
  cheap: LocalCheap | null;
  heavy: LocalHeavy | null;
  width: number;
  height: number;
  now: Date;
  refreshedAt?: string | null;
  onSectionPress?: (s: LocalSection) => void;
}): React.JSX.Element {
  const idx = SECTIONS.indexOf(section);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focus === "rail" ? theme.accent : theme.border}
      paddingX={1}
      width={width}
      height={height}
    >
      <Text bold color={focus === "rail" ? theme.accent : undefined}>
        sections
      </Text>
      {SECTIONS.map((s, i) => {
        const sel = i === idx;
        const badge = sectionBadge(s, cheap, heavy);
        return (
          <ClickableBox
            key={s}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            hoverBg={sel ? theme.selectionBg : theme.hoverBg}
            onPress={onSectionPress ? () => onSectionPress(s) : undefined}
          >
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate">
              {s}
              {badge ? `  ${badge}` : ""}
            </Text>
          </ClickableBox>
        );
      })}
      <Text dimColor>
        {idx + 1}/{SECTIONS.length}
      </Text>
      <Box flexGrow={1} />
      {refreshedAt != null && (
        <Text dimColor wrap="truncate">
          ↻ {fmtAge(refreshedAt, now)}
        </Text>
      )}
    </Box>
  );
}

/** Repos junco knows about and where they live on disk. */
export function ReposSection({
  repos,
  error,
  cursor,
  window,
  height,
  focused,
  onRowPress,
}: {
  repos: LocalRepo[] | null;
  error: string | null;
  cursor: number;
  window: { start: number; end: number };
  height: number;
  focused: boolean;
  onRowPress?: (index: number) => void;
}): React.JSX.Element {
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
        repos
      </Text>
      {error !== null && (
        <Text dimColor wrap="truncate-end">
          unavailable: {error}
        </Text>
      )}
      {repos === null && error === null && <Text dimColor>loading…</Text>}
      {repos !== null && repos.length === 0 && error === null && <Text dimColor>none</Text>}
      {(repos ?? []).slice(window.start, window.end).map((r, i) => {
        const idx = window.start + i;
        const sel = idx === cursor;
        return (
          <ClickableBox
            key={r.path}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            hoverBg={sel ? theme.selectionBg : theme.hoverBg}
            onPress={onRowPress ? () => onRowPress(idx) : undefined}
          >
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate-end">
              <Text bold>{r.nwo ?? "⟨no nwo⟩"}</Text>
              <Text dimColor> {SOURCE_TAG[r.source]}</Text>
              <Text dimColor> {truncStart(r.path, 30)}</Text>
              {r.error !== null ? (
                <Text color={theme.warn}> {r.error}</Text>
              ) : (
                <>
                  {r.branch !== null && (
                    <Text>
                      {" "}
                      {r.branch}
                      {r.headSha !== null ? `@${r.headSha.slice(0, 7)}` : ""}
                    </Text>
                  )}
                  {r.dirty === true && <Text color={theme.warn}> ✎</Text>}
                </>
              )}
            </Text>
          </ClickableBox>
        );
      })}
      {repos !== null && repos.length > window.end - window.start && (
        <Text dimColor>
          {cursor + 1}/{repos.length}
        </Text>
      )}
    </Box>
  );
}

/** LOCAL dashboard: the section rail + the selected section body. Windowing
 * memory (minimal-movement prevStart) lives here in a per-section ref so the
 * near-pure section components stay testable with an explicit window; the
 * daemon panel scrolls via the `scroll` prop instead. */
export default function LocalDashboard({
  cheap,
  heavy,
  section,
  focus,
  cursor,
  scroll,
  layout,
  now,
  refreshedAt,
  onSectionPress,
  onRowPress,
  onDaemonWheel,
  onScrollMax,
  logEntries,
  logHasFile,
  onLogExpand,
}: {
  cheap: LocalCheap | null;
  heavy: LocalHeavy | null;
  section: LocalSection;
  focus: "rail" | "body";
  cursor: number;
  scroll: number;
  layout: Layout;
  now: Date;
  /** Cheap-poll completion stamp — pinned as the `↻ <age>` line in the rail. */
  refreshedAt?: string | null;
  onSectionPress?: (s: LocalSection) => void;
  onRowPress?: (index: number) => void;
  onDaemonWheel?: (dir: 1 | -1) => void;
  /** Forwarded to whichever of LOCAL mode's two offset surfaces is mounted —
   * `QueueView` (queue section) or `DaemonSection` (daemon section); only one
   * is ever mounted at a time, so a single callback serves both. */
  onScrollMax?: (max: number) => void;
  /** Live log tail for the `logs` section (App's useLogTail buffer); empty/
   * undefined until the surface is on screen. */
  logEntries?: LogEntry[];
  /** false → the daemon-not-started placeholder (App derives it from whether
   * any line has arrived; no render-time fs call). */
  logHasFile?: boolean;
  /** Click-to-expand → App opens the full-screen overlay (Task 7). */
  onLogExpand?: () => void;
}): React.JSX.Element {
  const bodyFocused = focus === "body";
  const h = layout.bodyRows;
  const listH = listRowsHeight(h);
  const prevStart = React.useRef<Record<LocalSection, number>>({
    queue: 0,
    outbox: 0,
    repos: 0,
    worktrees: 0,
    daemon: 0,
    logs: 0,
  });
  const total =
    section === "outbox"
      ? (cheap?.outbox.ops.length ?? 0)
      : section === "repos"
        ? (heavy?.repos.length ?? 0)
        : section === "worktrees"
          ? (heavy?.worktrees.length ?? 0)
          : 0;
  const win = windowSlice(total, listH, cursor, prevStart.current[section]);
  if (section === "outbox" || section === "repos" || section === "worktrees") {
    prevStart.current[section] = win.start;
  }

  const body =
    // The queue section is cursor-driven (`selectable` + `selectedRow`), so its
    // window follows the cursor and the shared scroll offset stays 0 here —
    // only the daemon section moves it. `scroll`/`onScrollMax` are passed for a
    // uniform interface; in this section the reported max is harmlessly unused.
    section === "queue" ? (
      <QueueView
        snap={cheap?.queue ?? null}
        scroll={scroll}
        now={now}
        height={h}
        focused={bodyFocused}
        selectable
        selectedRow={cursor}
        counts={cheap?.counts ?? null}
        onRowPress={onRowPress}
        onScrollMax={onScrollMax}
      />
    ) : section === "outbox" ? (
      <OutboxSection
        outbox={cheap?.outbox ?? null}
        cursor={cursor}
        window={win}
        height={h}
        focused={bodyFocused}
        now={now}
        onRowPress={onRowPress}
      />
    ) : section === "repos" ? (
      <ReposSection
        repos={heavy?.repos ?? null}
        error={heavy?.error ?? null}
        cursor={cursor}
        window={win}
        height={h}
        focused={bodyFocused}
        onRowPress={onRowPress}
      />
    ) : section === "worktrees" ? (
      <WorktreesSection
        worktrees={heavy?.worktrees ?? null}
        error={heavy?.error ?? null}
        cursor={cursor}
        window={win}
        height={h}
        focused={bodyFocused}
        onRowPress={onRowPress}
      />
    ) : section === "daemon" ? (
      <DaemonSection
        daemon={cheap?.daemon ?? null}
        scroll={scroll}
        height={h}
        focused={bodyFocused}
        onWheel={onDaemonWheel}
        onScrollMax={onScrollMax}
      />
    ) : (
      // The section variant reports no scrollable max (its whole surface is
      // click-to-expand), so no `onWheel` — a wheel there would clamp to a no-op.
      <LogView
        variant="section"
        entries={logEntries ?? []}
        height={h}
        focused={bodyFocused}
        hasFile={logHasFile ?? true}
        onExpand={onLogExpand}
      />
    );

  return (
    <Box flexDirection="row">
      <SectionRail
        section={section}
        focus={focus}
        cheap={cheap}
        heavy={heavy}
        width={layout.railWidth > 0 ? layout.railWidth : RAIL_WIDTH}
        height={h}
        now={now}
        refreshedAt={refreshedAt}
        onSectionPress={onSectionPress}
      />
      <Box flexGrow={1}>{body}</Box>
    </Box>
  );
}
