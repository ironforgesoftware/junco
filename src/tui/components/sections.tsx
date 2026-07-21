/**
 * System-section body components for the dashboard: the GitHub outbox op-log,
 * the per-ticket worktrees, and the daemon/health detail, plus the shared
 * section-badge derivation. Near-pure (window/cursor/scroll come in as props)
 * so they render identically as unified-view body arms and in tests.
 * (Relocated from the retired LocalDashboard.tsx — history in git.)
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { fmtAge, queueLabel } from "../queueFmt.js";
import { clampScroll, maxScroll } from "../window.js";
import { StatRow } from "./primitives/StatRow.js";
import { Rule } from "./primitives/Rule.js";
import { Badge } from "./primitives/Badge.js";
import { Gauge } from "./primitives/Gauge.js";
import { Scrollbar } from "./primitives/Scrollbar.js";
import { relTimeShort } from "./IssueList.js";
import type {
  LocalCheap,
  LocalHeavy,
  LocalSection,
  LocalRepo,
  LocalWorktree,
  DaemonDetail,
} from "../localSnapshot.js";

/** Compact live badge for a section, derived from the cheap/heavy snapshots.
 * Empty string → no badge (hidden at zero). Exported for the section suite's
 * direct `logs → ""` assertion. */
export function sectionBadge(
  s: LocalSection,
  cheap: LocalCheap | null,
  heavy: LocalHeavy | null,
): string {
  if (cheap === null) return "";
  switch (s) {
    case "queue": {
      const n = cheap.queue.running.length;
      return n > 0 ? `▸${n}` : "";
    }
    case "outbox":
      return cheap.outbox.depth > 0 ? `⇡${cheap.outbox.depth}` : "";
    case "worktrees": {
      const n = (heavy?.worktrees ?? []).filter((w) => w.kind === "stale").length;
      return n > 0 ? `⚑${n}` : "";
    }
    case "daemon":
      return cheap.daemon.up ? "up" : "down";
    case "repos":
      return "";
    // The live/follow indicator lives in the LogView header (● following /
    // ⏸ paused), not a rail badge — a rail dot would be redundant with the ▌
    // cursor, since the logs poll is active exactly when the section is
    // selected. Deliberate deviation from the plan's rail-dot (Component 5).
    case "logs":
      return "";
  }
}

/** Duration from whole seconds: `13m`, `2h13m`, `-` for null. */
export function fmtDur(s: number | null): string {
  if (s === null) return "-";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Truncate a long path from the start so the meaningful tail (repo dir)
 * survives: `…/repos/acme-api`. */
export function truncStart(p: string, max: number): string {
  return p.length <= max ? p : "…" + p.slice(p.length - max + 1);
}

export const SOURCE_TAG: Record<LocalRepo["source"], string> = {
  config: "(cfg)",
  watchlist: "(watch)",
  external: "(external)",
  clone: "(clone)",
};

// Provider-gate (Task 9/10) severity buckets for the daemon panel's endpoint
// row (Badge color when non-ok, else the reachable/unreachable text color) —
// latched auth/quota/config failures outrank a transient rate-limit/outage
// backoff, which in turn outranks a plain probe miss.
const GATE_RED = new Set(["auth_error", "quota_exhausted", "misconfig"]);
const GATE_YELLOW = new Set(["rate_limited", "outage_backoff", "budget_exhausted"]);

/** GitHub outbox op-log: live ops (selectable) with the cursor op's lastError
 * expanded, plus a read-only dead tail. Mirrors outboxCmd's opLine format. */
export function OutboxSection({
  outbox,
  cursor,
  window,
  height,
  focused,
  now,
  onRowPress,
}: {
  outbox: LocalCheap["outbox"] | null;
  cursor: number;
  window: { start: number; end: number };
  height: number;
  focused: boolean;
  now: Date;
  onRowPress?: (index: number) => void;
}): React.JSX.Element {
  const border = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
    />
  );
  if (outbox === null) {
    return React.cloneElement(border, {}, <Text dimColor>loading…</Text>);
  }
  const rows: React.JSX.Element[] = [];
  rows.push(
    <Text key="h" bold color={focused ? theme.accent : undefined}>
      <Text color={theme.warn}>⇡{outbox.depth}</Text> live ·{" "}
      <Text color={theme.error}>✗{outbox.dead}</Text> dead
    </Text>,
  );
  if (outbox.error !== null) {
    rows.push(
      <Text key="err" dimColor wrap="truncate-end">
        unavailable: {outbox.error}
      </Text>,
    );
  }
  if (outbox.ops.length === 0 && outbox.error === null) {
    rows.push(
      <Text key="none" dimColor>
        none
      </Text>,
    );
  }
  outbox.ops.slice(window.start, window.end).forEach((s, i) => {
    const idx = window.start + i;
    const sel = idx === cursor;
    const target = s.issueKey ?? "?";
    rows.push(
      <ClickableBox
        key={s.id}
        width="100%"
        backgroundColor={sel ? theme.selectionBg : undefined}
        hoverBg={sel ? theme.selectionBg : theme.hoverBg}
        onPress={onRowPress ? () => onRowPress(idx) : undefined}
      >
        <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
        <Text wrap="truncate-end">
          {fmtAge(s.createdAt, now)} {s.op.kind} {target}
          <Text dimColor> attempts={s.attempts}</Text>
        </Text>
      </ClickableBox>,
    );
    if (sel && s.lastError !== null) {
      rows.push(
        <Text key={`${s.id}-e`} dimColor wrap="truncate-end">
          {"  "}
          {s.lastError}
        </Text>,
      );
    }
  });
  if (outbox.ops.length > window.end - window.start) {
    rows.push(
      <Text key="pos" dimColor>
        {cursor + 1}/{outbox.ops.length}
      </Text>,
    );
  }
  if (outbox.deadOps.length > 0) {
    rows.push(
      <Text key="dead-h" bold color={theme.error}>
        {" "}
        dead
      </Text>,
    );
    for (const s of outbox.deadOps) {
      rows.push(
        <Text key={`d-${s.id}`} dimColor wrap="truncate-end">
          {"  "}
          {fmtAge(s.createdAt, now)} {s.op.kind} attempts={s.attempts}
        </Text>,
      );
    }
  }
  return React.cloneElement(border, {}, rows.slice(0, Math.max(1, height - 3)));
}

/** Per-ticket worktrees. The FS class (live/stale/backup) is display-only —
 * NOT the prune safety signal (that lives under worktrees.lock, Stage A/B). */
export function WorktreesSection({
  worktrees,
  error,
  cursor,
  window,
  height,
  focused,
  onRowPress,
}: {
  worktrees: LocalWorktree[] | null;
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
        worktrees
      </Text>
      {error !== null && (
        <Text dimColor wrap="truncate-end">
          unavailable: {error}
        </Text>
      )}
      {worktrees === null && error === null && <Text dimColor>loading…</Text>}
      {worktrees !== null && worktrees.length === 0 && error === null && <Text dimColor>none</Text>}
      {(worktrees ?? []).slice(window.start, window.end).map((w, i) => {
        const idx = window.start + i;
        const sel = idx === cursor;
        const dim = w.kind === "backup";
        return (
          <ClickableBox
            key={w.path}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            hoverBg={sel ? theme.selectionBg : theme.hoverBg}
            onPress={onRowPress ? () => onRowPress(idx) : undefined}
          >
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate-end" dimColor={dim}>
              {w.repoNwo ?? "⟨unmapped⟩"} {w.slug} <Text dimColor>{w.kind}</Text>
              {w.headSha !== null ? ` ${w.headSha.slice(0, 7)}` : ""}{" "}
              <Text dimColor>{fmtDur(w.ageSeconds)}</Text>
              {w.error !== null ? <Text color={theme.warn}> {w.error}</Text> : null}
            </Text>
          </ClickableBox>
        );
      })}
      {worktrees !== null && worktrees.length > window.end - window.start && (
        <Text dimColor>
          {cursor + 1}/{worktrees.length}
        </Text>
      )}
    </Box>
  );
}

/** Daemon & health detail — a scrollable non-list panel (`scroll` is clamped
 * into `[0, maxScroll(rows, visible)]` before it slices the built rows,
 * mirroring QueueView, so a past-the-end offset lands on the bottom row
 * instead of blanking the pane). Stack-agnostic wording: the endpoint row
 * reads "reachable"/"unreachable" (or a gate-state badge), never a specific
 * server name. */
export function DaemonSection({
  daemon,
  refreshedAt,
  now,
  scroll,
  height,
  focused,
  onWheel,
  onScrollMax,
}: {
  daemon: DaemonDetail | null;
  /** The unified refresh cycle's last-completed stamp (App.tsx refreshedAt) —
   * null when no cycle has landed yet. */
  refreshedAt: string | null;
  now: Date;
  scroll: number;
  height: number;
  focused: boolean;
  onWheel?: (dir: 1 | -1) => void;
  /** Reports `maxScroll(rows, visible)` to the owner DURING render, so the
   * owning hook can clamp its offset without duplicating this row arithmetic. */
  onScrollMax?: (max: number) => void;
}): React.JSX.Element {
  const border = (
    <ClickableBox
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
      onWheel={onWheel}
    />
  );
  if (daemon === null) {
    return React.cloneElement(border, {}, <Text dimColor>loading…</Text>);
  }
  const lines: React.JSX.Element[] = [];
  lines.push(
    <Text key="t" bold color={focused ? theme.accent : undefined}>
      daemon
    </Text>,
  );
  if (daemon.error !== null) {
    lines.push(
      <Text key="err" dimColor wrap="truncate-end">
        unavailable: {daemon.error}
      </Text>,
    );
  }
  const LW = 11;
  lines.push(
    daemon.up ? (
      <StatRow
        key="state"
        label="state"
        value={`up ${fmtDur(daemon.uptimeSeconds)}`}
        labelWidth={LW}
        color={theme.success}
        hint={`pid ${daemon.pid ?? "?"}`}
      />
    ) : (
      <StatRow key="state" label="state" value="down" labelWidth={LW} color={theme.warn} />
    ),
  );
  lines.push(
    <StatRow
      key="refreshed"
      label="refreshed"
      value={refreshedAt !== null ? `↻ ${relTimeShort(refreshedAt, now)} ago` : "—"}
      labelWidth={LW}
      hint="github data"
    />,
  );
  lines.push(<Rule key="r-ep" title="endpoint" width={24} />);
  const gateState = daemon.gate?.state ?? "ok";
  const epColor = GATE_RED.has(gateState)
    ? theme.error
    : GATE_YELLOW.has(gateState)
      ? theme.warn
      : daemon.endpointReachable
        ? theme.success
        : theme.warn;
  lines.push(
    <Text key="ep">
      <Text dimColor>{"endpoint".padEnd(LW)}</Text>
      {gateState !== "ok" ? (
        <Badge label={gateState.replace(/_/g, " ")} color={epColor} />
      ) : (
        <Text bold color={epColor}>
          {daemon.endpointReachable ? "reachable" : "unreachable"}
        </Text>
      )}
    </Text>,
  );
  if (daemon.gate !== null && daemon.gate.state !== "ok" && daemon.gate.reason !== null) {
    lines.push(
      <Text key="gate-r" color={epColor} wrap="truncate-end">
        {" ".repeat(LW)}
        {daemon.gate.reason}
      </Text>,
    );
  }
  lines.push(
    <StatRow
      key="hp"
      label="health"
      value={`${daemon.healthHost}:${daemon.healthPort}`}
      labelWidth={LW}
    />,
  );
  lines.push(<Rule key="r-act" title="activity" width={24} />);
  lines.push(
    <StatRow
      key="g"
      label="guard"
      value={`${daemon.guardNudges ?? 0} nudges · ${daemon.guardKills ?? 0} kills`}
      labelWidth={LW}
    />,
  );
  lines.push(
    <StatRow
      key="tok"
      label="tokens"
      value={`${daemon.tokensIn ?? 0} in · ${daemon.tokensOut ?? 0} out`}
      labelWidth={LW}
    />,
  );
  if (daemon.spend !== null) {
    lines.push(
      <StatRow
        key="spend"
        label="spend"
        value={`$${daemon.spend.todayUsd.toFixed(2)} today`}
        labelWidth={LW}
        hint={
          daemon.spend.dailyBudgetUsd > 0
            ? `of $${daemon.spend.dailyBudgetUsd.toFixed(2)} budget`
            : undefined
        }
      />,
    );
    if (daemon.spend.dailyBudgetUsd > 0) {
      lines.push(
        <Text key="spend-g">
          {" ".repeat(LW)}
          <Gauge
            value={daemon.spend.todayUsd}
            max={daemon.spend.dailyBudgetUsd}
            width={12}
            color={
              daemon.spend.todayUsd / daemon.spend.dailyBudgetUsd >= 0.8 ? theme.warn : theme.info
            }
          />
        </Text>,
      );
    }
  }
  const statuses = Object.entries(daemon.tasksByStatus);
  if (statuses.length > 0) {
    lines.push(
      <StatRow
        key="tbs"
        label="tasks"
        value={statuses.map(([k, v]) => `${k}:${v}`).join(" · ")}
        labelWidth={LW}
      />,
    );
  }
  for (const [id, p] of Object.entries(daemon.progress)) {
    lines.push(
      <Text key={`pg-${id}`} wrap="truncate-end">
        {"  "}
        {queueLabel(null, id)} turn {p.turns}
        {p.lastTool !== null ? ` · ${p.lastTool}` : ""} · {p.outputTokens} tok
      </Text>,
    );
  }
  const visible = Math.max(1, height - 3);
  onScrollMax?.(maxScroll(lines.length, visible));
  const start = clampScroll(scroll, lines.length, visible);
  return React.cloneElement(
    border,
    {},
    <Box flexGrow={1}>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        {lines.slice(start, start + visible)}
      </Box>
      <Scrollbar offset={start} viewport={visible} total={lines.length} height={visible} />
    </Box>,
  );
}
