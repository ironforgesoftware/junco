/**
 * Rows for the in-flight chat turn (spec 2026-09-06 §4.1): built from
 * `live.blocks` alone, keyed on the flush counter `frame`, so the cost per
 * frame is O(bytes in the live turn) and the finished history (FinishedTurns
 * .tsx) is never touched.
 *
 * Interim rendering (Task 11): text blocks render exactly as the finished
 * answer will (transcriptRender.ts's chat rows — `junco: ` label wrapped in
 * with the text, first row accent, the rest indented) so nothing jumps when
 * the turn ends and the renderer takes over; thinking blocks are a dim
 * `· thinking` row while `pinned` or still streaming; tool blocks are one
 * dim `▸ <name>` row. Task 12 (ThinkingBlock) and Task 15 (ToolCard) replace
 * the last two.
 */
import { useMemo } from "react";
import type { LiveTurnState } from "../../chat/liveBlocks.js";
import { wrapText, type TranscriptRow } from "../../transcriptRender.js";

export function useLiveRows(
  live: LiveTurnState | null,
  frame: number,
  width: number,
  pinned: boolean,
): TranscriptRow[] {
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
        case "thinking":
          if (pinned || !b.done) out.push({ text: "· thinking", tone: "dim" });
          break;
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
  }, [live, frame, width, pinned]);
}
