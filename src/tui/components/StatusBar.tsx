import React from "react";
import { Box, Text } from "ink";
import type { HealthInfo } from "../ghClient.js";

function fmtUp(s: number | null): string {
  if (s === null) return "";
  if (s < 3600) return ` up ${Math.floor(s / 60)}m`;
  return ` up ${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export function StatusBar({
  health,
  toast,
  hints,
}: {
  health: HealthInfo | null;
  toast: string | null;
  hints: string;
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
      {toast && <Text color="magenta">{toast}</Text>}
      <Box flexGrow={1} />
      <Text dimColor>{hints}</Text>
    </Box>
  );
}
