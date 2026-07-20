import React from "react";
import { Box, Text } from "ink";
import type { QueueSnapshot, QueueWaiting } from "../queueSnapshot.js";
import {
  queueLabel,
  progressLine,
  fmtAge,
  fmtAgeShort,
  fmtClock,
  fmtCompact,
  fmtDurShort,
  fmtSpark,
  oldestQueuedAt,
} from "../queueFmt.js";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { clampScroll, maxScroll } from "../window.js";

/** A running row is flagged stalled when its last progress update is older than
 * this — the supervisor's nudge window, surfaced so the operator sees a wedged
 * task before the guard escalates. */
const STALL_MS = 5 * 60_000;

function waitingNote(w: QueueWaiting): string {
  const parts: string[] = [];
  if (w.priority !== "normal") parts.push(w.priority);
  if (w.retryCount > 0) parts.push(`retry ${w.retryCount}`);
  if (w.notBefore !== null) parts.push(`not before ${fmtClock(w.notBefore)}`);
  if (w.deferred) parts.push("⏲ deferred");
  return parts.join(" · ");
}

/** Full queue view (main-area slot, opened with `t`): RUNNING / WAITING /
 * RECENT built as flat rows so App's scroll offset can slice them. In LOCAL
 * mode `selectable` turns on a `▌` accent cursor over the actionable rows
 * (WAITING then RECENT, `selectedRow` indexing that concatenation); RUNNING
 * rows render but are never selectable, and the window follows the cursor so a
 * selected row past the fold stays visible. `counts` (LOCAL only) surfaces the
 * full done/failed totals the capped RECENT list can't show. Absent props →
 * byte-identical to the GitHub `t` view. */
export function QueueView({
  snap,
  scroll,
  now,
  height,
  focused,
  selectable,
  selectedRow,
  counts,
  onRowPress,
  onScrollMax,
}: {
  snap: QueueSnapshot | null;
  scroll: number;
  now: Date;
  height: number;
  focused: boolean;
  selectable?: boolean;
  selectedRow?: number;
  /** Full done/failed totals (LOCAL queue section only); absent for the GitHub
   * `t` view, which then renders byte-identically. */
  counts?: { done: number; failed: number } | null;
  /** Actionable-row index: waiting `i`, recent `waiting.length + j`. Only
   * wired when `selectable` — absent/false keeps the GitHub `t` view's rows
   * bare (byte-identical). */
  onRowPress?: (row: number) => void;
  /** Reports `maxScroll(rows, visible)` to the owner DURING render, so the
   * owning hook can clamp its offset without duplicating this row arithmetic. */
  onScrollMax?: (max: number) => void;
}): React.JSX.Element {
  if (snap === null) {
    return (
      <Box
        borderStyle="round"
        borderColor={focused ? theme.accent : theme.border}
        paddingX={1}
        flexGrow={1}
        height={height}
      >
        <Text dimColor>queue — loading…</Text>
      </Box>
    );
  }

  // Leading 2-col gutter. With `selectable` the first col becomes the `▌`
  // accent cursor on the selected actionable row; otherwise it is the exact
  // two-space indent the GitHub `t` view has always rendered (byte-identical).
  const gutter = (sel: boolean): React.JSX.Element | string =>
    selectable ? (
      <>
        <Text color={theme.accent}>{sel ? "▌" : " "}</Text>{" "}
      </>
    ) : (
      "  "
    );

  const rows: React.JSX.Element[] = [];
  // Row-array index of the selected actionable row, recorded as it is pushed —
  // headers/RUNNING rows shift it, so only this build knows the true position.
  // Drives the cursor-following window below (null on the non-selectable path).
  let selRowIndex: number | null = null;
  const dash = (key: string): void => {
    rows.push(
      <Text key={key} dimColor>
        {"  "}—
      </Text>,
    );
  };

  // Wraps an actionable row's Text in a ClickableBox when `selectable` — the
  // non-selectable GitHub `t` view never wraps, so its rows stay byte-
  // identical to before mouse support existed. Hover on the selected row keeps
  // its selectionBg (the binding rule everywhere: sel ? selectionBg : hoverBg).
  const pressable = (
    row: number,
    sel: boolean,
    child: React.JSX.Element,
    key: string,
  ): React.JSX.Element =>
    selectable === true && onRowPress ? (
      <ClickableBox
        key={key}
        hoverBg={sel ? theme.selectionBg : theme.hoverBg}
        onPress={() => onRowPress(row)}
      >
        {child}
      </ClickableBox>
    ) : (
      child
    );

  const st = snap.stats;

  rows.push(
    <Text key="title" bold color={focused ? theme.accent : undefined}>
      queue
    </Text>,
  );

  // Paused banner: the daemon's gate is anything but healthy. `until` (a rate-
  // limit retry stamp) wins the suffix; else the free-text reason; else bare.
  const gate = st?.gate ?? null;
  if (gate !== null && gate.state !== "ok") {
    const label = gate.state.replace(/_/g, " ");
    const suffix =
      gate.until !== null
        ? ` (retry ${fmtClock(gate.until)})`
        : gate.reason !== null
          ? ` — ${gate.reason}`
          : "";
    rows.push(
      <Text key="paused" color={theme.warn} wrap="truncate-end">
        {`▸ paused — ${label}${suffix}`}
      </Text>,
    );
  }

  // Poll heartbeat: only meaningful while the daemon is actually up (a stale
  // lastPollAt from a since-stopped daemon would read as a live tick).
  const pollAge =
    snap.daemonUp && st !== null && st.lastPollAt !== null ? fmtAge(st.lastPollAt, now) : null;
  rows.push(
    <Text key="run-h" bold>
      RUNNING ({snap.running.length}/{snap.maxConcurrent})
      {pollAge !== null ? <Text dimColor>{` · ↻ poll ${pollAge}`}</Text> : null}
    </Text>,
  );
  if (snap.running.length === 0) dash("run-none");
  for (const r of snap.running) {
    rows.push(
      <Text key={`r-${r.id}`} wrap="truncate-end">
        {gutter(false)}
        <Text color="cyan">◐ </Text>
        <Text bold>{queueLabel(r.github, r.id)}</Text>
        <Text dimColor> {r.id}</Text>
      </Text>,
    );
    rows.push(
      <Text key={`rp-${r.id}`} dimColor wrap="truncate-end">
        {"     "}
        {progressLine(r, now)}
      </Text>,
    );
    // Stall warning, aligned under the progress line. Never for stale rows
    // (daemon down — their updatedAt is a fallback null anyway) and only past
    // the nudge window.
    if (!r.stale && r.updatedAt !== null && now.getTime() - Date.parse(r.updatedAt) >= STALL_MS) {
      rows.push(
        <Text key={`rs-${r.id}`} color={theme.warn} wrap="truncate-end">
          {`     ⚠ no activity ${fmtAgeShort(r.updatedAt, now)}`}
        </Text>,
      );
    }
  }

  rows.push(
    <Text key="wait-h" bold>
      {" "}
    </Text>,
  );
  const deferredCount = snap.waiting.filter((w) => w.deferred).length;
  const oldestQ = oldestQueuedAt(snap.waiting);
  const waitSegs = [String(snap.waiting.length)];
  if (deferredCount > 0) waitSegs.push(`${deferredCount} deferred`);
  if (oldestQ !== null) waitSegs.push(`oldest ${fmtAgeShort(oldestQ, now)}`);
  rows.push(
    <Text key="wait-h2" bold>
      {`WAITING (${waitSegs.join(" · ")})`}
    </Text>,
  );
  if (snap.waiting.length === 0) dash("wait-none");
  snap.waiting.forEach((w, i) => {
    const note = waitingNote(w);
    const sel = selectable === true && selectedRow === i;
    if (sel) selRowIndex = rows.length;
    rows.push(
      pressable(
        i,
        sel,
        <Text key={`w-${w.id}`} wrap="truncate-end">
          {gutter(sel)}
          {i + 1}. <Text bold>{queueLabel(w.github, w.id)}</Text>
          <Text dimColor> {w.github ? w.id : w.kind}</Text>
          {note !== "" ? <Text color="yellow"> {note}</Text> : null}
          {w.queuedAt !== null ? (
            <Text dimColor>
              {`${note !== "" ? " · " : " "}queued ${fmtAgeShort(w.queuedAt, now)}`}
            </Text>
          ) : null}
        </Text>,
        `w-${w.id}`,
      ),
    );
  });

  rows.push(
    <Text key="rec-h" bold>
      {" "}
    </Text>,
  );
  rows.push(
    <Text key="rec-h2" bold>
      RECENT
    </Text>,
  );
  // LOCAL only: RECENT caps at 5, so surface the full done/failed totals here.
  if (counts) {
    rows.push(
      <Text key="rec-counts" wrap="truncate-end">
        {"  "}
        <Text color="green">DONE {counts.done}</Text>
        <Text dimColor> · </Text>
        <Text color="red">FAILED {counts.failed}</Text>
      </Text>,
    );
  }
  if (snap.recent.length === 0) dash("rec-none");
  snap.recent.forEach((r, j) => {
    const sel = selectable === true && selectedRow === snap.waiting.length + j;
    if (sel) selRowIndex = rows.length;
    rows.push(
      pressable(
        snap.waiting.length + j,
        sel,
        <Text key={`f-${r.id}-${r.finishedAt}`} wrap="truncate-end">
          {gutter(sel)}
          <Text color={r.status === "done" ? "green" : "red"}>
            {r.status === "done" ? "✓" : "✗"}{" "}
          </Text>
          {queueLabel(r.github, r.id)}
          {r.resultStatus !== null
            ? ` ${r.resultStatus}${
                r.durationSeconds !== null ? ` ${fmtDurShort(r.durationSeconds)}` : ""
              }`
            : null}
          <Text dimColor>
            {r.resultStatus !== null
              ? ` · ${fmtAge(r.finishedAt, now)}`
              : ` ${fmtAge(r.finishedAt, now)}`}
          </Text>
        </Text>,
        `f-${r.id}-${r.finishedAt}`,
      ),
    );
  });

  // STATS: derived ledger/health rollup. Plain (never `pressable`) rows appended
  // AFTER the actionable RECENT list, so `selRowIndex` and every `onRowPress`
  // index stay put. Absent (error-path snapshot) → no section at all; fallback
  // stats (empty ledger) → the null-derived segments/lines self-omit below.
  if (st !== null) {
    const w = st.window24h;
    rows.push(
      <Text key="stats-h" bold>
        {" "}
      </Text>,
    );
    rows.push(
      <Text key="stats-t" bold>
        STATS
      </Text>,
    );

    // 24h: counts + success rate always render; avg/ETA only with a populated
    // ledger (avgDurationSeconds drives both; ETA also drops when zero).
    let l24 = `24h ${w.done}✓ ${w.failed}✗`;
    if (w.successRate !== null) l24 += ` (${Math.round(w.successRate * 100)}%)`;
    const seg24: string[] = [];
    if (w.avgDurationSeconds !== null) seg24.push(`avg ${fmtDurShort(w.avgDurationSeconds)}`);
    if (st.etaSeconds !== null && st.etaSeconds !== 0)
      seg24.push(`ETA ~${fmtDurShort(st.etaSeconds)}`);
    if (seg24.length > 0) l24 += ` · ${seg24.join(" · ")}`;
    rows.push(
      <Text key="stats-24" wrap="truncate-end">
        {`  ${l24}`}
      </Text>,
    );

    // 7d: weekly totals + a per-day activity sparkline. Absent when the ledger
    // has no 7-day window yet (fallback stats).
    if (st.perDay7d.length > 0) {
      const d7 = st.perDay7d.reduce((a, p) => a + p.done, 0);
      const f7 = st.perDay7d.reduce((a, p) => a + p.failed, 0);
      const spark = fmtSpark(st.perDay7d.map((p) => p.done + p.failed));
      rows.push(
        <Text key="stats-7d" wrap="truncate-end">
          {`  7d ${d7}✓ ${f7}✗ ${spark}`}
        </Text>,
      );
    }

    // Spend + tokens: each segment self-omits; the whole line drops when both
    // are absent (no /health spend, empty-ledger tokens).
    const seg3: string[] = [];
    if (st.spend !== null) {
      seg3.push(
        st.spend.dailyBudgetUsd > 0
          ? `spend $${st.spend.todayUsd.toFixed(2)}/$${st.spend.dailyBudgetUsd.toFixed(2)}`
          : `spend $${st.spend.todayUsd.toFixed(2)} today`,
      );
    }
    if (w.tokensIn !== null && w.tokensOut !== null) {
      seg3.push(`tok ${fmtCompact(w.tokensIn)} in ${fmtCompact(w.tokensOut)} out`);
    }
    if (seg3.length > 0) {
      rows.push(
        <Text key="stats-sp" wrap="truncate-end">
          {`  ${seg3.join(" · ")}`}
        </Text>,
      );
    }

    // Guards + outbox: zero segments drop; the whole line drops when every one
    // is empty (fresh daemon, drained outbox).
    const seg4: string[] = [];
    if (st.guards !== null) {
      if (st.guards.nudges > 0) seg4.push(`${st.guards.nudges} nudges`);
      if (st.guards.kills > 0) seg4.push(`${st.guards.kills} kills`);
      if (st.guards.requeues > 0) seg4.push(`${st.guards.requeues} requeues`);
    }
    if (st.outbox.depth + st.outbox.dead > 0) {
      seg4.push(
        `outbox ${st.outbox.depth} queued${st.outbox.dead > 0 ? ` ${st.outbox.dead} dead` : ""}`,
      );
    }
    if (seg4.length > 0) {
      rows.push(
        <Text key="stats-g" wrap="truncate-end">
          {`  guards ${seg4.join(" · ")}`}
        </Text>,
      );
    }

    // Restart notice: levers changed in config but not yet applied to the daemon.
    if (st.pendingRestartFields.length > 0) {
      rows.push(
        <Text key="stats-r" color={theme.warn} wrap="truncate-end">
          {`  ⚠ restart to apply: ${st.pendingRestartFields.join(", ")}`}
        </Text>,
      );
    }
  }

  // Cursor-following window: base at `scroll` (the GitHub `t` path's only input,
  // and 0 for the LOCAL queue), then nudge so a selected row past the fold stays
  // visible — mirrors windowSlice's clamp. The slice caps at `visible` rows, so
  // the frame never exceeds `height` (Ink duplicate-redraw hazard). Non-
  // selectable → selRowIndex null → start clamped (byte-identical output).
  const visible = Math.max(1, height - 3);
  onScrollMax?.(maxScroll(rows.length, visible));
  // Clamp the base offset BEFORE the selected-row nudge below, so a stale or
  // past-the-end `scroll` can never slice an empty window; cursor-following is
  // unchanged.
  let start = clampScroll(scroll, rows.length, visible);
  if (selRowIndex !== null) {
    if (selRowIndex < start) start = selRowIndex;
    else if (selRowIndex >= start + visible) start = selRowIndex - visible + 1;
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
    >
      {rows.slice(start, start + visible)}
    </Box>
  );
}
