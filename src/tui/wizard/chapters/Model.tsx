/** Chapter 2 — the inference endpoint + model. Same discovery/prefix rules as
 * the original wizard: probe <base>/models, bare ids get inferProvider()'s
 * prefix, ids with "/" are kept verbatim; unreachable endpoints warn and fall
 * through to manual entry (never a dead end — the finale re-probes). */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Tip, Select, type ChapterProps } from "../controls.js";
import { TextField } from "../../components/TextField.js";
import { Spinner } from "../../components/Spinner.js";
import { TIPS } from "../../../wizard/tips.js";
import { inferProvider } from "../../../wizard/models.js";
import { theme } from "../../theme.js";

type Step = "source" | "url" | "key" | "probe" | "pick" | "manual" | "mjPath";
const MANUAL = " manual"; // select sentinel (leading space — not a real id)

export function Model({
  answers,
  patch,
  onNext,
  io,
  setTextEditing,
}: ChapterProps): React.JSX.Element {
  const [step, setStep] = useState<Step>("source");
  const [ids, setIds] = useState<string[]>([]);
  const [manualDraft, setManualDraft] = useState("");
  const textSteps: Step[] = ["url", "key", "manual", "mjPath"];
  useEffect(() => {
    setTextEditing(textSteps.includes(step));
    return () => setTextEditing(false);
  }, [step]);
  useEffect(() => {
    if (step !== "probe") return;
    let alive = true;
    void io.discoverModels(answers.baseUrl ?? "", answers.apiKey ?? "").then((found) => {
      if (!alive) return;
      setIds(found);
      setStep(found.length > 0 ? "pick" : "manual");
    });
    return () => {
      alive = false;
    };
  }, [step]);

  const finish = (picked: string): void => {
    const full =
      picked.includes("/") || answers.mode === "models_json"
        ? picked
        : `${inferProvider(answers.baseUrl ?? "")}/${picked}`;
    patch({ modelId: full });
    onNext();
  };

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
      {step === "source" && (
        <>
          <Text>How is the model configured?</Text>
          <Box marginTop={1}>
            <Select
              focus
              options={[
                {
                  value: "inline",
                  label: "Inline — an OpenAI-compatible endpoint",
                  hint: "recommended",
                },
                { value: "models_json", label: "From a Pi models.json file" },
              ]}
              onSubmit={(v) => {
                patch({ mode: v as "inline" | "models_json" });
                setStep(v === "inline" ? "url" : "mjPath");
              }}
            />
          </Box>
        </>
      )}
      {step === "url" && (
        <>
          <Text>Inference endpoint base URL (OpenAI-compatible /v1)?</Text>
          {field(
            answers.baseUrl ?? "",
            (v) => patch({ baseUrl: v }),
            () => setStep("key"),
            "http://127.0.0.1:1234/v1",
          )}
        </>
      )}
      {step === "key" && (
        <>
          <Text>API key for the endpoint?</Text>
          {field(
            answers.apiKey ?? "",
            (v) => patch({ apiKey: v }),
            () => setStep("probe"),
            "1234",
          )}
        </>
      )}
      {step === "probe" && (
        <Text>
          <Spinner /> asking the endpoint for its models…
        </Text>
      )}
      {step === "mjPath" && (
        <>
          <Text>Path to your Pi models.json?</Text>
          {field(
            answers.modelsJson ?? "~/.pi/agent/models.json",
            (v) => patch({ modelsJson: v }),
            () => {
              const found = io.listModelsJson(answers.modelsJson ?? "~/.pi/agent/models.json");
              setIds(found);
              setStep(found.length > 0 ? "pick" : "manual");
            },
            "~/.pi/agent/models.json",
          )}
        </>
      )}
      {step === "pick" && (
        <>
          <Text>
            <Text color={theme.success}>✓</Text> {ids.length} model{ids.length === 1 ? "" : "s"}{" "}
            found — pick one
          </Text>
          <Box marginTop={1}>
            <Select
              focus
              options={[
                ...ids.map((id) => ({ value: id, label: id })),
                { value: MANUAL, label: "✏️  Enter manually…" },
              ]}
              onSubmit={(v) => (v === MANUAL ? setStep("manual") : finish(v))}
            />
          </Box>
        </>
      )}
      {step === "manual" && (
        <>
          <Text>Model id?</Text>
          {field(
            manualDraft,
            setManualDraft,
            () => finish(manualDraft.trim() || "my-model"),
            "my-model",
          )}
        </>
      )}
      <Tip>{TIPS.model}</Tip>
    </Box>
  );
}
