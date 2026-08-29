import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { DashboardClient } from "../ghClient.js";
import { toolCallIds, type TranscriptSummary } from "../../transcriptSummary.js";

export interface TranscriptState {
  id: string;
  path: string | null;
  /** Opened from a RUNNING row: a missing file means "not started yet", not an error. */
  expectLive: boolean;
  loading: boolean;
  /** Terminal read error, or `no transcript for <id>`. */
  error: string | null;
  /** Size of the last read — the client's stat gate. */
  size: number | null;
  summary: TranscriptSummary | null;
  showThinking: boolean;
  /** Pin the viewport to the tail (live). Defaults to `expectLive`. */
  follow: boolean;
  /** Index into `toolCallIds(summary)`; clamped on every read. */
  cursor: number;
  expanded: ReadonlySet<string>;
}

export interface TranscriptApi {
  transcript: TranscriptState | null;
  openTranscript: (id: string, opts: { expectLive: boolean }) => void;
  closeTranscript: () => void;
  toggleThinking: () => void;
  setFollow: (on: boolean) => void;
  /** Move the tool-call cursor; clamps; pauses follow. */
  moveCursor: (delta: number) => void;
  setCursor: (idx: number) => void;
  /** Expand/collapse the cursor's tool result. */
  toggleExpanded: () => void;
}

/**
 * transcript-view domain: the open transcript's state plus its live poll.
 * Like useReview, navigation is the caller's job — App's queue `enter`
 * opens the state AND sets the view; `close` clears it AND navigates back.
 *
 * The poll runs only while the file is still being written (`summary.live`)
 * or, for a running ticket, not yet created (`summary === null &&
 * expectLive`). The client stat-gates the read, so the steady state is one
 * stat per tick; the first read that reports `live: false` ends the poll.
 */
export function useTranscript({
  client,
  aliveRef,
  pollMs = 1_000,
}: {
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
  pollMs?: number;
}): TranscriptApi {
  const [transcript, setTranscript] = useState<TranscriptState | null>(null);

  // The interval's lifecycle is driven entirely by `polling` below — reactive
  // React state, exactly spec §4's predicate — via the effect's dependency
  // array: that reactive value is what starts the interval on a false→true
  // transition and clears it on true→false. `pollRef` is NOT the lifecycle
  // driver; it is a synchronous terminal stop-flag a tick consults right
  // before dispatching. `readOnce`'s `.then` updates it from the read result
  // BEFORE calling `setTranscript`, so a tick can never issue a read after
  // the terminal result has already resolved but before React has committed
  // the corresponding state update and re-run this effect. Under Ink's
  // legacy root, state updates take the sync lane and flush in a microtask —
  // ahead of any `setInterval` macrotask — so in practice that window rarely
  // opens; the ref makes the guarantee hold regardless of that scheduling
  // detail.
  const pollRef = useRef<{
    id: string;
    expectLive: boolean;
    size: number | null;
    polling: boolean;
  } | null>(null);

  const readOnce = useCallback(
    (id: string, prevSize: number | null): Promise<void> => {
      return client.readTranscript(id, prevSize).then((r) => {
        if (!aliveRef.current) return;
        const p = pollRef.current;
        if (p !== null && p.id === id) {
          if (!r.ok) {
            p.polling = false;
          } else if (r.value.kind === "read") {
            p.size = r.value.size;
            p.polling = r.value.summary.live;
          } else if (r.value.kind === "missing") {
            p.polling = p.expectLive;
          }
          // "unchanged": leave p.size/p.polling as they are.
        }
        setTranscript((s) => {
          if (s === null || s.id !== id) return s; // closed or reopened meanwhile
          if (!r.ok) return { ...s, loading: false, error: r.error };
          const v = r.value;
          if (v.kind === "unchanged") return s.loading ? { ...s, loading: false } : s;
          if (v.kind === "missing")
            return {
              ...s,
              loading: false,
              path: v.path,
              error: s.expectLive ? null : `no transcript for ${id}`,
            };
          const n = toolCallIds(v.summary).length;
          return {
            ...s,
            loading: false,
            error: null,
            size: v.size,
            summary: v.summary,
            cursor: Math.min(s.cursor, Math.max(0, n - 1)),
          };
        });
      });
    },
    [client, aliveRef],
  );

  const openTranscript = useCallback(
    (id: string, opts: { expectLive: boolean }): void => {
      pollRef.current = { id, expectLive: opts.expectLive, size: null, polling: opts.expectLive };
      setTranscript({
        id,
        path: null,
        expectLive: opts.expectLive,
        loading: true,
        error: null,
        size: null,
        summary: null,
        showThinking: false,
        follow: opts.expectLive,
        cursor: 0,
        expanded: new Set(),
      });
      void readOnce(id, null);
    },
    [readOnce],
  );

  const id = transcript?.id ?? null;
  const polling =
    transcript !== null &&
    transcript.error === null &&
    (transcript.summary !== null ? transcript.summary.live : transcript.expectLive);

  useEffect(() => {
    if (!polling || id === null) return;
    // Guard against overlapping ticks: setInterval fires on a fixed schedule
    // regardless of whether the previous readOnce has resolved. Without this,
    // a slow tick (state update lagging behind the timer under load) lets a
    // stale tick sneak in an extra read while one is already outstanding.
    let inFlight = false;
    const t = setInterval(() => {
      if (inFlight) return;
      const p = pollRef.current;
      if (p === null || p.id !== id || !p.polling) return; // terminal read already landed
      inFlight = true;
      readOnce(id, p.size).then(
        () => {
          inFlight = false;
        },
        () => {
          inFlight = false;
        },
      );
    }, pollMs);
    return () => clearInterval(t);
  }, [polling, id, pollMs, readOnce]);

  const closeTranscript = useCallback((): void => {
    pollRef.current = null;
    setTranscript(null);
  }, []);
  const toggleThinking = useCallback(
    (): void => setTranscript((s) => (s === null ? s : { ...s, showThinking: !s.showThinking })),
    [],
  );
  const setFollow = useCallback(
    (on: boolean): void => setTranscript((s) => (s === null ? s : { ...s, follow: on })),
    [],
  );
  const setCursor = useCallback(
    (idx: number): void =>
      setTranscript((s) => {
        if (s === null || s.summary === null) return s;
        const n = toolCallIds(s.summary).length;
        if (n === 0) return s;
        return { ...s, cursor: Math.max(0, Math.min(idx, n - 1)), follow: false };
      }),
    [],
  );
  const moveCursor = useCallback(
    (delta: number): void =>
      setTranscript((s) => {
        if (s === null || s.summary === null) return s;
        const n = toolCallIds(s.summary).length;
        if (n === 0) return s;
        return { ...s, cursor: Math.max(0, Math.min(s.cursor + delta, n - 1)), follow: false };
      }),
    [],
  );
  const toggleExpanded = useCallback(
    (): void =>
      setTranscript((s) => {
        if (s === null || s.summary === null) return s;
        const target = toolCallIds(s.summary)[s.cursor];
        if (target === undefined) return s;
        const expanded = new Set(s.expanded);
        if (expanded.has(target)) expanded.delete(target);
        else expanded.add(target);
        return { ...s, expanded };
      }),
    [],
  );

  return {
    transcript,
    openTranscript,
    closeTranscript,
    toggleThinking,
    setFollow,
    moveCursor,
    setCursor,
    toggleExpanded,
  };
}
