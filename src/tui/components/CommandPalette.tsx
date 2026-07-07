import React from "react";
import { Box, Text } from "ink";
import type { PaletteCommand } from "../cliRunner.js";
import { TextField } from "./TextField.js";

/** Prefix-ish filter: name starts with the query, or query appears in it. */
export function filterCommands(commands: PaletteCommand[], filter: string): PaletteCommand[] {
  const q = filter.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.name.startsWith(q) || c.name.includes(q));
}

export function CommandPalette({
  commands,
  filter,
  selected,
  argsMode,
  argsValue,
  onFilter,
  onArgs,
  onCancel,
}: {
  commands: PaletteCommand[];
  filter: string;
  selected: number;
  argsMode: boolean;
  argsValue: string;
  onFilter: (v: string) => void;
  onArgs: (v: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const visible = filterCommands(commands, filter);
  const current = visible[Math.min(selected, Math.max(0, visible.length - 1))];
  void onCancel; // esc handled by the App's router; prop kept for symmetry
  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} minWidth={60}>
      <Text bold>run a junco command</Text>
      <Text dimColor>Runs the junco CLI against this dashboard's config; output opens here.</Text>
      <Box gap={1}>
        <Text dimColor>:</Text>
        <TextField
          value={filter}
          onChange={onFilter}
          onSubmit={() => {}}
          focus={!argsMode}
          placeholder="type to filter…"
        />
      </Box>
      {visible.length === 0 && <Text dimColor>no matching command</Text>}
      {visible.map((c, i) => (
        <Box key={c.name} gap={1}>
          <Text color={i === selected ? "cyan" : undefined} dimColor={c.excluded !== null}>
            {i === selected ? "▸ " : "  "}
            {c.name}
            {c.argsHint ? ` ${c.argsHint}` : ""}
          </Text>
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate-end">
            {c.excluded ?? c.description}
          </Text>
        </Box>
      ))}
      {argsMode && current && (
        <Box gap={1} marginTop={1}>
          <Text dimColor>args:</Text>
          <TextField
            value={argsValue}
            onChange={onArgs}
            onSubmit={() => {}}
            focus={true}
            placeholder={current.argsHint ?? ""}
          />
        </Box>
      )}
      <Text dimColor>enter run · ↑/↓ move · esc close</Text>
    </Box>
  );
}
