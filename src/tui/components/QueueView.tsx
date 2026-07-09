import React from "react";
import { Box, Text } from "ink";
import type { QueueSnapshot, QueueWaiting } from "../queueSnapshot.js";
import { queueLabel, progressLine, fmtAge, fmtClock } from "../queueFmt.js";
import { theme } from "../theme.js";

/** A selectable actionable row surfaced to the LOCAL Queue section: WAITING
 * (inbox) and RECENT (done/failed) rows. RUNNING rows are never included —
 * the daemon owns processing/. */
export interface QueueRowRef {
  kind: "running" | "waiting" | "recent";
  id: string;
  status?: "done" | "failed";
}

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
 * rows render but are never selectable. Absent props → byte-identical to the
 * GitHub `t` view. */
export function QueueView({
  snap,
  scroll,
  now,
  height,
  focused,
  selectable,
  selectedRow,
  onRows,
}: {
  snap: QueueSnapshot | null;
  scroll: number;
  now: Date;
  height: number;
  focused: boolean;
  selectable?: boolean;
  selectedRow?: number;
  onRows?: (rows: QueueRowRef[]) => void;
}): React.JSX.Element {
  React.useEffect(() => {
    if (!onRows) return;
    if (snap === null) {
      onRows([]);
      return;
    }
    onRows([
      ...snap.waiting.map((w) => ({ kind: "waiting" as const, id: w.id })),
      ...snap.recent.map((r) => ({ kind: "recent" as const, id: r.id, status: r.status })),
    ]);
  }, [snap, onRows]);

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
  const dash = (key: string): void => {
    rows.push(
      <Text key={key} dimColor>
        {"  "}—
      </Text>,
    );
  };

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
    rows.push(
      <Text key={`w-${w.id}`} wrap="truncate-end">
        {gutter(sel)}
        {i + 1}. <Text bold>{queueLabel(w.github, w.id)}</Text>
        <Text dimColor> {w.github ? w.id : w.kind}</Text>
        {note !== "" ? <Text color="yellow"> {note}</Text> : null}
      </Text>,
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
  if (snap.recent.length === 0) dash("rec-none");
  snap.recent.forEach((r, j) => {
    const sel = selectable === true && selectedRow === snap.waiting.length + j;
    rows.push(
      <Text key={`f-${r.id}-${r.finishedAt}`} wrap="truncate-end">
        {gutter(sel)}
        <Text color={r.status === "done" ? "green" : "red"}>
          {r.status === "done" ? "✓" : "✗"}{" "}
        </Text>
        {queueLabel(r.github, r.id)}
        <Text dimColor> {fmtAge(r.finishedAt, now)}</Text>
      </Text>,
    );
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
    >
      {rows.slice(scroll, scroll + Math.max(1, height - 3))}
    </Box>
  );
}
