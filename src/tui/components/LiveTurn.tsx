/**
 * Rows for the in-flight chat turn (spec 2026-09-06 §4.1): built from
 * `live.blocks` alone, keyed on `live`'s identity (useChat.ts publishes a new
 * object per flush and `applyLiveRecord` returns a new one per record — #511
 * dropped the redundant frame counter), so the cost per frame is O(bytes in
 * the live turn) and the finished history (FinishedTurns.tsx) is never
 * touched.
 *
 * Text blocks render exactly as the finished answer will (transcriptRender
 * .ts's `chatAnswerRows` — markdown, `junco: ` label on the first row in
 * accent, the rest indented) so nothing jumps when the turn ends and the
 * renderer takes over. The turn's text blocks are joined into ONE answer, as
 * the finished turn's `text` is, and typeset through a single `MdCache` held
 * in a ref and dropped with the turn (spec §4.2): a frame re-renders only
 * the open tail block. Thinking blocks are spec §4.3's four states (below).
 * Tool blocks are spec §4.4's cards (ToolCard.tsx): the spinner frame comes
 * from Ink's shared animation timer, ticking only while a tool is running,
 * and a card's expansion is `live.expanded` (toggled by `x`/enter).
 *
 * Thinking (spec §4.3, D4): while a block streams, its header `· thinking ·
 * <elapsed>s` ticks off `startedAt` against a 1 s clock and the body follows
 * in tone `thinking`, plain-wrapped (reasoning is not prose to typeset); once
 * `done` it folds to `▸ thinking · <dur>s` — or stays open under `▾` when
 * the operator pinned it (`t`) or, #511, expanded this block alone (`t` on
 * its header: the row carries `liveThinkingAnchor(contentIndex)`, a cursor
 * stop, and the id lives in `live.expanded` like a tool card's). The header
 * is the SAME string transcriptRender.ts prints for the finished turn, so
 * the row does not change shape at turn end.
 *
 * `dur` is `doneAt - startedAt` when the block carries a `doneAt` (the daemon
 * or the reducer stamps one whenever it marks a block done, #511), else the
 * elapsed at the moment the block was first seen done, measured on that
 * first frame; either way it is kept in a ref keyed by `<turn>:<contentIndex>`
 * — the map is dropped with the turn so a later turn's block 0 never inherits it.
 */
import { useMemo, useRef } from "react";
import { liveThinkingAnchor, type LiveTurnState } from "../../chat/liveBlocks.js";
import { bumpRender } from "../renderCount.js";
import { useClock } from "../hooks/useClock.js";
import {
  chatAnswerRows,
  fmtThinkingHeader,
  proseLines,
  type TranscriptRow,
} from "../../transcriptRender.js";
import { createMdCache, type HighlightFn, type MdCache } from "../markdown/render.js";
import { toolCardRows, useToolSpinner } from "./ToolCard.js";

/** Elapsed ms since an ISO stamp, never negative; 0 if the stamp is unparsable. */
function elapsedMs(startedAt: string, now: number): number {
  const t = new Date(startedAt).getTime();
  return Number.isNaN(t) ? 0 : Math.max(0, now - t);
}

export function useLiveRows(
  live: LiveTurnState | null,
  width: number,
  pinned: boolean,
  highlight: HighlightFn | null,
): TranscriptRow[] {
  // The clock only needs to tick while a thinking block is still streaming
  // (that header is the one row that changes per second); otherwise it
  // idles at a long interval so an idle chat view is not re-rendered every
  // second for nothing.
  const ticking = live?.blocks.some((b) => b.kind === "thinking" && !b.done) ?? false;
  const now = useClock(ticking ? 1000 : 60_000).getTime();
  const spinnerFrame = useToolSpinner(live);
  // Fold durations, measured on the first frame a block is seen done. A ref,
  // not state: the value is derived from the frame that revealed it, and
  // setting state here would schedule a second render for the same rows.
  const folded = useRef<{ turn: string | null; ms: Map<number, number> }>({
    turn: null,
    ms: new Map(),
  });
  if (folded.current.turn !== (live?.turn ?? null)) {
    folded.current = { turn: live?.turn ?? null, ms: new Map() };
  }
  // The answer's markdown cache, reset with the turn (same lifetime as
  // `folded`); renderMarkdown drops it itself on a width/highlighter change.
  const md = useRef<{ turn: string | null; cache: MdCache }>({
    turn: null,
    cache: createMdCache(),
  });
  if (md.current.turn !== (live?.turn ?? null)) {
    md.current = { turn: live?.turn ?? null, cache: createMdCache() };
  }
  if (live !== null)
    for (const b of live.blocks)
      if (b.kind === "thinking" && b.done && !folded.current.ms.has(b.contentIndex)) {
        const doneAt = b.doneAt === undefined ? NaN : new Date(b.doneAt).getTime();
        folded.current.ms.set(
          b.contentIndex,
          elapsedMs(b.startedAt, Number.isNaN(doneAt) ? now : doneAt),
        );
      }
  return useMemo(() => {
    // Counted so tests can prove the memo re-runs on a new `live` and holds
    // on an unchanged one.
    bumpRender("LiveTurn");
    const out: TranscriptRow[] = [];
    if (live === null) return out;
    let text = "";
    for (const b of live.blocks) {
      switch (b.kind) {
        case "text":
          text += b.text;
          break;
        case "thinking": {
          const ms = b.done
            ? (folded.current.ms.get(b.contentIndex) ?? 0)
            : elapsedMs(b.startedAt, now);
          const anchor = liveThinkingAnchor(b.contentIndex);
          const open = pinned || live.expanded.has(anchor);
          const state = !b.done ? "streaming" : open ? "pinned" : "collapsed";
          // No tone, like the finished header and the tool rows.
          out.push({ text: `  ${fmtThinkingHeader(state, ms)}`, anchor });
          if (state !== "collapsed")
            for (const l of proseLines(b.text, width - 4))
              out.push({ text: l === "" ? "" : `    ${l}`, tone: "thinking" });
          break;
        }
        case "tool":
          out.push(...toolCardRows(b, { width, expanded: live.expanded.has(b.id), spinnerFrame }));
          break;
      }
    }
    out.push(...chatAnswerRows(text, width, { highlight, cache: md.current.cache }));
    return out;
    // `now` moves once a second only while a block streams (see `ticking`);
    // `spinnerFrame` ten times a second only while a tool runs.
  }, [live, width, pinned, now, highlight, spinnerFrame]);
}
