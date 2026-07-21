# Setup Wizard Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the clack-based `junco init` with a full-screen Ink walkthrough — chapter rail, junco tips, preflight/flight-check receipts, and a config-preserving re-run mode — per `docs/superpowers/specs/2026-07-11-setup-wizard-design.md`.

**Architecture:** Pure flow engine (`src/wizard/flow.ts`) + probe layer (`src/wizard/detect.ts`) + copy registry (`src/wizard/tips.ts`), rendered by a thin Ink skin (`src/tui/wizard/`) that is lazy-imported. `runInitWizard` keeps its signature/exit codes; all side effects stay behind a `WizardIO` object so the interactive step is injectable.

**Tech Stack:** TypeScript strict ESM (NodeNext), ink 7.1.0 + react 19.2.7 (already pinned), vitest + ink-testing-library. `@clack/prompts` is deleted.

## Global Constraints

- Node ≥ 22.19; ESM with `.js` import suffixes; strict TS. `npm run typecheck` covers `tests/` (vitest does not).
- No new dependencies. Remove `@clack/prompts` via `npm uninstall @clack/prompts` (keeps exact-pin lockfile discipline).
- All wizard copy is stack-agnostic: say "inference endpoint", never a product/server name; no personal-setup strings (omp, omlx, launchd labels, vault names).
- No AI attribution in commits. Conventional commits. Suite green at every commit.
- `--yes` must keep writing exactly today's default config (packaged smoke test `scripts/package-smoke.sh` asserts `init --yes` works headless).
- Exit codes: 0 written/unchanged, 130 cancelled, 1 non-TTY-without-`--yes` (existing cli guard).
- Ink tests: never assert one fixed timeout tick; use `tests/helpers/until.js` + the `press`/`tick` pattern from `tests/configView.test.tsx` (30 ms between keystrokes; chained writes drop keys).
- Never import the Pi SDK in `src/` at module top level (wizard never touches it — keep it that way).
- Prettier before committing touched files: `npx prettier --write <files>`.
- The vitest exit-code trap: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — never pipe into grep/tail.

## File Structure

```
src/wizard/tips.ts              copy registry (greetings, tips, sign-off, next steps)   [new]
src/wizard/flow.ts              WizardAnswers, defaults, buildConfigObject,             [new]
                                answersFromConfig, diffAnswers, applyAnswers, CHAPTERS
src/wizard/detect.ts            CheckResult probes: preflightChecks, flightChecks,      [new]
                                greetingName
src/tui/wizard/WizardApp.tsx    rail + chapter router + footer + cancel/nav keys        [new]
src/tui/wizard/chapters/*.tsx   Welcome, Workspace, Model, RepoSafety, Github,          [new]
                                Extras, Review, Finale (one file each)
src/tui/wizard/receipts.tsx     shared <ReceiptList> (✓/⚠/✗ rows) + <Tip> box           [new]
src/wizard.ts                   rewritten runInitWizard (WizardIO, collectFn seam,      [rewrite]
                                fresh/rerun writes)
src/wizard/prompter.ts          DELETED (with @clack/prompts)
src/wizard/models.ts            unchanged (doctor imports it too)
src/cli.ts                      init routing (rerun mode), USAGE text                   [modify]
tests/wizardTips.test.ts        copy guards                                             [new]
tests/wizardFlow.test.ts        flow engine + round-trips + rerun preservation          [new]
tests/wizardDetect.test.ts      probe verdicts with fake exec/fetch                     [new]
tests/wizardChapters.test.tsx   per-chapter Ink component tests                         [new]
tests/wizardApp.test.tsx        full Enter-through flow, cancel, rail, narrow           [new]
tests/wizard.test.ts            rewritten runInitWizard contract tests                  [rewrite]
tests/cli.test.ts               init routing updates                                    [modify]
README.md, docs/configuration.md, CHANGELOG.md                                          [modify]
```

Chapter components receive `(answers, onPatch, onNext, onBack, io)` props and are testable standalone; `WizardApp` owns the rail, keyboard routing, and the finale handoff.

---

### Task 1: Copy registry (`src/wizard/tips.ts`)

**Files:**

- Create: `src/wizard/tips.ts`
- Test: `tests/wizardTips.test.ts`

**Interfaces:**

- Produces: `BIRD: string`, `GREETINGS: readonly string[]`, `TIPS: Record<TipKey, string>` with `TipKey = "welcome" | "workspace" | "model" | "repoSafety" | "githubOff" | "githubApproval" | "extras" | "review" | "signoff"`, `NEXT_STEPS: readonly { cmd: string; blurb: string }[]`, `pickGreeting(seed: number): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/wizardTips.test.ts
import { describe, it, expect } from "vitest";
import { BIRD, GREETINGS, TIPS, NEXT_STEPS, pickGreeting } from "../src/wizard/tips.js";

describe("wizard copy registry", () => {
  it("has a greeting pool and deterministic picker", () => {
    expect(GREETINGS.length).toBeGreaterThanOrEqual(3);
    expect(pickGreeting(0)).toBe(GREETINGS[0]);
    expect(pickGreeting(GREETINGS.length + 1)).toBe(GREETINGS[1]);
  });

  it("has a tip for every chapter key", () => {
    for (const k of [
      "welcome",
      "workspace",
      "model",
      "repoSafety",
      "githubOff",
      "githubApproval",
      "extras",
      "review",
      "signoff",
    ] as const) {
      expect(TIPS[k].length).toBeGreaterThan(10);
    }
    expect(BIRD).toBe("🐦");
  });

  it("next steps name real subcommands", () => {
    const cmds = NEXT_STEPS.map((s) => s.cmd);
    expect(cmds.some((c) => c.includes("junco start"))).toBe(true);
    expect(cmds.some((c) => c.includes("junco submit"))).toBe(true);
    expect(cmds.some((c) => c.includes("junco config list"))).toBe(true);
  });

  it("all copy is stack-agnostic (packaging rule)", () => {
    const all = [...GREETINGS, ...Object.values(TIPS), ...NEXT_STEPS.map((s) => s.cmd + s.blurb)]
      .join(" ")
      .toLowerCase();
    for (const banned of ["omp", "omlx", "lm studio", "ollama", "launchd", "edelweiss"]) {
      expect(all).not.toContain(banned);
    }
    // the endpoint is always described generically
    expect(Object.values(TIPS).join(" ")).toContain("inference endpoint");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wizardTips.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, "Cannot find module … tips.js"

- [ ] **Step 3: Write the implementation**

```ts
// src/wizard/tips.ts
/**
 * The wizard's copy registry — every greeting, tip, and trust-copy string in
 * one file so the stack-agnostic packaging gate is a single grep and copy
 * review is a single diff. Voice: "warm guide" — a junco glyph and friendly
 * plain language; never a chatty mascot, never a specific product name.
 */

export const BIRD = "🐦";

export const GREETINGS: readonly string[] = [
  "let's get your worker set up. Enter accepts the safe default at every step.",
  "a few short chapters and your ticket queue is airborne.",
  "five minutes of questions, a lifetime of merged PRs.",
  "let's build the nest. Every answer is editable later.",
];

/** Deterministic pick so tests are stable; callers pass e.g. Date.now(). */
export function pickGreeting(seed: number): string {
  return GREETINGS[Math.abs(seed) % GREETINGS.length];
}

export type TipKey =
  | "welcome"
  | "workspace"
  | "model"
  | "repoSafety"
  | "githubOff"
  | "githubApproval"
  | "extras"
  | "review"
  | "signoff";

export const TIPS: Record<TipKey, string> = {
  welcome: "Every answer lands in one editable file — config.json. Nothing here is permanent.",
  workspace:
    "This is junco's nest — tickets fly into inbox/, get worked in processing/, and land in done/ or failed/.",
  model:
    "junco drives a coding agent through this inference endpoint. Any OpenAI-compatible /v1 works.",
  repoSafety:
    "junco only works in throwaway worktrees and opens pull requests — it never commits to your branches. Folders you list here are the only places a ticket can point it. Leave the list empty to allow any repo path.",
  githubOff:
    "Off means zero gh calls — junco stays fully local. Flip it later with `junco config set github.enabled true`.",
  githubApproval:
    "With approval required, a plan-ready ticket waits for you; without it, plans auto-execute on the next sweep.",
  extras:
    "The recommended set is pre-checked. Space toggles, Enter continues — each row explains itself below.",
  review: "more levers keep their safe defaults — `junco config list` shows every one.",
  signoff: "The nest is ready.",
};

export const NEXT_STEPS: readonly { cmd: string; blurb: string }[] = [
  { cmd: "junco start", blurb: "launch the worker daemon" },
  { cmd: "junco submit <ticket>.md", blurb: "drop your first ticket in the inbox" },
  { cmd: "junco dashboard", blurb: "watch the queue live (press , for settings)" },
  { cmd: "junco config list", blurb: "every lever, its default, and what it does" },
  { cmd: "junco doctor", blurb: "re-run the full preflight anytime" },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wizardTips.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 4 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/wizard/tips.ts tests/wizardTips.test.ts
git add src/wizard/tips.ts tests/wizardTips.test.ts
git commit -m "feat(wizard): copy registry with stack-agnostic guard"
```

---

### Task 2: Flow engine — answers, defaults, fresh config build (`src/wizard/flow.ts`)

**Files:**

- Create: `src/wizard/flow.ts`
- Test: `tests/wizardFlow.test.ts`

**Interfaces:**

- Consumes: `getAtPath`/`setAtPath` from `src/configLevers.ts`, `loadConfig` from `src/config.ts` (tests only).
- Produces (later tasks rely on these exact names):

```ts
export interface WatchedRepoAnswer {
  nwo: string;
  path: string;
}
export interface WizardAnswers {
  vaultRoot: string;
  mode: "inline" | "models_json";
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  modelsJson?: string;
  repoRoots: string[];
  github: { enabled: boolean; repos: WatchedRepoAnswer[]; requireApproval: boolean };
  extras: { sandbox: boolean; verify: boolean; health: boolean; transcripts: boolean };
}
export const CHAPTERS: readonly string[]; // ["Welcome","Workspace","Model","Repo safety","GitHub","Extras","Review"]
export function defaultAnswers(): WizardAnswers;
export function buildConfigObject(a: WizardAnswers): Record<string, unknown>;
export function renderConfigJson(a: WizardAnswers): string; // JSON.stringify(buildConfigObject(a), null, 2) + "\n"
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/wizardFlow.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHAPTERS,
  defaultAnswers,
  buildConfigObject,
  renderConfigJson,
  type WizardAnswers,
} from "../src/wizard/flow.js";
import { loadConfig, queuePaths } from "../src/config.js";

function loadRendered(a: WizardAnswers) {
  const dir = mkdtempSync(join(tmpdir(), "wizflow-"));
  const p = join(dir, "config.json");
  writeFileSync(p, renderConfigJson(a), "utf8");
  return loadConfig(p);
}

describe("chapters", () => {
  it("is the approved rail order", () => {
    expect(CHAPTERS).toEqual([
      "Welcome",
      "Workspace",
      "Model",
      "Repo safety",
      "GitHub",
      "Extras",
      "Review",
    ]);
  });
});

describe("defaultAnswers", () => {
  it("keeps today's --yes pins and adds safe walkthrough defaults", () => {
    const a = defaultAnswers();
    expect(a.vaultRoot).toBe("~/Junco");
    expect(a.modelId).toBe("local/my-model");
    expect(a.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(a.apiKey).toBe("1234");
    expect(a.repoRoots).toEqual([]);
    expect(a.github).toEqual({ enabled: false, repos: [], requireApproval: true });
    expect(a.extras).toEqual({ sandbox: true, verify: true, health: true, transcripts: true });
  });
});

describe("buildConfigObject / renderConfigJson", () => {
  it("defaults render the same minimal config as today's --yes", () => {
    const obj = buildConfigObject(defaultAnswers());
    expect(Object.keys(obj).sort()).toEqual(["juncoSubdir", "model", "vaultRoot"]);
    const cfg = loadRendered(defaultAnswers());
    expect(cfg.model.id).toBe("local/my-model");
    expect(queuePaths(cfg).inbox.endsWith("Junco/inbox")).toBe(true);
  });

  it("non-default answers land in the right sections and round-trip", () => {
    const a: WizardAnswers = {
      ...defaultAnswers(),
      vaultRoot: "/tmp/jv",
      repoRoots: ["~/code"],
      github: {
        enabled: true,
        repos: [{ nwo: "acme/api", path: "/tmp/acme" }],
        requireApproval: false,
      },
      extras: { sandbox: false, verify: true, health: false, transcripts: true },
    };
    const cfg = loadRendered(a);
    expect(cfg.allowedRepoRoots.length).toBe(1);
    expect(cfg.github.enabled).toBe(true);
    expect(cfg.github.repos).toEqual([{ nwo: "acme/api", path: "/tmp/acme" }]);
    expect(cfg.github.requireApproval).toBe(false);
    expect(cfg.sandbox.enabled).toBe(false);
    expect(cfg.healthEnabled).toBe(false);
    // checked extras are OMITTED (schema default already true)
    const obj = buildConfigObject(a);
    expect((obj.verify as undefined) === undefined).toBe(true);
    expect((obj.observability as Record<string, unknown>).transcripts).toBeUndefined();
  });

  it("models_json mode writes model.modelsJson and no inline fields", () => {
    const a: WizardAnswers = {
      ...defaultAnswers(),
      mode: "models_json",
      modelsJson: "~/.pi/agent/models.json",
      modelId: "prov/m1",
    };
    const obj = buildConfigObject(a);
    const model = obj.model as Record<string, unknown>;
    expect(model.modelsJson).toBe("~/.pi/agent/models.json");
    expect(model.baseUrl).toBeUndefined();
    expect(model.apiKey).toBeUndefined();
    expect(loadRendered(a).model.id).toBe("prov/m1");
  });

  it("escapes JSON-hostile strings", () => {
    const a = { ...defaultAnswers(), vaultRoot: '/tmp/we"ird\\path' };
    expect(loadRendered(a).vaultRoot).toBe('/tmp/we"ird\\path');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wizardFlow.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, cannot find module flow.js

- [ ] **Step 3: Write the implementation**

```ts
// src/wizard/flow.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wizardFlow.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 6 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/wizard/flow.ts tests/wizardFlow.test.ts
git add src/wizard/flow.ts tests/wizardFlow.test.ts
git commit -m "feat(wizard): pure flow engine — answers, defaults, minimal fresh config"
```

---

### Task 3: Flow engine — re-run mode (prefill, diff, apply)

**Files:**

- Modify: `src/wizard/flow.ts` (append)
- Test: `tests/wizardFlow.test.ts` (append)

**Interfaces:**

- Consumes: `getAtPath`, `setAtPath` from `src/configLevers.ts`.
- Produces:

```ts
export interface AnswerDiff {
  path: string;
  from: unknown;
  to: unknown;
}
export function answersFromConfig(raw: Record<string, unknown>): WizardAnswers;
export function diffAnswers(raw: Record<string, unknown>, a: WizardAnswers): AnswerDiff[];
export function applyAnswers(
  raw: Record<string, unknown>,
  a: WizardAnswers,
): Record<string, unknown>; // clone; uncovered keys preserved
```

- [ ] **Step 1: Write the failing tests (append to tests/wizardFlow.test.ts)**

```ts
import { answersFromConfig, diffAnswers, applyAnswers } from "../src/wizard/flow.js";

describe("re-run mode", () => {
  const raw = {
    vaultRoot: "/v",
    juncoSubdir: "",
    model: { id: "prov/m", baseUrl: "http://h:1/v1", apiKey: "k" },
    worker: { maxConcurrent: 3 }, // NOT wizard-covered — must survive untouched
    git: { allowedRepoRoots: ["/code"], branchPrefix: "junco/" },
    sandbox: { enabled: false },
  };

  it("answersFromConfig prefills covered levers and defaults the rest", () => {
    const a = answersFromConfig(raw);
    expect(a.vaultRoot).toBe("/v");
    expect(a.mode).toBe("inline");
    expect(a.modelId).toBe("prov/m");
    expect(a.repoRoots).toEqual(["/code"]);
    expect(a.extras.sandbox).toBe(false);
    expect(a.extras.verify).toBe(true); // schema default
    expect(a.github.enabled).toBe(false);
  });

  it("prefers models_json mode when the file sets it", () => {
    const a = answersFromConfig({ model: { id: "p/m", modelsJson: "/mj.json" } });
    expect(a.mode).toBe("models_json");
    expect(a.modelsJson).toBe("/mj.json");
  });

  it("diffAnswers reports only changed paths", () => {
    const a = answersFromConfig(raw);
    a.vaultRoot = "/v2";
    a.extras.sandbox = true;
    const d = diffAnswers(raw, a);
    expect(d).toContainEqual({ path: "vaultRoot", from: "/v", to: "/v2" });
    expect(d).toContainEqual({ path: "sandbox.enabled", from: false, to: true });
    expect(d.length).toBe(2);
  });

  it("diffAnswers is empty when nothing changed", () => {
    expect(diffAnswers(raw, answersFromConfig(raw))).toEqual([]);
  });

  it("applyAnswers preserves uncovered keys verbatim and does not mutate input", () => {
    const a = answersFromConfig(raw);
    a.vaultRoot = "/v2";
    const out = applyAnswers(raw, a);
    expect(out.vaultRoot).toBe("/v2");
    expect((out.worker as { maxConcurrent: number }).maxConcurrent).toBe(3);
    expect((out.git as { branchPrefix: string }).branchPrefix).toBe("junco/");
    expect(raw.vaultRoot).toBe("/v"); // input untouched
  });

  it("switching models_json → inline clears model.modelsJson in the output", () => {
    const mjRaw = { vaultRoot: "/v", model: { id: "p/m", modelsJson: "/mj.json" } };
    const a = answersFromConfig(mjRaw);
    a.mode = "inline";
    a.baseUrl = "http://h:1/v1";
    a.apiKey = "k";
    const out = applyAnswers(mjRaw, a);
    expect(JSON.stringify(out)).not.toContain("modelsJson");
    expect((out.model as { baseUrl: string }).baseUrl).toBe("http://h:1/v1");
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/wizardFlow.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, "answersFromConfig is not a function" (or module export error)

- [ ] **Step 3: Implement (append to src/wizard/flow.ts)**

```ts
import { getAtPath, setAtPath } from "../configLevers.js";

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
  const out: AnswerDiff[] = [];
  for (const { path, value } of coveredPaths(a)) {
    const cur = getAtPath(raw, path);
    if (JSON.stringify(cur) !== JSON.stringify(value)) {
      if (cur === undefined && value === undefined) continue;
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
```

- [ ] **Step 4: Run to verify all flow tests pass**

Run: `npx vitest run tests/wizardFlow.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 12 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/wizard/flow.ts tests/wizardFlow.test.ts
git add src/wizard/flow.ts tests/wizardFlow.test.ts
git commit -m "feat(wizard): re-run mode — prefill, diff, preserving apply"
```

---

### Task 4: Probe layer (`src/wizard/detect.ts`)

**Files:**

- Create: `src/wizard/detect.ts`
- Test: `tests/wizardDetect.test.ts`

**Interfaces:**

- Consumes: `endpointReachable(cfg)` from `src/health.ts`, `fetchModels` from `src/wizard/models.ts`, `splitModelId` from `src/agent/modelSetup.ts`, `selectBackend`/`classifyAvailability` from `src/agent/sandbox/backend.ts`, `queuePaths` from `src/config.ts`.
- Produces:

```ts
export interface CheckResult {
  verdict: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}
export interface DetectDeps {
  execFn?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetchModelsFn?: typeof fetchModels;
  reachableFn?: (cfg: Config) => Promise<boolean>;
  accessOkFn?: (dir: string) => boolean;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
}
export async function greetingName(deps?: DetectDeps): Promise<string>;
export async function preflightChecks(deps?: DetectDeps): Promise<CheckResult[]>; // node, git, gh(+auth)
export async function flightChecks(cfg: Config, deps?: DetectDeps): Promise<CheckResult[]>;
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/wizardDetect.test.ts
import { describe, it, expect } from "vitest";
import { greetingName, preflightChecks, flightChecks } from "../src/wizard/detect.js";
import { loadConfig } from "../src/config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;
const okExec =
  (table: Record<string, { code: number; stdout: string }>): Exec =>
  async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const hit = table[key] ?? { code: 127, stdout: "" };
    return { ...hit, stderr: "" };
  };

function tmpCfg(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wizdetect-"));
  const p = join(dir, "config.json");
  writeFileSync(
    p,
    JSON.stringify({ vaultRoot: join(dir, "vault"), juncoSubdir: "", ...extra }),
    "utf8",
  );
  return loadConfig(p);
}

describe("greetingName", () => {
  it("returns the git first name, or 'friend' when unset", async () => {
    expect(
      await greetingName({
        execFn: okExec({ "git config user.name": { code: 0, stdout: "Ada Lovelace\n" } }),
      }),
    ).toBe("Ada");
    expect(await greetingName({ execFn: okExec({}) })).toBe("friend");
  });
});

describe("preflightChecks", () => {
  it("reports node/git/gh receipts with authenticated gh", async () => {
    const res = await preflightChecks({
      nodeVersion: "22.19.0",
      execFn: okExec({
        "git --version": { code: 0, stdout: "git version 2.44.0\n" },
        "gh --version": { code: 0, stdout: "gh version 2.49.0\n" },
        "gh auth status": { code: 0, stdout: "" },
      }),
    });
    expect(res.map((r) => [r.label, r.verdict])).toEqual([
      ["node", "ok"],
      ["git", "ok"],
      ["gh", "ok"],
    ]);
    expect(res[2].detail).toContain("authenticated");
  });

  it("warns on missing gh and fails on old node", async () => {
    const res = await preflightChecks({ nodeVersion: "20.1.0", execFn: okExec({}) });
    expect(res.find((r) => r.label === "node")?.verdict).toBe("fail");
    expect(res.find((r) => r.label === "git")?.verdict).toBe("fail");
    expect(res.find((r) => r.label === "gh")?.verdict).toBe("warn");
  });
});

describe("flightChecks", () => {
  it("covers endpoint, model, dirs; warns when model not advertised", async () => {
    const cfg = tmpCfg({ sandbox: { enabled: false } });
    const res = await flightChecks(cfg, {
      reachableFn: async () => true,
      fetchModelsFn: async () => ["other-model"],
      accessOkFn: () => true,
      execFn: okExec({
        "gh auth status": { code: 0, stdout: "" },
        "gh --version": { code: 0, stdout: "x" },
      }),
    });
    expect(res.find((r) => r.label === "inference endpoint")?.verdict).toBe("ok");
    expect(res.find((r) => r.label === "model")?.verdict).toBe("warn");
    expect(res.filter((r) => r.label.includes("dir")).every((r) => r.verdict === "ok")).toBe(true);
  });

  it("fails endpoint receipt when unreachable and skips model check", async () => {
    const cfg = tmpCfg({ sandbox: { enabled: false } });
    const res = await flightChecks(cfg, {
      reachableFn: async () => false,
      accessOkFn: () => true,
      execFn: okExec({}),
    });
    expect(res.find((r) => r.label === "inference endpoint")?.verdict).toBe("fail");
    expect(res.find((r) => r.label === "model")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wizardDetect.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, cannot find module detect.js

- [ ] **Step 3: Write the implementation**

```ts
// src/wizard/detect.ts
/**
 * Wizard probe layer — the Welcome preflight and the Finale flight check.
 * Same seam shapes as doctor.ts (execFn / reachableFn / fetchModelsFn /
 * accessOkFn) and the same ✓/⚠/✗ verdict vocabulary, but scoped to what the
 * walkthrough shows; `junco doctor` remains the exhaustive standalone check.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../types.js";
import { queuePaths } from "../config.js";
import { endpointReachable } from "../health.js";
import { fetchModels } from "./models.js";
import { splitModelId } from "../agent/modelSetup.js";
import { selectBackend, classifyAvailability } from "../agent/sandbox/backend.js";

export interface CheckResult {
  verdict: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}

export interface DetectDeps {
  execFn?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetchModelsFn?: typeof fetchModels;
  reachableFn?: (cfg: Config) => Promise<boolean>;
  accessOkFn?: (dir: string) => boolean;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
}

function defaultExec(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
      res({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function defaultAccessOk(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** First name from `git config user.name`, "friend" when unset/unavailable. */
export async function greetingName(deps: DetectDeps = {}): Promise<string> {
  const execFn = deps.execFn ?? defaultExec;
  const r = await execFn("git", ["config", "user.name"]);
  const first = r.code === 0 ? r.stdout.trim().split(/\s+/)[0] : "";
  return first || "friend";
}

/** Welcome-chapter receipts: node ≥ 22.19, git present, gh present+authed. */
export async function preflightChecks(deps: DetectDeps = {}): Promise<CheckResult[]> {
  const execFn = deps.execFn ?? defaultExec;
  const out: CheckResult[] = [];

  const v = deps.nodeVersion ?? process.versions.node;
  const [maj, min] = v.split(".").map(Number);
  out.push(
    maj > 22 || (maj === 22 && min >= 19)
      ? { verdict: "ok", label: "node", detail: v }
      : { verdict: "fail", label: "node", detail: `${v} < required 22.19` },
  );

  const git = await execFn("git", ["--version"]);
  out.push(
    git.code === 0
      ? { verdict: "ok", label: "git", detail: git.stdout.trim() }
      : { verdict: "fail", label: "git", detail: "not found — PR tickets need git" },
  );

  const gh = await execFn("gh", ["--version"]);
  if (gh.code !== 0) {
    out.push({ verdict: "warn", label: "gh", detail: "not found — PRs need it, Q&A is fine" });
  } else {
    const auth = await execFn("gh", ["auth", "status"]);
    out.push(
      auth.code === 0
        ? { verdict: "ok", label: "gh", detail: "authenticated" }
        : { verdict: "warn", label: "gh", detail: "installed, not authenticated (gh auth login)" },
    );
  }
  return out;
}

/** Finale receipts against the freshly-written config. Mirrors the doctor
 * checks the wizard can affect; failures never block — config is on disk and
 * `junco doctor` is the standalone re-check. */
export async function flightChecks(cfg: Config, deps: DetectDeps = {}): Promise<CheckResult[]> {
  const execFn = deps.execFn ?? defaultExec;
  const reachableFn = deps.reachableFn ?? ((c: Config) => endpointReachable(c));
  const fetchModelsFn = deps.fetchModelsFn ?? fetchModels;
  const accessOkFn = deps.accessOkFn ?? defaultAccessOk;
  const out: CheckResult[] = [];

  const up = await reachableFn(cfg);
  out.push(
    up
      ? { verdict: "ok", label: "inference endpoint", detail: cfg.model.baseUrl }
      : {
          verdict: "fail",
          label: "inference endpoint",
          detail: `${cfg.model.baseUrl} unreachable — junco doctor re-checks anytime`,
        },
  );
  if (up) {
    const ids = await fetchModelsFn(cfg.model.baseUrl, cfg.model.apiKey);
    const { modelId } = splitModelId(cfg.model.id);
    if (ids.length === 0) {
      out.push({
        verdict: "warn",
        label: "model",
        detail: `endpoint lists no models; cannot verify ${cfg.model.id}`,
      });
    } else if (ids.includes(modelId) || ids.includes(cfg.model.id)) {
      out.push({ verdict: "ok", label: "model", detail: cfg.model.id });
    } else {
      out.push({
        verdict: "warn",
        label: "model",
        detail: `${cfg.model.id} not among ${ids.length} advertised`,
      });
    }
  }

  const paths = queuePaths(cfg);
  for (const [label, dir] of [
    ["queue dir", dirname(paths.inbox)],
    ["worktree dir", cfg.worktreeRoot],
    ["state dir", cfg.stateDir],
  ] as const) {
    out.push(
      accessOkFn(dir)
        ? { verdict: "ok", label, detail: dir }
        : { verdict: "fail", label, detail: `${dir} not writable` },
    );
  }

  if (cfg.sandbox.enabled) {
    const backend = selectBackend(cfg.sandbox.backend, deps.platform ?? process.platform);
    if (backend.name === "none") {
      out.push({
        verdict: "warn",
        label: "sandbox",
        detail: "backend=none — env scrub + fs jail only",
      });
    } else {
      const ok = await backend.isAvailable((c, a) => execFn(c, a).then((r) => ({ code: r.code })));
      const outcome = classifyAvailability(cfg.sandbox.backend, backend.name, ok);
      out.push(
        outcome === "ok"
          ? { verdict: "ok", label: "sandbox", detail: `${backend.name} available` }
          : outcome === "degrade"
            ? {
                verdict: "warn",
                label: "sandbox",
                detail: `${backend.name} unavailable — degrading to none`,
              }
            : {
                verdict: "fail",
                label: "sandbox",
                detail: `${backend.name} unavailable — tickets fail closed (junco doctor for the fix)`,
              },
      );
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wizardDetect.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 6 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/wizard/detect.ts tests/wizardDetect.test.ts
git add src/wizard/detect.ts tests/wizardDetect.test.ts
git commit -m "feat(wizard): preflight and flight-check probe layer"
```

---

### Task 5: WizardIO contract + shared TUI controls

**Files:**

- Create: `src/wizard/io.ts` (types only — no runtime code)
- Create: `src/tui/wizard/controls.tsx`
- Test: `tests/wizardChapters.test.tsx` (started here, grown by Tasks 6–10)

**Interfaces:**

- Produces `src/wizard/io.ts`:

```ts
import type { WizardAnswers, AnswerDiff } from "./flow.js";
import type { CheckResult } from "./detect.js";

export type WizardOutcome = "written" | "unchanged" | "cancelled";

export interface WriteResult {
  written: boolean; // false on a zero-diff re-run (dirs still ensured)
  configPath: string;
  queueRoot: string; // dirname of the inbox
  changes: AnswerDiff[]; // empty in fresh mode
}

/** Everything the Ink app needs from the outside world. Built by
 * runInitWizard; faked wholesale in component tests. */
export interface WizardIO {
  mode: "fresh" | "rerun";
  configPath: string;
  initialAnswers: WizardAnswers;
  currentRaw: Record<string, unknown> | null; // rerun: the parsed existing file
  greetName(): Promise<string>;
  preflight(): Promise<CheckResult[]>;
  discoverModels(baseUrl: string, apiKey: string): Promise<string[]>;
  listModelsJson(path: string): string[];
  write(a: WizardAnswers): WriteResult;
  flightCheck(): Promise<CheckResult[]>;
}
```

- Produces `src/tui/wizard/controls.tsx`: `Tip`, `ReceiptList`, `Select`, `MultiSelect` (exact code below). Chapter prop contract (also in controls.tsx):

```ts
export interface ChapterProps {
  answers: WizardAnswers;
  patch: (p: Partial<WizardAnswers>) => void;
  onNext: () => void;
  onBack: () => void;
  io: WizardIO;
  setTextEditing: (b: boolean) => void; // WizardApp mutes q/← while true
}
```

- [ ] **Step 1: Write the failing test**

```tsx
// tests/wizardChapters.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { until } from "./helpers/until.js";
import { Tip, ReceiptList, Select, MultiSelect } from "../src/tui/wizard/controls.js";

afterEach(cleanup);
const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
async function press(stdin: { write: (s: string) => void }, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

describe("controls", () => {
  it("Tip renders the junco glyph and copy", () => {
    const { lastFrame } = render(<Tip>Every answer is editable later.</Tip>);
    expect(lastFrame()).toContain("🐦");
    expect(lastFrame()).toContain("editable later");
  });

  it("ReceiptList renders one mark per verdict", () => {
    const { lastFrame } = render(
      <ReceiptList
        items={[
          { verdict: "ok", label: "git", detail: "2.44" },
          { verdict: "warn", label: "gh", detail: "not authenticated" },
          { verdict: "fail", label: "node", detail: "too old" },
        ]}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("✓ git");
    expect(f).toContain("⚠ gh");
    expect(f).toContain("✗ node");
  });

  it("Select moves with ↓ and submits the highlighted value", async () => {
    let picked = "";
    const { stdin } = render(
      <Select
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta", hint: "recommended" },
        ]}
        onSubmit={(v) => {
          picked = v;
        }}
        focus
      />,
    );
    await press(stdin, DOWN, ENTER);
    await until(() => picked === "b");
    expect(picked).toBe("b");
  });

  it("MultiSelect toggles with space and submits checked values", async () => {
    let result: string[] | null = null;
    const { stdin } = render(
      <MultiSelect
        items={[
          { value: "sandbox", label: "OS sandbox", checked: true },
          { value: "verify", label: "Verify before PR", checked: true },
        ]}
        onSubmit={(vals) => {
          result = vals;
        }}
        onFocusChange={() => {}}
        focus
      />,
    );
    await press(stdin, DOWN, SPACE, ENTER); // uncheck "verify"
    await until(() => result !== null);
    expect(result).toEqual(["sandbox"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, cannot find module controls.js

- [ ] **Step 3: Write the implementation**

```tsx
// src/tui/wizard/controls.tsx
/**
 * Shared wizard controls: the junco Tip box, ✓/⚠/✗ receipt rows, and minimal
 * Select/MultiSelect (arrow + enter / space) in the dashboard's visual
 * language (theme.ts). Also home of ChapterProps — the contract every
 * chapter component implements.
 */
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import { BIRD } from "../../wizard/tips.js";
import { isMouseInput } from "../mouse.js";
import type { CheckResult } from "../../wizard/detect.js";
import type { WizardAnswers } from "../../wizard/flow.js";
import type { WizardIO } from "../../wizard/io.js";

export interface ChapterProps {
  answers: WizardAnswers;
  patch: (p: Partial<WizardAnswers>) => void;
  onNext: () => void;
  onBack: () => void;
  io: WizardIO;
  setTextEditing: (b: boolean) => void;
}

export function Tip({ children }: { children: string }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text>{BIRD} </Text>
      <Box width={58}>
        <Text dimColor wrap="wrap">
          {children}
        </Text>
      </Box>
    </Box>
  );
}

const MARK = { ok: "✓", warn: "⚠", fail: "✗" } as const;
const COLOR = { ok: theme.success, warn: theme.warn, fail: theme.error } as const;

export function ReceiptList({ items }: { items: CheckResult[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((r, i) => (
        <Text key={i}>
          <Text color={COLOR[r.verdict]}>{MARK[r.verdict]}</Text> {r.label}
          {r.detail ? <Text dimColor> — {r.detail}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export function Select({
  options,
  onSubmit,
  focus,
  initial = 0,
}: {
  options: SelectOption[];
  onSubmit: (v: string) => void;
  focus: boolean;
  initial?: number;
}): React.JSX.Element {
  const [idx, setIdx] = useState(initial);
  useInput(
    (input, key) => {
      if (isMouseInput(input)) return;
      if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setIdx((i) => Math.min(options.length - 1, i + 1));
      else if (key.return) onSubmit(options[idx].value);
    },
    { isActive: focus },
  );
  return (
    <Box flexDirection="column">
      {options.map((o, i) => (
        <Text key={o.value} color={i === idx ? theme.accent : undefined}>
          {i === idx ? "▌ " : "  "}
          {o.label}
          {o.hint ? <Text dimColor> ({o.hint})</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

export interface MultiItem {
  value: string;
  label: string;
  checked: boolean;
}

export function MultiSelect({
  items,
  onSubmit,
  onFocusChange,
  focus,
}: {
  items: MultiItem[];
  onSubmit: (checkedValues: string[]) => void;
  onFocusChange: (index: number) => void;
  focus: boolean;
}): React.JSX.Element {
  const [idx, setIdx] = useState(0);
  const [checked, setChecked] = useState(items.map((i) => i.checked));
  useInput(
    (input, key) => {
      if (isMouseInput(input)) return;
      if (key.upArrow) {
        const n = Math.max(0, idx - 1);
        setIdx(n);
        onFocusChange(n);
      } else if (key.downArrow) {
        const n = Math.min(items.length - 1, idx + 1);
        setIdx(n);
        onFocusChange(n);
      } else if (input === " ") {
        setChecked((c) => c.map((v, i) => (i === idx ? !v : v)));
      } else if (key.return) {
        onSubmit(items.filter((_, i) => checked[i]).map((i) => i.value));
      }
    },
    { isActive: focus },
  );
  return (
    <Box flexDirection="column">
      {items.map((o, i) => (
        <Text key={o.value} color={i === idx ? theme.accent : undefined}>
          {i === idx ? "▌ " : "  "}
          {checked[i] ? "[x] " : "[ ] "}
          {o.label}
        </Text>
      ))}
    </Box>
  );
}
```

And create `src/wizard/io.ts` exactly as shown in the Interfaces block above (with a two-line doc comment noting it is type-only).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 4 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/wizard/io.ts src/tui/wizard/controls.tsx tests/wizardChapters.test.tsx
git add src/wizard/io.ts src/tui/wizard/controls.tsx tests/wizardChapters.test.tsx
git commit -m "feat(wizard): WizardIO contract + shared Ink controls"
```

---

### Task 6: Welcome + Workspace chapters

**Files:**

- Create: `src/tui/wizard/chapters/Welcome.tsx`, `src/tui/wizard/chapters/Workspace.tsx`
- Test: `tests/wizardChapters.test.tsx` (append)

**Interfaces:**

- Consumes: `ChapterProps`, `Tip`, `ReceiptList` from `../controls.js`; `Spinner` from `../../components/Spinner.js`; `TextField` from `../../components/TextField.js`; `TIPS`, `pickGreeting` from `../../../wizard/tips.js`.
- Produces: `export function Welcome(props: ChapterProps)`, `export function Workspace(props: ChapterProps)`.

- [ ] **Step 1: Write the failing tests (append to tests/wizardChapters.test.tsx)**

```tsx
import { Welcome } from "../src/tui/wizard/chapters/Welcome.js";
import { Workspace } from "../src/tui/wizard/chapters/Workspace.js";
import { defaultAnswers } from "../src/wizard/flow.js";
import type { WizardIO } from "../src/wizard/io.js";

function fakeIo(over: Partial<WizardIO> = {}): WizardIO {
  return {
    mode: "fresh",
    configPath: "/tmp/config.json",
    initialAnswers: defaultAnswers(),
    currentRaw: null,
    greetName: async () => "Ada",
    preflight: async () => [{ verdict: "ok", label: "git", detail: "2.44" }],
    discoverModels: async () => ["m-fast", "m-big"],
    listModelsJson: () => [],
    write: () => ({
      written: true,
      configPath: "/tmp/config.json",
      queueRoot: "/tmp/q",
      changes: [],
    }),
    flightCheck: async () => [],
    ...over,
  };
}

const noopChapter = {
  patch: () => {},
  onBack: () => {},
  setTextEditing: () => {},
};

describe("Welcome", () => {
  it("greets by name, shows preflight receipts, and advances on enter", async () => {
    let advanced = false;
    const { lastFrame, stdin } = render(
      <Welcome
        {...noopChapter}
        answers={defaultAnswers()}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await until(() => (lastFrame() ?? "").includes("✓ git"));
    expect(lastFrame()).toContain("🐦");
    await press(stdin, ENTER);
    await until(() => advanced);
  });

  it("rerun mode names the config being tuned", async () => {
    const { lastFrame } = render(
      <Welcome
        {...noopChapter}
        answers={defaultAnswers()}
        io={fakeIo({ mode: "rerun", configPath: "/etc/junco.json" })}
        onNext={() => {}}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("/etc/junco.json"));
    expect(lastFrame()).toContain("tune");
  });
});

describe("Workspace", () => {
  it("edits vaultRoot and advances on enter, refusing empty", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const view = (
      <Workspace
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />
    );
    const { stdin, rerender } = render(view);
    // wipe the default then type a path
    for (let i = 0; i < "~/Junco".length; i++) {
      await press(stdin, BACKSPACE);
      rerender(
        <Workspace
          {...noopChapter}
          answers={answers}
          patch={(p) => {
            answers = { ...answers, ...p };
          }}
          io={fakeIo()}
          onNext={() => {
            advanced = true;
          }}
        />,
      );
    }
    await press(stdin, ENTER); // empty → must NOT advance
    expect(advanced).toBe(false);
    stdin.write("/tmp/nest");
    await tick();
    rerender(
      <Workspace
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.vaultRoot).toBe("/tmp/nest");
  });
});
```

Also add `const BACKSPACE = "\x7f";` next to the other key constants at the top of the file.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, cannot find module chapters/Welcome.js

- [ ] **Step 3: Write the implementations**

```tsx
// src/tui/wizard/chapters/Welcome.tsx
/** Chapter 0 — greeting + machine preflight (detect-then-offer: what the
 * machine already has right is shown as receipts, never asked). */
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Tip, ReceiptList, type ChapterProps } from "../controls.js";
import { Spinner } from "../../components/Spinner.js";
import { TIPS, pickGreeting } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";
import { isMouseInput } from "../../mouse.js";
import type { CheckResult } from "../../../wizard/detect.js";

export function Welcome({ io, onNext }: ChapterProps): React.JSX.Element {
  const [name, setName] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [seed] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    void io.greetName().then((n) => alive && setName(n));
    void io.preflight().then((c) => alive && setChecks(c));
    return () => {
      alive = false;
    };
  }, [io]);
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.return) onNext();
  });
  return (
    <Box flexDirection="column">
      <Text>
        Hey <Text color={theme.accent}>{name ?? "…"}</Text> — {pickGreeting(seed)}
      </Text>
      {io.mode === "rerun" && (
        <Box marginTop={1}>
          <Text dimColor>
            Found your config at {io.configPath} — let's tune it. q leaves everything untouched.
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        {checks ? (
          <ReceiptList items={checks} />
        ) : (
          <Text>
            <Spinner /> checking your machine…
          </Text>
        )}
      </Box>
      <Tip>{TIPS.welcome}</Tip>
      <Box marginTop={1}>
        <Text dimColor>press enter to begin</Text>
      </Box>
    </Box>
  );
}
```

```tsx
// src/tui/wizard/chapters/Workspace.tsx
/** Chapter 1 — vaultRoot. juncoSubdir stays "" (queue directly under it). */
import React, { useEffect } from "react";
import { Box, Text } from "ink";
import { Tip, type ChapterProps } from "../controls.js";
import { TextField } from "../../components/TextField.js";
import { TIPS } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";

export function Workspace({
  answers,
  patch,
  onNext,
  setTextEditing,
}: ChapterProps): React.JSX.Element {
  useEffect(() => {
    setTextEditing(true);
    return () => setTextEditing(false);
  }, [setTextEditing]);
  return (
    <Box flexDirection="column">
      <Text>Where should junco keep its tickets?</Text>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} width={46} marginTop={1}>
        <TextField
          value={answers.vaultRoot}
          onChange={(v) => patch({ vaultRoot: v })}
          onSubmit={() => {
            if (answers.vaultRoot.trim() !== "") onNext();
          }}
          focus
          placeholder="~/Junco"
        />
      </Box>
      <Tip>{TIPS.workspace}</Tip>
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify all chapter tests pass**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 7 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/tui/wizard/chapters/Welcome.tsx src/tui/wizard/chapters/Workspace.tsx tests/wizardChapters.test.tsx
git add src/tui/wizard/chapters tests/wizardChapters.test.tsx
git commit -m "feat(wizard): Welcome and Workspace chapters"
```

---

### Task 7: Model chapter

**Files:**

- Create: `src/tui/wizard/chapters/Model.tsx`
- Test: `tests/wizardChapters.test.tsx` (append)

**Interfaces:**

- Consumes: `ChapterProps`, `Tip`, `Select` from `../controls.js`; `TextField`, `Spinner`; `inferProvider` from `../../../wizard/models.js`; `TIPS`.
- Produces: `export function Model(props: ChapterProps)`. Internal step machine: `"source" → ("url" → "key" → "probe" → "pick" [→ "manual"]) | ("mjPath" → "pick" [→ "manual"])`. Provider-prefix rules identical to today's wizard: picked ids containing `/` kept as-is, bare ids get `inferProvider(baseUrl)` prefix; models.json ids arrive already prefixed.

- [ ] **Step 1: Write the failing tests (append)**

```tsx
import { Model } from "../src/tui/wizard/chapters/Model.js";

describe("Model chapter", () => {
  it("inline path: url → key → probe → pick, prefixing the discovered id", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const io = fakeIo({ discoverModels: async () => ["m-fast", "m-big"] });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, ENTER); // source: inline (first option)
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("endpoint"));
    await press(stdin, ENTER); // accept default URL
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("API key"));
    await press(stdin, ENTER); // accept default key
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("2 models found"));
    await press(stdin, ENTER); // pick first discovered id
    await until(() => advanced);
    expect(answers.modelId).toBe("local/m-fast"); // 127.0.0.1 → "local" prefix
    expect(answers.mode).toBe("inline");
  });

  it("empty discovery falls to manual entry", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const io = fakeIo({ discoverModels: async () => [] });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, ENTER);
    rerender(<Model {...props()} />);
    await press(stdin, ENTER); // url
    rerender(<Model {...props()} />);
    await press(stdin, ENTER); // key
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Model id"));
    stdin.write("anthropic/claude");
    await tick();
    rerender(<Model {...props()} />);
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.modelId).toBe("anthropic/claude"); // slash → kept as-is
  });

  it("models_json path lists file entries", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const io = fakeIo({ listModelsJson: () => ["prov/m1", "prov/m2"] });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, DOWN, ENTER); // second option: models.json
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("models.json"));
    await press(stdin, ENTER); // accept default path
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("prov/m1"));
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.mode).toBe("models_json");
    expect(answers.modelId).toBe("prov/m1");
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, cannot find module chapters/Model.js

- [ ] **Step 3: Write the implementation**

```tsx
// src/tui/wizard/chapters/Model.tsx
/** Chapter 2 — the inference endpoint + model. Same discovery/prefix rules as
 * the old clack wizard: probe <base>/models, bare ids get inferProvider()'s
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
```

- [ ] **Step 4: Run to verify all chapter tests pass**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 10 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/tui/wizard/chapters/Model.tsx tests/wizardChapters.test.tsx
git add src/tui/wizard/chapters/Model.tsx tests/wizardChapters.test.tsx
git commit -m "feat(wizard): Model chapter with live discovery"
```

---

### Task 8: Repo safety + GitHub chapters

**Files:**

- Create: `src/tui/wizard/chapters/RepoSafety.tsx`, `src/tui/wizard/chapters/Github.tsx`
- Test: `tests/wizardChapters.test.tsx` (append)

**Interfaces:**

- Consumes: `ChapterProps`, `Tip`, `Select`, `TextField`, `TIPS`, `theme`.
- Produces: `export function RepoSafety(props: ChapterProps)`, `export function Github(props: ChapterProps)`.

- [ ] **Step 1: Write the failing tests (append)**

```tsx
import { RepoSafety } from "../src/tui/wizard/chapters/RepoSafety.js";
import { Github } from "../src/tui/wizard/chapters/Github.js";

describe("RepoSafety chapter", () => {
  it("adds roots until an empty submit advances", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io: fakeIo(),
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<RepoSafety {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Which folders"));
    stdin.write("/code");
    await tick();
    rerender(<RepoSafety {...props()} />);
    await press(stdin, ENTER); // add /code
    rerender(<RepoSafety {...props()} />);
    await until(() => (lastFrame() ?? "").includes("✓ /code"));
    await press(stdin, ENTER); // empty → advance
    await until(() => advanced);
    expect(answers.repoRoots).toEqual(["/code"]);
    expect(lastFrame()).toContain("never commits to your branches");
  });
});

describe("Github chapter", () => {
  it("Off (default) advances immediately", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const { lastFrame, stdin } = render(
      <Github
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("GitHub bridge"));
    expect(lastFrame()).toContain("zero gh calls");
    await press(stdin, ENTER); // "Off" is first/default
    await until(() => advanced);
    expect(answers.github.enabled).toBe(false);
  });

  it("On collects repos then the approval toggle", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io: fakeIo(),
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("GitHub bridge"));
    await press(stdin, DOWN, ENTER); // On
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("owner/repo"));
    stdin.write("acme/api");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("local clone path"));
    stdin.write("/tmp/acme");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    await press(stdin, ENTER); // empty nwo → done adding
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("approval"));
    await press(stdin, ENTER); // keep approval required (default)
    await until(() => advanced);
    expect(answers.github).toEqual({
      enabled: true,
      repos: [{ nwo: "acme/api", path: "/tmp/acme" }],
      requireApproval: true,
    });
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, cannot find module chapters/RepoSafety.js

- [ ] **Step 3: Write the implementations**

```tsx
// src/tui/wizard/chapters/RepoSafety.tsx
/** Chapter 3 — git.allowedRepoRoots, the containment rail. Trust copy lives
 * exactly where the authority is granted (Stripe-style). Empty list is
 * honest: any repo path is allowed. */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Tip, type ChapterProps } from "../controls.js";
import { TextField } from "../../components/TextField.js";
import { TIPS } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";

export function RepoSafety({
  answers,
  patch,
  onNext,
  setTextEditing,
}: ChapterProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setTextEditing(true);
    return () => setTextEditing(false);
  }, [setTextEditing]);
  return (
    <Box flexDirection="column">
      <Text>Which folders may junco work in? (Enter on an empty field continues)</Text>
      {answers.repoRoots.map((r) => (
        <Text key={r}>
          <Text color={theme.success}>✓</Text> {r}
        </Text>
      ))}
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} width={46} marginTop={1}>
        <TextField
          value={draft}
          onChange={setDraft}
          onSubmit={() => {
            const v = draft.trim();
            if (v === "") return onNext();
            patch({ repoRoots: [...answers.repoRoots, v] });
            setDraft("");
          }}
          focus
          placeholder="~/code (empty = allow any repo path)"
        />
      </Box>
      <Tip>{TIPS.repoSafety}</Tip>
    </Box>
  );
}
```

```tsx
// src/tui/wizard/chapters/Github.tsx
/** Chapter 4 — the issues→inbox bridge. Off by default (zero gh calls);
 * enabling reveals watched-repo entry and the approval toggle. */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Tip, Select, type ChapterProps } from "../controls.js";
import { TextField } from "../../components/TextField.js";
import { TIPS } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";
import type { WatchedRepoAnswer } from "../../../wizard/flow.js";

type Step = "toggle" | "nwo" | "path" | "approval";

export function Github({
  answers,
  patch,
  onNext,
  setTextEditing,
}: ChapterProps): React.JSX.Element {
  const [step, setStep] = useState<Step>("toggle");
  const [repos, setRepos] = useState<WatchedRepoAnswer[]>(answers.github.repos);
  const [nwo, setNwo] = useState("");
  const [path, setPath] = useState("");
  useEffect(() => {
    setTextEditing(step === "nwo" || step === "path");
    return () => setTextEditing(false);
  }, [step, setTextEditing]);

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
      {step === "toggle" && (
        <>
          <Text>Enable the GitHub bridge (issues → tickets)?</Text>
          <Box marginTop={1}>
            <Select
              focus
              options={[
                { value: "off", label: "Off — stay fully local", hint: "recommended to start" },
                { value: "on", label: "On — watch repos for labeled issues" },
              ]}
              onSubmit={(v) => {
                if (v === "off") {
                  patch({ github: { ...answers.github, enabled: false } });
                  onNext();
                } else {
                  setStep("nwo");
                }
              }}
            />
          </Box>
          <Tip>{TIPS.githubOff}</Tip>
        </>
      )}
      {step === "nwo" && (
        <>
          <Text>Watch a repo — owner/repo (empty to finish adding):</Text>
          {repos.map((r) => (
            <Text key={r.nwo}>
              <Text color={theme.success}>✓</Text> {r.nwo} <Text dimColor>({r.path})</Text>
            </Text>
          ))}
          {field(
            nwo,
            setNwo,
            () => (nwo.trim() === "" ? setStep("approval") : setStep("path")),
            "acme/api",
          )}
        </>
      )}
      {step === "path" && (
        <>
          <Text>
            Local clone path for <Text color={theme.accent}>{nwo.trim()}</Text>:
          </Text>
          {field(
            path,
            setPath,
            () => {
              const entry = { nwo: nwo.trim(), path: path.trim() };
              if (entry.path === "") return;
              setRepos((r) => [...r, entry]);
              setNwo("");
              setPath("");
              setStep("nwo");
            },
            "~/code/api (local clone path)",
          )}
        </>
      )}
      {step === "approval" && (
        <>
          <Text>Require your approval before a planned ticket executes?</Text>
          <Box marginTop={1}>
            <Select
              focus
              options={[
                { value: "yes", label: "Yes — plans wait for me", hint: "recommended" },
                { value: "no", label: "No — plan-ready tickets auto-execute" },
              ]}
              onSubmit={(v) => {
                patch({ github: { enabled: true, repos, requireApproval: v === "yes" } });
                onNext();
              }}
            />
          </Box>
          <Tip>{TIPS.githubApproval}</Tip>
        </>
      )}
      {step !== "toggle" && step !== "approval" && <Tip>{TIPS.githubOff}</Tip>}
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify all chapter tests pass**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 13 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/tui/wizard/chapters/RepoSafety.tsx src/tui/wizard/chapters/Github.tsx tests/wizardChapters.test.tsx
git add src/tui/wizard/chapters tests/wizardChapters.test.tsx
git commit -m "feat(wizard): repo-safety and GitHub bridge chapters"
```

---

### Task 9: Extras + Review chapters

**Files:**

- Create: `src/tui/wizard/chapters/Extras.tsx`, `src/tui/wizard/chapters/Review.tsx`
- Test: `tests/wizardChapters.test.tsx` (append)

**Interfaces:**

- Consumes: `MultiSelect`, `Select`, `Tip`, `LEVERS` from `src/configLevers.ts`, `renderConfigJson`/`diffAnswers` from `src/wizard/flow.ts`.
- Produces: `export function Extras(props: ChapterProps)`; `export function Review(props: ReviewProps)` where:

```ts
export interface ReviewProps extends ChapterProps {
  onWrite: () => void; // WizardApp: io.write(answers) then phase="finale"
  onCancel: () => void; // quit without writing
}
```

- [ ] **Step 1: Write the failing tests (append)**

```tsx
import { Extras } from "../src/tui/wizard/chapters/Extras.js";
import { Review } from "../src/tui/wizard/chapters/Review.js";

describe("Extras chapter", () => {
  it("pre-checks the recommended set, shows the focused description, unchecking persists", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const { lastFrame, stdin } = render(
      <Extras
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("OS sandbox"));
    // focused row's LEVERS description shows below the list
    expect(lastFrame()).toContain("Wrap agent tool subprocesses");
    await press(stdin, SPACE); // uncheck sandbox (first row)
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.extras).toEqual({
      sandbox: false,
      verify: true,
      health: true,
      transcripts: true,
    });
  });
});

describe("Review chapter", () => {
  it("fresh mode shows the exact JSON and writes on confirm", async () => {
    let wrote = false;
    const { lastFrame, stdin } = render(
      <Review
        {...noopChapter}
        answers={defaultAnswers()}
        patch={() => {}}
        io={fakeIo()}
        onNext={() => {}}
        onWrite={() => {
          wrote = true;
        }}
        onCancel={() => {}}
      />,
    );
    await until(() => (lastFrame() ?? "").includes('"vaultRoot"'));
    expect(lastFrame()).toContain("junco config list");
    await press(stdin, ENTER); // "Write config" is the first option
    await until(() => wrote);
  });

  it("rerun mode shows a diff, or the untouched note when nothing changed", async () => {
    const raw = { vaultRoot: "/v", model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "k" } };
    const changed = { ...answersFromConfig(raw), vaultRoot: "/v2" };
    const { lastFrame } = render(
      <Review
        {...noopChapter}
        answers={changed}
        patch={() => {}}
        io={fakeIo({ mode: "rerun", currentRaw: raw })}
        onNext={() => {}}
        onWrite={() => {}}
        onCancel={() => {}}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("vaultRoot"));
    expect(lastFrame()).toContain("/v → /v2");

    const same = render(
      <Review
        {...noopChapter}
        answers={answersFromConfig(raw)}
        patch={() => {}}
        io={fakeIo({ mode: "rerun", currentRaw: raw })}
        onNext={() => {}}
        onWrite={() => {}}
        onCancel={() => {}}
      />,
    );
    await until(() => (same.lastFrame() ?? "").includes("Nothing changed"));
  });
});
```

Also add `import { answersFromConfig } from "../src/wizard/flow.js";` and `const SPACE = " ";` at the top if not present.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, cannot find module chapters/Extras.js

- [ ] **Step 3: Write the implementations**

```tsx
// src/tui/wizard/chapters/Extras.tsx
/** Chapter 5 — the optional features, batched into one multiselect (sv-create
 * style) with the recommended set pre-checked. Footer shows the focused
 * lever's real LEVERS description, ConfigView-style. */
import React, { useState } from "react";
import { Box, Text } from "ink";
import { Tip, MultiSelect, type ChapterProps } from "../controls.js";
import { TIPS } from "../../../wizard/tips.js";
import { LEVERS } from "../../../configLevers.js";

const ROWS = [
  { value: "sandbox", label: "OS sandbox for agent commands", lever: "sandbox.enabled" },
  { value: "verify", label: "Verify (build/test) before each PR", lever: "verify.enabled" },
  { value: "health", label: "Health endpoint on 127.0.0.1", lever: "observability.healthEnabled" },
  { value: "transcripts", label: "Per-ticket transcripts", lever: "observability.transcripts" },
] as const;

function describe(leverPath: string): string {
  return LEVERS.find((l) => l.path === leverPath)?.description ?? "";
}

export function Extras({ answers, patch, onNext }: ChapterProps): React.JSX.Element {
  const [focused, setFocused] = useState(0);
  return (
    <Box flexDirection="column">
      <Text>Which extras should stay on? (space toggles, enter continues)</Text>
      <Box marginTop={1}>
        <MultiSelect
          focus
          items={ROWS.map((r) => ({
            value: r.value,
            label: r.label,
            checked: answers.extras[r.value as keyof typeof answers.extras],
          }))}
          onFocusChange={setFocused}
          onSubmit={(vals) => {
            patch({
              extras: {
                sandbox: vals.includes("sandbox"),
                verify: vals.includes("verify"),
                health: vals.includes("health"),
                transcripts: vals.includes("transcripts"),
              },
            });
            onNext();
          }}
        />
      </Box>
      <Box marginTop={1} width={58}>
        <Text dimColor wrap="wrap">
          {describe(ROWS[focused].lever)}
        </Text>
      </Box>
      <Tip>{TIPS.extras}</Tip>
    </Box>
  );
}
```

```tsx
// src/tui/wizard/chapters/Review.tsx
/** Chapter 6 — recap → confirm → write (shadcn: the config file is the
 * product). Fresh mode shows the exact JSON; rerun shows an old → new diff of
 * just the changed lever paths, or the untouched note when there are none. */
import React from "react";
import { Box, Text } from "ink";
import { Tip, Select, type ChapterProps } from "../controls.js";
import { TIPS } from "../../../wizard/tips.js";
import { LEVERS } from "../../../configLevers.js";
import { renderConfigJson, diffAnswers } from "../../../wizard/flow.js";
import { theme } from "../../theme.js";

export interface ReviewProps extends ChapterProps {
  onWrite: () => void;
  onCancel: () => void;
}

const COVERED = 12; // lever paths the walkthrough covers (flow.ts coveredPaths)

export function Review({ answers, io, onWrite, onBack, onCancel }: ReviewProps): React.JSX.Element {
  const diff = io.mode === "rerun" ? diffAnswers(io.currentRaw ?? {}, answers) : null;
  const untouched = diff !== null && diff.length === 0;
  return (
    <Box flexDirection="column">
      {diff === null ? (
        <>
          <Text>This is the exact config.json that will be written:</Text>
          <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1} width={58}>
            <Text>{renderConfigJson(answers).trimEnd()}</Text>
          </Box>
        </>
      ) : untouched ? (
        <Text>Nothing changed — config untouched.</Text>
      ) : (
        <>
          <Text>Changes to {io.configPath}:</Text>
          <Box flexDirection="column" marginTop={1}>
            {diff.map((d) => (
              <Text key={d.path}>
                <Text color={theme.accent}>{d.path}</Text>:{" "}
                <Text dimColor>{JSON.stringify(d.from) ?? "unset"}</Text> →{" "}
                {JSON.stringify(d.to) ?? "unset"}
              </Text>
            ))}
          </Box>
        </>
      )}
      <Box marginTop={1}>
        <Select
          focus
          options={
            untouched
              ? [{ value: "write", label: "Finish" }]
              : [
                  { value: "write", label: io.mode === "rerun" ? "Write changes" : "Write config" },
                  { value: "back", label: "Go back" },
                  { value: "cancel", label: "Quit without writing" },
                ]
          }
          onSubmit={(v) => (v === "write" ? onWrite() : v === "back" ? onBack() : onCancel())}
        />
      </Box>
      <Tip>{`${LEVERS.length - COVERED} ${TIPS.review}`}</Tip>
    </Box>
  );
}
```

Note: `Review`'s tip composes to "63 more levers keep their safe defaults — `junco config list` shows every one." — dynamic from `LEVERS.length`, so it never goes stale.

- [ ] **Step 4: Run to verify all chapter tests pass**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 16 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/tui/wizard/chapters/Extras.tsx src/tui/wizard/chapters/Review.tsx tests/wizardChapters.test.tsx
git add src/tui/wizard/chapters tests/wizardChapters.test.tsx
git commit -m "feat(wizard): Extras multiselect and Review confirm chapters"
```

---

### Task 10: Finale chapter (flight check + staged next steps)

**Files:**

- Create: `src/tui/wizard/chapters/Finale.tsx`
- Test: `tests/wizardChapters.test.tsx` (append)

**Interfaces:**

- Consumes: `ReceiptList`, `Spinner`, `NEXT_STEPS`, `TIPS`, `BIRD`, `WriteResult`, `WizardIO`.
- Produces:

```ts
export interface FinaleProps {
  result: WriteResult;
  io: WizardIO;
  onDone: () => void;
  /** ms between next-step reveals; tests pass 0. Default 150. */
  revealMs?: number;
}
export function Finale(props: FinaleProps): React.JSX.Element;
```

- [ ] **Step 1: Write the failing tests (append)**

```tsx
import { Finale } from "../src/tui/wizard/chapters/Finale.js";

describe("Finale", () => {
  it("shows write receipts, flight-check results, staged next steps, sign-off", async () => {
    let done = false;
    const io = fakeIo({
      flightCheck: async () => [
        { verdict: "ok", label: "inference endpoint", detail: "http://h:1/v1" },
      ],
    });
    const { lastFrame, stdin } = render(
      <Finale
        result={{ written: true, configPath: "/tmp/c.json", queueRoot: "/tmp/q", changes: [] }}
        io={io}
        onDone={() => {
          done = true;
        }}
        revealMs={0}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("✓ Wrote config"));
    await until(() => (lastFrame() ?? "").includes("inference endpoint"));
    await until(() => (lastFrame() ?? "").includes("junco start"));
    await until(() => (lastFrame() ?? "").includes("The nest is ready"));
    await press(stdin, ENTER);
    await until(() => done);
  });

  it("zero-diff rerun says the config was untouched", async () => {
    const { lastFrame } = render(
      <Finale
        result={{ written: false, configPath: "/tmp/c.json", queueRoot: "/tmp/q", changes: [] }}
        io={fakeIo()}
        onDone={() => {}}
        revealMs={0}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("Config untouched"));
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, cannot find module chapters/Finale.js

- [ ] **Step 3: Write the implementation**

```tsx
// src/tui/wizard/chapters/Finale.tsx
/** The finale — write receipts, a doctor-lite flight check, then next steps
 * revealed one line at a time (Astro-style pacing; failures never block:
 * the config is already on disk and every ✗ names its fix). */
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ReceiptList } from "../controls.js";
import { Spinner } from "../../components/Spinner.js";
import { NEXT_STEPS, TIPS, BIRD } from "../../../wizard/tips.js";
import { theme } from "../../theme.js";
import { isMouseInput } from "../../mouse.js";
import type { CheckResult } from "../../../wizard/detect.js";
import type { WriteResult, WizardIO } from "../../../wizard/io.js";

export interface FinaleProps {
  result: WriteResult;
  io: WizardIO;
  onDone: () => void;
  revealMs?: number;
}

export function Finale({ result, io, onDone, revealMs = 150 }: FinaleProps): React.JSX.Element {
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let alive = true;
    void io.flightCheck().then((c) => alive && setChecks(c));
    return () => {
      alive = false;
    };
  }, [io]);
  useEffect(() => {
    if (checks === null || shown >= NEXT_STEPS.length) return;
    const id = setTimeout(() => setShown((n) => n + 1), revealMs);
    return () => clearTimeout(id);
  }, [checks, shown, revealMs]);
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.return) onDone();
  });
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.success}>✓</Text>{" "}
        {result.written
          ? `Wrote config: ${result.configPath}`
          : `Config untouched: ${result.configPath}`}
      </Text>
      <Text>
        <Text color={theme.success}>✓</Text> Queue ready: {result.queueRoot}
        {"/{inbox,processing,done,failed}"}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Flight check</Text>
        {checks ? (
          <ReceiptList items={checks} />
        ) : (
          <Text>
            <Spinner /> probing your setup…
          </Text>
        )}
      </Box>
      {checks && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Next steps</Text>
          {NEXT_STEPS.slice(0, shown).map((s) => (
            <Text key={s.cmd}>
              {"  "}
              <Text color={theme.info}>{s.cmd}</Text> <Text dimColor>— {s.blurb}</Text>
            </Text>
          ))}
        </Box>
      )}
      {checks && shown >= NEXT_STEPS.length && (
        <Box marginTop={1}>
          <Text>
            {TIPS.signoff} {BIRD} <Text dimColor>(enter to finish)</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify all chapter tests pass**

Run: `npx vitest run tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, 18 passed

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/tui/wizard/chapters/Finale.tsx tests/wizardChapters.test.tsx
git add src/tui/wizard/chapters/Finale.tsx tests/wizardChapters.test.tsx
git commit -m "feat(wizard): finale — flight check and staged next steps"
```

---

### Task 11: WizardApp — rail, router, navigation, cancel

**Files:**

- Create: `src/tui/wizard/WizardApp.tsx`
- Test: `tests/wizardApp.test.tsx`

**Interfaces:**

- Consumes: every chapter component, `CHAPTERS`, `useTerminalSize`, `useApp`.
- Produces:

```ts
export interface WizardAppProps {
  io: WizardIO;
  onOutcome: (o: WizardOutcome) => void; // called exactly once before exit
  sizeOverride?: TerminalSize; // tests inject a fixed size
  revealMs?: number; // forwarded to Finale; tests pass 0
}
export function WizardApp(props: WizardAppProps): React.JSX.Element;
```

Key behavior (all asserted below): chapter rail with ✓/▶ marks (hidden under 80 columns → `n/7 · <name>` breadcrumb); global keys — Ctrl-C always cancels, `q` cancels only while no text field is focused, `←`/Esc go back one chapter (Esc on Welcome cancels); Review's Write → `io.write(answers)` → Finale; Finale's enter → outcome `written`/`unchanged`; footer legend always visible.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/wizardApp.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { until } from "./helpers/until.js";
import { WizardApp } from "../src/tui/wizard/WizardApp.js";
import { defaultAnswers } from "../src/wizard/flow.js";
import type { WizardIO } from "../src/wizard/io.js";
import type { WizardAnswers } from "../src/wizard/flow.js";

afterEach(cleanup);
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
async function press(stdin: { write: (s: string) => void }, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}
const SIZE = { columns: 100, rows: 32 };

function fakeIo(over: Partial<WizardIO> = {}): WizardIO {
  const written: WizardAnswers[] = [];
  return {
    mode: "fresh",
    configPath: "/tmp/config.json",
    initialAnswers: defaultAnswers(),
    currentRaw: null,
    greetName: async () => "Ada",
    preflight: async () => [{ verdict: "ok", label: "git", detail: "2.44" }],
    discoverModels: async () => ["m-fast"],
    listModelsJson: () => [],
    write: (a) => {
      written.push(a);
      return { written: true, configPath: "/tmp/config.json", queueRoot: "/tmp/q", changes: [] };
    },
    flightCheck: async () => [{ verdict: "ok", label: "inference endpoint", detail: "up" }],
    ...over,
  };
}

describe("WizardApp", () => {
  it("walks the whole flow Enter-through to a written outcome", async () => {
    let outcome = "";
    const io = fakeIo();
    const writes: WizardAnswers[] = [];
    io.write = (a) => {
      writes.push(a);
      return { written: true, configPath: "/tmp/config.json", queueRoot: "/tmp/q", changes: [] };
    };
    const { lastFrame, stdin } = render(
      <WizardApp io={io} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} revealMs={0} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    expect(lastFrame()).toContain("▶ Welcome");
    await press(stdin, ENTER); // begin
    await until(() => (lastFrame() ?? "").includes("Where should junco"));
    expect(lastFrame()).toContain("✓ Welcome");
    await press(stdin, ENTER); // vaultRoot default
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, ENTER); // inline
    await press(stdin, ENTER); // url default
    await press(stdin, ENTER); // key default
    await until(() => (lastFrame() ?? "").includes("1 model"));
    await press(stdin, ENTER); // pick m-fast
    await until(() => (lastFrame() ?? "").includes("Which folders"));
    await press(stdin, ENTER); // empty roots → continue
    await until(
      () =>
        (lastFrame() ?? "").includes("GitHub bridge") ||
        (lastFrame() ?? "").includes("Enable the GitHub"),
    );
    await press(stdin, ENTER); // Off
    await until(() => (lastFrame() ?? "").includes("Which extras"));
    await press(stdin, ENTER); // keep recommended set
    await until(() => (lastFrame() ?? "").includes('"vaultRoot"'));
    await press(stdin, ENTER); // Write config
    await until(() => (lastFrame() ?? "").includes("The nest is ready"));
    await press(stdin, ENTER); // finish
    await until(() => outcome === "written");
    expect(writes.length).toBe(1);
    expect(writes[0].modelId).toBe("local/m-fast");
  });

  it("q cancels from a non-text chapter; Esc on Welcome cancels", async () => {
    let outcome = "";
    const { lastFrame, stdin } = render(
      <WizardApp io={fakeIo()} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await press(stdin, ESC);
    await until(() => outcome === "cancelled");
  });

  it("q typed into a text field does NOT cancel", async () => {
    let outcome = "none";
    const { lastFrame, stdin } = render(
      <WizardApp io={fakeIo()} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await press(stdin, ENTER); // → Workspace (text field focused)
    await until(() => (lastFrame() ?? "").includes("Where should junco"));
    await press(stdin, "q");
    expect(outcome).toBe("none");
    await until(() => (lastFrame() ?? "").includes("~/Juncoq"));
  });

  it("← goes back a chapter", async () => {
    const { lastFrame, stdin } = render(
      <WizardApp io={fakeIo()} onOutcome={() => {}} sizeOverride={SIZE} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await press(stdin, ENTER);
    await until(() => (lastFrame() ?? "").includes("Where should junco"));
    await press(stdin, "\x1b[D"); // left arrow
    await until(() => (lastFrame() ?? "").includes("press enter to begin"));
  });

  it("narrow terminals swap the rail for a breadcrumb", async () => {
    const { lastFrame } = render(
      <WizardApp io={fakeIo()} onOutcome={() => {}} sizeOverride={{ columns: 60, rows: 32 }} />,
    );
    await until(() => (lastFrame() ?? "").includes("1/7"));
    expect(lastFrame()).not.toContain("▶ Welcome");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wizardApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1, cannot find module WizardApp.js

- [ ] **Step 3: Write the implementation**

```tsx
// src/tui/wizard/WizardApp.tsx
/** The walkthrough shell: chapter rail (✓/▶), chapter router, footer legend,
 * and global navigation keys. Chapters own Enter; this component owns
 * q/Esc/←/Ctrl-C. `textEditing` mutes q while a TextField is focused so "q"
 * can be typed into paths. Outcome is reported exactly once via onOutcome,
 * then the app exits (runInitWizard maps it to an exit code). */
import React, { useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { CHAPTERS, type WizardAnswers } from "../../wizard/flow.js";
import type { WizardIO, WizardOutcome, WriteResult } from "../../wizard/io.js";
import { theme } from "../theme.js";
import { useTerminalSize, type TerminalSize } from "../useTerminalSize.js";
import { isMouseInput } from "../mouse.js";
import { Welcome } from "./chapters/Welcome.js";
import { Workspace } from "./chapters/Workspace.js";
import { Model } from "./chapters/Model.js";
import { RepoSafety } from "./chapters/RepoSafety.js";
import { Github } from "./chapters/Github.js";
import { Extras } from "./chapters/Extras.js";
import { Review } from "./chapters/Review.js";
import { Finale } from "./chapters/Finale.js";

export interface WizardAppProps {
  io: WizardIO;
  onOutcome: (o: WizardOutcome) => void;
  sizeOverride?: TerminalSize;
  revealMs?: number;
}

export function WizardApp({
  io,
  onOutcome,
  sizeOverride,
  revealMs,
}: WizardAppProps): React.JSX.Element {
  const { exit } = useApp();
  const size = useTerminalSize(sizeOverride);
  const narrow = size.columns < 80;
  const [answers, setAnswers] = useState<WizardAnswers>(io.initialAnswers);
  const [idx, setIdx] = useState(0);
  const [result, setResult] = useState<WriteResult | null>(null);
  const textEditing = useRef(false);
  const reported = useRef(false);

  const finishWith = (o: WizardOutcome): void => {
    if (reported.current) return;
    reported.current = true;
    onOutcome(o);
    exit();
  };
  const cancel = (): void => finishWith("cancelled");
  const patch = (p: Partial<WizardAnswers>): void => setAnswers((a) => ({ ...a, ...p }));
  const setTextEditing = (b: boolean): void => {
    textEditing.current = b;
  };
  const next = (): void => setIdx((i) => Math.min(CHAPTERS.length - 1, i + 1));
  const back = (): void => setIdx((i) => Math.max(0, i - 1));
  const write = (): void => setResult(io.write(answers));
  const done = (): void => finishWith(result?.written ? "written" : "unchanged");

  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.ctrl && input === "c") return cancel();
    if (result !== null) {
      if (input === "q") return done(); // config already written — q finishes
      return;
    }
    if (input === "q" && !textEditing.current) return cancel();
    if (key.escape) return idx === 0 ? cancel() : back();
    if (key.leftArrow && !textEditing.current) return back();
  });

  const chapterProps = { answers, patch, onNext: next, onBack: back, io, setTextEditing };
  const body =
    result !== null ? (
      <Finale result={result} io={io} onDone={done} revealMs={revealMs} />
    ) : idx === 0 ? (
      <Welcome {...chapterProps} />
    ) : idx === 1 ? (
      <Workspace {...chapterProps} />
    ) : idx === 2 ? (
      <Model {...chapterProps} />
    ) : idx === 3 ? (
      <RepoSafety {...chapterProps} />
    ) : idx === 4 ? (
      <Github {...chapterProps} />
    ) : idx === 5 ? (
      <Extras {...chapterProps} />
    ) : (
      <Review {...chapterProps} onWrite={write} onCancel={cancel} />
    );

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.accent}>
        junco setup
      </Text>
      <Box marginTop={1}>
        {!narrow && (
          <Box flexDirection="column" width={16} marginRight={2}>
            {CHAPTERS.map((c, i) => {
              const mark = result !== null || i < idx ? "✓" : i === idx ? "▶" : " ";
              return (
                <Text
                  key={c}
                  color={i === idx && result === null ? theme.accent : undefined}
                  dimColor={i > idx && result === null}
                >
                  {mark} {c}
                </Text>
              );
            })}
          </Box>
        )}
        <Box flexDirection="column" flexGrow={1}>
          {narrow && (
            <Text dimColor>
              {result !== null ? "done" : `${idx + 1}/${CHAPTERS.length} · ${CHAPTERS[idx]}`}
            </Text>
          )}
          {body}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>enter continue · ← back · q quit</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/wizardApp.test.tsx tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0, all passing

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/tui/wizard/WizardApp.tsx tests/wizardApp.test.tsx
git add src/tui/wizard/WizardApp.tsx tests/wizardApp.test.tsx
git commit -m "feat(wizard): WizardApp shell — rail, router, navigation"
```

---

### Task 12: Rewire `runInitWizard`, delete the clack prompter

**Files:**

- Rewrite: `src/wizard.ts`
- Delete: `src/wizard/prompter.ts`
- Modify: `package.json` (+ lockfile) via `npm uninstall @clack/prompts`
- Rewrite: `tests/wizard.test.ts`

**Interfaces:**

- Consumes: everything from `flow.js`, `io.js`, `detect.js`, `models.js`, `config.js`.
- Produces (cli.ts relies on): `runInitWizard(configPath: string, deps?: WizardDeps): Promise<number>` — 0 written/unchanged, 130 cancelled, 1 no-raw-mode. `WizardDeps` gains `collectFn?: (io: WizardIO) => Promise<WizardOutcome>` and drops `prompter`/`yes`-era fields except `yes` itself.

- [ ] **Step 1: Rewrite the test file**

Replace `tests/wizard.test.ts` wholesale (the old `scriptedPrompter`, `renderConfigJson`, `defaultAnswers`, `collectAnswers` suites moved to `tests/wizardFlow.test.ts` in Tasks 2–3):

```ts
// tests/wizard.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInitWizard } from "../src/wizard.js";
import { defaultAnswers, answersFromConfig } from "../src/wizard/flow.js";
import type { WizardIO } from "../src/wizard/io.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "wiz-"));
const read = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

describe("runInitWizard --yes", () => {
  it("writes the default config and creates the queue dirs, no prompts", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const prints: string[] = [];
    const code = await runInitWizard(cp, { yes: true, printFn: (s) => prints.push(s) });
    expect(code).toBe(0);
    const cfg = read(cp);
    expect(cfg.vaultRoot).toBe("~/Junco");
    expect((cfg.model as { id: string }).id).toBe("local/my-model");
    expect(prints.join("")).toContain("Wrote config");
    expect(prints.join("")).toContain("junco start");
  });
});

describe("runInitWizard interactive (collectFn seam)", () => {
  it("cancellation returns 130 and writes nothing", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const code = await runInitWizard(cp, { collectFn: async () => "cancelled" });
    expect(code).toBe(130);
    expect(existsSync(cp)).toBe(false);
  });

  it("fresh mode hands collectFn a fresh io; write lands config + dirs", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const code = await runInitWizard(cp, {
      collectFn: async (io: WizardIO) => {
        expect(io.mode).toBe("fresh");
        expect(io.initialAnswers).toEqual(defaultAnswers());
        const a = { ...io.initialAnswers, vaultRoot: join(dir, "vault") };
        const r = io.write(a);
        expect(r.written).toBe(true);
        return "written";
      },
    });
    expect(code).toBe(0);
    expect(read(cp).vaultRoot).toBe(join(dir, "vault"));
    expect(existsSync(join(dir, "vault", "inbox"))).toBe(true);
  });

  it("rerun mode prefills from the file and preserves uncovered keys", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(
      cp,
      JSON.stringify({
        vaultRoot: join(dir, "vault"),
        juncoSubdir: "",
        model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "k" },
        worker: { maxConcurrent: 4 },
      }),
      "utf8",
    );
    const code = await runInitWizard(cp, {
      collectFn: async (io: WizardIO) => {
        expect(io.mode).toBe("rerun");
        expect(io.initialAnswers.modelId).toBe("p/m");
        const a = { ...io.initialAnswers, modelId: "p/m2" };
        expect(io.write(a).written).toBe(true);
        return "written";
      },
    });
    expect(code).toBe(0);
    const cfg = read(cp);
    expect((cfg.model as { id: string }).id).toBe("p/m2");
    expect((cfg.worker as { maxConcurrent: number }).maxConcurrent).toBe(4); // preserved
  });

  it("zero-diff rerun leaves the file byte-identical and returns 0", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(
      cp,
      JSON.stringify({ vaultRoot: join(dir, "vault"), juncoSubdir: "", model: { id: "p/m" } }),
      "utf8",
    );
    const before = readFileSync(cp, "utf8");
    const code = await runInitWizard(cp, {
      collectFn: async (io: WizardIO) => {
        const r = io.write(answersFromConfig(io.currentRaw ?? {}));
        expect(r.written).toBe(false);
        return "unchanged";
      },
    });
    expect(code).toBe(0);
    expect(readFileSync(cp, "utf8")).toBe(before);
    expect(existsSync(join(dir, "vault", "inbox"))).toBe(true); // dirs still ensured
  });
});
```

- [ ] **Step 2: Run to verify the new suite fails against the old wizard**

Run: `npx vitest run tests/wizard.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -8 /tmp/out`
Expected: exit 1 (old `runInitWizard` has no `collectFn`, old exports moved)

- [ ] **Step 3: Rewrite src/wizard.ts**

```ts
// src/wizard.ts
/**
 * `junco init` — the guided setup walkthrough. `--yes` scaffolds the default
 * config with zero prompts (and zero React); interactive runs render the Ink
 * WizardApp (lazy-imported, dashboardCmd-style). All side effects live in the
 * WizardIO built here; the interactive step itself is behind `collectFn`, so
 * every contract below is testable without a TTY.
 *
 * Exit codes: 0 written/unchanged · 130 cancelled · 1 no raw-mode terminal.
 */

import { writeFileSync, readFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { Config } from "./types.js";
import {
  loadConfig,
  queuePaths,
  expandHome,
  resolveConfigPath,
  validateConfigObject,
} from "./config.js";
import {
  defaultAnswers,
  renderConfigJson,
  answersFromConfig,
  diffAnswers,
  applyAnswers,
  type WizardAnswers,
  type AnswerDiff,
} from "./wizard/flow.js";
import type { WizardIO, WizardOutcome } from "./wizard/io.js";
import { greetingName, preflightChecks, flightChecks, type DetectDeps } from "./wizard/detect.js";
import { fetchModels, parseModelsJson } from "./wizard/models.js";
import { NEXT_STEPS } from "./wizard/tips.js";

export interface WizardDeps {
  /** Skip prompts and scaffold from defaults (--yes). */
  yes?: boolean;
  /** Interactive collection seam — the Ink app in production, a fake in tests. */
  collectFn?: (io: WizardIO) => Promise<WizardOutcome>;
  detectDeps?: DetectDeps;
  fetchModelsFn?: typeof fetchModels;
  parseModelsJsonFn?: typeof parseModelsJson;
  writeFileFn?: (path: string, content: string) => void;
  renameFn?: (from: string, to: string) => void;
  readFileFn?: (path: string) => string;
  existsFn?: (path: string) => boolean;
  loadConfigFn?: (path: string) => Config;
  mkdirFn?: (path: string) => void;
  printFn?: (s: string) => void;
  /** Raw-mode probe (tests force true). */
  isInteractiveFn?: () => boolean;
}

function summary(configPath: string, queueRoot: string, wrote: boolean): string {
  const flag = configPath === resolveConfigPath(undefined) ? "" : ` (--config ${configPath})`;
  const head = wrote ? `✓ Wrote config:  ${configPath}\n` : `✓ Config untouched: ${configPath}\n`;
  return (
    `\n${head}` +
    `✓ Queue ready:   ${queueRoot}/{inbox,processing,done,failed}\n\n` +
    `Next steps${flag}:\n` +
    NEXT_STEPS.map((s) => `  • ${s.cmd} — ${s.blurb}\n`).join("")
  );
}

/** Default interactive collector: lazy-import React/Ink + the WizardApp so
 * non-interactive paths never pay the React cost (dashboardCmd pattern). */
async function inkCollect(io: WizardIO): Promise<WizardOutcome> {
  const [react, ink, { WizardApp }] = await Promise.all([
    import("react"),
    import("ink"),
    import("./tui/wizard/WizardApp.js"),
  ]);
  let outcome: WizardOutcome = "cancelled";
  const instance = ink.render(
    react.createElement(WizardApp, {
      io,
      onOutcome: (o: WizardOutcome) => {
        outcome = o;
      },
    }),
    { exitOnCtrlC: true, alternateScreen: true },
  );
  await instance.waitUntilExit();
  return outcome;
}

export async function runInitWizard(configPath: string, deps: WizardDeps = {}): Promise<number> {
  const resolved = resolve(configPath);
  const existsFn = deps.existsFn ?? existsSync;
  const printFn = deps.printFn ?? ((s) => process.stdout.write(s));
  const mkdirFn = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const writeFileFn = deps.writeFileFn ?? ((p, c) => writeFileSync(p, c, "utf8"));
  const readFileFn = deps.readFileFn ?? ((p) => readFileSync(p, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;

  const ensureDirs = (cfg: Config): string => {
    const paths = queuePaths(cfg);
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed, cfg.worktreeRoot]) {
      mkdirFn(d);
    }
    return dirname(paths.inbox);
  };

  if (deps.yes) {
    // Non-interactive scaffold — same minimal default config as ever (the
    // packaged smoke test drives this path headless).
    mkdirFn(dirname(resolved));
    writeFileFn(resolved, renderConfigJson(defaultAnswers()));
    const queueRoot = ensureDirs(loadConfigFn(resolved));
    printFn(summary(resolved, queueRoot, true));
    return 0;
  }

  // A TTY without raw-mode support cannot drive Ink — bail with the fix
  // before loading React (never render a broken UI).
  const interactive = deps.isInteractiveFn
    ? deps.isInteractiveFn()
    : Boolean(process.stdin.isTTY && typeof process.stdin.setRawMode === "function");
  if (!deps.collectFn && !interactive) {
    printFn(
      `junco init: this terminal cannot run the interactive walkthrough.\n` +
        `  Pass --yes to scaffold defaults, or create ${resolved} by hand.\n`,
    );
    return 1;
  }

  const mode: "fresh" | "rerun" = existsFn(resolved) ? "rerun" : "fresh";
  const raw =
    mode === "rerun" ? (JSON.parse(readFileFn(resolved)) as Record<string, unknown>) : null;

  const io: WizardIO = {
    mode,
    configPath: resolved,
    initialAnswers: raw ? answersFromConfig(raw) : defaultAnswers(),
    currentRaw: raw,
    greetName: () => greetingName(deps.detectDeps),
    preflight: () => preflightChecks(deps.detectDeps),
    discoverModels: (baseUrl, apiKey) => (deps.fetchModelsFn ?? fetchModels)(baseUrl, apiKey),
    listModelsJson: (p) => (deps.parseModelsJsonFn ?? parseModelsJson)(expandHome(p)),
    write: (a: WizardAnswers) => {
      let written = false;
      let changes: AnswerDiff[] = [];
      if (mode === "fresh") {
        mkdirFn(dirname(resolved));
        writeFileFn(resolved, renderConfigJson(a));
        written = true;
      } else {
        changes = diffAnswers(raw as Record<string, unknown>, a);
        if (changes.length > 0) {
          const next = applyAnswers(raw as Record<string, unknown>, a);
          validateConfigObject(next);
          // Atomic temp+rename, PID-suffixed (ConfigView/configCmd pattern).
          const tmp = join(dirname(resolved), `.config.json.tmp-${process.pid}`);
          writeFileFn(tmp, JSON.stringify(next, null, 2) + "\n");
          renameFn(tmp, resolved);
          written = true;
        }
      }
      const queueRoot = ensureDirs(loadConfigFn(resolved));
      return { written, configPath: resolved, queueRoot, changes };
    },
    flightCheck: () => flightChecks(loadConfigFn(resolved), deps.detectDeps),
  };

  const outcome = await (deps.collectFn ?? inkCollect)(io);
  if (outcome === "cancelled") {
    printFn("Setup cancelled — nothing written.\n");
    return 130;
  }
  // The alt-screen UI vanished on exit — leave a durable transcript.
  const queueRoot = dirname(queuePaths(loadConfigFn(resolved)).inbox);
  printFn(summary(resolved, queueRoot, outcome === "written"));
  return 0;
}
```

- [ ] **Step 4: Delete the prompter, drop the dependency**

```bash
rm src/wizard/prompter.ts
npm uninstall @clack/prompts
grep -rn "clack" src/ tests/ package.json || echo "clack fully gone"
```

Expected: "clack fully gone" (the grep finds nothing).

- [ ] **Step 5: Run wizard + flow + typecheck to verify**

Run: `npx vitest run tests/wizard.test.ts tests/wizardFlow.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0.
Run: `npm run typecheck > /tmp/tc 2>&1; echo "exit: $?"; tail -5 /tmp/tc`
Expected: exit 0 (catches any stale import of `prompter.js` or the moved `renderConfigJson`/`defaultAnswers`/`collectAnswers` — fix any straggler it names, e.g. cli.test fixtures).

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write src/wizard.ts tests/wizard.test.ts
git add -A
git commit -m "feat(wizard): Ink-backed runInitWizard, clack prompter removed"
```

---

### Task 13: CLI routing — re-run mode + help text

**Files:**

- Modify: `src/cli.ts` (init block at ~736–769, USAGE at ~130–174)
- Test: `tests/cli.test.ts` (modify the init routing describe block)

**Interfaces:**

- Consumes: `runInitWizard` (unchanged signature). The injected `deps.runInitWizardFn` seam and `--yes` passthrough stay exactly as-is.

- [ ] **Step 1: Update the routing tests**

In `tests/cli.test.ts`, find the init describe block (~lines 777–825). The test asserting "config exists → wizard NOT called, dirs ensured" must now hold **only for `--yes`** (and non-TTY). Add/replace so the block covers:

```ts
it("init with existing config routes into the wizard (re-run mode)", async () => {
  // fixture: config file exists; injected runInitWizardFn counts as interactive
  const calls: Array<{ cp: string; yes?: boolean }> = [];
  const code = await run(["init"], {
    ...baseDeps, // whatever the surrounding tests use: existsFn → true, loadConfigFn stub, etc.
    runInitWizardFn: async (cp, o) => {
      calls.push({ cp, yes: o.yes });
      return 0;
    },
  });
  expect(code).toBe(0);
  expect(calls.length).toBe(1);
  expect(calls[0].yes).toBeFalsy();
});

it("init --yes with existing config repairs dirs and does NOT run the wizard", async () => {
  // keep the existing "ensured queue directories" assertions, now under --yes
});
```

Follow the existing helpers in that block for fixtures (`existsFn`, `loadConfigFn`, mkdir spies) — mirror the current "config exists" test, adding `--yes` to its argv.

- [ ] **Step 2: Run to verify the new/changed tests fail**

Run: `npx vitest run tests/cli.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -8 /tmp/out`
Expected: exit 1 — the "routes into the wizard" test fails (old cli returns the repair branch).

- [ ] **Step 3: Rewrite the init block in src/cli.ts**

```ts
// ------------------------------------------------------------
// init: guided setup walkthrough. Fresh config → full wizard; existing
// config + interactive → the wizard's re-run (tune-up) mode; existing
// config + --yes/non-TTY → just ensure the queue dirs (never overwrite).
// ------------------------------------------------------------
if (subcommand === "init") {
  const wantYes = values.yes as boolean;
  const exists = existsFn(resolve(configPath));
  // An injected runInitWizardFn counts as "interactive" (test seam).
  const interactive = Boolean(deps.runInitWizardFn) || Boolean(process.stdin.isTTY);

  if (!exists && !wantYes && !interactive) {
    process.stderr.write(
      `junco init: no config at ${resolve(configPath)} and not an interactive terminal.\n` +
        `  Run \`junco init\` in a terminal, pass --yes to scaffold defaults, or create config.json.\n`,
    );
    return 1;
  }

  if (exists && (wantYes || !interactive)) {
    // Config already present — ensure the queue dirs, never overwrite.
    const cfg = loadConfigFn(configPath);
    const paths = queuePaths(cfg);
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed, cfg.worktreeRoot]) {
      mkdirSync(d, { recursive: true });
    }
    printFn(
      `Config already exists at ${resolve(configPath)}; ensured queue directories:\n` +
        `  inbox:      ${paths.inbox}\n` +
        `  processing: ${paths.processing}\n` +
        `  done:       ${paths.done}\n` +
        `  failed:     ${paths.failed}\n` +
        `  worktrees:  ${cfg.worktreeRoot}\n`,
    );
    return 0;
  }

  const runWizard =
    deps.runInitWizardFn ??
    ((cp: string, o: { yes?: boolean }) => runInitWizard(cp, { yes: o.yes, printFn }));
  return runWizard(configPath, { yes: wantYes });
}
```

Update USAGE:

- init line → `init         Guided setup walkthrough — writes config.json + creates the queue (re-run it anytime to tune settings)`
- The module doc comment line 6 similarly.

- [ ] **Step 4: Run cli tests + typecheck**

Run: `npx vitest run tests/cli.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 0.
Run: `npm run typecheck > /tmp/tc 2>&1; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/cli.ts tests/cli.test.ts
git add src/cli.ts tests/cli.test.ts
git commit -m "feat(cli): junco init re-runs as a tune-up on existing configs"
```

---

### Task 14: Docs, changelog, full gate, smoke test

**Files:**

- Modify: `README.md` (quick-start / init mentions around line 152), `docs/configuration.md` (intro), `CHANGELOG.md` (Unreleased)

- [ ] **Step 1: README**

Find the quick-start paragraph mentioning `junco init --yes` (~line 152). Replace the init sentence(s) with:

> `junco init` walks you through setup in a full-screen guided tour — workspace, inference endpoint + model (with live discovery), repo containment, the GitHub bridge, and the recommended extras — then verifies the result with a flight check. Re-run it anytime to tune an existing config (it only writes what you change). `junco init --yes` scaffolds defaults non-interactively.

- [ ] **Step 2: docs/configuration.md**

After the intro paragraph (line 3), append to it:

> The guided way to produce (or tune) this file is `junco init` — a walkthrough of the settings that matter, with safe defaults for the rest.

- [ ] **Step 3: CHANGELOG.md (Keep a Changelog, under Unreleased)**

```markdown
### Changed

- `junco init` is now a full-screen guided walkthrough (Ink): chapter rail, machine
  preflight, live model discovery, repo-containment and GitHub-bridge setup, an extras
  multiselect, a review-before-write step, and a post-write flight check. Re-running
  `junco init` on an existing config enters a tune-up mode that pre-fills current
  values and writes only what changed (all other keys preserved). `--yes` still
  scaffolds the same minimal default config non-interactively.

### Removed

- `@clack/prompts` dependency (the old prompt-based wizard).
```

- [ ] **Step 4: Full gate + packaged smoke test**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build && npm test
bash scripts/package-smoke.sh
```

Expected: all green; smoke test ends with its success line. If lint flags the two
`react-hooks/exhaustive-deps` disables in Model.tsx, keep the disables (they are
deliberate: the effects key on `step` only) — but confirm the rule name matches the
repo's eslint config before silencing anything else.

- [ ] **Step 5: Commit docs**

```bash
npx prettier --write README.md docs/configuration.md CHANGELOG.md
git add README.md docs/configuration.md CHANGELOG.md
git commit -m "docs: guided setup walkthrough"
```

---

## Plan self-review notes (already applied)

- **Spec coverage:** chapters/rail/keys (Tasks 5–11), warm-guide copy + stack-agnostic guard (Task 1), detect-then-offer + receipts (Tasks 4, 6, 10), recap-confirm-write + minimal fresh config (Tasks 2, 9), preserving re-run (Tasks 3, 12), `--yes`/exit codes/raw-mode guard (Task 12), cli routing + help (Task 13), docs/changelog/dependency removal (Tasks 12, 14). Narrow-terminal breadcrumb: Task 11. Unreachable-endpoint-no-dead-end: Model falls to manual (Task 7) + finale re-probe (Task 10).
- **Types:** `WizardAnswers`/`WizardIO`/`WizardOutcome`/`WriteResult`/`CheckResult`/`AnswerDiff` defined once (Tasks 2–5) and consumed by name everywhere after.
- **Known judgment calls for the implementer:** ink-testing-library timing — if a `press(ENTER)` races a probe-effect, wrap the assertion in `until()` (never lengthen `tick`). If `Select` double-fires on chapters that mount a new `Select` under a still-held Enter, debounce by checking `key.return` only after first render (add `useEffect`-gated `ready` state) — surface it in review rather than silently restructure.
