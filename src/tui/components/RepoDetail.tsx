/**
 * Full local picture of ONE repo: identity, git state, worktrees, recent
 * queue activity. Scroll-only (DaemonSection posture — build lines, report
 * maxScroll, slice by clampScroll). Serves two entry points (spec §3): the
 * pane-2 body arm for local-only/unwatched rows, and the full-width
 * "repoDetail" view for watched rows (enter / click-again on the rail row).
 */

import React from "react";
import { Box, Text } from "ink";
import { resolve } from "node:path";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { clampScroll, maxScroll } from "../window.js";
import { fmtAge } from "../queueFmt.js";
import { truncStart, fmtDur, SOURCE_TAG } from "./sections.js";
import { StatRow } from "./primitives/StatRow.js";
import { Rule } from "./primitives/Rule.js";
import { Scrollbar } from "./primitives/Scrollbar.js";
import type { UnifiedRepo } from "../railModel.js";
import type { LocalWorktree } from "../localSnapshot.js";
import type { QueueSnapshot, QueueRunning, QueueWaiting, QueueRecent } from "../queueSnapshot.js";

/** Queue rows whose ticket targeted this repo (resolved-path match). */
export function repoQueueRows(
  queue: QueueSnapshot | null,
  repoPath: string,
): { running: QueueRunning[]; waiting: QueueWaiting[]; recent: QueueRecent[] } {
  const target = resolve(repoPath);
  const mine = <T extends { repoPath: string | null }>(rows: T[]): T[] =>
    rows.filter((r) => r.repoPath !== null && resolve(r.repoPath) === target);
  return {
    running: mine(queue?.running ?? []),
    waiting: mine(queue?.waiting ?? []),
    recent: mine(queue?.recent ?? []),
  };
}

export function RepoDetail({
  repo,
  worktrees,
  queue,
  scroll,
  height,
  focused,
  now,
  onWheel,
  onScrollMax,
}: {
  repo: UnifiedRepo;
  /** Caller pre-filters to this repo (enumerateWorktrees rows by repoPath). */
  worktrees: LocalWorktree[] | null;
  queue: QueueSnapshot | null;
  scroll: number;
  height: number;
  focused: boolean;
  now: Date;
  onWheel?: (dir: 1 | -1) => void;
  /** Reports `maxScroll(lines, visible)` DURING render (DaemonSection rule). */
  onScrollMax?: (max: number) => void;
}): React.JSX.Element {
  const LW = 8;
  const lines: React.JSX.Element[] = [];
  lines.push(
    <Text key="t" bold color={focused ? theme.accent : undefined} wrap="truncate">
      {repo.nwo ?? truncStart(repo.path, 40)}
      <Text dimColor> {SOURCE_TAG[repo.source]}</Text>
    </Text>,
  );
  lines.push(<StatRow key="p" label="path" value={repo.path} labelWidth={LW} />);
  const g = repo.git;
  if (g === null) {
    lines.push(
      <Text key="g" dimColor>
        loading git state…
      </Text>,
    );
  } else if (g.error !== null) {
    lines.push(
      <Text key="ge" color={theme.warn} wrap="truncate-end">
        {g.error}
      </Text>,
    );
  } else {
    lines.push(
      <StatRow
        key="g"
        label="branch"
        value={`${g.branch ?? "?"}${g.headSha !== null ? `@${g.headSha.slice(0, 7)}` : ""}`}
        labelWidth={LW}
        hint={g.dirty === true ? "✎ dirty" : undefined}
        color={g.dirty === true ? theme.warn : undefined}
      />,
    );
    if (g.originUrl !== null) {
      lines.push(<StatRow key="o" label="origin" value={g.originUrl} labelWidth={LW} />);
    }
  }
  for (const c of repo.clones) {
    lines.push(<StatRow key={`c-${c}`} label="clone" value={truncStart(c, 40)} labelWidth={LW} />);
  }

  lines.push(<Rule key="wh" title="worktrees" width={24} />);
  const wts = worktrees ?? [];
  if (wts.length === 0) {
    lines.push(
      <Text key="w0" dimColor>
        {"  "}none
      </Text>,
    );
  }
  for (const w of wts) {
    lines.push(
      <Text key={`w-${w.path}`} wrap="truncate-end" dimColor={w.kind === "backup"}>
        {"  "}
        {w.slug} <Text dimColor>{w.kind}</Text>
        {w.headSha !== null ? ` ${w.headSha.slice(0, 7)}` : ""}{" "}
        <Text dimColor>{fmtDur(w.ageSeconds)}</Text>
      </Text>,
    );
  }

  lines.push(<Rule key="qh" title="recent tickets" width={24} />);
  const rows = repoQueueRows(queue, repo.path);
  const activity: { id: string; glyph: string; color: string | undefined; at: string | null }[] = [
    ...rows.running.map((r) => ({ id: r.id, glyph: "◐", color: theme.info, at: r.startedAt })),
    ...rows.waiting.map((w) => ({
      id: w.id,
      glyph: "⏳",
      color: undefined,
      at: w.queuedAt,
    })),
    ...rows.recent.map((r) => ({
      id: r.id,
      glyph: r.status === "done" ? "✓" : "✗",
      color: r.status === "done" ? theme.success : theme.error,
      at: r.finishedAt as string | null,
    })),
  ];
  if (activity.length === 0) {
    lines.push(
      <Text key="q0" dimColor>
        {"  "}none
      </Text>,
    );
  }
  for (const a of activity) {
    lines.push(
      <Text key={`q-${a.glyph}-${a.id}`} wrap="truncate-end">
        {"  "}
        <Text color={a.color}>{a.glyph}</Text> {a.id}
        {a.at !== null ? <Text dimColor> {fmtAge(a.at, now)}</Text> : null}
      </Text>,
    );
  }

  const visible = Math.max(1, height - 2);
  onScrollMax?.(maxScroll(lines.length, visible));
  const start = clampScroll(scroll, lines.length, visible);
  return (
    <ClickableBox
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
      onWheel={onWheel}
    >
      <Box flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {lines.slice(start, start + visible)}
        </Box>
        <Scrollbar offset={start} viewport={visible} total={lines.length} height={visible} />
      </Box>
    </ClickableBox>
  );
}
