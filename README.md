# junco

A headless task-queue worker that turns Markdown tickets into git pull requests
by driving a local LLM coding agent (Pi) under a runtime supervisor.

You drop a `.md` file with a frontmatter into an Obsidian-vault inbox; junco
claims it, spawns a Pi session in a fresh git worktree, watches the agent
turn-by-turn, nudges it when it loops, runs the spec's verification block,
critiques the diff, and opens a draft PR. Or fails loudly if the agent
deviated. One ticket at a time, sequential, polling-based.

```
            ┌─────────────────────────────────────────────────────────────┐
            │  Obsidian vault                                              │
            │   ├─ Junco/inbox/   ← drop .md tickets here                  │
            │   ├─ Junco/processing/                                       │
            │   ├─ Junco/done/                                             │
            │   └─ Junco/failed/                                           │
            └────────────────────────┬────────────────────────────────────┘
                                     │ (poll every 15s)
                                     ▼
            ┌────────────────────────────────────────────────────────────┐
            │  ~/junco/worker.py  (single-task daemon under launchd)     │
            │   1. claim ticket → fresh git worktree                     │
            │   2. spawn Pi --mode rpc                                   │
            │   3. supervise turn-by-turn (nudge / kill on guard trip)   │
            │   4. run ## Verification block                             │
            │   5. critic pass (diff vs spec)                            │
            │   6. push + open draft PR  (or fail loudly)                │
            └────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
                                  GitHub PR
```

## Status

| Layer | What it does | Where |
|---|---|---|
| Queue | Atomic claim from inbox/ → processing/ → done/ \| failed/. iCloud-aware. | `worker.py:claim` + `discover_tasks` |
| Agent | Spawns Pi (or omp) with project-aware preamble + ticket body. | `worker.py:_run_task_supervised` / `_run_task_oneshot` |
| Supervisor | Drives Pi via RPC. On guard trip, sends a recovery nudge before killing. | `supervisor.py`, `nudges.py`, `rpc_client.py` |
| Guards | Text-rep / thinking-rep (`RepetitionGuard`); tool-call literal-rep with adaptive thresholds (`ToolCallLoopGuard`); same-tool consecutive errors (`ToolErrorLoopGuard`). | `worker.py` |
| Post-session | Spec verification (configurable blocking gate); critic pass with one corrective re-dispatch. | `worker.py:run_spec_verification`, `run_critic_pass` |
| PR flow | Worktree per ticket, `git push --set-upstream`, `gh pr create --draft`. | `worker.py:_run_pr_flow` |

152 tests. Run with `.venv/bin/python -m pytest tests/ -q`.

## Prerequisites

- macOS with iCloud-synced Obsidian vault (defaults to `~/Library/Mobile Documents/obsidian/Documents/Vault`).
- Python 3.11+ (3.14 tested).
- [oMLX](https://github.com/jundot/omlx) running on `127.0.0.1:1234` with `Qwen3.6-27B-MLX-8bit` (or a model of your choice). The 27B is the validated default for headless Pi.
- [Pi](https://github.com/badlogic/pi-mono) — `npm install -g @mariozechner/pi-coding-agent` — installed at `/opt/homebrew/bin/pi`. (Junco can also run against `omp` from the oh-my-pi fork; configure via `client = "pi"` or `client = "omp"` in `config.toml`.)
- `gh` (GitHub CLI) authenticated against the target repo.
- For the Pi worker path: the `write-enriched` and `todo-write` extensions installed at `~/.pi/agent/extensions/` (pointed at by `[pi].extension_paths` in `config.toml`).

## Install

From `~/junco/`:

```bash
python3 -m venv .venv
.venv/bin/pip install pyyaml pytest
.venv/bin/python -m pytest tests/ -q       # expect 87 passing
bash scripts/install.sh                    # creates vault folders, installs LaunchAgent
```

`install.sh` creates `<vault>/Junco/{inbox,processing,done,failed}`, installs the ticket templates, renders `~/Library/LaunchAgents/com.junco.junco-worker.plist`, and loads the daemon with `launchctl bootstrap`.

## Uninstall

```bash
bash scripts/uninstall.sh
```

Removes the LaunchAgent. Leaves `~/junco/` (the code) and the vault's `Junco/` folder (the history) untouched so debug state survives.

## Submitting tasks

Two ticket flavors, distinguished by frontmatter:

- **Q&A ticket** (no `repo:`): junco runs Pi against the prompt body and writes the reply back into the file. No git involvement.
- **PR-flow ticket** (`repo: <path>`): junco creates a worktree, runs Pi inside it, and opens a draft PR.

### Q&A ticket

Drop into `<vault>/Junco/inbox/`:

```markdown
---
priority: normal             # low | normal | high
timeout_minutes: 30          # per-task wall-clock cap
---

# Title

Question or request body. Wikilinks like [[Other Note]] pass through verbatim
so the agent can resolve them if relevant.
```

### PR-flow ticket

```markdown
---
id: my-ticket-id-2026-04-25
priority: normal
timeout_minutes: 30
repo: ~/Development/your-project   # REQUIRED — triggers PR flow
base_branch: main
pr_title: Concise PR title
draft: true
labels: []
# amends_pr: 42                    # optional — amend mode (no new PR; commits added to existing)
---

# What the PR should do

## Why
Short rationale.

## Scope
### In scope
- ...
### Out of scope
- ...

## Steps
### Step 1 — ...
- [ ] ...
- [ ] Commit: `git add ... && git commit -m "..."`

## Verification

```bash
# Junco runs this AFTER your session in the worktree.
# If [verify].block_on_fail = true, any failure here blocks the PR open.
test -f path/to/expected
npx tsc --noEmit
```

## Done when
- [ ] N commits on `<branch_name>`.
```

The full template (with strict-notes for the agent) lives in `templates/task-code.md` and `~/.claude/skills/junco-dispatch/TEMPLATE.md`.

## PR-flow lifecycle

1. Ticket lands in `inbox/` → claimed atomically into `processing/` (worker scans every 15s).
2. **Pre-flight validation** with retry-with-backoff for transient github.com flakiness: `gh repo view`, `git ls-remote --heads origin <base>`, branch-collision check.
3. **Worktree provisioning**: `git worktree add -b junco/<id> <wt> origin/<base>` from `~/junco/worktrees/<id>`.
4. **Agent run** (one of):
   - **Supervised path** (`client = "pi"` AND `[supervisor].enabled = true`): spawn `pi --mode rpc`, send the initial prompt as a `prompt` command, supervise turn-by-turn. On guard trip: `Supervisor.decide()` → nudge or kill. After `agent_end` and no pending nudge, close cleanly.
   - **One-shot path** (legacy): `pi -p --mode json @<prompt-file>` runs to completion or hard-kills on guard trip.
5. **Post-session checks** (only on cleanly-completed sessions):
   - `run_spec_verification` runs the ticket's `## Verification` block in the worktree. Surfaces results in PR body banner. If `[verify].block_on_fail = true`, a failure routes the ticket to `failed/` and skips push/PR.
   - `run_critic_pass` spawns a short Pi session that compares `git diff base..HEAD` to the ticket spec and outputs `JUNCO_VERIFY: PASS` or `JUNCO_VERIFY: MISSING <items>`. On `MISSING` with retries remaining, junco re-dispatches one corrective worker turn.
6. **Push + PR**: `git push --set-upstream` (with retry on network flakiness) → `gh pr create --draft` (with retry).
7. **Finalize**: ticket moves to `done/` with frontmatter additions (`pr_url`, `branch`, `commit_count`, `tokens_*`, `agent_command`, etc.) and a structured `## Result` body block. Worktree removed on success; preserved for inspection on any failure.

## Result frontmatter (PR-flow tickets)

```yaml
status: completed                                    # | completed_no_changes | failed | timeout | aborted_partial | aborted_no_changes
started: 2026-04-25T17:11:48
finished: 2026-04-25T17:19:30
duration_seconds: 462
exit_code: 0
tokens_in: 52001
tokens_out: 1466
cache_read: 0
total_tokens: 53467
stop_reason: stop
agent_command: /opt/homebrew/bin/pi --mode rpc --model omlx/Qwen3.6-27B-MLX-8bit ...
pr_url: https://github.com/owner/repo/pull/42
branch: junco/my-ticket-id-2026-04-25
base_branch: main
commit_count: 3
pushed: true
```

## Configuration

`~/junco/config.toml`. Selected sections — see the file for the full set:

```toml
client = "pi"                              # "pi" or "omp"

[pi]
bin = "/opt/homebrew/bin/pi"
model_id = "omlx/Qwen3.6-27B-MLX-8bit"
mode = "json"                              # ignored when supervisor.enabled=true (rpc is forced)
extra_args = ["--tools", "bash,read,write,edit,grep,find,todo_write",
              "--no-skills", "--no-context-files", "--no-prompt-templates"]
commit_leftovers = false                   # fail-loud: incomplete work doesn't get a leftovers commit
extension_paths = [
  "~/.pi/agent/extensions/todo-write.ts",
  "~/.pi/agent/extensions/write-enriched.ts",
]

[supervisor]
enabled = true                             # turn-by-turn supervisor with nudge-on-guard-trip
budget_per_kind = 1                        # how many nudges per guard kind before kill
escalation_window_turns = 3                # same kind re-trips within K turns of nudge → kill
event_timeout_seconds = 300                # inter-event idle cap; silent Pi → timeout (→ failed/). 0 disables

[verify]
enabled = true
command_timeout = 60                       # per-command timeout for verification block
block_on_fail = true                       # verification failure → ticket fails (no PR opens)

[critic]
enabled = true
max_retries = 1                            # MISSING + retries remaining → 1 corrective re-dispatch
thinking = "minimal"                       # critic Pi session's thinking level
```

After editing: `launchctl kickstart -k gui/$(id -u)/com.junco.junco-worker`.

## Operation

```bash
tail -F ~/junco/launchd.out                                            # daemon log
tail -F "<vault>/Junco/worker.log"                                     # rotating worker log
launchctl kickstart -k gui/$(id -u)/com.junco.junco-worker         # force-restart
launchctl print gui/$(id -u)/com.junco.junco-worker                # inspect launchd state
```

### Manual runs

```bash
.venv/bin/python worker.py --once --dry-run    # what would happen, don't execute
.venv/bin/python worker.py --once              # process one task then exit
```

A single-instance `flock` (`worker.lock`, next to `config.toml`) keeps a manual
`--once` run from colliding with the live daemon: if the daemon holds the lock,
the manual run logs `another worker instance holds …` and exits 0 without
touching the queue. `--dry-run` is read-only (it neither claims tasks nor
recovers orphans) and runs without the lock, so it's always safe alongside the daemon.

### Retrying a failed task

```bash
mv "<vault>/Junco/failed/<file>" "<vault>/Junco/inbox/<file>"
```

Existing writer-owned frontmatter fields (`status`, `started`, `pr_url`, etc.) and any prior `## Result` block are stripped before the new run; user-authored frontmatter (`id`, `repo`, `base_branch`, etc.) is preserved.

## Repository layout

```
~/junco/
├── README.md
├── pyproject.toml             PEP 621 project metadata
├── config.toml                worker config
├── worker.py                  main daemon (launchd points here)
├── supervisor.py              decision engine
├── rpc_client.py              Pi --mode rpc protocol shim
├── nudges.py                  recovery message templates
├── plan_lint.py               pre-claim ticket validation
│
├── tests/                     pytest suite (152 tests)
├── scripts/
│   ├── install.sh             LaunchAgent install
│   ├── uninstall.sh           LaunchAgent remove
│   └── test-loop/             stress-run harness (shepherd, render, analyze, generate, omp_batch_probe)
├── templates/                 Obsidian Templater inputs (task.md, task-code.md)
└── docs/
    ├── postmortems/           run-by-run findings (2026-04-27 stress, 2026-04-28 e2e)
    ├── briefs/                25 reusable test-fixture briefs (T01..T25)
    └── omp-planner-samples/   captured omp planner outputs from 2026-04-27 probe
```

### File map (source modules)

| File | Role |
|---|---|
| `worker.py` | Main daemon. Config loading, task discovery, claim, dispatcher (`run_task` → supervised or one-shot), PR flow, finalize. |
| `rpc_client.py` | Pi `--mode rpc` protocol shim. Bidirectional JSONL over stdin/stdout. |
| `supervisor.py` | Decision engine: `decide(GuardEvent) → Action(continue\|nudge\|kill)`. Per-kind nudge budget + escalation window. |
| `nudges.py` | Recovery message templates per guard kind. ⚠️ JUNCO NOTICE-branded. |
| `plan_lint.py` | Pre-claim ticket validation (no `cd` in verification, files-table path existence, forbidden phrases, label existence, etc.). |
| `templates/task.md`, `templates/task-code.md` | Obsidian Templater inputs for Q&A and PR-flow tickets. |
| `scripts/install.sh`, `scripts/uninstall.sh` | LaunchAgent install/remove. |
| `scripts/test-loop/` | Stress-run harness — `shepherd.py` (sequential dispatcher with halt-on-failure), `render_tickets.py` (Claude-side ticket renderer), `omp_batch_probe.sh` (omp -p batch probe), `generate.sh`, `analyze.py`. |
| `docs/postmortems/` | Per-run architectural findings + ranked fixes shipped per round. |
| `docs/briefs/` | 25 reusable task briefs (T01 trivial → T25 architectural). |
| `docs/omp-planner-samples/` | 3 captured high-quality omp-planner ticket outputs from the 2026-04-27 probe. |
| `tests/` | 152 tests across protocol (rpc_client), policy (supervisor), integration (supervised_run), guards (repetition, output-budget, transient-retry), PR flow, plan-lint. |

## Architectural phases (in order shipped)

A chronological record so future-you knows when each layer landed and why:

1. **Phase 1** (PR flow) — worktree-per-ticket, push, draft PR via `gh`.
2. **Phase 2** (loop guards) — `RepetitionGuard` for text/thinking, `ToolCallLoopGuard` for tool literal-rep.
3. **Phase 3** (Pi migration) — `client = "pi"` worker default; vanilla Pi as the headless agent. Omp retained for interactive driving.
4. **Phase 4** (write-enriched + adaptive thresholds + tool-error loop guard + spec verification + critic pass + retry-with-backoff for github.com network ops + lean prose review).
5. **Phase 5** (supervised multi-turn) — Pi `--mode rpc` integration; `Supervisor.decide()` ; nudge-on-guard-trip; one-shot path preserved as legacy fallback.
6. **Phase 6** (verification gate, "Option A") — `[verify].block_on_fail` makes verification block PR open instead of just informational.
7. **Phase 7** (plan-lint pre-claim gate) — Deterministic ticket validation before claim. Catches `cd <repo>` in verification block, missing strict-notes block, forbidden phrases, nonexistent labels, files-table path mismatches. See `plan_lint.py`.
8. **Phase 8** (round 2: stress-run hardening) — `OutputBudgetGuard` (per-turn output token cap, kills runaway thinking before length-cutoff). Tightened `bash`/`grep`/`find`/`glob` thresholds to 3 from the stress-run findings.
9. **Phase 9** (round 3: e2e flow + retry) — Pi transient-error retry on `stop_reason=error` + 0 output tokens. SKILL.md guidance: BSD-coreutils awareness for verification commands; "verify before drafting" rule.

For the run-by-run details and what motivated each fix, see `docs/postmortems/`.

## Troubleshooting

- **`gh repo view` flaky on a fresh ticket**: junco retries on network-pattern stderr (`i/o timeout`, `dial tcp`, `could not resolve host`, ...). If ALL retries fail, ticket lands in `failed/` with the original error.
- **Tool-loop guard trips on a ticket that should succeed**: check `[supervisor].budget_per_kind` (default 1 — first trip becomes a nudge); also adaptive thresholds in `worker.py:DEFAULT_TOOL_LOOP_THRESHOLDS`.
- **"every task times out at N seconds"**: deep-context dense-27B prefill can exceed Pi's default stream timeout. Set `~/.omp/agent/.env` (omp) or check Pi's equivalent for `OMP_STREAM_FIRST_EVENT_TIMEOUT_MS=900000`.
- **Task stuck "unstable"**: iCloud sync hasn't settled. Bump `worker.stability_window_seconds` to 10–15.
- **`.icloud` placeholder never materializes**: open the file in Finder once OR run `brctl download <path>` manually. Junco auto-triggers `brctl download` when `[worker].icloud_brctl_download = true`.
- **Verification block fails but the diff looks correct**: with `[verify].block_on_fail = true` the ticket goes to `failed/`. Worktree is preserved at `~/junco/worktrees/<id>` — `cd` in and run the failing commands manually.

## Contributing

1. Fork, branch, write tests first.
2. `.venv/bin/python -m pytest tests/ -q` — must stay green.
3. Open a PR. Junco itself can be used to write junco — drop a PR-flow ticket against this repo.
