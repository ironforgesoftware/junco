# Setup-Wizard Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `junco init` a colorized clack TUI that discovers models from the endpoint, drops the redundant `/Junco` subfolder, cancels gracefully, and ships no personal-stack strings.

**Architecture:** A thin injectable `Prompter` interface (clack in prod, scripted in tests) replaces the `AskFn` string-Q&A seam. A small `src/wizard/models.ts` adds `inferProvider`/`fetchModels`/`parseModelsJson`. `renderConfigToml` writes `junco_subdir = ""`; the schema default stays `"Junco"` for back-compat. Ships as v0.2.2. **HOLD: no push/tag/release/publish until the maintainer approves.**

**Tech Stack:** Node ≥22.19, TypeScript NodeNext, `@clack/prompts@1.5.0`, vitest.

**Spec:** `docs/superpowers/specs/2026-06-01-wizard-deepening-design.md`

---

## File structure

- **Create** `src/wizard/models.ts` — `inferProvider(baseUrl)`, `fetchModels(baseUrl, apiKey, deps)`, `parseModelsJson(path)`. Pure-ish, fetch injectable, never throws.
- **Create** `src/wizard/prompter.ts` — `Prompter` interface, `SelectOption`, `WizardCancelled`, `clackPrompter()`.
- **Modify** `src/wizard.ts` — `renderConfigToml` (`junco_subdir=""`, de-personalized comments), `defaultAnswers` (`~/Junco`, `local/my-model`), `collectAnswers(prompter, deps)` (select + spinner + manual fallback + provider inference), `runInitWizard` (clack default, cancel → 130). Remove `AskFn`.
- **Modify** `src/config.ts` — `export` `expandHome`.
- **Modify** `src/cli.ts` — drop `askFn`/`AskFn`; non-TTY guard no longer references `askFn`; `runInitWizard` call drops `ask`.
- **Modify** `tests/wizard.test.ts` — `scriptedPrompter` helper; new select/fetch/cancel/inferProvider/parseModelsJson/fetchModels tests; update defaults (`~/Junco`, `local/my-model`) + assert `junco_subdir=""`.
- **Create** `tests/wizardModels.test.ts` — `inferProvider`, `fetchModels`, `parseModelsJson`.
- **Modify** `package.json` — add dep, bump to 0.2.2. **Modify** `CHANGELOG.md`, `README.md`.

---

### Task 1: Export `expandHome`

**Files:** Modify `src/config.ts:10`

- [ ] **Step 1:** Change `function expandHome(` → `export function expandHome(`.
- [ ] **Step 2:** Build: `npx tsc -p tsconfig.json` → clean.
- [ ] **Step 3:** Commit.

```bash
git add src/config.ts && git commit -m "refactor(config): export expandHome for wizard reuse"
```

---

### Task 2: `src/wizard/models.ts` — provider inference + model discovery

**Files:** Create `src/wizard/models.ts`, `tests/wizardModels.test.ts`

- [ ] **Step 1: Write failing tests** `tests/wizardModels.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { inferProvider, fetchModels, parseModelsJson } from "../src/wizard/models.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("inferProvider", () => {
  it.each([
    ["https://api.openai.com/v1", "openai"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://api.anthropic.com/v1", "anthropic"],
    ["http://127.0.0.1:1234/v1", "local"],
    ["http://localhost:1234/v1", "local"],
    ["https://api.together.xyz/v1", "together"],
    ["https://my-llm.fly.dev/v1", "fly"],
    ["not a url", "custom"],
  ])("%s → %s", (url, want) => expect(inferProvider(url)).toBe(want));
});

describe("fetchModels", () => {
  const ok = (ids: string[]) => async () =>
    ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) }) as Response;

  it("parses data[].id and sends Bearer auth to <base>/models", async () => {
    let seenUrl = "",
      seenAuth = "";
    const fetchFn = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init.headers as Record<string, string>).Authorization);
      return { ok: true, json: async () => ({ data: [{ id: "m-a" }, { id: "m-b" }] }) } as Response;
    }) as unknown as typeof fetch;
    const ids = await fetchModels("http://h:1/v1", "sk-x", { fetchFn });
    expect(ids).toEqual(["m-a", "m-b"]);
    expect(seenUrl).toBe("http://h:1/v1/models");
    expect(seenAuth).toBe("Bearer sk-x");
  });

  it("returns [] on non-200", async () => {
    const fetchFn = (async () => ({ ok: false }) as Response) as unknown as typeof fetch;
    expect(await fetchModels("http://h/v1", "k", { fetchFn })).toEqual([]);
  });

  it("returns [] when fetch throws", async () => {
    const fetchFn = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await fetchModels("http://h/v1", "k", { fetchFn })).toEqual([]);
  });

  it("returns [] on timeout", async () => {
    const fetchFn = (async (_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(await fetchModels("http://h/v1", "k", { fetchFn, timeoutMs: 5 })).toEqual([]);
  });
});

describe("parseModelsJson", () => {
  it("lists provider/model for every entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-mj-"));
    const p = join(dir, "models.json");
    writeFileSync(
      p,
      JSON.stringify({
        providers: {
          omlx: { models: [{ id: "alpha" }, { id: "beta" }] },
          openai: { models: [{ id: "gpt-x" }] },
        },
      }),
    );
    expect(parseModelsJson(p).sort()).toEqual(["omlx/alpha", "omlx/beta", "openai/gpt-x"].sort());
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns [] for a missing/invalid file", () => {
    expect(parseModelsJson("/no/such/models.json")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail** `npx vitest run tests/wizardModels.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/wizard/models.ts`

```ts
/**
 * Model discovery for the setup wizard: infer a provider label from an endpoint,
 * list a server's models (OpenAI-compatible /models), and list a Pi models.json's
 * entries. All best-effort and non-throwing so the wizard can fall back to manual.
 */
import { existsSync, readFileSync } from "node:fs";
import { apiBaseUrl } from "../agent/modelSetup.js";

/** Best-effort provider label from an endpoint URL (just an internal registry label). */
export function inferProvider(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "custom";
  }
  const known: Record<string, string> = {
    "api.openai.com": "openai",
    "openrouter.ai": "openrouter",
    "api.anthropic.com": "anthropic",
    "generativelanguage.googleapis.com": "google",
    "api.groq.com": "groq",
    "api.mistral.ai": "mistral",
    "api.deepseek.com": "deepseek",
  };
  if (known[host]) return known[host];
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host.endsWith(".local"))
    return "local";
  const labels = host
    .replace(/^api\./, "")
    .split(".")
    .filter(Boolean);
  if (labels.length >= 2) return labels[labels.length - 2];
  if (labels.length === 1) return labels[0];
  return "custom";
}

export interface FetchModelsDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** GET <base>/models (Bearer auth) → OpenAI-style data[].id. [] on any error/empty. */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  deps: FetchModelsDeps = {},
): Promise<string[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const url = `${apiBaseUrl(baseUrl).replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const body = (await resp.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body?.data)) return [];
    return body.data
      .map((m) => (typeof m?.id === "string" ? m.id : null))
      .filter((x): x is string => !!x);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** List "<provider>/<modelId>" for every model in a Pi models.json. [] if unreadable. */
export function parseModelsJson(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      providers?: Record<string, { models?: Array<{ id?: unknown }> }>;
    };
    const out: string[] = [];
    for (const [provider, p] of Object.entries(data.providers ?? {}))
      for (const m of p.models ?? [])
        if (typeof m?.id === "string") out.push(`${provider}/${m.id}`);
    return out;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run, verify pass** `npx vitest run tests/wizardModels.test.ts` → PASS.
- [ ] **Step 5: Commit** `git add src/wizard/models.ts tests/wizardModels.test.ts && git commit -m "feat(wizard): model discovery — inferProvider, fetchModels, parseModelsJson"`

---

### Task 3: `@clack/prompts` dep + `src/wizard/prompter.ts`

**Files:** Modify `package.json`; Create `src/wizard/prompter.ts`

- [ ] **Step 1: Add the dep (exact pin)** `npm install --save-exact @clack/prompts@1.5.0` → updates `package.json` + `package-lock.json`. Verify `dependencies["@clack/prompts"] === "1.5.0"`.

- [ ] **Step 2: Implement** `src/wizard/prompter.ts`

```ts
/**
 * Prompt seam for the setup wizard. Production impl wraps @clack/prompts (colored,
 * boxed, arrow-key select, spinner); tests inject a scripted Prompter. Centralizes
 * cancel handling: any Ctrl-C/Ctrl-D throws WizardCancelled (caught by runInitWizard).
 */
import * as clack from "@clack/prompts";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface Prompter {
  intro(title: string): void;
  note(msg: string, title?: string): void;
  text(opts: { message: string; default?: string; placeholder?: string }): Promise<string>;
  select(opts: { message: string; options: SelectOption[]; initial?: string }): Promise<string>;
  spinner<T>(start: string, task: () => Promise<T>, stop: (r: T) => string): Promise<T>;
}

export class WizardCancelled extends Error {
  constructor() {
    super("Setup cancelled");
    this.name = "WizardCancelled";
  }
}

export function clackPrompter(): Prompter {
  return {
    intro: (t) => clack.intro(t),
    note: (m, title) => clack.note(m, title),
    async text(opts) {
      const r = await clack.text({
        message: opts.message,
        placeholder: opts.placeholder ?? opts.default,
        defaultValue: opts.default,
      });
      if (clack.isCancel(r)) {
        clack.cancel("Setup cancelled.");
        throw new WizardCancelled();
      }
      return (r as string) || (opts.default ?? "");
    },
    async select(opts) {
      const r = await clack.select({
        message: opts.message,
        options: opts.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
        initialValue: opts.initial,
      });
      if (clack.isCancel(r)) {
        clack.cancel("Setup cancelled.");
        throw new WizardCancelled();
      }
      return r as string;
    },
    async spinner(start, task, stop) {
      const s = clack.spinner();
      s.start(start);
      try {
        const res = await task();
        s.stop(stop(res));
        return res;
      } catch (e) {
        s.stop("failed");
        throw e;
      }
    },
  };
}
```

- [ ] **Step 3: Build** `npx tsc -p tsconfig.json` → clean (confirms clack types resolve).
- [ ] **Step 4: Commit** `git add package.json package-lock.json src/wizard/prompter.ts && git commit -m "feat(wizard): add @clack/prompts@1.5.0 + Prompter seam"`

---

### Task 4: Refactor `src/wizard.ts` pure pieces (config render + defaults)

**Files:** Modify `src/wizard.ts`; Modify `tests/wizard.test.ts` (render + defaults)

- [ ] **Step 1: Update the round-trip + defaults tests** in `tests/wizard.test.ts` — replace the inline render test's expectations to also assert no `/Junco` and `junco_subdir=""`, and update `defaultAnswers`/all-defaults expectations:

```ts
// in "renderConfigToml" describe, add to the inline test:
expect(cfg.juncoSubdir).toBe("");
expect(queuePaths(cfg).inbox.endsWith("/jv/inbox")).toBe(true); // no /Junco segment
```

```ts
// replace defaultAnswers usage: defaultAnswers() now returns ~/Junco + local/my-model
import { defaultAnswers } from "../src/wizard.js";
it("defaultAnswers → ~/Junco + neutral model", () => {
  expect(defaultAnswers()).toEqual({
    vaultRoot: "~/Junco",
    mode: "inline",
    modelId: "local/my-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "1234",
  });
});
```

- [ ] **Step 2: Run, verify fail** `npx vitest run tests/wizard.test.ts` → FAIL (old defaults / no junco_subdir).

- [ ] **Step 3: Implement** — in `src/wizard.ts` update `renderConfigToml` + `defaultAnswers`:

```ts
export function renderConfigToml(a: WizardAnswers): string {
  const lines: string[] = [
    "# Junco configuration — generated by `junco init`.",
    "# Full reference + all options: https://github.com/ironforgesoftware/junco#configuration",
    "",
    `vault_root = ${tomlStr(a.vaultRoot)}   # queue lives at <vault_root>/{inbox,processing,done,failed}`,
    `junco_subdir = ""   # tickets live directly under vault_root`,
    "",
    "[model]",
    `id = ${tomlStr(a.modelId)}   # provider-prefixed model id`,
  ];
  if (a.mode === "models_json") {
    lines.push(
      `models_json = ${tomlStr(a.modelsJson ?? "~/.pi/agent/models.json")}   # provider+model loaded from this models.json`,
    );
  } else {
    lines.push(
      `base_url = ${tomlStr(a.baseUrl ?? "http://127.0.0.1:1234/v1")}   # any OpenAI-compatible /v1 endpoint`,
      `api_key = ${tomlStr(a.apiKey ?? "")}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function defaultAnswers(): WizardAnswers {
  return {
    vaultRoot: "~/Junco",
    mode: "inline",
    modelId: "local/my-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "1234",
  };
}
```

- [ ] **Step 4: Run, verify pass** `npx vitest run tests/wizard.test.ts` (render + defaults groups) → PASS.
- [ ] **Step 5: Commit** `git add src/wizard.ts tests/wizard.test.ts && git commit -m "feat(wizard): write junco_subdir=\"\" + de-personalized defaults (~/Junco)"`

---

### Task 5: `collectAnswers` over the `Prompter` (select + spinner + manual + inference)

**Files:** Modify `src/wizard.ts`; Modify `tests/wizard.test.ts` (collectAnswers group)

- [ ] **Step 1: Replace the collectAnswers tests** with a `scriptedPrompter` helper + select/manual/inference cases:

```ts
import type { Prompter } from "../src/wizard/prompter.js";
import { WizardCancelled } from "../src/wizard/prompter.js";

function scriptedPrompter(a: { text?: string[]; select?: string[] } = {}): Prompter {
  const text = [...(a.text ?? [])];
  const select = [...(a.select ?? [])];
  const rec = { intros: [] as string[], notes: [] as string[] };
  const p: Prompter & { rec: typeof rec } = {
    rec,
    intro: (t) => {
      rec.intros.push(t);
    },
    note: (m) => {
      rec.notes.push(m);
    },
    async text(o) {
      return text.length ? text.shift()! : (o.default ?? "");
    },
    async select(o) {
      return select.length ? select.shift()! : o.options[0].value;
    },
    async spinner(_s, task) {
      return task();
    },
  };
  return p;
}

describe("collectAnswers", () => {
  it("inline: picks a fetched model, no provider prefix needed when id has none", async () => {
    const p = scriptedPrompter({
      text: ["~/v", "http://127.0.0.1:1234/v1", "secret"],
      select: ["inline", "m-fast"],
    });
    const a = await collectAnswers(p, { fetchModelsFn: async () => ["m-fast", "m-slow"] });
    expect(a).toEqual({
      vaultRoot: "~/v",
      mode: "inline",
      modelId: "local/m-fast",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "secret",
    });
  });

  it("inline: manual entry keeps a slash-containing id unprefixed", async () => {
    const p = scriptedPrompter({
      text: ["~/v", "https://openrouter.ai/api/v1", "k", "anthropic/claude"],
      select: ["inline", " manual"],
    });
    const a = await collectAnswers(p, { fetchModelsFn: async () => ["x"] });
    expect(a.modelId).toBe("anthropic/claude"); // already has "/", not re-prefixed
  });

  it("inline: empty fetch falls straight to a manual prompt, prefixed by inferred provider", async () => {
    const p = scriptedPrompter({
      text: ["~/v", "https://api.openai.com/v1", "k", "gpt-z"],
      select: ["inline"],
    });
    const a = await collectAnswers(p, { fetchModelsFn: async () => [] });
    expect(a.modelId).toBe("openai/gpt-z");
  });

  it("models_json: lists file entries", async () => {
    const p = scriptedPrompter({
      text: ["~/v", "~/m.json"],
      select: ["models_json", "omlx/alpha"],
    });
    const a = await collectAnswers(p, { parseModelsJsonFn: () => ["omlx/alpha", "omlx/beta"] });
    expect(a).toEqual({
      vaultRoot: "~/v",
      mode: "models_json",
      modelId: "omlx/alpha",
      modelsJson: "~/m.json",
    });
  });
});
```

(Note the manual sentinel is `" manual"`.)

- [ ] **Step 2: Run, verify fail** → FAIL (collectAnswers still has old `AskFn` signature).

- [ ] **Step 3: Implement** — rewrite the top of `src/wizard.ts`: drop `AskFn` + readline; import the prompter + models helpers + `expandHome`; new `collectAnswers`:

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Config } from "./types.js";
import { loadConfig, queuePaths, expandHome } from "./config.js";
import { type Prompter, WizardCancelled, clackPrompter } from "./wizard/prompter.js";
import { fetchModels, parseModelsJson, inferProvider } from "./wizard/models.js";

const MANUAL = " manual"; // select sentinel for "enter manually"

export interface WizardAnswers {
  vaultRoot: string;
  mode: "inline" | "models_json";
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  modelsJson?: string;
}

export interface CollectDeps {
  fetchModelsFn?: typeof fetchModels;
  parseModelsJsonFn?: typeof parseModelsJson;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Show fetched ids as a select (+ manual escape hatch); empty list → manual prompt. */
async function pickModel(p: Prompter, ids: string[]): Promise<string> {
  if (ids.length > 0) {
    const choice = await p.select({
      message: "Select a model",
      options: [
        ...ids.map((id) => ({ value: id, label: id })),
        { value: MANUAL, label: "✏️  Enter manually…" },
      ],
    });
    if (choice !== MANUAL) return choice;
  }
  return p.text({ message: "Model id?", default: "my-model" });
}

export async function collectAnswers(p: Prompter, deps: CollectDeps = {}): Promise<WizardAnswers> {
  const fetchModelsFn = deps.fetchModelsFn ?? fetchModels;
  const parseModelsJsonFn = deps.parseModelsJsonFn ?? parseModelsJson;

  p.intro("junco init");
  const vaultRoot = await p.text({
    message: "Where should Junco keep its tickets?",
    default: "~/Junco",
  });
  const mode = (await p.select({
    message: "How is the model configured?",
    options: [
      { value: "inline", label: "Inline — an OpenAI-compatible endpoint" },
      { value: "models_json", label: "From a Pi models.json file" },
    ],
  })) as WizardAnswers["mode"];

  if (mode === "models_json") {
    const modelsJson = await p.text({
      message: "Path to your Pi models.json?",
      default: "~/.pi/agent/models.json",
    });
    const ids = parseModelsJsonFn(expandHome(modelsJson));
    const modelId = await pickModel(p, ids);
    return { vaultRoot, mode, modelId, modelsJson };
  }

  const baseUrl = await p.text({
    message: "Inference endpoint base URL (OpenAI-compatible)?",
    default: "http://127.0.0.1:1234/v1",
  });
  const apiKey = await p.text({ message: "API key for the endpoint?", default: "1234" });
  const ids = await p.spinner(
    `Fetching models from ${hostOf(baseUrl)}…`,
    () => fetchModelsFn(baseUrl, apiKey),
    (r) => `${r.length} model${r.length === 1 ? "" : "s"} found`,
  );
  const picked = await pickModel(p, ids);
  const modelId = picked.includes("/") ? picked : `${inferProvider(baseUrl)}/${picked}`;
  return { vaultRoot, mode, modelId, baseUrl, apiKey };
}
```

- [ ] **Step 4: Run, verify pass** `npx vitest run tests/wizard.test.ts` (collectAnswers group) → PASS.
- [ ] **Step 5: Commit** `git add src/wizard.ts tests/wizard.test.ts && git commit -m "feat(wizard): collectAnswers over Prompter — model select + spinner + manual + inference"`

---

### Task 6: `runInitWizard` — clack default + graceful cancel

**Files:** Modify `src/wizard.ts`; Modify `tests/wizard.test.ts` (runInitWizard group)

- [ ] **Step 1: Update the runInitWizard tests** to use `scriptedPrompter` and add a cancel case:

```ts
describe("runInitWizard", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("writes config + requests the queue dirs", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-wiz-run-"));
    const cfgPath = join(dir, "config.toml");
    const printed: string[] = [];
    const made: string[] = [];
    const code = await runInitWizard(cfgPath, {
      prompter: scriptedPrompter({
        text: [`${dir}/vault`, "http://127.0.0.1:1234/v1", "k"],
        select: ["inline", "m-a"],
      }),
      fetchModelsFn: async () => ["m-a"],
      mkdirFn: (pp) => made.push(pp),
      printFn: (s) => printed.push(s),
    });
    expect(code).toBe(0);
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = loadConfig(cfgPath);
    expect(cfg.juncoSubdir).toBe("");
    const paths = queuePaths(cfg);
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed])
      expect(made).toContain(d);
    expect(printed.join("")).toMatch(/Wrote config/);
  });

  it("--yes scaffolds a valid config with no prompts", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-wiz-yes-"));
    const cfgPath = join(dir, "config.toml");
    const code = await runInitWizard(cfgPath, { yes: true, mkdirFn: () => {}, printFn: () => {} });
    expect(code).toBe(0);
    expect(loadConfig(cfgPath).model.id).toBe("local/my-model");
  });

  it("returns 130 on cancel, no throw", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-wiz-cancel-"));
    const cfgPath = join(dir, "config.toml");
    const written: string[] = [];
    const cancelling: Prompter = {
      ...scriptedPrompter(),
      async text() {
        throw new WizardCancelled();
      },
    };
    const code = await runInitWizard(cfgPath, {
      prompter: cancelling,
      writeFileFn: (p2) => written.push(p2),
      mkdirFn: () => {},
      printFn: () => {},
    });
    expect(code).toBe(130);
    expect(written).toEqual([]); // nothing written when cancelled before collect finishes
  });
});
```

- [ ] **Step 2: Run, verify fail** → FAIL (old runInitWizard uses `ask`/readline).

- [ ] **Step 3: Implement** the new `WizardDeps` + `runInitWizard` in `src/wizard.ts`:

```ts
export interface WizardDeps {
  prompter?: Prompter;
  yes?: boolean;
  fetchModelsFn?: typeof fetchModels;
  parseModelsJsonFn?: typeof parseModelsJson;
  writeFileFn?: (path: string, content: string) => void;
  loadConfigFn?: (path: string) => Config;
  mkdirFn?: (path: string) => void;
  printFn?: (s: string) => void;
}

export async function runInitWizard(configPath: string, deps: WizardDeps = {}): Promise<number> {
  const writeFileFn = deps.writeFileFn ?? ((p, c) => writeFileSync(p, c, "utf8"));
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const mkdirFn = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const printFn = deps.printFn ?? ((s) => process.stdout.write(s));

  try {
    let answers: WizardAnswers;
    if (deps.yes) {
      answers = defaultAnswers();
    } else {
      const prompter = deps.prompter ?? clackPrompter();
      answers = await collectAnswers(prompter, {
        fetchModelsFn: deps.fetchModelsFn,
        parseModelsJsonFn: deps.parseModelsJsonFn,
      });
    }
    const toml = renderConfigToml(answers);
    const resolved = resolve(configPath);
    mkdirFn(dirname(resolved));
    writeFileFn(resolved, toml);

    const cfg = loadConfigFn(resolved);
    const paths = queuePaths(cfg);
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed, cfg.worktreeRoot])
      mkdirFn(d);

    const queueRoot = dirname(paths.inbox);
    printFn(
      `\n✓ Wrote config:  ${resolved}\n` +
        `✓ Created queue: ${queueRoot}/{inbox,processing,done,failed}\n\n` +
        `Next steps:\n` +
        `  • Tweak the model/endpoint in ${resolved} if needed.\n` +
        `  • Start the worker:  junco start --config ${resolved}\n` +
        `  • Submit a ticket:   junco submit <ticket>.md --config ${resolved}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof WizardCancelled) return 130; // clack.cancel() already printed
    throw e;
  }
}
```

- [ ] **Step 4: Run, verify pass** `npx vitest run tests/wizard.test.ts` → all PASS.
- [ ] **Step 5: Commit** `git add src/wizard.ts tests/wizard.test.ts && git commit -m "feat(wizard): clack-backed runInitWizard with graceful cancel (exit 130)"`

---

### Task 7: Wire `cli.ts` to the new wizard (drop `AskFn`)

**Files:** Modify `src/cli.ts`; (cli tests should already pass — verify)

- [ ] **Step 1:** Edit `src/cli.ts:35` import → `import { runInitWizard } from "./wizard.js";` (drop `type AskFn`).
- [ ] **Step 2:** Remove the `askFn?: AskFn;` field (lines 51–52) from `CliDeps`.
- [ ] **Step 3:** Non-TTY guard (`cli.ts:300`) → drop the `!deps.askFn &&` term:

```ts
if (!wantYes && !deps.runInitWizardFn && !process.stdin.isTTY) {
```

- [ ] **Step 4:** Wizard wiring (`cli.ts:307-310`) → drop `ask`:

```ts
const runWizard =
  deps.runInitWizardFn ??
  ((cp: string, o: { yes?: boolean }) => runInitWizard(cp, { yes: o.yes, printFn }));
```

- [ ] **Step 5: Build + full suite** `npx tsc -p tsconfig.json && npx vitest run` → clean build, all green (cli wizard-routing + non-TTY guard tests rely on `runInitWizardFn`/TTY, not `askFn`).
- [ ] **Step 6: Commit** `git add src/cli.ts && git commit -m "feat(cli): wire clack wizard; drop the AskFn seam"`

---

### Task 8: Version bump, changelog, README, final verification

**Files:** Modify `package.json`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1:** `package.json` `"version": "0.2.1"` → `"0.2.2"`.
- [ ] **Step 2:** `CHANGELOG.md` — add under the top:

```markdown
## [0.2.2] - 2026-06-01

### Added

- Colorized `junco init` wizard (via `@clack/prompts`): boxed prompts, an arrow-key model picker that **discovers models from the endpoint** (`GET /v1/models`) or a Pi `models.json`, and a spinner while it fetches. Falls back to manual entry when the endpoint is unreachable.
- Graceful cancel: Ctrl-C/Ctrl-D exits cleanly (no stack trace).

### Changed

- The wizard now writes `junco_subdir = ""`, so the queue lives directly under the chosen directory (default `~/Junco/{inbox,…}`) — no redundant `Junco/` subfolder. Existing configs are unaffected (the schema default stays `Junco`).
- Removed personal-stack example strings from the shipped wizard prompts; the provider label is inferred from the endpoint host.
```

- [ ] **Step 3:** `README.md` — in the "Get started" / wizard mention, note the model auto-detection + that the queue is created at the chosen dir (e.g. `~/Junco`). (Adjust whatever wording references `~/junco-vault/Junco`.) Grep first: `grep -n "junco-vault\|/Junco\|init" README.md`.
- [ ] **Step 4: Full build + suite** `npm run build && npm test` → clean, all green (expect ~584 tests).
- [ ] **Step 5: Live smoke (isolated HOME, no real dirs):**

```bash
SB=$(mktemp -d); HOME="$SB" node dist/cli.js init --yes --config "$SB/config.toml"
grep -q 'junco_subdir = ""' "$SB/config.toml" && echo "subdir OK"
node dist/cli.js init --config /tmp/none/config.toml </dev/null; echo "guard exit=$?"   # → 1
rm -rf "$SB"
```

- [ ] **Step 6: Commit** `git add package.json CHANGELOG.md README.md && git commit -m "chore(release): v0.2.2 — wizard deepening"`

**HOLD:** Do NOT tag / push / `gh release` / `npm publish`. Stop here and report diffs + green suite + the live demo. Await maintainer approval.

---

## Self-review

- **Spec coverage:** clack TUI (T3,5,6) ✓; arrow-key model picker + `/v1/models` discovery + models.json + manual fallback (T2,5) ✓; provider inference (T2,5) ✓; `junco_subdir=""` / `~/Junco` (T4) ✓; schema default stays `Junco` (no schema change) ✓; graceful cancel → 130 (T6) ✓; de-personalization (T4 defaults + render comments; T5 removes the omlx/Qwen prompt example) ✓; v0.2.2 + hold (T8) ✓; tests incl. cancel/fetch/inferProvider (T2,5,6) ✓.
- **Type consistency:** `Prompter`/`SelectOption`/`WizardCancelled` defined in T3, consumed in T5/T6/tests; `collectAnswers(p, deps)` and `WizardDeps.prompter` match; `fetchModels`/`parseModelsJson`/`inferProvider` signatures consistent T2↔T5; `expandHome` exported (T1) before use (T5). MANUAL sentinel `" manual"` identical in src + tests.
- **Placeholder scan:** none — every code step is complete.
- **Open assumption:** `~/Junco` (Design 2) per maintainer; one-line default change if they meant a subfolder under a chosen vault.

```

```
