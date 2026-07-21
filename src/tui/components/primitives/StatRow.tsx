import React from "react";
import { Text } from "ink";

/** Plain text of a stat line: padded label, value, optional hint. */
export function statRowText(
  label: string,
  value: string,
  labelWidth: number,
  hint?: string,
): string {
  return `${label.padEnd(labelWidth)}${value}${hint !== undefined ? ` ${hint}` : ""}`;
}

/** Aligned key/value line for detail panels: dim fixed-width label, bold
 * value (optionally colored), dim hint suffix. One per stat — panels build
 * grids by stacking rows with one shared labelWidth. */
export function StatRow({
  label,
  value,
  labelWidth,
  color,
  hint,
}: {
  label: string;
  value: string;
  labelWidth: number;
  color?: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{label.padEnd(labelWidth)}</Text>
      <Text bold color={color}>
        {value}
      </Text>
      {hint !== undefined ? <Text dimColor> {hint}</Text> : null}
    </Text>
  );
}
