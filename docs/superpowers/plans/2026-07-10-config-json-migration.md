# Config TOML→JSON Migration + Lever Registry + CLI/TUI Editor + Hot-Reload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TOML config with a camelCase `config.json`, remove `smol-toml`, and add a lever registry that powers a `junco config` CLI, a dashboard config editor, and daemon hot-reload of live-safe settings.

**Architecture:** `src/config.ts` splits into `parseConfigFile` (JSON → nested, zod-validated, defaulted) + `assembleConfig` (nested → flat `Config`) + `loadConfig = assemble∘parse`. A hand-written `LEVERS` registry (one descriptor per config leaf, carrying type/default/editable/reload/description) is the single source for the CLI, TUI, and the hot-reload partition, guarded by a schema-bijection drift test. The daemon holds config in a mutable `ConfigHolder` that a directory-watching `configWatcher` updates on file change; the poll loop reads the holder each iteration so live levers reach the next ticket while restart-kind levers only warn.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), zod, vitest, Ink/React (TUI), Node `fs.watch`.

## Global Constraints

- Node ≥ 22.19; ESM/NodeNext; strict TS. Suite green at **every** commit (`npm test`).
- Dependencies exact-pinned; **remove** `smol-toml` (no new deps).
- **No AI attribution** in commits/PRs (no `Co-Authored-By: Claude`, no "Generated with" lines). If a subagent adds the trailer, amend it away before finishing.
- The flat `Config` type in `src/types.ts` is **unchanged** — this migration only changes how it is loaded/edited.
- `src/ticketSchema.ts` is untouched (config is not the ticket contract).
- **Release is on HOLD** — no tag/publish/`gh release`. A CHANGELOG entry ships in the PR; nothing more.
- Live-runtime files (`config.toml`, `tickets/`, `worktrees/`, `launchd.*`) in the main checkout are off-limits to code. The live conversion is a maintainer-run runbook step (Appendix A), not a code task.
- Full gate before "done": `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Run `npx prettier --write` on touched files before each commit. Capture vitest exit code explicitly (never pipe into grep/tail).

---

## File Structure

- **Modify** `src/config.ts` — replace `TomlSchema`/`parseToml` with `ConfigSchema` (camelCase) + `parseConfigFile` + `assembleConfig` + JSON `loadConfig` + leftover-`.toml` guard; drop `toolsFromExtraArgs`, `camelizeKeys`, `omlx`-casing; swap `config.toml`→`config.json` in path helpers.
- **Create** `src/configLevers.ts` — `Lever` interface, `LEVERS` array, `getAtPath`/`setAtPath`/`leverAtPath` helpers.
- **Create** `src/configCmd.ts` — `junco config {path,list,get,set}`.
- **Create** `src/configWatcher.ts` — `ConfigHolder`, `makeConfigHolder`, `watchConfig`.
- **Create** `src/tui/components/ConfigView.tsx` — the dashboard config editor.
- **Modify** `src/wizard.ts` — `renderConfigToml`→`renderConfigJson`; write `config.json`.
- **Modify** `src/metrics.ts` — `pendingRestartFields` on the snapshot.
- **Modify** `src/statusCmd.ts` — surface `pendingRestartFields`.
- **Modify** `src/daemon.ts` — `mainLoop`/`runScheduler` read the holder per iteration.
- **Modify** `src/cli.ts` — wire `config` subcommand; create holder + watcher in `start`.
- **Modify** `src/tui/App.tsx` — open/close the Config view on a key.
- **Modify** docs + `package.json` (remove `smol-toml`) + `CHANGELOG.md`.
- **Modify** coupled tests: `tests/{config,wizard,doctor,cli,service,restartCmd,dashboardCmd,prsCmd,tuiCliRunner,tuiApp}.test.ts`, `tests/helpers/localFixtures.tsx`.
- **Create** tests: `tests/configLevers.test.ts`, `tests/configCmd.test.ts`, `tests/configWatcher.test.ts`, `tests/configView.test.tsx`.

---

## Task 1: Flip the config format (TOML → JSON) atomically

This is the one large task — schema, loader, wizard, dependency removal, and every test that feeds a file through `loadConfig` must move together or the suite goes red.

**Files:**
- Modify: `src/config.ts`
- Modify: `src/wizard.ts`
- Modify: `package.json` (remove `smol-toml`)
- Test: `tests/config.test.ts`, `tests/wizard.test.ts`, and the string/path fixups in `tests/{doctor,cli,service,restartCmd,dashboardCmd,prsCmd,tuiCliRunner,tuiApp}.test.ts` + `tests/helpers/localFixtures.tsx`

**Interfaces:**
- Produces: `parseConfigFile(path: string): ConfigParsed` (nested, camelCase, defaulted — the zod output type), `assembleConfig(d: ConfigParsed): Config`, `loadConfig(path: string): Config`, `renderConfigJson(a: WizardAnswers): string`. `defaultUserConfigPath`/`resolveConfigPath` now resolve `config.json`.
- Consumes: existing `Config`/`ModelConfig` types (`src/types.ts`), `expandHome`, `DEFAULT_COMPAT`, `DEFAULT_TOOLS`.

- [ ] **Step 1: Write failing tests for the new JSON loader (rewrite `tests/config.test.ts`).**

Replace the `writeToml` helper and the TOML-body tests with JSON. Keep the non-format tests (`queuePaths`, `isLoopbackHost`, `resolveConfigPath`, `defaultUserConfigPath`) — only change file basename to `config.json` where they assert it.

```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, queuePaths, resolveConfigPath, defaultUserConfigPath } from "../src/config.js";

function writeJson(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}
function writeRaw(basename: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-cfg-"));
  const p = join(dir, basename);
  writeFileSync(p, body, "utf8");
  return p;
}

describe("loadConfig (JSON)", () => {
  it("parses a minimal config and fills defaults", () => {
    const cfg = loadConfig(writeJson({ vaultRoot: "/tmp/vault" }));
    expect(cfg.vaultRoot).toBe("/tmp/vault");
    expect(cfg.juncoSubdir).toBe("Junco");
    expect(cfg.model.id).toBe("local/my-model");
    expect(cfg.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(cfg.model.api).toBe("openai-completions");
    expect(cfg.defaultTimeoutMinutes).toBe(30);
    expect(cfg.tools).toContain("read");
    expect(cfg.commitLeftoversEnabled).toBe(false);
  });

  it("reads promoted first-class fields (tools, worker.commitLeftovers)", () => {
    const cfg = loadConfig(writeJson({
      vaultRoot: "/v",
      tools: ["read", "bash"],
      worker: { commitLeftovers: true, maxConcurrent: 3 },
    }));
    expect(cfg.tools).toEqual(["read", "bash"]);
    expect(cfg.commitLeftoversEnabled).toBe(true);
    expect(cfg.maxConcurrent).toBe(3);
  });

  it("reads camelCase model + observability fields", () => {
    const cfg = loadConfig(writeJson({
      vaultRoot: "/v",
      model: { id: "p/m", baseUrl: "http://h:9/v1", apiKey: "k", contextWindow: 4096 },
      observability: { healthPort: 9999, logLevel: "debug" },
    }));
    expect(cfg.model.id).toBe("p/m");
    expect(cfg.model.contextWindow).toBe(4096);
    expect(cfg.healthPort).toBe(9999);
    expect(cfg.logLevel).toBe("debug");
  });

  it("merges model.compat onto DEFAULT_COMPAT (camelCase keys, no camelization)", () => {
    const cfg = loadConfig(writeJson({
      vaultRoot: "/v",
      model: { compat: { supportsDeveloperRole: true, customKey: 1 } },
    }));
    expect(cfg.model.compat.supportsDeveloperRole).toBe(true);
    expect((cfg.model.compat as Record<string, unknown>).customKey).toBe(1);
    expect(cfg.model.compat.maxTokensField).toBe("max_tokens"); // default preserved
  });

  it("expands ~ in path fields and derives github cross-field defaults", () => {
    const cfg = loadConfig(writeJson({
      vaultRoot: "~/Junco",
      observability: { stateDir: "/state" },
      github: { enabled: true, triggerLabel: "bot" },
    }));
    expect(cfg.vaultRoot).not.toContain("~");
    expect(cfg.github.askLabel).toBe("bot:ask");
    expect(cfg.github.externalReposRoot).toBe("/state/external");
    expect(cfg.github.plannerModelId).toBeNull();
  });

  it("throws a clear error when vaultRoot is missing", () => {
    expect(() => loadConfig(writeJson({ model: { id: "x" } }))).toThrow(/vaultRoot/);
  });

  it("throws a friendly error on malformed JSON", () => {
    const p = writeRaw("config.json", "{ not json");
    expect(() => loadConfig(p)).toThrow(/not valid JSON/);
  });

  it("guards a leftover config.toml where config.json is expected", () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-cfg-"));
    writeFileSync(join(dir, "config.toml"), 'vault_root = "/v"\n', "utf8");
    expect(() => loadConfig(join(dir, "config.json"))).toThrow(/TOML config was removed/);
  });
});

describe("resolveConfigPath / defaultUserConfigPath", () => {
  it("defaults to config.json under XDG", () => {
    expect(defaultUserConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/junco/config.json");
  });
  it("prefers ./config.json when present", () => {
    expect(resolveConfigPath(undefined, { existsFn: (p) => p.endsWith("config.json"), cwd: () => "/w" }))
      .toBe("/w/config.json");
  });
});

describe("queuePaths", () => {
  it("derives queue paths under vaultRoot/juncoSubdir", () => {
    const paths = queuePaths({ vaultRoot: "/v", juncoSubdir: "Junco" } as any);
    expect(paths.inbox).toBe("/v/Junco/inbox");
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run tests/config.test.ts > /tmp/t1.out 2>&1; echo "exit: $?"`
Expected: FAIL (old `loadConfig` still parses TOML; new fields/guards absent).

- [ ] **Step 3: Rewrite `src/config.ts`.**

Replace the `smol-toml` import and `TomlSchema`/`loadConfig`/`toolsFromExtraArgs`/`camelizeKeys` with the JSON pipeline. Keep `expandHome`, `isLoopbackHost`, `HEALTH_TIMEOUT_MS`, `queuePaths`, `DEFAULT_COMPAT`, `DEFAULT_TOOLS`, `ResolveConfigDeps`.

Top of file — drop `import { parse as parseToml } from "smol-toml";`. Keep `readFileSync, existsSync` and add nothing new.

Path helpers — change the basename:

```ts
export function defaultUserConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
    ? env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  return join(base, "junco", "config.json");
}
// resolveConfigPath: replace the two "config.toml" literals with "config.json".
```

The schema (camelCase, sectioned, shims dropped, `tools` + `worker.commitLeftovers` promoted):

```ts
const ConfigSchema = z.object({
  vaultRoot: z.string({ required_error: "config: vaultRoot is required" }),
  juncoSubdir: z.string().default("Junco"),
  tools: z.array(z.string()).default(DEFAULT_TOOLS),
  model: z.object({
    id: z.string().default("local/my-model"),
    modelsJson: z.string().optional(),
    api: z.string().default("openai-completions"),
    baseUrl: z.string().default("http://127.0.0.1:1234/v1"),
    apiKey: z.string().default("1234"),
    reasoning: z.boolean().default(true),
    input: z.array(z.string()).default(["text", "image"]),
    contextWindow: z.number().default(131072),
    maxTokens: z.number().default(49152),
    cost: z.object({
      input: z.number().default(0),
      output: z.number().default(0),
      cacheRead: z.number().default(0),
      cacheWrite: z.number().default(0),
    }).default({}),
    thinkingLevel: z.string().default("medium"),
    compat: z.record(z.unknown()).default({}),
  }).default({}),
  worker: z.object({
    defaultTimeoutMinutes: z.number().min(1).default(30),
    pollIntervalSeconds: z.number().min(1).default(15),
    startupPollSeconds: z.number().min(1).default(30),
    startupWait: z.boolean().default(true),
    maxTransientRetries: z.number().int().min(0).default(2),
    retryBackoffSeconds: z.number().min(0).default(60),
    maxConcurrent: z.number().int().min(1).default(1),
    commitLeftovers: z.boolean().default(false),
  }).default({}),
  supervisor: z.object({
    enabled: z.boolean().default(true),
    budgetPerKind: z.number().default(1),
    escalationWindowTurns: z.number().default(3),
    outputBudgetPerTurn: z.number().default(12000),
    outputBudgetPostCommit: z.number().default(24000),
  }).default({}),
  git: z.object({
    gitBin: z.string().default("git"),
    ghBin: z.string().default("gh"),
    defaultBaseBranch: z.string().default("main"),
    branchPrefix: z.string().default("junco/"),
    worktreeRoot: z.string().default("~/junco/worktrees"),
    removeWorktreeOnSuccess: z.boolean().default(true),
    allowedRepoRoots: z.array(z.string()).default([]),
  }).default({}),
  pr: z.object({
    draftByDefault: z.boolean().default(true),
    defaultLabels: z.array(z.string()).default([]),
  }).default({}),
  verify: z.object({
    enabled: z.boolean().default(true),
    commandTimeout: z.number().min(1).default(60),
    blockOnFail: z.boolean().default(false),
  }).default({}),
  critic: z.object({
    enabled: z.boolean().default(true),
    maxRetries: z.number().default(1),
    thinking: z.string().default("minimal"),
  }).default({}),
  planLint: z.object({
    enabled: z.boolean().default(true),
    blockOnError: z.boolean().default(true),
    checkLabels: z.boolean().default(true),
  }).default({}),
  observability: z.object({
    healthEnabled: z.boolean().default(true),
    healthHost: z.string().default("127.0.0.1").transform((h) => (h.trim() === "" ? "127.0.0.1" : h)),
    healthPort: z.number().int().min(1).max(65535).default(8787),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    stateDir: z.string().default("~/.local/state/junco"),
    logToFile: z.boolean().default(true),
    transcripts: z.boolean().default(true),
  }).default({}),
  github: z.object({
    enabled: z.boolean().default(false),
    triggerLabel: z.string().min(1).default("junco"),
    askLabel: z.string().min(1).optional(),
    pollIntervalSeconds: z.number().min(5).default(60),
    requireApproval: z.boolean().default(true),
    plannerModelId: z.string().min(1).optional(),
    externalReposRoot: z.string().min(1).optional(),
    repos: z.array(z.object({
      nwo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "github.repos[].nwo must be owner/repo"),
      path: z.string().min(1),
    })).default([]),
  }).default({}),
  assess: z.object({
    maxIssuesPerRun: z.number().int().min(1).default(20),
    minSeverity: z.enum(["critical", "high", "medium", "low"]).default("low"),
    npmBin: z.string().min(1).default("npm"),
  }).default({}),
});

export type ConfigParsed = z.infer<typeof ConfigSchema>;
```

The parse/assemble/load trio:

```ts
export function parseConfigFile(path: string): ConfigParsed {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (path.endsWith(".json")) {
      const tomlPath = path.slice(0, -".json".length) + ".toml";
      if (existsSync(tomlPath)) {
        throw new Error(
          `config: found ${tomlPath} but TOML config was removed — convert it to ${path} ` +
            `(see docs/configuration.md). Your config.toml is untouched.`,
        );
      }
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`config: ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return ConfigSchema.parse(raw);
}

export function assembleConfig(d: ConfigParsed): Config {
  return {
    vaultRoot: expandHome(d.vaultRoot),
    juncoSubdir: d.juncoSubdir,
    tools: d.tools,
    model: {
      id: d.model.id,
      modelsJson: d.model.modelsJson ? expandHome(d.model.modelsJson) : null,
      api: d.model.api,
      baseUrl: d.model.baseUrl,
      apiKey: d.model.apiKey,
      reasoning: d.model.reasoning,
      input: d.model.input,
      contextWindow: d.model.contextWindow,
      maxTokens: d.model.maxTokens,
      cost: {
        input: d.model.cost.input,
        output: d.model.cost.output,
        cacheRead: d.model.cost.cacheRead,
        cacheWrite: d.model.cost.cacheWrite,
      },
      thinkingLevel: d.model.thinkingLevel,
      compat: { ...DEFAULT_COMPAT, ...d.model.compat },
    },
    defaultTimeoutMinutes: d.worker.defaultTimeoutMinutes,
    pollIntervalSeconds: d.worker.pollIntervalSeconds,
    startupPollSeconds: d.worker.startupPollSeconds,
    startupWait: d.worker.startupWait,
    maxTransientRetries: d.worker.maxTransientRetries,
    retryBackoffSeconds: d.worker.retryBackoffSeconds,
    maxConcurrent: d.worker.maxConcurrent,
    commitLeftoversEnabled: d.worker.commitLeftovers,
    supervisorEnabled: d.supervisor.enabled,
    supervisorBudgetPerKind: d.supervisor.budgetPerKind,
    supervisorEscalationWindow: d.supervisor.escalationWindowTurns,
    supervisorOutputBudgetPerTurn: d.supervisor.outputBudgetPerTurn,
    supervisorOutputBudgetPostCommit: d.supervisor.outputBudgetPostCommit,
    gitBin: d.git.gitBin,
    ghBin: d.git.ghBin,
    defaultBaseBranch: d.git.defaultBaseBranch,
    branchPrefix: d.git.branchPrefix,
    worktreeRoot: expandHome(d.git.worktreeRoot),
    removeWorktreeOnSuccess: d.git.removeWorktreeOnSuccess,
    allowedRepoRoots: d.git.allowedRepoRoots.map(expandHome),
    draftByDefault: d.pr.draftByDefault,
    defaultLabels: d.pr.defaultLabels,
    verifyEnabled: d.verify.enabled,
    verifyCommandTimeout: d.verify.commandTimeout,
    verifyBlockOnFail: d.verify.blockOnFail,
    criticEnabled: d.critic.enabled,
    criticMaxRetries: d.critic.maxRetries,
    criticThinking: d.critic.thinking,
    planLintEnabled: d.planLint.enabled,
    planLintBlockOnError: d.planLint.blockOnError,
    planLintCheckLabels: d.planLint.checkLabels,
    healthEnabled: d.observability.healthEnabled,
    healthHost: d.observability.healthHost,
    healthPort: d.observability.healthPort,
    logLevel: d.observability.logLevel,
    stateDir: expandHome(d.observability.stateDir),
    logToFile: d.observability.logToFile,
    transcriptsEnabled: d.observability.transcripts,
    github: {
      enabled: d.github.enabled,
      triggerLabel: d.github.triggerLabel,
      askLabel: d.github.askLabel ?? `${d.github.triggerLabel}:ask`,
      pollIntervalSeconds: d.github.pollIntervalSeconds,
      requireApproval: d.github.requireApproval,
      plannerModelId: d.github.plannerModelId ?? null,
      externalReposRoot: expandHome(d.github.externalReposRoot ?? join(d.observability.stateDir, "external")),
      repos: d.github.repos.map((r) => ({ nwo: r.nwo, path: expandHome(r.path) })),
    },
    assess: {
      maxIssuesPerRun: d.assess.maxIssuesPerRun,
      minSeverity: d.assess.minSeverity,
      npmBin: d.assess.npmBin,
    },
  };
}

export function loadConfig(path: string): Config {
  return assembleConfig(parseConfigFile(path));
}
```

Delete `toolsFromExtraArgs` and `camelizeKeys` and the `oMLX`/`omlx` reconciliation block entirely.

- [ ] **Step 4: Rewrite the wizard renderer (`src/wizard.ts`).**

Replace `renderConfigToml` with `renderConfigJson` (drop the `tomlStr` helper and the commented GitHub block — JSON has no comments; `docs/configuration.md` + `junco config list` carry that guidance). Update the call site in `runWizard` (the `writeFileFn(configPath, renderConfigToml(...))` line) and any doc-comment mentioning `config.toml`.

```ts
/** Render a minimal config.json from the wizard answers. Pure — output must
 * round-trip through loadConfig. Writes juncoSubdir:"" so the queue lives
 * directly under vaultRoot. */
export function renderConfigJson(a: WizardAnswers): string {
  const model: Record<string, unknown> = { id: a.modelId };
  if (a.mode === "models_json") {
    model.modelsJson = a.modelsJson ?? "~/.pi/agent/models.json";
  } else {
    model.baseUrl = a.baseUrl ?? "http://127.0.0.1:1234/v1";
    model.apiKey = a.apiKey ?? "";
  }
  return JSON.stringify({ vaultRoot: a.vaultRoot, juncoSubdir: "", model }, null, 2) + "\n";
}
```

In `runWizard`, the config path is derived from the resolver, so writing to it needs no change beyond `renderConfigToml(answers)` → `renderConfigJson(answers)`.

- [ ] **Step 5: Remove the dependency.**

Run: `npm uninstall smol-toml`
Expected: `smol-toml` gone from `package.json` `dependencies` and `package-lock.json`.
Verify: `grep -rn "smol-toml" src/ package.json` prints nothing.

- [ ] **Step 6: Update `tests/wizard.test.ts`.**

Change `renderConfigToml` → `renderConfigJson` and assert JSON round-trips through `loadConfig` instead of asserting TOML text. Representative:

```ts
it("renders a config.json that round-trips through loadConfig", () => {
  const json = renderConfigJson({ vaultRoot: "/v", mode: "inline", modelId: "p/m", baseUrl: "http://h/v1", apiKey: "k" });
  const parsed = JSON.parse(json);
  expect(parsed).toMatchObject({ vaultRoot: "/v", juncoSubdir: "", model: { id: "p/m", baseUrl: "http://h/v1" } });
  const dir = mkdtempSync(join(tmpdir(), "wiz-")); const p = join(dir, "config.json");
  writeFileSync(p, json, "utf8");
  expect(loadConfig(p).model.id).toBe("p/m");
});
```

Any test that asserted the wizard wrote a `config.toml` path must expect `config.json`.

- [ ] **Step 7: Fix the string/path coupling in the other tests.**

These reference `config.toml` only as a path string or as written body. Update each occurrence to `config.json` and (where a TOML body was written and then loaded) to a JSON body. Files: `tests/{doctor,cli,service,restartCmd,dashboardCmd,prsCmd,tuiCliRunner,tuiApp}.test.ts`, `tests/helpers/localFixtures.tsx`. Grep-drive it:

Run: `grep -rn "config\.toml\|writeToml\|parseToml\|renderConfigToml" tests/`
For each hit: rename `config.toml`→`config.json`; if the test writes a TOML *body* through `loadConfig`, replace it with `JSON.stringify({ vaultRoot: ... })`; if it only builds a `Config` literal, leave the literal (only fix an incidental `config.toml` path string).

- [ ] **Step 8: Run the full suite.**

Run: `npx vitest run > /tmp/t1full.out 2>&1; echo "exit: $?"`
Expected: PASS (exit 0). Investigate any file still assuming TOML.

- [ ] **Step 9: Typecheck + format, then commit.**

Run: `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/t1tc.out 2>&1; echo "exit: $?"` (ignore the ~57 pre-existing unrelated errors noted in project memory; ensure no *new* config-related ones).
Run: `npx prettier --write src/config.ts src/wizard.ts tests/config.test.ts tests/wizard.test.ts`

```bash
git add -A
git commit -m "feat(config): load config.json (camelCase, no shims); remove smol-toml"
```

---

## Task 2: Lever registry + drift test

**Files:**
- Create: `src/configLevers.ts`
- Test: `tests/configLevers.test.ts`

**Interfaces:**
- Produces: `Lever` interface; `LEVERS: Lever[]`; `getAtPath(obj, path): unknown`; `setAtPath(obj, path, value): void` (mutates, creating intermediate objects); `leverAtPath(path): Lever | undefined`.
- Consumes: `ConfigParsed` shape / `ConfigSchema` from `src/config.ts` (export `ConfigSchema` for the drift test).

- [ ] **Step 1: Export the schema for the drift test.** In `src/config.ts`, add `export` to `const ConfigSchema` (leave everything else).

- [ ] **Step 2: Write the failing drift test (`tests/configLevers.test.ts`).**

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { LEVERS, getAtPath, setAtPath, leverAtPath } from "../src/configLevers.js";
import { ConfigSchema } from "../src/config.js";

// Walk a zod object schema to dotted leaf paths, capturing default + kind.
function schemaLeaves(schema: z.ZodTypeAny, prefix = ""): { path: string; def: z.ZodTypeAny }[] {
  let s = schema;
  while (s instanceof z.ZodDefault || s instanceof z.ZodOptional || s instanceof z.ZodEffects) {
    s = s instanceof z.ZodEffects ? s._def.schema : s._def.innerType;
  }
  if (s instanceof z.ZodObject) {
    return Object.entries(s.shape).flatMap(([k, v]) =>
      schemaLeaves(v as z.ZodTypeAny, prefix ? `${prefix}.${k}` : k));
  }
  return [{ path: prefix, def: schema }];
}

describe("LEVERS ↔ schema bijection", () => {
  const leafPaths = schemaLeaves(ConfigSchema).map((l) => l.path).sort();
  const leverPaths = LEVERS.map((l) => l.path).sort();

  it("has exactly one lever per schema leaf (no missing, no orphan)", () => {
    expect(leverPaths).toEqual(leafPaths);
  });
  it("gives every lever a reload classification", () => {
    for (const l of LEVERS) expect(["live", "restart"]).toContain(l.reload);
  });
  it("marks structured levers non-editable", () => {
    for (const l of LEVERS) if (l.type === "structured") expect(l.editable).toBe(false);
  });
});

describe("path helpers", () => {
  it("gets and sets nested dotted paths", () => {
    const obj: Record<string, unknown> = {};
    setAtPath(obj, "worker.maxConcurrent", 4);
    expect(getAtPath(obj, "worker.maxConcurrent")).toBe(4);
    expect(obj).toEqual({ worker: { maxConcurrent: 4 } });
  });
  it("leverAtPath finds a lever", () => {
    expect(leverAtPath("worker.maxConcurrent")?.type).toBe("number");
  });
});
```

- [ ] **Step 3: Run to verify failure.**

Run: `npx vitest run tests/configLevers.test.ts > /tmp/t2.out 2>&1; echo "exit: $?"`
Expected: FAIL (module not found).

- [ ] **Step 4: Write `src/configLevers.ts`.**

Type + helpers, then the full `LEVERS` array. **Completeness is enforced by the drift test in Step 2** — every schema leaf below must have exactly one entry. Assign `type`/`editable`/`reload` by these rules:
- `type`: `model.apiKey`→`secret`; `tools`,`pr.defaultLabels`,`git.allowedRepoRoots`,`model.input`,`model.compat`,`model.cost`,`github.repos`→`structured`(`editable:false`); zod enum→`enum`(list `enumValues`); zod number→`number`(copy `min`/`max` from the schema); zod boolean→`boolean`; else→`string`. All non-structured levers are `editable:true`.
- `reload`: **`restart`** for `vaultRoot`, `juncoSubdir`, `github.enabled`, and `observability.{healthEnabled,healthHost,healthPort,stateDir,logToFile,transcripts}`. **`live`** for everything else — including `observability.logLevel` (the watcher re-applies it via `setLogLevel`) and `worker.maxConcurrent`.
- `default`: copy the schema default verbatim.
- `description`: one sentence; reuse the prose already in `src/config.ts` / `src/types.ts` comments.

```ts
export interface Lever {
  path: string;
  type: "boolean" | "number" | "enum" | "string" | "secret" | "structured";
  default: unknown;
  editable: boolean;
  reload: "live" | "restart";
  description: string;
  enumValues?: string[];
  min?: number;
  max?: number;
}

export function getAtPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), obj);
}

export function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

export const LEVERS: Lever[] = [
  { path: "vaultRoot", type: "string", default: undefined, editable: true, reload: "restart",
    description: "Root directory Junco keeps its ticket queue under." },
  { path: "juncoSubdir", type: "string", default: "Junco", editable: true, reload: "restart",
    description: "Subdirectory under vaultRoot holding inbox/processing/done/failed." },
  { path: "tools", type: "structured", default: ["read","bash","edit","write","grep","find","ls"], editable: false, reload: "live",
    description: "Tool allowlist granted to the coding agent." },
  // --- model.* ---
  { path: "model.id", type: "string", default: "local/my-model", editable: true, reload: "live",
    description: "Provider-prefixed model id, e.g. openai/gpt-4o-mini." },
  { path: "model.apiKey", type: "secret", default: "1234", editable: true, reload: "live",
    description: "API key for the inference endpoint." },
  { path: "model.baseUrl", type: "string", default: "http://127.0.0.1:1234/v1", editable: true, reload: "live",
    description: "OpenAI-compatible /v1 endpoint base URL." },
  { path: "model.maxTokens", type: "number", default: 49152, editable: true, reload: "live",
    description: "Max output tokens per model call." },
  { path: "model.thinkingLevel", type: "string", default: "medium", editable: true, reload: "live",
    description: "Worker default reasoning/thinking level." },
  // ... model.{modelsJson,api,reasoning,input,contextWindow,cost,compat} ...
  // --- worker.* ---
  { path: "worker.maxConcurrent", type: "number", default: 1, min: 1, editable: true, reload: "live",
    description: "Parallel ticket slots; same-repo tickets always serialize." },
  { path: "worker.pollIntervalSeconds", type: "number", default: 15, min: 1, editable: true, reload: "live",
    description: "Seconds between inbox polls when idle." },
  { path: "worker.commitLeftovers", type: "boolean", default: false, editable: true, reload: "live",
    description: "Sweep uncommitted leftovers into a final commit at run end." },
  // ... worker.{defaultTimeoutMinutes,startupPollSeconds,startupWait,maxTransientRetries,retryBackoffSeconds} ...
  // --- observability.* ---
  { path: "observability.logLevel", type: "enum", enumValues: ["debug","info","warn","error"], default: "info", editable: true, reload: "live",
    description: "Daemon-wide log threshold (applied live)." },
  { path: "observability.healthPort", type: "number", default: 8787, min: 1, max: 65535, editable: true, reload: "restart",
    description: "Port the /health metrics server binds (restart to rebind)." },
  { path: "observability.healthHost", type: "string", default: "127.0.0.1", editable: true, reload: "restart",
    description: "Bind address for /health; non-loopback exposes metrics (restart to rebind)." },
  // ... observability.{healthEnabled(restart),stateDir(restart),logToFile(restart),transcripts(restart)} ...
  // --- supervisor.*, git.*, pr.*, verify.*, critic.*, planLint.*, github.*, assess.* (all live except github.enabled=restart) ---
  { path: "assess.minSeverity", type: "enum", enumValues: ["critical","high","medium","low"], default: "low", editable: true, reload: "live",
    description: "Drop assessment findings below this severity." },
];

export function leverAtPath(path: string): Lever | undefined {
  return LEVERS.find((l) => l.path === path);
}
```

Fill every remaining leaf (the `// ...` markers) following the rules above until the drift test's bijection assertion passes. `vaultRoot`'s `default` is `undefined` (it is `required`, no schema default) — the drift test's default check must treat a `required` field's default as `undefined` (adjust the walker to emit `undefined` for non-`ZodDefault` leaves).

- [ ] **Step 5: Run the drift test to green.**

Run: `npx vitest run tests/configLevers.test.ts > /tmp/t2b.out 2>&1; echo "exit: $?"`
Expected: PASS. If "no missing/no orphan" fails, the diff lists the exact missing/extra paths — add/remove them.

- [ ] **Step 6: Format + commit.**

Run: `npx prettier --write src/configLevers.ts tests/configLevers.test.ts src/config.ts`
```bash
git add -A
git commit -m "feat(config): lever registry + schema-bijection drift test"
```

---

## Task 3: `junco config` CLI

**Files:**
- Create: `src/configCmd.ts`
- Modify: `src/cli.ts` (register the `config` subcommand; add it to `USAGE`)
- Test: `tests/configCmd.test.ts`

**Interfaces:**
- Produces: `runConfigCommand(argv: string[], configPath: string, deps?: ConfigCmdDeps): number` where `ConfigCmdDeps = { readFileFn?; writeFileFn?; existsFn?; printFn?; errFn?; daemonRunningFn?: () => boolean }`. Subcommands: `path`, `list`, `get <path>`, `set <path> <value>`.
- Consumes: `LEVERS`, `getAtPath`, `setAtPath`, `leverAtPath` (Task 2); `parseConfigFile`, `loadConfig`, `resolveConfigPath` (Task 1).

- [ ] **Step 1: Write failing tests (`tests/configCmd.test.ts`).**

```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigCommand } from "../src/configCmd.js";

function fixture(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cfgcmd-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

describe("junco config", () => {
  it("path prints the resolved config path", () => {
    const p = fixture({ vaultRoot: "/v" });
    let out = "";
    expect(runConfigCommand(["path"], p, { printFn: (s) => (out += s) })).toBe(0);
    expect(out.trim()).toBe(p);
  });

  it("get prints the effective value (default when unset)", () => {
    const p = fixture({ vaultRoot: "/v" });
    let out = "";
    runConfigCommand(["get", "worker.maxConcurrent"], p, { printFn: (s) => (out += s) });
    expect(out.trim()).toBe("1");
  });

  it("set coerces a number and writes sparsely", () => {
    const p = fixture({ vaultRoot: "/v" });
    expect(runConfigCommand(["set", "worker.maxConcurrent", "3"], p, { printFn: () => {} })).toBe(0);
    const raw = JSON.parse(readFileSync(p, "utf8"));
    expect(raw.worker.maxConcurrent).toBe(3);
    expect(raw.vaultRoot).toBe("/v"); // untouched keys preserved, nothing else added
    expect(Object.keys(raw)).toEqual(["vaultRoot", "worker"]);
  });

  it("set coerces booleans and enums", () => {
    const p = fixture({ vaultRoot: "/v" });
    runConfigCommand(["set", "verify.enabled", "false"], p, { printFn: () => {} });
    runConfigCommand(["set", "observability.logLevel", "debug"], p, { printFn: () => {} });
    const raw = JSON.parse(readFileSync(p, "utf8"));
    expect(raw.verify.enabled).toBe(false);
    expect(raw.observability.logLevel).toBe("debug");
  });

  it("set rejects a structured path", () => {
    const p = fixture({ vaultRoot: "/v" });
    let err = "";
    expect(runConfigCommand(["set", "tools", "read"], p, { errFn: (s) => (err += s) })).toBe(1);
    expect(err).toMatch(/edit config\.json directly/);
  });

  it("set rejects a bad enum value and writes nothing", () => {
    const p = fixture({ vaultRoot: "/v" });
    const before = readFileSync(p, "utf8");
    expect(runConfigCommand(["set", "observability.logLevel", "loud"], p, { errFn: () => {} })).toBe(1);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("set rejects an out-of-range number", () => {
    const p = fixture({ vaultRoot: "/v" });
    expect(runConfigCommand(["set", "worker.maxConcurrent", "0"], p, { errFn: () => {} })).toBe(1);
  });

  it("list masks secrets", () => {
    const p = fixture({ vaultRoot: "/v", model: { apiKey: "supersecret" } });
    let out = "";
    runConfigCommand(["list"], p, { printFn: (s) => (out += s) });
    expect(out).not.toContain("supersecret");
    expect(out).toContain("model.apiKey");
  });

  it("set warns to restart only for restart-kind levers", () => {
    const p = fixture({ vaultRoot: "/v" });
    let out = "";
    runConfigCommand(["set", "observability.healthPort", "9000"], p, { printFn: (s) => (out += s), daemonRunningFn: () => true });
    expect(out).toMatch(/restart/i);
    out = "";
    runConfigCommand(["set", "worker.pollIntervalSeconds", "20"], p, { printFn: (s) => (out += s), daemonRunningFn: () => true });
    expect(out).not.toMatch(/restart/i);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run tests/configCmd.test.ts > /tmp/t3.out 2>&1; echo "exit: $?"`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/configCmd.ts`.**

```ts
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEVERS, getAtPath, setAtPath, leverAtPath, coerceLever, type Lever } from "./configLevers.js";
import { validateConfigObject } from "./config.js";

export interface ConfigCmdDeps {
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  existsFn?: (p: string) => boolean;
  printFn?: (s: string) => void;
  errFn?: (s: string) => void;
  daemonRunningFn?: () => boolean;
}

// coerceLever lives in configLevers.ts (shared with the TUI view) — see Task 2/3 Step 3a.

function maskFor(lever: Lever, value: unknown): unknown {
  return lever.type === "secret" && typeof value === "string" && value.length > 0 ? "••••" : value;
}

/** Effective value at a lever's path: the raw file value if present, else the default. */
function getEffective(
  readFile: (p: string) => string,
  exists: (p: string) => boolean,
  configPath: string,
  lever: Lever,
): unknown {
  if (!exists(configPath)) return lever.default;
  const raw = JSON.parse(readFile(configPath)) as Record<string, unknown>;
  const v = getAtPath(raw, lever.path);
  return v === undefined ? lever.default : v;
}

export function runConfigCommand(argv: string[], configPath: string, deps: ConfigCmdDeps = {}): number {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const err = deps.errFn ?? ((s: string) => process.stderr.write(s));
  const readFile = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const exists = deps.existsFn ?? existsSync;
  const [sub, ...rest] = argv;

  if (sub === "path") { print(configPath + "\n"); return 0; }

  if (sub === "list") {
    for (const l of LEVERS) {
      const cur = getEffective(readFile, exists, configPath, l);
      const val = maskFor(l, cur);
      const meta = l.type === "enum" ? l.enumValues?.join("|") : l.type;
      print(`${l.path}\t= ${JSON.stringify(val)} (default ${JSON.stringify(l.default)}) [${meta}${l.editable ? "" : ", read-only"}]  ${l.description}\n`);
    }
    return 0;
  }

  if (sub === "get") {
    const l = leverAtPath(rest[0]);
    if (!l) { err(`config: unknown path '${rest[0]}'\n`); return 1; }
    print(JSON.stringify(getEffective(readFile, exists, configPath, l)) + "\n");
    return 0;
  }

  if (sub === "set") {
    const [path, ...valueParts] = rest;
    const l = leverAtPath(path);
    if (!l) { err(`config: unknown path '${path}'\n`); return 1; }
    if (!l.editable) { err(`config: '${path}' is structured — edit config.json directly\n`); return 1; }
    const c = coerceLever(l, valueParts.join(" "));
    if ("error" in c) { err(`config: ${path}: ${c.error}\n`); return 1; }
    // Mutate raw (sparse), validate a defaulted copy via the schema, then atomic write.
    const raw = exists(configPath) ? (JSON.parse(readFile(configPath)) as Record<string, unknown>) : {};
    const old = getEffective(readFile, exists, configPath, l);
    setAtPath(raw, path, c.value);
    try { validateConfigObject(raw); } catch (e) { err(`config: ${e instanceof Error ? e.message : String(e)}\n`); return 1; }
    const tmp = join(dirname(configPath), `.config.json.tmp-${process.pid}`);
    writeFile(tmp, JSON.stringify(raw, null, 2) + "\n");
    renameSync(tmp, configPath);
    print(`${path}: ${JSON.stringify(old)} → ${JSON.stringify(c.value)}\n`);
    if (l.reload === "restart" && deps.daemonRunningFn?.()) print(`(restart the daemon to apply: junco restart)\n`);
    return 0;
  }

  err(`config: unknown subcommand '${sub ?? ""}' (path|list|get|set)\n`);
  return 1;
}

// helpers: getEffective reads raw value at path, else lever.default; validate via schema on a parsed copy.
```

`getEffective` and `maskFor` are defined inline above; `coerceLever` is imported from `configLevers.ts` (Step 3a) and `validateConfigObject` from `config.ts` (Step 4).

- [ ] **Step 3a: Add `coerceLever` to `src/configLevers.ts`** (shared by this CLI and the TUI view in Task 7):

```ts
export function coerceLever(lever: Lever, raw: string): { value: unknown } | { error: string } {
  switch (lever.type) {
    case "boolean":
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return { error: "expected true|false" };
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: "expected a number" };
      if (lever.min !== undefined && n < lever.min) return { error: `must be >= ${lever.min}` };
      if (lever.max !== undefined && n > lever.max) return { error: `must be <= ${lever.max}` };
      return { value: n };
    }
    case "enum":
      if (!lever.enumValues?.includes(raw)) return { error: `expected one of ${lever.enumValues?.join("|")}` };
      return { value: raw };
    case "string":
    case "secret":
      return { value: raw };
    default:
      return { error: "structured — edit config.json directly" };
  }
}
```

- [ ] **Step 4: Add `validateConfigObject` to `src/config.ts`.**

```ts
export function validateConfigObject(obj: unknown): void {
  ConfigSchema.parse(obj);
}
```

- [ ] **Step 5: Wire into `src/cli.ts`.** Add before the unknown-subcommand fallback:

```ts
if (subcommand === "config") {
  return runConfigCommand(positionals.slice(1), configPath, {});
}
```

Add `config` to the `USAGE` string with a one-line description. Import `runConfigCommand` (lazy import consistent with neighbors like `prs`/`assess` if that's the pattern).

- [ ] **Step 6: Run tests + typecheck.**

Run: `npx vitest run tests/configCmd.test.ts > /tmp/t3b.out 2>&1; echo "exit: $?"`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.eslint.json 2>&1 | grep -c configCmd` → expect `0`.

- [ ] **Step 7: Format + commit.**

Run: `npx prettier --write src/configCmd.ts src/config.ts src/cli.ts tests/configCmd.test.ts`
```bash
git add -A
git commit -m "feat(config): junco config path/list/get/set CLI"
```

---

## Task 4: metrics `pendingRestartFields` + status surfacing

**Files:**
- Modify: `src/metrics.ts` (field + snapshot + reset + `addPendingRestartFields`)
- Modify: `src/statusCmd.ts` (display line)
- Test: `tests/metrics.test.ts` (add cases), `tests/statusCmd.test.ts` (add a case)

**Interfaces:**
- Produces: `metrics.addPendingRestartFields(fields: string[]): void`; `MetricsSnapshot.pendingRestartFields: string[]`.
- Consumes: the existing `RunMetrics`/`snapshot()` (Task 4 is independent of Tasks 2–3).

- [ ] **Step 1: Add failing metrics test (`tests/metrics.test.ts`).**

```ts
it("accumulates and de-dups pending restart fields in the snapshot", () => {
  metrics.reset();
  metrics.addPendingRestartFields(["observability.healthPort", "vaultRoot"]);
  metrics.addPendingRestartFields(["vaultRoot"]);
  expect(metrics.snapshot().pendingRestartFields).toEqual(["observability.healthPort", "vaultRoot"]);
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run tests/metrics.test.ts > /tmp/t4.out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement in `src/metrics.ts`.**
- Add private `private _pendingRestartFields = new Set<string>();`.
- Add method: `addPendingRestartFields(fields: string[]): void { for (const f of fields) this._pendingRestartFields.add(f); }`
- In `snapshot()` return object add: `pendingRestartFields: [...this._pendingRestartFields].sort(),`
- In `reset()` add: `this._pendingRestartFields = new Set();`
- In `MetricsSnapshot` interface add: `pendingRestartFields: string[]; // config levers changed live that need a restart`

- [ ] **Step 4: Surface in `src/statusCmd.ts`.** After the existing health render, when `snap.pendingRestartFields.length > 0`, print a warning line:

```ts
if (snap.pendingRestartFields.length > 0) {
  printFn(`⚠ config changed — restart to apply: ${snap.pendingRestartFields.join(", ")}\n`);
}
```

Add a `tests/statusCmd.test.ts` case: a fake `/health` body including `pendingRestartFields: ["observability.healthPort"]` → output contains "restart to apply".

- [ ] **Step 5: Run + format + commit.**

Run: `npx vitest run tests/metrics.test.ts tests/statusCmd.test.ts > /tmp/t4b.out 2>&1; echo "exit: $?"` → PASS.
Run: `npx prettier --write src/metrics.ts src/statusCmd.ts tests/metrics.test.ts tests/statusCmd.test.ts`
```bash
git add -A
git commit -m "feat(metrics): expose pendingRestartFields; surface in junco status"
```

---

## Task 5: ConfigHolder + config watcher

**Files:**
- Create: `src/configWatcher.ts`
- Test: `tests/configWatcher.test.ts`

**Interfaces:**
- Produces: `interface ConfigHolder { current: Config }`; `makeConfigHolder(initial: Config): ConfigHolder`; `watchConfig(configPath, holder, deps?): { close(): void }` where deps = `{ watchFn?; loadFn?: (p)=>Config; parseFn?: (p)=>ConfigParsed; setLogLevelFn?; onRestartFields?: (f: string[]) => void; logFn?; debounceMs?; scheduleFn?: (cb, ms) => { cancel(): void } }`.
- Consumes: `loadConfig`/`parseConfigFile`/`ConfigParsed` (Task 1); `LEVERS`/`getAtPath` (Task 2); `setLogLevel` (`src/logging.ts`); `metrics.addPendingRestartFields` (Task 4).

- [ ] **Step 1: Write failing tests (`tests/configWatcher.test.ts`).**

Drive the watcher with an injected `watchFn` (captures the listener) and injected `parseFn`/`loadFn` returning canned objects, so no real fs events fire. Use an injected synchronous `scheduleFn` (run `cb` immediately) to make debounce deterministic.

```ts
import { describe, it, expect, vi } from "vitest";
import { makeConfigHolder, watchConfig } from "../src/configWatcher.js";

const baseConfig = { vaultRoot: "/v", logLevel: "info", healthPort: 8787 } as any;

function harness(seq: { parsed: any; config: any }[] | Error[]) {
  let fire: () => void = () => {};
  let i = 0;
  const setLog = vi.fn();
  const restart = vi.fn();
  const holder = makeConfigHolder(baseConfig);
  const handle = watchConfig("/dir/config.json", holder, {
    watchFn: (_dir, listener) => { fire = listener; return { close() {} }; },
    scheduleFn: (cb) => { cb(); return { cancel() {} }; },
    parseFn: () => { const s = seq[i]; if (s instanceof Error) throw s; return (s as any).parsed; },
    loadFn: () => { const s = seq[i++]; if (s instanceof Error) throw s; return (s as any).config; },
    setLogLevelFn: setLog,
    onRestartFields: restart,
  });
  return { fire: () => fire(), holder, setLog, restart, handle };
}

it("updates the holder and re-applies logLevel on a valid change", () => {
  const h = harness([
    { parsed: { vaultRoot: "/v", observability: { logLevel: "debug", healthPort: 8787 } },
      config: { ...baseConfig, logLevel: "debug" } },
  ]);
  h.fire();
  expect(h.holder.current.logLevel).toBe("debug");
  expect(h.setLog).toHaveBeenCalledWith("debug");
});

it("records restart-kind changes but not live ones", () => {
  // Watcher diffs the parsed file object at lever-path granularity.
  const h = harness([
    { parsed: { vaultRoot: "/v", observability: { healthPort: 9000 } },
      config: { ...baseConfig, healthPort: 9000 } },
  ]);
  h.fire();
  expect(h.restart).toHaveBeenCalledWith(expect.arrayContaining(["observability.healthPort"]));
});

it("keeps the last-good config when a reload fails", () => {
  const h = harness([new Error("bad json")]);
  const before = h.holder.current;
  h.fire();
  expect(h.holder.current).toBe(before);
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run tests/configWatcher.test.ts > /tmp/t5.out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement `src/configWatcher.ts`.**

```ts
import { watch } from "node:fs";
import { dirname, basename } from "node:path";
import type { Config } from "./types.js";
import { loadConfig, parseConfigFile, type ConfigParsed } from "./config.js";
import { LEVERS, getAtPath } from "./configLevers.js";
import { setLogLevel, log } from "./logging.js";
import { metrics } from "./metrics.js";

export interface ConfigHolder { current: Config; }
export function makeConfigHolder(initial: Config): ConfigHolder { return { current: initial }; }

const RESTART_PATHS = new Set(LEVERS.filter((l) => l.reload === "restart").map((l) => l.path));

export interface WatchConfigDeps {
  watchFn?: (dir: string, listener: () => void) => { close(): void };
  loadFn?: (p: string) => Config;
  parseFn?: (p: string) => ConfigParsed;
  setLogLevelFn?: (l: Config["logLevel"]) => void;
  onRestartFields?: (fields: string[]) => void;
  logFn?: { warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
  scheduleFn?: (cb: () => void, ms: number) => { cancel(): void };
  debounceMs?: number;
}

function changedLeverPaths(prev: ConfigParsed | null, next: ConfigParsed): string[] {
  if (!prev) return [];
  return LEVERS.filter((l) => JSON.stringify(getAtPath(prev, l.path)) !== JSON.stringify(getAtPath(next, l.path)))
    .map((l) => l.path);
}

export function watchConfig(configPath: string, holder: ConfigHolder, deps: WatchConfigDeps = {}): { close(): void } {
  const watchFn = deps.watchFn ?? ((dir, listener) => watch(dir, (_e, fn) => { if (fn === basename(configPath)) listener(); }));
  const loadFn = deps.loadFn ?? loadConfig;
  const parseFn = deps.parseFn ?? parseConfigFile;
  const setLogLevelFn = deps.setLogLevelFn ?? setLogLevel;
  const onRestartFields = deps.onRestartFields ?? ((f) => metrics.addPendingRestartFields(f));
  const logger = deps.logFn ?? log;
  const schedule = deps.scheduleFn ?? ((cb, ms) => { const t = setTimeout(cb, ms); return { cancel: () => clearTimeout(t) }; });
  const debounceMs = deps.debounceMs ?? 200;

  let prevParsed: ConfigParsed | null = null;
  try { prevParsed = parseFn(configPath); } catch { prevParsed = null; }
  let pending: { cancel(): void } | null = null;

  const reload = (): void => {
    let nextParsed: ConfigParsed;
    let nextConfig: Config;
    try { nextParsed = parseFn(configPath); nextConfig = loadFn(configPath); }
    catch (e) { logger.error("config reload failed; keeping previous config", { error: e instanceof Error ? e.message : String(e) }); return; }
    holder.current = nextConfig;
    setLogLevelFn(nextConfig.logLevel);
    const changed = changedLeverPaths(prevParsed, nextParsed);
    prevParsed = nextParsed;
    const restart = changed.filter((p) => RESTART_PATHS.has(p));
    if (restart.length > 0) { onRestartFields(restart); logger.warn("config changed; restart to apply", { fields: restart }); }
  };

  const watcher = watchFn(dirname(configPath), () => {
    if (pending) pending.cancel();
    pending = schedule(reload, debounceMs);
  });
  return { close: () => { if (pending) pending.cancel(); watcher.close(); } };
}
```

- [ ] **Step 4: Run tests to green.**

Run: `npx vitest run tests/configWatcher.test.ts > /tmp/t5b.out 2>&1; echo "exit: $?"` → PASS.

- [ ] **Step 5: Format + commit.**

Run: `npx prettier --write src/configWatcher.ts tests/configWatcher.test.ts`
```bash
git add -A
git commit -m "feat(config): ConfigHolder + directory-watching hot-reload watcher"
```

---

## Task 6: Wire hot-reload into the daemon

**Files:**
- Modify: `src/daemon.ts` (`mainLoop` + `runScheduler` read the holder per iteration)
- Modify: `src/cli.ts` (`start`: create holder, start watcher, pass holder into `mainLoop`)
- Test: `tests/daemon.test.ts` (add a hot-reload case)

**Interfaces:**
- Consumes: `ConfigHolder` (Task 5). `MainLoopDeps`/`SchedulerDeps` gain `configHolder?: ConfigHolder`.
- Produces: per-iteration `activeCfg()` behavior; setup-captured wiring stays on the initial `cfg`.

- [ ] **Step 1: Write a failing daemon test (`tests/daemon.test.ts`).**

Show that a holder update mid-run reaches the next `runOnce`. Use the existing daemon-test scaffolding and the real-tick yield.

```ts
it("mainLoop reads the holder each iteration (live reload reaches next runOnce)", async () => {
  const seen: number[] = [];
  const holder = makeConfigHolder({ ...cfg(), pollIntervalSeconds: 1 });
  const stop = new StopFlag();
  let n = 0;
  const runOnceFn = async (c: Config) => {
    seen.push(c.pollIntervalSeconds);
    if (n === 0) holder.current = { ...holder.current, pollIntervalSeconds: 99 };
    if (++n >= 2) stop.request();
    return true; // handled → loop continues without sleeping to idle
  };
  await mainLoop(holder.current, stop, {}, {
    configHolder: holder, runOnceFn,
    sleep: async () => { await new Promise((r) => setTimeout(r, 1)); },
    recoverOrphansFn: () => {}, pruneFn: () => {}, waitForEndpointFn: async () => {},
    mkdirs: () => {}, startHealthServerFn: async () => null as any,
  });
  expect(seen).toEqual([1, 99]);
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run tests/daemon.test.ts -t "reads the holder" > /tmp/t6.out 2>&1; echo "exit: $?"` → FAIL (mainLoop ignores holder).

- [ ] **Step 3: Implement in `src/daemon.ts`.**
- Add `configHolder?: ConfigHolder;` to `MainLoopDeps` and `SchedulerDeps` (import the type from `./configWatcher.js`).
- Near the top of `mainLoop`, after resolving deps: `const activeCfg = (): Config => deps.configHolder?.current ?? cfg;`
- In the serial loop body replace the per-iteration reads:
  - `const handled = await runOnceFn(cfg);` → `await runOnceFn(activeCfg());`
  - `await sleep(cfg.pollIntervalSeconds, stopFlag);` → `await sleep(activeCfg().pollIntervalSeconds, stopFlag);`
- In `maybeBridgeSweep`/`maybeOutboxDrain`, replace the closed-over `cfg` reads with `activeCfg()` (throttle comparison, `bridgeSweepFn(activeCfg())`, `outboxDepth(activeCfg())`, `outboxDrainFn(activeCfg())`).
- In the scheduler branch: `await runScheduler(activeCfg(), stopFlag, opts, { ...deps, configHolder: deps.configHolder, readyFn: () => endpointReachable(activeCfg()) });` and inside `runScheduler` add its own `activeCfg` and use it for the per-dispatch reads (`maxConcurrent`, poll sleep, `readyFn`). Leave `readinessProbe: () => endpointReachable(activeCfg())` on the health server so endpoint checks follow a live `baseUrl`.
- **Do NOT** change the setup-captured lines (`reporter`, `bridgeSweepFn` gating, `outboxDrainFn` gating, `startHealthServerFn` host/port, `mkdirs`, `recoverOrphans`, `pruneFn`, `waitForEndpoint`) — those intentionally use the initial `cfg` (restart-kind).

- [ ] **Step 4: Wire the watcher into `start` (`src/cli.ts`).** In the `start` handler, after `const cfg = loadConfigFn(configPath);` and lock acquisition:

```ts
const holder = makeConfigHolder(cfg);
const stopWatch = watchConfig(configPath, holder).close;
try {
  await mainLoopFn(cfg, stopFlag, { once: values.once as boolean }, { configHolder: holder });
  ...
} finally {
  stopWatch();
  ...existing teardown...
}
```

Import `makeConfigHolder`, `watchConfig` from `./configWatcher.js`. (If `mainLoopFn` is injected in tests without the 4th deps arg, keep the existing default; only the real `start` passes `configHolder`.)

- [ ] **Step 5: Run daemon tests.**

Run: `npx vitest run tests/daemon.test.ts > /tmp/t6b.out 2>&1; echo "exit: $?"` → PASS (new case + no regressions).

- [ ] **Step 6: Format + commit.**

Run: `npx prettier --write src/daemon.ts src/cli.ts tests/daemon.test.ts`
```bash
git add -A
git commit -m "feat(daemon): read config from a holder each iteration; watch for hot-reload"
```

---

## Task 7: TUI Config view

**Files:**
- Create: `src/tui/components/ConfigView.tsx`
- Modify: `src/tui/App.tsx` (open on a free key, close on Esc; render when active)
- Test: `tests/configView.test.tsx`

**Interfaces:**
- Consumes: `LEVERS`, `getAtPath`, `setAtPath` (Task 2); `validateConfigObject`, `loadConfig` (Task 1); `tui/theme` + existing Ink components; the `ghClient.ts` atomic-write pattern.
- Produces: `<ConfigView configPath={string} onExit={() => void} />` (Ink component).

- [ ] **Step 1: Confirm a free key.** Run `grep -n "input ===\|key\.\|useInput" src/tui/App.tsx` and pick an unused single key (prefer `,`; fall back to `g`). Record the choice in the component doc-comment.

- [ ] **Step 2: Write failing render/edit tests (`tests/configView.test.tsx`).**

Use `ink-testing-library` (already used by `configView`'s sibling tests — mirror `tests/tuiApp.test.tsx` imports). Assert: sections render; the focused lever's description shows; a bool toggle writes the file; a structured lever shows read-only; the `↻ restart to apply` marker appears on a restart-kind lever; an invalid number shows an error and does not write. **Loop-until-condition** with a bounded retry (never one fixed `setTimeout` tick).

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigView } from "../src/tui/components/ConfigView.js";

async function until(fn: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("condition not met");
}
function fixture(obj: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "cfgview-"));
  const p = join(dir, "config.json"); writeFileSync(p, JSON.stringify(obj, null, 2), "utf8"); return p;
}

it("renders sections and the focused lever description", async () => {
  const p = fixture({ vaultRoot: "/v" });
  const { lastFrame } = render(<ConfigView configPath={p} onExit={() => {}} />);
  await until(() => /worker/i.test(lastFrame() ?? ""));
  expect(lastFrame()).toMatch(/Parallel ticket slots|maxConcurrent/);
});
```

Add the toggle-write, read-only, restart-marker, and invalid-number cases similarly (navigate with `stdin.write` arrow/enter/space sequences, then `await until(() => JSON.parse(readFileSync(p)).<field> === expected)`).

- [ ] **Step 3: Run to verify failure.**

Run: `npx vitest run tests/configView.test.tsx > /tmp/t7.out 2>&1; echo "exit: $?"` → FAIL (module not found).

- [ ] **Step 4: Implement `src/tui/components/ConfigView.tsx`.**

Two-pane layout grouping `LEVERS` by their top-level section (`path.split(".")[0]`). State: `sectionIdx`, `fieldIdx`, `editing` (null | string buffer), `toast`. Read the raw JSON on mount; on save, `setAtPath` a clone, `validateConfigObject`, atomic write (temp+rename), reload raw, set toast per the lever's `reload` ("Saved — applies live" / "Saved — restart to apply"); on validate/coerce error, toast the message and leave the file untouched. `useInput`: arrows move focus; `Enter` starts/commits an edit (bool toggles immediately; enum cycles `enumValues`); `Esc` cancels an edit or calls `onExit`. Render the focused lever's `description` in a footer; render a `↻ restart` marker when `lever.reload === "restart"`; render `secret` values as `••••`; render `structured` levers dimmed with an "edit config.json" hint and skip them when entering edit mode. Reuse coercion by importing `coerceLever` from `configLevers.ts` (already added in Task 3 Step 3a).

(Full component ~150 lines; keep each handler small. Mirror the structure and theme usage of an existing view such as the assess/review view in `src/tui/components/`.)

- [ ] **Step 5: Wire into `src/tui/App.tsx`.** Add a `configOpen` state; on the chosen key (when no other modal is active) set it true; render `<ConfigView configPath={configPath} onExit={() => setConfigOpen(false)} />` instead of the main view when open. Add the key to the dashboard's help/legend line.

- [ ] **Step 6: Run tests (loop-until-condition) + full TUI suite.**

Run: `npx vitest run tests/configView.test.tsx tests/tuiApp.test.tsx > /tmp/t7b.out 2>&1; echo "exit: $?"` → PASS.

- [ ] **Step 7: Format + commit.**

Run: `npx prettier --write src/tui/components/ConfigView.tsx src/tui/App.tsx src/configLevers.ts tests/configView.test.tsx`
```bash
git add -A
git commit -m "feat(tui): in-dashboard config editor with per-lever explanations + reload markers"
```

---

## Task 8: Docs sweep, configuration.md shrink, CHANGELOG

**Files:**
- Modify: `docs/*.md`, `README.md`, `src/service.ts` (comments + emitted unit hints), `src/doctor.ts` (any `config.toml` string), `docs/configuration.md`, `CHANGELOG.md`
- No test file (docs); the packaged-CLI smoke test in CI covers wizard/init.

- [ ] **Step 1: Enumerate remaining references.**

Run: `grep -rn "config\.toml\|smol-toml\|\.toml" src/ docs/ README.md templates/ examples/ 2>/dev/null`
Expected remaining hits are prose/paths only (all code moved in Tasks 1–7).

- [ ] **Step 2: Replace `config.toml` → `config.json` across docs + README + `service.ts` strings.** Preserve surrounding wording. Where a doc showed a TOML snippet (```toml … ```), convert it to an equivalent JSON snippet with camelCase keys. Key files: `docs/operations.md`, `docs/configuration.md`, `docs/tickets.md`, `docs/github-mode.md`, `docs/assess.md`, `docs/dashboard.md`, `docs/parallel-sessions.md`, `README.md`, `ARCHITECTURE.md` (the `config.ts` row: "zod-validated JSON → typed Config").

- [ ] **Step 3: Shrink `docs/configuration.md`.** Replace the annotated per-field TOML reference with: a short intro, a **minimal `config.json` skeleton** (camelCase, a handful of common keys), and a pointer: "The full, always-current annotated reference is `junco config list` (every lever with its default, type, and one-line explanation). Edit interactively in the dashboard config view or with `junco config set <path> <value>`." Note the leftover-`.toml` guard behavior and that TOML is no longer supported.

- [ ] **Step 4: Add a `CHANGELOG.md` entry (unreleased).** Under a new `## [Unreleased]` (or the existing one), Keep-a-Changelog style:

```
### Changed
- **BREAKING:** configuration is now `config.json` (camelCase) instead of `config.toml`; the `smol-toml` dependency is removed. Convert existing `config.toml` files by hand (see docs/configuration.md); junco errors with a pointer if it finds a leftover `config.toml`. Legacy `[pi]`/`[oMLX]` sections are gone — set `model.*` directly; the tool allowlist is now top-level `tools`, and `commit_leftovers` is `worker.commitLeftovers`.
### Added
- `junco config path|list|get|set` and an in-dashboard config editor.
- Daemon hot-reload: live-safe settings apply at the next poll; structural changes surface `pendingRestartFields` in `junco status`/`/health`.
```

Do **not** bump the version or touch release workflows.

- [ ] **Step 5: Full gate.**

Run: `npm run lint > /tmp/gate.out 2>&1; echo "lint: $?"`
Run: `npm run format:check >> /tmp/gate.out 2>&1; echo "fmt: $?"`
Run: `npm run typecheck >> /tmp/gate.out 2>&1; echo "tc: $?"` (only pre-existing unrelated errors)
Run: `npm run build >> /tmp/gate.out 2>&1; echo "build: $?"`
Run: `npx vitest run > /tmp/gatetest.out 2>&1; echo "test: $?"`
Expected: all green (build 0, test 0; lint/fmt 0).

- [ ] **Step 6: Sandbox smoke test (init writes config.json, doctor reads it).**

```bash
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /Users/alxedelweiss/junco/.claude/worktrees/worktree-3/dist/cli.js init --yes \
  && test -f "$SB/.config/junco/config.json" && echo "OK config.json" \
  && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" node /Users/alxedelweiss/junco/.claude/worktrees/worktree-3/dist/cli.js config list | head -3 \
  ; cd / && rm -rf "$SB"
```
Expected: `OK config.json` and three lever lines.

- [ ] **Step 7: Format + commit.**

Run: `npx prettier --write docs/ README.md ARCHITECTURE.md CHANGELOG.md src/service.ts src/doctor.ts` (prettier ignores unknown types safely; scope to touched files if it complains)
```bash
git add -A
git commit -m "docs(config): switch references to config.json; shrink configuration.md; changelog"
```

---

## Self-Review Results

- **Spec coverage:** format (T1) · loadConfig+guard (T1) · registry+drift (T2) · CLI (T3) · status/health surfacing (T4) · holder+watcher (T5) · daemon wiring (T6) · TUI (T7) · docs/changelog/dependency-removal (T1+T8). Rollout steps 5 & 7 (live conversion, residual sweep) are the maintainer runbook in Appendix A (post-merge, not code).
- **Type consistency:** `parseConfigFile`/`assembleConfig`/`loadConfig`/`ConfigParsed`/`ConfigSchema` (T1; `ConfigSchema` exported in T2 Step 1; `validateConfigObject` added T3 Step 4) consumed in T2/T3/T5. `ConfigHolder`/`makeConfigHolder`/`watchConfig` (T5) consumed in T6. `Lever`/`LEVERS`/`getAtPath`/`setAtPath`/`leverAtPath` (T2) + `coerceLever` (T3 Step 3a) consumed in T3/T5/T7. `pendingRestartFields` (T4) consumed by T5's default `onRestartFields`; T7's `↻` marker keys off each lever's `reload`. Task order (T1→T8) satisfies every consumes-before-produces edge.
- **Placeholder note:** the `LEVERS` array (T2 Step 4) shows the pattern + a representative slice; the exhaustive-entry expansion is *enforced by the drift test*, not left to taste — the bijection assertion fails until every schema leaf has an entry. The `ConfigView` component (T7 Step 4) shows the state/handler contract with tests pinning behavior; its full JSX body follows the cited sibling view.

---

## Appendix A: Maintainer rollout runbook (post-merge, NOT a code task)

Run only after the PR merges to `main` and the daemon build is refreshed. Operates on the **main checkout's live runtime** — confirm each step.

1. Convert the live config: read `~/…/junco/config.toml`, hand-write the equivalent `config.json` (camelCase; `[pi].model_id`→`model.id`; `[oMLX]`→`model.baseUrl`/`apiKey`; `--tools` CSV→top-level `tools`; `commit_leftovers`→`worker.commitLeftovers`). Validate: `node dist/cli.js config list --config <new>.json`.
2. `mv config.toml config.toml.bak`; put `config.json` in place.
3. `junco restart` (never bare SIGTERM). Verify: `node dist/cli.js doctor` and `curl -s 127.0.0.1:8787/health`.
4. Watch one ticket process end-to-end; confirm `logs -f` clean.
5. **Residual-TOML sweep:** once healthy, `grep -rn "toml" .` across the repo; remove any lingering reference in code/docs/templates/examples/comments. Delete `config.toml.bak` after a confidence window. End state: zero TOML anywhere.
