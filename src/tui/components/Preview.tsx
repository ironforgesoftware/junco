import React from "react";
import { Box, Text, Transform } from "ink";
import { theme } from "../theme.js";
import { deriveState, stateMeta, type DashIssue } from "../state.js";
import { hyperlink, shortResourceRef } from "../links.js";
import { Spinner } from "./Spinner.js";

export interface PreviewProps {
  issue: DashIssue | null;
  trigger: string;
  body: string | null;
  planComment: string | null;
  loading: boolean;
  error: string | null;
  scroll: number;
  focused: boolean;
  height: number;
  width?: number;
  paneNumber?: boolean;
}

/** Pane 3 (wide) and the medium-mode full-body detail. Replaces IssueDetail. */
export function Preview({
  issue,
  trigger,
  body,
  planComment,
  loading,
  error,
  scroll,
  focused,
  height,
  width,
  paneNumber = false,
}: PreviewProps): React.JSX.Element {
  // Reserved rows: borders ×2, pane title, footer line — plus, when an issue is
  // shown, its heading and the ↗ link line (LINK_LINE_ROW in geometry.ts).
  const viewHeight = Math.max(1, height - (issue !== null ? 6 : 4));
  const lines: string[] = [];
  if (body !== null) lines.push(...body.split("\n"));
  if (planComment !== null) lines.push("", "── plan ──", ...planComment.split("\n"));
  else if (issue !== null && body !== null && !loading) lines.push("", "(no plan posted yet)");
  const visible = lines.slice(scroll, scroll + viewHeight);
  const st = issue ? deriveState(issue.labels, trigger) : null;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      height={height}
      width={width}
      flexGrow={width === undefined ? 1 : undefined}
    >
      <Text bold color={focused ? theme.accent : undefined} wrap="truncate">
        {paneNumber ? "3 preview" : "preview"}
        {issue ? ` · #${issue.number}` : ""}
      </Text>
      {issue === null && <Text dimColor>select an issue — its body and plan render here</Text>}
      {issue !== null && (
        <Text bold wrap="truncate">
          #{issue.number} {issue.title}{" "}
          {st !== null && <Text color={stateMeta(st).color}>[{stateMeta(st).badge}]</Text>}
        </Text>
      )}
      {issue !== null && (
        <Transform transform={(s) => hyperlink(s, issue.url)}>
          <Text dimColor wrap="truncate">
            ↗ {shortResourceRef(issue.url)}
          </Text>
        </Transform>
      )}
      {loading && (
        <Text dimColor>
          <Spinner /> loading issue details…
        </Text>
      )}
      {error !== null && <Text color={theme.error}>{error}</Text>}
      {visible.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
      <Box flexGrow={1} />
      {lines.length > viewHeight && (
        <Text dimColor>
          ↑/↓ scroll · {scroll + 1}-{Math.min(scroll + viewHeight, lines.length)}/{lines.length}
        </Text>
      )}
    </Box>
  );
}
