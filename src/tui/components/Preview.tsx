import React from "react";
import { Box, Text, Transform } from "ink";
import { theme } from "../theme.js";
import { deriveState, stateMeta, type DashIssue } from "../state.js";
import { hyperlink, shortResourceRef } from "../links.js";
import { Spinner } from "./Spinner.js";
import { ClickableBox } from "../ClickableBox.js";
import { clampScroll, maxScroll } from "../window.js";

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
  /** Mouse: press on the ↗ metadata line (opens the issue in the browser). */
  onLinkPress?: () => void;
  /** Mouse: wheel over the pane (down → +1, up → −1). */
  onWheel?: (dir: 1 | -1) => void;
  onScrollMax?: (max: number) => void;
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
  onLinkPress,
  onWheel,
  onScrollMax,
}: PreviewProps): React.JSX.Element {
  // Reserved rows: borders ×2, pane title, issue heading, the ↗ link line
  // (LINK_LINE_ROW in geometry.ts), footer line.
  const viewHeight = Math.max(1, height - 6);
  const lines: string[] = [];
  if (body !== null) lines.push(...body.split("\n"));
  if (planComment !== null) lines.push("", "── plan ──", ...planComment.split("\n"));
  else if (body !== null && !loading) lines.push("", "(no plan posted yet)");
  onScrollMax?.(maxScroll(lines.length, viewHeight));
  const start = clampScroll(scroll, lines.length, viewHeight);
  const visible = lines.slice(start, start + viewHeight);
  const st = deriveState(issue.labels, trigger);
  return (
    <ClickableBox
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      height={height}
      width={width}
      flexGrow={width === undefined ? 1 : undefined}
      onWheel={onWheel}
    >
      <Text bold color={focused ? theme.accent : undefined} wrap="truncate">
        preview · #{issue.number}
      </Text>
      <Text bold wrap="truncate">
        #{issue.number} {issue.title}{" "}
        <Text color={stateMeta(st).color}>[{stateMeta(st).badge}]</Text>
      </Text>
      <ClickableBox onPress={onLinkPress} hoverBg={theme.hoverBg}>
        <Transform transform={(s) => hyperlink(s, issue.url)}>
          <Text dimColor wrap="truncate">
            ↗ {shortResourceRef(issue.url)}
          </Text>
        </Transform>
      </ClickableBox>
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
          ↑/↓ scroll · {start + 1}-{Math.min(start + viewHeight, lines.length)}/{lines.length}
        </Text>
      )}
    </ClickableBox>
  );
}
