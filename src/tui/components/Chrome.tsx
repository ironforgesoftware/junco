import React from "react";
import { Box, Text } from "ink";
import { theme, toastColor, type ToastKind } from "../theme.js";
import type { LayoutMode } from "../layout.js";
import type { HealthInfo } from "../ghClient.js";
import { fmtCompact } from "../queueFmt.js";
import { relTime, relTimeShort } from "./IssueList.js";
import { TERMINAL_DONE_STATUSES } from "../../types.js";

export type HintView =
  | "main"
  | "detail"
  | "help"
  | "addRepo"
  | "palette"
  | "cmdOutput"
  | "queue"
  | "prs"
  | "prDetail"
  | "review";

function fmtUp(s: number | null): string {
  if (s === null) return "";
  if (s < 3600) return ` up ${Math.floor(s / 60)}m`;
  return ` up ${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Row 1: brand mark · active repo · (right) the pulse — review count, task
 * record, last task, tokens, bridge errors, daemon, queue, unpushed.
 *
 * One-line invariant (layout.ts budgets exactly CHROME_ROWS): the root Box is
 * height 1, the brand and chip group are flexShrink 0, and the repo name is
 * the ONLY flexible element — it truncates to absorb all width pressure. The
 * chip set is also responsive: below the wide breakpoint the record/last/tok/
 * bridge chips drop (they live in `junco status` for narrow terminals). */
export function Header({
  repoNwo,
  health,
  reviewCount,
  now,
  mode,
  queueRunning,
  queueWaiting,
  watchlistError,
  outboxDepth,
  prAttention,
  prFailing,
  refreshedAt,
}: {
  repoNwo: string | null;
  /** Extended /health snapshot, null before the first poll resolves. */
  health: HealthInfo | null;
  /** Issues (across the repos loaded so far) in plan-ready or approved state. */
  reviewCount: number;
  /** Wall clock for relative-age chips (last task) — polled, not a live clock. */
  now: Date;
  /** Layout mode — non-wide terminals render only the essential chips. */
  mode: LayoutMode;
  queueRunning: number;
  queueWaiting: number;
  watchlistError: string | null;
  /** Ops parked in the GitHub outbox — hidden at 0. */
  outboxDepth: number;
  /** junco-authored PRs needing attention (checks-failing or changes-requested)
   * across the watched repos loaded so far — hidden at 0. */
  prAttention: number;
  /** True when any of those PRs is checks-failing — picks the chip's color. */
  prFailing: boolean;
  /** Last completed unified refresh cycle (oldest cache age when any source
   * was served offline) — the top bar's single ↻ stamp. Null until the first
   * cycle completes. */
  refreshedAt: string | null;
}): React.JSX.Element {
  const wide = mode === "wide";
  const daemonUp = health === null ? null : health.up;
  const daemon =
    daemonUp === null
      ? "daemon …"
      : daemonUp
        ? `daemon ●${fmtUp(health?.uptimeSeconds ?? null)}`
        : "daemon ○";
  const lastStatus = health?.lastTaskStatus ?? null;
  const lastGood = lastStatus !== null && TERMINAL_DONE_STATUSES.has(lastStatus);
  const lastTaskAt = health?.lastTaskAt ?? null;
  const totalTokensOut = health?.totalTokensOut ?? null;
  const bridgeErrors = health?.bridgeErrors ?? null;
  return (
    <Box paddingX={1} gap={2} height={1}>
      <Box flexShrink={0}>
        <Text>🐦</Text>
        <Text> </Text>
        <Text bold color={theme.accent}>
          junco
        </Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text bold wrap="truncate">
          {repoNwo ?? "no repo"}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} gap={2}>
        {watchlistError !== null && <Text color={theme.warn}>watchlist!</Text>}
        {reviewCount > 0 && <Text color={theme.warn}>●{reviewCount} review</Text>}
        {prAttention > 0 && (
          <Text color={prFailing ? theme.error : theme.warn}>⚑{prAttention} PR</Text>
        )}
        {wide && health?.up && (
          <Text>
            <Text color={theme.success}>✓{health.tasksSucceeded ?? 0}</Text>
            {(health.tasksFailed ?? 0) > 0 && (
              <Text color={theme.error}> ✗{health.tasksFailed}</Text>
            )}
          </Text>
        )}
        {wide && lastTaskAt !== null && (
          <Text>
            last <Text color={lastGood ? theme.success : theme.error}>{lastGood ? "✓" : "✗"}</Text>{" "}
            {relTime(lastTaskAt, now)}
          </Text>
        )}
        {wide && totalTokensOut !== null && totalTokensOut > 0 && (
          <Text dimColor>tok {fmtCompact(totalTokensOut)}</Text>
        )}
        {wide && bridgeErrors !== null && bridgeErrors > 0 && (
          <Text color={theme.warn}>bridge ✗{bridgeErrors}</Text>
        )}
        <Text color={daemonUp ? theme.success : theme.warn}>{daemon}</Text>
        {refreshedAt !== null && <Text dimColor>↻ {relTimeShort(refreshedAt, now)}</Text>}
        {queueRunning + queueWaiting > 0 && (
          <Text color={theme.info}>
            ◐{queueRunning} ⏳{queueWaiting}
          </Text>
        )}
        {outboxDepth > 0 && <Text color={theme.warn}>⇡{outboxDepth} unpushed</Text>}
      </Box>
    </Box>
  );
}

/** Row n-1: reserved single toast row (stable layout — blank when idle). */
export function Toast({
  toast,
}: {
  toast: { kind: ToastKind; text: string } | null;
}): React.JSX.Element {
  return (
    <Box paddingX={1} height={1}>
      {toast ? (
        <Text color={toastColor(toast.kind)} wrap="truncate-end">
          {toast.text.replace(/\s*[\r\n]+\s*/g, " · ")}
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}

/** Row n: context key hints — accent key, muted label, graceful truncation. */
export function Footer({ hints }: { hints: [string, string][] }): React.JSX.Element {
  return (
    <Box paddingX={1} height={1}>
      <Text wrap="truncate-end">
        {hints.map(([k, label], i) => (
          <Text key={k}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text color={theme.accent}>{k}</Text>
            <Text dimColor> {label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/** The full key set for the current context (the ? modal is the long form). */
export function hintsFor(
  view: HintView,
  pane: 1 | 2 | 3,
  mode: LayoutMode,
  filtering: boolean,
): [string, string][] {
  if (filtering) {
    return [
      ["type", "filter"],
      ["enter", "apply"],
      ["esc", "clear"],
    ];
  }
  switch (view) {
    case "detail":
      return [
        ["↑/↓", "scroll"],
        ["o", "browser"],
        ["esc", "back"],
      ];
    case "queue":
      return [
        ["↑/↓", "scroll"],
        ["esc/t", "back"],
      ];
    case "prs":
      return [
        ["↑/↓", "move"],
        ["enter", "detail"],
        ["o", "browser"],
        ["esc/p", "back"],
      ];
    case "prDetail":
      return [
        ["esc", "back"],
        ["o", "browser"],
      ];
    case "review":
      return [
        ["↑/↓", "move"],
        ["enter", "open/file"],
        ["space", "toggle"],
        ["a/n", "all/none"],
        ["f", "file"],
        ["esc", "back"],
      ];
    case "palette":
      return [
        ["type", "filter"],
        ["↑/↓", "move"],
        ["enter", "run"],
        ["esc", "close"],
      ];
    case "cmdOutput":
      return [
        ["↑/↓", "scroll"],
        ["r", "re-run"],
        ["esc", "back"],
      ];
    case "addRepo":
      return [
        ["enter", "next/submit"],
        ["esc", "cancel"],
      ];
    case "help":
      return [["any key", "close"]];
    case "main":
      break;
  }
  if (pane === 1) {
    return [
      ["↑/↓", "move"],
      ["→", "issues"],
      ["w", "add repo"],
      ["x", "unwatch"],
      ["o", "browser"],
      ["r", "refresh"],
      ["s", "assess"],
      [":", "commands"],
      ["?", "help"],
      ["q", "quit"],
    ];
  }
  if (pane === 3) {
    return [
      ["↑/↓", "move"],
      ["enter", "detail"],
      ["←", "issues"],
      ["o", "browser"],
      ["?", "help"],
      ["q", "quit"],
    ];
  }
  const panesHint: [string, string] = mode === "wide" ? ["←/→", "panes"] : ["←", "repos"];
  return [
    ["↑/↓", "move"],
    panesHint,
    ["enter", "preview"],
    ["d", "dispatch"],
    ["a", "approve"],
    ["/", "filter"],
    ["t", "queue"],
    ["p", "PRs"],
    ["?", "help"],
    ["q", "quit"],
  ];
}
