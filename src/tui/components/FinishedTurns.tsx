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
import { useMemo, useRef } from "react";
import { bumpRender } from "../renderCount.js";
import { renderTranscriptRows, type TranscriptRow } from "../../transcriptRender.js";
import type { TranscriptSummary } from "../../transcriptSummary.js";
import type { HighlightFn, MdCache } from "../markdown/render.js";

/**
 * `highlight` (spec §4.2): the code-fence highlighter for the markdown
 * answers, null when Pi's could not be loaded (raw fences). A memo input —
 * it changes at most once, at mount.
 */
export function useFinishedRows(
  summary: TranscriptSummary | null,
  pinned: boolean,
  expanded: ReadonlySet<string>,
  width: number,
  highlight: HighlightFn | null,
): TranscriptRow[] {
  // Per-turn markdown caches across memo misses (a new summary arrives on
  // every finished turn; without this each one would re-typeset the whole
  // history). renderMarkdown revalidates each entry itself.
  const mdCache = useRef<Map<string, MdCache>>(new Map());
  return useMemo(() => {
    // Counted so tests can prove a live frame never re-runs this body.
    bumpRender("FinishedTurns");
    return summary === null
      ? []
      : renderTranscriptRows(summary, {
          width,
          pinned,
          expanded,
          markdown: true,
          highlight,
          mdCache: mdCache.current,
        });
  }, [summary, pinned, expanded, width, highlight]);
}
