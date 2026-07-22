/** Chapter 2 — the inference endpoint + model. Same discovery/prefix rules as
 * the original wizard: probe <base>/models, bare ids get inferProvider()'s
 * prefix, ids with "/" are kept verbatim; unreachable endpoints warn and fall
 * through to manual entry (never a dead end — the finale re-probes). The
 * "hosted" source skips the endpoint entirely: pick provider + model straight
 * from the SDK's embedded catalog (io.listCatalogProviders), then the shared
 * key step, then finish() joins them as "<provider>/<modelId>" verbatim. */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Tip, Select, type ChapterProps } from "../controls.js";
import { TextField } from "../../components/TextField.js";
import { Spinner } from "../../components/Spinner.js";
import { TIPS } from "../../../wizard/tips.js";
import { inferProvider } from "../../../wizard/models.js";
import { splitModelId } from "../../../agent/modelSetup.js";
import type { CatalogEntry } from "../../../agent/session.js";
import { theme } from "../../theme.js";

// "hostedProvider"/"hostedModel" are the hosted-catalog picker pair — they
// replace url/probe (no endpoint to reach; the catalog is embedded SDK data)
// but still land on the shared "key" step before finish().
type Step =
  | "source"
  | "url"
  | "key"
  | "probe"
  | "pick"
  | "manual"
  | "mjPath"
  | "hostedProvider"
  | "hostedModel";
const MANUAL = " manual"; // select sentinel (leading space — not a real id)
// Module scope (not render-local): a stable reference so the mount-editing
// effect below can depend on it without recreating it — and re-firing —
// every render.
const TEXT_STEPS: Step[] = ["url", "key", "manual", "mjPath"];

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
  // Hosted-catalog picker state. catalog === null means "not loaded yet"
  // (distinct from a loaded-but-empty list) so the loading spinner can't spin
  // forever on a resolved-empty response.
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [hostedProviderName, setHostedProviderName] = useState("");
  const [hostedModelId, setHostedModelId] = useState("");
  // Local draft, never the answers value directly: in rerun mode this starts
  // EMPTY (the stored key never touches the screen — ConfigView's startEdit
  // pattern) and an empty submit leaves answers.apiKey untouched. Fresh mode
  // starts from the current answer as before.
  const [keyDraft, setKeyDraft] = useState<string>(() =>
    io.mode === "rerun" ? "" : (answers.apiKey ?? ""),
  );
  useEffect(() => {
    setTextEditing(TEXT_STEPS.includes(step));
    return () => setTextEditing(false);
  }, [step, setTextEditing]);
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
  }, [step, answers.baseUrl, answers.apiKey, io]);
  useEffect(() => {
    if (step !== "hostedProvider") return;
    let alive = true;
    void io
      .listCatalogProviders()
      .then((found) => {
        if (!alive) return;
        setCatalog(found);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setCatalogError(
          `Couldn't load the hosted-provider catalog (${
            e instanceof Error ? e.message : String(e)
          }) — pick another option below.`,
        );
        setStep("source");
      });
    return () => {
      alive = false;
    };
  }, [step, io]);

  const finish = (picked: string): void => {
    const full =
      answers.mode === "hosted"
        ? `${hostedProviderName}/${picked}`
        : picked.includes("/") || answers.mode === "models_json"
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
          {catalogError && (
            <Box marginTop={1}>
              <Text color={theme.error}>{catalogError}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Select
              focus
              initial={answers.mode === "hosted" ? 1 : answers.mode === "models_json" ? 2 : 0}
              options={[
                {
                  value: "inline",
                  label: "Inline — an OpenAI-compatible endpoint",
                  hint: "recommended",
                },
                { value: "hosted", label: "A hosted provider from the built-in catalog" },
                { value: "models_json", label: "From a Pi models.json file" },
              ]}
              onSubmit={(v) => {
                const mode = v as "inline" | "models_json" | "hosted";
                setCatalogError(null); // retrying clears any stale failure message
                const enteringHostedFresh = mode === "hosted" && answers.mode !== "hosted";
                patch({
                  mode,
                  // Switching INTO hosted from another mode drops the inline
                  // placeholder key ("1234", defaultAnswers' baseline) —
                  // otherwise a first-time hosted pick would silently write
                  // that placeholder as a literal hosted apiKey. A rerun
                  // that's already hosted (re-submitting the preselected
                  // option unchanged) keeps whatever key it prefilled.
                  apiKey: enteringHostedFresh ? undefined : answers.apiKey,
                });
                // The draft mirrors the same reset: keyDraft init only runs at
                // mount, so without this the fresh-mode "1234" placeholder
                // would linger in the box even after answers.apiKey is
                // cleared above — masked as if a real key were already typed,
                // and an enter-through submit would then patch that literal
                // "1234" back into a hosted config (auth failure on a metered
                // provider), while a paste would append onto it instead of
                // replacing it.
                if (enteringHostedFresh) setKeyDraft("");
                setStep(
                  mode === "inline" ? "url" : mode === "hosted" ? "hostedProvider" : "mjPath",
                );
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
          <Text>
            {answers.mode === "hosted"
              ? `API key for ${hostedProviderName}?`
              : "API key for the endpoint?"}
          </Text>
          <Box borderStyle="round" borderColor={theme.border} paddingX={1} width={46} marginTop={1}>
            <TextField
              value={keyDraft}
              onChange={setKeyDraft}
              onSubmit={() => {
                if (keyDraft.trim() !== "") patch({ apiKey: keyDraft });
                // Hosted has no endpoint to probe (the catalog is embedded SDK
                // data, already validated by construction) — finish directly
                // instead of routing through the inline/models_json probe step.
                if (answers.mode === "hosted") finish(hostedModelId);
                else setStep("probe");
              }}
              focus
              placeholder={
                io.mode === "rerun"
                  ? "unchanged — enter keeps the current key"
                  : answers.mode === "hosted"
                    ? "blank = provider's own env var at runtime"
                    : "1234"
              }
              mask
            />
          </Box>
        </>
      )}
      {step === "probe" && (
        <Text>
          <Spinner /> asking the endpoint for its models…
        </Text>
      )}
      {step === "hostedProvider" &&
        (catalog === null ? (
          <Text>
            <Spinner /> loading the hosted-provider catalog…
          </Text>
        ) : (
          <>
            <Text>Which hosted provider?</Text>
            <Box marginTop={1}>
              <Select
                focus
                initial={Math.max(
                  0,
                  catalog.findIndex((c) => c.provider === splitModelId(answers.modelId).provider),
                )}
                options={catalog.map((c) => ({ value: c.provider, label: c.provider }))}
                onSubmit={(v) => {
                  setHostedProviderName(v);
                  setStep("hostedModel");
                }}
              />
            </Box>
          </>
        ))}
      {step === "hostedModel" &&
        (() => {
          const modelIds = catalog?.find((c) => c.provider === hostedProviderName)?.ids ?? [];
          return (
            <>
              <Text>Which {hostedProviderName} model?</Text>
              <Box marginTop={1}>
                <Select
                  focus
                  initial={Math.max(
                    0,
                    modelIds.findIndex((id) => id === splitModelId(answers.modelId).modelId),
                  )}
                  options={modelIds.map((id) => ({ value: id, label: id }))}
                  onSubmit={(v) => {
                    setHostedModelId(v);
                    setStep("key");
                  }}
                />
              </Box>
            </>
          );
        })()}
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
              initial={Math.max(
                0,
                ids.findIndex(
                  (id) => id === splitModelId(answers.modelId).modelId || id === answers.modelId,
                ),
              )}
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
