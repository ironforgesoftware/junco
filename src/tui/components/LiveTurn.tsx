/**
 * Rows for the in-flight chat turn (spec 2026-09-06 §4.1): built from
 * `live.blocks` alone, keyed on the flush counter `frame`, so the cost per
 * frame is O(bytes in the live turn) and the finished history (FinishedTurns
 * .tsx) is never touched.
 *
 * Text blocks render exactly as the finished answer will (transcriptRender
 * .ts's chat rows — `junco: ` label wrapped in with the text, first row
 * accent, the rest indented) so nothing jumps when the turn ends and the
 * renderer takes over. Thinking blocks are spec §4.3's four states (below).
 * Tool blocks are an interim one-row `▸ <name>` until Task 15 (ToolCard).
 *
 * Thinking (spec §4.3, D4): while a block streams, its header `· thinking ·
 * <elapsed>s` ticks off `startedAt` against a 1 s clock and the body follows
 * in tone `thinking`, plain-wrapped (reasoning is not prose to typeset); once
 * `done` it folds to `▸ thinking · <dur>s` — or stays open under `▾` when
 * the operator pinned it (`t`). The header is the SAME string
 * transcriptRender.ts prints for the finished turn, so the row does not
 * change shape at turn end.
 *
 * `dur` is the elapsed at the moment the block was first seen done: the bus
 * record carries no `doneAt`, so it is measured here on that first frame and
 * kept in a ref keyed by `<turn>:<contentIndex>` — the map is dropped with
 * the turn so a later turn's block 0 never inherits it.
 */
import { useMemo, useRef } from "react";
import type { LiveTurnState } from "../../chat/liveBlocks.js";
import { useClock } from "../hooks/useClock.js";
import {
  fmtThinkingHeader,
  proseLines,
  wrapText,
  type TranscriptRow,
} from "../../transcriptRender.js";

/** Elapsed ms since an ISO stamp, never negative; 0 if the stamp is unparsable. */
function elapsedMs(startedAt: string, now: number): number {
  const t = new Date(startedAt).getTime();
  return Number.isNaN(t) ? 0 : Math.max(0, now - t);
}

export function useLiveRows(
  live: LiveTurnState | null,
  frame: number,
  width: number,
  pinned: boolean,
): TranscriptRow[] {
  // The clock only needs to tick while a thinking block is still streaming
  // (that header is the one row that changes per second); otherwise it
  // idles at a long interval so an idle chat view is not re-rendered every
  // second for nothing.
  const ticking = live?.blocks.some((b) => b.kind === "thinking" && !b.done) ?? false;
  const now = useClock(ticking ? 1000 : 60_000).getTime();
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
  if (live !== null)
    for (const b of live.blocks)
      if (b.kind === "thinking" && b.done && !folded.current.ms.has(b.contentIndex))
        folded.current.ms.set(b.contentIndex, elapsedMs(b.startedAt, now));
  return useMemo(() => {
    // `frame` bumps once per applied flush (useChat.ts) and is the memo key
    // the spec names; `live` is what the body reads.
    void frame;
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
          const state = !b.done ? "streaming" : pinned ? "pinned" : "collapsed";
          // No tone, like the finished header and the tool rows.
          out.push({ text: `  ${fmtThinkingHeader(state, ms)}` });
          if (state !== "collapsed")
            for (const l of proseLines(b.text, width - 4))
              out.push({ text: l === "" ? "" : `    ${l}`, tone: "thinking" });
          break;
        }
        case "tool":
          out.push({ text: `▸ ${b.name}`, tone: "dim" });
          break;
      }
    }
    if (text !== "")
      wrapText(`junco: ${text.trimStart()}`, width - 2).forEach((l, i) =>
        out.push(i === 0 ? { text: l, tone: "accent" } : { text: l === "" ? "" : `  ${l}` }),
      );
    return out;
    // `now` moves once a second only while a block streams (see `ticking`).
  }, [live, frame, width, pinned, now]);
}
