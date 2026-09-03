import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { ChatConnState } from "../chatClient.js";
import type { PendingDraft } from "../../chat/draftStore.js";
import { anchorIds, summarizeTranscript, type TranscriptSummary } from "../../transcriptSummary.js";
import { parseTranscriptLine } from "../../agent/transcriptSchema.js";

export const CHAT_RING = 2000;
export const CHAT_FLUSH_MS = 50;
/** Ruling R21: delay before the hook resubscribes after a terminal `end` —
 * long enough that a flapping connection doesn't spin-subscribe, short
 * enough that an operator staring at "reconnecting"/"session reset" text
 * (rendered by a later task's header) sees the pane come back quickly. */
export const CHAT_RESUBSCRIBE_MS = 1000;

export interface ChatState {
  key: string;
  connection: ChatConnState;
  /** Ruling R32: the daemon's own word for a non-2xx refusal (chat_disabled,
   *  no_checkout, not_a_repo, unknown_key …). Null while live, and null for a
   *  transport-level down — which genuinely means only "daemon down". */
  downReason: string | null;
  endReason: string | null;
  summary: TranscriptSummary | null; // over the ring, excluding message_update
  liveText: string; // in-flight assistant text (bus-only deltas), cleared at turn end
  streaming: boolean;
  blocked: { reason: string; until: string | null } | null;
  degraded: boolean;
  overflowed: boolean; // ring dropped records: header shows "showing last <ringSize>"
  drafts: PendingDraft[]; // parked drafts for this key
  composer: string;
  composerFocused: boolean;
  cursor: number; // index into anchorIds(summary)
  follow: boolean;
  /** A cursor move that landed owes the window a nudge onto the anchor —
   * TranscriptBody paints it once and acks through `ackReveal`. */
  reveal: boolean;
  showThinking: boolean;
  expanded: ReadonlySet<string>;
  lastOffset: number | null;
  error: string | null; // last POST failure (toast-worthy)
}

export interface ChatApi {
  chat: ChatState | null;
  /** Spec 2026-09-02 §5: `opts.composer` PREFILLS the composer (focused, and
   *  NOT sent) — the chat verb types the thread for the operator, who still
   *  owns the send key. */
  openChat(key: string, opts?: { composer?: string }): void;
  closeChat(): void;
  send(text: string): Promise<void>;
  abort(): Promise<void>;
  fresh(): Promise<void>;
  clearError(): void;
  setComposer(text: string): void;
  focusComposer(on: boolean): void;
  moveCursor(delta: number): void;
  /** The view painted the reveal a cursor move owed (TranscriptBody onReveal). */
  ackReveal(): void;
  toggleExpanded(): void;
  toggleThinking(): void;
  setFollow(on: boolean): void;
  reloadDrafts(): Promise<void>;
  selectedDraft(): PendingDraft | null; // the draft under the cursor, when the anchor is a draft
}

const freshState = (key: string): ChatState => ({
  key,
  connection: "connecting",
  downReason: null,
  endReason: null,
  summary: null,
  liveText: "",
  streaming: false,
  blocked: null,
  degraded: false,
  overflowed: false,
  drafts: [],
  composer: "",
  composerFocused: true,
  cursor: 0,
  follow: true,
  reveal: false,
  showThinking: false,
  expanded: new Set(),
  lastOffset: null,
  error: null,
});

/**
 * chat-view domain (spec 2026-09-01 §8.5). The record ring lives in a ref
 * (`ringSize` persisted lines, default CHAT_RING); the summary is recomputed
 * only when a NON-delta record lands, and message_update deltas accumulate
 * into `liveText` through a `flushMs` flush — the spike showed per-delta
 * setState is survivable, and the batch is cheap insurance for slow
 * terminals.
 *
 * Ruling R21: `subscribeChat` (src/tui/chatClient.ts) treats `event: end` as
 * terminal and never reconnects on its own — daemon facts: `/chat/new` ends
 * every subscriber with `"session_reset"` and archives the transcript (the
 * next one starts at offset 0); daemon shutdown ends them with
 * `"daemon_stopped"` (the transcript persists). The hook owns
 * re-subscription: a subscription "generation" counter invalidates a
 * just-closed subscription's in-flight record/status/end callbacks and any
 * pending resubscribe timer, so a stale one is inert instead of touching
 * state for a subscription the hook has already moved on from. `end`'s
 * reason decides whether the resubscribe starts a fresh session
 * (`session_reset`: ring/summary/live-text cleared, `since: null`) or
 * resumes the same one (`daemon_stopped` and anything else: ring/summary
 * kept, `since: lastOffset` — read from a ref kept in sync on every record,
 * not from stale closure state).
 */
export function useChat({
  client,
  aliveRef,
  flushMs = CHAT_FLUSH_MS,
  ringSize = CHAT_RING,
  resubscribeMs = CHAT_RESUBSCRIBE_MS,
}: {
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
  flushMs?: number;
  ringSize?: number;
  resubscribeMs?: number;
}): ChatApi {
  const [chat, setChat] = useState<ChatState | null>(null);
  const ring = useRef<string[]>([]);
  const pendingDelta = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resubscribeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const keyRef = useRef<string | null>(null);
  /** The composer's live content, mirrored so `send` can tell "still what the
   *  operator was looking at" from "they typed while the POST was in flight"
   *  without closing over a render's state. Every writer of `composer` below
   *  keeps it in sync. */
  const composerRef = useRef("");
  const lastOffsetRef = useRef<number | null>(null);
  // Bumped by closeChat and by every connect() call: a callback or timer
  // captured against an earlier generation is stale and no-ops.
  const genRef = useRef(0);
  // Indirection so the recursive resubscribe call inside connect()'s own
  // `end` handler never needs `connect` in its own dependency array (which
  // exhaustive-deps would otherwise flag as a self-reference).
  const connectRef = useRef<(key: string, since: number | null) => void>(() => {});

  const flushDelta = useCallback((): void => {
    flushTimer.current = null;
    const d = pendingDelta.current;
    pendingDelta.current = "";
    if (d === "" || !aliveRef.current) return;
    setChat((s) => (s === null ? s : { ...s, liveText: s.liveText + d }));
  }, [aliveRef]);

  const reloadDrafts = useCallback(async (): Promise<void> => {
    const key = keyRef.current;
    if (key === null) return;
    const r = await client.listChatDrafts();
    if (!aliveRef.current || !r.ok) return;
    const mine = r.value.filter((d) => d.key === key);
    setChat((s) => (s === null || s.key !== key ? s : { ...s, drafts: mine }));
  }, [client, aliveRef]);

  const onRecord = useCallback(
    (offset: number | null, line: string): void => {
      const p = parseTranscriptLine(line);
      if (p.kind === "sdk" && p.event.type === "message_update") {
        const ev = p.event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ev?.type === "text_delta" && typeof ev.delta === "string") {
          pendingDelta.current += ev.delta;
          flushTimer.current ??= setTimeout(flushDelta, flushMs);
        }
        return;
      }
      let overflowed = false;
      ring.current.push(line);
      if (ring.current.length > ringSize) {
        ring.current.splice(0, ring.current.length - ringSize);
        overflowed = true;
      }
      const summary = summarizeTranscript(ring.current);
      const rec = p.kind === "junco" ? p.record : null;
      // Ruling R20: computed before setChat, not inside the updater — React
      // may run the updater lazily, so a flag set and read inside it can
      // observe the read happening before the write.
      const draftsChanged = rec?.type === "junco_chat_draft";
      setChat((s) => {
        if (s === null) return s;
        const n = anchorIds(summary).length;
        let next: ChatState = {
          ...s,
          summary,
          streaming: summary.live,
          overflowed: s.overflowed || overflowed,
          cursor: Math.min(s.cursor, Math.max(0, n - 1)),
          lastOffset: offset ?? s.lastOffset,
        };
        // Ruling R21 point 3: endReason clears here too, same as `blocked`.
        if (rec?.type === "junco_chat_turn_start")
          next = { ...next, liveText: "", blocked: null, endReason: null };
        if (rec?.type === "junco_chat_turn_end" || rec?.type === "junco_chat_turn_aborted")
          next = { ...next, liveText: "" };
        if (rec?.type === "junco_chat_turn_rejected")
          next = { ...next, blocked: { reason: rec.reason, until: rec.until } };
        if (rec?.type === "junco_chat_transcript_degraded") next = { ...next, degraded: true };
        return next;
      });
      if (draftsChanged) void reloadDrafts();
    },
    [flushDelta, flushMs, ringSize, reloadDrafts],
  );

  // Ruling R21: one subscription attempt. Wraps the raw record/status/end
  // handlers with a generation check so a callback firing after the hook has
  // moved on (closeChat, or a newer connect()) is inert. `end` schedules
  // exactly one resubscribe timer, stored in `resubscribeTimer` so closeChat
  // can cancel it.
  const connect = useCallback(
    (key: string, since: number | null): void => {
      const gen = ++genRef.current;
      // Mirrors closeChat's discipline: a resubscribe (the timer below
      // calling connectRef.current again) would otherwise overwrite
      // unsubRef.current without ever invoking the outgoing subscription's
      // cleanup — the only thing that runs the transport's ctrl.abort()
      // (chatClient.ts's `end` path returns without aborting).
      unsubRef.current?.();
      unsubRef.current = client.chat.subscribe(key, since, {
        record: (offset, line) => {
          if (genRef.current !== gen || !aliveRef.current) return;
          if (offset !== null) lastOffsetRef.current = offset;
          onRecord(offset, line);
        },
        status: (s, reason) => {
          if (genRef.current !== gen || !aliveRef.current) return;
          setChat((st) =>
            st === null || st.key !== key
              ? st
              : { ...st, connection: s, downReason: s === "down" ? (reason ?? null) : null },
          );
        },
        end: (reason) => {
          if (genRef.current !== gen || !aliveRef.current) return;
          setChat((st) =>
            st === null || st.key !== key ? st : { ...st, endReason: reason, streaming: false },
          );
          if (resubscribeTimer.current !== null) clearTimeout(resubscribeTimer.current);
          resubscribeTimer.current = setTimeout(() => {
            resubscribeTimer.current = null;
            if (genRef.current !== gen || !aliveRef.current || keyRef.current !== key) return;
            if (reason === "session_reset") {
              ring.current = [];
              pendingDelta.current = "";
              lastOffsetRef.current = null;
              setChat((st) =>
                st === null
                  ? st
                  : {
                      ...st,
                      summary: null,
                      liveText: "",
                      blocked: null,
                      degraded: false,
                      overflowed: false,
                      lastOffset: null,
                      cursor: 0,
                      streaming: false,
                    },
              );
              connectRef.current(key, null);
            } else {
              connectRef.current(key, lastOffsetRef.current);
            }
          }, resubscribeMs);
        },
      });
    },
    [client, aliveRef, onRecord, resubscribeMs],
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const closeChat = useCallback((): void => {
    genRef.current++; // invalidate any in-flight callbacks/timers
    unsubRef.current?.();
    unsubRef.current = null;
    keyRef.current = null;
    lastOffsetRef.current = null;
    composerRef.current = "";
    ring.current = [];
    pendingDelta.current = "";
    if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    if (resubscribeTimer.current !== null) clearTimeout(resubscribeTimer.current);
    resubscribeTimer.current = null;
    setChat(null);
  }, []);

  const openChat = useCallback(
    (key: string, opts?: { composer?: string }): void => {
      closeChat();
      keyRef.current = key;
      const composer = opts?.composer ?? "";
      // R32's restore ref is written by EVERY composer writer, the prefill
      // included: out of sync, the first failed POST would restore the ref's
      // stale "" over the prefilled thread.
      composerRef.current = composer;
      setChat({ ...freshState(key), composer }); // freshState focuses the composer already
      connect(key, null);
      void reloadDrafts();
    },
    [closeChat, connect, reloadDrafts],
  );

  useEffect(() => () => closeChat(), [closeChat]);

  const withKey = useCallback(
    async (fn: (key: string) => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
      const key = keyRef.current;
      if (key === null) return;
      const r = await fn(key);
      if (!aliveRef.current) return;
      if (!r.ok)
        setChat((s) => (s === null ? s : { ...s, error: r.error ?? "chat request failed" }));
    },
    [aliveRef],
  );

  /**
   * Ruling R32: the composer is emptied only once the POST has been ACCEPTED.
   * Clearing first threw the operator's message away on every failure —
   * silently, since nothing rendered `error` either.
   *
   * What is cleared is the composer's own content at send time (`before`),
   * not `text`: the slash router sends text the composer never held (`/pr 42`
   * submits the fetched PR body). It is left alone if the operator has typed
   * since, and put back if something else emptied the box while the POST was
   * in flight.
   */
  const send = useCallback(
    async (text: string): Promise<void> => {
      if (text.trim() === "") return;
      const key = keyRef.current;
      if (key === null) return;
      const before = composerRef.current;
      // Re-follow the tail: the operator has just written the newest row and
      // must see it (and the answer streaming under it), however far back
      // they had scrolled to read. Before the POST, so the prompt echo lands
      // in a followed window.
      setChat((s) => (s === null ? s : { ...s, error: null, follow: true }));
      const r = await client.chat.prompt(key, text);
      if (!aliveRef.current) return;
      if (r.ok) {
        if (composerRef.current !== before) return;
        composerRef.current = "";
        setChat((s) => (s === null ? s : { ...s, composer: "" }));
        return;
      }
      const composer = composerRef.current === "" ? before : composerRef.current;
      composerRef.current = composer;
      setChat((s) =>
        s === null ? s : { ...s, composer, error: r.error ?? "chat request failed" },
      );
    },
    [client, aliveRef],
  );
  const abort = useCallback(
    (): Promise<void> => withKey((key) => client.chat.abort(key)),
    [client, withKey],
  );
  // Ruling R21 point 4: fresh() only POSTs — no ring clearing here. The
  // reset happens in connect()'s `end("session_reset")` handler above, once
  // the daemon actually confirms the session ended and archives the old
  // transcript.
  const freshSession = useCallback(
    (): Promise<void> => withKey((key) => client.chat.fresh(key)),
    [client, withKey],
  );

  /** Consumed by useChatInput's toast effect: an error is shown once, then
   *  cleared, so the next failure toasts again even if it says the same thing. */
  const clearError = useCallback(
    (): void => setChat((s) => (s === null || s.error === null ? s : { ...s, error: null })),
    [],
  );
  const setComposer = useCallback((composer: string): void => {
    composerRef.current = composer;
    setChat((s) => (s === null ? s : { ...s, composer }));
  }, []);
  const focusComposer = useCallback(
    (composerFocused: boolean): void =>
      setChat((s) => (s === null ? s : { ...s, composerFocused })),
    [],
  );
  const moveCursor = useCallback(
    (delta: number): void =>
      setChat((s) => {
        if (s === null || s.summary === null) return s;
        const n = anchorIds(s.summary).length;
        // Nothing to move to ⇒ nothing changes, `follow` included. `tab` is
        // the cursor key now (chat-scroll brief) and a plain Q&A chat has no
        // anchors at all: dropping follow here unpinned the window from the
        // tail and, with a never-scrolled offset of 0, jumped it to the top.
        if (n === 0) return s;
        // Following means "at the tail", so a move out of follow steps from
        // the LAST card (useTranscript.moveCursor's rule): `s.cursor` is the
        // stale 0 the tail never moved, and stepping from it revealed the
        // second card from the top. `reveal` even when the clamp leaves the
        // index alone: tab on the last card after scrolling away from it
        // should still bring it back.
        const from = s.follow ? n - 1 : s.cursor;
        return {
          ...s,
          cursor: Math.max(0, Math.min(from + delta, n - 1)),
          follow: false,
          reveal: true,
        };
      }),
    [],
  );
  const ackReveal = useCallback(
    (): void => setChat((s) => (s === null || !s.reveal ? s : { ...s, reveal: false })),
    [],
  );
  const toggleExpanded = useCallback(
    (): void =>
      setChat((s) => {
        if (s === null || s.summary === null) return s;
        const id = anchorIds(s.summary)[s.cursor];
        if (id === undefined || id.startsWith("draft:")) return s;
        const expanded = new Set(s.expanded);
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        return { ...s, expanded };
      }),
    [],
  );
  const toggleThinking = useCallback(
    (): void => setChat((s) => (s === null ? s : { ...s, showThinking: !s.showThinking })),
    [],
  );
  const setFollow = useCallback(
    (follow: boolean): void => setChat((s) => (s === null ? s : { ...s, follow })),
    [],
  );
  const selectedDraft = useCallback((): PendingDraft | null => {
    if (chat === null || chat.summary === null) return null;
    const id = anchorIds(chat.summary)[chat.cursor];
    if (id === undefined || !id.startsWith("draft:")) return null;
    const draftId = id.slice("draft:".length);
    return chat.drafts.find((d) => d.id === draftId) ?? null;
  }, [chat]);

  return {
    chat,
    openChat,
    closeChat,
    send,
    abort,
    fresh: freshSession,
    clearError,
    setComposer,
    focusComposer,
    moveCursor,
    ackReveal,
    toggleExpanded,
    toggleThinking,
    setFollow,
    reloadDrafts,
    selectedDraft,
  };
}
