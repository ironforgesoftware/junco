/** Chapter 5 — who junco acts as on GitHub. Default keeps the ambient gh
 * login (zero gh calls). Choosing the bot probes the isolated config dir and,
 * when no login exists, offers gh's device-flow login (Ink suspended around
 * it) or a skip (junco auth login later; doctor nags until then). */
import React, { useState } from "react";
import { Box, Text } from "ink";
import { Tip, Select, type ChapterProps } from "../controls.js";
import { TIPS } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";
import { useSuspend } from "../../useSuspend.js";

type Step = "toggle" | "checking" | "found" | "login" | "running";

export function Account({ answers, patch, onNext, io }: ChapterProps): React.JSX.Element {
  const [step, setStep] = useState<Step>("toggle");
  const [login, setLogin] = useState<string | null>(null);
  const suspend = useSuspend();

  const detect = async (): Promise<void> => {
    setStep("checking");
    const l = await io.detectBotLogin();
    if (l !== null) {
      setLogin(l);
      patch({ botAccount: true });
      setStep("found");
    } else {
      setStep("login");
    }
  };

  return (
    <Box flexDirection="column">
      {step === "toggle" && (
        <>
          <Text>Who should junco act as on GitHub?</Text>
          <Box marginTop={1}>
            <Select
              focus
              initial={answers.botAccount ? 1 : 0}
              options={[
                { value: "ambient", label: "Your gh login", hint: "default — nothing changes" },
                { value: "bot", label: "A dedicated bot account", hint: "daemon acts as the bot" },
              ]}
              onSubmit={(v) => {
                if (v === "ambient") {
                  patch({ botAccount: false });
                  onNext();
                } else {
                  void detect();
                }
              }}
            />
          </Box>
          <Tip>{TIPS.account}</Tip>
        </>
      )}
      {step === "checking" && <Text dimColor>checking {io.botGhConfigDir}…</Text>}
      {step === "found" && (
        <>
          <Text>
            <Text color={theme.success}>✓</Text> bot account —{" "}
            <Text color={theme.accent}>acting as {login}</Text>
          </Text>
          <Box marginTop={1}>
            <Select
              focus
              options={[{ value: "next", label: "Continue" }]}
              onSubmit={() => onNext()}
            />
          </Box>
        </>
      )}
      {step === "login" && (
        <>
          <Text>No bot login yet under {io.botGhConfigDir}.</Text>
          <Text dimColor>
            Create the machine account on github.com first (a normal account, e.g. junco-agent).
          </Text>
          <Box marginTop={1}>
            <Select
              focus
              options={[
                {
                  value: "login",
                  label: "Log in now",
                  hint: "opens your browser (gh device flow)",
                },
                { value: "skip", label: "Skip — I'll run `junco auth login` later" },
              ]}
              onSubmit={(v) => {
                if (v === "skip") {
                  patch({ botAccount: true }); // doctor nags until the login exists
                  onNext();
                } else {
                  setStep("running");
                  void suspend(() => io.runGhLogin()).then(() => detect());
                }
              }}
            />
          </Box>
        </>
      )}
      {step === "running" && <Text dimColor>gh auth login running in your terminal…</Text>}
    </Box>
  );
}
