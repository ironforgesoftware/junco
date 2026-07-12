/** Chapter 1 — vaultRoot. juncoSubdir stays "" (queue directly under it). */
import React, { useEffect } from "react";
import { Box, Text } from "ink";
import { Tip, type ChapterProps } from "../controls.js";
import { TextField } from "../../components/TextField.js";
import { TIPS } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";

export function Workspace({
  answers,
  patch,
  onNext,
  setTextEditing,
}: ChapterProps): React.JSX.Element {
  useEffect(() => {
    setTextEditing(true);
    return () => setTextEditing(false);
  }, [setTextEditing]);
  return (
    <Box flexDirection="column">
      <Text>Where should junco keep its tickets?</Text>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} width={46} marginTop={1}>
        <TextField
          value={answers.vaultRoot}
          onChange={(v) => patch({ vaultRoot: v })}
          onSubmit={() => {
            if (answers.vaultRoot.trim() !== "") onNext();
          }}
          focus
          placeholder="~/Junco"
        />
      </Box>
      <Tip>{TIPS.workspace}</Tip>
    </Box>
  );
}
