import React from "react";
import { Text } from "ink";
import { ClickableBox } from "../../ClickableBox.js";

/** Track/thumb glyph per row; empty array when everything fits (no bar). */
export function scrollbarCells(
  offset: number,
  viewport: number,
  total: number,
  height: number,
): string[] {
  if (total <= viewport || height <= 0) return [];
  const thumbLen = Math.max(1, Math.round((viewport / total) * height));
  const maxStart = height - thumbLen;
  const maxOffset = total - viewport;
  const thumbStart =
    maxOffset <= 0 ? 0 : Math.min(maxStart, Math.round((offset / maxOffset) * maxStart));
  return Array.from({ length: height }, (_, i) =>
    i >= thumbStart && i < thumbStart + thumbLen ? "█" : "│",
  );
}

/** The first-row offset a press on track row `localY` means: the track's top
 * row is offset 0 and its LAST row (height - 1) is the maximum offset, so a
 * click or drag can always reach both ends. 0 when everything fits. */
export function scrollbarOffsetAt(
  localY: number,
  height: number,
  viewport: number,
  total: number,
): number {
  const maxOffset = Math.max(0, total - viewport);
  if (maxOffset === 0) return 0;
  return Math.round((localY / Math.max(1, height - 1)) * maxOffset);
}

/** Right-edge vertical scrollbar; renders nothing when content fits. With
 * `onScrollTo` the track is also a mouse target: press a row to jump there,
 * hold and drag to keep scrolling (the drag keeps the bar even once the
 * pointer leaves its one column — MouseProvider's capture). */
export function Scrollbar({
  offset,
  viewport,
  total,
  height,
  onScrollTo,
}: {
  offset: number;
  viewport: number;
  total: number;
  height: number;
  onScrollTo?: (offset: number) => void;
}): React.JSX.Element | null {
  const cells = scrollbarCells(offset, viewport, total, height);
  // No bar ⇒ no region either: when it all fits there is nothing to jump to.
  if (cells.length === 0) return null;
  const jump =
    onScrollTo === undefined
      ? undefined
      : (_x: number, y: number): void => onScrollTo(scrollbarOffsetAt(y, height, viewport, total));
  return (
    <ClickableBox flexDirection="column" flexShrink={0} width={1} onPressAt={jump} onDrag={jump}>
      {cells.map((c, i) => (
        <Text key={i} dimColor={c === "│"}>
          {c}
        </Text>
      ))}
    </ClickableBox>
  );
}
