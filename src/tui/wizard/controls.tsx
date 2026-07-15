/**
 * Shared wizard controls: the junco Tip box, ✓/⚠/✗ receipt rows, and minimal
 * Select/MultiSelect (arrow + enter / space) in the dashboard's visual
 * language (theme.ts). Also home of ChapterProps — the contract every
 * chapter component implements.
 */
import React, { useRef, useState } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { BIRD } from "../../wizard/tips.js";
import { useGuardedInput } from "../useGuardedInput.js";
import { ClickableBox } from "../ClickableBox.js";
import type { CheckResult } from "../../wizard/detect.js";
import type { WizardAnswers } from "../../wizard/flow.js";
import type { WizardIO } from "../../wizard/io.js";

export interface ChapterProps {
  answers: WizardAnswers;
  patch: (p: Partial<WizardAnswers>) => void;
  onNext: () => void;
  onBack: () => void;
  io: WizardIO;
  setTextEditing: (b: boolean) => void;
}

export function Tip({ children }: { children: string }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text>{BIRD} </Text>
      <Box width={58}>
        <Text dimColor wrap="wrap">
          {children}
        </Text>
      </Box>
    </Box>
  );
}

const MARK = { ok: "✓", warn: "⚠", fail: "✗" } as const;
const COLOR = { ok: theme.success, warn: theme.warn, fail: theme.error } as const;

export function ReceiptList({ items }: { items: CheckResult[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((r, i) => (
        <Text key={i}>
          <Text color={COLOR[r.verdict]}>{MARK[r.verdict]}</Text> {r.label}
          {r.detail ? <Text dimColor> — {r.detail}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export function Select({
  options,
  onSubmit,
  focus,
  initial = 0,
}: {
  options: SelectOption[];
  onSubmit: (v: string) => void;
  focus: boolean;
  initial?: number;
}): React.JSX.Element {
  // Ink parses one stdin chunk into multiple key events dispatched
  // synchronously in a for-loop, with React's flush deferred past the whole
  // loop — so two keys arriving in one chunk (key-repeat, fast typing,
  // SSH/tmux buffering) would both read pre-update state if we relied on the
  // `idx` render closure. The ref is the authoritative, synchronously
  // mutated value; `bump` just forces the re-render that reads it back out.
  const idxRef = useRef(initial);
  const [, bump] = useState(0);
  useGuardedInput(
    (input, key) => {
      if (key.upArrow) {
        idxRef.current = Math.max(0, idxRef.current - 1);
        bump((n) => n + 1);
      } else if (key.downArrow) {
        idxRef.current = Math.min(options.length - 1, idxRef.current + 1);
        bump((n) => n + 1);
      } else if (key.return) {
        onSubmit(options[idxRef.current].value);
      }
    },
    { isActive: focus },
  );
  return (
    <Box flexDirection="column">
      {options.map((o, i) => (
        <ClickableBox
          key={o.value}
          hoverBg={theme.hoverBg}
          onPress={
            focus
              ? () => {
                  idxRef.current = i;
                  bump((n) => n + 1);
                  onSubmit(o.value); // click = choose + advance (enter parity)
                }
              : undefined
          }
        >
          <Text color={i === idxRef.current ? theme.accent : undefined}>
            {i === idxRef.current ? "▌ " : "  "}
            {o.label}
            {o.hint ? <Text dimColor> ({o.hint})</Text> : null}
          </Text>
        </ClickableBox>
      ))}
    </Box>
  );
}

export interface MultiItem {
  value: string;
  label: string;
  checked: boolean;
}

export function MultiSelect({
  items,
  onSubmit,
  onFocusChange,
  focus,
}: {
  items: MultiItem[];
  onSubmit: (checkedValues: string[]) => void;
  onFocusChange: (index: number) => void;
  focus: boolean;
}): React.JSX.Element {
  // See Select above: idxRef/checkedRef are the authoritative state, mutated
  // synchronously inside the handler so a burst of key events delivered in
  // one stdin chunk (e.g. Space then Enter) each see the other's effect.
  // `bump` only forces the re-render that reads the refs back out.
  const idxRef = useRef(0);
  const checkedRef = useRef(items.map((i) => i.checked));
  const [, bump] = useState(0);
  useGuardedInput(
    (input, key) => {
      if (key.upArrow) {
        idxRef.current = Math.max(0, idxRef.current - 1);
        onFocusChange(idxRef.current);
        bump((n) => n + 1);
      } else if (key.downArrow) {
        idxRef.current = Math.min(items.length - 1, idxRef.current + 1);
        onFocusChange(idxRef.current);
        bump((n) => n + 1);
      } else if (input === " ") {
        const i = idxRef.current;
        checkedRef.current = checkedRef.current.map((v, j) => (j === i ? !v : v));
        bump((n) => n + 1);
      } else if (key.return) {
        onSubmit(items.filter((_, i) => checkedRef.current[i]).map((i) => i.value));
      }
    },
    { isActive: focus },
  );
  return (
    <Box flexDirection="column">
      {items.map((o, i) => (
        <ClickableBox
          key={o.value}
          hoverBg={theme.hoverBg}
          onPress={
            focus
              ? () => {
                  idxRef.current = i;
                  checkedRef.current = checkedRef.current.map((v, j) => (j === i ? !v : v));
                  onFocusChange(i);
                  bump((n) => n + 1);
                }
              : undefined
          }
        >
          <Text color={i === idxRef.current ? theme.accent : undefined}>
            {i === idxRef.current ? "▌ " : "  "}
            {checkedRef.current[i] ? "[x] " : "[ ] "}
            {o.label}
          </Text>
        </ClickableBox>
      ))}
    </Box>
  );
}
