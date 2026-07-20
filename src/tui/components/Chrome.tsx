import React from "react";
import { Box, Text } from "ink";
import { theme, toastColor, type ToastKind } from "../theme.js";
import type { LayoutMode } from "../layout.js";
import type { HealthInfo } from "../ghClient.js";
import { fmtCompact } from "../queueFmt.js";
import { relTime, relTimeShort } from "./IssueList.js";
import { TERMINAL_DONE_STATUSES } from "../../types.js";
import type { UiMode } from "../geometry.js";
import type { LocalSection } from "../localSnapshot.js";
import { ClickableBox } from "../ClickableBox.js";

export type HintView =
  | "main"
  | "detail"
  | "help"
  | "addRepo"
  | "config"
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
  uiMode,
  githubEnabled,
  onModeTab,
  updateLatest,
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
  /** Present only in the two-mode App; absent → legacy single-surface header
   * (byte-identical to pre-Stage-E rendering — no tab segment at all). */
  uiMode?: UiMode;
  /** When false the GITHUB tab dims (the mode is off in config). */
  githubEnabled?: boolean;
  /** Click handler for the GITHUB/LOCAL tabs (region-based; Task 5). */
  onModeTab?: (m: UiMode) => void;
  /** Latest npm version when newer than the running one; null/absent → no chip. */
  updateLatest?: string | null;
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
  // Fixed-width tab labels ("[GITHUB]"/"[G]" = 8/3, "[LOCAL]"/"[L]" = 7/3): the
  // inactive (unbracketed, shorter) label pads out to the SAME column width as
  // the active one so toggling modes never reflows the row. Purely
  // presentational now — clicks resolve against each tab's own ClickableBox
  // region (no mirrored hit-test bands to keep in lockstep).
  const ghWidth = wide ? 8 : 3;
  const loWidth = wide ? 7 : 3;
  const ghLabel =
    uiMode === "github" ? (wide ? "[GITHUB]" : "[G]") : (wide ? "github" : "g").padEnd(ghWidth);
  const loLabel =
    uiMode === "local" ? (wide ? "[LOCAL]" : "[L]") : (wide ? "local" : "l").padEnd(loWidth);
  return (
    <Box paddingX={1} gap={2} height={1}>
      <Box flexShrink={0}>
        <Text>🐦</Text>
        <Text> </Text>
        <Text bold color={theme.accent}>
          junco
        </Text>
      </Box>
      {uiMode !== undefined && (
        <Box flexShrink={0}>
          <ClickableBox
            onPress={onModeTab ? () => onModeTab("github") : undefined}
            hoverBg={theme.hoverBg}
          >
            <Text
              color={uiMode === "github" ? theme.accent : undefined}
              bold={uiMode === "github"}
              dimColor={githubEnabled === false}
            >
              {ghLabel}
            </Text>
          </ClickableBox>
          <Text> </Text>
          <ClickableBox
            onPress={onModeTab ? () => onModeTab("local") : undefined}
            hoverBg={theme.hoverBg}
          >
            <Text color={uiMode === "local" ? theme.accent : undefined} bold={uiMode === "local"}>
              {loLabel}
            </Text>
          </ClickableBox>
        </Box>
      )}
      <Box flexShrink={1} minWidth={0}>
        <Text bold wrap="truncate">
          {repoNwo ?? "no repo"}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} gap={2}>
        {wide && updateLatest != null && <Text color={theme.accent}>⬆ v{updateLatest}</Text>}
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

/** Row n: context key hints — accent key, muted label. Each hint is a
 * flexShrink-0 chip; a chip whose hint KEY has an `actions` entry is
 * clickable (mouse-driven ftue), the rest render inert. Overflow clips
 * (no ellipsis) rather than truncating — the row is informational and the
 * layout invariant (height 1, no wrap) still holds. */
export function Footer({
  hints,
  actions,
}: {
  hints: [string, string][];
  actions?: Record<string, () => void>;
}): React.JSX.Element {
  return (
    <Box paddingX={1} height={1} overflow="hidden">
      {hints.map(([k, label], i) => {
        const run = actions?.[k];
        const chip = (
          <Text>
            <Text color={theme.accent}>{k}</Text>
            <Text dimColor> {label}</Text>
          </Text>
        );
        return (
          <Box key={k} flexShrink={0}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            {run ? (
              <ClickableBox onPress={run} hoverBg={theme.hoverBg}>
                {chip}
              </ClickableBox>
            ) : (
              chip
            )}
          </Box>
        );
      })}
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
        ["f", "file/post"],
        ["x", "discard"],
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
    case "config":
      return [
        ["↑/↓", "field"],
        ["←/→", "section"],
        ["enter", "edit/toggle"],
        ["esc", "close"],
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
      ["m", "local"],
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
    ["c", "analyze"],
    ["/", "filter"],
    ["t", "queue"],
    ["p", "PRs"],
    ["s", "assess issue"],
    [",", "config"],
    ["m", "local"],
    ["?", "help"],
    ["q", "quit"],
  ];
}

/** Local-mode key hints — GitHub `hintsFor` is untouched; this is a sibling
 * for the LOCAL surface. `m`/Shift+Tab is the global mode swap (also in the
 * github main set so it is discoverable from both sides). */
export function localHintsFor(section: LocalSection, focus: "rail" | "body"): [string, string][] {
  if (focus === "rail") {
    return [
      ["↑/↓", "section"],
      ["→", "open"],
      ["m", "github"],
      ["r", "refresh"],
      ["?", "help"],
      ["q", "quit"],
    ];
  }
  switch (section) {
    case "queue":
      return [
        ["↑/↓", "move"],
        ["R", "requeue"],
        ["x", "delete"],
        ["←", "back"],
      ];
    case "outbox":
      return [
        ["↑/↓", "move"],
        ["f", "flush"],
        ["←", "back"],
      ];
    case "repos":
      return [
        ["↑/↓", "move"],
        ["o", "browser"],
        ["x", "unwatch"],
        ["←", "back"],
      ];
    case "worktrees":
      return [
        ["↑/↓", "move"],
        ["x", "prune"],
        ["←", "back"],
      ];
    case "daemon":
      return [
        ["[/]", "scroll"],
        ["X", "restart"],
        ["f", "flush"],
        ["←", "back"],
      ];
    case "logs":
      // Compact tail: → / Enter (or a click on the pane, or a click-again on the
      // rail row) opens the full-screen overlay; `←` returns to the rail.
      return [["←", "back"]];
  }
}

/** What pane 2 currently shows in the unified view — mirrors railModel's
 * BodyKind with sections flattened for hint lookup. */
export type BodyHintKind =
  | "issues"
  | "repoDetail"
  | "queue"
  | "outbox"
  | "worktrees"
  | "daemon"
  | "logs";

/** Single-surface hint sets for the unified view. Non-main views delegate to
 * hintsFor verbatim; main is pane- and body-kind-aware. Replaces the
 * hintsFor/localHintsFor pair once App swaps over (unified-view spec §3). */
export function hintsForUnified(
  view: HintView,
  bodyKind: BodyHintKind,
  pane: 1 | 2 | 3,
  mode: LayoutMode,
  filtering: boolean,
): [string, string][] {
  if (filtering || view !== "main") return hintsFor(view, pane, mode, filtering);
  // Pane 1 (rail): one row's worth of chips — enter (repo detail) and → (body
  // focus) live in the help modal instead; the row must not clip `q quit` at
  // the 120-col test width (Footer clips, never wraps).
  if (pane === 1) {
    return [
      ["↑/↓", "move"],
      ["w", "add repo"],
      ["x", "unwatch"],
      ["o", "browser"],
      ["r", "refresh"],
      ["s", "assess"],
      ["t", "queue"],
      [":", "commands"],
      ["?", "help"],
      ["q", "quit"],
    ];
  }
  if (pane === 3) return hintsFor("main", 3, mode, false);
  switch (bodyKind) {
    case "issues":
      // Pane-2 issue verbs minus the dead mode toggle and the t queue-view
      // key (t now jumps the RAIL cursor, so it reads as a rail hint).
      return hintsFor("main", 2, mode, false).filter(([k]) => k !== "m" && k !== "t");
    case "repoDetail":
      return [
        ["[ ]", "scroll"],
        ["o", "browser"],
        ["←", "back"],
      ];
    case "queue":
      return [
        ["↑/↓", "move"],
        ["R", "requeue"],
        ["x", "delete"],
        ["←", "back"],
      ];
    case "outbox":
      return [
        ["↑/↓", "move"],
        ["f", "flush"],
        ["←", "back"],
      ];
    case "worktrees":
      return [
        ["↑/↓", "move"],
        ["x", "prune"],
        ["←", "back"],
      ];
    case "daemon":
      return [
        ["[/]", "scroll"],
        ["X", "restart"],
        ["f", "flush"],
        ["←", "back"],
      ];
    case "logs":
      return [
        ["enter", "open log"],
        ["←", "back"],
      ];
  }
}
