---
id: add-string-utils-2026-05-31
priority: normal
timeout_minutes: 30
repo: ~/code/your-project
base_branch: main
pr_title: "Add string utility helpers and unit tests"
draft: true
---

# Add string utility helpers and unit tests

## Why

The project has ad-hoc string truncation and slugification scattered across multiple modules.
The goal is one `src/utils/strings.ts` helper module with two exported functions — `truncate`
and `slugify` — imported by callers instead of each one reimplementing the logic.

## Pre-flight context (verified at plan time)

- Build: TypeScript strict; `npm run build` runs `tsc --noEmit`
- Test runner: Vitest 2.x; `npm test` runs `vitest run`
- Conventions: `src/utils/index.ts` is the barrel for utilities; new exports go there
- Quirks: no path aliases configured — use relative imports

## Scope

### ✅ In scope

- Create `src/utils/strings.ts` with `truncate(s: string, max: number): string` and `slugify(s: string): string`
- Re-export both from `src/utils/index.ts`
- Create `src/utils/strings.test.ts` with unit tests for both functions

### ⚠️ Ask before touching (stop and report; do not unilaterally fix)

- Any existing caller of inline string logic — do not migrate callers in this ticket
- Pre-existing test failures unrelated to this change
- Anything that would force a new dependency

### 🚫 Out of scope (do not touch)

- Do not modify any file outside `src/utils/`
- Do not add i18n or locale-aware logic
- Do not run database migrations or touch config files

## 🚫 Forbidden actions

Behavior-level prohibitions that apply regardless of how the task evolves:

- `git rebase`, `git push --force`, amending prior commits.
- `npm install --force`, `--legacy-peer-deps` (signal real conflicts; do not suppress them).
- Adding `// @ts-ignore`, `// @ts-expect-error`, `eslint-disable`, or `# noqa` to bypass errors.
- Modifying `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, or `Cargo.lock` by hand.
- Skipping pre-commit hooks (`--no-verify`).
- Running `git push` or `gh pr create` — junco handles both.

## Reference — existing utilities to reuse

- `src/utils/index.ts` — barrel export for utilities. Add re-exports here; import from here in callers.
- No existing string helpers; the two functions are net-new.

## Files

| File | Action | Lines | Notes |
|---|---|---|---|
| `src/utils/strings.ts` | new | — | `truncate` and `slugify` exports |
| `src/utils/strings.test.ts` | new | — | Vitest unit tests for both functions |
| `src/utils/index.ts` | modify | last line | append `export * from './strings'` |

All paths are relative to the worktree root (your cwd).

## Steps

Each step is one atomic change. **Commit after each step.**

### Step 1 — Create strings.ts with truncate and slugify

- [ ] Create `src/utils/strings.ts` exporting:
  - `truncate(s: string, max: number): string` — returns `s` unchanged if `s.length <= max`, otherwise returns `s.slice(0, max - 1) + '…'`
  - `slugify(s: string): string` — lowercases, replaces non-alphanumeric runs with `-`, trims leading/trailing hyphens
- [ ] Commit: `git add src/utils/strings.ts && git commit -m "feat: add truncate and slugify string utilities"`

### Step 2 — Re-export from the barrel

- [ ] Append `export * from './strings';` to `src/utils/index.ts`
- [ ] Commit: `git add src/utils/index.ts && git commit -m "feat: re-export string utilities from utils barrel"`

### Step 3 — Add unit tests

- [ ] Create `src/utils/strings.test.ts` with Vitest tests:
  - `truncate`: test no-op when under limit, truncation with ellipsis when over, exact-limit edge case
  - `slugify`: test lowercase conversion, space-to-hyphen, special-char stripping, leading/trailing hyphen trimming
- [ ] Run: `npm test` → expect exit 0
- [ ] Commit: `git add src/utils/strings.test.ts && git commit -m "test: add unit tests for truncate and slugify"`

## Behavior (acceptance — testable assertions)

- WHEN `truncate("hello world", 8)` is called THE SYSTEM SHALL return `"hello w…"`.
- WHEN `slugify("Hello, World!")` is called THE SYSTEM SHALL return `"hello-world"`.
- WHEN `npm run build` is executed THE SYSTEM SHALL exit 0 with no TypeScript errors.
- WHEN `npm test` is executed THE SYSTEM SHALL exit 0 with all tests passing.

## Verification (junco runs this — do NOT run it yourself)

```bash
npm run build
npm test
test -f src/utils/strings.ts
test -f src/utils/strings.test.ts
```

## Done when

- [ ] `src/utils/strings.ts` exists and exports `truncate` and `slugify`
- [ ] `src/utils/index.ts` re-exports both functions
- [ ] `src/utils/strings.test.ts` exists with tests for both functions
- [ ] 3 commits on `junco/add-string-utils-2026-05-31` (one per step)

## Notes for the agent (strict — copy this section verbatim into every plan)

1. **Trust the spec.** File paths, line numbers, and commands in this plan were verified by the planner. Do not re-explore the repo.
2. **One commit per step.** Suggested commit messages above are just suggestions — a better one is fine, but commit exactly once per step.
3. **Never run `git log`, `git status`, or `git diff` after a commit** to "verify" it landed. Commits with exit 0 always land. Verifying wastes turns.
4. **Call `todo_write` once at the start with top-level `phases: [...]`** to lay out the plan. After that, use only the incremental fields — `start`, `complete`, `abandon`, `remove`, `add_tasks`, `add_notes`, `add_phase`. **Never pass `phases:` again** after the initial plan — it replaces the entire todo list and wipes progress memory, triggering re-planning loops.
5. **Do not expand scope.** If you find an issue not in this plan, note it in your final summary — do not fix it.
6. **Do not push or open a PR.** The worker handles that.
7. **Final summary** (2–3 sentences at session end): what you did and any surprises. (Junco runs `## Verification` itself — don't restate it.)
8. **Graceful stop on spec mismatch.** If you find the spec doesn't match reality (a file already exists with content the spec doesn't anticipate, a precondition has changed, the work is already done, or you cannot complete it as specified), output a single sentence explaining the mismatch and stop. Do NOT loop in thinking trying to reconcile — junco's supervisor will kill the session within minutes and the ticket lands in `failed/` with no useful information. Your one-sentence summary becomes the failure note that lets the user fix the spec and re-dispatch.
