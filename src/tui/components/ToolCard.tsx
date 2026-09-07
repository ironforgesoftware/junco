/**
 * Live + finished tool cards (spec 2026-09-06 §4.4, D6). The rows themselves
 * are transcriptRender.ts's `renderToolCard` — a root module, so the finished
 * turns (`junco transcript`, the ticket TranscriptView, FinishedTurns.tsx)
 * and the live turn (LiveTurn.tsx) draw the SAME card and nothing changes
 * shape when the turn ends. This module is the dashboard-side wrapper: the
 * spinner frame → glyph mapping, and the hook that ticks Ink's shared
 * animation timer only while a tool is still running.
 */
import { useAnimation } from "ink";
import type { LiveBlock, LiveTurnState } from "../../chat/liveBlocks.js";
import { renderToolCard, type TranscriptRow } from "../../transcriptRender.js";
import { SPINNER_FRAMES } from "./Spinner.js";

export type ToolBlock = Extract<LiveBlock, { kind: "tool" }>;

/** Rows for one live tool block; `spinnerFrame` is `useToolSpinner`'s. */
export function toolCardRows(
  block: ToolBlock,
  o: { width: number; expanded: boolean; spinnerFrame: number },
): TranscriptRow[] {
  return renderToolCard(block, {
    width: o.width,
    expanded: o.expanded,
    spinner: SPINNER_FRAMES[o.spinnerFrame % SPINNER_FRAMES.length] ?? null,
  });
}

/**
 * The spinner frame for the live turn's running cards: Ink's shared
 * `useAnimation` timer (Spinner.tsx's, ~10 fps), active only while some tool
 * block is not done — an idle chat view must not repaint every 100 ms.
 */
export function useToolSpinner(live: LiveTurnState | null): number {
  const running = live?.blocks.some((b) => b.kind === "tool" && !b.done) ?? false;
  const { frame } = useAnimation({ interval: 100, isActive: running });
  return frame;
}
