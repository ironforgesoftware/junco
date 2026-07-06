import React from "react";
import { Text } from "ink";

/** Temporary toolchain smoke component — removed once real components land. */
export function Smoke({ label }: { label: string }): React.JSX.Element {
  return <Text>{label} dashboard smoke</Text>;
}
