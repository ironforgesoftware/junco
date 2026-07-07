import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";

const VISIBLE_LINES = 24;

export function CommandOutput({
  title,
  running,
  elapsedS,
  output,
  scroll,
  exitCode,
  timedOut,
}: {
  title: string;
  running: boolean;
  elapsedS: number;
  output: string;
  scroll: number;
  exitCode: number | null;
  timedOut: boolean;
}): React.JSX.Element {
  const status = running
    ? `running… ${elapsedS}s`
    : timedOut
      ? `timed out after ${elapsedS}s (killed)`
      : `exit ${exitCode ?? "?"}`;
  const lines = output === "" ? [] : output.split("\n");
  const visible = lines.slice(scroll, scroll + VISIBLE_LINES);
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
      {lines.length > VISIBLE_LINES && (
        <Text dimColor>
          j/k scroll · {scroll + 1}-{Math.min(scroll + VISIBLE_LINES, lines.length)}/{lines.length}
        </Text>
      )}
      <Text dimColor>esc back · r re-run</Text>
    </Box>
  );
}
