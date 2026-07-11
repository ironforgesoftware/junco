/** Chapter 4 — the issues→inbox bridge. Off by default (zero gh calls);
 * enabling reveals watched-repo entry and the approval toggle. */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Tip, Select, type ChapterProps } from "../controls.js";
import { TextField } from "../../components/TextField.js";
import { TIPS } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";

type Step = "toggle" | "nwo" | "path" | "approval";

export function Github({
  answers,
  patch,
  onNext,
  setTextEditing,
}: ChapterProps): React.JSX.Element {
  const [step, setStep] = useState<Step>("toggle");
  const [nwo, setNwo] = useState("");
  const [path, setPath] = useState("");
  useEffect(() => {
    setTextEditing(step === "nwo" || step === "path");
    return () => setTextEditing(false);
  }, [step, setTextEditing]);

  const field = (
    value: string,
    onChange: (v: string) => void,
    onSubmit: () => void,
    placeholder: string,
  ): React.JSX.Element => (
    <Box borderStyle="round" borderColor={theme.border} paddingX={1} width={46} marginTop={1}>
      <TextField
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus
        placeholder={placeholder}
      />
    </Box>
  );

  return (
    <Box flexDirection="column">
      {step === "toggle" && (
        <>
          <Text>Enable the GitHub bridge (issues → tickets)?</Text>
          <Box marginTop={1}>
            <Select
              focus
              initial={answers.github.enabled ? 1 : 0}
              options={[
                { value: "off", label: "Off — stay fully local", hint: "recommended to start" },
                { value: "on", label: "On — watch repos for labeled issues" },
              ]}
              onSubmit={(v) => {
                if (v === "off") {
                  patch({ github: { ...answers.github, enabled: false } });
                  onNext();
                } else {
                  setStep("nwo");
                }
              }}
            />
          </Box>
          <Tip>{TIPS.githubOff}</Tip>
        </>
      )}
      {step === "nwo" && (
        <>
          <Text>Watch a repo — owner/repo (empty to finish adding):</Text>
          {answers.github.repos.map((r) => (
            <Text key={r.nwo}>
              <Text color={theme.success}>✓</Text> {r.nwo} <Text dimColor>({r.path})</Text>
            </Text>
          ))}
          {field(
            nwo,
            setNwo,
            () => (nwo.trim() === "" ? setStep("approval") : setStep("path")),
            "acme/api",
          )}
        </>
      )}
      {step === "path" && (
        <>
          <Text>
            Local clone path for <Text color={theme.accent}>{nwo.trim()}</Text>:
          </Text>
          {field(
            path,
            setPath,
            () => {
              const entry = { nwo: nwo.trim(), path: path.trim() };
              if (entry.path === "") return;
              if (!answers.github.repos.some((r) => r.nwo === entry.nwo)) {
                patch({ github: { ...answers.github, repos: [...answers.github.repos, entry] } });
              }
              setNwo("");
              setPath("");
              setStep("nwo");
            },
            "~/code/api (local clone path)",
          )}
        </>
      )}
      {step === "approval" && (
        <>
          <Text>Require your approval before a planned ticket executes?</Text>
          <Box marginTop={1}>
            <Select
              focus
              initial={answers.github.requireApproval ? 0 : 1}
              options={[
                { value: "yes", label: "Yes — plans wait for me", hint: "recommended" },
                { value: "no", label: "No — plan-ready tickets auto-execute" },
              ]}
              onSubmit={(v) => {
                patch({
                  github: { ...answers.github, enabled: true, requireApproval: v === "yes" },
                });
                onNext();
              }}
            />
          </Box>
          <Tip>{TIPS.githubApproval}</Tip>
        </>
      )}
      {step !== "toggle" && step !== "approval" && <Tip>{TIPS.githubOn}</Tip>}
    </Box>
  );
}
