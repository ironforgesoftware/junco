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

  const computePolling = (s: TranscriptState): boolean =>
    s.error === null && (s.summary !== null ? s.summary.live : s.expectLive);

  // `size`/`polling` for the interval tick below, updated SYNCHRONOUSLY
  // (inside the setTranscript updater, which React invokes immediately —
  // not deferred to a re-render) so a tick never acts on a stale decision.
  // A version keyed only off React state would leave a window, between a
  // terminal read resolving and React actually committing + re-running the
  // effect, where a fixed-schedule setInterval tick can still fire and
  // issue one extra read — this ref closes that window by making the
  // stop-polling decision available the instant the read completes.
  const pollRef = useRef<{ size: number | null; polling: boolean } | null>(null);

  const readOnce = useCallback(
    (id: string, prevSize: number | null): Promise<void> => {
      return client.readTranscript(id, prevSize).then((r) => {
        if (!aliveRef.current) return;
        setTranscript((s) => {
          if (s === null || s.id !== id) return s; // closed or reopened meanwhile
          let next: TranscriptState;
          if (!r.ok) {
            next = { ...s, loading: false, error: r.error };
          } else {
            const v = r.value;
            if (v.kind === "unchanged") {
              next = s.loading ? { ...s, loading: false } : s;
            } else if (v.kind === "missing") {
              next = {
                ...s,
                loading: false,
                path: v.path,
                error: s.expectLive ? null : `no transcript for ${id}`,
              };
            } else {
              const n = toolCallIds(v.summary).length;
              next = {
                ...s,
                loading: false,
                error: null,
                size: v.size,
                summary: v.summary,
                cursor: Math.min(s.cursor, Math.max(0, n - 1)),
              };
            }
          }
          pollRef.current = { size: next.size, polling: computePolling(next) };
          return next;
        });
      });
    },
    [client, aliveRef],
  );

  const openTranscript = useCallback(
    (id: string, opts: { expectLive: boolean }): void => {
      pollRef.current = { size: null, polling: opts.expectLive };
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

  useEffect(() => {
    if (id === null || !(pollRef.current?.polling ?? false)) return;
    // Guard against overlapping ticks: setInterval fires on a fixed schedule
    // regardless of whether the previous readOnce has resolved. Without this,
    // a slow tick (state update lagging behind the timer under load) lets a
    // stale tick sneak in an extra read while one is already outstanding.
    let inFlight = false;
    const t = setInterval(() => {
      if (inFlight) return;
      const p = pollRef.current;
      if (p === null || !p.polling) return; // terminal read already landed
      inFlight = true;
      void readOnce(id, p.size).finally(() => {
        inFlight = false;
      });
    }, pollMs);
    return () => clearInterval(t);
  }, [id, pollMs, readOnce]);

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
