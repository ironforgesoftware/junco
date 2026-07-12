# Hosted Providers Phase 3 (Product Surface + Cost) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dollars visible and cappable, doctor that actually preflights hosted auth, a wizard hosted path that doesn't sabotage catalog eligibility, and honest docs — PR 3 of 3 for `docs/superpowers/specs/2026-07-11-hosted-providers-design.md` (§4, §5). Stacked on Phase 2 (PR #179).

**Architecture:** The SDK already computes per-turn USD (`usage.cost.total`, per-Mtok pricing applied in every driver — verified pi-ai `models.js:186-197`); junco's accumulator just drops it. So: `Usage` gains `costUsd` summed in `RunAccumulator`; critic/corrective usage stops being discarded and aggregates into the ticket footer + metrics; a tiny persisted `spendLedger` (watchlist.ts pattern) tracks per-day USD; `worker.dailyBudgetUsd` latches a new `budget_exhausted` gate state until local midnight. Doctor gains per-API auth checks via a `getResolvedModelInfo` helper in `session.ts` (the one runtime-SDK-import module). The wizard gains a hosted mode that emits `model: { id }` with NO `baseUrl`/`apiKey` keys.

**Tech Stack:** TypeScript strict/ESM, zod, vitest, Ink (wizard chapters). No new dependencies.

## Global Constraints

- Suite green at every commit; conventional commits; **no AI attribution trailers of any kind**.
- No new dependencies; `src/ticketSchema.ts` untouched.
- Runtime `await import` of the SDK stays ONLY in `src/agent/session.ts` — the new helpers live there; doctor/wizard consume them through injectable deps. Task 10 amends the CLAUDE.md rule text from "inside `makePiSessionFactory`" to "inside `src/agent/session.ts`".
- Prettier before each commit; re-read before editing; vitest exit codes captured directly.
- Config fields ⇒ fixture sweep via `npm run typecheck`. TUI/wizard tests: loop-until-condition, never one fixed tick.
- **Stack-agnostic shipping rule**: no provider names in README body text or wizard marketing copy; provider ids appear only as neutral catalog enumerations/examples. Local-first stays the README's default framing ("no third service **unless you choose one**").
- Money-math discipline: `costUsd` is a float of small magnitude — display with `$X.XXXX` (4 dp), never do equality comparisons in tests (use `toBeCloseTo`).

---

### Task 1: `Usage.costUsd` — stop dropping the SDK's own dollar figure

**Files:** Modify `src/types.ts` (Usage, ~line 215), `src/agent/runResult.ts` (turn_end usage sum, ~lines 48-70). Test: `tests/session.test.ts` (+ the runResult tests file if separate).

**Interfaces:** `Usage` gains `costUsd: number` (0 when the provider/fake reports no cost). `RunAccumulator` sums `e.message.usage.cost?.total ?? 0` per turn_end (SDK `Usage.cost` is USD — pi-ai `types.d.ts:248-269`; cite in the comment). All `Usage` literal builders (crash-result literals in runOnce/prFlow, test fakes) gain `costUsd: 0` — typecheck sweeps them.

- [ ] Failing tests: turn_end with `usage: {input: 10, output: 5, cost: {total: 0.0123}}` twice → `result.usage.costUsd` ≈ 0.0246 (`toBeCloseTo`); fakes without `cost` → 0.
- [ ] Implement + fixture/literal sweep (`npm run typecheck`).
- [ ] Full suite green. Commit: `feat(cost): Usage.costUsd — accumulate the SDK's per-turn USD`

### Task 2: count every session — critic + corrective usage aggregation

**Files:** Modify `src/critic.ts` (CriticResult gains `usage: Usage`, populated from `result.usage`, ~lines 21-25 + 189-191), `src/prFlow.ts` (aggregate main + critic pass 1 + corrective + critic pass 2 usage into the `result` handed to `finalizePr` — sum fields incl. `costUsd`; corrective run at ~710-729 currently discards usage entirely), `src/finalize.ts` (footer lines at :27/:109 gain `cost=$X.XXXX`; `metrics.recordTask` call sites pass costUsd), `src/metrics.ts` (recordTask widens to `{input, output, costUsd?}`; snapshot gains `totalCostUsd`). Tests: `tests/critic.test.ts`, `tests/prFlow.test.ts`, `tests/finalize.test.ts` (or wherever renderPrResult is pinned), `tests/metrics.test.ts`.

**Semantics (each a test):** critic returns its usage; a PR ticket with critic+corrective runs finalizes with footer/metrics usage = sum of all sessions (up to 4); Q&A unchanged single-session; `totalCostUsd` accumulates in snapshot and resets; footer renders `cost=$0.0246`-style 4 dp. NOTE prFlow's requeue exits never reach finalizePr — that's Task 4's ledger's job, do NOT force finalize on requeues.

- [ ] TDD; full suite; commit: `feat(cost): aggregate critic + corrective session usage into ticket accounting`

### Task 3: `spendLedger` — persisted per-day USD

**Files:** Create `src/spendLedger.ts`, test `tests/spendLedger.test.ts`.

**Interfaces:**

```ts
export interface SpendLedgerDeps {
  now?: () => number;
  readFileFn?: typeof readFileSync;
  writeFileFn?: typeof writeFileSync;
  renameFn?: typeof renameSync;
  mkdirFn?: typeof mkdirSync;
}
export interface SpendLedger {
  recordUsd(usd: number): void;
  todayUsd(): number;
  nextMidnightMs(): number;
}
export function makeSpendLedger(stateDir: string, deps?: SpendLedgerDeps): SpendLedger;
```

Semantics: file `join(stateDir, "spend.json")`, shape `{ date: "YYYY-MM-DD", usd: number }` (LOCAL date); `recordUsd` is read-modify-write with the watchlist.ts atomic discipline (mkdir + `.tmp` + rename); date rollover resets to the new day on both read and write; corrupt/missing file → `{today, 0}` never throws (watchlist read discipline, `src/watchlist.ts:28-77` is the template — cite it); `recordUsd(0)` is a no-op (skip the write). `nextMidnightMs()` = start of next LOCAL day per the injected clock (budget gate expiry).

- [ ] TDD with fake clock crossing midnight + injected fs; commit: `feat(cost): spendLedger — persisted per-day USD (state_dir/spend.json)`

### Task 4: record spend at every session site

**Files:** Modify `src/runOnce.ts` (deps gain `spend?: Pick<SpendLedger, "recordUsd">`; record `result.usage.costUsd` right after each `runAgent` — Q&A site AND thread into prFlow deps), `src/prFlow.ts` (deps gain same; record after main, corrective; critic records inside critic call sites via the returned usage), `src/daemon.ts` (construct one `makeSpendLedger(cfg.stateDir)` next to the gate; thread through serial + scheduler runOnce deps). Tests: `tests/runOnce.test.ts`, `tests/prFlow.test.ts`, `tests/daemon.test.ts`.

**Semantics:** spend records for EVERY session including ones whose ticket later requeues (money was spent; requeued attempts currently vanish from accounting — the ledger is the honest record); no spend dep → no-op (CLI run-once unaffected); fake sessions with costUsd 0 record nothing.

- [ ] TDD (fake ledger records calls; requeued-attempt case pinned); commit: `feat(cost): record per-session spend at all runAgent sites`

### Task 5: `worker.dailyBudgetUsd` → `budget_exhausted` gate state

**Files:** Modify `src/providerGate.ts` (GateStateKind gains `"budget_exhausted"`; new `reportBudgetExhausted(untilMs: number, reason: string)` — until-based like rate_limited but **excluded from `reportSuccess()` clearing** (a success doesn't un-spend money; only expiry at midnight or `clearLatched()` clears it) — document + test the asymmetry), `src/config.ts`+`src/types.ts`+`src/configLevers.ts` (`worker.dailyBudgetUsd`, number ≥ 0, default 0 = off; live lever; fixture sweep), `src/daemon.ts` (`gatedReady` checks budget BEFORE the gate/probe: `cfg.dailyBudgetUsd > 0 && spend.todayUsd() >= cfg.dailyBudgetUsd` → `gate.reportBudgetExhausted(spend.nextMidnightMs(), \`daily budget $\${...} reached ($\${today} spent)\`)`then blocked). Tests:`tests/providerGate.test.ts`, `tests/config.test.ts`, `tests/configLevers.test.ts`, `tests/daemon.test.ts`.

**Semantics (each a test):** budget 0 → never consulted; exceeded → claiming pauses with the budget reason, /health+TUI inherit via the existing gate plumbing (no new surface code); expiry at the injected next-midnight resumes claiming; `reportSuccess` does NOT clear it; hot-reload (`clearLatched`) does (operator raised the budget → immediate resume; the next poll re-latches if still exceeded); in-flight-success-then-relatch loop is impossible because success doesn't clear it.

- [ ] TDD; commit: `feat(cost): worker.dailyBudgetUsd — budget_exhausted gate state until local midnight`

### Task 6: spend on the surfaces — /health + TUI header

**Files:** Modify `src/daemon.ts` (healthServer gains `spendToday: () => number` — or fold into the existing metrics snapshot consumption: preferred = `/health` top-level `spend: { todayUsd, dailyBudgetUsd }` via a new healthServer option mirroring gateStatus), `src/healthServer.ts`, `src/tui/localSnapshot.ts` + the dashboard header (spend ticker `$X.XX today` + `/ $budget` when budget on; follow existing header idioms). Tests: `tests/healthServer.test.ts`, `tests/localSnapshotDaemon.test.ts`, TUI test file.

- [ ] TDD (payload shape; absent option → null; TUI renders when present, loop-until); commit: `feat(cost): spend visibility — /health payload + dashboard ticker`

### Task 7: `getResolvedModelInfo` + catalog listing helpers in session.ts

**Files:** Modify `src/agent/session.ts`. Test: `tests/sdkImportSurface.test.ts` (pin any new SDK statics consumed).

**Interfaces (exact — doctor and wizard consume these):**

```ts
export interface ResolvedModelInfo {
  provider: string;
  modelId: string;
  baseUrl: string;
  api: string;
  cost: ModelCost;
  path: "models_json" | "catalog" | "inline";
}
export async function getResolvedModelInfo(
  cfg: Config,
  modelId?: string,
): Promise<ResolvedModelInfo>; // modelId overrides cfg.model.id (planner preflight); throws the cascade's own errors on miss
export interface CatalogEntry {
  provider: string;
  ids: string[];
}
export async function listCatalogProviders(): Promise<CatalogEntry[]>; // from ModelRegistry.inMemory(AuthStorage.inMemory()).getAll(), grouped + sorted alphabetically — complete list, no favorites
```

Both use the same dynamic import + `resolveModelViaRegistries`/registry surface the factory uses (reuse, don't duplicate the ops construction — extract a tiny module-private `sdkRegistryOps(authStorage)` if needed). `getAll()` existence: verify against the SDK d.ts before relying on it; if absent, enumerate via the compat `getProviders/getModels` re-exports reachable from the registry — STOP and report BLOCKED if neither is importable from the root (do not add a pi-ai dependency).

- [ ] Pin test (import-surface) + typecheck/build; the helpers themselves are exercised via doctor/wizard fakes in later tasks (repo convention: no real-SDK unit tests). Commit: `feat(agent): getResolvedModelInfo + listCatalogProviders — session.ts SDK helpers`

### Task 8: doctor — hosted-aware preflight

**Files:** Modify `src/doctor.ts` (+ its deps interface). Test: `tests/doctor.test.ts`.

**Checks (replacing/extending the endpoint block; all behind injectable deps — `resolveInfoFn` defaulting to `getResolvedModelInfo`, `fetchFn`):**

1. **Resolution echo:** `model — <id> resolves via <catalog|models.json|inline> (<baseUrl>)`; a cascade throw → fail with the error text.
2. **Key source echo:** config literal / `$VAR` (resolved) / provider env var name present / none — warn on "none" for non-local providers (`the SDK will look for <PROVIDER>_API_KEY-style env vars at request time` — derive the name generically from the provider string uppercased + `_API_KEY`, labeled "typically").
3. **Auth check (hosted, free routes only):** by `info.api` family — `openai-*` → `GET {baseUrl}/models` Bearer; `anthropic-*` → `GET {baseUrl}/v1/models` with `x-api-key` + `anthropic-version: 2023-06-01`; `google-*` → `GET {baseUrl}/v1beta/models?key=`; other/unknown api → skip with note. 200 → ok `auth verified`; 401/403 → fail `auth rejected (check the key)`; network error → warn `endpoint unreachable`; never a paid completions call — say so in a comment.
4. **Planner preflight:** when `cfg.plannerModelId` set (check actual field name — it lives under github config as `plannerModelId`), resolve it via `resolveInfoFn(cfg, plannerId)` → ok/warn.
5. Local/inline configs: keep the existing probe-based checks exactly (policy-gated as today).

- [ ] TDD with fake resolveInfoFn/fetchFn (all five checks, both auth outcomes, unreachable); commit: `feat(doctor): hosted-aware preflight — resolution, key source, per-API auth check, planner`

### Task 9: wizard flow — hosted mode that PRESERVES catalog eligibility (pure layer)

**Files:** Modify `src/wizard/flow.ts` (+ `src/wizard/detect.ts` if needed). Test: `tests/wizardFlow.test.ts`.

**The trap this task exists to avoid (verified):** `buildConfigObject` writes `model.baseUrl` unconditionally for non-models_json modes (`flow.ts:66`) and `apiKey: a.apiKey ?? ""` (`flow.ts:70`); `answersFromConfig` infers mode solely from `modelsJson` presence (`flow.ts:141`) — a rerun over a hosted config would misclassify it as inline, prefill the localhost baseUrl, and DESTROY catalog eligibility on write.

**Semantics (each a test):**

- `WizardAnswers.mode` widens to `"inline" | "models_json" | "hosted"`.
- Fresh hosted build: emits `model: { id: "<provider/model>" }` — NO `baseUrl` key, NO `apiKey` key when the user left it blank (env-var deferral); a pasted literal or `$VAR` ref emits `apiKey` only. Never emits `source` (auto suffices; keep the config minimal).
- Rerun detection: `answersFromConfig` classifies hosted when the RAW config has no `modelsJson` AND no `baseUrl` key (read the raw parsed object — if the current signature only sees resolved `Config`, use `baseUrlExplicit`); rerun `coveredPaths` for hosted covers `model.id` (+ `model.apiKey` only when changed) and must NOT write `model.baseUrl`.
- Rerun of an inline/models_json config: byte-identical behavior to today (regression net).

- [ ] TDD; commit: `feat(wizard): hosted mode emission + rerun detection — never write baseUrl for catalog configs`

### Task 10: wizard chapter — hosted UI chain

**Files:** Modify `src/tui/wizard/chapters/Model.tsx` (Step union + "hosted" option in the `source` select → `hostedProvider` → `hostedModel` → `key` chain, skipping `url`/`probe`), `src/wizard/io.ts` (gains `listCatalogProviders` seam defaulting to the session.ts helper; injectable for tests), Review.tsx only if secret paths change (they don't — apiKey path unchanged). Tests: `tests/wizardChapters.test.tsx`.

**Semantics:** provider select = complete alphabetical catalog list (no favorites, stack-agnostic); model select filtered to the provider (ids as-is); key step reuses the existing masked TextField step with placeholder text explaining blank = provider env var at runtime; `finish()` in hosted mode uses the picked `provider/id` verbatim (no `inferProvider`); text steps registered in `textSteps`; catalog-load failure → inline fallback message + route back to source step (never a crash). Loop-until test discipline.

- [ ] TDD; commit: `feat(wizard): hosted provider chapter — catalog picker, masked key, env-var default`

### Task 11: docs, README, examples, CLAUDE.md — the positioning pass

**Files:** `README.md` (:15-19 endpoint line → "any OpenAI-compatible endpoint you point it at — or a hosted provider from the embedded catalog"; :99-100 → "no third service in the loop **unless you choose one**"; :149-151 wizard line mentions the hosted path generically; keep provider names OUT of body text), `docs/configuration.md` (hosted-minimal example beside the local one; dailyBudgetUsd), `docs/operations.md` (budget_exhausted row in the gate table; spend surfaces), `examples/` (hosted config variant WITHOUT baseUrl), `CLAUDE.md` (SDK-import rule text → "only inside `src/agent/session.ts`"; keep under 120 lines), `CHANGELOG.md`. Conformance: every claim re-verified against code with file:line in the report.

- [ ] Verify-then-write; prettier; commit: `docs(providers): hosted positioning, budget + spend docs, CLAUDE.md import-rule amendment`

### Task 12: full gate + smoke + whole-branch review + PR

- [ ] Full gate (`exit: 0`), sandboxed init/doctor smoke (local unchanged; hosted config → doctor shows resolution/key-source lines).
- [ ] Whole-branch review (base = phase-2 head a20d927), fix wave, re-review to "Ready to merge".
- [ ] Push; PR titled `feat: hosted product surface — cost accounting, daily budget, doctor auth preflight, wizard hosted path (phase 3/3)` with base `feat/hosted-providers-phase2` (retarget to main after #179 merges — GitHub auto-retargets on base-branch deletion). No AI attribution; trailer sweep.
