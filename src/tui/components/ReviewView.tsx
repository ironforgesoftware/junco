import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import type { PendingAssess } from "../../assessReview.js";
import { ANALYSIS_FOOTER, type PendingComment } from "../../commentReview.js";
import type { PendingDraft } from "../../chat/draftStore.js";
import { clampScroll, maxScroll } from "../window.js";
import { fmtAge } from "../queueFmt.js";

interface ReviewOpen {
  kind: "batch";
  batchIdx: number;
  findingCursor: number;
  checked: Set<string>;
}
interface DraftOpen {
  kind: "draft";
  draftIdx: number;
}
/** A parked chat draft's preview (spec 2026-09-01 §8.6) — `idx` indexes
 * `chatDrafts`, not the combined list. */
interface ChatDraftOpen {
  kind: "chatDraft";
  idx: number;
}
export interface ReviewState {
  loading: boolean;
  error: string | null;
  batches: PendingAssess[];
  drafts: PendingComment[];
  chatDrafts: PendingDraft[];
  // Cursor over the COMBINED list — batches, then comment drafts, then chat drafts.
  cursor: number;
  open: ReviewOpen | DraftOpen | ChatDraftOpen | null;
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

/** The chat-draft row's / preview header's route cell: a forced override wins
 * over the verdict, and the command kinds never route at all (spec §6.4). */
function routeVerdict(d: PendingDraft): string {
  if (d.kind === "audit" || d.kind === "investigate") return "command";
  if (d.routeOverride !== "auto") return `${d.routeOverride}!`;
  return d.files[0]?.route?.destination ?? "?";
}

/** The chat-draft preview body, one string per rendered line: the
 * RouteDecision verbatim (spec §6.4), the allowlist's dropped keys (§6.1),
 * every lint violation, then the file exactly as it sits on disk. */
function chatDraftLines(d: PendingDraft): string[] {
  const out: string[] = [];
  for (const f of d.files) {
    out.push(`── ${f.name} ──`);
    const r = f.route;
    if (r) {
      out.push(`destination: ${r.destination}`);
      for (const reason of r.reasons) out.push(`reason: ${reason}`);
      if (r.carriedTimeout !== null) out.push(`carried: timeout_minutes=${r.carriedTimeout}`);
      if (r.discarded.length > 0) out.push(`would discard: ${r.discarded.join(", ")}`);
    }
    if (f.droppedKeys.length > 0) out.push(`dropped: ${f.droppedKeys.join(", ")}`);
    for (const v of f.lint) out.push(`[${v.severity}] ${v.rule}: ${v.message}`);
    out.push(...f.content.split("\n"));
  }
  return out;
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

  // Chat-draft preview mode (spec 2026-09-01 §6.4, §8.6) — same top-anchored
  // window as the comment-draft preview above, over the rendered draft lines.
  if (state.open && state.open.kind === "chatDraft") {
    const cd = state.chatDrafts[state.open.idx];
    if (!cd) {
      return (
        <Box paddingX={1}>
          <Text dimColor>draft gone</Text>
        </Box>
      );
    }
    const lines = chatDraftLines(cd);
    // Reserve rows: header (1) + the hint line (1).
    const bodyRows = Math.max(1, rows - 2);
    onScrollMax?.(maxScroll(lines.length, bodyRows));
    const start = clampScroll(scroll, lines.length, bodyRows);
    return (
      <ClickableBox flexDirection="column" paddingX={1} onWheel={onDraftWheel}>
        <Text wrap="truncate-end">
          <Text color={theme.accent}>{cd.nwo ?? cd.key}</Text>
          <Text dimColor>{` · ${cd.kind} · route: ${routeVerdict(cd)}`}</Text>
        </Text>
        {lines.slice(start, start + bodyRows).map((line, i) => (
          <Text key={start + i} wrap="truncate-end">
            {line.length > 0 ? line : " "}
          </Text>
        ))}
        <Text dimColor>s submit · e edit · r route · D discard · esc back</Text>
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

  // Combined list mode — batches first, then comment drafts, then chat drafts.
  const total = state.batches.length + state.drafts.length + state.chatDrafts.length;
  if (total === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>
          no pending audit reviews — run audit (u) on a repo first · or draft a comment on an issue
          (n)
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
        if (idx >= batchCount + state.drafts.length) {
          const cd = state.chatDrafts[idx - batchCount - state.drafts.length];
          return (
            <ClickableBox
              key={cd.id}
              width="100%"
              backgroundColor={sel ? theme.selectionBg : undefined}
              hoverBg={sel ? theme.selectionBg : theme.hoverBg}
              gap={1}
              onPress={onRowPress ? () => onRowPress(idx) : undefined}
            >
              {/* Same pin discipline (#233): the kind + file names flex. */}
              <Box flexShrink={0}>
                <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor={!sel}>{cd.nwo ?? cd.key}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text
                  wrap="truncate"
                  dimColor={!sel}
                >{`${cd.kind} · ${cd.files.map((f) => f.name.replace(/\.md$/, "")).join(", ")}`}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text color={cd.lintFailed ? theme.error : theme.accent}>
                  {cd.lintFailed ? "lint ✗" : routeVerdict(cd)}
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor>{fmtAge(cd.createdAt, now)}</Text>
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
