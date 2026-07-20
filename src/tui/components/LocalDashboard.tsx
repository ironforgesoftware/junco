import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { fmtAge, queueLabel } from "../queueFmt.js";
import { QueueView } from "./QueueView.js";
import { LogView } from "./LogView.js";
import { windowSlice, clampScroll, maxScroll } from "../window.js";
import { listRowsHeight } from "../geometry.js";
import { RAIL_WIDTH, type Layout } from "../layout.js";
import type { LogEntry } from "../../logReader.js";
import type {
  LocalCheap,
  LocalHeavy,
  LocalSection,
  LocalRepo,
  LocalWorktree,
  DaemonDetail,
} from "../localSnapshot.js";

// LocalSection already lives in localSnapshot.ts (it gates the cheap-tick
// `section` option) — re-export rather than redeclare so the union has one
// source of truth.
export type { LocalSection } from "../localSnapshot.js";
export type { UiMode } from "../geometry.js";

const SECTIONS: readonly LocalSection[] = [
  "queue",
  "outbox",
  "repos",
  "worktrees",
  "daemon",
  "logs",
];

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

/** LOCAL section rail — a fixed 5-row list (never windowed), rendered like the
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

/** Duration from whole seconds: `13m`, `2h13m`, `-` for null. */
function fmtDur(s: number | null): string {
  if (s === null) return "-";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Truncate a long path from the start so the meaningful tail (repo dir)
 * survives: `…/repos/acme-api`. */
function truncStart(p: string, max: number): string {
  return p.length <= max ? p : "…" + p.slice(p.length - max + 1);
}

const SOURCE_TAG: Record<LocalRepo["source"], string> = {
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
      <LogView
        variant="section"
        entries={logEntries ?? []}
        height={h}
        focused={bodyFocused}
        hasFile={logHasFile ?? true}
        onExpand={onLogExpand}
        onWheel={onDaemonWheel}
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
