/**
 * System-section body components for the dashboard: the GitHub outbox op-log,
 * the per-ticket worktrees, and the daemon/health detail, plus the shared
 * section-badge derivation. Near-pure (window/cursor/scroll come in as props)
 * so they render identically as unified-view body arms and in tests.
 * (Relocated from LocalDashboard.tsx — history there.)
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { fmtAge, queueLabel } from "../queueFmt.js";
import { clampScroll, maxScroll } from "../window.js";
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
      return cheap.daemon.up ? "●" : "○";
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

// Provider-gate (Task 9/10) severity buckets for the daemon panel's
// endpoint dot — latched auth/quota/config failures outrank a transient
// rate-limit/outage backoff, which in turn outranks a plain probe miss.
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
 * instead of blanking the pane). Stack-agnostic wording: "inference
 * endpoint", never a specific server. */
export function DaemonSection({
  daemon,
  scroll,
  height,
  focused,
  onWheel,
  onScrollMax,
}: {
  daemon: DaemonDetail | null;
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
  if (!daemon.up) {
    lines.push(
      <Text key="down" color={theme.warn}>
        ○ not running
      </Text>,
    );
  } else {
    lines.push(
      <Text key="pid">
        pid {daemon.pid ?? "?"} · up {fmtDur(daemon.uptimeSeconds)}
      </Text>,
    );
  }
  const gateState = daemon.gate?.state ?? "ok";
  const epColor = GATE_RED.has(gateState)
    ? theme.error
    : GATE_YELLOW.has(gateState)
      ? theme.warn
      : daemon.endpointReachable
        ? theme.success
        : theme.warn;
  const epDot = epColor === theme.success ? "●" : "○";
  lines.push(
    <Text key="ep">
      <Text color={epColor}>{epDot}</Text> inference endpoint
    </Text>,
  );
  if (daemon.gate !== null && daemon.gate.state !== "ok") {
    lines.push(
      <Text key="gate" color={epColor} wrap="truncate-end">
        {daemon.gate.state}
        {daemon.gate.reason !== null ? ` — ${daemon.gate.reason}` : ""}
      </Text>,
    );
  }
  lines.push(
    <Text key="hp" dimColor>
      health {daemon.healthHost}:{daemon.healthPort}
    </Text>,
  );
  lines.push(
    <Text key="g">
      guard: nudges {daemon.guardNudges ?? 0} · kills {daemon.guardKills ?? 0}
    </Text>,
  );
  lines.push(
    <Text key="tok" dimColor>
      tok in {daemon.tokensIn ?? 0} · out {daemon.tokensOut ?? 0}
    </Text>,
  );
  if (daemon.spend !== null) {
    const spendLine =
      daemon.spend.dailyBudgetUsd > 0
        ? `spend $${daemon.spend.todayUsd.toFixed(2)} today / $${daemon.spend.dailyBudgetUsd.toFixed(2)} budget`
        : `spend $${daemon.spend.todayUsd.toFixed(2)} today`;
    lines.push(
      <Text key="spend" dimColor>
        {spendLine}
      </Text>,
    );
  }
  const statuses = Object.entries(daemon.tasksByStatus);
  if (statuses.length > 0) {
    lines.push(<Text key="tbs">{statuses.map(([k, v]) => `${k}:${v}`).join(" · ")}</Text>);
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
  return React.cloneElement(border, {}, lines.slice(start, start + visible));
}
