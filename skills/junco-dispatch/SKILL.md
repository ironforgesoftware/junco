---
name: junco-dispatch
description: 'Use when the user wants to dispatch work to the local junco task-queue worker. Scaffolds a structured plan file with junco frontmatter, applies anti-loop conventions, and submits it to the configured inbox for the local agent to execute. Triggered by phrases like "send to junco", "dispatch to junco", "/junco", "junco: <brief>", or "junco-batch: <brief>" (batch mode skips the preview gate for headless/non-interactive harnesses). Also handles repo audits: phrases like "assess this repo", "have junco audit this repo", or "junco assess <repo>" run junco assess — a read-only audit, on any watched repo owned or not, that parks findings for a human-confirmed review before anything is filed (see Assess mode). Also handles issue investigation: phrases like "analyze issue #N", "have junco look into this issue", or "junco analyze <issue>" run junco analyze — a read-only investigation of one issue that parks a draft comment for human-confirmed posting (see Analyze mode).'
---

# Junco dispatch

Package a unit of work into a plan-shaped markdown file with junco frontmatter and submit it to the configured inbox via `junco submit`. The junco worker claims the ticket, runs it through its configured coding agent, and opens a draft PR on completion.

**Why this skill exists:** plan quality is the single biggest lever on the agent's performance. In testing, a well-structured plan ran several times faster and used far fewer tokens than a loose prompt doing the same work. This skill bakes the earned-in-blood anti-loop conventions into every ticket you author.

**Two families of work.** Most of this skill is about _authoring_ a plan-shaped ticket and submitting it — fresh dispatch, wrapping an existing plan, amending an open PR. Two modes are different, and author nothing: _assess_ triggers `junco assess`, a read-only repo audit — on any watched repo, owned or not — that parks its findings for review; filing them as GitHub issues is a separate, human-confirmed step, and an assess run never opens a PR. See "Assess mode" below. _analyze_ triggers `junco analyze`, a read-only investigation of a single issue that parks a drafted comment for review; posting it is a separate, human-confirmed step, and an analyze run never opens a PR either. See "Analyze mode" below.

## When to trigger

Fire this skill when the user explicitly asks to dispatch work:

- **Fresh tickets:** "dispatch this to junco", "send to junco", "junco this", "/junco", "junco: <brief>", "queue this for junco"
- **Batch tickets (no preview, headless mode):** "junco-batch: <brief>" — used for automated load tests; skips the preview gate (see "Batch mode" under Dispatch procedure)
- **Amend tickets (follow-ups on existing PRs):** "amend junco PR #N: <what to fix>", "junco: fix PR #N by ...", "follow up on PR #N via junco", "dispatch an amendment to #N"
- **Assess (audit a repo, park findings for review):** "assess this repo", "have junco audit this repo", "junco assess <repo>", "scan this repo and file issues", "junco: assess <repo>" — this runs `junco assess`, not a plan dispatch (see "Assess mode")
- **Analyze (investigate an issue, park a comment draft for review):** "analyze issue #N with junco", "have junco look into this issue", "junco analyze <owner/repo#N|url>", "investigate this issue and draft a comment", "junco: analyze <issue>" — this runs `junco analyze`, not a plan dispatch (see "Analyze mode")

**Do NOT fire** when the user is:

- debugging or configuring junco itself (e.g. "why did junco fail?", "why did the assess run fail?", "fix the junco worker")
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
   - 180 min: large. If you'd pick more than 180, **decompose into a ticket set** instead — see "Ticket sets" below.

## Ticket sets

When a task naturally decomposes into 2+ tickets with real dependency ordering (e.g. "add the API, then the UI that calls it, then the docs"), author them as a SET rather than one oversized ticket:

- Give each ticket an explicit `id:` — short and stable, since sibling tickets reference it.
- Reference sibling ids in `depends_on:`. The worker won't claim a ticket until every id in its `depends_on:` list has finished successfully AND (if it opened a PR) that PR merged.
- Submit the tickets in any order — `junco submit` never refuses on a forward-referenced id; a `depends_on` entry that names nothing yet queued or finished just prints a warning and waits.
- The worker executes the set in dependency order automatically, gating each ticket's claim on its dependencies' merged PRs. One ticket is still one PR — the set is what expresses work that genuinely needs several.
- If a ticket mid-chain fails, its dependents cascade to `failed/` too (a `dependency_failed` marker names which dependency). `junco retry <parent>` revives the whole chain — it resurrects the cascaded dependents transitively, not just the one ticket named.

**Compiler-backed alternative.** When the operator has `planSets.enabled` on, `junco submit --plan <file> --repo <path>` compiles ONE fenced `junco-plan` document into the same dependency-ordered ticket set, instead of you hand-authoring N separate ticket files. Shape (abbreviated — the same YAML the daemon's own planner emits when plan sets are on):

```junco-plan
version: 1
shared_context: |
  Constraints that apply to every task.
tasks:
  - id: short-slug            # [a-z0-9][a-z0-9-]{0,31}; must not match r?<digits>
    title: Verb-first title
    depends_on: []            # other task ids in this same document
    description: |
      Self-contained: what to build and why.
    acceptance:
      - Testable assertion
    prohibitions:
      - What must not change
    verification: |
      commands the worker runs to verify (optional)
```

Each task becomes its own ticket and pull request, executed in dependency order. The compiler builds the `plan:`/`depends_on:` frontmatter itself — never hand-author those fields on a compiled set. Reach for this when plan sets are enabled and you'd otherwise be hand-writing more than a couple of dependent tickets; fall back to hand-authored tickets with `depends_on:` when plan sets are off, or the work doesn't cleanly fit the compiler's task shape.

The compiler refuses (never strips) a plan whose free-text fields — `title`, `description`, `acceptance`, `prohibitions`, `verification`, `shared_context` — contain a frontmatter delimiter (`---`), a code fence (` ``` `), or a `## `-prefixed markdown heading. Those all collide with structure the compiler itself builds into the child ticket's body, so write plain prose in these fields — no fenced code, no `##` headings, no `---` lines.

## Drafting procedure

1. **Read the template.** Use Read tool on `~/.claude/skills/junco-dispatch/TEMPLATE.md` to load the canonical shape. Do not paraphrase from memory.
2. **Choose an example as anchor.** Read `EXAMPLE.md`; pick the one (trivial or moderate) closest in scope.
3. **Discover repo specifics for Pre-flight context + Reference.** Read the repo's `package.json` / `pyproject.toml` / `Cargo.toml` to capture build tool + version + key dependency versions. Read 1–2 files central to the change to extract reusable signatures (barrel exports, function signatures, type shapes). Paste these inline in the ticket — every Read avoided at execute time saves ~30 seconds. **Verify-before-drafting:** before populating Reference and Files sections, READ the actual target file(s). Do NOT assume field names, line numbers, imports, or interface shapes from memory — they have been wrong in the past (a plan-render listed a `description` field on a model that didn't exist, and called an `image` field "an HTTPS URL" when it was actually a CSS gradient). The plan-lint `files_paths_exist` rule will warn if your Files-table paths don't match the repo state.
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

### Linked tracking issue (optional)

When the user asks for an issue alongside the PR ("file an issue for this too", "link the PR to a tracking issue"), add to the frontmatter:

```yaml
github_request:
  create_issue: true
```

The **worker** — not you — creates the issue at claim time under its own GitHub identity (the operator's bot account when configured), on the clone's `origin` repo, and the eventual PR carries `Closes owner/repo#N` so merging closes it. Do NOT create the issue yourself with `gh`, and never write a `github:` block by hand (it is worker-managed). Omit the request when the ticket targets a repo the operator does not control (fork-PR dispatch) — the worker ignores it there. The same goes for amendment tickets (`amends_pr`): amendments never edit the existing PR's body, so the issue would never close — omit the request.

## Authoring discipline (what makes the plan NOT loop)

Empirical lessons from repeated testing. Bake these into every plan body:

- **Absolute paths or "relative to worktree root".** Never say "the config file".
- **Line numbers for surgical edits** (e.g. `src/a.ts:42–58`). Removes grep pressure.
- **Every step ends in a commit.** No uncommitted limbo states.
- **Three-tier scope split: ✅ / ⚠️ / 🚫.** ✅ is what to do; ⚠️ is the agent's escape hatch (stop and report — don't unilaterally fix); 🚫 is hard prohibitions on files. The ⚠️ tier prevents the most expensive failure mode (silent unilateral scope expansion).
- **Forbidden actions are behavior-level, not file-level.** Out-of-scope is "don't touch X.ts"; Forbidden actions is "don't `--no-verify`, don't force-push, don't `// @ts-ignore`". Both are needed.
- **Reference signatures, not just paths.** Paste `validate(token: str) -> Result[User, Error]` rather than `path/to/validate.py`. Saves Read calls AND prevents wrong-shape inventions.
- **Behavior (EARS) and Verification are paired.** Behavior says `WHEN X THE SYSTEM SHALL Y`; Verification gives the bash command that exercises it. They map 1:1.
- **Verification commands must be exact and check exit 0.** Not "make sure it builds". **Never include `cd <repo>` in the bash block** — junco runs it with `cwd=<worktree>`; a leading `cd` moves out of the worktree and the verification fails for the wrong reason.
- **Write portable verification commands.** The worker runs verification in the daemon's shell on whatever OS it runs on — prefer portable commands. Common gotchas when portability matters:
  - `wc -l < file` outputs `       1` (whitespace-padded) on BSD vs `1` on GNU. Use `awk 'END {print NR}' file` for portable line count, OR `[ "$(wc -l < file | tr -d ' ')" = "1" ]`.
  - `sed -i` requires a backup-extension arg on BSD: `sed -i ''` (note the empty string). Alternative: redirect to a temp file and `mv`.
  - `date -v +1d` (BSD) vs `date -d 'tomorrow'` (GNU) — prefer ISO timestamps in spec content rather than computing dates in verification.
  - `head -c N` works on both. `tail -c N` differs in offset semantics — verify the exact byte you want with `xxd` or `od` for portability.
  - When in doubt, prefer Python or `awk` one-liners over shell coreutils — they have consistent semantics across platforms.
- **The "Notes for the agent (strict)" section is mandatory.** Copy verbatim. Dropping this is the difference between a few minutes and 20+ minutes of wall clock.

## Plan-lint (automatic pre-dispatch check)

The junco worker runs a deterministic linter on every ticket before claiming it. Tickets that fail lint move directly to `failed/` with a `phase_error` like `plan-lint: no_cd_in_verification: ...` — they never reach the agent. Rules currently enforced:

- No `cd ` lines inside the `## Verification` fenced bash block
- Every `### Step N` block contains exactly one `git commit` line
- Every path in the Files table appears in at least one Step body
- Every label in frontmatter exists on the GitHub repo (`gh label list`)
- The strict "Notes for the agent" block is present at the end
- No forbidden phrases (`TBD`, `Similar to Step N`, `think carefully`, `consider all cases`)

If you generate a ticket and lint rejects it, fix the specific rule cited and re-dispatch. The linter exists to catch known foot-guns _before_ spawning a 5-minute agent run.

## Things to NEVER put in a plan

- **"Think carefully" / "consider all cases" / "be thorough"** — these feed xhigh self-doubt and trigger loops.
- **"TBD" / "TODO" / "similar to Step N" / "and so on"** — agent can't expand placeholders; it'll get stuck.
- **Defensive timeout inflation** — a 180-min cap on trivial work masks loop bugs and wastes GPU time.
- **Invented labels** — breaks `gh pr create` after push.
- **Optional suggestions** — "you might also want to check X". Either it's a step or it isn't.
- **Narrative verification** — use executable commands, not "confirm everything is working".
- **Multiple parallel branches / PRs per ticket** — junco is one-ticket = one-PR. Work that genuinely needs several PRs is a SET of tickets with `depends_on` edges between them (see "Ticket sets" below), never one ticket juggling multiple branches.

## Dispatch procedure

**Two modes** based on trigger phrase:

- **Interactive (default):** triggered by `junco:`, `dispatch to junco`, `send to junco`, `/junco`. Includes the preview gate — used for normal day-to-day dispatch.
- **Batch (no preview):** triggered by `junco-batch:`. SKIPS the AskUserQuestion preview gate entirely and submits directly. Used for automated load tests run from a non-interactive / headless harness (no interactive prompt tool available). The AskUserQuestion tool is unavailable in a headless harness and will throw `ToolAbortError` if invoked, so batch mode MUST omit it. Do NOT use `junco-batch:` for normal interactive dispatches — there is no review checkpoint.

### Interactive mode (default)

1. **Render.** Generate the full ticket as a string (frontmatter + body).
2. **Preview + approve.** Use `AskUserQuestion` with the rendered ticket as a preview. Ask: "Dispatch this to junco?" with options `Yes, dispatch` / `Edit first` / `Cancel`.
3. **On approve — submit via CLI.** Write the rendered ticket to a temp file, then run:

   ```
   junco submit <tempfile>
   ```

   (`junco submit` resolves the configured inbox and places the file atomically, deriving the filename from the `id` frontmatter field.) If `junco` is not installed globally, use `npx junco submit <tempfile>`. Report the destination path it prints.

4. **Announce.** Tell the user:
   - Ticket id and destination path (from `junco submit` output)
   - Expected wall clock (use `timeout_minutes` as an upper bound)
   - How to watch: watch the daemon's log output (its stdout, captured by your process/service manager), or poll the `done/` and `failed/` directories under the queue root (`junco inbox-path` shows where the queue lives)
5. **Offer monitoring.** Ask: "Want me to monitor the ticket and notify when it lands in done/ or failed/?" If yes, spawn a Monitor tool call that polls `done/<id>` and `failed/<id>` under the queue root.

### Batch mode (no preview, headless harness)

Triggered when the user prompt starts with `junco-batch:`. Identical to interactive mode EXCEPT step 2 and step 5 are skipped:

1. **Render.** Generate the full ticket as a string (frontmatter + body). Same template, same rules.
2. **(SKIPPED)** No `AskUserQuestion` preview gate. The ask tool is unavailable in a headless harness and would throw `ToolAbortError`.
3. **Submit via CLI.** Write the rendered ticket to a temp file, then run `junco submit <tempfile>` (or `npx junco submit <tempfile>`). The worker resolves the configured inbox and places the file atomically.
4. **Print one-line confirmation to stdout.** Format: `BATCH_DISPATCHED <id> -> <destination-path>`. This line is what the calling shell script greps for to confirm success. (The destination path comes from `junco submit` output.)
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

## Assess mode (audit a repo → review → file)

Triggered by "assess this repo", "have junco audit this repo", "junco assess <repo>", and similar. This mode is **not** plan authoring — do not draft a ticket. `junco assess` composes its own machine-owned ticket; the daemon then runs a read-only audit (a dependency scan plus a read-only agent audit) and **parks** the findings in a durable review queue — nothing is filed yet. A separate, human-confirmed step (`junco assess review` / `junco assess file`) files the findings you select as GitHub issues. An assess run **never opens a pull request**.

**Works on any watched repo, owned or not.** On a repo you own, filed issues get `junco:finding` + `severity/<level>` labels (best-effort). On a repo you don't own, filed issues are label-free — junco never assumes triage rights it doesn't have on someone else's tracker; the severity and fingerprint still live in the issue title and a body marker.

**An issue reference scopes the audit and auto-provisions.** `junco assess owner/repo#N` (or an issue URL) steers the audit to the code that issue implicates and, unlike the bare `owner/repo` form above, **auto-provisions** an unwatched repo — fork, clone, watchlist add, the same as `junco dispatch`/`junco analyze` — instead of requiring it be watched already. Findings filed from a scoped audit carry a `**Context:** owner/repo#N` line that GitHub cross-references onto the issue's timeline automatically; no comment is posted on the issue itself (that's Analyze mode, below).

Your job here is only: resolve the target, decide whether to pass `--auto-plan`, confirm, run the CLI, and set expectations — including that a review step still stands between the audit and anything landing on GitHub. Do NOT use `TEMPLATE.md`, plan-lint, or any of the authoring discipline above — none of it applies to assess (`junco assess` owns the ticket shape, not you).

### Inputs to gather

1. **Target** — one of:
   - an absolute (or `~`-relative) path to a local git checkout — default to the current working directory if it's a git repo, and confirm; or
   - an `owner/repo` that junco already watches — a `[[github.repos]]` entry, one added from the dashboard, or an external (unowned) watchlist entry. An unwatched `owner/repo` is rejected by the CLI — surface that and offer a local path instead; or
   - an `owner/repo#N` reference or issue URL — scopes the audit to that issue instead of the whole repo, and auto-provisions an unwatched repo rather than requiring it be watched already (see above).
2. **`--auto-plan`?** — off by default. It applies the GitHub trigger label to every issue filed from this batch so the bridge can plan them, but only takes effect on a repo you own — an unowned batch always forces it off, since junco doesn't queue plan/PR work against a repo it doesn't own. Only worth setting when the target repo is bridge-watched _and_ GitHub integration is enabled; otherwise the label just sits inert (see caveat). Ask if unsure; when in doubt, leave it off.

### Preconditions (check before running; fail fast with a useful message)

- **The daemon must be running.** `junco assess` only _queues_ a ticket — nothing is audited and nothing is parked for review until the daemon claims it on its next poll (~15 s). Unlike a dispatch there is no PR to watch; the payoff is a reviewable batch of findings appearing a little later. If the user isn't running the daemon, say so up front.
- **The repo needs a GitHub `origin` remote.** The daemon resolves the destination repo from `origin`; a repo with no GitHub `origin` fails the run (any filed issues need a home). Pre-check with `git -C <path> remote -v` (or `gh repo view <path>`) before queuing.

### Interactive procedure (default)

1. **Confirm.** Use `AskUserQuestion`: "Run `junco assess <target> [--auto-plan]`? This queues a read-only audit; findings are parked for your review, not filed automatically." with options `Yes, run` / `Edit first` / `Cancel`.
2. **Run.** `junco assess <target> [--auto-plan]` (or `npx junco assess <target> [--auto-plan]` if `junco` isn't on PATH).
3. **Report** the `queued: <ticket-path>` line the command prints, plus:
   - the daemon must be running for the audit to happen;
   - once it's done, findings sit in a review queue — nothing is filed yet;
   - to see what's pending: `junco assess review` (list) or `junco assess review <id>` (one batch's findings with fingerprints);
   - to file the ones worth keeping: `junco assess file <id> --all` or `junco assess file <id> --only <fingerprint,…>`;
   - on a repo the user owns, filed issues carry `junco:finding` + `severity/<level>` labels; on a repo they don't own, issues file label-free;
   - with `--auto-plan` on an owned, bridge-watched repo, filed issues also carry the trigger label, taking them into the label → plan → approve → PR loop.

### Batch / headless procedure

When invoked headlessly (`junco-batch:` prefix, or no interactive ask tool available): skip the confirm gate, run `junco assess <target> [--auto-plan]`, and print one line for the calling shell to grep — `ASSESS_QUEUED <id> -> <ticket-path>` (id and path come from the command's output). Filing still requires a separate, explicit `junco assess file <id> --all|--only <fp,…>` — batch mode does not auto-file.

### Caveats to surface

- **A review step always sits between the audit and any filed issue.** `junco assess` no longer files anything by itself; `junco assess file` does, and it requires an explicit `--all` or `--only <fingerprints>` — there's no bare default.
- **`--auto-plan` is inert unless the repo is owned, bridge-watched, and GitHub integration is enabled.** The label lands on filed issues from that batch, but only a watched repo (with the bridge on) turns a labeled issue into a plan; an unowned repo never gets the label regardless of the flag.
- **Closing a finding issue suppresses it forever.** Dedup scans your own most recent 500 issues on the repo (author-scoped, closed ones included) for the finding marker, so closing an issue (even as wontfix) stops that finding from ever re-filing — including a genuine future regression that hashes the same. To let it re-file, delete the issue or edit the `<!-- junco:finding:... -->` marker line out of its body.
- **A parked-but-unreviewed finding is not suppressed** — it just re-parks on the next audit, since no issue exists yet.
- **The auto-provisioning asymmetry is deliberate.** `owner/repo#N` auto-provisions an unwatched repo; bare `owner/repo` does not — it still errors if the repo isn't already watched. Don't "fix" this by watching a repo first when the user gave an issue reference; just run the command.
- For the authoritative flag list and config knobs (`[assess]`), point the user at `junco assess --help` and the project README.

### Do NOT

- Hand-author an assess ticket, or bolt `assess:` frontmatter onto a plan — `junco assess` owns that machine-owned shape.
- Apply `TEMPLATE.md` / plan-lint / the anti-loop authoring rules — they are for plan tickets, not assess.
- Treat assess as PR dispatch — it never opens a PR.
- File findings on the user's behalf without them choosing `--all` or specific fingerprints — that selection is the human confirmation gate, and it isn't yours to make for them.

## Analyze mode (investigate an issue → reviewed comment)

Triggered by "analyze issue #N", "have junco look into this issue", "junco analyze <owner/repo#N|url>", and similar. Like assess, this mode is **not** plan authoring — do not draft a ticket. `junco analyze` composes its own machine-owned ticket; the daemon then runs a read-only investigation of the named issue against the repo and **parks** the resulting comment draft in a durable review queue — nothing posts yet. A separate, human-confirmed step (`junco analyze review` / `junco analyze edit` / `junco analyze post`) posts the draft as a comment on the issue. An analyze run **never opens a pull request** and posts **no comment other than the one you explicitly confirm**.

**Works on any issue, owned repo or not.** An unwatched repo is auto-forked and provisioned exactly like `junco dispatch` — no separate "watch it first" step. Every posted comment carries a disclosure footer by default (`_Analysis drafted with [junco](https://github.com/ironforgesoftware/junco) and human-reviewed before posting._`); `junco analyze post <id> --no-footer` omits it.

Your job here is only: resolve the issue reference, confirm, run the CLI, and set expectations — including that a review (and optional edit) step always stands between the investigation and anything posted to GitHub. Do NOT use `TEMPLATE.md`, plan-lint, or any of the authoring discipline above — none of it applies to analyze (`junco analyze` owns the ticket shape, not you).

### Inputs to gather

1. **Target** — an `owner/repo#N` reference or a full issue URL (e.g. `https://github.com/owner/repo/issues/42`). If the user names an issue without the repo and you're inside a git checkout with a GitHub remote, offer to combine them and confirm.

### Preconditions (check before running; fail fast with a useful message)

- **The daemon must be running.** `junco analyze` only _queues_ a ticket — nothing is investigated and nothing is parked for review until the daemon claims it on its next poll (~15 s). If the user isn't running the daemon, say so up front.
- **One draft per issue.** If a previous analysis of the same issue is still queued or running (not yet parked or failed), re-running `junco analyze` on it fails loud (`ticket already queued`) rather than silently duplicating work — mention this if the user asks to re-run one they just triggered.

### Interactive procedure (default)

1. **Confirm.** Use `AskUserQuestion`: "Run `junco analyze <target>`? This queues a read-only investigation; the drafted comment is parked for your review, not posted automatically." with options `Yes, run` / `Edit first` / `Cancel`.
2. **Run.** `junco analyze <target>` (or `npx junco analyze <target>` if `junco` isn't on PATH).
3. **Report** the `queued: <ticket-path>` line the command prints, plus:
   - the daemon must be running for the investigation to happen;
   - once it's done, the draft sits in a review queue — nothing is posted yet;
   - to preview it: `junco analyze review` (list) or `junco analyze review <id>` (full draft, exactly as it would post, footer included);
   - to revise it: `junco analyze edit <id>` (opens `$EDITOR`/`$VISUAL`; re-sanitizes on save);
   - to post it: `junco analyze post <id>` (add `--no-footer` to omit the disclosure line) — this is the human confirm step, and it's the only outward write in the whole flow.

### Batch / headless procedure

When invoked headlessly (`junco-batch:` prefix, or no interactive ask tool available): skip the confirm gate, run `junco analyze <target>`, and print one line for the calling shell to grep — `ANALYZE_QUEUED <id> -> <ticket-path>` (id and path come from the command's output). Posting still requires a separate, explicit `junco analyze post <id>` — batch mode does not auto-post.

### Caveats to surface

- **A review step always sits between the investigation and any posted comment.** `junco analyze` never posts anything itself; `junco analyze post` does, and it's a deliberate per-draft action — there's no bare "post everything" shortcut.
- **The issue text is untrusted input the agent read, not instructions.** The investigation prompt frames it as data; a hostile or mistaken issue can't redirect what the agent does, but the review step is still worth taking seriously before posting on someone else's tracker.
- **Re-analyzing an issue overwrites its pending draft**, not additive — `junco analyze review <id>` always reflects the latest investigation.
- For the authoritative flag list, point the user at `junco analyze --help` and the project README.

### Do NOT

- Hand-author an analyze ticket, or bolt `analyze:` frontmatter onto a plan — `junco analyze` owns that machine-owned shape.
- Apply `TEMPLATE.md` / plan-lint / the anti-loop authoring rules — they are for plan tickets, not analyze.
- Treat analyze as PR dispatch — it never opens a PR.
- Post a comment on the user's behalf without them running `junco analyze post <id>` explicitly — that confirmation is the human gate, and it isn't yours to make for them.

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
- Empirical data from repeated end-to-end test runs comparing structured plans vs. loose prompts

The "Notes for the agent (strict)" block is the single most-earned asset — multiple 20-minute looping runs led to its exact wording.
