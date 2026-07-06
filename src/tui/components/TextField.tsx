import React from "react";
import { Text, useInput } from "ink";

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
      if (key.return) return onSubmit();
      if (key.backspace || key.delete) return onChange(value.slice(0, -1));
      if (input && !key.ctrl && !key.meta && !key.escape) onChange(value + input);
    },
    { isActive: focus },
  );
  return value === "" ? (
    <Text dimColor>{placeholder}</Text>
  ) : (
    <Text>{value + (focus ? "▏" : "")}</Text>
  );
}
