# junco

**Turn Markdown tickets into pull requests — automatically.**

Junco is a task-queue worker that turns Markdown "tickets" into git pull requests. Drop a ticket (a plan with YAML frontmatter) into an inbox directory; the daemon claims it, runs it in an isolated git worktree by driving a coding agent, applies loop guards and verification, runs a diff-vs-spec critic, then opens a draft PR. A ticket without a `repo:` field is a **Q&A ticket** — the agent answers in-place, no git involved. Any tool or human can author and submit tickets; Junco is harness-agnostic on the dispatch side.

The embedded agent talks to any **OpenAI-compatible `/v1` inference endpoint** — point it at a local server, a hosted API, or any compatible provider.

---

## Get started in 60 seconds

Requires **Node ≥ 22.19** (plus `git` + an authenticated `gh` for PR-flow tickets).

**1. Run the setup wizard** — it asks a few questions, writes `config.toml`, and creates the queue:

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

**4. Watch it:** `curl localhost:8787/health`, or check `<vault_root>/Junco/done/` and `failed/`.

New to the ticket format? Run `junco schema`, copy a template from `examples/`, or let the bundled **`junco-dispatch`** skill scaffold a well-formed ticket. The sections below explain each step in depth.

---

## Table of Contents

0. [Get started in 60 seconds](#get-started-in-60-seconds)
1. [Quickstart](#quickstart)
2. [How it works](#how-it-works)
3. [CLI reference](#cli-reference)
4. [Configuration](#configuration)
5. [Tickets](#tickets)
6. [Health & observability](#health--observability)
7. [Running as a service](#running-as-a-service)
8. [Troubleshooting](#troubleshooting)
9. [Contributing](#contributing)
10. [License](#license)

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

The wizard asks for your vault directory and model (an OpenAI-compatible endpoint, or a Pi `models.json`), **writes `config.toml`**, and creates the queue directories `<vault_root>/Junco/{inbox,processing,done,failed}` plus the worktree root. Add `--yes` to scaffold defaults non-interactively. A bare `junco` (or `npx @ironforgesoftware/junco`) runs this same wizard on first run.

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

```bash
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
```

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
         │  junco submit <ticket.md>
         ▼
  <vault_root>/Junco/inbox/          ← drop tickets here
         │
         │  daemon polls every 15s
         ▼
  ┌──────────────────────────────────────────────────────┐
  │  junco daemon                                        │
  │                                                      │
  │  1. plan-lint           validate frontmatter         │
  │  2. claim               inbox/ → processing/         │
  │  3. git worktree        isolated branch per ticket   │
  │  4. agent run           drives coding agent          │
  │     └─ loop guards      supervisor watches each turn │
  │  5. verification        runs ## Verification block   │
  │  6. critic              diff-vs-spec check           │
  │  7. push + PR           gh pr create --draft         │
  │  8. finalize            processing/ → done/|failed/  │
  └──────────────────────────────────────────────────────┘
         │
         ▼
  GitHub draft PR  (or answer written in-place for Q&A)
```

**Plan-lint** runs before the agent starts. Bad tickets (invalid frontmatter, forbidden patterns, nonexistent labels) route directly to `failed/` without consuming any agent tokens.

**Loop guards** (supervisor) watch the agent turn-by-turn. On a guard trip, the supervisor sends a recovery nudge; if the agent trips the same guard again within the escalation window, it kills the session.

**Critic** compares the final diff to the ticket spec. If it flags missing items and retries remain, Junco dispatches one corrective agent turn before pushing.

---

## CLI reference

All commands accept `--config <path>` to point at a non-default `config.toml`. When omitted, `config.toml` in the current directory is used.

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
| `junco --help` / `-h` | Print usage. |

---

## Configuration

Junco is configured via a TOML file (default: `config.toml` in the current directory). Below is a fully-annotated reference with defaults.

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
```

### Key knobs to know

| Knob | Effect |
|---|---|
| `[model].id` | Which model the agent requests (provider-prefixed, e.g. `omlx/my-model`). |
| `[model].models_json` | Point at a Pi `models.json` to load the provider+model (api, compat, context window…) from that file. |
| `[model].base_url` / `api` | Switch inference backends — any OpenAI-compatible `/v1` endpoint, or another Pi `api` style (Anthropic, Google, Bedrock…). |
| `[verify].block_on_fail` | Set `true` to make verification failures block the PR open (strict mode). |
| `[supervisor].budget_per_kind` | Raise to allow more nudges before killing a looping agent. |
| `[worker].startup_wait` | Set `false` to start the daemon even when the endpoint is not yet up. |
| `[git].remove_worktree_on_success` | Set `false` to retain worktrees after success (debugging). |

---

## Tickets

A ticket is a Markdown file with YAML frontmatter and a plan body. Run `junco schema` to print the full typed JSON Schema for every frontmatter field.

### Ticket flavors

| Flavor | Trigger | What happens |
|---|---|---|
| **Q&A ticket** | No `repo:` field | Agent answers in-place; result written back to the ticket file. No git. |
| **PR-flow ticket** | `repo: <absolute/path>` | Agent runs in an isolated git worktree; a draft PR is opened on success. |

### Key frontmatter fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique ticket identifier. Used as the inbox filename and branch suffix. |
| `repo` | path | Absolute path to the target git repository. Presence triggers PR flow. |
| `priority` | `low\|normal\|high` | Processing order within the queue. |
| `timeout_minutes` | number | Per-ticket wall-clock cap. Overrides `[worker].default_timeout_minutes`. |
| `base_branch` | string | Branch to fork from. Overrides `[git].default_base_branch`. |
| `branch_name` | string | Override the auto-generated branch name. |
| `pr_title` | string | Pull request title. |
| `draft` | bool | Open PR as draft. Overrides `[pr].draft_by_default`. |
| `labels` | string[] | Labels to apply to the PR. |
| `reviewers` | string[] | GitHub handles to request as reviewers. |
| `amends_pr` | number | PR number — add commits to an existing PR instead of opening a new one. |

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

```markdown
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
```

### Submitting tickets

```bash
# From a file:
junco submit ./my-ticket.md --config ~/junco/config.toml

# From stdin:
cat my-ticket.md | junco submit - --config ~/junco/config.toml

# Print the inbox path:
junco inbox-path --config ~/junco/config.toml
```

The bundled `junco-dispatch` skill (for Claude Code) scaffolds well-structured tickets from any Claude session and submits them automatically.

### Templates

Ticket templates live in the `templates/` directory:
- `templates/task.md` — Q&A ticket template
- `templates/task-code.md` — PR-flow ticket template (with strict-notes for the agent)

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

## Health & observability

When `[observability].health_enabled = true`, Junco serves HTTP on `health_host:health_port` (default `127.0.0.1:8787`).

| Endpoint | Success | Use |
|---|---|---|
| `GET /live` | `200 {status:"alive", pid, uptimeSeconds}` | Liveness — is the process up? |
| `GET /ready` | `200 {status:"ready"}` or `503` | Readiness — can the endpoint be reached? |
| `GET /health` | `200 {status:"ok", ready, metrics:{...}}` | Full metrics: uptime, poll count, current ticket, tasks processed/succeeded/failed, task counts by status, token totals, duration totals. |

```bash
# Quick checks:
curl http://127.0.0.1:8787/live
curl http://127.0.0.1:8787/ready
curl http://127.0.0.1:8787/health | jq .
```

**Logs** are structured JSON on stdout. Set `[observability].log_level` to `debug` for verbose output, `info` for normal operation.

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

---

## Troubleshooting

### Inference endpoint unreachable at boot

By default (`[worker].startup_wait = true`) Junco blocks startup and retries every `startup_poll_seconds` (default 30) until the endpoint responds. Check that your inference server is running and that `[oMLX].url` points to the correct address.

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
