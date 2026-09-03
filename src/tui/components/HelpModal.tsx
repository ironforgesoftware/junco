import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { Modal } from "./Modal.js";
import type { LayoutMode } from "../layout.js";
import type { ContextBindings } from "../viewActions.js";
import { NAV_HELP_ROWS } from "../footerModel.js";

function Section({ title, rows }: { title: string; rows: [string, string][] }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {rows.map(([k, d]) => (
        <Box key={`${k}-${d}`} gap={2}>
          <Box minWidth={12}>
            <Text color={theme.accent}>{k}</Text>
          </Box>
          <Text>{d}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Categorized help, k9s-style: the CURRENT context's derived mnemonics first
 * (mnemonic spec §3) — every named verb with its derived key, hidden shift
 * variants included (they never render in the footer) — then the structural
 * reference. An uppercase key = shift-guarded (destructive verbs + variants). */
export function HelpModal({
  pane,
  mode,
  trigger,
  bindings,
  updateLatest,
}: {
  pane: 1 | 2 | 3;
  mode: LayoutMode;
  trigger: string;
  /** The bindings of the surface UNDER the modal (App passes the main-body
   * context — help opens from the main view only). */
  bindings: ContextBindings;
  /** Latest npm version when newer than the running one; null/absent → no line. */
  updateLatest?: string | null;
}): React.JSX.Element {
  void pane;
  void mode;
  // Structural chips (key-first) then every derived mnemonic — visible verbs
  // first, hidden shift variants after, annotated.
  const structural = bindings.chips.flatMap((c) =>
    c.kind === "structural" ? [[c.key, c.label] as [string, string]] : [],
  );
  const visible = bindings.all.filter((d) => !d.hidden);
  const hidden = bindings.all.filter((d) => d.hidden && d.id !== "close");
  const thisView: [string, string][] = [
    ...structural,
    ...visible.map((d): [string, string] => [
      d.key,
      d.id === "chat" ? "chat with the agent about the repo under the cursor" : d.label,
    ]),
    ...hidden.map((d): [string, string] => [d.key, `${d.label} (shift variant)`]),
  ];
  return (
    <Modal title="junco dashboard — keys" minWidth={64}>
      <Text dimColor>
        flow: dispatch → junco posts a plan → read it in the preview → approve → PR opens (the
        trigger label is `{trigger}`)
      </Text>
      <Text dimColor>
        keys are mnemonics: the underlined letter in each footer chip IS the key; an uppercase
        letter means shift (guarded/destructive). The filled chip is chat — c on any screen with a
        repo in context.
      </Text>
      <Section title="this view" rows={thisView} />
      <Section title="navigate" rows={[...NAV_HELP_ROWS]} />
      <Section
        title="system rows"
        rows={[
          ["queue…logs", "pinned below the repos — enter/→ opens the body"],
          ["retry", "requeue a failed ticket (queue row)"],
          ["Delete / Prune", "remove a queued ticket / stale worktree (shift, confirmed)"],
          ["Restart", "restart the daemon (shift, confirmed; work salvaged)"],
          ["enter on logs", "full-screen live log (follow · level · ticket · / search)"],
          ["enter on queue", "transcript of a running/recent ticket (thinking · follow · expand)"],
          ["accent #", "issue/PR opened by the junco bot account"],
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
      {updateLatest != null && (
        <Box marginTop={1}>
          <Text color={theme.accent}>⬆ junco v{updateLatest} available — run: junco update</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Modal>
  );
}
