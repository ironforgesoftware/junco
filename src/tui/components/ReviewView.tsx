import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import type { PendingAssess } from "../../assessReview.js";
import { ANALYSIS_FOOTER, type PendingComment } from "../../commentReview.js";
import { clampScroll, maxScroll } from "../window.js";
import { fmtAge } from "../queueFmt.js";

export interface ReviewOpen {
  kind: "batch";
  batchIdx: number;
  findingCursor: number;
  checked: Set<string>;
}
export interface DraftOpen {
  kind: "draft";
  draftIdx: number;
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
  scroll,
  height,
  focused,
  now,
  onRowPress,
  onFindingPress,
  onDraftWheel,
  onScrollMax,
}: {
  state: ReviewState;
  scroll: number;
  height: number;
  focused: boolean;
  now: Date;
  onRowPress?: (index: number) => void;
  onFindingPress?: (index: number) => void;
  onDraftWheel?: (dir: 1 | -1) => void;
  onScrollMax?: (max: number) => void;
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
    // Top-anchored: the window starts exactly at `start`, so `j`/`k` move the
    // visible lines by one immediately — no cursor-centering dead-zone.
    onScrollMax?.(maxScroll(lines.length, bodyRows));
    const start = clampScroll(scroll, lines.length, bodyRows);
    return (
      <ClickableBox flexDirection="column" paddingX={1} onWheel={onDraftWheel}>
        <Text wrap="truncate-end">
          <Text color={theme.accent}>{`${draft.nwo}#${draft.issue}`}</Text>
          <Text
            dimColor
          >{` · ${draft.issueTitle} · ${draft.external ? "external" : "owned"}`}</Text>
        </Text>
        {lines.slice(start, start + bodyRows).map((line, i) => (
          <Text key={start + i} wrap="truncate-end">
            {line.length > 0 ? line : " "}
          </Text>
        ))}
        {draft.footer && (
          <Text dimColor wrap="truncate-end">
            {ANALYSIS_FOOTER}
          </Text>
        )}
        <Text dimColor>f post · x discard · esc back</Text>
      </ClickableBox>
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
    const filedCount = batch.filed ? Object.keys(batch.filed).length : 0;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          <Text color={theme.accent}>{batch.nwo}</Text>
          <Text
            dimColor
          >{`  ${batch.external ? "external" : "owned"} · ${checked.size}/${batch.findings.length} selected${filedCount > 0 ? ` · ${filedCount} filed` : ""}`}</Text>
        </Text>
        {batch.findings.slice(w.start, w.end).map((f, i) => {
          const idx = w.start + i;
          const sel = idx === findingCursor && focused;
          const on = checked.has(f.fingerprint);
          const rec = batch.filed?.[f.fingerprint];
          return (
            <ClickableBox
              key={f.fingerprint}
              width="100%"
              backgroundColor={sel ? theme.selectionBg : undefined}
              hoverBg={sel ? theme.selectionBg : theme.hoverBg}
              gap={1}
              onPress={onFindingPress ? () => onFindingPress(idx) : undefined}
            >
              {/* Fixed cells pin (flexShrink 0) so the flexing title is the ONLY
                  thing that yields — without this a long title shrinks the
                  trailing accounting below content width and it WRAPS onto a
                  second visual line (#233; Rail's assess-column precedent). */}
              <Box flexShrink={0}>
                <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text>{on ? "[x]" : rec ? " ✓ " : "[ ]"}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text color={SEV_COLOR[f.severity]}>{f.severity.padEnd(8)}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate" dimColor={!sel}>
                  {f.title}
                </Text>
              </Box>
              {rec && (
                <Box flexShrink={0}>
                  <Text
                    dimColor
                  >{`${rec.how === "deduped" ? "dup" : rec.how} ${fmtAge(rec.at, now)}`}</Text>
                </Box>
              )}
            </ClickableBox>
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
          no pending audit reviews — run audit (u) on a repo first · or draft a comment on an issue
          (c)
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
          const filedCount = b.filed ? Object.keys(b.filed).length : 0;
          return (
            <ClickableBox
              key={b.id}
              width="100%"
              backgroundColor={sel ? theme.selectionBg : undefined}
              hoverBg={sel ? theme.selectionBg : theme.hoverBg}
              gap={1}
              onPress={onRowPress ? () => onRowPress(idx) : undefined}
            >
              {/* Same pin discipline as the checklist rows (#233): only the
                  nwo flexes; age/ownership/count never shrink or wrap. */}
              <Box flexShrink={0}>
                <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate" dimColor={!sel}>
                  {b.nwo}
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor>{fmtAge(b.createdAt, now)}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor>{b.external ? "external" : "owned"}</Text>
              </Box>
              <Box flexShrink={0}>
                {filedCount > 0 ? (
                  <Text color={theme.accent}>{`filed ${filedCount}/${b.findings.length}`}</Text>
                ) : (
                  <Text color={theme.accent}>{`${b.findings.length}`}</Text>
                )}
              </Box>
            </ClickableBox>
          );
        }
        const d = state.drafts[idx - batchCount];
        return (
          <ClickableBox
            key={d.id}
            width="100%"
            backgroundColor={sel ? theme.selectionBg : undefined}
            hoverBg={sel ? theme.selectionBg : theme.hoverBg}
            gap={1}
            onPress={onRowPress ? () => onRowPress(idx) : undefined}
          >
            {/* Same pin discipline (#233): the draft preview is the flexer. */}
            <Box flexShrink={0}>
              <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor={!sel}>{`${d.nwo}#${d.issue}`}</Text>
            </Box>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate" dimColor={!sel}>
                {firstDraftLine(d.draft)}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>comment</Text>
            </Box>
          </ClickableBox>
        );
      })}
    </Box>
  );
}
