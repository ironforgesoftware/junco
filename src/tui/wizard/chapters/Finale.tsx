/** The finale — write receipts, a doctor-lite flight check, then next steps
 * revealed one line at a time (Astro-style pacing; failures never block:
 * the config is already on disk and every ✗ names its fix). */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { ReceiptList } from "../controls.js";
import { Spinner } from "../../components/Spinner.js";
import { NEXT_STEPS, TIPS, BIRD } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";
import { useGuardedInput } from "../../useGuardedInput.js";
import { ClickableBox } from "../../ClickableBox.js";
import type { CheckResult } from "../../../wizard/detect.js";
import type { WriteResult, WizardIO } from "../../../wizard/io.js";

export interface FinaleProps {
  result: WriteResult;
  io: WizardIO;
  onDone: () => void;
  /** ms between next-step reveals; tests pass 0. Default 150. */
  revealMs?: number;
}

export function Finale({ result, io, onDone, revealMs = 150 }: FinaleProps): React.JSX.Element {
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let alive = true;
    void io.flightCheck().then((c) => alive && setChecks(c));
    return () => {
      alive = false;
    };
  }, [io]);
  useEffect(() => {
    if (checks === null || shown >= NEXT_STEPS.length) return;
    const id = setTimeout(() => setShown((n) => n + 1), revealMs);
    return () => clearTimeout(id);
  }, [checks, shown, revealMs]);
  useGuardedInput((_input, key) => {
    if (key.return) onDone();
  });
  return (
    <ClickableBox flexDirection="column" onPress={onDone}>
      <Text>
        <Text color={theme.success}>✓</Text>{" "}
        {result.written
          ? `Wrote config: ${result.configPath}`
          : `Config untouched: ${result.configPath}`}
      </Text>
      <Text>
        <Text color={theme.success}>✓</Text> Queue ready: {result.queueRoot}
        {"/{inbox,processing,done,failed}"}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Flight check</Text>
        {checks ? (
          <ReceiptList items={checks} />
        ) : (
          <Text>
            <Spinner /> probing your setup…
          </Text>
        )}
      </Box>
      {checks && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Next steps</Text>
          {NEXT_STEPS.slice(0, shown).map((s) => (
            <Text key={s.cmd}>
              {"  "}
              <Text color={theme.info}>{s.cmd}</Text> <Text dimColor>— {s.blurb}</Text>
            </Text>
          ))}
        </Box>
      )}
      {checks && shown >= NEXT_STEPS.length && (
        <Box marginTop={1}>
          <Text>
            {TIPS.signoff} {BIRD} <Text dimColor>(enter to finish)</Text>
          </Text>
        </Box>
      )}
    </ClickableBox>
  );
}
