import React from "react";
import { Text } from "ink";

/** Rule width inside the fixed-layout detail panels (daemon, repo detail).
 * Those panels build a flat line array and never learn their own width, so they
 * share one deliberate constant; width-aware panes (the rail, the activity card)
 * compute `width - 4` from their own prop instead. */
export const DETAIL_RULE_WIDTH = 24;

/** Plain text of a titled divider: `── title ────…` padded to `width`. */
export function ruleText(title: string | null, width: number): string {
  if (title === null) return "─".repeat(Math.max(0, width));
  const head = `── ${title} `;
  return head + "─".repeat(Math.max(0, width - head.length));
}

/** Titled divider: dim line, bold title. */
export function Rule({ title, width }: { title: string | null; width: number }): React.JSX.Element {
  if (title === null) return <Text dimColor>{ruleText(null, width)}</Text>;
  const head = `── ${title} `;
  return (
    <Text>
      <Text dimColor>{"── "}</Text>
      <Text bold>{title}</Text>
      <Text dimColor>{" " + "─".repeat(Math.max(0, width - head.length))}</Text>
    </Text>
  );
}
