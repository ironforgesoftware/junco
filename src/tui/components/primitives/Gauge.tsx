import React from "react";
import { Text } from "ink";

/** ▰▱ fill string; null value or non-positive max → all track. */
export function gaugeText(value: number | null, max: number, width: number): string {
  const w = Math.max(0, width);
  if (value === null || max <= 0) return "▱".repeat(w);
  const filled = Math.min(w, Math.max(0, Math.round((value / max) * w)));
  return "▰".repeat(filled) + "▱".repeat(w - filled);
}

/** Determinate fill bar. The ▰/▱ glyph pair carries the reading colorlessly
 * (NO_COLOR-safe); `label` renders dim after the bar. */
export function Gauge({
  value,
  max,
  width,
  color,
  label,
}: {
  value: number | null;
  max: number;
  width: number;
  color?: string;
  label?: string;
}): React.JSX.Element {
  return (
    <Text>
      <Text color={value === null ? undefined : color} dimColor={value === null}>
        {gaugeText(value, max, width)}
      </Text>
      {label !== undefined ? <Text dimColor> {label}</Text> : null}
    </Text>
  );
}
