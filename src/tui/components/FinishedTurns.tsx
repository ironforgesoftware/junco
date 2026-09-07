/**
 * Rows for the finished turns of a chat (spec 2026-09-06 §4.1): the summary
 * rendered through `renderTranscriptRows`, memoized on exactly
 * `[summary, pinned, expanded, width]`. The live turn (`state.live`) and the
 * flush counter (`state.frame`) are deliberately NOT inputs — a streaming
 * flush must never re-run the history's renderer. `useLiveRows`
 * (LiveTurn.tsx) builds the trailing rows; `concatRows` (TranscriptBody.tsx)
 * joins the two halves without copying.
 *
 * A hook rather than a component because the rows are consumed by
 * TranscriptBody's windowing, not painted here.
 */
import { useMemo } from "react";
import { bumpRender } from "../renderCount.js";
import { renderTranscriptRows, type TranscriptRow } from "../../transcriptRender.js";
import type { TranscriptSummary } from "../../transcriptSummary.js";

export function useFinishedRows(
  summary: TranscriptSummary | null,
  pinned: boolean,
  expanded: ReadonlySet<string>,
  width: number,
): TranscriptRow[] {
  return useMemo(() => {
    // Counted so tests can prove a live frame never re-runs this body.
    bumpRender("FinishedTurns");
    return summary === null ? [] : renderTranscriptRows(summary, { width, pinned, expanded });
  }, [summary, pinned, expanded, width]);
}
