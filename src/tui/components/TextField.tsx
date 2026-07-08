import React from "react";
import { Text, useInput } from "ink";
import { isMouseInput } from "../mouse.js";

/** Minimal single-line input: printable chars append, backspace deletes,
 * enter submits. Only listens while `focus` is true. */
export function TextField({
  value,
  onChange,
  onSubmit,
  focus,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  focus: boolean;
  placeholder: string;
}): React.JSX.Element {
  useInput(
    (input, key) => {
      if (isMouseInput(input)) return;
      if (key.return) return onSubmit();
      if (key.backspace || key.delete) return onChange(value.slice(0, -1));
      if (input && !key.ctrl && !key.meta && !key.escape) onChange(value + input);
    },
    { isActive: focus },
  );
  // The block cursor marks the ACTIVE field — including when it's empty, so
  // the operator always sees where their keystrokes will land.
  if (value === "") {
    return (
      <Text>
        {focus && <Text color="cyan">█</Text>}
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }
  return (
    <Text>
      {value}
      {focus && <Text color="cyan">█</Text>}
    </Text>
  );
}
