/** Chapter 5 — the optional features, batched into one multiselect (sv-create
 * style) with the recommended set pre-checked. Footer shows the focused
 * lever's real LEVERS description, ConfigView-style. */
import React, { useState } from "react";
import { Box, Text } from "ink";
import { Tip, MultiSelect, type ChapterProps } from "../controls.js";
import { TIPS } from "../../../wizard/tips.js";
import { LEVERS } from "../../../configLevers.js";

const ROWS = [
  { value: "sandbox", label: "OS sandbox for agent commands", lever: "sandbox.enabled" },
  { value: "verify", label: "Verify (build/test) before each PR", lever: "verify.enabled" },
  { value: "health", label: "Health endpoint on 127.0.0.1", lever: "observability.healthEnabled" },
  { value: "transcripts", label: "Per-ticket transcripts", lever: "observability.transcripts" },
] as const;

function describe(leverPath: string): string {
  return LEVERS.find((l) => l.path === leverPath)?.description ?? "";
}

export function Extras({ answers, patch, onNext }: ChapterProps): React.JSX.Element {
  const [focused, setFocused] = useState(0);
  return (
    <Box flexDirection="column">
      <Text>Which extras should stay on? (space toggles, enter continues)</Text>
      <Box marginTop={1}>
        <MultiSelect
          focus
          items={ROWS.map((r) => ({
            value: r.value,
            label: r.label,
            checked: answers.extras[r.value as keyof typeof answers.extras],
          }))}
          onFocusChange={setFocused}
          onSubmit={(vals) => {
            patch({
              extras: {
                sandbox: vals.includes("sandbox"),
                verify: vals.includes("verify"),
                health: vals.includes("health"),
                transcripts: vals.includes("transcripts"),
              },
            });
            onNext();
          }}
        />
      </Box>
      <Box marginTop={1} width={58}>
        <Text dimColor wrap="wrap">
          {describe(ROWS[focused].lever)}
        </Text>
      </Box>
      <Tip>{TIPS.extras}</Tip>
    </Box>
  );
}
