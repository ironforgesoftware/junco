# Tickets

The ticket format — flavors, frontmatter, examples, submission — and the pipeline a ticket rides from inbox to pull request.

[← back to the README](../README.md)

A ticket is a Markdown file with YAML frontmatter and a plan body. Run `junco schema` to print the full typed JSON Schema for every frontmatter field.

## Ticket flavors

| Flavor                   | Trigger                                                                                                     | What happens                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Q&A ticket**           | No `repo:` field                                                                                            | Agent answers in-place; result written back to the ticket file. No git.                                                                                                                                                                                                                    |
| **PR-flow ticket**       | `repo: <absolute/path>`                                                                                     | Agent runs in an isolated git worktree; a draft PR is opened on success.                                                                                                                                                                                                                   |
| **Audit ticket**         | `audit:` mapping present (checked before `repo:`) — `assess:` is a permanently accepted legacy alias        | `npm audit` + a read-only agent audit of the `repo:` target; findings are parked for review — `junco audit file` is the confirm step that actually files them as GitHub issues — instead of opening a PR. → [Repo audit guide](./audit.md)                                                 |
| **Investigation ticket** | `investigate:` mapping present (checked before `repo:`) — `analyze:` is a permanently accepted legacy alias | A read-only agent investigation of the issue named in `investigate:` against the `repo:` target; the drafted comment is parked for review — `junco investigate post` is the confirm step that actually posts it — instead of opening a PR. → [Issue investigation guide](./investigate.md) |
| **Apply ticket**         | Body carries a `junco-patch` fence (`repo:` still required)                                                 | Same PR flow as a PR-flow ticket, but `git am --3way` applies a pre-built patch series directly instead of running an agent. → [Apply tickets](#apply-tickets)                                                                                                                             |

## Key frontmatter fields

| Field             | Type                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | string              | Unique ticket identifier. Used as the inbox filename and branch suffix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `repo`            | path                | Absolute path to the target git repository. Presence triggers PR flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `priority`        | `low\|normal\|high` | Processing order within the queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `timeout_minutes` | number              | Per-ticket wall-clock cap. Overrides `worker.defaultTimeoutMinutes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `base_branch`     | string              | Branch to fork from. Overrides `git.defaultBaseBranch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `branch_name`     | string              | Override the auto-generated branch name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pr_title`        | string              | Pull request title.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `draft`           | bool                | Open PR as draft. Overrides `pr.draftByDefault`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `labels`          | string[]            | Labels to apply to the PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `reviewers`       | string[]            | GitHub handles to request as reviewers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `amends_pr`       | number              | PR number — add commits to an existing PR instead of opening a new one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `push_remote`     | string              | Git remote the PR flow pushes the feature branch to. Defaults to `origin`. Set to `fork` (with a `fork` remote on the clone) for fork-based PRs against a repo you can't push to; the PR is then opened with `--head <fork-owner>:<branch>`. Worker-managed in fork-PR mode — see [GitHub mode](./github-mode.md#external-repos-fork-pr-mode).                                                                                                                                                                                                     |
| `tools`           | string[]            | Per-ticket tool allowlist override. Q&A tickets default to a read-only subset (`read, grep, find, ls`); list tools explicitly (e.g. `[read, grep, bash]`) to opt in to more.                                                                                                                                                                                                                                                                                                                                                                       |
| `not_before`      | ISO datetime        | Don't claim this ticket before this UTC instant. Set by the worker for retry backoff; dispatchers may also set it to schedule work.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `retry_count`     | integer             | Worker-managed transparent-retry counter. Don't set by hand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `depends_on`      | string[]            | Ticket ids that must be satisfied before this ticket is claimed: each referenced ticket finished successfully AND (when it opened a pull request) that PR was merged. Unsatisfied edges leave the ticket queued; a terminally failed dependency parks this ticket in failed/ (dependency cascade).                                                                                                                                                                                                                                                 |
| `deps_satisfied`  | string[]            | Worker-managed: `depends_on` entries the dependency sweep has confirmed satisfied. Don't set by hand.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `plan`            | mapping             | Optional plan-set membership/provenance: ties this ticket to an approved plan. `{ id: string, task: string, hash: string }` — `hash` is worker-managed (content hash of the approved plan). Stamped by the compiler — don't set by hand. → [Plan sets](#plan-sets-the-junco-plan-fence)                                                                                                                                                                                                                                                            |
| `audit`           | mapping             | Selects the audit flavor (see above). `{ auto_plan: bool, issue: number, issue_title: string }` — `issue`/`issue_title` are present only when scoped via `junco audit owner/repo#N`, and steer the audit and filed findings' `Context:` line. Machine-composed by `junco audit` — don't set by hand. `assess:` is a permanently accepted legacy alias (same shape); when a ticket carries both, `audit:` wins. → [Repo audit guide](./audit.md)                                                                                                    |
| `investigate`     | mapping             | Selects the investigation flavor (see above). `{ issue: number, title: string }`. Machine-composed by `junco investigate` — don't set by hand. `analyze:` is a permanently accepted legacy alias (same shape); when a ticket carries both, `investigate:` wins. → [Issue investigation guide](./investigate.md)                                                                                                                                                                                                                                    |
| `github_request`  | mapping             | Dispatcher-settable. `{ create_issue: true }` asks the worker to create a GitHub tracking issue for this ticket at claim time — on the clone's origin repo, under the worker's own gh identity (the bot account when configured) — and stamp the `github:` provenance block itself, so the resulting PR closes the issue on merge. Best-effort: if creation fails (offline, no permission, non-GitHub origin) the ticket still runs, unlinked. Ignored on fork-push (`push_remote: fork`), amend (`amends_pr`), and Q&A/audit/investigate tickets. |

> **Worker-managed `github:` block.** Tickets bridged from a GitHub issue carry a `github:` provenance block (`nwo`, `issue`, `kind`) built by the worker — never set it by hand. Its `github.external: true` flag marks a ticket that targets a repo you don't control (fork-PR mode): the reporter posts no labels or comments to the upstream issue, and the draft PR from the `push_remote` fork is the only outward-facing write. See [GitHub mode → External repos](./github-mode.md#external-repos-fork-pr-mode). Local dispatches can _request_ linkage without writing the block: set `github_request: { create_issue: true }` and the worker creates the issue and stamps `github:` itself.

## Minimal Q&A ticket

```markdown
---
id: my-qa-2026-05-31
priority: normal
timeout_minutes: 10
---

# My question

What is the time complexity of binary search and why?
```

## Minimal PR-flow ticket

````markdown
---
id: add-util-2026-05-31
priority: normal
timeout_minutes: 30
repo: /absolute/path/to/your-repo
base_branch: main
pr_title: Add utility function
draft: true
---

# Add a utility function

## Steps

- [ ] Implement the function.
- [ ] Commit: `git add ... && git commit -m "feat: add utility"`

## Verification

```bash
npx tsc --noEmit
```

## Done when

- [ ] 1 commit on the branch.
````

## Apply tickets

A PR-flow ticket (`repo:` present) whose **body** carries a `junco-patch` fence is an _apply ticket_. No frontmatter key selects it — detection is body-based only, the same way plan-set and Q&A-vs-PR-flow detection work elsewhere in Junco. Instead of driving an agent, Junco applies the fence's contents directly as a `git format-patch` mbox series: `git am --3way` applies AND commits the series in the provisioned worktree, so the series' own commit messages land as the PR's commits, in the same order they were generated.

- **No agent session runs — on a clean apply.** The PR flow's Phase 4 (see `ARCHITECTURE.md`) branches on the fence's presence: an apply ticket skips straight to `git am --3way` instead of driving the coding agent. A failed apply, or a clean apply whose own `## Verification` block then fails, can still hand the ticket to one agent turn — see [Escalation ladder](#escalation-ladder-when-a-patch-does-not-apply-cleanly) below.
- **Verification still gates the PR.** The ticket's own `## Verification` block runs exactly as it would for an agent-authored ticket, and a failing block still fails the PR the same way (subject to the escalation ladder below).
- **The critic runs only once an agent has touched the ticket.** Comparing the landed diff against the spec is tautological when the diff _is_ the spec, so a clean apply with no fallback skips that pass — the outcome records the skip as `apply mode — the patch series is the spec` rather than a PASS/MISSING verdict. The moment either rung of the escalation ladder fires, the tautology no longer holds and the critic runs exactly as it would for an ordinary agent ticket.
- **A conflict fails the ticket by default only when the fallback is disabled.** With `worker.applyFallbackToAgent` at its default (`true`), a `git am --3way` conflict escalates to the agent instead (see below). With the lever off, a conflict fails the ticket outright: it's routed straight to `failed/` rather than through the transient-failure/requeue path (a conflict against the same base is deterministic, so requeuing would just fail again identically), the `git am` output is folded into the failure note, `git am --abort` has already run, and the worktree is preserved (not pruned) so you can inspect it in a clean, un-wedged state.
- **Leftovers are never swept — on a clean apply.** Even with `commit_leftovers` enabled, a worktree left dirty after a clean `git am` fails loud instead of being folded into an extra commit the series itself never authored — `git am` applies and commits in one step, so anything left uncommitted afterward means something is wrong. A fallback session is an ordinary agent ticket from that point on, so `commit_leftovers` applies to it normally.

### Escalation ladder: when a patch does not apply cleanly

Two things can go wrong with an apply ticket after Phase 4 starts, and both are handled by the same one-shot escalation, gated by `worker.applyFallbackToAgent` (default **true**):

1. **The `git am --3way` itself fails** (a conflict against the current base). `git am --abort` runs immediately to leave the worktree clean.
2. **The apply succeeds, but the ticket's own `## Verification` block then fails.** The patch landed, but doesn't actually work against the current tree.

Either failure, with the lever on, dispatches **exactly one** agent session — never a loop. The agent receives the patch series as a **specification to implement against current reality**, not bytes to replay, plus the specific failure detail (the `git am` error, or the verification output); it's told explicitly not to re-run `git am`/`git apply`, since the series has already been tried (and rolled back, on an apply failure). Whatever that one session produces is re-verified once and the result stands — Phase 10's verification gate applies to it exactly as it would to any other ticket. With the lever off, either failure fails the ticket immediately instead, exactly as described in the bullets above.

**What this means for the approval gate — stated plainly.** On the GitHub route, a human's trigger-label approval was given to a _specific reviewed diff_. If the fallback runs, the PR that opens is **no longer byte-identical to what was approved** — the agent improvised a solution, not replayed the approved bytes. The PR body carries an explicit disclosure banner saying exactly that, and the ticket should be reviewed as ordinary agent-authored work, not rubber-stamped on the strength of the original patch review. Operators who need the byte-identical guarantee to hold unconditionally should set `worker.applyFallbackToAgent` to `false` — a failed apply then fails the ticket outright instead of quietly substituting agent work for the reviewed diff. See [Configuration § Apply-ticket fallback](configuration.md#apply-ticket-fallback) for the lever itself.

**Where this shows up: the task-history ledger.** Every PR-kind ticket's finalize record carries a `mode` field: `"apply"` for a clean apply with no fallback, `"apply_fallback"` for either rung of the ladder above, or `"agent"` for an ordinary agent-driven ticket. That makes the wall-clock and token difference between "the diff just landed" and "an agent had to finish it" a queryable fact instead of something inferred from logs. `junco status` and the dashboard don't render this field today — it's readable straight from `<dataDir>/data/history/tasks-YYYY-MM.jsonl`.

### Authoring rule: fence length

Wrap the series in a fence strictly longer than any backtick run that appears inside it. A plain patch (no fenced content in the diff) needs only the usual three backticks; a patch that itself adds or edits a fenced code block in a markdown file — one that already uses three backticks — needs a four-backtick outer fence instead, since extraction only recognizes a `junco-patch` block whose closing fence is at least as long as its opener.

### Limitation: commit authorship

`git am` takes the commit author from the mbox `From:` header, so applied commits are authored by whoever generated the patch series — Junco is only the _committer_. There's no way to make applied commits read as authored by Junco/the bot short of rewriting the `From:` headers before submitting. (A fallback session's commits are authored normally, like any other agent ticket.)

### Transcripts

Apply runs write a transcript exactly like an agent run. `junco transcript <id>` and the dashboard's transcript view record an apply run as `junco_meta` (first write) + a `junco_run_start` (`flow: "apply"`) + a `junco_run_end` frame bracketing the `git am` attempt itself, on both the success and the failure path — there are no turn/tool frames, since nothing but `git am` ran. When the escalation ladder then dispatches an agent session, that session's own run opens the **same** transcript file and appends to it (no duplicate `junco_meta`), so a failed-then-escalated ticket produces **one chronological record**: the apply frames first, the agent session's frames after.

### Lint rules

`junco lint` and `junco submit --dry-run` validate a `junco-patch` body the same way they validate any other ticket:

| Rule                     | Severity | Checks                                                                                                                                                                                                                                                         |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patch_parses`           | error    | The fence is a well-formed `git format-patch` series — an mbox `From <sha> …` header and at least one `diff --git a/… b/…` hunk, under 512 KB. A path git had to C-quote (`"a/…"`: quotes, backslashes, tabs, non-ASCII bytes) is refused rather than skipped. |
| `patch_paths_sane`       | error    | The series doesn't touch paths outside the repo (absolute paths, `..` traversal) and carries no binary hunk.                                                                                                                                                   |
| `patch_has_verification` | warning  | The ticket still has a `## Verification` block — it's the only execution-time check apply mode has.                                                                                                                                                            |

The prose rules (`steps_have_commits`, `files_table_referenced`, `files_paths_exist`, `no_cd_in_steps`) are skipped for apply tickets — a patch series has no Steps or Files table for them to check.

`patch_paths_sane` is also enforced by the executor itself, not only by lint: `applyPatchSeries` re-runs the same checks unconditionally before `git am`, so with `planLint.enabled` or `planLint.blockOnError` off a series lint would have blocked is still refused at execution time — the ticket fails with `apply failed: refused before git am: …`, the escalation ladder does not fall back to an agent, and the worktree is left untouched (no transcript frames either — nothing ran; the ticket's failure note carries the reason).

### What `patch_paths_sane` does not cover

`patch_paths_sane` inspects the series' **declared path strings** — the paths named on each `diff --git`/`---`/`+++` line — not what those paths resolve to on disk. Concretely, it does not catch:

- An in-repo symlink hunk (`mode 120000`) whose **target** points outside the repo (e.g. `link -> /etc/passwd`); the declared path (`link`) is ordinary and clean, so the rule has nothing to flag, and `git am` applies it.
- A path like `.github/workflows/…` — a workflow-file change is not a path-traversal or absolute path, so it applies cleanly like any other in-repo path.

Neither is a gap in enforcement so much as a gap in what lint can see from path strings alone: both are contained by the trigger-label trust gate, the diff being fully visible in the parked issue/ticket, and the draft-PR blast radius — the same trust model an agent-authored ticket already relies on, not by `patch_paths_sane` itself. Read the rule's name as "sane path strings", not "sane resulting tree."

### Untested / unsupported interactions

These combinations are not exercised by the test suite and their behavior is not a documented contract — treat it as undefined until someone needs it:

- A `junco-patch` fence inside an amend (`amends_pr`) ticket. `parsePatchSeries` runs unconditionally in Phase 4, so this activates apply mode on the amend branch instead of the agent path.
- A `junco-patch` fence inside a plan-set child ticket.
- A body carrying **both** a `junco-patch` fence and Steps/Files prose — the fence wins (apply mode runs), and the Steps prose is silently ignored; lint does not flag the dead prose.
- A `junco-patch` fence inside a Q&A ticket (no `repo:`) — there is no worktree to apply into, so the fence is treated as ordinary read-only prose handed to the agent, not as a series to apply.

### Minimal apply ticket

````markdown
---
id: apply-pagination-fix-2026-08-31
priority: normal
timeout_minutes: 20
repo: /absolute/path/to/your-repo
base_branch: main
pr_title: Fix off-by-one in pagination
draft: true
---

# Apply a pre-built patch series

```junco-patch
From 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b Mon Sep 17 00:00:00 2001
From: Jane Dev <jane@example.com>
Date: Sun, 30 Aug 2026 12:00:00 -0700
Subject: [PATCH] fix: correct off-by-one in page offset

---
 src/paginate.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/src/paginate.ts b/src/paginate.ts
index 1111111..2222222 100644
--- a/src/paginate.ts
+++ b/src/paginate.ts
@@ -10,7 +10,7 @@ export function paginate(items: Item[], page: number, size: number): Item[] {
-  const offset = page * size;
+  const offset = (page - 1) * size;
   return items.slice(offset, offset + size);
 }
--
2.43.0
```

## Verification

```bash
npx tsc --noEmit
```
````

## Plan sets (the `junco-plan` fence)

A _plan set_ is one fenced YAML document that Junco compiles into a dependency-ordered set of PR-flow tickets — each task becomes its own ticket and its own pull request, and a task is claimed only after every task it `depends_on` has finished successfully and had its PR merged. It is the compiler behind the `depends_on` / `deps_satisfied` / `plan` frontmatter fields above: you write the plan, the compiler writes the tickets. Compilation is gated by `planSets.enabled` (default **off** — see [Configuration § Plan sets](configuration.md#plan-sets)); the dependency machinery underneath (claim gating on `depends_on`, the merge sweep, the failure cascade) is always on, so hand-authored tickets with `depends_on:` work with the lever off.

Two doors compile a plan set:

- **Local:** `junco submit --plan <file> --repo <path>` reads the **last** complete `junco-plan` fence in `<file>` — a plan document is not a ticket and carries no frontmatter; anything outside the fence is ignored — validates it, and drops the compiled children straight into the inbox. Re-running with an edited plan supersedes the previous revision's still-unclaimed children. `junco lint` validates tickets, not plan documents: the compiler's own validator runs at submit time and prints every error at once.
- **GitHub bridge:** with plan sets on, a labeled issue whose vouched body carries a `junco-plan` fence (`junco submit --as-issue --plan <file> --repo <path>` parks exactly that), or a planning session that emits one instead of a single `junco-ticket` fence, is compiled on labeling/approval. The bridge then maintains a plan-set dashboard comment, set-level lifecycle labels, and a degraded-mode comment on the first failure. → [GitHub mode](./github-mode.md)

### The fence

````markdown
```junco-plan
version: 1
shared_context: |
  Constraints every task inherits — build and test commands, conventions, what never changes.
tasks:
  - id: api-endpoint
    title: Add the /v1/items endpoint
    description: |
      Self-contained, for an agent that sees only this task, the shared context, and the
      ids of its prerequisites. What to build and why.
    acceptance:
      - WHEN GET /v1/items is called THE SYSTEM SHALL return 200 with a JSON array.
    prohibitions:
      - Do not touch the UI package.
    verification: |
      npm test
  - id: items-ui
    title: Render the items list from /v1/items
    depends_on: [api-endpoint]
    description: |
      Consume the endpoint the api-endpoint task added; it is merged by the time this runs.
    acceptance:
      - WHEN the items page loads THE SYSTEM SHALL render one row per item returned.
    verification: |
      npm test
```
````

| Field                  | Required | Meaning                                                                                                                                               |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`              | yes      | Always `1`.                                                                                                                                           |
| `shared_context`       | no       | Prose every child ticket carries under its `## Shared context` section.                                                                               |
| `tasks[].id`           | yes      | `[a-z0-9][a-z0-9-]{0,31}`, unique within the plan, and not purely numeric or `r<digits>` — that shape collides with the queue's retry-suffix grammar. |
| `tasks[].title`        | yes      | The child ticket's `#` heading.                                                                                                                       |
| `tasks[].depends_on`   | no       | Ids of other tasks in the same document. Forward references are fine; unknown ids, self-edges, and cycles are refused.                                |
| `tasks[].description`  | yes      | What to build and why — the top of the child ticket's body.                                                                                           |
| `tasks[].acceptance`   | yes      | Non-empty list; becomes the child's `## Behavior` assertions.                                                                                         |
| `tasks[].prohibitions` | no       | Becomes the child's `## Prohibitions` list.                                                                                                           |
| `tasks[].verification` | no       | Shell commands, one per line; emitted as the child's `## Verification` bash block, which the worker runs.                                             |

**What the compiler builds.** Each task becomes a ticket `<plan-id>-<task-id>` (the plan id is `plan-<file-slug>` on the local door), with `repo:` stamped from `--repo` (or the watchlist, on the bridge), a `plan: { id, task, hash }` provenance block, and `depends_on:` remapped to the sibling ticket ids. Every free-text field is plain prose: a frontmatter delimiter (`---`), a code fence (` ``` `), or a `## `-prefixed heading inside `title`, `description`, `acceptance`, `prohibitions`, `verification`, or `shared_context` is **refused**, not stripped — each collides with structure the compiler builds into the child body. Use `###` or deeper for a subheading. A plan with more than `planSets.maxTasks` tasks (default 10) is refused whole; validation collects every error before deciding, and nothing dispatches on any error.

Never hand-author `plan:` or `depends_on:` on a compiled set — the compiler owns them. `examples/plan-set.md` is a complete, compilable example.

## Submitting tickets

```bash
# From a file:
junco submit ./my-ticket.md

# From stdin:
cat my-ticket.md | junco submit -

# Compose and submit an apply ticket directly from a git format-patch file:
junco submit --patch ./my-series.patch --repo /absolute/path/to/your-repo \
  --title "Fix off-by-one in pagination" \
  --why "Backport the upstream fix" \
  --verify "npx tsc --noEmit"

# Compile a plan set (requires planSets.enabled) into its child tickets:
junco submit --plan ./my-plan.md --repo /absolute/path/to/your-repo

# Print the inbox path:
junco inbox-path
```

`junco submit --patch <file> --repo <path> [--title T] [--why W] [--verify CMD]` composes an
apply ticket (the `junco-patch` fence, wrapped at a safe fence length automatically) from an
existing `git format-patch` series so hand-authoring the fence is no longer the only way to
submit one — `--patch` and `--repo` are required, `--title`/`--why`/`--verify` are optional
(`--title` also seeds the ticket id slug; omitted, the PR title falls back to the series' own
first `Subject:` line; `--why` defaults to a line naming the patch file; `--verify`, when given,
emits a `## Verification` block). It composes the same ticket shape documented under
[Apply tickets](#apply-tickets) above, then falls into the same `--as-issue`/`--dry-run` routing
as a hand-authored file ticket — combine it with either flag exactly as you would `junco submit
<file>`.

The bundled `junco-dispatch` skill teaches coding agents (Claude Code and other
skills-capable harnesses) to scaffold well-structured tickets and submit them — including apply
tickets, when the agent already knows the exact bytes to land and there's nothing left to
resolve by reasoning about the target tree. Link it into your harness once with `junco skill
install --harness <name|path>`; the daemon re-checks and self-heals the links at every start.

## Templates

Ticket templates live in the `templates/` directory:

- `templates/plain/task.md` — Q&A ticket template (plain Markdown)
- `templates/plain/task-code.md` — PR-flow ticket template (plain Markdown)
- `templates/task.md`, `templates/task-code.md` — the same templates with [Obsidian Templater](https://github.com/SilentVoid13/Templater) date/title placeholders, for Obsidian-vault dispatch setups

> `junco retry` note: a retried ticket is cut at the first appended `<!-- junco-result` separator, so a ticket BODY containing that literal line would lose its tail on retry.

## PR-flow lifecycle

1. Ticket lands in `inbox/` — plan-lint validates frontmatter first (bad tickets → `failed/`, no agent run).
2. Daemon claims it atomically into `processing/`.
3. Git worktree provisioned from `origin/<base_branch>` at `<worktreeRoot>/<id>`.
4. Agent runs with loop guards active (supervisor watches each turn; nudges on guard trips, kills on escalation).
5. After the agent session: the `## Verification` block runs in the worktree.
6. Critic compares the diff to the spec; if items are missing and retries remain, one corrective agent turn is dispatched.
7. Branch pushed; `gh pr create --draft` opens the PR.
8. Ticket moves to `done/` (success) or `failed/` (any failure). Worktree removed on success if `git.removeWorktreeOnSuccess = true`.

## How it works

```

You (or any harness)
│
│ junco submit <ticket.md>
▼
<dataDir>/queue/inbox/ ← drop tickets here
│
│ daemon polls every 15s
▼
┌──────────────────────────────────────────────────────┐
│ junco daemon │
│ │
│ 1. plan-lint validate frontmatter │
│ 2. claim inbox/ → processing/ │
│ 3. git worktree isolated branch per ticket │
│ 4. agent run drives coding agent │
│ └─ loop guards supervisor watches each turn │
│ 5. verification runs ## Verification block │
│ 6. critic diff-vs-spec check │
│ 7. push + PR gh pr create --draft │
│ 8. finalize processing/ → done/|failed/ │
└──────────────────────────────────────────────────────┘
│
▼
GitHub draft PR (or answer written in-place for Q&A)

```

**Plan-lint** runs before the agent starts. Bad tickets (invalid frontmatter, forbidden patterns, nonexistent labels) route directly to `failed/` without consuming any agent tokens.

**Loop guards** (supervisor) watch the agent turn-by-turn. On a guard trip, the supervisor sends a recovery nudge; if the agent trips the same guard again within the escalation window, it kills the session.

**Critic** compares the final diff to the ticket spec. If it flags missing items and retries remain, Junco dispatches one corrective agent turn before pushing.

### Reliability

- **Transient failures retry themselves.** When a run fails for infrastructure reasons (connection/5xx errors, truncated stream, or anything else that doesn't classify more specifically — see below) with no commits made, the ticket goes back to the inbox with `retry_count` bumped and a `not_before` backoff stamp — up to `worker.maxTransientRetries` (default 2). Real failures (plan-lint, verification, guard kills) still fail immediately.
- **Auth/quota/rate-limit/model-not-found failures don't spend that budget.** These are classified as the provider's fault, not the ticket's: the ticket is requeued with a fresh `not_before` but `retry_count` is left untouched, and the [provider gate](operations.md#provider-gate) pauses claiming (across the whole daemon, not just this ticket) until an operator fixes it — cleared by a successful session, a config hot-reload apply, or a daemon restart. A rate-limit failure instead backs off and retries on its own once its window elapses; an outage backs off the same way but keeps consuming the retry budget above.
- **The worker doesn't burn tickets while your endpoint is down.** Endpoint readiness is probed before every claim, and the provider gate above independently pauses claiming on a classified infrastructure failure — either way, work stays queued instead of failing.
- **Crashes requeue, not fail.** Tickets found in `processing/` at startup rejoin the inbox under the same retry budget; only an exhausted budget routes to `failed/`.
- **Timeouts salvage work.** A session that hits its timeout after committing gets its commits pushed and a draft PR opened (status `timeout_partial`, routed to `done/`) with a partial-run banner, instead of losing the work in a dead worktree.
- **Ctrl-C twice force-stops.** First signal: finish the in-flight ticket, then exit. Second: abort the agent session and salvage its commits. Third: hard exit. Rendered service files set matching stop timeouts so launchd/systemd don't SIGKILL a draining worker.
