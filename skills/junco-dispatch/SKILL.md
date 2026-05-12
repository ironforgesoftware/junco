---
name: junco-dispatch
description: 'Use when the user wants to dispatch work to the local junco task-queue worker. Scaffolds a structured plan file with junco frontmatter, applies anti-loop conventions, and drops it in ~/junco/tickets/inbox/ for the local agent to execute. Triggered by phrases like "send to junco", "dispatch to junco", "/junco", "junco: <brief>", or "junco-batch: <brief>" (batch mode skips the preview gate for omp -p).'
---

# Junco dispatch

Package a unit of work into a plan-shaped markdown file with junco frontmatter and write it to `/Users/you/junco/tickets/inbox/`. The local junco worker (launchd agent `com.junco.junco-worker`) claims the ticket, runs it through `omp` against a local Qwen3.6-27B on oMLX, and opens a draft PR on completion. The tickets directory is symlinked into the Obsidian vault (`Vault/Junco/`) for read-only visibility on Mac and iOS Obsidian.

**Why this skill exists:** plan quality is the single biggest lever on the local agent's performance. In smoke testing, the same work took **4m 37s with a well-structured plan vs. 23+ min and a failed loop with a loose prompt** (8× fewer tokens). This skill bakes the earned-in-blood anti-loop conventions into every ticket you author.

## When to trigger

Fire this skill when the user explicitly asks to dispatch work:

- **Fresh tickets:** "dispatch this to junco", "send to junco", "junco this", "/junco", "junco: <brief>", "queue this for junco"
- **Batch tickets (no preview, for `omp -p`):** "junco-batch: <brief>" — used for automated load tests; skips the preview gate (see "Batch mode" under Dispatch procedure)
- **Amend tickets (follow-ups on existing PRs):** "amend junco PR #N: <what to fix>", "junco: fix PR #N by ...", "follow up on PR #N via junco", "dispatch an amendment to #N"

**Do NOT fire** when the user is:

- debugging or configuring junco itself (e.g. "why did junco fail?", "fix the junco worker")
- asking what junco is or how it works
- discussing the `junco` skill in the abstract

## Supporting files

- `TEMPLATE.md` — the canonical plan template. Every ticket uses this exact shape.
- `EXAMPLE.md` — two worked examples (trivial 1-commit; moderate 2-commit). Use as shape anchors when generating.

Read these via the Read tool when you need to quote or reference the template.

## Inputs to gather

Ask the minimum needed — autodetect where possible, ask inline when not.

1. **Repo target** — absolute path to a git repo.
   - Autodetect: if the current CC working directory is a git repo, default to it and confirm ("Dispatch to junco targeting `$(pwd)`?").
   - Ask only if no cwd-repo fit or the user's brief clearly refers to a different repo.
   - Must have a GitHub remote (the worker calls `gh repo view`). If uncertain, run `gh repo view <path>` or `git -C <path> remote -v` to verify before drafting.
2. **Goal** — one-sentence brief. If the trigger was "send to junco" with no details, ask: "What's the goal in one sentence?"
3. **Scope boundaries** — ask if ambiguous: "Anything specifically off-limits?" If clear from the brief, infer.
4. **Existing plan file** — if the user says "junco this plan: <path>", skip drafting and wrap the existing file (see "Wrapping an existing plan" below).
5. **Verification commands** — autodetect from the project:
   - `package.json` → offer `npm run build`, `npm test`, `npx tsc --noEmit` (which apply)
   - `pyproject.toml` / `pytest.ini` → `pytest -v`, possibly `ruff check`, `mypy`
   - `Cargo.toml` → `cargo build`, `cargo test`
   - If the tooling is unclear or the task is doc-only, use `test` / `grep` / existence checks.
6. **Timeout** — pick by scope, don't ask unless unusual:
   - 30 min: trivial (1 file, 1 commit, no tests)
   - 60 min: small (2–4 files, build or test run)
   - 90–120 min: moderate (feature work, refactor)
   - 180 min: large. If you'd pick more than 180, **decompose into multiple tickets** — offer that to the user instead.

## Drafting procedure

1. **Read the template.** Use Read tool on `~/.claude/skills/junco-dispatch/TEMPLATE.md` to load the canonical shape. Do not paraphrase from memory.
2. **Choose an example as anchor.** Read `EXAMPLE.md`; pick the one (trivial or moderate) closest in scope.
3. **Discover repo specifics for Pre-flight context + Reference.** Read the repo's `package.json` / `pyproject.toml` / `Cargo.toml` to capture build tool + version + key dependency versions. Read 1–2 files central to the change to extract reusable signatures (barrel exports, function signatures, type shapes). Paste these inline in the ticket — every Read avoided at execute time saves ~30 seconds. **Verify-before-drafting:** before populating Reference and Files sections, READ the actual target file(s). Do NOT assume field names, line numbers, imports, or interface shapes from memory — they have been wrong in the past (2026-04-27 omp-batch comparison: a Claude batch-render listed a `description` field on Product that didn't exist, and called the `image` field "an HTTPS URL" when it was actually a CSS gradient). The plan-lint `files_paths_exist` rule will warn if your Files-table paths don't match the repo state.
4. **Populate every section.** Follow the template literally. If a section is inapplicable (e.g. no reusable utilities, no observable behavior), write `_None._` — do not drop the section. Shape consistency matters more than section density.
5. **Be specific.** Absolute paths when they help; relative-to-worktree-root (default) when the task is self-contained. Include line numbers for surgical edits.
6. **Include the full "Notes for the agent (strict)" block verbatim.** This is the anti-loop payload — copy from `TEMPLATE.md` exactly. Do not reword.

## Metadata rules

- `id`: `<slug>-<YYYY-MM-DD>` where slug is lowercase-hyphenated from the title. Examples: `add-changelog-2026-04-23`, `refactor-auth-header-2026-04-24`.
- `created`: ISO-8601 current local time (seconds resolution).
- `priority`: `normal` unless the user says otherwise.
- `timeout_minutes`: per the heuristic above.
- `repo`: absolute path, `~` will expand.
- `base_branch`: `main` unless the repo uses a different default (check `git -C <repo> symbolic-ref refs/remotes/origin/HEAD` if unsure).
- `branch_name`: omit by default — the worker derives `junco/<id>`. Only include if the user wants to override.
- `pr_title`: first H1 from the body, verb-first, ≤70 chars, no `junco:` prefix.
- `draft`: always `true` unless the user explicitly requests ready-for-review.
- `labels`: empty `[]` by default. **Only include labels that exist on the repo** — `gh label list --repo <nwo>` to verify. Nonexistent labels fail `gh pr create` after push, leaving the branch on origin but no PR.

## Authoring discipline (what makes the plan NOT loop)

Empirical lessons from smoke-2/3/4. Bake these into every plan body:

- **Absolute paths or "relative to worktree root".** Never say "the config file".
- **Line numbers for surgical edits** (e.g. `src/a.ts:42–58`). Removes grep pressure.
- **Every step ends in a commit.** No uncommitted limbo states.
- **Three-tier scope split: ✅ / ⚠️ / 🚫.** ✅ is what to do; ⚠️ is the agent's escape hatch (stop and report — don't unilaterally fix); 🚫 is hard prohibitions on files. The ⚠️ tier prevents the most expensive failure mode (silent unilateral scope expansion).
- **Forbidden actions are behavior-level, not file-level.** Out-of-scope is "don't touch X.ts"; Forbidden actions is "don't `--no-verify`, don't force-push, don't `// @ts-ignore`". Both are needed.
- **Reference signatures, not just paths.** Paste `validate(token: str) -> Result[User, Error]` rather than `path/to/validate.py`. Saves Read calls AND prevents wrong-shape inventions.
- **Behavior (EARS) and Verification are paired.** Behavior says `WHEN X THE SYSTEM SHALL Y`; Verification gives the bash command that exercises it. They map 1:1.
- **Verification commands must be exact and check exit 0.** Not "make sure it builds". **Never include `cd <repo>` in the bash block** — junco runs it with `cwd=<worktree>`; a leading `cd` moves out of the worktree and the verification fails for the wrong reason.
- **Verification runs on macOS BSD utilities, not GNU.** The worker shells out to bash on macOS, which uses BSD coreutils. Common gotchas:
  - `wc -l < file` outputs `       1` (whitespace-padded) on BSD vs `1` on GNU. Use `awk 'END {print NR}' file` for portable line count, OR `[ "$(wc -l < file | tr -d ' ')" = "1" ]`.
  - `sed -i` requires a backup-extension arg on BSD: `sed -i ''` (note the empty string). Alternative: redirect to a temp file and `mv`.
  - `date -v +1d` (BSD) vs `date -d 'tomorrow'` (GNU) — prefer ISO timestamps in spec content rather than computing dates in verification.
  - `head -c N` works on both. `tail -c N` differs in offset semantics — verify the exact byte you want with `xxd` or `od` for portability.
  - When in doubt, prefer Python or `awk` one-liners over shell coreutils — they have consistent semantics across platforms.
- **The "Notes for the agent (strict)" section is mandatory.** Copy verbatim. Dropping this is the difference between 4 minutes and 20+ minutes of wall clock.

## Plan-lint (automatic pre-dispatch check)

The junco worker runs a deterministic linter on every ticket before claiming it. Tickets that fail lint move directly to `failed/` with a `phase_error` like `plan-lint: no_cd_in_verification: ...` — they never reach the agent. Rules currently enforced:

- No `cd ` lines inside the `## Verification` fenced bash block
- Every `### Step N` block contains exactly one `git commit` line
- Every path in the Files table appears in at least one Step body
- Every label in frontmatter exists on the GitHub repo (`gh label list`)
- The strict "Notes for the agent" block is present at the end
- No forbidden phrases (`TBD`, `Similar to Step N`, `think carefully`, `consider all cases`)

If you generate a ticket and lint rejects it, fix the specific rule cited and re-dispatch. The linter exists to catch known foot-guns *before* spawning a 5-minute agent run.

## Things to NEVER put in a plan

- **"Think carefully" / "consider all cases" / "be thorough"** — these feed xhigh self-doubt and trigger loops.
- **"TBD" / "TODO" / "similar to Step N" / "and so on"** — agent can't expand placeholders; it'll get stuck.
- **Defensive timeout inflation** — a 180-min cap on trivial work masks loop bugs and wastes GPU time.
- **Invented labels** — breaks `gh pr create` after push.
- **Optional suggestions** — "you might also want to check X". Either it's a step or it isn't.
- **Narrative verification** — use executable commands, not "confirm everything is working".
- **Multiple parallel branches / PRs per ticket** — junco is one-ticket = one-PR.

## Dispatch procedure

**Two modes** based on trigger phrase:

- **Interactive (default):** triggered by `junco:`, `dispatch to junco`, `send to junco`, `/junco`. Includes the preview gate — used for normal day-to-day dispatch.
- **Batch (no preview):** triggered by `junco-batch:`. SKIPS the AskUserQuestion preview gate entirely and writes directly to inbox/. Used for automated load tests run via `omp -p` (non-interactive). The AskUserQuestion tool is unavailable in `omp -p` mode and will throw `ToolAbortError` if invoked, so batch mode MUST omit it. Do NOT use `junco-batch:` for normal interactive dispatches — there is no review checkpoint.

### Interactive mode (default)

1. **Render.** Generate the full ticket as a string (frontmatter + body).
2. **Preview + approve.** Use `AskUserQuestion` with the rendered ticket as a preview. Ask: "Dispatch this to junco?" with options `Yes, dispatch` / `Edit first` / `Cancel`.
3. **On approve — write to inbox.** Use the Write tool to create:

   ```
   /Users/you/junco/tickets/inbox/<id>.md
   ```

4. **Announce.** Tell the user:
   - Ticket file path
   - Expected wall clock (use `timeout_minutes` as an upper bound; cite smoke-4's 4m 37s as a realistic floor for moderate work)
   - How to watch: `tail -F ~/junco/launchd.out` or `tail -F ~/junco/tickets/worker.log`
5. **Offer monitoring.** Ask: "Want me to monitor the ticket and notify when it lands in done/ or failed/?" If yes, spawn a Monitor tool call that polls `done/<id>` and `failed/<id>`.

### Batch mode (no preview, for `omp -p`)

Triggered when the user prompt starts with `junco-batch:`. Identical to interactive mode EXCEPT step 2 and step 5 are skipped:

1. **Render.** Generate the full ticket as a string (frontmatter + body). Same template, same rules.
2. **(SKIPPED)** No `AskUserQuestion` preview gate. The ask tool is unavailable in `omp -p` mode and would throw `ToolAbortError`.
3. **Write directly to inbox.** Use the Write tool to create the same path as interactive mode (`/Users/you/junco/tickets/inbox/<id>.md`).
4. **Print one-line confirmation to stdout.** Format: `BATCH_DISPATCHED <id> -> <inbox-path>`. This line is what the calling shell script greps for to confirm success.
5. **(SKIPPED)** No monitor offer.

Note: batch mode produces tickets with the SAME structural quality as interactive mode (same TEMPLATE.md, same plan-lint rules apply post-claim). The only difference is the absence of the human-in-the-loop preview gate. Use only for automated test loops.

## Wrapping an existing plan file

If the user says "junco this plan: `<path>`", do NOT rewrite the body. Instead:

1. Read the plan file.
2. Parse any existing frontmatter (Plan mode plans typically don't have any).
3. Prepend junco frontmatter with values inferred from the plan's H1 and structure.
4. Ensure the "Notes for the agent (strict)" section is present at the end — if absent, append it verbatim from `TEMPLATE.md`.
5. Preview → approve → write to inbox as normal.

## Amend mode (follow-up tickets on existing PRs)

Use this when the user wants to fix / extend an open PR that junco originally opened (e.g. "amend PR #42 to address the review comments"). Instead of opening a new PR, the worker pushes new commits to the same branch; GitHub auto-updates the existing PR.

### Inputs to gather for amend

1. **PR number** — extract from the trigger ("PR #42", "#17"). If missing, ask.
2. **Repo** — autodetect from the PR (via `gh pr view <n>`) if not obvious from cwd. Confirm with the user.
3. **What needs fixing** — this is the core input. Ask explicitly if the brief is vague: "What specific changes should the amendment make?"
4. **(Optional) PR comments** — if the user says "address review feedback", run `gh pr view <n> --json reviews,comments --jq '.'` to read the comments and include a concise summary in the ticket body as a "### Review feedback summary" section. Don't dump raw comments; summarise each comment as an actionable bullet.

### Drafting an amend ticket

1. Read `TEMPLATE.md` — the "Amend mode" section has the minimal amend-ticket shape.
2. Generate the ticket with:
   - `id: amend-<PR#>-<short-slug>-<date>` (self-describing filename)
   - `repo:` — absolute path
   - `amends_pr: <N>` — the integer PR number (no `#`)
   - **Omit** `branch_name`, `base_branch`, `pr_title`, `draft`, `labels` — the worker derives them from the PR
   - `timeout_minutes: 30` typically (amendments are small)
3. Body structure:
   - H1: `Amend PR #N: <short label>`
   - `## What needs fixing` — concrete bullets of the changes requested
   - `## Steps` — numbered, each ending in a commit with `fix:` / `refactor:` / etc. prefix
   - `## Done when` — observable outcomes
   - `## Notes for the agent (strict)` — copy the **amend-mode** block from `TEMPLATE.md` (different from fresh-ticket notes — forbids rebasing/squashing, says "you are amending, not starting over", etc.)

### Validation before writing an amend ticket

- `gh pr view <N> --repo <nwo> --json state,isCrossRepository` → refuse if `state != "OPEN"` or `isCrossRepository == true`
- Confirm with the user if the PR isn't the one junco originally opened (i.e. a PR authored outside junco may have been made by a human and may not follow junco's branch-naming convention — the worker will still amend it, but surface this and let the user decide)
- Everything else the worker validates at claim time (branch on origin, etc.)

### When NOT to offer amend mode

- PR is merged / closed — suggest a fresh ticket instead
- Changes require rewriting history (squash/rebase) — tell the user the worker won't force-push; offer to do it manually or start fresh
- The requested change is fundamentally different direction — recommend closing the PR and dispatching a fresh ticket

## Error handling

Before writing to inbox, validate:

- Repo path exists and is a git repo → else ask for clarification.
- Repo has a GitHub remote → else refuse with a useful message ("The worker uses `gh pr create`; this repo has no GitHub remote. Options: add one, or keep this as a local plan without junco.")
- Branch `junco/<id>` not already on origin → else suggest bumping the id. (`git ls-remote --heads origin junco/<id>`)
- Labels exist on repo if any are specified → else remove them and warn.

If any validation fails, surface the specific problem and ask how to proceed. Don't write a broken ticket and let the worker fail 5 seconds after claim.

## Provenance

This skill's template and anti-loop rules were synthesized from:

- Anthropic, "Effective context engineering for AI agents" (section structure + Goldilocks specificity)
- Addy Osmani, "How to write a good spec for AI agents" (six-area template; three-tier boundaries)
- Addy Osmani, "The Code Agent Orchestra" (kill-loop patterns; file ownership; Ralph Loop)
- Empirical smoke-test data: `~/junco/tests/test_pr_flow.py` and the MEMORY entry `project_junco_pr_flow.md`

The "Notes for the agent (strict)" block is the single most-earned asset — multiple 20-minute looping runs led to its exact wording.
