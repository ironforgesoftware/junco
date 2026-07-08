# Configuration

The full annotated `config.toml` reference, plus the knobs worth knowing.

[← back to the README](../README.md)

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
allowed_repo_roots = []           # Confine PR-flow tickets to these roots ([] = any path). See docs/operations.md § Security model.

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

## Key knobs to know

| Knob                               | Effect                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `[model].id`                       | Which model the agent requests (provider-prefixed, e.g. `omlx/my-model`).                                                  |
| `[model].models_json`              | Point at a Pi `models.json` to load the provider+model (api, compat, context window…) from that file.                      |
| `[model].base_url` / `api`         | Switch inference backends — any OpenAI-compatible `/v1` endpoint, or another Pi `api` style (Anthropic, Google, Bedrock…). |
| `[verify].block_on_fail`           | Set `true` to make verification failures block the PR open (strict mode).                                                  |
| `[supervisor].budget_per_kind`     | Raise to allow more nudges before killing a looping agent.                                                                 |
| `[worker].startup_wait`            | Set `false` to start the daemon even when the endpoint is not yet up.                                                      |
| `[git].remove_worktree_on_success` | Set `false` to retain worktrees after success (debugging).                                                                 |
