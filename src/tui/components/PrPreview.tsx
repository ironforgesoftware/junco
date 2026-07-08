import React from "react";
import { Box, Text, Transform } from "ink";
import { theme } from "../theme.js";
import { derivePrState, prStateMeta, ticketSlugFromBranch, type DashPr } from "../prState.js";
import { hyperlink } from "../links.js";
import { relTime } from "./IssueList.js";

export interface PrPreviewProps {
  pr: DashPr | null;
  branchPrefix: string;
  now: Date;
  height: number;
  width?: number; // set → fixed width; undefined → flexGrow 1
  focused: boolean;
  titleLabel?: string; // pane title prefix; default "3 pr" for the p-view's pane-3 slot
}

function reviewDecisionToString(reviewDecision: string | null): string {
  if (!reviewDecision) return "no decision";
  // Map GitHub GraphQL enum values to display format
  if (reviewDecision === "APPROVED") return "approved";
  if (reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (reviewDecision === "REVIEW_REQUIRED") return "review-required";
  return reviewDecision.toLowerCase();
}

function checksToString(checks: {
  pass: number;
  fail: number;
  pending: number;
  total: number;
}): string {
  if (checks.total === 0) return "none";
  const parts: string[] = [];
  if (checks.fail > 0) parts.push(`✗${checks.fail}`);
  if (checks.pass > 0) parts.push(`✓${checks.pass}`);
  if (checks.pending > 0) parts.push(`◍${checks.pending}`);
  return `${parts.join(" ")} of ${checks.total}`;
}

/** Maps review decision and checks states to ink color for display. */
function checksColor(checks: {
  pass: number;
  fail: number;
  pending: number;
  total: number;
}): string | undefined {
  if (checks.total === 0) return undefined; // default (no color)
  if (checks.fail > 0) return theme.error;
  if (checks.pending > 0) return theme.warn;
  return theme.success;
}

export function PrPreview({
  pr,
  branchPrefix,
  now,
  height,
  width,
  focused,
  titleLabel = "3 pr",
}: PrPreviewProps): React.JSX.Element {
  // Height budget (mirrors Preview.tsx): borders ×2 + pane title. Content rows
  // are built most-important-first so that slicing drops the least important
  // rows at small heights — rendering more rows than fit corrupts the frame
  // (Yoga drops the pane title and bleeds adjacent rows together).
  const maxRows = Math.max(1, height - 3);
  const rows: React.JSX.Element[] = [];

  if (pr !== null) {
    const meta = prStateMeta(derivePrState(pr));

    rows.push(
      <Text key="heading" bold wrap="truncate">
        #{pr.number} {pr.title} <Text color={meta.color}>[{meta.badge}]</Text>
      </Text>,
      <Transform key="link" transform={(s) => hyperlink(s, pr.url)}>
        <Text dimColor wrap="truncate">
          ↗ {pr.nwo}#{pr.number}
        </Text>
      </Transform>,
      <Text key="checks" wrap="truncate-end" color={checksColor(pr.checks)}>
        checks: {checksToString(pr.checks)}
      </Text>,
      <Text key="review" wrap="truncate-end">
        review: {reviewDecisionToString(pr.reviewDecision)}
      </Text>,
      // branch: headRefName ← baseRefName, truncate-start on head so the slug tail survives
      <Box key="branch" width="100%" minWidth={0}>
        <Text wrap="truncate-start">branch: {pr.headRefName}</Text>
        <Text wrap="truncate-end"> ← {pr.baseRefName}</Text>
      </Box>,
      <Text key="ticket" wrap="truncate-end">
        ticket: {ticketSlugFromBranch(pr.headRefName, branchPrefix) || "—"}
      </Text>,
    );

    // merge line — skip when both parts are null
    if (pr.mergeable !== null || pr.mergeStateStatus !== null) {
      rows.push(
        <Text key="merge" wrap="truncate-end">
          merge:{" "}
          {pr.mergeable && pr.mergeStateStatus
            ? `${pr.mergeable} · ${pr.mergeStateStatus}`
            : pr.mergeable || pr.mergeStateStatus}
        </Text>,
      );
    }

    rows.push(
      <Text key="stats" wrap="truncate-end">
        ±: +{pr.additions} −{pr.deletions} · {pr.changedFiles} files
      </Text>,
      <Text key="opened" wrap="truncate-end">
        opened {relTime(pr.createdAt, now)}
      </Text>,
    );

    if (pr.state === "MERGED" && pr.mergedAt !== null) {
      rows.push(
        <Text key="merged" wrap="truncate-end">
          merged {relTime(pr.mergedAt, now)}
        </Text>,
      );
    } else if (pr.state === "CLOSED") {
      // Closed PRs carry no closedAt in DashPr; updatedAt is the closest honest proxy.
      rows.push(
        <Text key="closed" wrap="truncate-end">
          closed {relTime(pr.updatedAt, now)}
        </Text>,
      );
    }

    rows.push(
      <Text key="author" dimColor wrap="truncate-end">
        author: {pr.author}
      </Text>,
    );
  }

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
        {titleLabel}
        {pr ? ` · #${pr.number}` : ""}
      </Text>

      {pr === null && <Text dimColor>select a pull request — its status renders here</Text>}

      {rows.slice(0, maxRows)}
    </Box>
  );
}
