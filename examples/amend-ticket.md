<!-- Amend ticket: `amends_pr` adds commits to an existing PR instead of opening a new one. -->
---
id: amend-42-fix-slugify-edge-cases-2026-05-31
repo: ~/code/your-project
amends_pr: 42
timeout_minutes: 30
---

# Amend PR #42: Fix slugify edge case with consecutive hyphens

## What needs fixing

- `slugify("foo--bar")` returns `"foo--bar"` instead of `"foo-bar"` — multiple consecutive hyphens are not collapsed
- `slugify("  leading and trailing  ")` returns `"-leading-and-trailing-"` — spaces at the boundaries are not stripped before hyphenation

## Steps

Each step is one atomic change. **Commit after each step.**

### Step 1 — Collapse consecutive hyphens in slugify

- [ ] In `src/utils/strings.ts`, update `slugify` to replace runs of two or more hyphens with a single hyphen after the initial replacement pass (add `.replace(/-{2,}/g, '-')` before the final trim)
- [ ] Commit: `git add src/utils/strings.ts && git commit -m "fix: collapse consecutive hyphens in slugify"`

### Step 2 — Add regression tests for the fixed edge cases

- [ ] In `src/utils/strings.test.ts`, add test cases:
  - `slugify("foo--bar")` → `"foo-bar"`
  - `slugify("  leading and trailing  ")` → `"leading-and-trailing"`
- [ ] Run: `npm test` → expect exit 0
- [ ] Commit: `git add src/utils/strings.test.ts && git commit -m "test: add regression tests for slugify consecutive-hyphen and whitespace edge cases"`

## Done when

- [ ] `slugify("foo--bar")` returns `"foo-bar"`
- [ ] `slugify("  leading and trailing  ")` returns `"leading-and-trailing"`
- [ ] `npm test` exits 0
- [ ] 2 new commits on top of the existing PR branch

## Notes for the agent (strict — copy this section verbatim into every amend plan)

1. **You are amending, not starting over.** Previous commits on this branch are the starting point. Do not try to re-do their work.
2. **Add new commits on top.** Do NOT rebase, squash, or amend prior commits — those would need a force-push and the worker won't do one.
3. **Commit messages describe the amendment** (e.g. `fix: address review feedback on X`, `refactor: extract Y per review`) — not the original work.
4. **Do not** `git push` or touch the remote. The worker pushes your new commits; GitHub updates the existing PR automatically.
5. **Do not** switch branches. Stay on the branch you're on.
6. **Do not re-inspect prior commits.** Trust they're present; focus on the amendments.
7. After `git commit` exits 0, the commit is real. Do not `git log`/`status`/`diff` to verify.
8. After the initial `todo_write` with `phases:`, use only the incremental fields (`start`, `complete`, `abandon`, `remove`, `add_tasks`, `add_notes`, `add_phase`). Never pass `phases:` again — it wipes progress memory.
9. **Final summary:** what you amended, which verification commands passed.
