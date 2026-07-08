import React from "react";
import { Box, Text } from "ink";
import { theme, toastColor, type ToastKind } from "../theme.js";
import type { LayoutMode } from "../layout.js";

export type HintView = "main" | "detail" | "help" | "addRepo" | "palette" | "cmdOutput" | "queue";

function fmtUp(s: number | null): string {
  if (s === null) return "";
  if (s < 3600) return ` up ${Math.floor(s / 60)}m`;
  return ` up ${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Row 1: brand chip · active repo · (right) watchlist warn, daemon, queue, clock. */
export function Header({
  repoNwo,
  daemonUp,
  uptimeSeconds,
  queueRunning,
  queueWaiting,
  watchlistError,
  outboxDepth,
  now,
}: {
  repoNwo: string | null;
  daemonUp: boolean | null;
  uptimeSeconds: number | null;
  queueRunning: number;
  queueWaiting: number;
  watchlistError: string | null;
  /** Ops parked in the GitHub outbox — hidden at 0. */
  outboxDepth: number;
  now: Date;
}): React.JSX.Element {
  const daemon =
    daemonUp === null ? "daemon …" : daemonUp ? `daemon ●${fmtUp(uptimeSeconds)}` : "daemon ○";
  const hhmm = now.toTimeString().slice(0, 5);
  return (
    <Box paddingX={1} gap={2}>
      <Text backgroundColor={theme.accent} color={theme.brandInk} bold>
        {" junco "}
      </Text>
      <Text bold wrap="truncate">
        {repoNwo ?? "no repo"}
      </Text>
      <Box flexGrow={1} />
      {watchlistError !== null && <Text color={theme.warn}>watchlist!</Text>}
      {outboxDepth > 0 && <Text color={theme.warn}>⇡{outboxDepth} unpushed</Text>}
      <Text color={daemonUp ? theme.success : theme.warn}>{daemon}</Text>
      {queueRunning + queueWaiting > 0 && (
        <Text color={theme.info}>
          ◐{queueRunning} ⏳{queueWaiting}
        </Text>
      )}
      <Text dimColor>{hhmm}</Text>
    </Box>
  );
}

/** Row n-1: reserved single toast row (stable layout — blank when idle). */
export function Toast({
  toast,
}: {
  toast: { kind: ToastKind; text: string } | null;
}): React.JSX.Element {
  return (
    <Box paddingX={1} height={1}>
      {toast ? (
        <Text color={toastColor(toast.kind)} wrap="truncate-end">
          {toast.text.replace(/\s*[\r\n]+\s*/g, " · ")}
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}

/** Row n: context key hints — accent key, muted label, graceful truncation. */
export function Footer({ hints }: { hints: [string, string][] }): React.JSX.Element {
  return (
    <Box paddingX={1} height={1}>
      <Text wrap="truncate-end">
        {hints.map(([k, label], i) => (
          <Text key={k}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text color={theme.accent}>{k}</Text>
            <Text dimColor> {label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/** The full key set for the current context (the ? modal is the long form). */
export function hintsFor(
  view: HintView,
  pane: 1 | 2 | 3,
  mode: LayoutMode,
  filtering: boolean,
): [string, string][] {
  if (filtering) {
    return [
      ["type", "filter"],
      ["enter", "apply"],
      ["esc", "clear"],
    ];
  }
  switch (view) {
    case "detail":
      return [
        ["↑/↓", "scroll"],
        ["esc", "back"],
      ];
    case "queue":
      return [
        ["↑/↓", "scroll"],
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
        ["↑/↓", "scroll"],
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
      break;
  }
  if (pane === 1) {
    return [
      ["↑/↓", "move"],
      ["→", "issues"],
      ["w", "add repo"],
      ["x", "unwatch"],
      ["r", "refresh"],
      [":", "commands"],
      ["?", "help"],
      ["q", "quit"],
    ];
  }
  if (pane === 3) {
    return [
      ["↑/↓", "scroll"],
      ["←", "issues"],
      ["o", "browser"],
      ["?", "help"],
      ["q", "quit"],
    ];
  }
  const panesHint: [string, string] = mode === "wide" ? ["←/→", "panes"] : ["←", "repos"];
  return [
    ["↑/↓", "move"],
    panesHint,
    ["enter", mode === "wide" ? "preview" : "detail"],
    ["d", "dispatch"],
    ["a", "approve"],
    ["/", "filter"],
    ["t", "queue"],
    ["?", "help"],
    ["q", "quit"],
  ];
}
