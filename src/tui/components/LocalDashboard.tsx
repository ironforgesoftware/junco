import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { fmtAge, queueLabel } from "../queueFmt.js";
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

const SECTIONS: readonly LocalSection[] = ["queue", "outbox", "repos", "worktrees", "daemon"];

/** Compact live badge for a section, derived from the cheap/heavy snapshots.
 * Empty string → no badge (hidden at zero). */
function sectionBadge(s: LocalSection, cheap: LocalCheap | null, heavy: LocalHeavy | null): string {
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
}: {
  section: LocalSection;
  focus: "rail" | "body";
  cheap: LocalCheap | null;
  heavy: LocalHeavy | null;
  width: number;
  height: number;
  now: Date;
  refreshedAt?: string | null;
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
          <Box key={s} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate">
              {s}
              {badge ? `  ${badge}` : ""}
            </Text>
          </Box>
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

/** GitHub outbox op-log: live ops (selectable) with the cursor op's lastError
 * expanded, plus a read-only dead tail. Mirrors outboxCmd's opLine format. */
export function OutboxSection({
  outbox,
  cursor,
  window,
  height,
  focused,
  now,
}: {
  outbox: LocalCheap["outbox"] | null;
  cursor: number;
  window: { start: number; end: number };
  height: number;
  focused: boolean;
  now: Date;
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
      <Box key={s.id} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
        <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
        <Text wrap="truncate-end">
          {fmtAge(s.createdAt, now)} {s.op.kind} {target}
          <Text dimColor> attempts={s.attempts}</Text>
        </Text>
      </Box>,
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
}: {
  repos: LocalRepo[] | null;
  error: string | null;
  cursor: number;
  window: { start: number; end: number };
  height: number;
  focused: boolean;
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
          <Box key={r.path} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
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
          </Box>
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
}: {
  worktrees: LocalWorktree[] | null;
  error: string | null;
  cursor: number;
  window: { start: number; end: number };
  height: number;
  focused: boolean;
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
          <Box key={w.path} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate-end" dimColor={dim}>
              {w.repoNwo ?? "⟨unmapped⟩"} {w.slug} <Text dimColor>{w.kind}</Text>
              {w.headSha !== null ? ` ${w.headSha.slice(0, 7)}` : ""}{" "}
              <Text dimColor>{fmtDur(w.ageSeconds)}</Text>
              {w.error !== null ? <Text color={theme.warn}> {w.error}</Text> : null}
            </Text>
          </Box>
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

/** Daemon & health detail — a scrollable non-list panel (`scroll` slices the
 * built rows, mirroring QueueView). Stack-agnostic wording: "inference
 * endpoint", never a specific server. */
export function DaemonSection({
  daemon,
  scroll,
  height,
  focused,
}: {
  daemon: DaemonDetail | null;
  scroll: number;
  height: number;
  focused: boolean;
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
  lines.push(
    <Text key="ep">
      <Text color={daemon.endpointReachable ? theme.success : theme.warn}>
        {daemon.endpointReachable ? "●" : "○"}
      </Text>{" "}
      inference endpoint
    </Text>,
  );
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
  return React.cloneElement(border, {}, lines.slice(scroll, scroll + Math.max(1, height - 3)));
}
