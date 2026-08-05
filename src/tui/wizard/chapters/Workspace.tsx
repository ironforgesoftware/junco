/** Chapter 1 — dataDir, the unified data root (queue, reviews, transcripts). */
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
  io,
}: ChapterProps): React.JSX.Element {
  useEffect(() => {
    setTextEditing(true);
    return () => setTextEditing(false);
  }, [setTextEditing]);
  return (
    <Box flexDirection="column">
      <Text>Where should junco keep its data (queue, reviews, transcripts)?</Text>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} width={46} marginTop={1}>
        <TextField
          value={answers.dataDir}
          onChange={(v) => patch({ dataDir: v })}
          onSubmit={() => {
            if (answers.dataDir.trim() !== "") onNext();
          }}
          focus
          placeholder="~/.junco"
        />
      </Box>
      {io.dataDirLegacyFallback && (
        // Informational only — mirrors io.effectiveDataDir, never patches
        // `answers`, so leaving this field untouched still writes no
        // explicit dataDir key (see WizardIO.effectiveDataDir's doc comment).
        <Text dimColor>
          found existing data at {io.effectiveDataDir} — junco will keep using it
        </Text>
      )}
      <Tip>{TIPS.workspace}</Tip>
    </Box>
  );
}
