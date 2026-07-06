import React from "react";
import { Box, Text } from "ink";
import type { DashIssue } from "../state.js";
import { deriveState, stateMeta } from "../state.js";

function relTime(iso: string): string {
  const ms = Date.now() - (Date.parse(iso) || Date.now());
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function IssueTable({
  issues,
  trigger,
  selected,
  focused,
}: {
  issues: DashIssue[];
  trigger: string;
  selected: number;
  focused: boolean;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor={!focused}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold dimColor={!focused}>
        issues
      </Text>
      {issues.length === 0 && <Text dimColor>no open issues</Text>}
      {issues.map((iss, i) => {
        const st = deriveState(iss.labels, trigger);
        const meta = stateMeta(st);
        return (
          <Box key={iss.number} gap={1}>
            <Text color={meta.color}>{meta.glyph}</Text>
            <Text color={i === selected ? "cyan" : undefined} wrap="truncate">
              #{iss.number} {iss.title}
            </Text>
            <Box flexGrow={1} />
            <Text color={meta.color}>{meta.badge}</Text>
            <Text dimColor>{relTime(iss.updatedAt)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
