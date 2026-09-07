import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { ChatConnState } from "../chatClient.js";
import type { PendingDraft } from "../../chat/draftStore.js";
import {
  anchorIds,
  commandAnchor,
  extendSummary,
  SummaryBuilder,
  thinkingAnchor,
  type SummaryState,
  type TranscriptSummary,
} from "../../transcriptSummary.js";
import { parseTranscriptLine, type JuncoRecord } from "../../agent/transcriptSchema.js";
import {
  applyLiveRecord,
  isLiveThinkingAnchor,
  liveAnchorIds,
  startLiveTurn,
  type LiveTurnState,
} from "../../chat/liveBlocks.js";

export const CHAT_RING = 2000;
/** Ruling R21: delay before the hook resubscribes after a terminal `end` —
 * long enough that a flapping connection doesn't spin-subscribe, short
 * enough that an operator staring at "reconnecting"/"session reset" text
 * (rendered by a later task's header) sees the pane come back quickly. */
const CHAT_RESUBSCRIBE_MS = 1000;

export interface ChatState {
  key: string;
  connection: ChatConnState;
  /** Ruling R32: the daemon's own word for a non-2xx refusal (chat_disabled,
   *  no_checkout, not_a_repo, unknown_key …). Null while live, and null for a
   *  transport-level down — which genuinely means only "daemon down". */
  downReason: string | null;
  endReason: string | null;
  summary: TranscriptSummary | null; // over the ring, excluding message_update
  /** Spec 2026-09-06 §3.1: the in-flight turn as blocks (bus-only records),
   *  null when idle. Published once per flush — never mutated in place. */
  live: LiveTurnState | null;
  streaming: boolean;
  blocked: { reason: string; until: string | null } | null;
  degraded: boolean;
  overflowed: boolean; // ring dropped records: header shows "showing last <ringSize>"
  drafts: PendingDraft[]; // parked drafts for this key
  composer: string;
  composerFocused: boolean;
  cursor: number; // index into chatAnchorIds(summary, live)
  follow: boolean;
  /** A cursor move that landed owes the window a nudge onto the anchor —
   * TranscriptBody paints it once and acks through `ackReveal`. */
  reveal: boolean;
  /** `t` pins the thinking block open (spec §3.1): unpinned, the live block
   *  shows while it streams and folds when done; pinned keeps it open and
   *  expands the finished turns' thinking rows the way `showThinking` did. */
  thinking: { pinned: boolean };
  /** Tool-call ids whose card body is open, and (#511) finished thinking
   *  anchors (`thinkingAnchor(run, turn)`) whose block `t` opened on its own. */
  expanded: ReadonlySet<string>;
  lastOffset: number | null;
  error: string | null; // last POST failure (toast-worthy)
  /** A junco_submit the operator still owns (spec 2026-09-03 §4.1): awaiting
   *  their y/n, or — once they said y — `running` while the daemon's CLI is
   *  still going (#478), which disarms y/n and re-words the header. */
  pending: {
    commandId: string;
    draftId: string;
    ids: string[];
    route: "inbox" | "issue";
    running: boolean;
  } | null;
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
  /** Toggle a tool card's body (spec 2026-09-06 §4.4): `id` names the card
   *  (the `x` verb reads it off the cursor), else the anchor under the cursor
   *  (enter/space). A live card toggles `live.expanded`, a finished one the
   *  `expanded` set — the id is the same tool-call id on both sides. */
  toggleExpanded(id?: string): void;
  /** `t` (spec §4.3, #511): with the cursor engaged (not following) on a
   *  thinking header, toggle THAT block — a live one in `live.expanded`, a
   *  finished one in `expanded`, the tool cards' mechanism; anywhere else
   *  flip the global pin. */
  toggleThinking(): void;
  setFollow(on: boolean): void;
  reloadDrafts(): Promise<void>;
  selectedDraft(): PendingDraft | null; // the draft under the cursor, when the anchor is a draft
  /** Answer the pending junco_submit card (spec 2026-09-03 §4.3). */
  decide(decision: "run" | "decline"): Promise<void>;
}

/**
 * The chat view's cursor space (spec 2026-09-06 §4.4): the finished anchors
 * (thinking headers ∪ tool ids ∪ draft/command cards, transcriptSummary.ts's
 * `anchorIds`) and then the live turn's thinking headers and tool cards
 * (liveBlocks.ts's `liveAnchorIds`), so the cursor can land on a card that is
 * still running or a block still streaming (#511). A live id the summary
 * already holds is not repeated — the card keeps ONE index across the turn
 * end. ChatView (the body's `anchors`), useChatInput (the anchor under the
 * cursor) and the clamps below all read this one function.
 */
export function chatAnchorIds(
  summary: TranscriptSummary | null,
  live: LiveTurnState | null,
): string[] {
  return mergeAnchorIds(summary === null ? [] : anchorIds(summary), liveAnchorIds(live));
}

/** `chatAnchorIds` from its two halves — ChatView memoizes each on its own
 * input so a flush that adds no tool card keeps the array's identity. */
export function mergeAnchorIds(finished: string[], live: string[]): string[] {
  if (live.length === 0) return finished;
  const seen = new Set(finished);
  return [...finished, ...live.filter((id) => !seen.has(id))];
}

/** `set` with `id` added or removed — the expand toggle tool cards and (#511)
 * thinking blocks share, on both the live and the finished set. */
function toggleIn(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * `expanded` after a turn end (spec 2026-09-06 §4.4): a card the operator
 * opened stays open past the turn end — the finished turn's card has the same
 * tool-call id, so the live set folds into the finished one. A live thinking
 * block they opened (#511) folds onto the finished turn's ONE thinking anchor
 * (`summary` already holds the turn that just closed: the last run's last
 * turn); its `think:live:*` id names nothing once the turn is over.
 */
function foldLiveExpanded(s: ChatState, summary: TranscriptSummary): ReadonlySet<string> {
  if (s.live === null || s.live.expanded.size === 0) return s.expanded;
  const next = new Set(s.expanded);
  let openThinking = false;
  for (const id of s.live.expanded) {
    if (isLiveThinkingAnchor(id)) openThinking = true;
    else next.add(id);
  }
  const runIdx = summary.runs.length - 1;
  const turn = summary.runs[runIdx]?.turns.at(-1);
  if (openThinking && turn !== undefined) next.add(thinkingAnchor(runIdx, turn.index));
  return next;
}

/**
 * `t` (spec §4.3, #511): per-block only while the cursor is engaged —
 * following means the operator has not walked to anything (tab drops
 * follow), and index 0 of a fresh chat is often a thinking header, where `t`
 * must still be the global pin it has always been. On a live header the
 * block's anchor toggles in `live.expanded`, on a finished one in `expanded`.
 */
function toggleThinkingState(s: ChatState): ChatState {
  const id = s.follow ? undefined : chatAnchorIds(s.summary, s.live)[s.cursor];
  if (id === undefined || !id.startsWith("think:"))
    return { ...s, thinking: { pinned: !s.thinking.pinned } };
  if (isLiveThinkingAnchor(id))
    return s.live === null
      ? s
      : { ...s, live: { ...s.live, expanded: toggleIn(s.live.expanded, id) } };
  return { ...s, expanded: toggleIn(s.expanded, id) };
}

const freshState = (key: string): ChatState => ({
  key,
  connection: "connecting",
  downReason: null,
  endReason: null,
  summary: null,
  live: null,
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
  thinking: { pinned: false },
  expanded: new Set(),
  lastOffset: null,
  error: null,
  pending: null,
});

/** The three bus-only record types (spec 2026-09-06 §1.1) — never in the
 *  ring, never persisted; `parseTranscriptLine` hands them over as `junco`
 *  records whose `type` the persisted union does not know. */
const LIVE_TYPES: ReadonlySet<string> = new Set([
  "junco_chat_delta",
  "junco_chat_tool",
  "junco_chat_partial",
]);
const isLiveRecord = (rec: JuncoRecord): boolean => LIVE_TYPES.has((rec as { type: string }).type);

/** Lines an overflow splice drops at once (#510): a tenth of the ring, at least one. */
export const overflowBatch = (ringSize: number): number => Math.max(1, Math.floor(ringSize / 10));

/** `summarizeTranscript(ring)` that hands back the builder instead of only its
 *  result, so it survives as the carried state after a splice: the next
 *  `batch - 1` pushes extend it rather than start from an empty one. */
function rebuildSummary(ring: readonly string[]): SummaryState {
  const b = new SummaryBuilder();
  for (const line of ring) b.push(line);
  return b;
}

/**
 * chat-view domain (spec 2026-09-01 §8.5). The record ring lives in a ref
 * (`ringSize` persisted lines, default CHAT_RING); the summary is extended
 * one record at a time (`extendSummary`, spec 2026-09-06 §3.3) with the
 * builder state kept in a ref, and rebuilt from the whole ring when the
 * ring overflows — so the invariant is: `summaryState` is null exactly when
 * the ring is empty, and otherwise is the builder that has seen exactly the
 * ring's lines (a whole-ring rebuild follows every splice). An overflow splices `overflowBatch(ringSize)`
 * (`max(1, floor(ringSize / 10))`) oldest lines in one go, not one (#510):
 * the ring then holds between `ringSize - batch + 1` and `ringSize` lines and
 * the O(ring) recompute runs once per `batch` records instead of on every
 * push once the ring is full. `overflowed` is sticky once set and the header
 * still reads "showing last <ringSize>" (an upper bound, as before).
 *
 * The live turn (spec 2026-09-06 §3.2, §3.4): bus-only records fold into a
 * pending `LiveTurnState` synchronously in the SSE callback (a string
 * append) and a `setImmediate` flush publishes it in ONE setState per frame
 * — a NEW `live` object each time, which is what the live rows memo keys on
 * (#511 dropped the separate frame counter); Ink's `maxFps` then bounds the
 * paint rate. The old 50 ms trailing timer is gone.
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
 * (`session_reset`: ring/summary/live turn cleared, `since: null`) or
 * resumes the same one (`daemon_stopped` and anything else: ring/summary
 * kept, `since: lastOffset` — read from a ref kept in sync on every record,
 * not from stale closure state).
 */
export function useChat({
  client,
  aliveRef,
  ringSize = CHAT_RING,
  resubscribeMs = CHAT_RESUBSCRIBE_MS,
  onSummaryRebuild,
}: {
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
  ringSize?: number;
  resubscribeMs?: number;
  /** Test-only seam (#510): called with the ring's length each time an
   *  overflow splice triggers the whole-ring `summarizeTranscript` recompute,
   *  so a test can count rebuilds and bound the ring without reaching into
   *  the hook's refs. Production callers leave it unset. */
  onSummaryRebuild?: (ringLength: number) => void;
}): ChatApi {
  const [chat, setChat] = useState<ChatState | null>(null);
  const ring = useRef<string[]>([]);
  /** The incremental summary's carried builder; see the invariant above. */
  const summaryState = useRef<SummaryState | null>(null);
  /** The live turn between flushes — the only copy the SSE callback writes. */
  const pendingLive = useRef<LiveTurnState | null>(null);
  const flushScheduled = useRef(false);
  const resubscribeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const keyRef = useRef<string | null>(null);
  /** The composer's live content, mirrored so `send` can tell "still what the
   *  operator was looking at" from "they typed while the POST was in flight"
   *  without closing over a render's state. Every writer of `composer` below
   *  keeps it in sync. */
  const composerRef = useRef("");
  /** The card `decide` answers, mirrored so the POST reads the latest record
   *  rather than a render's closure (the y/n key and the footer chip both call
   *  it from outside this hook). Written by every writer of `pending`, the way
   *  `composerRef` is (#481) — NOT in an effect: `decide` runs off a keystroke
   *  that can land before React has flushed a passive effect, and a ref that
   *  lags there drops the operator's `y` outright (CI, PR #484). */
  const pendingRef = useRef<ChatState["pending"]>(null);
  const lastOffsetRef = useRef<number | null>(null);
  // Bumped by closeChat and by every connect() call: a callback or timer
  // captured against an earlier generation is stale and no-ops.
  const genRef = useRef(0);
  // Indirection so the recursive resubscribe call inside connect()'s own
  // `end` handler never needs `connect` in its own dependency array (which
  // exhaustive-deps would otherwise flag as a self-reference).
  const connectRef = useRef<(key: string, since: number | null) => void>(() => {});

  const flushLive = useCallback((): void => {
    flushScheduled.current = false;
    if (!aliveRef.current) return;
    const live = pendingLive.current;
    // `expanded` is React state (toggleExpanded), not the accumulator's: a
    // flush of the same turn carries the operator's toggles over.
    setChat((s) =>
      s === null
        ? s
        : {
            ...s,
            live:
              live !== null && s.live !== null && s.live.turn === live.turn
                ? { ...live, expanded: s.live.expanded }
                : live,
          },
    );
  }, [aliveRef]);
  const scheduleFlush = useCallback((): void => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    setImmediate(flushLive);
  }, [flushLive]);

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
      // Never in the ring: the summary excludes provider deltas, and the
      // daemon's bus-only records carry the live turn instead (spec §1.1).
      if (p.kind === "sdk" && p.event.type === "message_update") return;
      const rec = p.kind === "junco" ? p.record : null;
      if (rec !== null && isLiveRecord(rec)) {
        pendingLive.current = applyLiveRecord(pendingLive.current, rec);
        scheduleFlush();
        return;
      }
      let overflowed = false;
      let summary: TranscriptSummary;
      ring.current.push(line);
      if (ring.current.length > ringSize) {
        // One splice of a batch, so the next `batch - 1` pushes stay
        // incremental (see the invariant above; #510).
        ring.current.splice(0, ring.current.length - ringSize + overflowBatch(ringSize) - 1);
        overflowed = true;
        summaryState.current = rebuildSummary(ring.current);
        summary = summaryState.current.result();
        onSummaryRebuild?.(ring.current.length);
      } else {
        // The builder is authoritative (`_prev` is documented as unread).
        const r = extendSummary(null, summaryState.current, line);
        summaryState.current = r.state;
        summary = r.summary;
      }
      // Ruling R20: computed before setChat, not inside the updater — React
      // may run the updater lazily, so a flag set and read inside it can
      // observe the read happening before the write.
      const draftsChanged = rec?.type === "junco_chat_draft";
      // Spec 2026-09-03 §4.1: a `proposed` command is the operator's card and
      // `running` is that same card mid-submit (#478); any other status is its
      // one terminal record (the daemon archived the draft it submitted, hence
      // the reload below).
      const command = rec?.type === "junco_chat_command" ? rec : null;
      const settledCommand =
        command !== null && command.status !== "proposed" && command.status !== "running";
      // Spec 2026-09-06 §3.2: a turn start opens the pending live turn under
      // its id (`ts` for a transcript written before ids existed); its end
      // drops it — the finished turn arrives through the summary. Outside the
      // updater (R20): `pendingLive` is the SSE callback's, not React's.
      if (rec?.type === "junco_chat_turn_start") {
        pendingLive.current = startLiveTurn(rec.turn ?? rec.ts);
      } else if (rec?.type === "junco_chat_turn_end" || rec?.type === "junco_chat_turn_aborted") {
        pendingLive.current = null;
      }
      // Ruling R20 again: outside the updater, which React may run lazily.
      // The same three transitions the updater below makes, on the ref the
      // y/n keystroke reads.
      if (command !== null) {
        if (settledCommand) {
          if (pendingRef.current?.commandId === command.commandId) pendingRef.current = null;
        } else {
          pendingRef.current = {
            commandId: command.commandId,
            draftId: command.draftId,
            ids: command.ids,
            route: command.route,
            running: command.status === "running",
          };
        }
      }
      setChat((s) => {
        if (s === null) return s;
        let next: ChatState = {
          ...s,
          summary,
          streaming: summary.live,
          overflowed: s.overflowed || overflowed,
          lastOffset: offset ?? s.lastOffset,
        };
        // Ruling R21 point 3: endReason clears here too, same as `blocked`.
        if (rec?.type === "junco_chat_turn_start")
          next = { ...next, live: null, blocked: null, endReason: null };
        if (rec?.type === "junco_chat_turn_end" || rec?.type === "junco_chat_turn_aborted") {
          next = { ...next, live: null, expanded: foldLiveExpanded(s, summary) };
        }
        const n = chatAnchorIds(summary, next.live).length;
        next = { ...next, cursor: Math.min(s.cursor, Math.max(0, n - 1)) };
        if (rec?.type === "junco_chat_turn_rejected")
          next = { ...next, blocked: { reason: rec.reason, until: rec.until } };
        if (rec?.type === "junco_chat_transcript_degraded") next = { ...next, degraded: true };
        // The card must not be missable: the proposal blurs the composer and
        // parks the cursor on its anchor, owing the window one reveal (#474's
        // cursor + reveal + follow: false contract).
        if (command?.status === "proposed") {
          const at = anchorIds(summary).indexOf(commandAnchor(command.commandId));
          next = {
            ...next,
            pending: {
              commandId: command.commandId,
              draftId: command.draftId,
              ids: command.ids,
              route: command.route,
              running: false,
            },
            composerFocused: false,
            ...(at >= 0 ? { cursor: at, follow: false, reveal: true } : {}),
          };
        } else if (command?.status === "running") {
          // #478: the card stays — it is the operator's until the CLI's
          // terminal record lands — but `running` disarms y/n (`decide`
          // refuses) and re-words the header. A replayed transcript rebuilds
          // this the same way, so a dashboard restarted mid-submit shows it
          // too; the composer stays blurred until the command settles.
          next = {
            ...next,
            pending: {
              commandId: command.commandId,
              draftId: command.draftId,
              ids: command.ids,
              route: command.route,
              running: true,
            },
            composerFocused: false,
          };
        } else if (settledCommand && next.pending?.commandId === command.commandId) {
          // Controller ruling R2 (fix round 1): the settling record undoes the
          // proposal's parking unconditionally — the transcript replays on
          // every (re)connect and the reducer cannot tell a replayed pair from
          // a live one, so a chat whose history holds an answered card used to
          // open scrolled to it, follow paused, composer blurred. After a
          // decision the operator wants the tail (the model's closing text
          // streams there) and a composer to reply with — send()'s semantics
          // since #475. The cursor stays put: the card is still reachable with
          // `tab`/`⏎`.
          next = { ...next, pending: null, follow: true, composerFocused: true };
        }
        return next;
      });
      if (draftsChanged || settledCommand) void reloadDrafts();
    },
    [scheduleFlush, ringSize, reloadDrafts, onSummaryRebuild],
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
              summaryState.current = null;
              pendingLive.current = null;
              lastOffsetRef.current = null;
              pendingRef.current = null;
              setChat((st) =>
                st === null
                  ? st
                  : {
                      ...st,
                      summary: null,
                      live: null,
                      blocked: null,
                      degraded: false,
                      overflowed: false,
                      lastOffset: null,
                      cursor: 0,
                      streaming: false,
                      // Defensive: in production the tool's own
                      // `junco_chat_command{aborted}` record precedes the
                      // reset, so `pending` is already null — but a reset
                      // drops the records the card is derived from, and a
                      // card with no record behind it can never be answered.
                      pending: null,
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
    pendingRef.current = null;
    ring.current = [];
    summaryState.current = null;
    // A flush already scheduled runs against the cleared ref and a null
    // state: `setChat(null)` below wins, the flush's updater is a no-op.
    pendingLive.current = null;
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
        if (s === null) return s;
        const n = chatAnchorIds(s.summary, s.live).length;
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
    (target?: string): void =>
      setChat((s) => {
        if (s === null) return s;
        const id = target ?? chatAnchorIds(s.summary, s.live)[s.cursor];
        // A draft card has no body to show; a `cmd:` card has the CLI output.
        if (id === undefined || id.startsWith("draft:")) return s;
        // A live card (spec 2026-09-06 §4.4) toggles the live turn's set; the
        // turn end folds it into `expanded` under the same id.
        if (s.live !== null && s.live.blocks.some((b) => b.kind === "tool" && b.id === id))
          return { ...s, live: { ...s.live, expanded: toggleIn(s.live.expanded, id) } };
        return { ...s, expanded: toggleIn(s.expanded, id) };
      }),
    [],
  );
  const toggleThinking = useCallback(
    (): void => setChat((s) => (s === null ? s : toggleThinkingState(s))),
    [],
  );
  const setFollow = useCallback(
    (follow: boolean): void => setChat((s) => (s === null ? s : { ...s, follow })),
    [],
  );
  /** Spec 2026-09-03 §4.5: `settled: false` is the daemon saying nothing was
   *  pending under that id — another dashboard answered first, or it expired.
   *  Not a transport error, but the operator's error to see. A `running` card
   *  (#478) is already decided: y/n are disarmed here rather than sent for a
   *  409 the operator would read as a lost keystroke. */
  const decide = useCallback(
    async (decision: "run" | "decline"): Promise<void> => {
      const key = keyRef.current;
      const pending = pendingRef.current;
      if (key === null || pending === null) return;
      if (pending.running) {
        setChat((s) => (s === null ? s : { ...s, error: "that submit is already running" }));
        return;
      }
      const r = await client.chat.decide(key, pending.commandId, decision);
      if (!aliveRef.current) return;
      const error = !r.ok
        ? r.error
        : r.value.settled
          ? null
          : "that confirmation is no longer pending";
      if (error !== null) setChat((s) => (s === null ? s : { ...s, error }));
    },
    [client, aliveRef],
  );
  const selectedDraft = useCallback((): PendingDraft | null => {
    if (chat === null || chat.summary === null) return null;
    const id = chatAnchorIds(chat.summary, chat.live)[chat.cursor];
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
    decide,
  };
}
