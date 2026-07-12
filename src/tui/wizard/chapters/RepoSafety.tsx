/** Chapter 3 — git.allowedRepoRoots, the containment rail. Trust copy lives
 * exactly where the authority is granted (Stripe-style). Empty list is
 * honest: any repo path is allowed. */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Tip, type ChapterProps } from "../controls.js";
import { TextField } from "../../components/TextField.js";
import { TIPS } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";

export function RepoSafety({
  answers,
  patch,
  onNext,
  setTextEditing,
}: ChapterProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setTextEditing(true);
    return () => setTextEditing(false);
  }, [setTextEditing]);
  return (
    <Box flexDirection="column">
      <Text>Which folders may junco work in? (Enter on an empty field continues)</Text>
      {answers.repoRoots.map((r) => (
        <Text key={r}>
          <Text color={theme.success}>✓</Text> {r}
        </Text>
      ))}
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} width={46} marginTop={1}>
        <TextField
          value={draft}
          onChange={setDraft}
          onSubmit={() => {
            const v = draft.trim();
            if (v === "") return onNext();
            if (!answers.repoRoots.includes(v)) {
              patch({ repoRoots: [...answers.repoRoots, v] });
            }
            setDraft("");
          }}
          focus
          placeholder="~/code (empty = allow any repo path)"
        />
      </Box>
      <Tip>{TIPS.repoSafety}</Tip>
    </Box>
  );
}
