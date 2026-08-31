# Junco ticket examples

Three worked examples using the canonical template. When generating a new plan,
pick the one that's closer in scope to the user's brief and use it as a
shape-reference, not a copy-paste source.

---

## Example 1 — Trivial (1 file, 1 commit, 30 min)

**User brief:** "Dispatch to junco: add a CHANGELOG.md to example-app noting the v0.1.0 release."

**Rendered ticket:**

````markdown
---
id: add-changelog-2026-04-23
priority: normal
timeout_minutes: 30
repo: ~/code/example-app
base_branch: main
pr_title: "Add CHANGELOG.md for v0.1.0"
draft: true
labels: []
---

# Add CHANGELOG.md for v0.1.0

## Why

The repo has no changelog. The goal is a conventional `CHANGELOG.md` at the
repo root seeded with a v0.1.0 entry noting the current state (smoke-test
target for the junco task-queue worker). Future releases append above the
v0.1.0 section.

## Pre-flight context (verified at plan time)

- Repo: example-app — a small example target repo. No build system, no tests.
- Existing root files: `README.md`, `HELLO.md`, `HELLO-4.md`. No prior `CHANGELOG.md`.
- Convention: Keep a Changelog 1.1.0 + Semantic Versioning 2.0.0.

## Scope

### ✅ In scope

- Create `CHANGELOG.md` at the repo root.
- Populate with a single `## v0.1.0 — 2026-04-23` section.

### ⚠️ Ask before touching (stop and report; do not unilaterally fix)

_None._ Trivial single-file content change.

### 🚫 Out of scope (do not touch)

- `README.md` — do not modify.
- `HELLO.md` / `HELLO-4.md` — do not reference in the changelog.
- Git tags — do not create a tag; CHANGELOG is standalone.

## 🚫 Forbidden actions

- `git rebase`, `git push --force`, amending prior commits.
- Modifying `package-lock.json`, `yarn.lock` by hand (n/a for this repo, kept for consistency).
- Skipping pre-commit hooks (`--no-verify`).
- Running `git push` or `gh pr create` — junco handles both.

## Reference — existing utilities to reuse

_None._ Pure-content change, no existing utilities apply.

## Files

| File           | Action | Lines | Notes              |
| -------------- | ------ | ----- | ------------------ |
| `CHANGELOG.md` | new    | —     | seed content below |

All paths are relative to the worktree root (your cwd).

## Steps

### Step 1 — Create CHANGELOG.md

- [ ] Create `CHANGELOG.md` with exactly:

  ```markdown
  # Changelog

  All notable changes to this repository will be documented in this file.

  The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
  and this repository adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

  ## v0.1.0 — 2026-04-23

  ### Added

  - Initial state: Example target repo for junco.
  ```
````

- [ ] Commit: `git add CHANGELOG.md && git commit -m "docs: add CHANGELOG.md with v0.1.0 entry"`

## Behavior (acceptance — testable assertions)

- WHEN `cat CHANGELOG.md` is executed THE SYSTEM SHALL output content beginning with `# Changelog`.
- WHEN `grep "^## v0.1.0" CHANGELOG.md` is executed THE SYSTEM SHALL exit 0 with the version heading.

## Verification (junco runs this — do NOT run it yourself)

```bash
test -f CHANGELOG.md
grep -q "^## v0.1.0" CHANGELOG.md
```

Junco runs each fenced bash block in the worktree after your session ends and
surfaces results in the PR body. Don't run them yourself — wastes turns.

Note: junco runs the block with `cwd=<worktree-path>`. **Do NOT include
`cd <repo>`** — that moves out of the worktree into the source main checkout
where the agent's new files don't exist. Write commands relative to the
worktree root.

## Done when

- [ ] `CHANGELOG.md` exists at the repo root.
- [ ] File contains a `## v0.1.0 — 2026-04-23` heading.
- [ ] 1 commit on `junco/add-changelog-2026-04-23`.

````

---

## Example 2 — Moderate (2 files, 2 commits, 60 min)

**User brief:** "Dispatch to junco: add HELLO-4.md greeting and add a Provenance section to README in example-app."
(This is a known-good moderate-complexity shape. Use it as
an anchor for moderate-complexity work.)

**Rendered ticket:**

```markdown
---
id: hello4-and-readme-2026-04-23
priority: normal
timeout_minutes: 60
repo: ~/code/example-app
base_branch: main
pr_title: "Add HELLO-4.md and Provenance section to README"
draft: true
labels: []
---

# Add HELLO-4.md and Provenance section to README

## Why

Smoke test ticket. The repo is a disposable PR-flow target for junco. This
ticket adds a new greeting file and a Provenance section to the README so
the repo's origin is self-documenting.

## Pre-flight context (verified at plan time)

- Repo: example-app — a small example target repo. No build system, no tests.
- Existing root files: `README.md`, `HELLO.md`. No prior `HELLO-4.md`, no prior `## Provenance 4` section.
- Repo writes plain markdown; no link checking or linting on commit.

## Scope

### ✅ In scope

- Create `HELLO-4.md` at the repo root with a single-line greeting.
- Append a `## Provenance 4` section to the end of `README.md`.

### ⚠️ Ask before touching (stop and report; do not unilaterally fix)

- Existing `HELLO.md` content — if it appears stale or incorrect, do NOT update it as a "side fix"; flag in your final summary.
- README sections above the new Provenance — if they look broken, flag them; do NOT rewrite.

### 🚫 Out of scope (do not touch)

- `HELLO.md` — from a prior smoke run; do not modify or delete.
- `CHANGELOG.md` — if present, unaffected.
- Any other file at the repo root.

## 🚫 Forbidden actions

- `git rebase`, `git push --force`, amending prior commits.
- Skipping pre-commit hooks (`--no-verify`).
- Running `git push` or `gh pr create` — junco handles both.
- Editing existing README content above the new Provenance section.

## Reference — existing utilities to reuse

_None._ Pure-content changes.

## Files

| File | Action | Lines | Notes |
|---|---|---|---|
| `HELLO-4.md` | new | — | one-line content, trailing newline |
| `README.md` | modify | append | new `## Provenance 4` section at EOF |

All paths are relative to the worktree root (your cwd).

## Steps

### Step 1 — Create HELLO-4.md

- [ ] Create `HELLO-4.md` with exactly this content (single line, trailing newline):

````

junco says hi, take 4

````

- [ ] Commit: `git add HELLO-4.md && git commit -m "Add HELLO-4.md greeting"`

### Step 2 — Append Provenance section to README

- [ ] Append the following to the end of `README.md` (preserve existing content above):

```markdown

## Provenance 4

Example target repo for junco. Exercise run #4.
````

- [ ] Commit: `git add README.md && git commit -m "Note smoke-test provenance in README"`

## Behavior (acceptance — testable assertions)

- WHEN `cat HELLO-4.md` is executed THE SYSTEM SHALL output `junco says hi, take 4`.
- WHEN `tail README.md` is executed THE SYSTEM SHALL include a `## Provenance 4` heading and its body.
- WHEN `grep -c "^## Provenance 4$" README.md` is executed THE SYSTEM SHALL output `1` (no duplicate sections).

## Verification (junco runs this — do NOT run it yourself)

```bash
test -f HELLO-4.md
grep -q "^junco says hi, take 4$" HELLO-4.md
grep -q "^## Provenance 4$" README.md
```

Junco runs each fenced bash block in the worktree after your session ends and
surfaces results in the PR body. Don't run them yourself — wastes turns.

Note: junco runs the block with `cwd=<worktree-path>`. **Do NOT include
`cd <repo>`** — that moves out of the worktree into the source main checkout
where the agent's new files don't exist. Write commands relative to the
worktree root.

## Done when

- [ ] `HELLO-4.md` exists with the exact content above.
- [ ] `README.md` ends with a `## Provenance 4` section.
- [ ] 2 commits on `junco/hello4-and-readme-2026-04-23`.

````

---

---

## Example 3 — Amend mode (follow-up on existing PR, 1 commit, 30 min)

**User brief:** "Amend junco PR #42 — I noticed HELLO.md should end with a newline per our repo convention."

**Rendered ticket:**

```markdown
---
id: amend-42-trailing-newline-2026-04-23
priority: normal
timeout_minutes: 30
repo: ~/code/example-app
amends_pr: 42
---

# Amend PR #42: ensure HELLO.md ends with a trailing newline

## What needs fixing

Repo convention is POSIX-style text files with a trailing newline. The original PR landed `HELLO.md` without one. Fix the file on the PR's branch.

## 🚫 Forbidden actions

- `git rebase`, `git push --force`, amending the prior commit (this is the amend-mode core rule).
- Switching branches — stay on the PR's branch.
- Running `git push` or `gh pr edit` — the worker handles the push; GitHub auto-updates the PR.

## Steps

### Step 1 — Add trailing newline to HELLO.md

- [ ] Rewrite `HELLO.md` so its content is exactly `Hello from junco.\n` (note trailing newline). If the file already ends with a newline, the edit is a no-op; verify with the verification command below before concluding.
- [ ] Commit: `git add HELLO.md && git commit -m "fix: ensure HELLO.md ends with trailing newline"`

## Behavior (acceptance — testable assertions)

- WHEN `tail -c1 HELLO.md` is executed THE SYSTEM SHALL output a single LF (0x0a) byte.

## Verification (junco runs this — do NOT run it yourself)

```bash
test -f HELLO.md
[ "$(tail -c1 HELLO.md | xxd -p)" = "0a" ]
````

Junco runs each fenced bash block in the worktree after your session ends and
surfaces results in the PR body. Don't run them yourself.

## Done when

- [ ] `HELLO.md` ends with a single LF byte.
- [ ] 1 new commit on top of the existing PR branch.

```

### Why this shape for amend tickets

- **`amends_pr: 42`** is the only metadata that matters for routing. Everything else (branch_name, base_branch, pr_title, labels) is derived from the PR or left unchanged.
- **H1 references the PR number** so filenames + PR pages can be cross-referenced at a glance.
- **"What needs fixing" section** replaces "Why / Scope" for amend mode — the PR already has context; what we need is the delta.

## Calibration notes for the skill

- Example 1 and 2 are what "good" looks like for their respective sizes. Use them as anchors when a user brief could swing either way in scope.
- Example 2 is a known-good shape: in testing, a well-structured plan like this ran several times faster and used far fewer tokens than the same work given as a loose prompt. **Shape matters.**
- When generating, don't invent richer examples than the brief warrants. A "create a file" ticket should NOT grow a "Reference — existing utilities" section with three bullets just to fill the slot.
- Aim for the minimum plan that still contains every mandatory section (even if some are `_None_`). Consistency of shape > fullness of content.
```
