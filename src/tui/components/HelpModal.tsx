import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { Modal } from "./Modal.js";
import { hintsFor, type HintView } from "./Chrome.js";
import type { LayoutMode } from "../layout.js";

function Section({ title, rows }: { title: string; rows: [string, string][] }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {rows.map(([k, d]) => (
        <Box key={k} gap={2}>
          <Box minWidth={12}>
            <Text color={theme.accent}>{k}</Text>
          </Box>
          <Text>{d}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Categorized help, k9s-style: what applies to the CURRENT view first. */
export function HelpModal({
  view,
  pane,
  mode,
  trigger,
}: {
  view: HintView;
  pane: 1 | 2 | 3;
  mode: LayoutMode;
  trigger: string;
}): React.JSX.Element {
  return (
    <Modal title="junco dashboard — keys" minWidth={64}>
      <Text dimColor>
        flow: d dispatch → junco posts a plan → read it in the preview → a approve → PR opens
      </Text>
      <Section title="this view" rows={hintsFor(view, pane, mode, false)} />
      <Section
        title="navigate"
        rows={[
          ["↑/↓ · j/k", "move selection / scroll"],
          ["←/→ · h/l · tab", "switch panes"],
          ["[ / ]", "scroll (alias of ↑/↓ in views)"],
          ["g/G", "first / last"],
          ["1/2/3", "jump pane directly (3 = PRs for the selected repo, wide)"],
          ["enter", "open detail — issue (pane 2) or PR (pane 3 / PRs view)"],
        ]}
      />
      <Section
        title="act on issue"
        rows={[
          ["d", `dispatch (adds \`${trigger}\`)`],
          ["D", "dispatch as ask (read-only Q&A)"],
          ["a", "approve the posted plan"],
          ["R", "re-plan / re-cycle (by state)"],
          ["o", "open in browser (repo from pane 1, PR from PR views)"],
        ]}
      />
      <Section
        title="panes & views"
        rows={[
          ["/", "filter issues (esc clears)"],
          ["w", "add repo to watchlist"],
          ["x", "unwatch repo"],
          ["r", "refresh now"],
          ["s", "assess the selected repo (audit for vulnerabilities, file issues)"],
          ["S", "assess with --auto-plan (findings carry the trigger label)"],
          ["v", "assess review queue"],
          ["t", "queue view"],
          ["p", "PR tracking — junco-authored PRs across watched repos"],
          [":", "command palette"],
        ]}
      />
      <Section
        title="mouse"
        rows={[
          ["click", "focus pane / select row"],
          ["click selected", "open it — same as enter"],
          ["wheel", "move selection / scroll, under the cursor"],
          ["↗ line", "open on GitHub (cmd+click works too)"],
        ]}
      />
      <Section
        title="system"
        rows={[
          ["?", "this help"],
          ["q", "quit (terminal restored)"],
          ["⇡", "unpushed GitHub ops — flushed automatically; junco outbox flush pushes now"],
        ]}
      />
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Modal>
  );
}
