import React from "react";
import { Box, Text } from "ink";

export function HelpOverlay({ trigger }: { trigger: string }): React.JSX.Element {
  const rows: [string, string][] = [
    ["j/k", "move selection"],
    ["tab · h/l", "switch panes"],
    ["w / i", "jump to watched repos / issues pane"],
    [":", "command palette — run junco CLI commands"],
    ["enter", "issue detail (body + plan)"],
    ["d", `dispatch (adds \`${trigger}\`)`],
    ["D", "dispatch as ask (read-only Q&A)"],
    ["a", "approve the posted plan"],
    ["R", "re-plan / re-cycle (by state)"],
    ["o", "open in browser"],
    ["A", "add repo to watchlist"],
    ["x", "unwatch repo"],
    ["r", "refresh now"],
    ["q", "quit"],
  ];
  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1}>
      <Text bold>junco dashboard — keys</Text>
      {rows.map(([k, d]) => (
        <Box key={k} gap={2}>
          <Box minWidth={10}>
            <Text color="cyan">{k}</Text>
          </Box>
          <Text>{d}</Text>
        </Box>
      ))}
      <Text dimColor>press any key to close</Text>
    </Box>
  );
}
