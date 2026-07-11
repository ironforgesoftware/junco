/** Chapter 6 — recap → confirm → write (shadcn: the config file is the
 * product). Fresh mode shows the exact JSON; rerun shows an old → new diff of
 * just the changed lever paths, or the untouched note when there are none. */
import React from "react";
import { Box, Text } from "ink";
import { Select, type ChapterProps } from "../controls.js";
import { TIPS, BIRD } from "../../../wizard/tips.js";
import { LEVERS } from "../../../configLevers.js";
import { renderConfigJson, diffAnswers, COVERED_LEVER_COUNT } from "../../../wizard/flow.js";
import { theme } from "../../theme.js";

export interface ReviewProps extends ChapterProps {
  onWrite: () => void;
  onCancel: () => void;
}

/** Human-readable diff value: strings print raw (no quotes), everything else
 * falls back to JSON.stringify, undefined reads as "unset". */
function fmt(v: unknown): string {
  if (v === undefined) return "unset";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function Review({ answers, io, onWrite, onBack, onCancel }: ReviewProps): React.JSX.Element {
  const diff = io.mode === "rerun" ? diffAnswers(io.currentRaw ?? {}, answers) : null;
  const untouched = diff !== null && diff.length === 0;
  return (
    <Box flexDirection="column">
      {diff === null ? (
        <>
          <Text>This is the exact config.json that will be written:</Text>
          <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1} width={58}>
            <Text>{renderConfigJson(answers).trimEnd()}</Text>
          </Box>
        </>
      ) : untouched ? (
        <Text>Nothing changed — config untouched.</Text>
      ) : (
        <>
          <Text>Changes to {io.configPath}:</Text>
          <Box flexDirection="column" marginTop={1}>
            {diff.map((d) => (
              <Text key={d.path}>
                <Text color={theme.accent}>{d.path}</Text>: <Text dimColor>{fmt(d.from)}</Text> →{" "}
                {fmt(d.to)}
              </Text>
            ))}
          </Box>
        </>
      )}
      <Box marginTop={1}>
        <Select
          focus
          options={
            untouched
              ? [{ value: "write", label: "Finish" }]
              : [
                  { value: "write", label: io.mode === "rerun" ? "Write changes" : "Write config" },
                  { value: "back", label: "Go back" },
                  { value: "cancel", label: "Quit without writing" },
                ]
          }
          onSubmit={(v) => (v === "write" ? onWrite() : v === "back" ? onBack() : onCancel())}
        />
      </Box>
      {/* Not the shared <Tip> (fixed width={58}): the composed count-prefixed
          sentence runs long enough to wrap mid-phrase (splitting "config"
          from "list`") at that width, so this copy needs a bit more room. */}
      <Box marginTop={1}>
        <Text>{BIRD} </Text>
        <Box width={66}>
          <Text dimColor wrap="wrap">
            {`${LEVERS.length - COVERED_LEVER_COUNT} ${TIPS.review}`}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
