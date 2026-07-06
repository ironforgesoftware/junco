import React from "react";
import { Box, Text } from "ink";
import type { IssueLifecycle } from "../state.js";
import { stateMeta } from "../state.js";

export interface RepoRow {
  nwo: string;
  fromConfig: boolean;
  counts: Partial<Record<IssueLifecycle, number>>;
}

const COUNT_ORDER: IssueLifecycle[] = ["plan-ready", "working", "failed"];

export function RepoList({
  repos,
  selected,
  focused,
}: {
  repos: RepoRow[];
  selected: number;
  focused: boolean;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor={!focused}
      paddingX={1}
      minWidth={24}
    >
      <Text bold dimColor={!focused}>
        repos
      </Text>
      {repos.length === 0 && <Text dimColor>none watched — press A</Text>}
      {repos.map((r, i) => {
        const badges = COUNT_ORDER.filter((s) => (r.counts[s] ?? 0) > 0)
          .map((s) => `${r.counts[s]}${stateMeta(s).glyph}`)
          .join(" ");
        return (
          <Text key={r.nwo} color={i === selected ? "cyan" : undefined} wrap="truncate">
            {i === selected ? "▸ " : "  "}
            {r.nwo}
            {r.fromConfig ? " (cfg)" : ""}
            {badges ? `  ${badges}` : ""}
          </Text>
        );
      })}
    </Box>
  );
}
