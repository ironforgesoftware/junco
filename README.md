# junco

**Turn Markdown tickets into pull requests — automatically.**

Junco is a task-queue worker that turns Markdown "tickets" into git pull requests. Drop a ticket (a plan with YAML frontmatter) into an inbox directory; the daemon claims it, runs it in an isolated git worktree by driving a coding agent, applies loop guards and verification, runs a diff-vs-spec critic, then opens a draft PR. A ticket without a `repo:` field is a **Q&A ticket** — the agent answers in-place, no git involved. Any tool or human can author and submit tickets; Junco is harness-agnostic on the dispatch side.

The embedded agent talks to any **OpenAI-compatible `/v1` inference endpoint** — point it at a local server, a hosted API, or any compatible provider.

---

## Get started in 60 seconds

Requires **Node ≥ 22.19** (plus `git` + an authenticated `gh` for PR-flow tickets).

**1. Run the setup wizard** — it asks a few questions, **detects the models on your endpoint**, writes `config.toml`, and creates the queue:

```bash
npx @ironforgesoftware/junco        # first run → setup wizard; afterwards → starts the daemon
# prefer a global install?  npm install -g @ironforgesoftware/junco   (then the command is just `junco`)
```

(Or explicitly: `junco init` runs the same wizard; `junco init --yes` scaffolds defaults non-interactively.)

**2. Start the worker:**

```bash
junco start          # polls the inbox; Ctrl-C to stop  (a bare `junco` also starts it once configured)
```

**3. Give it work** — a ticket is a Markdown file. With a `repo:` field junco opens a draft PR; without one it answers in place:

```bash
junco submit my-task.md
```

**4. Watch it:** `curl localhost:8787/health`, or check `~/Junco/done/` and `failed/`.

New to the ticket format? Run `junco schema`, copy a template from `examples/`, or let the bundled **`junco-dispatch`** skill scaffold a well-formed ticket. The sections below explain each step in depth.

---

## Table of Contents

0. [Get started in 60 seconds](#get-started-in-60-seconds)
1. [Quickstart](#quickstart)
2. [How it works](#how-it-works)
3. [CLI reference](#cli-reference)
4. [Configuration](#configuration)
5. [Tickets](#tickets)
6. [GitHub-integrated mode](#github-integrated-mode)
7. [Health & observability](#health--observability)
8. [Running as a service](#running-as-a-service)
9. [Security model](#security-model)
10. [Troubleshooting](#troubleshooting)
11. [Contributing](#contributing)
12. [License](#license)

---

## Quickstart

**Prerequisites:** Node ≥ 22.19. For PR-flow tickets: `git` + the GitHub CLI `gh` (run `gh auth login` once). Q&A tickets need neither.

### 1. Install

```bash
npm install -g @ironforgesoftware/junco
# or run without installing:
npx @ironforgesoftware/junco <command>
# (either way, the installed command is just `junco`)
```

### 2. Set up (interactive wizard)

```bash
junco init --config ~/junco/config.toml
```

The wizard asks where to keep your tickets and which model to use — **letting you pick from the models your endpoint advertises** (an OpenAI-compatible endpoint, or a Pi `models.json`) — **writes `config.toml`**, and creates the queue directories at `<vault_root>/{inbox,processing,done,failed}` (default `~/Junco/…`) plus the worktree root. Add `--yes` to scaffold defaults non-interactively. A bare `junco` (or `npx @ironforgesoftware/junco`) runs this same wizard on first run.

<details><summary>Prefer to write the config by hand?</summary>

Create `config.toml` with at least:

```toml
vault_root = "~/my-junco-vault"
[model]
id = "myprovider/my-model"             # provider-prefixed model id
base_url = "http://127.0.0.1:1234/v1"  # your OpenAI-compatible endpoint
api_key = "your-api-key"
# (or set: models_json = "~/.pi/agent/models.json" to load the model from there)
```

Then run `junco init` — with a config already present it just creates the queue dirs (it never overwrites your config). See [Configuration](#configuration) for every key, or copy `examples/config.toml`.

</details>

### 3. Start the daemon

```bash
junco start --config ~/junco/config.toml
```

The daemon polls the inbox every 15 seconds. It acquires a lock (`worker.lock` next to `config.toml`) so only one instance runs at a time.

### 4. Submit your first ticket

**Q&A ticket** (no git, just an answer written back to the file):

```bash
cat > /tmp/my-question.md << 'EOF'
---
id: my-first-qa-2026-05-31
priority: normal
timeout_minutes: 10
---

# What is the Big O complexity of merge sort?

Explain with a short example.
EOF

junco submit /tmp/my-question.md --config ~/junco/config.toml
```

**PR-flow ticket** (creates a worktree, runs the agent, opens a draft PR):

````bash
cat > /tmp/my-pr-ticket.md << 'EOF'
---
id: add-hello-util-2026-05-31
priority: normal
timeout_minutes: 30
repo: /absolute/path/to/your-repo
base_branch: main
pr_title: Add hello utility function
draft: true
---

# Add a hello() utility

## Steps
- [ ] Create `src/hello.ts` exporting a `hello(name: string): string` function.
- [ ] Commit: `git add src/hello.ts && git commit -m "feat: add hello utility"`

## Verification

```bash
npx tsc --noEmit
````

## Done when

- [ ] 1 commit on the branch with the new file.
      EOF

junco submit /tmp/my-pr-ticket.md --config ~/junco/config.toml

```

Watch the daemon pick it up and open a draft PR automatically.

---

## How it works

```

You (or any harness)
│
│ junco submit <ticket.md>
▼
<vault_root>/Junco/inbox/ ← drop tickets here
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

````

**Plan-lint** runs before the agent starts. Bad tickets (invalid frontmatter, forbidden patterns, nonexistent labels) route directly to `failed/` without consuming any agent tokens.

**Loop guards** (supervisor) watch the agent turn-by-turn. On a guard trip, the supervisor sends a recovery nudge; if the agent trips the same guard again within the escalation window, it kills the session.

**Critic** compares the final diff to the ticket spec. If it flags missing items and retries remain, Junco dispatches one corrective agent turn before pushing.

### Reliability

- **Transient failures retry themselves.** When a run fails for infrastructure reasons (endpoint error, truncated stream) with no commits made, the ticket goes back to the inbox with `retry_count` bumped and a `not_before` backoff stamp — up to `[worker].max_transient_retries` (default 2). Real failures (plan-lint, verification, guard kills) still fail immediately.
- **The worker doesn't burn tickets while your endpoint is down.** Readiness is probed before every claim; work stays queued until the endpoint answers.
- **Crashes requeue, not fail.** Tickets found in `processing/` at startup rejoin the inbox under the same retry budget; only an exhausted budget routes to `failed/`.
- **Timeouts salvage work.** A session that hits its timeout after committing gets its commits pushed and a draft PR opened (status `timeout_partial`, routed to `done/`) with a partial-run banner, instead of losing the work in a dead worktree.
- **Ctrl-C twice force-stops.** First signal: finish the in-flight ticket, then exit. Second: abort the agent session and salvage its commits. Third: hard exit. Rendered service files set matching stop timeouts so launchd/systemd don't SIGKILL a draining worker.

---

## CLI reference

All commands accept `--config <path>` to point at a non-default `config.toml`. When omitted, junco uses `./config.toml` if present, else the user-level default `~/.config/junco/config.toml` (respects `XDG_CONFIG_HOME`) — so junco works from any directory after first-run setup.

| Command | Description |
|---|---|
| `junco start [--config <path>] [--once]` | Run the daemon. Polls forever; `--once` processes one task then exits. Acquires a single-instance lock (`worker.lock` next to `config.toml`); exits 0 if another instance holds the lock. |
| `junco run-once [--config <path>]` | One-shot: process a single available task and exit. No lock — convenient for dev or cron. |
| `junco submit <file\|-> [--config <path>]` | Atomically place a ticket into the configured inbox. Use `-` to read from stdin. The inbox filename is derived from the ticket's `id` frontmatter field. |
| `junco inbox-path [--config <path>]` | Print the resolved inbox directory path. |
| `junco schema` | Print the ticket-frontmatter JSON Schema (the typed contract for all frontmatter fields). |
| `junco init [--config <path>] [--yes]` | Interactive setup wizard: prompts for vault + model, **writes `config.toml`**, and creates the queue directories. With a config already present, just creates the dirs (never overwrites). `--yes` scaffolds defaults non-interactively. |
| `junco` (no subcommand) | First run (no config yet) → the setup wizard; otherwise → `start`. |
| `junco service [--platform launchd\|systemd] [--config <path>]` | Render a service file to stdout. Defaults to `launchd` on macOS, `systemd` elsewhere. |
| `junco status` | One-glance view: daemon (pid/uptime), endpoint readiness, in-flight tickets, processed counts, queue sizes. |
| `junco list [box]` | Newest-first ticket listing per queue box (`inbox\|processing\|done\|failed`), with terminal statuses. |
| `junco retry <name…\|--all>` | Move failed tickets back to the inbox for a fresh run — claim stamp, appended result blocks, and retry bookkeeping stripped. |
| `junco doctor` | Preflight: config parses, node/git/gh present, `gh` authenticated, endpoint reachable, model advertised, queue/worktree/state dirs writable. |
| `junco dashboard` | Interactive terminal UI for GitHub-integrated mode: watch repos, review plans, dispatch/approve/re-plan issues. Needs a real TTY. |
| `junco restart` | Restart the supervised daemon so it picks up config and code changes: finds the launchd/systemd user unit referencing your config, kicks it with the platform-correct verb, verifies the pid changed. |
| `junco logs [-f] [-n N] [--json]` | Tail (or follow) the worker log — human-readable on a TTY, raw JSON when piped or with `--json`. |
| `junco --help` / `-h` | Print usage. |

---

## Configuration

Junco is configured via a TOML file — `./config.toml` if present, else `~/.config/junco/config.toml` (the wizard writes the latter unless you pass `--config`). Below is a fully-annotated reference with defaults.

```toml
# ── Vault ────────────────────────────────────────────────────────────────────
vault_root = "~/junco-vault"      # REQUIRED. Queue lives at <vault_root>/<junco_subdir>/
junco_subdir = "Junco"            # Subfolder name inside vault_root. Default: "Junco"

# ── Agent ────────────────────────────────────────────────────────────────────
[pi]
extra_args = [                    # Optional extra CLI args passed to the agent.
  "--tools", "bash,read,write,edit,grep,find"
]
commit_leftovers = false          # false (default) = agent must commit its own work; fail-loud if not.

# ── Model + inference provider ───────────────────────────────────────────────
# Two ways to configure the model. EITHER point at a Pi-style models.json:
[model]
id = "<provider>/<model>"         # REQUIRED. Provider-prefixed (provider = text before the first "/").
models_json = "~/.pi/agent/models.json"   # Optional. If set + present, the provider+model (api, compat,
                                  # context_window, thinking_format, …) are loaded from this file.
# … OR describe it inline (used when models_json is unset/missing). The fields
# below default to the values shown — override only what your model needs:
api = "openai-completions"        # openai-completions | anthropic-messages | google-generative-ai | bedrock-converse-stream | …
base_url = "http://127.0.0.1:1234/v1"  # Any OpenAI-compatible /v1 base URL.
api_key = "1234"
reasoning = true                  # Model supports extended thinking.
input = ["text", "image"]         # Modalities the model accepts.
context_window = 131072
max_tokens = 49152
thinking_level = "medium"         # off | minimal | low | medium | high | xhigh
[model.compat]                     # Provider quirks (snake_case here; camelCased internally).
max_tokens_field = "max_tokens"   # Some servers reject the auto-detected "max_completion_tokens".
thinking_format = "qwen-chat-template"
# Back-compat: a legacy [pi].model_id + [oMLX] url/api_key still populate
# [model].id / base_url / api_key when [model] omits them.

# ── Worker ───────────────────────────────────────────────────────────────────
[worker]
default_timeout_minutes = 30      # Per-ticket wall-clock cap (used when the ticket omits timeout_minutes).
poll_interval_seconds = 15        # How often to poll the inbox when idle.
startup_poll_seconds = 30         # Retry cadence while waiting for the endpoint at boot.
startup_wait = true               # Block startup until the inference endpoint is reachable.
max_transient_retries = 2         # Requeue transient failures (endpoint errors, no commits) this many times.
retry_backoff_seconds = 60        # not_before backoff per retry (linear: attempt × backoff).
max_concurrent = 1                # Parallel ticket slots. Same-repo tickets always serialize.

# ── Supervisor (loop guards) ─────────────────────────────────────────────────
[supervisor]
enabled = true
budget_per_kind = 1               # Nudges per guard kind before the session is killed.
escalation_window_turns = 3       # Same guard re-trips within K turns of a nudge → kill.
output_budget_per_turn = 12000    # Token output cap per agent turn.
output_budget_post_commit = 24000 # Token output cap in post-commit turns.

# ── Git ──────────────────────────────────────────────────────────────────────
[git]
git_bin = "git"
gh_bin = "gh"
default_base_branch = "main"
branch_prefix = "junco/"          # PR branches are named <branch_prefix><ticket-id>.
worktree_root = "~/junco/worktrees"
remove_worktree_on_success = true # Clean up worktrees after a successful PR. Default: true.
allowed_repo_roots = []           # Confine PR-flow tickets to these roots ([] = any path). See Security model.

# ── Pull requests ─────────────────────────────────────────────────────────────
[pr]
draft_by_default = true           # Open PRs as drafts. Default: true.
default_labels = []               # Labels added to every PR (in addition to per-ticket labels).

# ── Verification ─────────────────────────────────────────────────────────────
[verify]
enabled = true
command_timeout = 60              # Seconds per bash command in the ## Verification block.
block_on_fail = false             # true = a failing verification blocks the PR; ticket goes to failed/.

# ── Critic ───────────────────────────────────────────────────────────────────
[critic]
enabled = true
max_retries = 1                   # One corrective re-dispatch when the critic flags missing items.
thinking = "minimal"

# ── Plan lint ────────────────────────────────────────────────────────────────
[plan_lint]
enabled = true
block_on_error = true             # Lint failures route the ticket to failed/ before the agent runs.
check_labels = true               # Validate that frontmatter labels exist on the target repo (via gh).

# ── Observability ─────────────────────────────────────────────────────────────
[observability]
health_enabled = true
health_host = "127.0.0.1"         # Loopback by default — not network-exposed unless you change this.
health_port = 8787
log_level = "info"                # debug | info | warn | error
state_dir = "~/.local/state/junco" # worker.log + transcripts/ live here.
log_to_file = true                # Tee structured logs to <state_dir>/worker.log (10 MB rotation).
transcripts = true                # Per-ticket event JSONL under <state_dir>/transcripts/.
````

### Key knobs to know

| Knob                               | Effect                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `[model].id`                       | Which model the agent requests (provider-prefixed, e.g. `omlx/my-model`).                                                  |
| `[model].models_json`              | Point at a Pi `models.json` to load the provider+model (api, compat, context window…) from that file.                      |
| `[model].base_url` / `api`         | Switch inference backends — any OpenAI-compatible `/v1` endpoint, or another Pi `api` style (Anthropic, Google, Bedrock…). |
| `[verify].block_on_fail`           | Set `true` to make verification failures block the PR open (strict mode).                                                  |
| `[supervisor].budget_per_kind`     | Raise to allow more nudges before killing a looping agent.                                                                 |
| `[worker].startup_wait`            | Set `false` to start the daemon even when the endpoint is not yet up.                                                      |
| `[git].remove_worktree_on_success` | Set `false` to retain worktrees after success (debugging).                                                                 |

---

## Tickets

A ticket is a Markdown file with YAML frontmatter and a plan body. Run `junco schema` to print the full typed JSON Schema for every frontmatter field.

### Ticket flavors

| Flavor             | Trigger                 | What happens                                                             |
| ------------------ | ----------------------- | ------------------------------------------------------------------------ |
| **Q&A ticket**     | No `repo:` field        | Agent answers in-place; result written back to the ticket file. No git.  |
| **PR-flow ticket** | `repo: <absolute/path>` | Agent runs in an isolated git worktree; a draft PR is opened on success. |

### Key frontmatter fields

| Field             | Type                | Description                                                                                                                                                                  |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | string              | Unique ticket identifier. Used as the inbox filename and branch suffix.                                                                                                      |
| `repo`            | path                | Absolute path to the target git repository. Presence triggers PR flow.                                                                                                       |
| `priority`        | `low\|normal\|high` | Processing order within the queue.                                                                                                                                           |
| `timeout_minutes` | number              | Per-ticket wall-clock cap. Overrides `[worker].default_timeout_minutes`.                                                                                                     |
| `base_branch`     | string              | Branch to fork from. Overrides `[git].default_base_branch`.                                                                                                                  |
| `branch_name`     | string              | Override the auto-generated branch name.                                                                                                                                     |
| `pr_title`        | string              | Pull request title.                                                                                                                                                          |
| `draft`           | bool                | Open PR as draft. Overrides `[pr].draft_by_default`.                                                                                                                         |
| `labels`          | string[]            | Labels to apply to the PR.                                                                                                                                                   |
| `reviewers`       | string[]            | GitHub handles to request as reviewers.                                                                                                                                      |
| `amends_pr`       | number              | PR number — add commits to an existing PR instead of opening a new one.                                                                                                      |
| `tools`           | string[]            | Per-ticket tool allowlist override. Q&A tickets default to a read-only subset (`read, grep, find, ls`); list tools explicitly (e.g. `[read, grep, bash]`) to opt in to more. |
| `not_before`      | ISO datetime        | Don't claim this ticket before this UTC instant. Set by the worker for retry backoff; dispatchers may also set it to schedule work.                                          |
| `retry_count`     | integer             | Worker-managed transparent-retry counter. Don't set by hand.                                                                                                                 |

### Minimal Q&A ticket

```markdown
---
id: my-qa-2026-05-31
priority: normal
timeout_minutes: 10
---

# My question

What is the time complexity of binary search and why?
```

### Minimal PR-flow ticket

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
````

## Done when

- [ ] 1 commit on the branch.

````

### Submitting tickets

```bash
# From a file:
junco submit ./my-ticket.md --config ~/junco/config.toml

# From stdin:
cat my-ticket.md | junco submit - --config ~/junco/config.toml

# Print the inbox path:
junco inbox-path --config ~/junco/config.toml
````

The bundled `junco-dispatch` skill (for Claude Code) scaffolds well-structured tickets from any Claude session and submits them automatically.

### Templates

Ticket templates live in the `templates/` directory:

- `templates/plain/task.md` — Q&A ticket template (plain Markdown)
- `templates/plain/task-code.md` — PR-flow ticket template (plain Markdown)
- `templates/task.md`, `templates/task-code.md` — the same templates with [Obsidian Templater](https://github.com/SilentVoid13/Templater) date/title placeholders, for Obsidian-vault dispatch setups

> `junco retry` note: a retried ticket is cut at the first appended `<!-- junco-result` separator, so a ticket BODY containing that literal line would lose its tail on retry.

### PR-flow lifecycle

1. Ticket lands in `inbox/` — plan-lint validates frontmatter first (bad tickets → `failed/`, no agent run).
2. Daemon claims it atomically into `processing/`.
3. Git worktree provisioned from `origin/<base_branch>` at `<worktree_root>/<id>`.
4. Agent runs with loop guards active (supervisor watches each turn; nudges on guard trips, kills on escalation).
5. After the agent session: the `## Verification` block runs in the worktree.
6. Critic compares the diff to the spec; if items are missing and retries remain, one corrective agent turn is dispatched.
7. Branch pushed; `gh pr create --draft` opens the PR.
8. Ticket moves to `done/` (success) or `failed/` (any failure). Worktree removed on success if `remove_worktree_on_success = true`.

---

## GitHub-integrated mode

Junco can use **GitHub Issues as a dispatch surface**: label an issue and the daemon drafts an execution plan, posts it for review, and — once approved — works it in a worktree, opens a PR, and reports back on the issue thread. Junco never executes a raw issue directly; it always plans first. The local inbox keeps working exactly as before — both surfaces feed the same queue, and with `enabled = false` (the default) Junco makes zero GitHub calls.

```toml
[github]
enabled = true
trigger_label = "junco"        # the approval marker
poll_interval_seconds = 60     # bridge sweep cadence
require_approval = true        # a write+ collaborator must apply junco:approved before a plan executes
# planner_model_id = "provider/small-model"   # optional: plan with a different model than execution

[[github.repos]]
nwo  = "owner/repo"            # repo to watch
path = "~/code/repo"           # its local clone (origin must point at nwo)
```

**The two-hop loop.** Every sweep, Junco lists open issues carrying the trigger label in each watched repo.

1. **Dispatch → plan.** An eligible issue (trigger label present, no lifecycle label yet) is verified — **who applied the label, and do they have write access?** — then turned into a _planning_ ticket: a read-only, Q&A-style session at the mapped clone that explores the repo and drafts a plan using the same authoring discipline as the `junco-dispatch` skill (single-sourced from `skills/junco-dispatch/TEMPLATE.md`; see `planPrompt.ts`). Set `planner_model_id` to plan with a cheaper/different model than the one that executes. The issue flips to `junco:planning`.
2. **Plan → review.** When planning finishes, Junco posts the plan as **one issue comment** — carrying a hidden `<!-- junco:plan -->` anchor so the bridge can recover it later — and flips the issue to `junco:plan-ready`. The comment is ordinary GitHub markdown: **you can edit it**, and whatever it says at approval time is what executes.
3. **Approve → execute.** With `require_approval = true` (the default), a write+ collaborator applies `junco:approved` after reading the plan comment; Junco checks both that a write+ collaborator applied it and that the approval postdates the plan comment (so a stale approval from before a re-plan can't sneak an old plan through). With `require_approval = false`, the plan executes automatically on the next sweep instead — no human gate. Either way, Junco reads the plan back out of the (possibly edited) comment, builds an ordinary execution ticket from it, swaps `junco:plan-ready`/`junco:approved` for `junco:queued`, and the normal pipeline runs from there (atomic claim, worktree, guards, verification, critic, retries) exactly as for a locally-submitted ticket.

When the execution ticket finalizes, Junco posts **one comment** — PR link plus a brief summary, or the failure reason — and flips to `junco:done`/`junco:failed`. The PR body includes `Closes owner/repo#N`, so merging auto-closes the issue.

**Questions skip planning.** Add the ask label (default `junco:ask`) alongside the trigger label and Junco routes straight to the read-only Q&A path (`junco:queued` directly — no plan, no review, no approval) — the session browses the mapped clone with read-only tools and posts its **answer as the comment**. No branch, no PR.

**Lifecycle labels** signal state silently (no notifications) and are visible in the issue list:

| Label              | Meaning                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `junco:planning`   | A planning session is drafting a plan from the raw issue                                                |
| `junco:plan-ready` | Plan posted as a comment — awaiting review (and approval, if `require_approval`)                        |
| `junco:approved`   | Applied by a write+ collaborator after reading the plan; authorizes execution (removed once dispatched) |
| `junco:queued`     | An execution ticket (or Q&A ticket) is in the inbox, waiting for a worker slot                          |
| `junco:working`    | A session is on it right now                                                                            |
| `junco:done`       | Finished — see the closing comment (PR link / answer)                                                   |
| `junco:failed`     | Failed — see the closing comment for the reason (planning or execution)                                 |
| `junco:denied`     | Trigger label was applied by someone without write access                                               |

**Re-plan gestures** (all take effect on the next sweep, no restart needed):

- Remove `junco:plan-ready` (leave the trigger label on) → a fresh planning session runs. If more than one plan comment exists on the issue, the latest one wins.
- Remove `junco:failed` → the issue re-enters at the top: fresh planning, fresh review, fresh approval.
- Edit Junco's own plan comment before it's approved → your edit is what executes, not the model's original draft.

**Trust model.** Issue text is untrusted input until someone with write/maintain/admin permission applies the trigger label — and by labeling, they vouch for the body _as it stands_, so **read the issue before you label it**. From there, the plan hop adds its own guarantees: the planner emits the ticket **body only**, inside a fenced block — frontmatter (`repo:`/`workdir:`/`tools:`) is always built by the bridge itself, never by model output or issue text; a plan comment only counts as authoritative if it was posted by the bridge's own authenticated `gh` login (a forged marker comment from another contributor can't smuggle in a plan); and an approval only counts if it comes from a write+ collaborator **and** postdates the plan comment it's approving. Junco fails closed on any verification error, only ever executes against clone paths from _your config_ (issue content cannot steer it elsewhere), and cross-checks that each mapped clone's `origin` matches the configured repo so a typo can't ship commits to the wrong place. `require_approval = false` removes the human approval gate entirely — reasonable for a private personal repo where you already trust everyone who can apply the trigger label, but keep the default `true` anywhere else. Note too that with `require_approval = false`, anyone who can apply labels — including a triage-only collaborator, whose label edits are _not_ permission-verified on the plan hop — can re-apply `junco:plan-ready` to replay an existing plan comment straight into execution; one more reason auto mode belongs only on a private personal repo.

**Team workflow.** Planning is automatic now, so hand-drafting the task issue is optional rather than required: label a raw bug report and Junco drafts the plan itself, posts it for review, and you approve or edit before anything runs. If a report issue already has a task sub-issue with a concrete plan, label the sub-issue instead — Junco automatically appends the parent issue's title and body as background context for the planner, and closing the sub-issue rolls up into the parent's progress. Either way, nothing executes until a human has seen a concrete plan (or you've deliberately opted out via `require_approval = false`).

**Operational notes.** `junco doctor` checks each repo mapping (clone exists, origin matches, repo reachable via `gh`) and that the planner template (`skills/junco-dispatch/TEMPLATE.md`) is readable — that check fails preflight rather than warns, since an unreadable template fails every planning ticket. `junco status` and `/health` report sweep counts. Polling cost is a small, fixed number of API calls per repo per sweep against a 5,000/hr authenticated limit — still negligible. Auth is whatever `gh auth login` already holds; there are no new secrets. If GitHub is unreachable, sweeps skip and the local queue keeps running, and most lost label flips or comments are cosmetic (the queue files and the PR are the source of truth) — with one exception. On the **plan hop**, if the `junco:planning → junco:plan-ready` flip is lost _after_ the plan comment has already posted, the issue strands in `junco:planning` and won't advance to review on its own (the bridge won't re-plan an issue that still carries `junco:planning`). Recover by hand: apply `junco:plan-ready` yourself (the plan comment is already on the thread), or remove `junco:planning` to re-plan from scratch.

### Offline / flaky network

**When GitHub is unreachable** (network errors after retry backoff), Junco queues label operations, issue comments, and the PR push+create sequence as durable ops under `<state_dir>/github-outbox/` — one JSON file per operation. These ops are **stored durably**: if the daemon crashes, they survive the restart and are flushed automatically on the next bridge sweep once GitHub comes back online. Operations are **replayed in FIFO order** to preserve per-issue semantics, are **idempotent** (a crash mid-flush will not double-post comments or duplicate labels), and are **fault-tolerant**: a non-network error on a single op (e.g., you deleted a label) bumps its attempt count and dead-letters it after 3 attempts to `github-outbox/dead/`. The ticket itself still **finalizes done/failed** locally (the worker never blocks on GitHub connectivity), so the queue keeps moving — the outbox is for durability, not gating.

**What gets queued:** lifecycle label flips (onStart, onRequeue, onFinal), final comments (PR link + summary | answer | failure reason), and the entire PR push+create sequence (including comment + labels for PR-finalize tickets). Fresh PR operations checkpoint state: if the push succeeds but PR creation fails, the replay skips the push and goes straight to create (no redundant pushes on retry).

**Manual push:** list what's queued with `junco outbox` (shows operation type, target issue/branch, age, attempt count); flush immediately with `junco outbox flush` instead of waiting for the next auto sweep. Both commands work even if the daemon is down.

**Dashboard visibility:**

- **Chip:** the dashboard header shows `⇡N unpushed` when there are queued ops (hidden at N=0). To flush from inside the dashboard, open the `:` command palette and run `outbox` with args `flush` — or run `junco outbox flush` from any shell.
- **Issue list:** when the issue list is served from cache (GitHub was offline during fetch), an `offline · HH:MM` badge in the issue pane's title row shows the cached-at timestamp, so you know the list is stale.
- **PR offline:** an offline PR-flow ticket still finalizes with its earned terminal status (e.g. `completed`) — the work is done locally. The ticket file's Result section gains the line "PR queued for offline push — junco will open it automatically when GitHub is reachable.", and no issue comment posts at finalize time; when the outbox flushes, the comment that lands reads `Opened <pr-url>` plus the agent's summary. When the branch was built from a possibly-stale base (the base couldn't be fetched while offline), the PR body gains a warning: `⚠️ Built offline from a possibly stale base — rebase check recommended.`

**Dead-letter and recovery:** when an op has failed 3 times, it moves to `github-outbox/dead/` to prevent infinite retry. `junco doctor` warns if dead-lettered ops exist; list them with `junco outbox` (shown as `dead: N`). To retry a dead-lettered op, edit it by hand, move it back to `<state_dir>/github-outbox/`, and run `junco outbox flush`.

**Trust model:** queued ops replay under your own `gh` auth — the same authentication as the live path. Approval verification happens live at sweep time (a plan-ready issue's approval label is checked before an execution ticket is created): queuing changes _when_ a label lands, not _how_ it is verified.

### Dashboard

The dashboard runs fullscreen in the terminal's alternate buffer (like vim or htop): it uses your whole window, adapts its layout to the terminal size (a side-by-side preview pane appears at ≥110 columns), and restores your terminal exactly on exit. It is an interactive terminal UI over the same GitHub-integrated mode described above — a faster loop than watching labels change on the web. Run it from a real TTY, not piped or backgrounded:

```bash
junco dashboard
```

Above the panes, the header's right side is a live pulse of the daemon: issues awaiting review (`●N review`), the processed record (`✓succeeded ✗failed`), the most recent task's outcome and age (`last ✓/✗ <age>`), cumulative output tokens (`tok <compact>`), daemon up/down with uptime, the local queue (`◐running ⏳waiting`), and unpushed GitHub outbox ops (`⇡N unpushed`) — every chip but daemon status is hidden when its count is zero or the daemon is down. Below 110 columns the header keeps only the essentials (review, daemon, queue, unpushed); the full record lives in `junco status`.

The screen has three zones:

- **Repos pane** (left, pane 1) — every watched repo, with a per-state issue-count badge (plan-ready / working / failed) and a `(cfg)` marker on entries that came from `config.toml` rather than the watchlist. The queue card lives here at the top, showing running/waiting work at a glance; press `t` to see the full queue view.
- **Issues pane** (middle, pane 2) — the selected repo's trigger-labeled issues, newest-relevant first, each showing a lifecycle glyph and its current state badge (planning / plan-ready / approved / queued / working / done / failed / denied).
- **Preview pane** (right, pane 3, wide terminals only at ≥110 columns) — the selected issue's full body and posted plan comment, auto-loaded as you move through the list.

A persistent shortcut bar at the bottom of the screen shows the keys relevant to wherever you are (repos pane, issues pane, detail, palette, …); press `?` for the full key reference. Keys:

| Key              | Action                                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1` / `2` / `3`  | jump to pane (1=repos, 2=issues, 3=preview; pane 3 only in wide mode)                                                                                                                                                                                                        |
| `↑` / `↓` (or `j` / `k`) | move selection (repo or issue, depending on the focused pane)                                                                                                                                                                                                        |
| `←` / `→` (or `h` / `l`, `tab`) | switch panes (repos ↔ issues ↔ preview)                                                                                                                                                                                                                       |
| `g` / `G`        | jump to first / last (repos or issues)                                                                                                                                                                                                                                       |
| `/`              | filter issues (type to narrow, `enter` applies, `esc` clears)                                                                                                                                                                                                                |
| `[` / `]`        | scroll (alias of `↑`/`↓` in preview, detail, queue, and command-output views)                                                                                                                                                                                                |
| `w`              | add a repo to the watchlist — paste `owner/repo` or a github.com URL; leave the clone path empty and junco clones it for you into `<state_dir>/repos/<owner>/<repo>`. Validates the clone's origin, confirms reachability via `gh`, and creates the trigger label if missing |
| `i`              | jump to the issues pane (alias of `2`)                                                                                                                                                                                                                                       |
| `enter`          | focus preview pane (wide mode) or open issue detail (narrow mode) — full body plus the posted plan comment, in-terminal, before you decide                                                                                                                                   |
| `d`              | dispatch (adds the trigger label)                                                                                                                                                                                                                                            |
| `D`              | dispatch as ask — read-only Q&A, no plan, no PR                                                                                                                                                                                                                              |
| `a`              | approve the posted plan (only available once a plan is ready)                                                                                                                                                                                                                |
| `R`              | re-plan or re-cycle, whichever applies to the issue's current state                                                                                                                                                                                                          |
| `o`              | open the issue in your browser                                                                                                                                                                                                                                               |
| `x`              | unwatch a repo (watchlist entries only — entries from `config.toml` are read-only in the dashboard and report where they're defined instead)                                                                                                                                 |
| `r`              | refresh the current repo's issues now                                                                                                                                                                                                                                        |
| `t`              | queue view — running / waiting / recent tickets (the queue card in the left rail shows the same at a glance)                                                                                                                                                                 |
| `:`              | command palette — run junco CLI subcommands without leaving the dashboard (see below)                                                                                                                                                                                        |
| `?`              | show/hide the full key list                                                                                                                                                                                                                                                  |
| `q`              | quit                                                                                                                                                                                                                                                                         |

Every action is an ordinary label mutation made through your own `gh` auth — the same trust model as labeling an issue by hand on GitHub. Dispatch/approve/re-plan don't run anything themselves; they just move labels that the daemon's sweep acts on.

**The command palette** (`:`) runs the junco CLI from inside the dashboard: type to filter, `enter` to run (commands that take arguments — `list`, `retry`, `outbox`, `submit`, `logs`, `service` — get an args field first), and the command's real output appears in a scrollable pane with its exit code (`r` re-runs, `esc` returns). Under the hood each run spawns the actual `junco` CLI against the dashboard's own config — no reimplementation, no drift, and no shell in the middle. `logs` runs bounded (`-n 200`); `init`, `start`, and `dashboard` are shown greyed-out with the reason they can't run here (use `restart` for the daemon).

Repos added with `w` (and removed with `x`) live in a small JSON watchlist file at `<state_dir>/github-watchlist.json`, separate from `config.toml`. The daemon's bridge sweep re-reads this file every sweep, so watchlist changes take effect without a restart. Where a repo appears in both, the `config.toml` `[[github.repos]]` entry wins — that's also why config-sourced repos aren't removable from the dashboard.

The **queue card** at the bottom of the left rail shows the daemon's local queue at all times: the running ticket (with live turn progress from the daemon's health endpoint) and how many tickets are waiting. The dashboard header shows `⇡N unpushed` alongside when there are queued GitHub ops waiting to be flushed (see Offline / flaky network). Press `t` for the full queue view — waiting positions match the order the daemon will actually claim (priority first, then filename), deferred tickets show their retry backoff (`not before HH:MM`), and RECENT lists the last few finished tickets. The card covers the _whole_ local queue, including tickets submitted with `junco submit` — not just GitHub-dispatched ones. When the daemon is down the card says so rather than implying queued work will run.

---

## Health & observability

When `[observability].health_enabled = true`, Junco serves HTTP on `health_host:health_port` (default `127.0.0.1:8787`).

| Endpoint      | Success                                    | Use                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /live`   | `200 {status:"alive", pid, uptimeSeconds}` | Liveness — is the process up?                                                                                                                                                                                                                  |
| `GET /ready`  | `200 {status:"ready"}` or `503`            | Readiness — can the endpoint be reached?                                                                                                                                                                                                       |
| `GET /health` | `200 {status:"ok", ready, metrics:{...}}`  | Full metrics: uptime, poll count, in-flight tickets (`currentTickets`), live per-ticket progress (`currentProgress`: turns, last tool, output tokens), tasks processed/succeeded/failed, task counts by status, token totals, duration totals. |

```bash
# Quick checks:
curl http://127.0.0.1:8787/live
curl http://127.0.0.1:8787/ready
curl http://127.0.0.1:8787/health | jq .
```

**Logs** are structured JSON on stdout (colorized human format on a TTY; set `JUNCO_LOG_JSON=1` to force JSON) and are also written to `<state_dir>/worker.log` (default `~/.local/state/junco/worker.log`, rotated at 10 MB). `junco logs -f` follows them. Set `[observability].log_level` to `debug` for verbose output, `info` for normal operation.

**Transcripts:** every agent session appends its event stream (turns, tool calls, results — no token deltas) to `<state_dir>/transcripts/<ticket-id>.jsonl`, the debugging record for failed runs. Disable with `[observability].transcripts = false`.

**Concurrency:** `[worker].max_concurrent` (default 1) runs that many tickets in parallel. Tickets targeting the same `repo:` always serialize, and a graceful stop drains in-flight work.

> The health server binds to loopback (`127.0.0.1`) by default. To expose it on a network interface, change `health_host`. Do so with care — there is no authentication.

---

## Running as a service

`junco service` renders a platform-native service file to stdout. Pipe it to the right location and load it.

### macOS (launchd)

```bash
junco service --platform launchd --config ~/junco/config.toml \
  > ~/Library/LaunchAgents/com.junco.worker.plist

launchctl load ~/Library/LaunchAgents/com.junco.worker.plist
launchctl start com.junco.worker
```

### Linux (systemd)

```bash
junco service --platform systemd --config ~/junco/config.toml \
  > ~/.config/systemd/user/junco.service

systemctl --user daemon-reload
systemctl --user enable --now junco
```

### Lock semantics and supervisor restart loops

`junco start` acquires `worker.lock` (next to `config.toml`). If a second instance starts while the first holds the lock, it **exits 0** — it does not error out. This means your supervisor (launchd, systemd) will not enter a restart loop if you accidentally start Junco twice.

`junco run-once` does **not** acquire the lock — it is safe for cron and dev use alongside a running daemon.

### Restarting after config or code changes

The daemon reads its config and code once at startup. `junco restart` bounces the supervised daemon correctly: it discovers the launchd plist / systemd user unit that references your config path and uses `launchctl kickstart -k` / `systemctl --user restart` — the verbs that relaunch unconditionally. (A plain SIGTERM is _not_ a restart: with launchd's `SuccessfulExit=false` keep-alive, a graceful exit stays down.) It validates the config first — refusing to bounce the daemon onto a config it can't parse — and confirms the new pid before reporting success.

---

## Security model

The inbox is a **code-execution boundary**. Junco runs a coding agent with bash/file tools against whatever ticket lands in `inbox/`, and `## Verification` blocks run as your user — anyone who can write to the inbox can act as you. Keep the inbox on a local disk you own, don't point it at a synced/shared folder others can write to, and set `[git].allowed_repo_roots` to confine PR-flow tickets to approved checkout locations:

```toml
[git]
allowed_repo_roots = ["~/code"]   # [] (default) = any path on disk
```

---

## Troubleshooting

### Inference endpoint unreachable at boot

By default (`[worker].startup_wait = true`) Junco blocks startup and retries every `startup_poll_seconds` (default 30) until the endpoint responds. Check that your inference server is running and that `[model].base_url` points to the correct address.

Set `startup_wait = false` to let Junco start immediately and fail individual tickets if the endpoint is down.

### `gh` not authenticated

PR-flow tickets require the GitHub CLI to be authenticated. Run:

```bash
gh auth login
gh auth status   # verify
```

Q&A tickets do not use `gh` and are unaffected.

### A ticket is stuck in `processing/`

If the daemon crashed mid-run (power loss, OOM), a ticket can be stranded in `processing/`. On the next startup Junco detects orphaned claims and recovers them automatically. If you need to force it, move the file back to `inbox/`:

```bash
mv <vault_root>/Junco/processing/<ticket.md> <vault_root>/Junco/inbox/
```

Existing result frontmatter written by the worker is stripped; your original frontmatter is preserved.

### Plan-lint rejections

If a ticket lands in `failed/` immediately (before any agent run), plan-lint rejected it. Open the ticket file — the `## Result` block describes the specific lint error. Common causes:

- `repo:` path does not exist or is not a git repository
- Label names in `labels:` do not exist on the target GitHub repo (`[plan_lint].check_labels = true`)
- `## Verification` block contains `cd <repo>` (forbidden — verification runs inside the worktree already)
- Missing required frontmatter fields

Fix the frontmatter and resubmit:

```bash
junco submit ./fixed-ticket.md --config ~/junco/config.toml
```

### Verification failure blocks the PR

If `[verify].block_on_fail = true` and the `## Verification` block fails, the ticket moves to `failed/` and the worktree is preserved at `<worktree_root>/<id>`. Inspect it directly:

```bash
cd <worktree_root>/<ticket-id>
# run the failing verification commands manually
```

Fix and resubmit the ticket, or set `block_on_fail = false` if you want Junco to open the PR regardless.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Bug reports, feature requests, and PRs are welcome.

Junco can submit tickets against itself — drop a PR-flow ticket with `repo:` pointing at this repository.

---

## License

MIT
