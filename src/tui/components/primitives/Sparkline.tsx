import React from "react";
import { Text } from "ink";
import { fmtSpark } from "../../queueFmt.js";

/** Per-value bar chart (▁▂▃▄▅▆▇█ via fmtSpark). Dim when every value is
 * zero — an empty week recedes instead of glowing. */
export function Sparkline({
  values,
  color,
}: {
  values: number[];
  color?: string;
}): React.JSX.Element {
  const empty = values.every((v) => v <= 0);
  return (
    <Text color={empty ? undefined : color} dimColor={empty}>
      {fmtSpark(values)}
    </Text>
  );
}
