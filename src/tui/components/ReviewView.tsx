import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { PendingAssess } from "../../assessReview.js";
import { ANALYSIS_FOOTER, type PendingComment } from "../../commentReview.js";

export interface ReviewOpen {
  kind: "batch";
  batchIdx: number;
  findingCursor: number;
  checked: Set<string>;
}
export interface DraftOpen {
  kind: "draft";
  draftIdx: number;
  scroll: number;
}
export interface ReviewState {
  loading: boolean;
  error: string | null;
  batches: PendingAssess[];
  drafts: PendingComment[];
  // Cursor over the COMBINED list — batches first, then drafts.
  cursor: number;
  open: ReviewOpen | DraftOpen | null;
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

/** First non-empty, trimmed line of a draft — the list-row preview text. */
function firstDraftLine(draft: string): string {
  for (const raw of draft.split("\n")) {
    const line = raw.trim();
    if (line) return line;
  }
  return "";
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

  // Draft preview mode.
  if (state.open && state.open.kind === "draft") {
    const draft = state.drafts[state.open.draftIdx];
    if (!draft) {
      return (
        <Box paddingX={1}>
          <Text dimColor>draft gone</Text>
        </Box>
      );
    }
    const lines = draft.draft.split("\n");
    // Reserve rows: header (1), the footer line when present (1), hint (1).
    const bodyRows = Math.max(1, rows - (draft.footer ? 3 : 2));
    const w = windowRange(lines.length, state.open.scroll, bodyRows);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text wrap="truncate-end">
          <Text color={theme.accent}>{`${draft.nwo}#${draft.issue}`}</Text>
          <Text
            dimColor
          >{` · ${draft.issueTitle} · ${draft.external ? "external" : "owned"}`}</Text>
        </Text>
        {lines.slice(w.start, w.end).map((line, i) => (
          <Text key={w.start + i} wrap="truncate-end">
            {line.length > 0 ? line : " "}
          </Text>
        ))}
        {draft.footer && (
          <Text dimColor wrap="truncate-end">
            {ANALYSIS_FOOTER}
          </Text>
        )}
        <Text dimColor>f post · x discard · esc back</Text>
      </Box>
    );
  }

  // Assess checklist mode.
  if (state.open && state.open.kind === "batch") {
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

  // Combined list mode — batches first, then comment drafts.
  const total = state.batches.length + state.drafts.length;
  if (total === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>
          no pending assess reviews — run assess (s) on a repo first · or draft a comment on an
          issue (c)
        </Text>
      </Box>
    );
  }
  const w = windowRange(total, state.cursor, rows);
  const batchCount = state.batches.length;
  return (
    <Box flexDirection="column" paddingX={1}>
      {Array.from({ length: w.end - w.start }, (_, i) => {
        const idx = w.start + i;
        const sel = idx === state.cursor && focused;
        if (idx < batchCount) {
          const b = state.batches[idx];
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
        }
        const d = state.drafts[idx - batchCount];
        return (
          <Box
            key={d.id}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            gap={1}
          >
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text dimColor={!sel}>{`${d.nwo}#${d.issue}`}</Text>
            <Text dimColor>comment</Text>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate" dimColor={!sel}>
                {firstDraftLine(d.draft)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
