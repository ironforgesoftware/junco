# Wizard Follow-up Fixes Implementation Plan (#173–#177)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Each task's authoritative requirements live in its GitHub issue; this plan pins the design decisions and interfaces so the fixes land coherently on `feat/setup-wizard-walkthrough` (PR #178 then closes all five on merge).

**Goal:** Resolve issues #173 (security: apiKey masking), #174 (write-path polish), #175 (nwo update-in-place), #176 (helper/literal dedup), #177 (test hardening) on the PR branch.

**Architecture:** No new modules except `src/execProbe.ts` (Task D). All fixes follow patterns already in the branch: ConfigView's secret discipline, the injectable-deps seams, `until()`-bounded Ink tests.

## Global Constraints

- Suite green at every commit; conventional commits ending with the issue ref, e.g. `fix(wizard): mask model.apiKey across the walkthrough (#173)`.
- No AI attribution. No new dependencies. TypeScript strict ESM, `.js` suffixes.
- Vitest exit-code trap: `npx vitest run <file> > /tmp/out 2>&1; echo "exit: $?"`.
- Masking is DISPLAY-ONLY: the written config.json always carries the real key; `renderConfigJson`/`buildConfigObject`/round-trip tests must not change.
- Full gate + packaged smoke after the last task; PR body updated to `Closes #173` … `Closes #177`.

---

### Task A — #173: mask `model.apiKey` everywhere the wizard shows it

**Files:** `src/tui/wizard/chapters/Model.tsx`, `src/tui/wizard/chapters/Review.tsx`, tests in `tests/wizardChapters.test.tsx` (+ `tests/wizardApp.test.tsx` only if existing assertions reference the raw key).

Decisions:

- **Model key step** keeps a local `keyDraft` state: initialized `""` in rerun mode (`io.mode === "rerun"`), `answers.apiKey ?? ""` in fresh mode. TextField gets `mask` (prop exists). Rerun placeholder: `"unchanged — enter keeps the current key"`. Submit: trimmed-empty draft → keep `answers.apiKey` untouched; otherwise `patch({ apiKey: draft })`. Then `setStep("probe")` as today (probe reads the post-patch answers on the next commit).
- **Review redaction**: derive secret paths once — `const SECRET_PATHS = LEVERS.filter((l) => l.type === "secret").map((l) => l.path);` (today: `["model.apiKey"]`). Fresh mode: deep-clone `buildConfigObject(answers)`, `setAtPath(clone, p, "••••")` for each secret path whose `getAtPath` is a non-empty string, render the clone (import `getAtPath`/`setAtPath` from `configLevers.js`; `renderConfigJson` itself unchanged). Rerun diff: when `d.path` is in `SECRET_PATHS`, render `•••• → ••••` (both sides masked; the point is "it changed", not the values).
- **Tests** (drive real components): key step renders `•` and never the literal key, fresh and rerun; rerun empty-submit keeps the stored key (assert `discoverModels` was called with the stored key, and `answers.apiKey` unchanged); rerun non-empty submit patches the new key; fresh Review frame contains `"••••"` and NOT the key literal; rerun diff with a changed key shows masked arrows and no literals. Grep the existing wizardApp walkthrough tests for `"1234"`/`"k"` frame assertions and adjust only if they break.

### Task B — #174: write-path truthfulness, tmp cleanup, banner brevity

**Files:** `src/wizard.ts`, `src/tui/wizard/WizardApp.tsx`, `tests/wizard.test.ts`, `tests/wizardApp.test.tsx`.

Decisions:

- **Truthful cancel after partial write**: `runInitWizard` keeps a closure flag `let wroteFile = false`, set immediately after the successful config write inside `io.write` (both modes). On `outcome === "cancelled"`: if `wroteFile`, print `Setup did not finish — but the config WAS written to <resolved>.\n  Run junco doctor to verify the rest.\n` (exit stays 130); else today's "nothing written" line.
- **Tmp cleanup**: add `unlinkFn?: (p: string) => void` to `WizardDeps` (default `unlinkSync`). Wrap the rename in try/catch: on throw, best-effort `try { unlinkFn(tmp) } catch {}` then rethrow. Applies to both branches (fresh + rerun share the temp+rename shape).
- **Banner brevity**: in WizardApp's write catch, display `const brief = msg.split("\n")[0].slice(0, 120)` (append `…` when truncated). `validateConfigObject` throws a raw ZodError whose `.message` is a multi-line JSON blob (verified `src/config.ts:364-366`), so first-line + cap is the right display trim; the full error still reaches nothing else (banner is the only consumer).
- **Tests**: (1) collectFn whose `io.write` throws after `writeFileFn` succeeded (make `loadConfigFn` throw) then returns "cancelled" → printFn output matches `config WAS written`; (2) `renameFn` that throws → `unlinkFn` spy called with the PID temp path, error propagates; (3) wizardApp: `io.write` throwing `new Error("line1\nline2")` → frame shows `line1`, not `line2`.

### Task C — #175: duplicate nwo re-entry updates the path

**Files:** `src/tui/wizard/chapters/Github.tsx`, `tests/wizardChapters.test.tsx`.

Decision: in the path-step submit, replace the existing entry instead of skipping: if `answers.github.repos.some((r) => r.nwo === entry.nwo)` → `patch` with `repos.map((r) => (r.nwo === entry.nwo ? entry : r))`; else append as today. Update the existing "adding the same nwo twice results in one entry" test to also assert the path is the SECOND path (update-in-place), and keep the single-entry assertion.

### Task D — #176: extract shared probe helpers; consolidate flow defaults

**Files:** create `src/execProbe.ts`; modify `src/doctor.ts`, `src/wizard/detect.ts`, `src/wizard/flow.ts`. Tests: existing suites pin behavior (no new tests required; typecheck catches misses).

Decisions:

- `src/execProbe.ts` exports `defaultExec(cmd, args)` and `defaultAccessOk(dir)` — moved verbatim (10s timeout, ENOENT→127, mkdir+W_OK). Doctor and detect delete their local copies and import; keep doctor's exported behavior byte-identical (its worker.py provenance comments stay with the call sites, not the helpers).
- `flow.ts`: inside `buildConfigObject` and `coveredPaths`, take `const d = defaultAnswers()` and use `d.modelsJson`-style fallbacks instead of repeated literals — concretely `a.modelsJson ?? d.modelsJson!`… note `defaultAnswers()` has no `modelsJson` (mode inline) — so add the models.json literal as a module const `DEFAULT_MODELS_JSON = "~/.pi/agent/models.json"` used by both sites, and `d.baseUrl!`/`d.apiKey!` for the inline pair. `answersFromConfig` github/extras fallbacks read `d.github.enabled`, `d.github.repos`, `d.github.requireApproval`, `d.extras.*` instead of literals.

### Task E — #177: test hardening (tests only)

**Files:** `tests/wizardApp.test.tsx`, `tests/wizardFlow.test.ts`.

- Finale rail: in the existing walkthrough test, after `"The nest is ready"` appears, assert every chapter shows `✓` (e.g. frame matches `✓ Review` and contains no `▶`).
- Reverse mode-switch: `applyAnswers` test — start from an inline raw config, switch answers to `mode: "models_json"` + `modelsJson`, assert output JSON contains `modelsJson` and neither `baseUrl` nor `apiKey` under `model`.
- Delete the two unfalsifiable `<=` assertions in the `COVERED_LEVER_COUNT` drift-guard test (the `toBe(13)` pin stays; adjust its comment).

---

### Close-out

1. Full gate (`lint`, `format:check`, `typecheck`, `build`, `test`) + `scripts/package-smoke.sh`.
2. PTY E2E re-run (fresh + rerun no-op) — the key-step interaction changed in Task A.
3. Consolidated review of the combined diff; fix findings.
4. `gh pr edit 178` — add `Closes #173`–`Closes #177`, update the security section to say the fix landed in-branch.
5. Push.
