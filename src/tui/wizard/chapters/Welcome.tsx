/** Chapter 0 — greeting + machine preflight (detect-then-offer: what the
 * machine already has right is shown as receipts, never asked). */
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Tip, ReceiptList, type ChapterProps } from "../controls.js";
import { Spinner } from "../../components/Spinner.js";
import { TIPS, pickGreeting } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";
import { isMouseInput } from "../../mouse.js";
import type { CheckResult } from "../../../wizard/detect.js";

export function Welcome({ io, onNext }: ChapterProps): React.JSX.Element {
  const [name, setName] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [seed] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    void io.greetName().then((n) => alive && setName(n));
    void io.preflight().then((c) => alive && setChecks(c));
    return () => {
      alive = false;
    };
  }, [io]);
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.return) onNext();
  });
  return (
    <Box flexDirection="column">
      <Text>
        Hey <Text color={theme.accent}>{name ?? "…"}</Text> — {pickGreeting(seed)}
      </Text>
      {io.mode === "rerun" && (
        <Box marginTop={1}>
          <Text dimColor>
            Found your config at {io.configPath} — let's tune it. q leaves everything untouched.
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        {checks ? (
          <ReceiptList items={checks} />
        ) : (
          <Text>
            <Spinner /> checking your machine…
          </Text>
        )}
      </Box>
      <Tip>{TIPS.welcome}</Tip>
      <Box marginTop={1}>
        <Text dimColor>press enter to begin</Text>
      </Box>
    </Box>
  );
}
