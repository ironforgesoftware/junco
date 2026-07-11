/**
 * Pure wizard flow engine: the answer model, chapter order, and the two
 * config-write shapes (fresh minimal object here; re-run diff/apply in this
 * file too — see answersFromConfig/diffAnswers/applyAnswers). No Ink, no IO —
 * everything is unit-testable without a TTY. renderConfigJson output must
 * always round-trip through loadConfig (tests/wizardFlow.test.ts pins this).
 */

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
