import React from "react";
import { Box, Text } from "ink";
import type { DashIssue } from "../state.js";
import { deriveState, stateMeta } from "../state.js";

const VISIBLE_LINES = 24;

export function IssueDetail({
  issue,
  trigger,
  body,
  planComment,
  loading,
  scroll,
}: {
  issue: DashIssue;
  trigger: string;
  body: string | null;
  planComment: string | null;
  loading: boolean;
  scroll: number;
}): React.JSX.Element {
  const st = deriveState(issue.labels, trigger);
  const lines: string[] = [];
  if (body !== null) lines.push(...body.split("\n"));
  if (planComment !== null) {
    lines.push("", "── plan comment ──", ...planComment.split("\n"));
  } else if (!loading) {
    lines.push("", "(no plan posted yet)");
  }
  const visible = lines.slice(scroll, scroll + VISIBLE_LINES);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      <Text bold>
        #{issue.number} {issue.title}{" "}
        <Text color={stateMeta(st).color}>[{stateMeta(st).badge}]</Text>
      </Text>
      {loading && <Text dimColor>loading…</Text>}
      {visible.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
      {lines.length > VISIBLE_LINES && (
        <Text dimColor>
          j/k scroll · {scroll + 1}-{Math.min(scroll + VISIBLE_LINES, lines.length)}/{lines.length}{" "}
          · esc back
        </Text>
      )}
    </Box>
  );
}
