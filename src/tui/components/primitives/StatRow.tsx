import React from "react";
import { Box, Text } from "ink";

/** Plain text of a stat line: padded label, value, optional hint. */
export function statRowText(
  label: string,
  value: string,
  labelWidth: number,
  hint?: string,
): string {
  return `${label.padEnd(labelWidth)}${value}${hint !== undefined ? ` ${hint}` : ""}`;
}

/** Aligned key/value line for detail panels: dim fixed-width label cell, bold
 * value (optionally colored), dim hint suffix. One per stat — panels build
 * grids by stacking rows with one shared labelWidth. The label cell is
 * pinned (`flexShrink={0}`) and never truncates, so it can't be partially
 * eaten and break column alignment with sibling rows; only the VALUE (plus
 * hint) shrinks. `truncate` picks which end of an over-long value is
 * sacrificed: "end" (default) for plain prose values, "start" when the tail
 * discriminates (a filesystem path's repo directory). */
export function StatRow({
  label,
  value,
  labelWidth,
  color,
  hint,
  truncate = "end",
}: {
  label: string;
  value: string;
  labelWidth: number;
  color?: string;
  hint?: string;
  truncate?: "end" | "start";
}): React.JSX.Element {
  return (
    <Box width="100%" overflow="hidden">
      <Box flexShrink={0}>
        <Text dimColor>{label.padEnd(labelWidth)}</Text>
      </Box>
      <Box flexGrow={1} minWidth={0}>
        <Text wrap={truncate === "start" ? "truncate-start" : "truncate-end"}>
          <Text bold color={color}>
            {value}
          </Text>
          {hint !== undefined ? <Text dimColor> {hint}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}
