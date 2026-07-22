# TUI Hooks Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four #258 follow-ups (#259 prop-stabilization, #260 add `eslint-plugin-react-hooks`, #261 unify React imports, #262 extract `useLocalSnapshot`) in one branch, ending with both react-hooks rules enforced as **errors**.

**Architecture:** A warn→fix→ratchet-to-error path: add the plugin with `exhaustive-deps: warn` (so every commit stays green), fix all 14 discovered warnings + activate the inert memos, then flip to `error`. Finish with the domain-E hook extraction.

**Tech Stack:** TypeScript strict, React 19 + Ink, eslint 9 flat config + typescript-eslint 8.61, `eslint-plugin-react-hooks`, vitest + ink-testing-library.

**Spec:** `docs/superpowers/specs/2026-07-21-tui-hooks-hardening-design.md`

## Discovery (already run — grounds this plan)

`eslint-plugin-react-hooks@7.1.1` run over `src/tui/`: **rules-of-hooks = 0 violations** (clean); **exhaustive-deps = 14 warnings** across 4 files. The full triaged list:

| #   | file:line            | warning                                                                                                                                      | bucket      |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | App.tsx:252          | `runCliFn` logical expr changes deps every render → wrap in `useMemo`                                                                        | stabilize   |
| 2   | App.tsx:674          | useCallback missing `github`                                                                                                                 | github-obj  |
| 3   | App.tsx:757          | useCallback missing `props` → destructure                                                                                                    | destructure |
| 4   | App.tsx:776          | useEffect missing `props` → destructure                                                                                                      | destructure |
| 5   | App.tsx:797          | useEffect missing `props` → destructure                                                                                                      | destructure |
| 6   | App.tsx:861          | useCallback missing `props` → destructure                                                                                                    | destructure |
| 7   | App.tsx:892          | useCallback missing `github`                                                                                                                 | github-obj  |
| 8   | App.tsx:1391         | useMemo missing `github`,`resetPalette`,`setAddRepoError`,`setLogFilters`,`setLogFollow`,`setLogOverlay`,`setLogSearchMode`,`setReviewState` | add-stable  |
| 9   | App.tsx:1491         | useMemo missing `setLogOverlay`,`setLogSearchMode`                                                                                           | add-stable  |
| 10  | useCmdOutput.ts:71   | useCallback missing `setView`                                                                                                                | add-stable  |
| 11  | useGithubData.ts:389 | `currentIssues` conditional changes deps → move into `useMemo`                                                                               | stabilize   |
| 12  | Model.tsx:62         | useEffect missing `setTextEditing`,`textSteps`                                                                                               | wizard      |
| 13  | Model.tsx:74         | useEffect missing `answers.apiKey`,`answers.baseUrl`,`io`                                                                                    | wizard      |
| 14  | Model.tsx:96         | useEffect missing `io`                                                                                                                       | wizard      |

**Framing correction (important):** `exhaustive-deps` flags missing deps _inside_ hook arrays — it does **not** flag the unstable callback _props_ (`railRowPress`/`sectionRowPress`/inline arrows) that make #258's memos inert. So the linter does not "discover" #259; `tests/renderPerf.test.tsx` does. The linter's role for #259 is to _verify_ the `useCallback` fixes have correct deps. They are complementary. (Warnings 1 `runCliFn` and 11 `currentIssues` do overlap with prop-stability — fixing them helps.)

**Stable-identity fact used throughout:** React guarantees `useState`'s setter and `useRef` are stable across renders. So adding a bare `setXxx` / ref to a dep array is **behavior-neutral** (no extra re-identification) and satisfies the rule. `props.xxx` where `xxx` is a stable function/value is likewise safe once destructured.

## Global Constraints

- Node ≥ 22.19, ESM/NodeNext, strict TS; imports use `.js` extensions.
- Dependencies **exact-pinned**: `npm install --save-dev --save-exact eslint-plugin-react-hooks` (discovery used `7.1.1`).
- **No AI attribution in commits.** Amend away any subagent-appended trailer.
- Conventional commits; **full gate green at EVERY commit**: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- **Exit-code trap:** never pipe vitest/eslint into grep for the exit code — redirect, then `echo $?`.
- **The ~189 black-box TUI tests are the behavior invariant** — behavior-preserving throughout; never delete/modify one.
- **Ink test gotcha:** never assert a fixed `setTimeout` tick after a state change — use `tests/helpers/until.ts`'s `until()`.
- Prettier may reformat between read and edit — re-read before editing; `npx prettier --write` touched files before committing.
- **Live runtime:** merge promotes to the daemon. Do not run `junco start`. Green-at-every-commit is the guard.
- **Behaviour rule for every dep-array fix:** the fix must NOT change runtime behavior. Adding a stable setter/ref, or destructuring a prop already read, is safe. If a fix would make a callback re-identify every render (e.g. adding the whole `github` result object), do NOT — use the narrower fix (destructure the specific field) or annotate with a reasoned `// eslint-disable-next-line react-hooks/exhaustive-deps -- <reason>`. Never a blanket file-level disable.

---

## Task 1: Unify React type-imports (#261)

**Files:** Modify `src/tui/hooks/useGithubData.ts`, `src/tui/hooks/usePalette.ts`, `src/tui/hooks/useLogOverlay.tsx`, `src/tui/hooks/useAddRepoForm.ts`.

**Why first:** trivial, no dependencies, and it makes the hooks consistent before the lint pass. `useReview.ts` already uses the target style (named `import type { Dispatch, SetStateAction, MutableRefObject } from "react"`).

- [ ] **Step 1: Find every `React.` type reference in the four files**

```bash
for f in useGithubData usePalette useAddRepoForm; do echo "=== $f.ts"; grep -n "React\.\|import.*React" src/tui/hooks/$f.ts; done
echo "=== useLogOverlay.tsx"; grep -n "React\.\|import.*React" src/tui/hooks/useLogOverlay.tsx
```

- [ ] **Step 2: Convert each**

For each file: add `import type { Dispatch, SetStateAction, MutableRefObject } from "react";` (only the names actually used), remove any `import type React from "react"` / `import React ...` used solely for types, and replace `React.Dispatch`→`Dispatch`, `React.SetStateAction`→`SetStateAction`, `React.MutableRefObject`→`MutableRefObject`. Match `useReview.ts:2` exactly:

```ts
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
```

Do NOT change any runtime import (`useState`/`useCallback`/etc. stay as they are). These are type-only edits.

- [ ] **Step 3: Verify no `React.` type refs remain + gate**

```bash
grep -rn "React\." src/tui/hooks/ ; echo "--- (empty = all converted)"
npm run typecheck > /tmp/tc.txt 2>&1; echo "typecheck exit: $?"
npx vitest run > /tmp/t.txt 2>&1; echo "suite exit: $?"; grep -E "Tests " /tmp/t.txt
```

Expected: no `React.` refs in hooks; typecheck exit 0; suite green (3205).

- [ ] **Step 4: prettier + eslint + commit**

```bash
npx prettier --write src/tui/hooks/*.ts src/tui/hooks/*.tsx
git add src/tui/hooks/ && git commit -m "refactor(tui): unify React type-imports across the hooks (#261)"
```

---

## Task 2: Add eslint-plugin-react-hooks — rules-of-hooks:error, exhaustive-deps:warn (#260a)

**Files:** Modify `package.json` (devDep), `eslint.config.js`.

**Interfaces:**

- Produces: the react-hooks config block later tasks drive down to zero warnings and then flip to error.

- [ ] **Step 1: Install the plugin, exact-pinned**

```bash
npm install --save-dev --save-exact eslint-plugin-react-hooks@7.1.1
```

- [ ] **Step 2: Add the config block**

In `eslint.config.js`: add `import reactHooks from "eslint-plugin-react-hooks";` at the top, and append this object as the LAST entry in the `tseslint.config(...)` call (after the existing rules block):

```js
  {
    files: ["src/tui/**/*.ts", "src/tui/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
```

- [ ] **Step 3: Confirm rules-of-hooks passes and exactly 14 exhaustive-deps warnings surface**

```bash
npx eslint src/tui > /tmp/rh.txt 2>&1; echo "eslint exit: $? (expect 0 — warnings don't fail)"
echo "rules-of-hooks violations: $(grep -c rules-of-hooks /tmp/rh.txt) (expect 0)"
echo "exhaustive-deps warnings: $(grep -c exhaustive-deps /tmp/rh.txt) (expect 14)"
```

Expected: exit 0, 0 rules-of-hooks, 14 exhaustive-deps. If rules-of-hooks > 0, STOP and report (that's a real hook-ordering bug, not expected). If the exhaustive-deps count differs from 14, re-triage before proceeding (the tree may have shifted).

- [ ] **Step 4: Full gate (lint must still pass — warnings are not errors)**

```bash
npm run lint > /tmp/l.txt 2>&1; echo "lint exit: $?"
npm run typecheck > /tmp/tc.txt 2>&1; echo "typecheck exit: $?"
npx vitest run > /tmp/t.txt 2>&1; echo "suite exit: $?"; grep -E "Tests " /tmp/t.txt
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json eslint.config.js
git commit -m "chore(tui): add eslint-plugin-react-hooks (rules-of-hooks error, exhaustive-deps warn) (#260)"
```

---

## Task 3: Fix the add-stable-dep + destructure-props warnings (7 of 14)

**Files:** Modify `src/tui/App.tsx`, `src/tui/hooks/useCmdOutput.ts`.

Handles warnings 3,4,5,6 (destructure), 8,9 (add stable setters), 10 (add setView). All behavior-neutral (see the stable-identity fact + the behaviour rule in Global Constraints).

- [ ] **Step 1: Add stable setters — warnings 8, 9, 10**

- `useCmdOutput.ts:71` — add `setView` to that `useCallback`'s dep array. `setView` is a param that is App's `useState` setter (stable), so this is behavior-neutral.
- `App.tsx:1391` — add the 8 named missing deps (`github`, `resetPalette`, `setAddRepoError`, `setLogFilters`, `setLogFollow`, `setLogOverlay`, `setLogSearchMode`, `setReviewState`) to that `useMemo`'s dep array. `setXxx` are stable setters; `resetPalette` is a `useCallback` (stable); `github` is the useGithubData result — **verify `github`'s handlers used here are already covered; if adding `github` (the whole object) would churn the memo every render, instead add the specific `github.<field>` values referenced inside, or annotate `github` with a reason.** Read the memo body first.
- `App.tsx:1491` — add `setLogOverlay`, `setLogSearchMode` (stable setters).

- [ ] **Step 2: Destructure props — warnings 3, 4, 5, 6**

For each of `App.tsx:757` (useCallback), `:776` (useEffect), `:797` (useEffect), `:861` (useCallback): the hook reads `props.<x>`. At the top of `App`'s body (near the existing `const { … } = props;` destructure, ~line 247), add the specific prop(s) each site reads, then reference the destructured name inside the hook and add it to the dep array. Read each site to see which `props.<x>` it uses (likely `props.githubEnabled`, `props.localCheapFn`, etc.). Do NOT add the whole `props` object to any dep array (that re-fires on every prop change).

- [ ] **Step 3: Re-run the linter — warning count should drop from 14 to 7**

```bash
npx eslint src/tui > /tmp/rh.txt 2>&1; echo "exhaustive-deps now: $(grep -c exhaustive-deps /tmp/rh.txt) (expect 7)"
```

- [ ] **Step 4: Behavior invariant — full suite green**

```bash
npm run typecheck > /tmp/tc.txt 2>&1; echo "typecheck: $?"
npx vitest run > /tmp/t.txt 2>&1; echo "suite: $?"; grep -E "Tests " /tmp/t.txt
```

Expected: exit 0, 3205 tests. If any black-box test fails, a "behavior-neutral" fix wasn't — revert that specific fix and re-examine (likely the `github`-object case; use the narrower destructure or annotate).

- [ ] **Step 5: prettier + eslint + commit**

```bash
npx prettier --write src/tui/App.tsx src/tui/hooks/useCmdOutput.ts
git add src/tui/App.tsx src/tui/hooks/useCmdOutput.ts
git commit -m "refactor(tui): fix stable-dep and destructure-props exhaustive-deps warnings"
```

---

## Task 4: Prop-stabilization + activate the inert memos (#259) + the stabilize warnings

**Files:** Modify `src/tui/App.tsx`, `src/tui/hooks/useGithubData.ts`, `tests/renderPerf.test.tsx`.

The performance task. Handles warnings 1 (`runCliFn`), 2 & 7 (`github`), 11 (`currentIssues`) AND #259's actual fix (the row-press handlers + inline arrows that keep 9 memos inert). `tests/renderPerf.test.tsx` is the oracle.

- [ ] **Step 1: Capture the current renderPerf baseline**

```bash
JUNCO_RENDER_COUNT=1 npx vitest run tests/renderPerf.test.tsx > /tmp/perf-before.txt 2>&1; echo "exit: $?"
```

Note which components the test currently records as re-rendering on an unrelated poll (per #258: only ActivityCard + PrPreview bail out; the other 9 bump).

- [ ] **Step 2: Stabilize `runCliFn` — warning 1**

`App.tsx:252` — `runCliFn` is currently `props.runCliFn ?? ((name, extraArgs) => runCliCommand(configPath, name, extraArgs))`, a fresh arrow each render that churns `runPaletteCommand`/`paletteEnter` identity. Wrap it:

```ts
const runCliFn = useMemo(
  () =>
    props.runCliFn ??
    ((name: string, extraArgs: string[]) => runCliCommand(configPath, name, extraArgs)),
  [props.runCliFn, configPath],
);
```

- [ ] **Step 3: Stabilize `railRowPress` / `sectionRowPress` (#259)**

Read `App.tsx` around lines 2009 (`railRowPress`) and 2026 (`sectionRowPress`) — plain component-body functions passed as `onRowPress` to the memo'd `UnifiedRail`/section components. Wrap each in `useCallback` with its real deps. Because `exhaustive-deps` is now on, the linter tells you the exact deps — add them; if a dep is itself unstable, stabilize _it_ rather than widening until the callback re-identifies every render (which would re-defeat the memo). Prefer stabilizing the source.

- [ ] **Step 4: Stabilize the inline JSX arrows feeding memo'd components**

The `onWheel={(d) => scrollBy(d)}`, `onRowPress={(i) => {…}}`, `assess={(nwo) => …}` arrows (multiple sites in App's render) are recreated each render, defeating the memo on their target components. For each arrow passed to a memo'd component (`IssueList`, `PrList`, `UnifiedRail`, `RepoDetail`, `Preview`, `QueueView`, the sections), hoist it to a `useCallback` (or pass the stable underlying function directly if the arrow only forwards args, e.g. `onWheel={scrollBy}` when signatures match). Read each call site; keep behavior identical.

- [ ] **Step 5: Fix warnings 2, 7 (`github`) and 11 (`currentIssues`)**

- `App.tsx:674` and `:892` — `useCallback` missing `github`. If these callbacks call `github.<method>`, destructure the specific methods used (`const { evictRepo, refreshAll } = github;`) and depend on those (they're `useCallback`s from the hook — stable), rather than the whole `github` object. If genuinely dependent on the whole object, annotate with a reason.
- `useGithubData.ts:389` — `currentIssues` is a conditional/derived value making the `useMemo` at :392 change every render. Apply eslint's suggested fix: move the `currentIssues` computation inside the `useMemo` callback, or wrap it in its own `useMemo`.

- [ ] **Step 6: Re-run the linter — the 4 stabilize warnings clear (7 → 3, leaving only the 3 wizard ones)**

```bash
npx eslint src/tui > /tmp/rh.txt 2>&1; echo "exhaustive-deps now: $(grep -c exhaustive-deps /tmp/rh.txt) (expect 3 — the Model.tsx wizard warnings)"
grep exhaustive-deps /tmp/rh.txt | grep -c Model || true
```

- [ ] **Step 7: Measure the memo activation + extend the perf test**

```bash
JUNCO_RENDER_COUNT=1 npx vitest run tests/renderPerf.test.tsx > /tmp/perf-after.txt 2>&1
```

Components that were bumping on an unrelated poll should now be flat. In `tests/renderPerf.test.tsx`, extend the assertions to the newly-flattened components (assert their render count stays 0 across the unrelated re-render). If a component is STILL bumping, its prop chain has another unstable link — trace it (a parent-level inline object/array prop) and stabilize, or document in the commit that it remains inert and why.

- [ ] **Step 8: Behavior invariant — full suite green**

```bash
npm run typecheck > /tmp/tc.txt 2>&1; echo "typecheck: $?"
npx vitest run > /tmp/t.txt 2>&1; echo "suite: $?"; grep -E "Tests " /tmp/t.txt
```

Expected: exit 0. **Watch for stale-closure regressions** — a `useCallback` with a missing dep reads stale state; the black-box tests that exercise the row-press/wheel handlers are the net, and `exhaustive-deps` (on) is the static guard.

- [ ] **Step 9: prettier + eslint + commit** with the before/after render-count deltas in the body:

```bash
npx prettier --write src/tui/App.tsx src/tui/hooks/useGithubData.ts tests/renderPerf.test.tsx
git add src/tui/App.tsx src/tui/hooks/useGithubData.ts tests/renderPerf.test.tsx
git commit -m "perf(tui): stabilize callback props so the memo'd components bail out (#259)"
```

---

## Task 5: Fix the wizard exhaustive-deps warnings (12, 13, 14)

**Files:** Modify `src/tui/wizard/chapters/Model.tsx`.

Pre-existing warnings unrelated to the #258 hooks; must clear before the ratchet to error.

- [ ] **Step 1: Read the three effects** at `Model.tsx:62`, `:74`, `:96` and their missing deps (`setTextEditing`,`textSteps`; `answers.apiKey`,`answers.baseUrl`,`io`; `io`).

- [ ] **Step 2: Fix each** — add the missing deps if doing so is behavior-neutral (stable setters/refs, or values the effect should react to). If an effect deliberately runs once-on-mount or must not re-fire on one of the flagged values, annotate `// eslint-disable-next-line react-hooks/exhaustive-deps -- <reason>` with a concrete reason. Read each effect to decide; the wizard's behavior is covered by `tests/wizardChapters.test.tsx` / `tests/wizardModels.test.ts`.

- [ ] **Step 3: Linter clean + gate**

```bash
npx eslint src/tui > /tmp/rh.txt 2>&1; echo "exhaustive-deps now: $(grep -c exhaustive-deps /tmp/rh.txt) (expect 0)"
npx vitest run tests/wizardChapters.test.tsx tests/wizardModels.test.ts > /tmp/w.txt 2>&1; echo "wizard tests: $?"; grep -E "Tests " /tmp/w.txt
npx vitest run > /tmp/t.txt 2>&1; echo "full suite: $?"; grep -E "Tests " /tmp/t.txt
```

Expected: 0 exhaustive-deps warnings; all green.

- [ ] **Step 4: prettier + eslint + commit**

```bash
npx prettier --write src/tui/wizard/chapters/Model.tsx
git add src/tui/wizard/chapters/Model.tsx
git commit -m "refactor(tui): clear the wizard exhaustive-deps warnings"
```

---

## Task 6: Ratchet exhaustive-deps to error (#260b)

**Files:** Modify `eslint.config.js`.

- [ ] **Step 1: Confirm zero warnings remain**

```bash
npx eslint src/tui > /tmp/rh.txt 2>&1; echo "exhaustive-deps: $(grep -c exhaustive-deps /tmp/rh.txt) (must be 0)"
```

If not 0, STOP — a prior task left a warning; do not flip to error over a non-empty list.

- [ ] **Step 2: Flip warn → error** in `eslint.config.js`:

```js
      "react-hooks/exhaustive-deps": "error",
```

- [ ] **Step 3: Full gate — lint must now pass with BOTH rules as errors**

```bash
npm run lint > /tmp/l.txt 2>&1; echo "lint exit: $? (must be 0)"
npm run format:check > /tmp/f.txt 2>&1; echo "format: $?"
npm run typecheck > /tmp/tc.txt 2>&1; echo "typecheck: $?"
npm run build > /tmp/b.txt 2>&1; echo "build: $?"
npx vitest run > /tmp/t.txt 2>&1; echo "suite: $?"; grep -E "Tests " /tmp/t.txt
```

Expected: all exit 0. This is the acceptance criterion for #260.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js
git commit -m "chore(tui): enforce react-hooks/exhaustive-deps as an error (#260)"
```

---

## Task 7: Extract `useLocalSnapshot` (#262)

**Files:** Create `src/tui/hooks/useLocalSnapshot.ts`, `tests/useLocalSnapshot.test.tsx`. Modify `src/tui/App.tsx`.

**Interfaces:**

- Produces: `useLocalSnapshot(opts): { localCheap, localHeavy, sectionCursor, repoDetailTarget, setSectionCursor, setRepoDetailTarget }` — mirrors the #258 hook seam pattern (see `src/tui/hooks/useGithubData.ts` for the nav-input + injected-fn shape).

Extract domain E from App: `localCheap`/`localHeavy`/`sectionCursor`/`repoDetailTarget` state + the two polling effects (cheap @3s **section-scoped**, heavy @15s). The extraction happens under the now-strict lint, so the new hook's deps are enforced from birth.

- [ ] **Step 1: Map the surface** — grep the current App.tsx for the state + effects (line numbers drift; locate by content):

```bash
grep -n "localCheap\|localHeavy\|sectionCursor\|repoDetailTarget\|localCheapFn\|localHeavyFn\|localCheapPollMs\|localHeavyPollMs" src/tui/App.tsx
```

Read the two polling effects in full. Note every nav value the cheap poll reads (`sysSection` scopes it) — those become hook inputs.

- [ ] **Step 2: Write the Probe unit test first** `tests/useLocalSnapshot.test.tsx` (mirror `tests/useGithubData.test.tsx`'s Probe): a Probe calls `useLocalSnapshot` with fake `localCheapFn`/`localHeavyFn` (large poll intervals) and a `sysSection` prop; assert (a) the cheap snapshot populates on mount (poll via `until()`), (b) the heavy snapshot populates, (c) changing `sysSection` via rerender re-invokes `localCheapFn` with the new section (the section-scoping behavior). Run → FAIL (module not found).

- [ ] **Step 3: Create the hook** — move the 4 state declarations + the two effects VERBATIM into `src/tui/hooks/useLocalSnapshot.ts`, taking `{ localCheapFn, localHeavyFn, localCheapPollMs, localHeavyPollMs, sysSection, aliveRef? }` as opts (match what the effects actually read). Preserve the `alive`/AbortController guards and cleanup exactly. Expose `setSectionCursor`/`setRepoDetailTarget` for App-resident cascade/JSX writes (the #258 exposed-setter pattern). The hook's own deps must satisfy `exhaustive-deps: error`.

- [ ] **Step 4: Run the unit test → PASS.**

- [ ] **Step 5: Wire into App** — replace the 4 state decls + the two effects with `const { localCheap, localHeavy, sectionCursor, repoDetailTarget, setSectionCursor, setRepoDetailTarget } = useLocalSnapshot({ … });`. All existing references stay identical. `sysSection` is derived in App (nav spine) and passed in.

- [ ] **Step 6: Full gate (incl. strict lint)**

```bash
npm run lint > /tmp/l.txt 2>&1; echo "lint: $?"
npm run typecheck > /tmp/tc.txt 2>&1; echo "typecheck: $?"
npx vitest run > /tmp/t.txt 2>&1; echo "suite: $?"; grep -E "Tests " /tmp/t.txt
```

Expected: all exit 0. The local-section black-box tests (`tests/tuiLocalApp.test.tsx`, `tests/tuiLocalActions.test.tsx`, `tests/tuiActivityCard.test.tsx`) are the behavior net.

- [ ] **Step 7: prettier + eslint + commit**

```bash
npx prettier --write src/tui/App.tsx src/tui/hooks/useLocalSnapshot.ts tests/useLocalSnapshot.test.tsx
git add src/tui/App.tsx src/tui/hooks/useLocalSnapshot.ts tests/useLocalSnapshot.test.tsx
git commit -m "refactor(tui): extract useLocalSnapshot from App (#262)"
```

---

## Task 8: Close-out

**Files:** Modify `ARCHITECTURE.md` (if the hook count note needs it); optionally `CLAUDE.md`.

- [ ] **Step 1: Update the ARCHITECTURE.md `hooks/` note** to include `useLocalSnapshot` in the hook list (the `tui/` row lists the hooks; add it).
- [ ] **Step 2: CLAUDE.md** — add ONE line to the testing-gotchas or the commands note only if a genuine new gotcha emerged (e.g. "react-hooks eslint is on; a new hook's deps are enforced"). Otherwise skip — do not pad.
- [ ] **Step 3: Final full gate + report**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/final.txt 2>&1; echo "exit: $?"; grep -E "Test Files|Tests " /tmp/final.txt
echo "App.tsx: $(wc -l < src/tui/App.tsx) lines (was 2421 at #258 merge)"
echo "exhaustive-deps warnings: $(npx eslint src/tui 2>&1 | grep -c exhaustive-deps) (must be 0, and it's now error-level)"
```

- [ ] **Step 4: Commit** `docs(tui): note useLocalSnapshot in ARCHITECTURE.md`

The four issues close on merge: #259 (memo activation — measured), #260 (both rules error), #261 (imports unified), #262 (useLocalSnapshot).

## Do-not / preserve

- **Never add the whole `props` object or the whole `github` result object to a dep array** — that re-fires on every change and defeats the point. Destructure the specific field, or annotate with a reason.
- **A stabilized callback must keep identical behavior** — no stale closures. `exhaustive-deps: error` + the black-box tests are the dual guard.
- **No blanket file-level eslint-disable.** Every disable is a single line with a concrete reason.
- The nav spine, composition stack, and input cascade stay in App (unchanged from #258).

## Follow-ups (file if they arise)

- If Task 4 finds a component that stays inert due to a deep prop chain, note it — a second stabilization pass may be warranted.
- The pre-existing `useWatchlist` render-phase `readWatchlist()` (moved-not-introduced in #258) — out of scope unless a warning implicates it.
