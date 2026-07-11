# Hosted Providers Phase 1 (Core Resolution + Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let junco resolve hosted catalog models (Anthropic, OpenAI, …) through the Pi SDK's builtin `ModelRegistry` catalog, with optional/`$VAR` API keys and no ambient `~/.pi` file reads — PR 1 of 3 for `docs/superpowers/specs/2026-07-11-hosted-providers-design.md`.

**Architecture:** A new pure resolution cascade in `src/agent/modelSetup.ts` (models.json → builtin catalog → inline) consumed by `makePiSessionFactory` through a `RegistryOps` seam, so tests never import the SDK. Config gains `model.source`, an explicit-`baseUrl` flag, a nullable `$VAR`-interpolated `apiKey`, and SDK retry levers; the factory switches to `AuthStorage.inMemory()` and always passes `SettingsManager.inMemory()`. A minimal probe bypass keeps the daemon bootable against hosted endpoints until Phase 2's provider gate.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), zod, vitest, `@earendil-works/pi-coding-agent` 0.80.3 (existing exact-pinned dep — nothing new is added).

## Global Constraints

- Suite green at every commit; conventional commits; **no AI attribution trailers of any kind**.
- No new dependencies (the catalog lives inside the already-pinned SDK).
- Never import the Pi SDK at module top level in `src/` (type-only is fine); the runtime `await import` stays inside `makePiSessionFactory` (`src/agent/session.ts`).
- `src/ticketSchema.ts` is untouched.
- Run `npx prettier --write` on touched files before each commit (prettier may reformat between read and edit — re-read before editing).
- Full gate before declaring done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Vitest exit-code trap: never pipe vitest into a filter; capture `$?` directly.
- Phases 2 (provider gate/resilience) and 3 (doctor/wizard/cost/docs) are **separate plans**, authored after this PR merges, against spec §3 and §4–5 respectively. Do not implement them here.

---

### Task 1: `resolveApiKey` — literal / `$VAR` / absent, `!command` rejected

**Files:**

- Modify: `src/config.ts` (add exported helper near `DEFAULT_COMPAT`, ~line 84)
- Test: `tests/config.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `resolveApiKey(raw: string | undefined, env: Record<string, string | undefined>): string | null` — exported from `src/config.ts`. Throws `Error` with a `config:`-prefixed message on `!`-prefixed values and on missing `$VAR` targets. Task 3's `assembleConfig` calls this.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts` (import `resolveApiKey` alongside the existing `loadConfig` import from `../src/config.js`):

```ts
describe("resolveApiKey", () => {
  it("passes a literal key through", () => {
    expect(resolveApiKey("sk-live-123", {})).toBe("sk-live-123");
  });

  it("returns null when unset (defer to provider env at request time)", () => {
    expect(resolveApiKey(undefined, {})).toBeNull();
  });

  it("interpolates an exact $VAR reference from the daemon env", () => {
    expect(resolveApiKey("$MY_PROVIDER_KEY", { MY_PROVIDER_KEY: "sk-env-9" })).toBe("sk-env-9");
  });

  it("throws a config error when the referenced $VAR is unset or empty", () => {
    expect(() => resolveApiKey("$MISSING_KEY", {})).toThrow(/config: model\.apiKey.*MISSING_KEY/);
    expect(() => resolveApiKey("$EMPTY_KEY", { EMPTY_KEY: "" })).toThrow(/EMPTY_KEY/);
  });

  it("rejects !command values — junco never shell-executes config values", () => {
    expect(() => resolveApiKey("!op read secret", {})).toThrow(/config: model\.apiKey.*!command/);
  });

  it("treats a non-env-shaped $ string as a literal", () => {
    expect(resolveApiKey("$not-an-env-ref", {})).toBe("$not-an-env-ref");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `resolveApiKey` is not exported.

- [ ] **Step 3: Implement**

In `src/config.ts`, after the `DEFAULT_COMPAT` block:

```ts
const ENV_REF = /^\$([A-Z_][A-Z0-9_]*)$/;

/**
 * Resolve the configured model.apiKey: a literal passes through; an exact
 * "$ENV_VAR" reference (uppercase env style only — anything else is a literal)
 * is read from the daemon environment; absent stays null so the SDK's
 * request-time provider env-var fallback (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * …) applies. "!command" values are rejected: the Pi SDK shell-executes them
 * in its own auth files, and junco will not forward that surface from
 * config.json.
 */
export function resolveApiKey(
  raw: string | undefined,
  env: Record<string, string | undefined>,
): string | null {
  if (raw === undefined) return null;
  if (raw.startsWith("!")) {
    throw new Error(
      'config: model.apiKey must not be a "!command" value — junco does not execute shell ' +
        'commands from config.json. Use a literal key or an "$ENV_VAR" reference.',
    );
  }
  const m = ENV_REF.exec(raw);
  if (m) {
    const val = env[m[1]];
    if (val === undefined || val === "") {
      throw new Error(
        `config: model.apiKey references $${m[1]}, but ${m[1]} is not set in the daemon environment.`,
      );
    }
    return val;
  }
  return raw;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (all existing + 6 new).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/config.ts tests/config.test.ts
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): resolveApiKey — \$VAR interpolation, !command rejected, absent = null"
```

---

### Task 2: `catalogEligible` — the source rule as a pure predicate

**Files:**

- Modify: `src/agent/modelSetup.ts` (after `splitModelId`)
- Test: `tests/modelSetup.test.ts`

**Interfaces:**

- Consumes: `splitModelId` (same file).
- Produces: `catalogEligible(m: ModelSourceFields): boolean` and `interface ModelSourceFields { source: "auto" | "catalog" | "inline"; id: string; baseUrlExplicit: boolean }` — exported from `src/agent/modelSetup.ts`. Tasks 3 (assembly default rule), 5 (cascade), and 7 (probe bypass) consume it. `ModelConfig` will structurally satisfy `ModelSourceFields` after Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `tests/modelSetup.test.ts`:

```ts
describe("catalogEligible", () => {
  it("auto + non-local provider + no explicit baseUrl → eligible", () => {
    expect(
      catalogEligible({
        source: "auto",
        id: "anthropic/claude-sonnet-4-5",
        baseUrlExplicit: false,
      }),
    ).toBe(true);
  });

  it("auto + explicit baseUrl → inline (deliberate proxy/override)", () => {
    expect(
      catalogEligible({ source: "auto", id: "anthropic/claude-sonnet-4-5", baseUrlExplicit: true }),
    ).toBe(false);
  });

  it("auto + local provider (bare or prefixed) → never eligible", () => {
    expect(catalogEligible({ source: "auto", id: "my-model", baseUrlExplicit: false })).toBe(false);
    expect(catalogEligible({ source: "auto", id: "local/my-model", baseUrlExplicit: false })).toBe(
      false,
    );
  });

  it("explicit source wins over the heuristic in both directions", () => {
    expect(catalogEligible({ source: "catalog", id: "openai/gpt-x", baseUrlExplicit: true })).toBe(
      true,
    );
    expect(catalogEligible({ source: "inline", id: "openai/gpt-x", baseUrlExplicit: false })).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/modelSetup.test.ts`
Expected: FAIL — `catalogEligible` not exported.

- [ ] **Step 3: Implement**

In `src/agent/modelSetup.ts` after `splitModelId`:

```ts
/** The fields the source rule needs — ModelConfig satisfies this structurally. */
export interface ModelSourceFields {
  source: "auto" | "catalog" | "inline";
  id: string;
  baseUrlExplicit: boolean;
}

/**
 * Should this model resolve from the SDK's builtin hosted catalog?  Explicit
 * `model.source` always wins; under "auto" a non-`local` provider prefix opts
 * in unless the user explicitly set `model.baseUrl` (an explicit endpoint
 * means a deliberate proxy/override → inline).
 */
export function catalogEligible(m: ModelSourceFields): boolean {
  if (m.source === "catalog") return true;
  if (m.source === "inline") return false;
  return splitModelId(m.id).provider !== "local" && !m.baseUrlExplicit;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/modelSetup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/agent/modelSetup.ts tests/modelSetup.test.ts
git add src/agent/modelSetup.ts tests/modelSetup.test.ts
git commit -m "feat(model): catalogEligible — the hosted-catalog source rule as a pure predicate"
```

---

### Task 3: Config schema + assembly — `source`, `baseUrlExplicit`, nullable `apiKey`, `retry`

**Files:**

- Modify: `src/types.ts` (ModelConfig, ~lines 22-35)
- Modify: `src/config.ts` (ConfigSchema model block ~lines 89-111, `assembleConfig` ~lines 266-290, `loadConfig` ~line 356)
- Test: `tests/config.test.ts`
- Sweep: every test file whose `makeConfig`/`cfg()` helper builds a full `ModelConfig` literal (typecheck finds them)

**Interfaces:**

- Consumes: `resolveApiKey` (Task 1), `catalogEligible` + `ModelSourceFields` (Task 2, imported into `src/config.ts` from `./agent/modelSetup.js`).
- Produces: resolved `Config.model` gains `source: "auto" | "catalog" | "inline"`, `baseUrlExplicit: boolean`, `apiKey: string | null`, `retry: ModelRetryConfig` (`{ maxRetries: number | null; baseDelayMs: number | null }` — new exported interface in `src/types.ts`). `assembleConfig(d, env?)` and `loadConfig(path, env?)` gain an injectable env (default `process.env`). Tasks 5-7 consume these fields.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts`:

```ts
describe("hosted model config (source / baseUrlExplicit / apiKey / retry)", () => {
  it("defaults stay local-first: source auto, local default baseUrl, placeholder key", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/tmp/vault" }));
    expect(cfg.model.source).toBe("auto");
    expect(cfg.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(cfg.model.baseUrlExplicit).toBe(false);
    expect(cfg.model.apiKey).toBe("1234");
    expect(cfg.model.retry).toEqual({ maxRetries: null, baseDelayMs: null });
  });

  it("a hosted id with no baseUrl and no key resolves apiKey to null (env fallback)", () => {
    const cfg = loadConfig(
      writeJson({ vaultRoot: "/tmp/vault", model: { id: "anthropic/claude-sonnet-4-5" } }),
    );
    expect(cfg.model.baseUrlExplicit).toBe(false);
    expect(cfg.model.apiKey).toBeNull();
  });

  it("an explicit baseUrl keeps the inline placeholder key (proxy/override)", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/vault",
        model: { id: "anthropic/claude-sonnet-4-5", baseUrl: "http://10.0.0.5:8080/v1" },
      }),
    );
    expect(cfg.model.baseUrlExplicit).toBe(true);
    expect(cfg.model.apiKey).toBe("1234");
  });

  it("interpolates $VAR keys through the injectable env", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/vault",
        model: { id: "anthropic/claude-sonnet-4-5", apiKey: "$PROVIDER_KEY" },
      }),
      { PROVIDER_KEY: "sk-real" },
    );
    expect(cfg.model.apiKey).toBe("sk-real");
  });

  it("parses retry levers and defaults them to null", () => {
    const cfg = loadConfig(
      writeJson({
        vaultRoot: "/tmp/vault",
        model: { retry: { maxRetries: 5, baseDelayMs: 500 } },
      }),
    );
    expect(cfg.model.retry).toEqual({ maxRetries: 5, baseDelayMs: 500 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `source`/`baseUrlExplicit`/`retry` undefined; `loadConfig` takes one argument.

- [ ] **Step 3: Implement the schema + types**

`src/config.ts` — in the `ConfigSchema` model block, change `baseUrl`/`apiKey` and add `source`/`retry`:

```ts
      source: z.enum(["auto", "catalog", "inline"]).default("auto"),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      retry: z
        .object({
          maxRetries: z.number().int().min(0).optional(),
          baseDelayMs: z.number().min(0).optional(),
        })
        .default({}),
```

`src/types.ts` — add above `ModelConfig` and extend it:

```ts
/** SDK auto-retry knobs passed to SettingsManager.inMemory; null = SDK default. */
export interface ModelRetryConfig {
  maxRetries: number | null;
  baseDelayMs: number | null;
}
```

and in `ModelConfig`:

```ts
export interface ModelConfig {
  id: string; // provider-prefixed, e.g. "openai/gpt-4o-mini"
  source: "auto" | "catalog" | "inline"; // resolution mode; auto = catalog for non-local providers without an explicit baseUrl
  modelsJson: string | null; // path to a Pi models.json, or null for inline
  api: string; // Pi Api style, e.g. "openai-completions"
  baseUrl: string; // OpenAI-compatible endpoint (inline path; local default when unset)
  baseUrlExplicit: boolean; // true iff base_url was present in the config file
  apiKey: string | null; // null = defer to the provider's env var at request time
  retry: ModelRetryConfig;
  reasoning: boolean;
  input: string[]; // e.g. ["text", "image"]
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
  thinkingLevel: string; // worker default thinking level
  compat: ModelCompat;
}
```

- [ ] **Step 4: Implement the assembly**

`src/config.ts` — import `catalogEligible` next to the existing imports:

```ts
import { catalogEligible } from "./agent/modelSetup.js";
```

Add near `DEFAULT_COMPAT`:

```ts
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";
```

Replace the `model:` block of `assembleConfig` and thread `env`:

```ts
export function assembleConfig(
  d: ConfigParsed,
  env: Record<string, string | undefined> = process.env,
): Config {
  const baseUrlExplicit = d.model.baseUrl !== undefined;
  const eligible = catalogEligible({ source: d.model.source, id: d.model.id, baseUrlExplicit });
  const resolvedKey = resolveApiKey(d.model.apiKey, env);
  return {
    vaultRoot: expandHome(d.vaultRoot),
    juncoSubdir: d.juncoSubdir,
    tools: d.tools,
    model: {
      id: d.model.id,
      source: d.model.source,
      modelsJson: d.model.modelsJson ? expandHome(d.model.modelsJson) : null,
      api: d.model.api,
      // Stored raw; apiBaseUrl() normalizes (strips trailing /models) at use.
      baseUrl: d.model.baseUrl ?? DEFAULT_LOCAL_BASE_URL,
      baseUrlExplicit,
      // Catalog-eligible configs may omit the key: the SDK falls back to the
      // provider's env var (ANTHROPIC_API_KEY, …) at request time. The "1234"
      // placeholder applies only to inline/local endpoints.
      apiKey: resolvedKey ?? (eligible ? null : "1234"),
      retry: {
        maxRetries: d.model.retry.maxRetries ?? null,
        baseDelayMs: d.model.retry.baseDelayMs ?? null,
      },
      reasoning: d.model.reasoning,
      // …(keep the remaining fields exactly as they are today: input,
      // contextWindow, maxTokens, cost{…}, thinkingLevel, compat merge)…
    },
    // …rest of assembleConfig unchanged…
  };
}
```

and:

```ts
export function loadConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Config {
  return assembleConfig(parseConfigFile(path), env);
}
```

- [ ] **Step 5: Run the new tests, then sweep the fixtures**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: errors ONLY in test files whose helpers build full `ModelConfig` literals (per CLAUDE.md: `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts` and the assess/analyze/config/health suites). In each flagged `makeConfig`/`cfg()` model block add:

```ts
      source: "auto",
      baseUrlExplicit: false,
      retry: { maxRetries: null, baseDelayMs: null },
```

(`apiKey: string | null` widens — existing string literals stay valid.) Re-run `npm run typecheck` until clean, then `npx vitest run` on each touched suite.

- [ ] **Step 6: Full suite + commit**

Run: `npx vitest run > /tmp/t3.out 2>&1; echo "exit: $?"` — expected `exit: 0`.

```bash
npx prettier --write src/config.ts src/types.ts tests/
git add -A src/config.ts src/types.ts tests/
git commit -m "feat(config): model.source + baseUrlExplicit + nullable \$VAR apiKey + retry levers"
```

---

### Task 4: Lever registry entries for the new fields

**Files:**

- Modify: `src/configLevers.ts` (model.\* section, ~lines 75-196)
- Test: `tests/configLevers.test.ts`

**Interfaces:**

- Consumes: schema defaults from Task 3.
- Produces: levers `model.source`, `model.retry.maxRetries`, `model.retry.baseDelayMs` (all `reload: "live"`); updated `model.baseUrl` / `model.apiKey` lever defaults (`undefined`) and descriptions. The TUI config editor picks these up automatically from `LEVERS` + `SECTION_ORDER` — no TUI change in this phase.

- [ ] **Step 1: Write the failing test**

Append to `tests/configLevers.test.ts`:

```ts
describe("hosted-provider levers", () => {
  it("registers model.source and model.retry.* as live levers", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("model.source")).toMatchObject({ reload: "live", default: "auto" });
    expect(byPath.get("model.retry.maxRetries")).toMatchObject({ reload: "live" });
    expect(byPath.get("model.retry.baseDelayMs")).toMatchObject({ reload: "live" });
  });

  it("model.apiKey and model.baseUrl no longer advertise hard defaults", () => {
    const byPath = new Map(LEVERS.map((l) => [l.path, l]));
    expect(byPath.get("model.apiKey")?.default).toBeUndefined();
    expect(byPath.get("model.baseUrl")?.default).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/configLevers.test.ts`
Expected: FAIL — new paths missing, old defaults still `"1234"` / the localhost URL.

- [ ] **Step 3: Implement**

In `src/configLevers.ts` model section — update the two existing entries and add three:

```ts
  {
    path: "model.source",
    type: "string",
    default: "auto",
    editable: true,
    reload: "live",
    description:
      "Model resolution mode: auto (catalog for non-local providers without an explicit baseUrl), catalog, or inline.",
  },
```

`model.baseUrl` entry → `default: undefined` and description: `"OpenAI-compatible /v1 endpoint base URL. Unset = local default (http://127.0.0.1:1234/v1); setting it forces inline resolution."`

`model.apiKey` entry → `default: undefined` and description: `"API key for the inference endpoint. Literal, \"$ENV_VAR\" reference, or unset to use the provider's env var (e.g. ANTHROPIC_API_KEY) for hosted catalog models."`

```ts
  {
    path: "model.retry.maxRetries",
    type: "number",
    default: undefined,
    editable: true,
    reload: "live",
    description: "SDK auto-retry attempts on transient provider errors; unset = SDK default (3).",
  },
  {
    path: "model.retry.baseDelayMs",
    type: "number",
    default: undefined,
    editable: true,
    reload: "live",
    description: "Base delay for SDK auto-retry backoff in ms; unset = SDK default (2000).",
  },
```

If `tests/configLevers.test.ts` has a lever↔schema default-parity assertion, the Task 3 schema changes make these exact values mandatory — reconcile in whichever direction the existing test asserts.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/configLevers.test.ts tests/configView.test.tsx tests/configCmd.test.ts`
Expected: PASS (the TUI/CLI suites consume `LEVERS` — fix any snapshot-style drift by updating expected field lists, not by hiding levers).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/configLevers.ts tests/configLevers.test.ts
git add src/configLevers.ts tests/configLevers.test.ts tests/configView.test.tsx tests/configCmd.test.ts
git commit -m "feat(config): live levers for model.source and model.retry.*"
```

---

### Task 5: `resolveModelViaRegistries` — the cascade behind a registry seam

**Files:**

- Modify: `src/agent/modelSetup.ts`
- Test: `tests/modelSetup.test.ts`

**Interfaces:**

- Consumes: `catalogEligible` (Task 2), `buildInlineProviderConfig`/`splitModelId`/`apiBaseUrl` (same file), `Config` with Task 3 fields.
- Produces (all exported from `src/agent/modelSetup.ts`):

```ts
export interface RegistryLike {
  find(provider: string, modelId: string): unknown;
  registerProvider(name: string, config: Record<string, unknown>): void;
}
export interface RegistryOps {
  fromFile(modelsJsonPath: string): RegistryLike;
  inMemory(): RegistryLike;
}
export interface ResolvedModel {
  model: unknown;
  registry: RegistryLike;
  path: "models_json" | "catalog" | "inline";
}
export function resolveModelViaRegistries(
  cfg: Config,
  ops: RegistryOps,
  warn?: (msg: string, meta?: Record<string, unknown>) => void,
): ResolvedModel;
```

Task 6 wires the factory through this.

- [ ] **Step 1: Write the failing tests**

Append to `tests/modelSetup.test.ts` (reuse the file's existing `Config`-fixture helper; set `model.id`, `model.source`, `model.baseUrlExplicit`, `model.apiKey`, `model.modelsJson` per case):

```ts
function fakeRegistry(models: Record<string, unknown>) {
  const registered: Array<{ name: string; config: Record<string, unknown> }> = [];
  return {
    registered,
    // After an inline registration, find() resolves the registered model —
    // mirrors the real registry (registerProvider replaces provider models).
    find: (p: string, m: string) =>
      models[`${p}/${m}`] ?? (registered.length > 0 ? { fromInline: true } : undefined),
    registerProvider: (name: string, config: Record<string, unknown>) => {
      registered.push({ name, config });
    },
  };
}

describe("resolveModelViaRegistries", () => {
  it("models.json hit wins (path models_json), no provider registered", () => {
    const sentinel = { catalog: "file" };
    const file = fakeRegistry({ "anthropic/claude-x": sentinel });
    const mem = fakeRegistry({});
    const cfg = makeCfg({ id: "anthropic/claude-x", modelsJson: existingModelsJsonPath });
    const out = resolveModelViaRegistries(cfg, { fromFile: () => file, inMemory: () => mem });
    expect(out).toMatchObject({ model: sentinel, path: "models_json" });
    expect(file.registered).toEqual([]);
  });

  it("catalog hit resolves WITHOUT registerProvider (the clobber bug stays dead)", () => {
    const sentinel = { catalog: "builtin" };
    const mem = fakeRegistry({ "anthropic/claude-x": sentinel });
    const cfg = makeCfg({ id: "anthropic/claude-x", modelsJson: null, apiKey: null });
    const out = resolveModelViaRegistries(cfg, { fromFile: fail, inMemory: () => mem });
    expect(out).toMatchObject({ model: sentinel, path: "catalog" });
    expect(mem.registered).toEqual([]);
  });

  it("catalog miss falls through to inline when a key exists", () => {
    const mem = fakeRegistry({});
    const cfg = makeCfg({ id: "unknownprov/m1", modelsJson: null, apiKey: "k" });
    const out = resolveModelViaRegistries(cfg, { fromFile: fail, inMemory: () => mem });
    expect(out.path).toBe("inline");
    expect(mem.registered[0]?.name).toBe("unknownprov");
  });

  it("catalog miss with a null key throws an actionable config error", () => {
    const mem = fakeRegistry({});
    const cfg = makeCfg({ id: "unknownprov/m1", modelsJson: null, apiKey: null });
    expect(() => resolveModelViaRegistries(cfg, { fromFile: fail, inMemory: () => mem })).toThrow(
      /did not resolve from the builtin catalog/,
    );
  });

  it("ineligible (local) config goes straight to inline", () => {
    const mem = fakeRegistry({});
    const cfg = makeCfg({ id: "local/my-model", modelsJson: null, apiKey: "1234" });
    const out = resolveModelViaRegistries(cfg, { fromFile: fail, inMemory: () => mem });
    expect(out.path).toBe("inline");
  });
});
```

(`fail` = `() => { throw new Error("must not be called"); }`; `makeCfg` = the file's Config helper with `source: "auto"`, `baseUrlExplicit: false` defaults. Write a real temp models.json via `mkdtempSync` for `existingModelsJsonPath`, matching the file's existing `resolveProbeBaseUrl` test pattern.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/modelSetup.test.ts`
Expected: FAIL — `resolveModelViaRegistries` / `RegistryLike` not exported.

- [ ] **Step 3: Implement**

In `src/agent/modelSetup.ts` (interfaces from the block above, then):

```ts
/**
 * The three-way model resolution cascade — models.json → builtin catalog →
 * inline — behind a registry seam so tests never import the SDK.  Catalog
 * resolution deliberately never calls registerProvider: registering an inline
 * provider REPLACES the SDK's builtin models for that provider (the pre-Phase-1
 * bug that bound "anthropic/…" to the local default endpoint).
 */
export function resolveModelViaRegistries(
  cfg: Config,
  ops: RegistryOps,
  warn: (msg: string, meta?: Record<string, unknown>) => void = () => {},
): ResolvedModel {
  const m = cfg.model;
  const { provider, modelId } = splitModelId(m.id);

  if (m.modelsJson && existsSync(m.modelsJson)) {
    const registry = ops.fromFile(m.modelsJson);
    const model = registry.find(provider, modelId);
    if (model) return { model, registry, path: "models_json" };
    warn("model not in models.json; falling through", {
      modelsJson: m.modelsJson,
      provider,
      modelId,
    });
  }

  if (catalogEligible(m)) {
    const registry = ops.inMemory();
    const model = registry.find(provider, modelId);
    if (model) return { model, registry, path: "catalog" };
    warn("model not in the builtin catalog; falling through to inline", { provider, modelId });
  }

  if (m.apiKey === null) {
    throw new Error(
      `model "${m.id}": provider "${provider}" did not resolve from the builtin catalog and no ` +
        `inline endpoint is configured — set model.baseUrl + model.apiKey, point model.modelsJson ` +
        `at a Pi models.json, or use a catalog provider id.`,
    );
  }
  const registry = ops.inMemory();
  const { providerConfig } = buildInlineProviderConfig(cfg);
  registry.registerProvider(provider, providerConfig);
  const model = registry.find(provider, modelId);
  if (!model) {
    throw new Error(
      `Pi model "${provider}/${modelId}" not found in registry (baseUrl: ${apiBaseUrl(m.baseUrl)}).`,
    );
  }
  return { model, registry, path: "inline" };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/modelSetup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/agent/modelSetup.ts tests/modelSetup.test.ts
git add src/agent/modelSetup.ts tests/modelSetup.test.ts
git commit -m "feat(model): resolveModelViaRegistries — models.json → catalog → inline cascade"
```

---

### Task 6: Factory wiring — in-memory auth/settings, conditional key, cascade

**Files:**

- Modify: `src/agent/session.ts:492-578` (`makePiSessionFactory`)
- Test: `tests/sdkImportSurface.test.ts`

**Interfaces:**

- Consumes: `resolveModelViaRegistries`, `RegistryLike` (Task 5); `Config.model.apiKey/retry` (Task 3); SDK root exports `AuthStorage.inMemory`, `SettingsManager.inMemory`, `ModelRegistry.{create,inMemory}` (pinned by the new test).
- Produces: no new exports — behavior only. The factory stays the single place with a runtime SDK import.

- [ ] **Step 1: Write the failing import-surface test**

Append to `tests/sdkImportSurface.test.ts`:

```ts
describe("Pi SDK import surface (hosted-provider factory wiring depends on these)", () => {
  it("exposes the session-construction statics on the root", async () => {
    const mod = (await import("@earendil-works/pi-coding-agent")) as Record<string, any>;
    for (const name of [
      "createAgentSession",
      "AuthStorage",
      "ModelRegistry",
      "SessionManager",
      "SettingsManager",
    ]) {
      expect(mod[name], name).toBeDefined();
    }
    expect(typeof mod.AuthStorage.inMemory, "AuthStorage.inMemory").toBe("function");
    expect(typeof mod.SettingsManager.inMemory, "SettingsManager.inMemory").toBe("function");
    expect(typeof mod.ModelRegistry.inMemory, "ModelRegistry.inMemory").toBe("function");
    expect(typeof mod.ModelRegistry.create, "ModelRegistry.create").toBe("function");
  });
});
```

- [ ] **Step 2: Run to verify it passes already (it pins, not drives)**

Run: `npx vitest run tests/sdkImportSurface.test.ts`
Expected: PASS — this test exists to fail loudly on a future SDK bump. (TDD exception: the driven behavior is SDK-side; the junco-side logic was TDD'd in Task 5.)

- [ ] **Step 3: Rewire the factory**

In `src/agent/session.ts` `makePiSessionFactory`, replace lines 498-533 (destructure → model-resolution block):

```ts
const { createAgentSession, AuthStorage, ModelRegistry, SessionManager, SettingsManager } =
  await import("@earendil-works/pi-coding-agent");

const { provider } = splitModelId(cfg.model.id);

// In-memory auth: AuthStorage.create() file-backs onto the operator's real
// ~/.pi/agent/auth.json (creating it if absent) — junco must never touch it.
const authStorage = AuthStorage.inMemory();
// A null key defers to the SDK's request-time provider env-var fallback
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, … — see resolveApiKey in config.ts).
if (cfg.model.apiKey !== null) {
  authStorage.setRuntimeApiKey(provider, cfg.model.apiKey);
}

// models.json → builtin catalog → inline (see resolveModelViaRegistries).
const resolved = resolveModelViaRegistries(
  cfg,
  {
    fromFile: (p) => ModelRegistry.create(authStorage, p) as unknown as RegistryLike,
    inMemory: () => ModelRegistry.inMemory(authStorage) as unknown as RegistryLike,
  },
  (msg, meta) => log.warn(msg, meta),
);
const model = resolved.model as any;
const modelRegistry = resolved.registry as any;
```

Add `resolveModelViaRegistries` and `RegistryLike` to the existing `./modelSetup.js` import, and add to the `createAgentSession({ ... })` options (after `sessionManager`):

```ts
      // Never read ~/.pi/agent/settings.json or the target repo's
      // .pi/settings.json (trusted by default by the SDK — a repo-controlled
      // injection surface for a queue worker). Retry knobs come from config;
      // SDK defaults apply otherwise.
      settingsManager: SettingsManager.inMemory({
        retry: {
          ...(cfg.model.retry.maxRetries !== null ? { maxRetries: cfg.model.retry.maxRetries } : {}),
          ...(cfg.model.retry.baseDelayMs !== null ? { baseDelayMs: cfg.model.retry.baseDelayMs } : {}),
        },
      }),
```

Delete the now-dead Path A/B block (lines 506-533) and the unused direct `existsSync`/`buildInlineProviderConfig` imports if nothing else in the file uses them.

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck && npm run build`
Expected: clean (if `settingsManager` or `SettingsManager` is rejected, STOP — the SDK surface differs from the pinned .d.ts; re-read `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts` before proceeding).

Run: `npx vitest run > /tmp/t6.out 2>&1; echo "exit: $?"` — expected `exit: 0`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/agent/session.ts tests/sdkImportSurface.test.ts
git add src/agent/session.ts tests/sdkImportSurface.test.ts
git commit -m "feat(agent): catalog-aware factory — in-memory auth/settings, conditional runtime key"
```

---

### Task 7: Probe bypass for catalog sources (keeps the daemon bootable until Phase 2)

**Files:**

- Modify: `src/agent/modelSetup.ts` (add `shouldProbeEndpoint`)
- Modify: `src/health.ts:41-65` (`endpointReachable`), `src/health.ts:99-129` (`waitForEndpoint`)
- Modify: `src/doctor.ts:152-175` (endpoint + model checks)
- Test: `tests/modelSetup.test.ts`, `tests/health.test.ts`, `tests/doctor.test.ts`

**Interfaces:**

- Consumes: `catalogEligible` (Task 2), `ModelConfig` (Task 3).
- Produces: `shouldProbeEndpoint(m: ModelConfig): boolean` exported from `src/agent/modelSetup.ts` (Phase 2's provider gate replaces its call sites; the predicate survives).

- [ ] **Step 1: Write the failing tests**

`tests/modelSetup.test.ts`:

```ts
describe("shouldProbeEndpoint", () => {
  it("skips the probe for catalog-eligible configs without a models.json", () => {
    expect(shouldProbeEndpoint(modelCfg({ id: "anthropic/claude-x", modelsJson: null }))).toBe(
      false,
    );
  });
  it("probes local/inline configs and any models.json config", () => {
    expect(shouldProbeEndpoint(modelCfg({ id: "local/my-model", modelsJson: null }))).toBe(true);
    expect(
      shouldProbeEndpoint(modelCfg({ id: "anthropic/claude-x", modelsJson: "/tmp/models.json" })),
    ).toBe(true);
  });
});
```

`tests/health.test.ts` (match the file's existing fixture + fake-fetch pattern):

```ts
it("endpointReachable returns true without fetching for catalog sources", async () => {
  const fetchFn = vi.fn();
  const cfg = makeConfig({ model: hostedModel() }); // id anthropic/claude-x, modelsJson null, apiKey null
  await expect(endpointReachable(cfg, { fetchFn })).resolves.toBe(true);
  expect(fetchFn).not.toHaveBeenCalled();
});

it("endpointReachable omits the Authorization header when apiKey is null but a probe runs", async () => {
  const fetchFn = vi.fn().mockResolvedValue({ ok: true });
  const cfg = makeConfig({ model: { ...hostedModel(), modelsJson: tmpModelsJson } });
  await endpointReachable(cfg, { fetchFn });
  const headers = fetchFn.mock.calls[0][1].headers;
  expect(headers.Authorization).toBeUndefined();
});

it("waitForEndpoint returns immediately for catalog sources", async () => {
  const cfg = makeConfig({ model: hostedModel() });
  const sleep = vi.fn();
  await waitForEndpoint(cfg, { requested: false }, { sleep });
  expect(sleep).not.toHaveBeenCalled();
});
```

`tests/doctor.test.ts`:

```ts
it("skips the endpoint probe for hosted catalog configs with an ok note", async () => {
  const { lines } = await runDoctor(makeConfig({ model: hostedModel() })); // per the file's harness
  expect(lines.join("\n")).toMatch(/inference endpoint.*catalog.*probe skipped/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/modelSetup.test.ts tests/health.test.ts tests/doctor.test.ts`
Expected: FAIL — `shouldProbeEndpoint` missing; probe fetches/hangs; doctor reports unreachable.

- [ ] **Step 3: Implement**

`src/agent/modelSetup.ts`:

```ts
/**
 * Whether the readiness machinery should probe the endpoint at all.  Hosted
 * catalog models have no local server to wait for, and probing a metered API
 * on every poll/dashboard tick is billed traffic.  A configured models.json
 * still probes (its provider baseUrl may be local).  Phase 2 replaces the
 * boolean call sites with the provider gate; this predicate survives.
 */
export function shouldProbeEndpoint(m: ModelConfig): boolean {
  return !(catalogEligible(m) && !m.modelsJson);
}
```

(import `ModelConfig` type-only alongside `Config` from `../types.js`.)

`src/health.ts` `endpointReachable` — first line of the body and the headers:

```ts
if (!shouldProbeEndpoint(cfg.model)) return true;
```

```ts
      headers:
        cfg.model.apiKey !== null ? { Authorization: `Bearer ${cfg.model.apiKey}` } : {},
```

`src/health.ts` `waitForEndpoint` — after the `startupWait` guard:

```ts
if (!shouldProbeEndpoint(cfg.model)) {
  log.info("hosted provider (catalog) — endpoint startup wait skipped");
  return;
}
```

`src/doctor.ts` — wrap checks 5-6:

```ts
// 5. endpoint (hosted catalog models are not probed — Phase 2 adds the
// provider gate; Phase 3 adds per-API auth checks)
if (!shouldProbeEndpoint(cfg.model)) {
  report("ok", "inference endpoint", `${cfg.model.id} — hosted provider (catalog); probe skipped`);
} else {
  const up = await reachableFn(cfg);
  report(
    up ? "ok" : "fail",
    "inference endpoint",
    up ? cfg.model.baseUrl : `${cfg.model.baseUrl} unreachable`,
  );

  // 6. model advertised (warn-only: not every endpoint lists models)
  if (up) {
    const ids = await fetchModelsFn(cfg.model.baseUrl, cfg.model.apiKey);
    const { modelId } = splitModelId(cfg.model.id);
    if (ids.length === 0) {
      report("warn", "model", `endpoint does not list models; cannot verify ${cfg.model.id}`);
    } else if (ids.includes(modelId) || ids.includes(cfg.model.id)) {
      report("ok", "model", cfg.model.id);
    } else {
      report(
        "warn",
        "model",
        `${cfg.model.id} not among the endpoint's ${ids.length} advertised models`,
      );
    }
  }
}
```

(Checks 5 and 6 keep their existing bodies verbatim — only the wrapping guard is new. `fetchModelsFn(cfg.model.baseUrl, cfg.model.apiKey)` now receives `string | null` — widen that helper's parameter type to `string | null` and have it omit the Authorization header on null, mirroring `endpointReachable`.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/modelSetup.test.ts tests/health.test.ts tests/doctor.test.ts tests/healthServer.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npx vitest run > /tmp/t7.out 2>&1; echo "exit: $?"` — expected `exit: 0`.

```bash
npx prettier --write src/agent/modelSetup.ts src/health.ts src/doctor.ts tests/
git add -A src/agent/modelSetup.ts src/health.ts src/doctor.ts tests/
git commit -m "feat(health): skip endpoint probing for hosted catalog sources"
```

---

### Task 8: Pin the key-scrub guarantee for provider env vars

**Files:**

- Test: `tests/scrubEnv.test.ts` (test-only task — the allowlist already provides the behavior; this pins it against future allowlist edits)

**Interfaces:**

- Consumes: `scrubEnv(source?): Record<string, string>` (`src/scrubEnv.ts:22`).
- Produces: a regression pin only.

- [ ] **Step 1: Write the test (expected to pass immediately — it pins)**

Append to `tests/scrubEnv.test.ts`:

```ts
it("drops hosted-provider API keys — they must never reach agent children", () => {
  const out = scrubEnv({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sk-ant-x",
    OPENAI_API_KEY: "sk-x",
    GEMINI_API_KEY: "g-x",
    ANTHROPIC_OAUTH_TOKEN: "t-x",
  });
  expect(out.PATH).toBe("/bin");
  for (const k of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
  ]) {
    expect(out[k], k).toBeUndefined();
  }
});
```

- [ ] **Step 2: Run to verify pass**

Run: `npx vitest run tests/scrubEnv.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
npx prettier --write tests/scrubEnv.test.ts
git add tests/scrubEnv.test.ts
git commit -m "test(scrubEnv): pin provider API keys out of agent child envs"
```

---

### Task 9: CHANGELOG + configuration reference

**Files:**

- Modify: `CHANGELOG.md` (Unreleased section, Keep-a-Changelog style)
- Modify: `docs/configuration.md` (model section field reference)

**Interfaces:** none — documentation of Tasks 1-7. Full hosted-provider guide, wizard, and README repositioning land in Phase 3 (spec §5); this documents only the shipped config fields, stack-agnostically (provider ids appear as neutral catalog examples).

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]`:

```markdown
### Added

- Hosted catalog model resolution: a provider-prefixed `model.id` (e.g.
  `anthropic/claude-sonnet-4-5`) with no explicit `model.baseUrl` now resolves
  from the embedded SDK's builtin provider catalog (real endpoint, cost, and
  context-window metadata). `model.source` (`auto`/`catalog`/`inline`) pins the
  behavior explicitly.
- `model.apiKey` may be omitted (the provider's environment variable, e.g.
  `ANTHROPIC_API_KEY`, applies at request time) or set to an `"$ENV_VAR"`
  reference; `"!command"` values are rejected.
- `model.retry.maxRetries` / `model.retry.baseDelayMs` — SDK auto-retry levers.
- Endpoint probing (startup wait, readiness, doctor) is skipped for hosted
  catalog models.

### Changed

- **Behavior:** a provider-prefixed `model.id` without an explicit
  `model.baseUrl` previously bound to the local default endpoint
  (`http://127.0.0.1:1234/v1`); it now resolves from the builtin catalog.
  Explicitly set `model.baseUrl` (or `model.source: "inline"`) to keep the old
  binding.
- The agent session no longer reads or creates `~/.pi/agent/auth.json`,
  `~/.pi/agent/settings.json`, or a target repo's `.pi/settings.json` — auth
  and settings are fully injected from junco config.
```

- [ ] **Step 2: configuration.md**

In the model section table/list, document: `source` (with the auto rule), `baseUrl` (unset = local default; setting it forces inline), `apiKey` (literal / `$ENV_VAR` / unset ⇒ provider env var; `!command` rejected), `retry.maxRetries`, `retry.baseDelayMs`. Add one hosted example block:

````markdown
```json
{
  "model": { "id": "anthropic/claude-sonnet-4-5" }
}
```

With no `baseUrl` and no `apiKey`, the model resolves from the embedded
catalog and the key comes from `ANTHROPIC_API_KEY` in the daemon environment.
````

- [ ] **Step 3: Verify docs claims against behavior, commit**

Every CHANGELOG line above is a conformance assertion — re-check each against the code/tests from Tasks 1-7 before committing.

```bash
npx prettier --write CHANGELOG.md docs/configuration.md
git add CHANGELOG.md docs/configuration.md
git commit -m "docs(providers): document catalog resolution, \$VAR keys, retry levers"
```

---

### Task 10: Full gate + PR

- [ ] **Step 1: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate.out 2>&1; echo "exit: $?"`
Expected: `exit: 0`.

- [ ] **Step 2: Sandboxed smoke** (per CLAUDE.md — never from the repo root)

```bash
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /Users/alxedelweiss/junco/.claude/worktrees/worktree-2/dist/cli.js init --yes && \
  node /Users/alxedelweiss/junco/.claude/worktrees/worktree-2/dist/cli.js doctor; cd / && rm -rf "$SB"
```

Expected: doctor runs; the default (local) config still probes and reports as before this branch.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/hosted-providers
gh pr create --title "feat: hosted catalog providers — core resolution + auth (phase 1/3)" \
  --body "$(cat <<'EOF'
Phase 1 of docs/superpowers/specs/2026-07-11-hosted-providers-design.md (§1, §2).

- models.json → builtin catalog → inline resolution cascade (RegistryOps seam)
- model.source + explicit-baseUrl rule; nullable / $VAR apiKey; retry levers
- AuthStorage.inMemory + SettingsManager.inMemory (no ambient ~/.pi or repo .pi reads)
- probe bypass for hosted catalog sources (Phase 2 replaces with the provider gate)

Phase 2 (provider gate/failure classes) and Phase 3 (doctor/wizard/cost/docs) follow as separate plans.
EOF
)"
```

(No AI attribution in the PR body. Verify no `Co-Authored-By` trailers slipped into any commit: `git log origin/main..HEAD --format='%b' | grep -i co-authored` must be empty.)
