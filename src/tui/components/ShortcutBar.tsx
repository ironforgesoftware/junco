import React from "react";
import { Box, Text } from "ink";

export type BarView = "main" | "detail" | "help" | "addRepo" | "palette" | "cmdOutput" | "queue";
export type BarPane = "repos" | "issues";

/** The full key set for the CURRENT context — a persistent, glanceable bar
 * (the `?` overlay remains the long-form reference). Pure. */
export function shortcutsFor(view: BarView, pane: BarPane): [string, string][] {
  switch (view) {
    case "detail":
      return [
        ["[ / ]", "scroll"],
        ["esc", "back"],
      ];
    case "queue":
      return [
        ["[ / ]", "scroll"],
        ["esc/t", "back"],
      ];
    case "palette":
      return [
        ["type", "filter"],
        ["↑/↓", "move"],
        ["enter", "run"],
        ["esc", "close"],
      ];
    case "cmdOutput":
      return [
        ["[ / ]", "scroll"],
        ["r", "re-run"],
        ["esc", "back"],
      ];
    case "addRepo":
      return [
        ["enter", "next/submit"],
        ["esc", "cancel"],
      ];
    case "help":
      return [["any key", "close"]];
    case "main":
      return pane === "repos"
        ? [
            ["j/k", "move"],
            ["tab/i", "issues"],
            ["w", "add repo"],
            ["x", "unwatch"],
            ["r", "refresh"],
            ["t", "queue"],
            [":", "commands"],
            ["?", "help"],
            ["q", "quit"],
          ]
        : [
            ["j/k", "move"],
            ["enter", "detail"],
            ["d", "dispatch"],
            ["D", "ask"],
            ["a", "approve"],
            ["R", "re-plan/cycle"],
            ["o", "browser"],
            ["tab/h", "repos"],
            ["t", "queue"],
            [":", "commands"],
            ["?", "help"],
            ["q", "quit"],
          ];
  }
}

export function ShortcutBar({ view, pane }: { view: BarView; pane: BarPane }): React.JSX.Element {
  const parts = shortcutsFor(view, pane);
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        {parts.map(([k, label], i) => (
          <Text key={k}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text color="cyan">{k}</Text>
            <Text dimColor> {label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
