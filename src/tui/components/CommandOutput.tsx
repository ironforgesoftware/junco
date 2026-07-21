import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";
import { clampScroll, maxScroll } from "../window.js";
import { Scrollbar } from "./primitives/Scrollbar.js";

export function CommandOutput({
  title,
  running,
  elapsedS,
  output,
  scroll,
  exitCode,
  timedOut,
  height,
  onScrollMax,
}: {
  title: string;
  running: boolean;
  elapsedS: number;
  output: string;
  scroll: number;
  exitCode: number | null;
  timedOut: boolean;
  height: number;
  onScrollMax?: (max: number) => void;
}): React.JSX.Element {
  // Reserved rows: borders ×2, title, scroll line, footer line.
  const visibleLines = Math.max(1, height - 5);
  const status = running
    ? `running… ${elapsedS}s`
    : timedOut
      ? `timed out after ${elapsedS}s (killed)`
      : `exit ${exitCode ?? "?"}`;
  const lines = output === "" ? [] : output.split("\n");
  onScrollMax?.(maxScroll(lines.length, visibleLines));
  const start = clampScroll(scroll, lines.length, visibleLines);
  const visible = lines.slice(start, start + visibleLines);
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
      <Box flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {visible.map((l, i) => (
            <Text key={i} wrap="truncate-end">
              {l || " "}
            </Text>
          ))}
        </Box>
        <Scrollbar
          offset={start}
          viewport={visibleLines}
          total={lines.length}
          height={visibleLines}
        />
      </Box>
      {lines.length > visibleLines && (
        <Text dimColor>
          ↑/↓ scroll · {start + 1}-{Math.min(start + visibleLines, lines.length)}/{lines.length}
        </Text>
      )}
      <Text dimColor>esc back · r re-run</Text>
    </Box>
  );
}
