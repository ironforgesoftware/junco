# Setup-Wizard Deepening — Design

**Date:** 2026-06-01
**Status:** Awaiting user review
**Ships as:** v0.2.2 (per maintainer; features, but kept a patch bump)
**Release hold:** Do NOT push / tag / release / `npm publish` until the maintainer explicitly approves. Work locally; show diffs + green tests + a live demo first.

## Goal

Make `junco init` a polished, colorized first-run experience: a boxed/colored TUI, an
arrow-key model picker that **discovers available models from the endpoint** instead of
making the user type a model id, a single sensibly-named queue folder (`~/Junco`, no
redundant nesting), graceful cancellation, and no personal-stack details baked into the
shipped prompts.

## Locked decisions

1. **TUI library:** adopt **`@clack/prompts@1.5.0`** — pure ESM, `engines.node >=20.12`
   (junco floor is ≥22.19), small tree (`@clack/core@1.4.0`, `sisteransi`,
   `fast-string-width`, `fast-wrap-ansi`), no native deps. Becomes junco's 5th runtime
   dependency, pinned exact (junco pins everything).
2. **Queue folder:** default `vault_root = "~/Junco"`, `junco_subdir = ""` → queue at
   `~/Junco/{inbox,processing,done,failed}`. The folder holding tickets is named `Junco`.
   The **schema default for `junco_subdir` stays `"Junco"`** so existing shared-vault
   configs (`<vault>/Junco/…`) are untouched; only the wizard writes `""`.
3. **Provider label:** **inferred** from the endpoint host (see §D). Overridable by editing
   config or by typing a provider-prefixed id manually.
4. **De-personalize the shipped wizard:** remove `omlx` and `Qwen3.6-27B-oQ8-mtp` from
   prompts/defaults/comments; use neutral placeholders. (Stack-agnostic shipped-surface
   rule applies to the wizard, not just skill/README/templates.)

## Architecture & components

### A. Module structure + testability seam

clack reads live stdin/stdout, so it can't be driven by the current injectable
`AskFn`. Introduce a thin **`Prompter`** interface to keep `collectAnswers` /
`runInitWizard` unit-testable without a TTY:

```ts
export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}
export interface Prompter {
  intro(title: string): void;
  outro(msg: string): void;
  note(msg: string, title?: string): void;
  text(opts: { message: string; default?: string; placeholder?: string }): Promise<string>;
  select(opts: { message: string; options: SelectOption[]; initial?: string }): Promise<string>;
  /** Run `task` while showing a spinner; returns task's result. */
  spinner<T>(startMsg: string, task: () => Promise<T>, stopMsg: (r: T) => string): Promise<T>;
}
```

- **Production impl** (`clackPrompter`) wraps `@clack/prompts`: `text`, `select`, `spinner`,
  `intro`/`outro`/`note`, and centralizes **cancel handling** — every clack call is checked
  with `isCancel(...)`; on cancel it calls `clack.cancel("Setup cancelled.")` and throws a
  sentinel `WizardCancelled` error.
- **Test impl** (`scriptedPrompter`) returns queued answers for `text`/`select` and runs the
  spinner task inline — fully hermetic, no clack, no stdin.

`renderConfigToml` stays a pure function. New files: `src/wizard/prompter.ts` (interface +
clack impl), `src/wizard/models.ts` (`fetchModels`, `parseModelsJson`, `inferProvider`).
`src/wizard.ts` keeps `renderConfigToml`, `collectAnswers`, `defaultAnswers`,
`runInitWizard`, now parameterized by a `Prompter` + a model-fetch dep.

### B. Colorized flow

`intro("junco init")` → grouped prompts → `outro("✓ Wrote ~/Junco/config.toml …")`, boxed +
cyan/green via clack (which uses picocolors and **auto-honors `NO_COLOR`**). The existing
non-TTY guard in `cli.ts` stays, so clack is never reached without a TTY; `--yes` keeps
using `defaultAnswers()` with no prompts (no clack import on that path beyond the lazy
prompter construction).

**Graceful cancel:** Ctrl-C/Ctrl-D anywhere → `isCancel` → `cancel("Setup cancelled.")` →
`runInitWizard` catches `WizardCancelled` and returns exit code `130`, **no stack trace**
(fixes the fatal `AbortError` dump observed during testing).

### C. Subfolder fix

`renderConfigToml` emits:

```toml
vault_root = "~/Junco"   # queue lives at <vault_root>/{inbox,processing,done,failed}
junco_subdir = ""        # tickets live directly under vault_root
```

`queuePaths` does `join(vaultRoot, juncoSubdir)`; `join(".../Junco", "")` → `.../Junco`, so
**no code change in `queuePaths`**. Success message + comment drop `/Junco`. The default
vault prompt becomes `Where should Junco keep its tickets? [~/Junco]`.

### D. Model recognition

**`fetchModels(baseUrl, apiKey, { fetchFn, timeoutMs })` → `string[]`** — mirrors the
request `health.ts:54` already makes: `GET <apiBaseUrl(baseUrl)>/models`, header
`Authorization: Bearer <key>`, `AbortController` timeout (default 5s). Parses OpenAI-style
`{ data: [{ id }] }` → ids. Any error / non-200 / empty / timeout → `[]` (never throws).

**`inferProvider(baseUrl) → string`** — parse hostname:

- `api.openai.com`→`openai`, `openrouter.ai`→`openrouter`, `api.anthropic.com`→`anthropic`,
  `generativelanguage.googleapis.com`→`google`, `api.groq.com`→`groq`,
  `api.mistral.ai`→`mistral`, `api.deepseek.com`→`deepseek`.
- `localhost` / `127.0.0.1` / `0.0.0.0` / `*.local`→`local`.
- else: strip a leading `api.`, take the second-level label (`api.together.xyz`→`together`);
  un-parseable → `custom`.

**Inline-mode flow:** vault → mode → endpoint base URL → api key → `spinner("Fetching models
from <host>…", fetchModels, r => \`${r.length} found\`)`→ if ids found,`select`them (each
id as a choice) plus a trailing **"✏️  Enter manually…"** option; if the list is empty (fetch
failed/offline) →`note(...)`+ a`text` prompt for the id (today's behavior).

**models_json mode:** `parseModelsJson(path)` reads the file and lists
`<provider>/<modelId>` for every `providers[*].models[*].id` → `select` + manual fallback.
These ids are already provider-scoped, so no inference.

**Storing the id:** if the chosen/typed id already contains `/`, store as-is (respects
manual full ids and OpenRouter-style `vendor/model`). Otherwise store
`\`${inferProvider(baseUrl)}/${id}\``. `splitModelId`splits on the first`/` only, so a
model id that itself contains slashes is preserved under the inferred provider.

### E. De-personalization (shipped-surface hygiene)

- `defaultAnswers().modelId`: `omlx/my-model` → `local/my-model`.
- Prompt example: `e.g. omlx/Qwen3.6-27B-oQ8-mtp` → neutral (`e.g. openai/gpt-4o-mini` or
  `local/<model>`), or simply drop the example now that ids are picked from a list.
- `renderConfigToml` comments: no `omlx`, no specific model names.
- Keep generic local defaults (`http://127.0.0.1:1234/v1`, key `1234`) — those are not
  personal-stack identifiers.

## Testing

- `renderConfigToml` round-trip incl. `junco_subdir = ""` → `loadConfig` → `queuePaths` →
  `<vault>/inbox` (asserts **no `/Junco`** segment); inline + models_json + escaping.
- `inferProvider`: table of hosts → labels incl. localhost→`local` and the SLD fallback.
- `fetchModels`: stub `fetchFn` → parses `data[].id`; non-200 → `[]`; thrown error → `[]`;
  timeout (slow fetch + small `timeoutMs`) → `[]`; asserts the `Authorization` header and the
  `/models` URL.
- `parseModelsJson`: well-formed file → `provider/model` list; missing/invalid → `[]`.
- `collectAnswers(scriptedPrompter, …)`: inline w/ select, inline w/ manual fallback,
  models_json, defaults on empty; verifies the inferred-provider prefixing rule (bare id gets
  prefixed; id-with-slash kept).
- `runInitWizard` end-to-end with `scriptedPrompter` + stub `fetchModels` + write/mkdir
  recorders: writes config, creates the four queue dirs (+ worktreeRoot), prints next steps.
- **Cancel path:** scriptedPrompter throws `WizardCancelled` → `runInitWizard` returns `130`,
  no throw escapes.
- Update existing tests that asserted the old `AskFn` shape or a `/Junco` queue path. Keep
  the full suite green (574 today; net new ~10–14).

## Out of scope

- `create-junco` companion (`npm create junco`).
- Changing the daemon, ticket contract, or any non-wizard surface.
- Auto-starting the daemon from the wizard (prints the next command, as today).
- Multi-provider config in one run (single endpoint/model, as today).

## Open assumptions (flag at review)

- "Folder named Junco" interpreted as `~/Junco` in home with `junco_subdir = ""` (Design 2).
  If you meant "keep a `Junco` subfolder under a separately-chosen vault," that's a one-line
  default change instead.
- Provider inference list is best-effort; unknown hosts fall back to the SLD label or
  `custom`. Easy to extend.
