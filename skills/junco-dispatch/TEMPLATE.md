# Junco ticket template

This is the canonical shape for a plan/ticket dispatched to the local Junco
worker. The template below is what the agent emits when the user asks for a
dispatch — every section is load-bearing and has a reason.

Use it verbatim (substituting `<placeholders>`) unless a section is genuinely
inapplicable (e.g. omit the `Reference` section only if you're certain there
are no reusable utilities to point at). Prefer to keep a section and write
`_None_` than drop it, so the agent always sees the same layout.

---

````markdown
---
id: <slug>-<YYYY-MM-DD>
priority: normal
timeout_minutes: <30 | 60 | 90 | 120 | 180>
repo: <absolute path, ~ expands>
base_branch: main
branch_name: junco/<slug>
pr_title: "<verb-first H1, ≤70 chars>"
draft: true
labels: []
# amends_pr: 42    # ONLY for amendment tickets — see "Amend mode" section below
# github_request:     # optional — worker creates a tracking issue and links the PR to it
#   create_issue: true
---

# <Verb-first action title, ≤70 chars>

## Why

<2–4 sentences. State the problem and the end state. No implementation
detail — that lives in Steps. Bad: "We'll refactor X to use Y." Good: "Handler
X has inline validation that's duplicated across three callers; the goal is
one `validate()` helper imported everywhere X is used.">

## Pre-flight context (verified at plan time)

<Snapshot of non-obvious facts the planner discovered while drafting. Keep
to 4–6 bullets. Things to include: build tool + version, package manager,
language/framework versions, key library versions and their breaking-change
quirks, repo-specific conventions (barrel exports, path aliases). Things
NOT to include: anything obvious from the file tree or repeating the Why.>

- Build: <e.g. Vite 7.x + React 19 + TypeScript strict; `npm run build` runs `tsc --noEmit && vite build`>
- Stack: <e.g. react-router-dom v7.1.0 — note v7 dropped `Switch`>
- Conventions: <e.g. `src/components/index.ts` is a barrel; import from there, not individual files>
- Quirks: <e.g. `vite.config.ts` has no `base` set — assume `/`>

## Scope

### ✅ In scope

- <concrete bullet>
- <concrete bullet>

### ⚠️ Ask before touching (stop and report; do not unilaterally fix)

- <files outside the In-scope list that _look_ related but might be intentional>
- <pre-existing test failures unrelated to this change>
- <anything that would force a new dependency>
- <if list is empty, write `_None._` — but bias toward at least one bullet for any non-trivial ticket>

### 🚫 Out of scope (do not touch)

- <bullet — be explicit about nearby-but-forbidden things>
- <bullet>

## 🚫 Forbidden actions

Behavior-level prohibitions that apply regardless of how the task evolves:

- `git rebase`, `git push --force`, amending prior commits.
- `npm install --force`, `--legacy-peer-deps` (signal real conflicts; do not suppress them).
- Adding `// @ts-ignore`, `// @ts-expect-error`, `eslint-disable`, or `# noqa` to bypass errors.
- Modifying `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, or `Cargo.lock` by hand.
- Skipping pre-commit hooks (`--no-verify`).
- Running `git push` or `gh pr create` — junco handles both.
- <add ticket-specific forbidden actions here, e.g. "do not run database migrations">

## Reference — existing utilities to reuse

Paste signatures and version constraints inline — every Read call avoided
here saves the agent ~30 seconds at execute time, and an inline signature
prevents wrong-shape inventions.

- `src/components/index.ts` — barrel export. **Import everything from here**, not from individual files. Currently exports: `Header`, `Footer`, `HeroSection`, `ProductBento`, `Footer` (verify before drafting).
- `react-router-dom` v7.1.0 (`^7.1.0` in `package.json`) — use `Link`, `NavLink`, `Routes`, `Route`. Note: v7 dropped `Switch`; do not import it.
- `path/to/utility.py::validate(token: str) -> Result[User, Error]` — use for X instead of writing new code; signature stable.
- `path/to/other.ts::helper(opts: Options): Promise<T>` — already handles Y.

(Bias toward always including at least one reuse pointer with signature.
This single bullet is the difference between "agent reinvents the wheel"
and "agent uses what already exists".)

## Files

| File       | Action | Lines | Notes                                              |
| ---------- | ------ | ----- | -------------------------------------------------- |
| `src/a.ts` | modify | 42–58 | replace inline validation with `validate()` helper |
| `src/b.ts` | new    | —     | one-line module re-exporting from `./a`            |
| `src/c.ts` | delete | —     | dead code (last import removed in step 1)          |

All paths are relative to the worktree root (your cwd).

## Steps

Each step is one atomic change. **Commit after each step.**

### Step 1 — <short verb-first label>

- [ ] <specific action with file path + line numbers or exact snippet>
- [ ] Run: `<verification command>` → expect exit 0 / expected output
- [ ] Commit: `git add <paths> && git commit -m "<suggested message>"`

### Step 2 — <short verb-first label>

- [ ] <specific action>
- [ ] Commit: `git add <paths> && git commit -m "<suggested message>"`

### Step N — <short verb-first label>

- [ ] ...

## Behavior (acceptance — testable assertions)

EARS-style trigger/response pairs. These are _behavioral_ — what the system
should do once the change lands. The Verification block (next) is the
_operational_ check that exercises these behaviors. For doc-only or
content-only tickets where there is no observable behavior, write `_None._`.

- WHEN `<trigger>` THE SYSTEM SHALL `<observable response>`.
- WHEN `<trigger>` THE SYSTEM SHALL `<observable response>`.
- (e.g.) WHEN `npm run build` is executed THE SYSTEM SHALL exit 0 with no TypeScript errors.
- (e.g.) WHEN a user navigates to `/about` THE SYSTEM SHALL render `<h1>About</h1>`.

## Verification (junco runs this — do NOT run it yourself)

```bash
<command 1>
<command 2>
<command 3>
```
````

Junco runs each fenced bash block in the worktree after your session ends and
surfaces results in the PR body. Do not run these commands inside your session
— they're junco's job. Tell the spec what success looks like; junco enforces.

**Do NOT include `cd <repo>` in this block.** Junco invokes the block with
`cwd=<worktree-path>`, which is _not_ the source repo's main checkout — it's
a per-ticket worktree under `~/junco/worktrees/<id>/`. A leading `cd` moves
out of the worktree into the source repo's main, where the agent's new files
don't exist yet, and the verification fails for the wrong reason. Just write
the commands relative to the worktree root (e.g. `test -f src/foo.ts`,
`npx tsc --noEmit`, `npm run build`).

## Done when

- [ ] <observable outcome 1>
- [ ] <observable outcome 2>
- [ ] <N> commits on `<branch_name>` (one per step).

<!-- The worker's prompt preamble carries the strict working discipline — do not author it here. -->

---

## Why each section exists

Keep these rationales in mind when generating plans — dropping a section costs
the agent minutes of confused exploration:

- **Frontmatter first** — worker-readable metadata separate from agent-readable body. The worker needs `repo:`; everything else has sensible defaults.
- **"Why" before "how"** — grounds the model in purpose before mechanics. Prevents "why am I doing this?" re-planning mid-session.
- **Pre-flight context** — Anthropic-style context engineering applied to the spec: load the agent on stack specifics, version quirks, and conventions it would otherwise discover via grep/read. Saves 1–3 turns at execute time.
- **Scope split ✅/⚠️/🚫** — three-tier boundary (Osmani "good-spec"). The ⚠️ tier is the agent's escape hatch: when in doubt, _stop and report_, don't unilaterally fix. Without it, ambiguous cases become silent unilateral decisions — the most expensive failure mode in stress tests.
- **Forbidden actions** — behavior-level prohibitions distinct from file-level Out-of-scope. Catches corner-cutting under pressure (`--no-verify`, `// @ts-ignore`, force-push) regardless of which files are touched.
- **Reference section with signatures** — biases the agent toward reuse AND prevents wrong-shape inventions. Pasting `validate(token: str) -> Result[User, Error]` saves a Read call AND prevents the agent from inventing the wrong call shape.
- **Files table** — agent sees the full surface at a glance. Removes exploration pressure.
- **Steps with inline commits** — Ralph Loop + bite-sized granularity; each step is resumable and auditable in git.
- **Behavior (EARS)** — `WHEN <trigger> THE SYSTEM SHALL <response>`. The behavioral counterpart to Verification: triggers are spelled out so commands and assertions map 1:1. Distinct from Done-when (structural) — Behavior is what the system _does_, Done-when is what _exists_.
- **Verification block** — exact commands, not "make sure it builds". The agent runs them; it doesn't narrate.
- **Done when** — observable outcomes, not "looks good". Gives the agent a clear stop condition.
- **No Notes section** — the anti-loop discipline lives in the worker's own prompt preamble since 0.13; plans carry only ticket-specific content.

## Template values — guidance

- `id`: `<slug>-<YYYY-MM-DD>` (e.g. `add-hello-2026-04-23`). Slug from the title: lowercase, hyphenated, alphanumeric + hyphens only.
- `timeout_minutes`:
  - **30** — trivial: single file, 1 commit, no tests (e.g. "add HELLO.md").
  - **60** — small: 2–4 files, multiple commits, verification runs a build or tests.
  - **90–120** — moderate: feature work, multi-file refactor, possibly new tests.
  - **180** — large: architectural or cross-module. If you'd write >180, decompose into multiple tickets instead.
- `draft`: always `true` unless the user explicitly asks for a non-draft PR.
- `labels`: empty list by default. Only include labels that exist on the repo. When the user names labels, dry-run/lint's labels_exist check validates them — no separate gh call. Nonexistent labels fail `gh pr create`.
- `branch_name`: omit unless the user overrides. The worker derives `junco/<id>` by default.
- `base_branch`: `main` unless the repo uses a different default branch.

## Amend mode (follow-up tickets on existing PRs)

When the agent's original PR needs more work, use **amend mode** to push additional commits to the same branch — the existing PR auto-updates, no second PR is opened. Use this instead of starting over.

### Minimal amend ticket

```markdown
---
id: amend-<PR#>-<short-slug>-<YYYY-MM-DD>
priority: normal
timeout_minutes: 30
repo: <absolute path>
amends_pr: 42
---

# Amend PR #42: <what needs fixing>

## What needs fixing

- <concrete bullet — reviewer comment / test failure / misread scope>
- <concrete bullet>

## Steps

### Step 1 — <short label>

- [ ] <specific action addressing the feedback>
- [ ] Commit: `git add <paths> && git commit -m "fix: address review feedback on X"`

## Done when

- [ ] <observable outcome>
- [ ] <N> new commits on top of the existing PR branch

<!-- The worker's prompt preamble carries the strict working discipline — do not author it here. -->
```

### Metadata rules for amend tickets

- **`amends_pr`** (integer): the PR number being amended. The worker resolves the PR's head + base branches via `gh pr view` and overrides any `branch_name:` / `base_branch:` the ticket might try to set.
- **`branch_name` / `base_branch`**: omit; they're derived from the PR. If you include them and they conflict with the PR, the worker logs a warning and uses the PR's values anyway.
- **`pr_title`**: omit; the existing PR keeps its title. Changing it would require a separate `gh pr edit` call (not done by the worker).
- **`draft`**: omit; the existing PR's draft state is unchanged.
- **`labels`**: omit; use `gh pr edit --add-label` manually if you want to add labels.
- **`id`**: convention is `amend-<PR#>-<short-slug>-<date>` so ticket filenames are self-describing.
- **`timeout_minutes`**: typically 30 (amendments are usually small fixes).

### When NOT to use amend mode

- The original PR is **merged** or **closed** → start a fresh ticket; amend mode refuses non-open PRs.
- The amendment would require **rewriting history** (squashing, rebasing, amending commits) → do it manually; the worker only adds new commits.
- The PR is from a **fork** (`isCrossRepository: true`) → the worker refuses; push access is a permissions question.
- You want a **different approach entirely** → close the original PR and dispatch a fresh ticket. Amend mode layers new commits on top; it can't rewind bad direction.

## Things you must NOT put in a plan

- **"Think carefully"**, **"consider all edge cases"**, **"be thorough"** — these feed xhigh thinking's self-doubt and trigger loops.
- **"TBD"**, **"TODO"**, **"fill in later"** — if you don't know it, ask the user or don't include the step.
- **"Similar to Step N"** — the agent may read steps out of order. Write each step completely.
- **Verification phrased as narrative** — "Make sure it builds" → use `npm run build` with expected exit 0.
- **Labels the repo doesn't have** — causes `gh pr create` to fail after push succeeds.
- **Optional hints** — "you might also want to check X". Either it's a step or it isn't.
- **Defensive padding** — "if this breaks, feel free to adjust". The agent should stop and report, not adjust.
