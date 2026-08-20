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

/** Matches config.ts's assembleConfig default (an unset dataDir resolves to
 * the canonical `juncoHome` — `~/.junco`, single-root spec 2026-07-16 §4).
 * NOT the same constant as dataMigrateCmd.ts's own DEFAULT_DATA_DIR — that
 * one pins the pre-0.10 legacy root it migrates FROM, deliberately unchanged
 * by the single-root flip. */
const DEFAULT_DATA_DIR = "~/.junco";

export interface WatchedRepoAnswer {
  nwo: string;
  path: string;
}

export interface WizardAnswers {
  dataDir: string;
  mode: "inline" | "models_json" | "hosted";
  modelId: string;
  baseUrl?: string; // inline mode
  apiKey?: string; // inline mode; also hosted mode (literal or "$VAR" ref)
  modelsJson?: string; // models_json mode
  repoRoots: string[];
  github: { enabled: boolean; repos: WatchedRepoAnswer[]; requireApproval: boolean };
  /** Bot-account enable flag only — configDir stays the schema default (YAGNI). */
  botAccount: boolean;
  extras: { sandbox: boolean; verify: boolean; health: boolean; transcripts: boolean };
  /** Harness skills dirs to link (skills.harnessDirs); [] = write no key. */
  harnessDirs: string[];
}

/** Rail order — Welcome is chapter 0; the finale renders after Review. */
export const CHAPTERS = [
  "Welcome",
  "Workspace",
  "Model",
  "Repo safety",
  "GitHub",
  "Account",
  "Extras",
  "Skills",
  "Review",
] as const;

/** Defaults used by `--yes` and as the Enter-through path. The pins
 * (~/.junco, local/my-model, :1234) are asserted by tests and the
 * packaged smoke test — change them only with the spec. */
export function defaultAnswers(): WizardAnswers {
  return {
    dataDir: DEFAULT_DATA_DIR,
    mode: "inline",
    modelId: "local/my-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "1234",
    repoRoots: [],
    github: { enabled: false, repos: [], requireApproval: true },
    botAccount: false,
    extras: { sandbox: true, verify: true, health: true, transcripts: true },
    // The `--yes` path links nothing — consent needs an interactive choice.
    harnessDirs: [],
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
  // Never write vaultRoot/juncoSubdir (legacy, deprecated) — dataDir only
  // materializes when it differs from the schema default, so a fully-default
  // fresh config carries no path keys at all (never born deprecated).
  const obj: Record<string, unknown> = { model };
  if (a.dataDir !== DEFAULT_DATA_DIR) obj.dataDir = a.dataDir;

  if (a.repoRoots.length > 0) obj.git = { allowedRepoRoots: a.repoRoots };
  if (a.github.enabled) {
    obj.github = {
      enabled: true,
      repos: a.github.repos,
      requireApproval: a.github.requireApproval,
    };
  }
  if (a.botAccount) obj.botAccount = { enabled: true };
  if (!a.extras.sandbox) obj.sandbox = { enabled: false };
  if (!a.extras.verify) obj.verify = { enabled: false };
  const obs: Record<string, unknown> = {};
  if (!a.extras.health) obs.healthEnabled = false;
  if (!a.extras.transcripts) obs.transcripts = false;
  if (Object.keys(obs).length > 0) obj.observability = obs;
  if (a.harnessDirs.length > 0) obj.skills = { harnessDirs: a.harnessDirs };
  return obj;
}

/** Pure — output must round-trip through loadConfig. A dataDir left at the
 * schema default writes no path key at all — the queue then resolves to
 * <dataDir>/queue (config.ts's assembleConfig). */
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
    // undefined when at the default: an untouched rerun never materializes a
    // dataDir key, and a legacy vaultRoot config's rerun never gets one
    // spuriously added either — see answersFromConfig's doc comment and the
    // "legacy vaultRoot rerun" describe block in wizardFlow.test.ts.
    { path: "dataDir", value: a.dataDir === DEFAULT_DATA_DIR ? undefined : a.dataDir },
    { path: "model.id", value: a.modelId },
    ...model,
    { path: "git.allowedRepoRoots", value: a.repoRoots },
    { path: "github.enabled", value: a.github.enabled },
    { path: "github.repos", value: a.github.repos },
    { path: "github.requireApproval", value: a.github.requireApproval },
    { path: "botAccount.enabled", value: a.botAccount },
    { path: "sandbox.enabled", value: a.extras.sandbox },
    { path: "verify.enabled", value: a.extras.verify },
    { path: "observability.healthEnabled", value: a.extras.health },
    { path: "observability.transcripts", value: a.extras.transcripts },
    { path: "skills.harnessDirs", value: a.harnessDirs },
  ];
}

/** Number of lever paths the walkthrough covers — kept derived so the Review
 * chapter's "N more levers keep their safe defaults" count can never drift
 * from coveredPaths(). The count is mode-independent (the model trio is
 * always three entries). */
export const COVERED_LEVER_COUNT = coveredPaths(defaultAnswers()).length;

/** Prefill answers from a raw parsed config.json (re-run mode). Missing keys
 * fall back to the schema defaults the fresh wizard uses. A legacy config's
 * `vaultRoot` is deliberately NOT prefilled into `dataDir` — the wizard must
 * never treat a legacy path override as if it were the unified data root, and
 * an untouched rerun over such a config must stay a true no-op (never
 * deleting the user's vaultRoot behind their back). Migrating a legacy config
 * onto dataDir is `junco data migrate`'s job, not the wizard's. */
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
    // The write-side sentinel only — literally the raw key or the schema
    // default ("~/.junco"), NEVER filesystem-probed. This module is pure/
    // no-IO by design (see the module comment), so it cannot know whether an
    // unset key will actually resolve to the legacy ~/.local/state/junco
    // root on THIS machine (assembleConfig's single-root probe,
    // config.ts's resolveDataRoot) — showing that requires IO. The
    // IO-aware layer (wizard.ts's buildWizardIO) computes the EFFECTIVE
    // root separately via resolveDataRoot and exposes it as
    // WizardIO.effectiveDataDir for the Workspace chapter to display
    // alongside this field; this field itself must stay untouched or a
    // wizard save on a legacy-fallback machine would start writing an
    // explicit dataDir key (pinning the legacy root and fighting `junco
    // data migrate`) even when the user never typed one.
    dataDir: (g("dataDir") as string) ?? d.dataDir,
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
    botAccount: (g("botAccount.enabled") as boolean) ?? false,
    extras: {
      sandbox: (g("sandbox.enabled") as boolean) ?? d.extras.sandbox,
      verify: (g("verify.enabled") as boolean) ?? d.extras.verify,
      health: (g("observability.healthEnabled") as boolean) ?? d.extras.health,
      transcripts: (g("observability.transcripts") as boolean) ?? d.extras.transcripts,
    },
    harnessDirs: (g("skills.harnessDirs") as string[]) ?? [],
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
