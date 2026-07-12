/**
 * Pure wizard flow engine: the answer model, chapter order, and the two
 * config-write shapes (fresh minimal object here; re-run diff/apply in this
 * file too — see answersFromConfig/diffAnswers/applyAnswers). No Ink, no IO —
 * everything is unit-testable without a TTY. renderConfigJson output must
 * always round-trip through loadConfig (tests/wizardFlow.test.ts pins this).
 */

import { getAtPath, setAtPath } from "../configLevers.js";

/** Repeated across buildConfigObject/coveredPaths for models_json mode. */
const DEFAULT_MODELS_JSON = "~/.pi/agent/models.json";

export interface WatchedRepoAnswer {
  nwo: string;
  path: string;
}

export interface WizardAnswers {
  vaultRoot: string;
  mode: "inline" | "models_json" | "hosted";
  modelId: string;
  baseUrl?: string; // inline mode
  apiKey?: string; // inline mode; also hosted mode (literal or "$VAR" ref)
  modelsJson?: string; // models_json mode
  repoRoots: string[];
  github: { enabled: boolean; repos: WatchedRepoAnswer[]; requireApproval: boolean };
  extras: { sandbox: boolean; verify: boolean; health: boolean; transcripts: boolean };
}

/** Rail order — Welcome is chapter 0; the finale renders after Review. */
export const CHAPTERS = [
  "Welcome",
  "Workspace",
  "Model",
  "Repo safety",
  "GitHub",
  "Extras",
  "Review",
] as const;

/** Defaults used by `--yes` and as the Enter-through path. The model pins
 * (~/Junco, local/my-model, :1234) are asserted by tests and the packaged
 * smoke test — change them only with the spec. */
export function defaultAnswers(): WizardAnswers {
  return {
    vaultRoot: "~/Junco",
    mode: "inline",
    modelId: "local/my-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "1234",
    repoRoots: [],
    github: { enabled: false, repos: [], requireApproval: true },
    extras: { sandbox: true, verify: true, health: true, transcripts: true },
  };
}

/** Fresh-mode config: minimal — required fields plus only answers that differ
 * from schema defaults, so the file stays small and hand-editable. */
export function buildConfigObject(a: WizardAnswers): Record<string, unknown> {
  const d = defaultAnswers();
  const model: Record<string, unknown> = { id: a.modelId };
  if (a.mode === "models_json") {
    model.modelsJson = a.modelsJson ?? DEFAULT_MODELS_JSON;
  } else if (a.mode === "hosted") {
    // Catalog-eligible by construction: no baseUrl key at all (an explicit
    // baseUrl — even the localhost default — flips catalogEligible/
    // assembleConfig to inline resolution, see agent/modelSetup.ts) and no
    // source key (unset "auto" already resolves to catalog for a non-local
    // provider prefix with no explicit baseUrl). apiKey is omitted entirely
    // when the user left it blank so the SDK falls back to the provider's
    // own env var at request time; a pasted literal or "$VAR" ref is kept.
    if (a.apiKey) model.apiKey = a.apiKey;
  } else {
    model.baseUrl = a.baseUrl ?? d.baseUrl!;
    // apiKey fallback stays "" — NOT d.apiKey ("1234", the wizard's inline
    // placeholder credential). A fresh config with no key entered should
    // write an empty string; consolidating this one would change behavior.
    model.apiKey = a.apiKey ?? "";
  }
  const obj: Record<string, unknown> = { vaultRoot: a.vaultRoot, juncoSubdir: "", model };

  if (a.repoRoots.length > 0) obj.git = { allowedRepoRoots: a.repoRoots };
  if (a.github.enabled) {
    obj.github = {
      enabled: true,
      repos: a.github.repos,
      requireApproval: a.github.requireApproval,
    };
  }
  if (!a.extras.sandbox) obj.sandbox = { enabled: false };
  if (!a.extras.verify) obj.verify = { enabled: false };
  const obs: Record<string, unknown> = {};
  if (!a.extras.health) obs.healthEnabled = false;
  if (!a.extras.transcripts) obs.transcripts = false;
  if (Object.keys(obs).length > 0) obj.observability = obs;
  return obj;
}

/** Pure — output must round-trip through loadConfig. juncoSubdir:"" keeps the
 * queue directly under vaultRoot (today's wizard behavior). */
export function renderConfigJson(a: WizardAnswers): string {
  return JSON.stringify(buildConfigObject(a), null, 2) + "\n";
}

/** The dotted lever paths the wizard covers. diff/apply operate ONLY on these,
 * which is what makes re-run writes preserving: everything else in the raw
 * object is never touched. */
function coveredPaths(a: WizardAnswers): { path: string; value: unknown }[] {
  const d = defaultAnswers();
  const model: { path: string; value: unknown }[] =
    a.mode === "models_json"
      ? [
          { path: "model.modelsJson", value: a.modelsJson ?? DEFAULT_MODELS_JSON },
          { path: "model.baseUrl", value: undefined },
          { path: "model.apiKey", value: undefined },
        ]
      : a.mode === "hosted"
        ? [
            { path: "model.modelsJson", value: undefined },
            // Always undefined — a hosted rerun must never write a baseUrl,
            // even the localhost default, or the config stops being
            // catalog-eligible (assembleConfig treats a present key as an
            // explicit override, see agent/modelSetup.ts:catalogEligible).
            { path: "model.baseUrl", value: undefined },
            // Only a real value when the user actually set one; blank never
            // materializes a placeholder key, so an untouched rerun is a
            // true no-op diff.
            { path: "model.apiKey", value: a.apiKey || undefined },
          ]
        : [
            { path: "model.modelsJson", value: undefined },
            { path: "model.baseUrl", value: a.baseUrl ?? d.baseUrl! },
            // apiKey fallback stays "" (see buildConfigObject) — not d.apiKey.
            { path: "model.apiKey", value: a.apiKey ?? "" },
          ];
  return [
    { path: "vaultRoot", value: a.vaultRoot },
    { path: "model.id", value: a.modelId },
    ...model,
    { path: "git.allowedRepoRoots", value: a.repoRoots },
    { path: "github.enabled", value: a.github.enabled },
    { path: "github.repos", value: a.github.repos },
    { path: "github.requireApproval", value: a.github.requireApproval },
    { path: "sandbox.enabled", value: a.extras.sandbox },
    { path: "verify.enabled", value: a.extras.verify },
    { path: "observability.healthEnabled", value: a.extras.health },
    { path: "observability.transcripts", value: a.extras.transcripts },
  ];
}

/** Number of lever paths the walkthrough covers — kept derived so the Review
 * chapter's "N more levers keep their safe defaults" count can never drift
 * from coveredPaths(). The count is mode-independent (the model trio is
 * always three entries). */
export const COVERED_LEVER_COUNT = coveredPaths(defaultAnswers()).length;

/** Prefill answers from a raw parsed config.json (re-run mode). Missing keys
 * fall back to the schema defaults the fresh wizard uses. */
export function answersFromConfig(raw: Record<string, unknown>): WizardAnswers {
  const d = defaultAnswers();
  const g = (p: string): unknown => getAtPath(raw, p);
  // Raw-key presence, not resolved Config: a hosted config has neither a
  // modelsJson path nor an explicit baseUrl key. Checking presence here
  // (rather than inferring "inline" as the catch-all default) is the fix for
  // the trap this task exists to avoid — see flow.ts's module comment and
  // the brief: misclassifying a hosted config as inline on rerun would
  // prefill the localhost baseUrl and destroy catalog eligibility on write.
  const hasModelsJson = typeof g("model.modelsJson") === "string";
  const hasBaseUrl = g("model.baseUrl") !== undefined;
  const mode: WizardAnswers["mode"] = hasModelsJson
    ? "models_json"
    : hasBaseUrl
      ? "inline"
      : "hosted";
  return {
    vaultRoot: (g("vaultRoot") as string) ?? d.vaultRoot,
    mode,
    modelId: (g("model.id") as string) ?? d.modelId,
    // Hosted mode never prefills the localhost baseUrl default — that would
    // reintroduce the exact trap this task fixes on the next rerun.
    baseUrl: mode === "hosted" ? undefined : ((g("model.baseUrl") as string) ?? d.baseUrl),
    // Hosted mode never falls back to d.apiKey ("1234", the inline
    // placeholder) — a hosted config with no key is deliberate env-var
    // deferral, not a blank inline field.
    apiKey:
      mode === "hosted"
        ? (g("model.apiKey") as string | undefined)
        : ((g("model.apiKey") as string) ?? d.apiKey),
    modelsJson: g("model.modelsJson") as string | undefined,
    repoRoots: (g("git.allowedRepoRoots") as string[]) ?? [],
    github: {
      enabled: (g("github.enabled") as boolean) ?? d.github.enabled,
      repos: (g("github.repos") as WatchedRepoAnswer[]) ?? d.github.repos,
      requireApproval: (g("github.requireApproval") as boolean) ?? d.github.requireApproval,
    },
    extras: {
      sandbox: (g("sandbox.enabled") as boolean) ?? d.extras.sandbox,
      verify: (g("verify.enabled") as boolean) ?? d.extras.verify,
      health: (g("observability.healthEnabled") as boolean) ?? d.extras.health,
      transcripts: (g("observability.transcripts") as boolean) ?? d.extras.transcripts,
    },
  };
}

export interface AnswerDiff {
  path: string;
  from: unknown;
  to: unknown;
}

/** Changed covered paths only (deep-equal via JSON — values here are small
 * scalars/arrays). An absent key counts as changed only if the new value is
 * defined and differs. */
export function diffAnswers(raw: Record<string, unknown>, a: WizardAnswers): AnswerDiff[] {
  const original = answersFromConfig(raw);
  const originalCovered = new Map(coveredPaths(original).map(({ path, value }) => [path, value]));
  const out: AnswerDiff[] = [];
  for (const { path, value } of coveredPaths(a)) {
    const origValue = originalCovered.get(path);
    if (JSON.stringify(origValue) !== JSON.stringify(value)) {
      const cur = getAtPath(raw, path);
      out.push({ path, from: cur, to: value });
    }
  }
  return out;
}

/** Re-run write shape: clone the raw object and setAtPath ONLY the changed
 * lever paths — every key the wizard doesn't cover is preserved verbatim.
 * `undefined` values are dropped by JSON.stringify at write time (that is how
 * a mode switch clears model.modelsJson / the inline fields). */
export function applyAnswers(
  raw: Record<string, unknown>,
  a: WizardAnswers,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  for (const { path, from, to } of diffAnswers(raw, a)) {
    void from;
    setAtPath(clone, path, to);
  }
  return JSON.parse(JSON.stringify(clone)) as Record<string, unknown>; // drop undefineds
}
