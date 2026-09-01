# Tickets

The ticket format — flavors, frontmatter, examples, submission — and the pipeline a ticket rides from inbox to pull request.

[← back to the README](../README.md)

A ticket is a Markdown file with YAML frontmatter and a plan body. Run `junco schema` to print the full typed JSON Schema for every frontmatter field.

## Ticket flavors

| Flavor                | Trigger                                                     | What happens                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q&A ticket**        | No `repo:` field                                            | Agent answers in-place; result written back to the ticket file. No git.                                                                                                                                                                                                      |
| **PR-flow ticket**    | `repo: <absolute/path>`                                     | Agent runs in an isolated git worktree; a draft PR is opened on success.                                                                                                                                                                                                     |
| **Assessment ticket** | `assess:` mapping present (checked before `repo:`)          | `npm audit` + a read-only agent audit of the `repo:` target; findings are parked for review — `junco assess file` is the confirm step that actually files them as GitHub issues — instead of opening a PR. → [Vulnerability assessment guide](./assess.md)                   |
| **Analysis ticket**   | `analyze:` mapping present (checked before `repo:`)         | A read-only agent investigation of the issue named in `analyze:` against the `repo:` target; the drafted comment is parked for review — `junco analyze post` is the confirm step that actually posts it — instead of opening a PR. → [Analysis comments guide](./analyze.md) |
| **Apply ticket**      | Body carries a `junco-patch` fence (`repo:` still required) | Same PR flow as a PR-flow ticket, but `git am --3way` applies a pre-built patch series directly instead of running an agent. → [Apply tickets](#apply-tickets)                                                                                                               |

## Key frontmatter fields

| Field             | Type                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | string              | Unique ticket identifier. Used as the inbox filename and branch suffix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `repo`            | path                | Absolute path to the target git repository. Presence triggers PR flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `priority`        | `low\|normal\|high` | Processing order within the queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `timeout_minutes` | number              | Per-ticket wall-clock cap. Overrides `worker.defaultTimeoutMinutes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `base_branch`     | string              | Branch to fork from. Overrides `git.defaultBaseBranch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `branch_name`     | string              | Override the auto-generated branch name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pr_title`        | string              | Pull request title.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `draft`           | bool                | Open PR as draft. Overrides `pr.draftByDefault`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `labels`          | string[]            | Labels to apply to the PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `reviewers`       | string[]            | GitHub handles to request as reviewers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `amends_pr`       | number              | PR number — add commits to an existing PR instead of opening a new one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `push_remote`     | string              | Git remote the PR flow pushes the feature branch to. Defaults to `origin`. Set to `fork` (with a `fork` remote on the clone) for fork-based PRs against a repo you can't push to; the PR is then opened with `--head <fork-owner>:<branch>`. Worker-managed in fork-PR mode — see [GitHub mode](./github-mode.md#external-repos-fork-pr-mode).                                                                                                                                                                                                  |
| `tools`           | string[]            | Per-ticket tool allowlist override. Q&A tickets default to a read-only subset (`read, grep, find, ls`); list tools explicitly (e.g. `[read, grep, bash]`) to opt in to more.                                                                                                                                                                                                                                                                                                                                                                    |
| `not_before`      | ISO datetime        | Don't claim this ticket before this UTC instant. Set by the worker for retry backoff; dispatchers may also set it to schedule work.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `retry_count`     | integer             | Worker-managed transparent-retry counter. Don't set by hand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `depends_on`      | string[]            | Ticket ids that must be satisfied before this ticket is claimed: each referenced ticket finished successfully AND (when it opened a pull request) that PR was merged. Unsatisfied edges leave the ticket queued; a terminally failed dependency parks this ticket in failed/ (dependency cascade).                                                                                                                                                                                                                                              |
| `deps_satisfied`  | string[]            | Worker-managed: `depends_on` entries the dependency sweep has confirmed satisfied. Don't set by hand.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `plan`            | mapping             | Optional plan-set membership/provenance: ties this ticket to an approved plan. `{ id: string, task: string, hash: string }` — `hash` is worker-managed (content hash of the approved plan).                                                                                                                                                                                                                                                                                                                                                     |
| `assess`          | mapping             | Selects the assessment flavor (see above). `{ auto_plan: bool, issue: number, issue_title: string }` — `issue`/`issue_title` are present only when scoped via `junco assess owner/repo#N`, and steer the audit and filed findings' `Context:` line. Machine-composed by `junco assess` — don't set by hand. → [Vulnerability assessment guide](./assess.md)                                                                                                                                                                                     |
| `analyze`         | mapping             | Selects the analysis flavor (see above). `{ issue: number, title: string }`. Machine-composed by `junco analyze` — don't set by hand. → [Analysis comments guide](./analyze.md)                                                                                                                                                                                                                                                                                                                                                                 |
| `github_request`  | mapping             | Dispatcher-settable. `{ create_issue: true }` asks the worker to create a GitHub tracking issue for this ticket at claim time — on the clone's origin repo, under the worker's own gh identity (the bot account when configured) — and stamp the `github:` provenance block itself, so the resulting PR closes the issue on merge. Best-effort: if creation fails (offline, no permission, non-GitHub origin) the ticket still runs, unlinked. Ignored on fork-push (`push_remote: fork`), amend (`amends_pr`), and Q&A/assess/analyze tickets. |

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

- **No agent session runs.** The PR flow's Phase 4 (see `ARCHITECTURE.md`) branches on the fence's presence: an apply ticket skips straight to `git am --3way` instead of driving the coding agent.
- **Verification still gates the PR.** The ticket's own `## Verification` block runs exactly as it would for an agent-authored ticket, and a failing block still fails the PR the same way.
- **The critic is skipped.** Comparing the landed diff against the spec is tautological when the diff _is_ the spec, so apply mode skips that pass — the outcome records the skip as `apply mode — the patch series is the spec` rather than a PASS/MISSING verdict.
- **A conflict fails the ticket — it is never requeued.** A `git am --3way` conflict is deterministic: rerunning the identical series against the identical base fails the same way, so it is routed straight to `failed/` rather than through the transient-failure/requeue path. The `git am` output is folded into the failure note, `git am --abort` has already run, and the worktree is preserved (not pruned) so you can inspect it in a clean, un-wedged state.
- **Leftovers are never swept.** Even with `commit_leftovers` enabled, a worktree left dirty after `git am` fails loud instead of being folded into an extra commit the series itself never authored — `git am` applies and commits in one step, so anything left uncommitted afterward means something is wrong.

### Authoring rule: fence length

Wrap the series in a fence strictly longer than any backtick run that appears inside it. A plain patch (no fenced content in the diff) needs only the usual three backticks; a patch that itself adds or edits a fenced code block in a markdown file — one that already uses three backticks — needs a four-backtick outer fence instead, since extraction only recognizes a `junco-patch` block whose closing fence is at least as long as its opener.

### Two limitations

- **Authorship.** `git am` takes the commit author from the mbox `From:` header, so applied commits are authored by whoever generated the patch series — Junco is only the _committer_. There's no way to make applied commits read as authored by Junco/the bot short of rewriting the `From:` headers before submitting.
- **No transcript.** An apply ticket runs no agent session, so `junco transcript <id>` and the dashboard's transcript view have nothing to show for it. Auditability for an apply ticket comes from `worker.log`, the ticket's done/failed record, and the PR's diff itself — not a transcript.

### Lint rules

`junco lint` and `junco submit --dry-run` validate a `junco-patch` body the same way they validate any other ticket:

| Rule                     | Severity | Checks                                                                                                                                 |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `patch_parses`           | error    | The fence is a well-formed `git format-patch` series — an mbox `From <sha> …` header and at least one `diff --git` hunk, under 512 KB. |
| `patch_paths_sane`       | error    | The series doesn't touch paths outside the repo (absolute paths, `..` traversal) and carries no binary hunk.                           |
| `patch_has_verification` | warning  | The ticket still has a `## Verification` block — it's the only execution-time check apply mode has.                                    |

The prose rules (`steps_have_commits`, `files_table_referenced`, `files_paths_exist`, `no_cd_in_steps`) are skipped for apply tickets — a patch series has no Steps or Files table for them to check.

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

## Submitting tickets

```bash
# From a file:
junco submit ./my-ticket.md

# From stdin:
cat my-ticket.md | junco submit -

# Print the inbox path:
junco inbox-path
```

The bundled `junco-dispatch` skill teaches coding agents (Claude Code and other
skills-capable harnesses) to scaffold well-structured tickets and submit them. Link it
into your harness once with `junco skill install --harness <name|path>`; the daemon
re-checks and self-heals the links at every start.

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
