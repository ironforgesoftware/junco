import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";

export interface Column {
  label: string;
  /** Fixed cell width, or "flex" for the one growing column. */
  width: number | "flex";
  align?: "left" | "right";
}

/** Padded label for one column (pure, for structural tests). */
export function headerCell(col: Column): string {
  if (col.width === "flex") return col.label;
  return col.align === "right" ? col.label.padStart(col.width) : col.label.padEnd(col.width);
}

/** Column-header strip: bold accent labels on the hover background, cells
 * aligned to the same widths the data rows use (gap 1, mirrored). NO_COLOR →
 * bold text only. */
export function TableHeader({ columns }: { columns: Column[] }): React.JSX.Element {
  return (
    <Box width="100%" gap={1} backgroundColor={theme.hoverBg}>
      {columns.map((c, i) =>
        c.width === "flex" ? (
          <Box key={i} flexGrow={1} minWidth={0}>
            <Text bold color={theme.accent} wrap="truncate">
              {headerCell(c)}
            </Text>
          </Box>
        ) : (
          <Box key={i} flexShrink={0} width={c.width}>
            <Text bold color={theme.accent}>
              {headerCell(c)}
            </Text>
          </Box>
        ),
      )}
    </Box>
  );
}
