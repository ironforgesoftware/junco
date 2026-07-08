import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";

export function CommandOutput({
  title,
  running,
  elapsedS,
  output,
  scroll,
  exitCode,
  timedOut,
  height,
}: {
  title: string;
  running: boolean;
  elapsedS: number;
  output: string;
  scroll: number;
  exitCode: number | null;
  timedOut: boolean;
  height: number;
}): React.JSX.Element {
  // Reserved rows: borders ×2, title, scroll line, footer line.
  const visibleLines = Math.max(1, height - 5);
  const status = running
    ? `running… ${elapsedS}s`
    : timedOut
      ? `timed out after ${elapsedS}s (killed)`
      : `exit ${exitCode ?? "?"}`;
  const lines = output === "" ? [] : output.split("\n");
  const visible = lines.slice(scroll, scroll + visibleLines);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      <Text bold>
        {title}{" "}
        <Text color={running ? "cyan" : timedOut || exitCode ? "red" : "green"}>
          {running && (
            <>
              <Spinner />{" "}
            </>
          )}
          [{status}]
        </Text>
      </Text>
      {visible.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
      {lines.length > visibleLines && (
        <Text dimColor>
          ↑/↓ scroll · {scroll + 1}-{Math.min(scroll + visibleLines, lines.length)}/{lines.length}
        </Text>
      )}
      <Text dimColor>esc back · r re-run</Text>
    </Box>
  );
}
