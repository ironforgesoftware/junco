import React, { useRef, useState } from "react";
import { Box, Text, usePaste } from "ink";
import { useGuardedInput } from "../useGuardedInput.js";
import { theme } from "../theme.js";

export const SLASH_COMMANDS: ReadonlyArray<{ name: string; hint: string; takesArg: boolean }> = [
  { name: "draft", hint: "draft a ticket from this conversation", takesArg: false },
  {
    name: "submit",
    hint: "submit [id] — submit the parked draft (the only one, or the named one)",
    takesArg: true,
  },
  { name: "audit", hint: "request a read-only repo audit (junco audit)", takesArg: false },
  {
    name: "investigate",
    hint: "investigate N — deep-read issue #N (junco investigate)",
    takesArg: true,
  },
  { name: "pr", hint: "pr N — pull PR #N (body, reviews, comments) into the chat", takesArg: true },
  { name: "issue", hint: "issue N — pull issue #N into the chat", takesArg: true },
  { name: "abort", hint: "abort the streaming turn", takesArg: false },
  { name: "new", hint: "archive this session and start fresh", takesArg: false },
];

/** Candidates for a leading-slash value; an argument (a space or newline) ends completion. */
export function slashMatches(value: string): typeof SLASH_COMMANDS {
  if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return [];
  const prefix = value.slice(1);
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export interface ComposerProps {
  value: string;
  onChange(v: string): void;
  onSubmit(v: string): void;
  focused: boolean;
  disabled?: boolean;
  disabledReason?: string;
  width: number;
  /** Visible rows for the text (default 4); longer input scrolls to the tail. */
  maxRows?: number;
}

/**
 * Multiline composer (spec 2026-09-01 §8.2). Ink 7's keypress parser makes
 * both newline chords deterministic (parse-keypress.js:414-423): alt+enter
 * arrives as `\x1b\r` → key.return && key.meta (414-418); ctrl+j arrives as
 * `\n` → input "\n" with key.return false (420-423, named 'enter' not
 * 'return' so use-input.js:50's `return: keypress.name === 'return'` stays
 * false). Paste comes through Ink's own bracketed-paste channel (usePaste,
 * §8.4) as one string and never reaches useInput while this hook is active.
 *
 * Every edit composes off a `valueRef` kept in sync with the `value` prop
 * rather than off the prop directly: Ink dispatches each keystroke via
 * `reconciler.discreteUpdates` with no synchronous flush (use-input.js:111),
 * so two `stdin.write` calls issued back-to-back run against the SAME render
 * closure — reading the stale `value` prop on the second would silently drop
 * the first edit. `edit()` updates the ref immediately so a chained keystroke
 * (or a paste) always composes onto the latest text; rendering still uses
 * the `value` prop, keeping the component controlled.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  focused,
  disabled = false,
  disabledReason,
  width,
  maxRows = 4,
}: ComposerProps): React.JSX.Element {
  const [slashSel, setSlashSel] = useState(0);
  const valueRef = useRef(value);
  valueRef.current = value; // resync from the prop every render
  const matches = slashMatches(value);
  const active = focused && !disabled;

  const edit = (next: string): void => {
    valueRef.current = next;
    onChange(next);
  };

  useGuardedInput(
    (input, key) => {
      // R22 applies to the match list too: two keypresses delivered in one
      // stdin read (or two back-to-back stdin.write calls in a test) run
      // against the SAME render closure, so the render-time `matches` (closed
      // over the pre-edit `value` prop) can be one keystroke stale. Recompute
      // off `valueRef.current` for every list-navigation decision; `matches`
      // stays for rendering only (it reflects the `value` prop, per R22).
      const m = slashMatches(valueRef.current);
      if (m.length > 0) {
        if (key.upArrow) {
          setSlashSel((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow) {
          setSlashSel((s) => Math.min(m.length - 1, s + 1));
          return;
        }
        if (key.tab) {
          const c = m[Math.min(slashSel, m.length - 1)]!;
          edit(`/${c.name}${c.takesArg ? " " : ""}`);
          setSlashSel(0);
          return;
        }
      }
      if (key.return && key.meta) {
        edit(valueRef.current + "\n");
        return;
      }
      if (key.return) {
        setSlashSel(0);
        onSubmit(valueRef.current);
        return;
      }
      if (input === "\n") {
        edit(valueRef.current + "\n");
        return;
      }
      if (key.backspace || key.delete) {
        edit(valueRef.current.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
        setSlashSel(0);
        edit(valueRef.current + input);
      }
    },
    // `text`: typed chunks append whole (the ref makes either shape correct,
    // but a text field states its contract — see useGuardedInput).
    { isActive: active, text: true },
  );
  usePaste((text) => edit(valueRef.current + text.replace(/\r\n?/g, "\n")), { isActive: active });

  const lines = value === "" ? [""] : value.split("\n");
  const shown = lines.slice(Math.max(0, lines.length - maxRows));
  const inner = Math.max(10, width - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? theme.accent : theme.border}
      paddingX={1}
    >
      {disabled ? (
        <Text dimColor>{disabledReason ?? "chat unavailable"}</Text>
      ) : (
        shown.map((l, i) => (
          <Text key={i} wrap="truncate">
            {i === shown.length - 1 && active ? (
              <>
                {l}
                <Text color="cyan">█</Text>
              </>
            ) : l === "" && i === 0 && shown.length === 1 ? (
              <Text dimColor>type a message — enter to send · ctrl+j newline · / commands</Text>
            ) : (
              l
            )}
          </Text>
        ))
      )}
      {matches.length > 0 && !disabled && (
        <Box flexDirection="column" marginTop={0}>
          {matches.map((c, i) => (
            <Text
              key={c.name}
              color={i === Math.min(slashSel, matches.length - 1) ? theme.accent : undefined}
              wrap="truncate"
            >
              {`/${c.name}`.padEnd(10)} <Text dimColor>{c.hint.slice(0, inner - 12)}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
