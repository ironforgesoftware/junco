/** Pane-3 card for system-row selections: the 7-day ledger at a glance.
 * Pure render over QueueStats — no fetches (spec §3). */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { fmtCompact, fmtDurShort } from "../queueFmt.js";
import { Sparkline } from "./primitives/Sparkline.js";
import { StatRow } from "./primitives/StatRow.js";
import { Rule } from "./primitives/Rule.js";
import type { QueueStats } from "../queueStats.js";

const LW = 6;

export function ActivityCard({
  stats,
  width,
  height,
}: {
  stats: QueueStats | null;
  width: number;
  height: number;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
      height={height}
    >
      <Text bold>activity</Text>
      {stats === null ? (
        <Text dimColor>no history yet</Text>
      ) : (
        <>
          {stats.perDay7d.length > 0 && (
            <>
              <Text>
                <Text dimColor>{"7d".padEnd(LW)}</Text>
                <Sparkline
                  values={stats.perDay7d.map((p) => p.done + p.failed)}
                  color={theme.accent}
                />
              </Text>
              <Text>
                {" ".repeat(LW)}
                <Text color={theme.success}>
                  ✓{stats.perDay7d.reduce((a, p) => a + p.done, 0)}
                </Text>{" "}
                <Text color={theme.error}>✗{stats.perDay7d.reduce((a, p) => a + p.failed, 0)}</Text>
              </Text>
            </>
          )}
          <Rule title="24h" width={Math.max(8, width - 4)} />
          <Text>
            <Text dimColor>{"done".padEnd(LW)}</Text>
            <Text color={theme.success}>✓{stats.window24h.done}</Text>{" "}
            <Text color={stats.window24h.failed > 0 ? theme.error : undefined}>
              ✗{stats.window24h.failed}
            </Text>
            {stats.window24h.successRate !== null
              ? ` · ${Math.round(stats.window24h.successRate * 100)}%`
              : ""}
          </Text>
          {stats.window24h.avgDurationSeconds !== null && (
            <StatRow
              label="avg"
              value={fmtDurShort(stats.window24h.avgDurationSeconds)}
              labelWidth={LW}
              hint={
                stats.window24h.tokensOut !== null
                  ? `tok ${fmtCompact(stats.window24h.tokensOut)}`
                  : undefined
              }
            />
          )}
          {stats.window24h.costUsd !== null && (
            <StatRow
              label="cost"
              value={`$${stats.window24h.costUsd.toFixed(2)}`}
              labelWidth={LW}
            />
          )}
        </>
      )}
    </Box>
  );
}

/** Reserved-slot filler: keeps pane geometry frozen when the selection has no
 * third-column content (local repos). */
export function ReservedNote({
  text,
  width,
  height,
}: {
  text: string;
  width: number;
  height: number;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
      height={height}
    >
      <Text dimColor>{text}</Text>
    </Box>
  );
}
