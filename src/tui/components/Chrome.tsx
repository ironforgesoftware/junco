import React from "react";
import { Box, Text } from "ink";
import { theme, toastColor, type ToastKind } from "../theme.js";
import type { LayoutMode } from "../layout.js";
import type { HealthInfo } from "../ghClient.js";
import { fmtCompact } from "../queueFmt.js";
import { relTime, relTimeShort } from "./IssueList.js";
import { TERMINAL_DONE_STATUSES } from "../../types.js";
import type { Chip } from "../viewActions.js";
import { ClickableBox } from "../ClickableBox.js";

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

/** Pure segment split for one chip — the mnemonic renderer's core, exported
 * for structural tests (frames strip ANSI, so accent PLACEMENT is asserted
 * here, not from rendered frames). Mnemonic chips render their label with the
 * winning char in accent (uppercased in place when guarded — the shift cue);
 * structural chips and charIndex-null mnemonics render key-first. */
export function chipSegments(chip: Chip): { text: string; accent: boolean }[] {
  if (chip.kind === "mnemonic" && chip.charIndex !== null) {
    const i = chip.charIndex;
    const ch = chip.guarded ? chip.label[i].toUpperCase() : chip.label[i];
    return [
      ...(i > 0 ? [{ text: chip.label.slice(0, i), accent: false }] : []),
      { text: ch, accent: true },
      ...(i + 1 < chip.label.length ? [{ text: chip.label.slice(i + 1), accent: false }] : []),
    ];
  }
  return [
    { text: chip.key, accent: true },
    { text: ` ${chip.label}`, accent: false },
  ];
}

/** Row n: the context's chips (viewActions) — mnemonic labels with the
 * derived key's character in accent, structural keys key-first. A chip with a
 * `chipActions` entry (mnemonic → by ID, structural → by KEY) is clickable;
 * the rest render inert. Overflow clips (no ellipsis) rather than truncating
 * — the row is informational and the one-line layout invariant holds. */
export function Footer({
  chips,
  chipActions,
}: {
  chips: Chip[];
  chipActions?: Record<string, () => void>;
}): React.JSX.Element {
  {
    return (
      <Box paddingX={1} height={1} overflow="hidden">
        {chips.map((chip, i) => {
          const id = chip.kind === "mnemonic" ? chip.id : chip.key;
          const run = chipActions?.[id];
          const body = (
            <Text>
              {chipSegments(chip).map((seg, j) => (
                <Text key={j} color={seg.accent ? theme.accent : undefined} dimColor={!seg.accent}>
                  {seg.text}
                </Text>
              ))}
            </Text>
          );
          return (
            <Box key={`${id}-${i}`} flexShrink={0}>
              {i > 0 ? <Text dimColor> · </Text> : null}
              {run ? (
                <ClickableBox onPress={run} hoverBg={theme.hoverBg}>
                  {body}
                </ClickableBox>
              ) : (
                body
              )}
            </Box>
          );
        })}
      </Box>
    );
  }
}
