# Tickets

The ticket format — flavors, frontmatter, examples, submission — and the pipeline a ticket rides from inbox to pull request.

[← back to the README](../README.md)

A ticket is a Markdown file with YAML frontmatter and a plan body. Run `junco schema` to print the full typed JSON Schema for every frontmatter field.

## Ticket flavors

| Flavor                | Trigger                                             | What happens                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q&A ticket**        | No `repo:` field                                    | Agent answers in-place; result written back to the ticket file. No git.                                                                                                                                                                                                      |
| **PR-flow ticket**    | `repo: <absolute/path>`                             | Agent runs in an isolated git worktree; a draft PR is opened on success.                                                                                                                                                                                                     |
| **Assessment ticket** | `assess:` mapping present (checked before `repo:`)  | `npm audit` + a read-only agent audit of the `repo:` target; findings are parked for review — `junco assess file` is the confirm step that actually files them as GitHub issues — instead of opening a PR. → [Vulnerability assessment guide](./assess.md)                   |
| **Analysis ticket**   | `analyze:` mapping present (checked before `repo:`) | A read-only agent investigation of the issue named in `analyze:` against the `repo:` target; the drafted comment is parked for review — `junco analyze post` is the confirm step that actually posts it — instead of opening a PR. → [Analysis comments guide](./analyze.md) |

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

## Submitting tickets

```bash
# From a file:
junco submit ./my-ticket.md --config ~/junco/config.json

# From stdin:
cat my-ticket.md | junco submit - --config ~/junco/config.json

# Print the inbox path:
junco inbox-path --config ~/junco/config.json
```

The bundled `junco-dispatch` skill (for Claude Code) scaffolds well-structured tickets from any Claude session and submits them automatically.

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
