import React from "react";
import { Text } from "ink";

/** Pill text: one pad space each side; `padTo` pads the label itself so a
 * column of pills shares one width (longest badge in the meta table). */
export function badgeText(label: string, padTo?: number): string {
  return ` ${padTo !== undefined ? label.padEnd(padTo) : label} `;
}

/** State pill: label on a semantic background, black text for contrast.
 * NO_COLOR strips the background (chalk) and keeps the padded label — same
 * width, still legible. */
export function Badge({
  label,
  color,
  padTo,
}: {
  label: string;
  /** Semantic color name or hex — the pill background. */
  color: string;
  padTo?: number;
}): React.JSX.Element {
  return (
    <Text backgroundColor={color} color="black">
      {badgeText(label, padTo)}
    </Text>
  );
}
