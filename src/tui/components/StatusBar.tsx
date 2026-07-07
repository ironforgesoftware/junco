import React from "react";
import { Box, Text } from "ink";
import type { HealthInfo } from "../ghClient.js";

function fmtUp(s: number | null): string {
  if (s === null) return "";
  if (s < 3600) return ` up ${Math.floor(s / 60)}m`;
  return ` up ${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Collapse newlines (raw gh stderr can be multi-line) so nothing breaks the
 * single-line bar; the width is then bounded by `wrap="truncate-end"`. */
function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " · ").trim();
}

export function StatusBar({
  health,
  toast,
  hints,
  watchlistError,
}: {
  health: HealthInfo | null;
  toast: string | null;
  hints: string;
  watchlistError?: string | null;
}): React.JSX.Element {
  const daemon =
    health === null
      ? "daemon …"
      : health.up
        ? `daemon ●${fmtUp(health.uptimeSeconds)}${health.ticketsBridged !== null ? ` · ${health.ticketsBridged} bridged` : ""}`
        : "daemon ○ not running";
  return (
    <Box borderStyle="round" paddingX={1} gap={2}>
      <Text color={health?.up ? "green" : "yellow"}>{daemon}</Text>
      {/* Greedy middle that SHRINKS: truncate-end keeps it one line, flexShrink
          yields space so daemon (left) and hints (right) never wrap. */}
      <Box flexGrow={1} flexShrink={1} flexBasis={0} gap={2} minWidth={0}>
        {watchlistError && (
          <Text color="red" wrap="truncate-end">
            watchlist: {oneLine(watchlistError)}
          </Text>
        )}
        {toast && (
          <Text color="magenta" wrap="truncate-end">
            {oneLine(toast)}
          </Text>
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {hints}
      </Text>
    </Box>
  );
}
