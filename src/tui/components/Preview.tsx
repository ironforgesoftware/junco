import React from "react";
import { Box, Text, Transform } from "ink";
import { theme } from "../theme.js";
import { deriveState, stateMeta, type DashIssue } from "../state.js";
import { hyperlink, shortResourceRef } from "../links.js";
import { Spinner } from "./Spinner.js";

export interface PreviewProps {
  issue: DashIssue;
  trigger: string;
  body: string | null;
  planComment: string | null;
  loading: boolean;
  error: string | null;
  scroll: number;
  focused: boolean;
  height: number;
  width?: number;
}

/** The fullscreen issue-detail view's body — issue heading, body text, and any
 * posted plan comment. Renders at any layout width; not scoped to a pane.
 * Replaces IssueDetail. */
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
}: PreviewProps): React.JSX.Element {
  // Reserved rows: borders ×2, pane title, issue heading, the ↗ link line
  // (LINK_LINE_ROW in geometry.ts), footer line.
  const viewHeight = Math.max(1, height - 6);
  const lines: string[] = [];
  if (body !== null) lines.push(...body.split("\n"));
  if (planComment !== null) lines.push("", "── plan ──", ...planComment.split("\n"));
  else if (body !== null && !loading) lines.push("", "(no plan posted yet)");
  const visible = lines.slice(scroll, scroll + viewHeight);
  const st = deriveState(issue.labels, trigger);
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
        preview · #{issue.number}
      </Text>
      <Text bold wrap="truncate">
        #{issue.number} {issue.title}{" "}
        <Text color={stateMeta(st).color}>[{stateMeta(st).badge}]</Text>
      </Text>
      <Transform transform={(s) => hyperlink(s, issue.url)}>
        <Text dimColor wrap="truncate">
          ↗ {shortResourceRef(issue.url)}
        </Text>
      </Transform>
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
