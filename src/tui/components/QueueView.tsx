import React from "react";
import { Box, Text } from "ink";
import type { QueueSnapshot, QueueWaiting } from "../queueSnapshot.js";
import { queueLabel, progressLine, fmtAge, fmtClock } from "../queueFmt.js";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { clampScroll, maxScroll } from "../window.js";

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

  rows.push(
    <Text key="title" bold color={focused ? theme.accent : undefined}>
      queue
    </Text>,
  );

  rows.push(
    <Text key="run-h" bold>
      RUNNING ({snap.running.length}/{snap.maxConcurrent})
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
  }

  rows.push(
    <Text key="wait-h" bold>
      {" "}
    </Text>,
  );
  rows.push(
    <Text key="wait-h2" bold>
      WAITING ({snap.waiting.length})
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
          <Text dimColor> {fmtAge(r.finishedAt, now)}</Text>
        </Text>,
        `f-${r.id}-${r.finishedAt}`,
      ),
    );
  });

  // Cursor-following window: base at `scroll` (the GitHub `t` path's only input,
  // and 0 for the LOCAL queue), then nudge so a selected row past the fold stays
  // visible — mirrors windowSlice's clamp. The slice caps at `visible` rows, so
  // the frame never exceeds `height` (Ink duplicate-redraw hazard). Non-
  // selectable → selRowIndex null → start === scroll (byte-identical).
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
