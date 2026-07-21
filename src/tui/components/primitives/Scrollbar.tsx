import React from "react";
import { Box, Text } from "ink";

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

/** Right-edge vertical scrollbar; renders nothing when content fits. */
export function Scrollbar({
  offset,
  viewport,
  total,
  height,
}: {
  offset: number;
  viewport: number;
  total: number;
  height: number;
}): React.JSX.Element | null {
  const cells = scrollbarCells(offset, viewport, total, height);
  if (cells.length === 0) return null;
  return (
    <Box flexDirection="column" flexShrink={0} width={1}>
      {cells.map((c, i) => (
        <Text key={i} dimColor={c === "│"}>
          {c}
        </Text>
      ))}
    </Box>
  );
}
