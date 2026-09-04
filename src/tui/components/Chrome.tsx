import React from "react";
import { Box, Text } from "ink";
import { theme, toastColor, type ToastKind } from "../theme.js";
import type { LayoutMode } from "../layout.js";
import type { HealthInfo } from "../ghClient.js";
import { fmtDurShort } from "../queueFmt.js";
import {
  footerSegments,
  type FooterChip,
  type FooterRow,
  type FooterRows,
} from "../footerModel.js";
import { relTime } from "./IssueList.js";
import { TERMINAL_DONE_STATUSES } from "../../types.js";
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

/** One chip's styled runs (footerModel.footerSegments is the ONE styling
 * model the renderer and the tests share — frames carry no ANSI, so accent
 * placement is asserted there, never from a rendered frame). */
function SegmentText({ chip }: { chip: FooterChip }): React.JSX.Element {
  return (
    <Text>
      {footerSegments(chip).map((s, j) => (
        <Text
          key={j}
          color={s.pill ? theme.pillFg : s.accent ? theme.accent : undefined}
          backgroundColor={s.pill ? theme.accent : s.keycap ? theme.keycapBg : undefined}
          bold={s.pill || s.accent}
          underline={s.underline}
          dimColor={s.dim}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** A run of chips, two columns apart. The spacing is `gap` on the RUN, not a
 * `marginRight` on each chip: a trailing margin on the last chip pushed the
 * pinned run three columns in from the right edge while the label sat one
 * column in from the left (#460). `marginLeft` keeps the two runs apart when
 * the flex spacer between them has shrunk to nothing.
 *
 * One chip with a `chipActions` entry is clickable — pill and mnemonic chips
 * by their mnemonic ID, structural chips by their KEY (which IS their
 * `FooterChip.id`, footerModel.ts); the rest render inert. A separator
 * dispatches nothing at all: it names no key. */
function ChipRun({
  chips,
  chipActions,
  marginLeft = 0,
}: {
  chips: FooterChip[];
  chipActions?: Record<string, () => void>;
  marginLeft?: number;
}): React.JSX.Element {
  return (
    <Box flexShrink={0} gap={2} marginLeft={chips.length > 0 ? marginLeft : 0}>
      {chips.map((chip, i) => {
        const run = chip.kind === "separator" ? undefined : chipActions?.[chip.id];
        const body = <SegmentText chip={chip} />;
        return (
          <Box key={`${chip.id}-${i}`} flexShrink={0}>
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

/** One footer row: dim label in a fixed-width slot, the chips, a spacer, the
 * pinned chips. `overflow="hidden"` + `flexShrink={0}` chips = clip, never
 * wrap — the row is informational and the two-line invariant holds. */
function FooterLine({
  row,
  labelWidth,
  chipActions,
}: {
  row: FooterRow;
  labelWidth: number;
  chipActions?: Record<string, () => void>;
}): React.JSX.Element {
  return (
    <Box paddingX={1} height={1} overflow="hidden">
      <Box width={labelWidth} flexShrink={0} marginRight={2}>
        <Text dimColor wrap="truncate">
          {row.label}
        </Text>
      </Box>
      <ChipRun chips={row.chips} chipActions={chipActions} />
      <Box flexGrow={1} />
      <ChipRun chips={row.pinned} chipActions={chipActions} marginLeft={2} />
    </Box>
  );
}

/** Rows n-1 and n (spec 2026-09-02 §3): actions above, navigate below. A live
 * toast paints over the ACTIONS row for its lifetime (useToast: 4 s or the
 * next keystroke) — navigation is never hidden. Both labels share one slot
 * width so the two chip runs start in the same column. */
export function Footer({
  rows,
  toast,
  chipActions,
}: {
  rows: FooterRows;
  /** Non-null → replaces the ACTIONS row for as long as it lives. */
  toast: { kind: ToastKind; text: string } | null;
  /** Chip click handlers — pill/mnemonic by ID, structural by KEY. */
  chipActions?: Record<string, () => void>;
}): React.JSX.Element {
  const labelWidth = Math.max(rows.actions.label.length, rows.navigate.label.length);
  return (
    <Box flexDirection="column" height={2}>
      {toast ? (
        <Box paddingX={1} height={1} overflow="hidden">
          <Text color={toastColor(toast.kind)} wrap="truncate-end">
            {toast.text.replace(/\s*[\r\n]+\s*/g, " · ")}
          </Text>
        </Box>
      ) : (
        <FooterLine row={rows.actions} labelWidth={labelWidth} chipActions={chipActions} />
      )}
      <FooterLine row={rows.navigate} labelWidth={labelWidth} chipActions={chipActions} />
    </Box>
  );
}
