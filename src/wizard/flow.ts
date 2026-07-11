/**
 * Pure wizard flow engine: the answer model, chapter order, and the two
 * config-write shapes (fresh minimal object here; re-run diff/apply in this
 * file too — see answersFromConfig/diffAnswers/applyAnswers). No Ink, no IO —
 * everything is unit-testable without a TTY. renderConfigJson output must
 * always round-trip through loadConfig (tests/wizardFlow.test.ts pins this).
 */

import { getAtPath, setAtPath } from "../configLevers.js";

export interface WatchedRepoAnswer {
  nwo: string;
  path: string;
}

export interface WizardAnswers {
  vaultRoot: string;
  mode: "inline" | "models_json";
  modelId: string;
  baseUrl?: string; // inline mode
  apiKey?: string; // inline mode
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
  const model: Record<string, unknown> = { id: a.modelId };
  if (a.mode === "models_json") {
    model.modelsJson = a.modelsJson ?? "~/.pi/agent/models.json";
  } else {
    model.baseUrl = a.baseUrl ?? "http://127.0.0.1:1234/v1";
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
  const model: { path: string; value: unknown }[] =
    a.mode === "models_json"
      ? [
          { path: "model.modelsJson", value: a.modelsJson ?? "~/.pi/agent/models.json" },
          { path: "model.baseUrl", value: undefined },
          { path: "model.apiKey", value: undefined },
        ]
      : [
          { path: "model.modelsJson", value: undefined },
          { path: "model.baseUrl", value: a.baseUrl ?? "http://127.0.0.1:1234/v1" },
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

/** Prefill answers from a raw parsed config.json (re-run mode). Missing keys
 * fall back to the schema defaults the fresh wizard uses. */
export function answersFromConfig(raw: Record<string, unknown>): WizardAnswers {
  const d = defaultAnswers();
  const g = (p: string): unknown => getAtPath(raw, p);
  const mode = typeof g("model.modelsJson") === "string" ? "models_json" : "inline";
  return {
    vaultRoot: (g("vaultRoot") as string) ?? d.vaultRoot,
    mode,
    modelId: (g("model.id") as string) ?? d.modelId,
    baseUrl: (g("model.baseUrl") as string) ?? d.baseUrl,
    apiKey: (g("model.apiKey") as string) ?? d.apiKey,
    modelsJson: g("model.modelsJson") as string | undefined,
    repoRoots: (g("git.allowedRepoRoots") as string[]) ?? [],
    github: {
      enabled: (g("github.enabled") as boolean) ?? false,
      repos: (g("github.repos") as WatchedRepoAnswer[]) ?? [],
      requireApproval: (g("github.requireApproval") as boolean) ?? true,
    },
    extras: {
      sandbox: (g("sandbox.enabled") as boolean) ?? true,
      verify: (g("verify.enabled") as boolean) ?? true,
      health: (g("observability.healthEnabled") as boolean) ?? true,
      transcripts: (g("observability.transcripts") as boolean) ?? true,
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
