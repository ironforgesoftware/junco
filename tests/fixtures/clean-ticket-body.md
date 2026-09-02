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

- [ ] Create `CHANGELOG.md` with the Keep a Changelog header, a link to
      <https://keepachangelog.com/en/1.1.0/>, and one `## v0.1.0 — 2026-04-23`
      section whose `### Added` list holds the single entry
      "Initial state: Example target repo for junco."
- [ ] Commit: `git add CHANGELOG.md && git commit -m "docs: add CHANGELOG.md with v0.1.0 entry"`

## Behavior (acceptance — testable assertions)

- WHEN `cat CHANGELOG.md` is executed THE SYSTEM SHALL output content beginning with `# Changelog`.
- WHEN `grep "^## v0.1.0" CHANGELOG.md` is executed THE SYSTEM SHALL exit 0 with the version heading.

## Verification (junco runs this — do NOT run it yourself)

    test -f CHANGELOG.md
    grep -q "^## v0.1.0" CHANGELOG.md

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
