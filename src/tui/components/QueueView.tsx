import React from "react";
import { Box, Text } from "ink";
import type { QueueSnapshot, QueueWaiting } from "../queueSnapshot.js";
import { queueLabel, progressLine, fmtAge, fmtClock } from "../queueFmt.js";
import { theme } from "../theme.js";

function waitingNote(w: QueueWaiting): string {
  const parts: string[] = [];
  if (w.priority !== "normal") parts.push(w.priority);
  if (w.retryCount > 0) parts.push(`retry ${w.retryCount}`);
  if (w.notBefore !== null) parts.push(`not before ${fmtClock(w.notBefore)}`);
  if (w.deferred) parts.push("⏲ deferred");
  return parts.join(" · ");
}

/** Full queue view (main-area slot, opened with `t`): RUNNING / WAITING /
 * RECENT built as flat rows so App's scroll offset can slice them. */
export function QueueView({
  snap,
  scroll,
  now,
  height,
  focused,
}: {
  snap: QueueSnapshot | null;
  scroll: number;
  now: Date;
  height: number;
  focused: boolean;
}): React.JSX.Element {
  if (snap === null) {
    return (
      <Box borderStyle="round" paddingX={1} flexGrow={1}>
        <Text dimColor>queue — loading…</Text>
      </Box>
    );
  }

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
        {"  "}
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
    rows.push(
      <Text key={`w-${w.id}`} wrap="truncate-end">
        {"  "}
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
  for (const r of snap.recent) {
    rows.push(
      <Text key={`f-${r.id}-${r.finishedAt}`} wrap="truncate-end">
        {"  "}
        <Text color={r.status === "done" ? "green" : "red"}>
          {r.status === "done" ? "✓" : "✗"}{" "}
        </Text>
        {queueLabel(r.github, r.id)}
        <Text dimColor> {fmtAge(r.finishedAt, now)}</Text>
      </Text>,
    );
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
      {rows.slice(scroll, scroll + Math.max(1, height - 3))}
    </Box>
  );
}
