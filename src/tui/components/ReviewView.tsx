import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { PendingAssess } from "../../assessReview.js";

export interface ReviewOpen {
  batchIdx: number;
  findingCursor: number;
  checked: Set<string>;
}
export interface ReviewState {
  loading: boolean;
  error: string | null;
  batches: PendingAssess[];
  cursor: number;
  open: ReviewOpen | null;
}

// theme.ts has no `danger` key — critical/high map to the semantic `error`
// color, medium to `warn`, low stays uncolored.
const SEV_COLOR: Record<string, string | undefined> = {
  critical: theme.error,
  high: theme.error,
  medium: theme.warn,
  low: undefined,
};

/** Visible slice of `len` rows around `cursor` within `rows` lines. */
function windowRange(len: number, cursor: number, rows: number): { start: number; end: number } {
  if (len <= rows) return { start: 0, end: len };
  let start = Math.max(0, cursor - Math.floor(rows / 2));
  start = Math.min(start, len - rows);
  return { start, end: start + rows };
}

export function ReviewView({
  state,
  height,
  focused,
}: {
  state: ReviewState;
  height: number;
  focused: boolean;
}): React.JSX.Element {
  const rows = Math.max(1, height - 2);
  if (state.loading) {
    return (
      <Box paddingX={1}>
        <Text dimColor>loading pending reviews…</Text>
      </Box>
    );
  }
  if (state.error) {
    return (
      <Box paddingX={1}>
        <Text color={theme.error}>{state.error}</Text>
      </Box>
    );
  }

  // Checklist mode.
  if (state.open) {
    const batch = state.batches[state.open.batchIdx];
    if (!batch) {
      return (
        <Box paddingX={1}>
          <Text dimColor>batch gone</Text>
        </Box>
      );
    }
    const { checked, findingCursor } = state.open;
    const w = windowRange(batch.findings.length, findingCursor, rows - 1);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          <Text color={theme.accent}>{batch.nwo}</Text>
          <Text
            dimColor
          >{`  ${batch.external ? "external" : "owned"} · ${checked.size}/${batch.findings.length} selected`}</Text>
        </Text>
        {batch.findings.slice(w.start, w.end).map((f, i) => {
          const idx = w.start + i;
          const sel = idx === findingCursor && focused;
          const on = checked.has(f.fingerprint);
          return (
            <Box
              key={f.fingerprint}
              width="100%"
              backgroundColor={sel ? theme.selectionBg : undefined}
              gap={1}
            >
              <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
              <Text>{on ? "[x]" : "[ ]"}</Text>
              <Text color={SEV_COLOR[f.severity]}>{f.severity.padEnd(8)}</Text>
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate" dimColor={!sel}>
                  {f.title}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  }

  // Batch-list mode.
  if (state.batches.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>no pending assess reviews — run assess (s) on a repo first</Text>
      </Box>
    );
  }
  const w = windowRange(state.batches.length, state.cursor, rows);
  return (
    <Box flexDirection="column" paddingX={1}>
      {state.batches.slice(w.start, w.end).map((b, i) => {
        const idx = w.start + i;
        const sel = idx === state.cursor && focused;
        return (
          <Box
            key={b.id}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            gap={1}
          >
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate" dimColor={!sel}>
                {b.nwo}
              </Text>
            </Box>
            <Text dimColor>{b.external ? "external" : "owned"}</Text>
            <Text color={theme.accent}>{`${b.findings.length}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
