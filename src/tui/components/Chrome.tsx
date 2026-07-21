import React from "react";
import { Box, Text } from "ink";
import { theme, toastColor, type ToastKind } from "../theme.js";
import type { LayoutMode } from "../layout.js";
import type { HealthInfo } from "../ghClient.js";
import { fmtDurShort } from "../queueFmt.js";
import { relTime } from "./IssueList.js";
import { TERMINAL_DONE_STATUSES } from "../../types.js";
import type { Chip } from "../viewActions.js";
import { ClickableBox } from "../ClickableBox.js";
import type { QueueStats } from "../queueStats.js";

function fmtUp(s: number | null): string {
  if (s === null) return "";
  if (s < 3600) return ` up ${Math.floor(s / 60)}m`;
  return ` up ${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Row 1: brand mark · breadcrumb trail · (right) the pulse. The trail is
 * crumbs joined by a dim "▸" — the only flexible element in the row. The
 * pulse is four groups — warnings │ record (24h + last) │ live (run + eta) │
 * system (daemon/queue/unpushed) — each joined to the next by a dim "│".
 *
 * One-line invariant (layout.ts budgets exactly CHROME_ROWS): the root Box is
 * height 1, the brand and chip group are flexShrink 0, and the breadcrumb
 * trail truncates to absorb all width pressure. The chip set is also
 * responsive: below the wide breakpoint, the wide-only members of each group
 * drop (they live in `junco status` for narrow terminals). */
export function Header({
  crumbs,
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
  updateLatest,
  stats,
  runningIds,
}: {
  crumbs: string[];
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
  /** Latest npm version when newer than the running one; null/absent → no chip. */
  updateLatest?: string | null;
  /** Derived queue stats (task-history ledger + /health gate/spend/guards) —
   * null before the first snapshot resolves. */
  stats: QueueStats | null;
  /** IDs of the currently-running tickets, in running order. */
  runningIds: string[];
}): React.JSX.Element {
  const wide = mode === "wide";
  const daemonUp = health === null ? null : health.up;
  const daemon =
    daemonUp === null
      ? "daemon …"
      : daemonUp
        ? `daemon${fmtUp(health?.uptimeSeconds ?? null)}`
        : "daemon down";
  const lastStatus = health?.lastTaskStatus ?? null;
  const lastGood = lastStatus !== null && TERMINAL_DONE_STATUSES.has(lastStatus);
  const lastTaskAt = health?.lastTaskAt ?? null;
  const bridgeErrors = health?.bridgeErrors ?? null;

  const w = stats?.window24h ?? null;
  const gate = stats?.gate ?? null;
  const warnChips: React.JSX.Element[] = [];
  if (wide && updateLatest != null)
    warnChips.push(
      <Text key="up" color={theme.accent}>
        ⬆ v{updateLatest}
      </Text>,
    );
  if (watchlistError !== null)
    warnChips.push(
      <Text key="wl" color={theme.warn}>
        watchlist!
      </Text>,
    );
  if (gate !== null && gate.state !== "ok")
    warnChips.push(
      <Text key="gate" color={theme.warn}>
        gate ⚠ {(gate.reason ?? gate.state.replace(/_/g, " ")).slice(0, 24)}
      </Text>,
    );
  if ((stats?.pendingRestartFields.length ?? 0) > 0)
    warnChips.push(
      <Text key="rp" color={theme.warn}>
        restart pending
      </Text>,
    );
  if (wide && bridgeErrors !== null && bridgeErrors > 0)
    warnChips.push(
      <Text key="br" color={theme.warn}>
        bridge ✗{bridgeErrors}
      </Text>,
    );
  if (reviewCount > 0)
    warnChips.push(
      <Text key="rv" color={theme.warn}>
        ●{reviewCount} review
      </Text>,
    );
  if (prAttention > 0)
    warnChips.push(
      <Text key="pr" color={prFailing ? theme.error : theme.warn}>
        ⚑{prAttention} PR
      </Text>,
    );

  const recordChips: React.JSX.Element[] = [];
  if (wide && w !== null && w.done + w.failed > 0)
    recordChips.push(
      <Text key="24h">
        24h <Text color={theme.success}>✓{w.done}</Text>{" "}
        <Text color={w.failed > 0 ? theme.error : undefined}>✗{w.failed}</Text>
        {w.successRate !== null ? ` ${Math.round(w.successRate * 100)}%` : ""}
      </Text>,
    );
  if (wide && lastTaskAt !== null)
    recordChips.push(
      <Text key="last">
        last <Text color={lastGood ? theme.success : theme.error}>{lastGood ? "✓" : "✗"}</Text>{" "}
        {relTime(lastTaskAt, now)}
      </Text>,
    );

  const liveChips: React.JSX.Element[] = [];
  if (runningIds.length > 0)
    liveChips.push(
      <Text key="run" color={theme.info}>
        ▸ {runningIds[0].slice(0, 20)}
        {runningIds.length > 1 ? ` +${runningIds.length - 1}` : ""}
      </Text>,
    );
  if (wide && queueWaiting > 0 && stats?.etaSeconds != null && stats.etaSeconds !== 0)
    liveChips.push(
      <Text key="eta" dimColor>
        eta {fmtDurShort(stats.etaSeconds)}
      </Text>,
    );

  const systemChips: React.JSX.Element[] = [];
  systemChips.push(
    <Text key="d" color={daemonUp ? theme.success : theme.warn}>
      {daemon}
    </Text>,
  );
  if (queueRunning + queueWaiting > 0)
    systemChips.push(
      <Text key="q" color={theme.info}>
        ◐{queueRunning} ⏳{queueWaiting}
      </Text>,
    );
  if (outboxDepth > 0)
    systemChips.push(
      <Text key="ob" color={theme.warn}>
        ⇡{outboxDepth} unpushed
      </Text>,
    );

  const groups = [warnChips, recordChips, liveChips, systemChips].filter((g) => g.length > 0);

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
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <Text dimColor> ▸ </Text> : null}
              {c}
            </React.Fragment>
          ))}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} gap={1}>
        {groups.map((g, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 ? <Text dimColor>│</Text> : null}
            <Box gap={2}>{g}</Box>
          </React.Fragment>
        ))}
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
