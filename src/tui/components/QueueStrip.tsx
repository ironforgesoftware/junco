import React from "react";
import { Box, Text } from "ink";
import type { QueueSnapshot } from "../queueSnapshot.js";
import { queueLabel, progressLine } from "../queueFmt.js";

const RUNNING_LINES = 2;
const NEXT_SHOWN = 3;

/** Always-on compact queue strip: header counts, running ticket(s) with live
 * progress, next-up in claim order. `t` (handled by App) expands to the view. */
export function QueueStrip({
  snap,
  now,
}: {
  snap: QueueSnapshot | null;
  now: Date;
}): React.JSX.Element {
  if (snap === null) {
    return (
      <Box borderStyle="round" paddingX={1}>
        <Text dimColor>queue — loading…</Text>
      </Box>
    );
  }
  if (snap.error !== null) {
    return (
      <Box borderStyle="round" paddingX={1}>
        <Text dimColor wrap="truncate-end">
          queue unavailable: {snap.error}
        </Text>
      </Box>
    );
  }
  if (snap.running.length === 0 && snap.waiting.length === 0 && snap.daemonUp) {
    return (
      <Box borderStyle="round" paddingX={1}>
        <Text dimColor>queue — idle</Text>
      </Box>
    );
  }

  const header =
    `queue — ${snap.running.length} running · ${snap.waiting.length} waiting` +
    (snap.maxConcurrent > 1 ? ` · max ${snap.maxConcurrent}` : "");
  const next = snap.waiting.slice(0, NEXT_SHOWN);
  const moreNext = snap.waiting.length - next.length;
  const shown = snap.running.slice(0, RUNNING_LINES);
  const moreRunning = snap.running.length - shown.length;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box gap={2}>
        <Text bold>{header}</Text>
        {!snap.daemonUp && <Text color="yellow">daemon ○ down — nothing will run</Text>}
      </Box>
      {shown.map((r) => (
        <Text key={r.id} wrap="truncate-end">
          <Text color="cyan">◐ </Text>
          <Text bold>{queueLabel(r.github, r.id)}</Text>
          <Text dimColor> {progressLine(r, now)}</Text>
        </Text>
      ))}
      {moreRunning > 0 && <Text dimColor>+{moreRunning} more running</Text>}
      {next.length > 0 && (
        <Text wrap="truncate-end">
          <Text dimColor>next: </Text>
          {next.map((w, i) => (
            <Text key={w.id}>
              {i > 0 ? "  " : ""}
              {w.deferred ? "⏲" : ""}
              {i + 1}) {queueLabel(w.github, w.id)}
            </Text>
          ))}
          {moreNext > 0 ? <Text dimColor> +{moreNext} more</Text> : null}
          <Text dimColor> [t]</Text>
        </Text>
      )}
    </Box>
  );
}
