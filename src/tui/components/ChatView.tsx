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
 * Ruling R32: `down` is terminal, so this line is the only thing the operator
 * gets — "daemon down" for a chat that is merely switched off sends them to
 * check a process that is running fine. Each string names the fix; an
 * unrecognized (or absent) reason keeps the honest generic word.
 */
const DOWN_TEXT: Record<string, string> = {
  chat_disabled: "chat disabled (chat.enabled)",
  no_checkout: "no checkout — clone the repo first",
  not_a_repo: "checkout is not a git repo",
  unknown_key: "repo not watched",
};

function downText(reason: string | null): string {
  return (reason !== null ? DOWN_TEXT[reason] : undefined) ?? "daemon down";
}

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
  if (s.connection === "down") return { text: downText(s.downReason), tone: "error" };
  if (s.endReason === "session_reset")
    return { text: "session reset — send a message to start fresh", tone: "warn" };
  if (s.endReason === "daemon_stopped" && s.connection !== "live")
    return { text: "daemon stopped — reconnecting", tone: "warn" };
  if (s.blocked)
    return {
      text: `blocked: ${s.blocked.reason}${s.blocked.until ? ` until ${hhmm(s.blocked.until)}` : ""}`,
      tone: "warn",
    };
  // Spec 2026-09-03 §4.3: the turn IS still streaming while junco_submit
  // blocks on the operator, and "◐ streaming" would say nothing about what it
  // is waiting for — so the card's word wins. #478: once they answered `y`
  // the wait is the daemon's CLI, not them, and the header must say so.
  if (s.pending)
    return {
      text: s.pending.running ? "▸ submitting…" : "◐ awaiting your confirmation",
      tone: "accent",
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
  /** ChatHealth.chatTodayUsd — the chat's spend for the ledger's current day
   *  (#456), null on an older daemon or with the health server off. */
  chatTodayUsd: number | null;
  scroll: number;
  height: number;
  width: number;
  /** Whether this view holds the keys. App mounts it full-screen and always
   * passes `true` (the chat is the only surface while it is the view — the
   * pane the operator came from is not consulted). The prop stays so the view
   * can paint itself blurred (border, selection, composer) should it ever
   * share the screen. */
  focused: boolean;
  onScrollMax?: (max: number) => void;
  onRowPress?: (anchorIdx: number) => void;
  /** Scrollbar click/drag (stable callback — this component is memoized). */
  onScrollTo?: (offset: number) => void;
  /** A cursor move's reveal, painted: commit the start and ack (stable). */
  onReveal?: (start: number) => void;
  onComposerChange: (v: string) => void;
  onComposerSubmit: (v: string) => void;
}

const COMPOSER_ROWS = 6; // border ×2 + up to 4 lines

/** Transcript rows visible inside a `height`-row chat view — reserved:
 * borders ×2, header, composer. The in-pane hint row is gone (#471): the
 * two-row footer says the keys with keycaps, so the pane spent a row on a
 * duplicate; the only thing on it that was NOT a duplicate — the window
 * indicator and the follow state — moved onto the header's right edge, and
 * the row went to the transcript. Exported because App's key cascade needs
 * the SAME number to page by (hooks/useChatInput.ts's PgUp/PgDn). */
export function chatVisibleRows(height: number): number {
  return Math.max(1, height - 3 - COMPOSER_ROWS);
}

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
    // Streaming text is labelled exactly as the finished answer will be
    // (transcriptRender.ts's chat rows): label wrapped in with the text, the
    // first row accent, the rest indented — so nothing jumps when the turn
    // ends and the renderer takes over.
    if (state.liveText !== "")
      wrapText(`junco: ${state.liveText.trimStart()}`, textWidth - 2).forEach((l, i) =>
        out.push(i === 0 ? { text: l, tone: "accent" } : { text: l === "" ? "" : `  ${l}` }),
      );
    return out;
  }, [state.summary, state.showThinking, state.expanded, state.liveText, textWidth]);
  // Memoized: a fresh array every render would defeat TranscriptBody's
  // React.memo on almost every ChatView re-render (e.g. a composer
  // keystroke, which touches state.composer but not state.summary).
  const anchors = useMemo(
    () => (state.summary === null ? [] : anchorIds(state.summary)),
    [state.summary],
  );
  const visible = chatVisibleRows(p.height);
  const { start, end } = bodyWindow({
    rows,
    anchors,
    cursor: state.cursor,
    follow: state.follow,
    reveal: state.reveal,
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
      {/* Two children so the identity half can truncate on a narrow terminal
          while the scroll status — the view's ONLY live scroll feedback — keeps
          its place at the right edge (#471). */}
      <Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold wrap="truncate">
            chat · {state.key} · <Text {...toneProps(status.tone)}>{status.text}</Text>
            {turns > 0 ? ` · ${turns} turn${turns === 1 ? "" : "s"}` : ""}
            {/* "today": ChatHealth.chatTodayUsd is the chat's spend for the
                ledger's current day (#456), which is what spec §8.2 asks for. */}
            {p.chatTodayUsd !== null ? ` · chat $${p.chatTodayUsd.toFixed(2)} today` : ""}
            {p.modelId ? ` · ${p.modelId}` : ""}
            {state.overflowed ? ` · showing last ${CHAT_RING}` : ""}
          </Text>
        </Box>
        <Text dimColor wrap="truncate">
          {` ${state.follow ? "following" : "paused"}`}
          {rows.length > 0 ? ` · ${start + 1}–${end}/${rows.length}` : ""}
        </Text>
      </Box>
      <TranscriptBody
        rows={rows}
        anchors={anchors}
        cursor={state.cursor}
        follow={state.follow}
        reveal={state.reveal}
        scroll={p.scroll}
        visible={visible}
        focused={p.focused && !state.composerFocused}
        onScrollMax={p.onScrollMax}
        onRowPress={p.onRowPress}
        onScrollTo={p.onScrollTo}
        onReveal={p.onReveal}
      />
      <Composer
        value={state.composer}
        onChange={p.onComposerChange}
        onSubmit={p.onComposerSubmit}
        focused={p.focused && state.composerFocused}
        disabled={disabled}
        disabledReason={
          state.connection === "down"
            ? `${downText(state.downReason)} — chat unavailable`
            : "connecting…"
        }
        width={p.width - 2}
      />
    </Box>
  );
});
