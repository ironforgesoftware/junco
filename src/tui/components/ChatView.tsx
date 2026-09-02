/**
 * The operator ↔ agent chat pane (spec 2026-09-01 §8.2): header strip +
 * TranscriptBody over the chat summary (with the in-flight `liveText`
 * appended as trailing rows) + Composer. Pure layout — every action arrives
 * as a prop; ChatView never touches useChat itself.
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { bumpRender } from "../renderCount.js";
import {
  renderTranscriptRows,
  wrapText,
  MIN_WIDTH,
  type RowTone,
  type TranscriptRow,
} from "../../transcriptRender.js";
import { anchorIds } from "../../transcriptSummary.js";
import type { ChatState } from "../hooks/useChat.js";
import { TranscriptBody, bodyWindow, toneProps } from "./TranscriptBody.js";
import { Composer } from "./Composer.js";
import { CHAT_RING } from "../hooks/useChat.js";

const hhmm = (iso: string): string => iso.slice(11, 16);

/**
 * Header word, in priority order (spec §8.2).
 *
 * Ruling R21b: `useChat` resubscribes automatically after a terminal `end`,
 * so `endReason` can still read `"daemon_stopped"` for a while after the
 * connection has already come back `"live"` (it only clears on the next
 * `junco_chat_turn_start`). Announcing "reconnecting" over a live connection
 * would be a stale, self-contradictory header, so that branch only fires
 * while the connection genuinely isn't live yet; once it's live the stale
 * reason falls through to the normal blocked/streaming/degraded/idle checks.
 */
export function chatHeaderStatus(
  s: ChatState,
  modelId: string | null,
): { text: string; tone?: RowTone } {
  void modelId;
  if (s.connection === "down") return { text: "daemon down", tone: "error" };
  if (s.endReason === "session_reset")
    return { text: "session reset — send a message to start fresh", tone: "warn" };
  if (s.endReason === "daemon_stopped" && s.connection !== "live")
    return { text: "daemon stopped — reconnecting", tone: "warn" };
  if (s.blocked)
    return {
      text: `blocked: ${s.blocked.reason}${s.blocked.until ? ` until ${hhmm(s.blocked.until)}` : ""}`,
      tone: "warn",
    };
  if (s.streaming) return { text: "◐ streaming", tone: "accent" };
  if (s.connection !== "live") return { text: s.connection, tone: "dim" };
  return {
    text: s.degraded ? "idle · transcript degraded" : "idle",
    tone: s.degraded ? "warn" : "dim",
  };
}

export interface ChatViewProps {
  state: ChatState;
  modelId: string | null;
  costUsd: number | null; // ChatHealth.costUsd — this daemon lifetime
  scroll: number;
  height: number;
  width: number;
  focused: boolean;
  onScrollMax?: (max: number) => void;
  onRowPress?: (anchorIdx: number) => void;
  onComposerChange: (v: string) => void;
  onComposerSubmit: (v: string) => void;
}

const COMPOSER_ROWS = 6; // border ×2 + up to 4 lines

/** Memoized (perf pass #259 discipline) — same rationale as TranscriptView:
 * a chat can carry thousands of rows, and every keystroke's setState should
 * not repaint the whole transcript from scratch. */
export const ChatView = React.memo(function ChatView(p: ChatViewProps): React.JSX.Element {
  bumpRender("ChatView");
  const { state } = p;
  const textWidth = Math.max(MIN_WIDTH, p.width - 6);
  const rows: TranscriptRow[] = useMemo(() => {
    const out =
      state.summary === null
        ? []
        : renderTranscriptRows(state.summary, {
            width: textWidth,
            showThinking: state.showThinking,
            expanded: state.expanded,
          });
    if (state.liveText !== "")
      for (const l of wrapText(state.liveText, textWidth)) out.push({ text: l });
    return out;
  }, [state.summary, state.showThinking, state.expanded, state.liveText, textWidth]);
  // Memoized: a fresh array every render would defeat TranscriptBody's
  // React.memo on almost every ChatView re-render (e.g. a composer
  // keystroke, which touches state.composer but not state.summary).
  const anchors = useMemo(
    () => (state.summary === null ? [] : anchorIds(state.summary)),
    [state.summary],
  );
  // Reserved: borders ×2, header, footer, composer.
  const visible = Math.max(1, p.height - 4 - COMPOSER_ROWS);
  const { start, end } = bodyWindow({
    rows,
    anchors,
    cursor: state.cursor,
    follow: state.follow,
    scroll: p.scroll,
    visible,
  });
  const status = chatHeaderStatus(state, p.modelId);
  const turns = state.summary?.runs.length ?? 0;
  const disabled = state.connection === "down" || state.connection === "connecting";
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={p.focused ? theme.accent : theme.border}
      paddingX={1}
      height={p.height}
      flexGrow={1}
    >
      <Text bold wrap="truncate">
        chat · {state.key} · <Text {...toneProps(status.tone)}>{status.text}</Text>
        {turns > 0 ? ` · ${turns} turn${turns === 1 ? "" : "s"}` : ""}
        {p.costUsd !== null ? ` · chat $${p.costUsd.toFixed(2)}` : ""}
        {p.modelId ? ` · ${p.modelId}` : ""}
        {state.overflowed ? ` · showing last ${CHAT_RING}` : ""}
      </Text>
      <TranscriptBody
        rows={rows}
        anchors={anchors}
        cursor={state.cursor}
        follow={state.follow}
        scroll={p.scroll}
        visible={visible}
        focused={p.focused && !state.composerFocused}
        onScrollMax={p.onScrollMax}
        onRowPress={p.onRowPress}
      />
      <Text dimColor wrap="truncate">
        {state.composerFocused
          ? "esc blur/abort · ctrl+j newline · / commands"
          : "i compose · ↑/↓ move · enter expand · s submit · e edit · r route · D discard · t thinking · f follow"}
        {rows.length > 0 ? ` · ${start + 1}–${end}/${rows.length}` : ""}
      </Text>
      <Composer
        value={state.composer}
        onChange={p.onComposerChange}
        onSubmit={p.onComposerSubmit}
        focused={p.focused && state.composerFocused}
        disabled={disabled}
        disabledReason={
          state.connection === "down" ? "daemon down — chat unavailable" : "connecting…"
        }
        width={p.width - 2}
      />
    </Box>
  );
});
