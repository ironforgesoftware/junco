# Operations

Running junco day to day — the full CLI reference, health checks, service supervision, the security model, and troubleshooting.

[← back to the README](../README.md)

## CLI reference

All commands accept `--config <path>` to point at a non-default `config.json`. When omitted, junco uses `./config.json` if present, else the user-level default `~/.config/junco/config.json` (respects `XDG_CONFIG_HOME`) — so junco works from any directory after first-run setup. No global install needed either: `npx @ironforgesoftware/junco <command>` works the same as the installed `junco` binary.

| Command                                                         | Description                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `junco start [--config <path>] [--once]`                        | Run the daemon. Polls forever; `--once` processes one task then exits. Acquires a single-instance lock (`worker.lock` next to `config.json`); exits 0 if another instance holds the lock.                                                               |
| `junco run-once [--config <path>]`                              | One-shot: process a single available task and exit. No lock — convenient for dev or cron.                                                                                                                                                               |
| `junco submit <file\|-> [--config <path>]`                      | Atomically place a ticket into the configured inbox. Use `-` to read from stdin. The inbox filename is derived from the ticket's `id` frontmatter field.                                                                                                |
| `junco inbox-path [--config <path>]`                            | Print the resolved inbox directory path.                                                                                                                                                                                                                |
| `junco schema`                                                  | Print the ticket-frontmatter JSON Schema (the typed contract for all frontmatter fields).                                                                                                                                                               |
| `junco config init [--config <path>]`                           | Headless default-config scaffold: **writes `config.json`** with safe defaults and creates the queue directories. With a config already present, just ensures the dirs (never overwrites). The interactive equivalent lives in `junco dashboard`, below. |
| `junco` (no subcommand)                                         | First run (no config yet) → the dashboard's guided setup walkthrough; otherwise → `start`.                                                                                                                                                              |
| `junco service [--platform launchd\|systemd] [--config <path>]` | Render a service file to stdout. Defaults to `launchd` on macOS, `systemd` elsewhere.                                                                                                                                                                   |
| `junco status [--config <path>]`                                | One-glance view: daemon (pid/uptime), endpoint readiness, in-flight tickets, processed counts, queue sizes.                                                                                                                                             |
| `junco list [box] [--config <path>]`                            | Newest-first ticket listing per queue box (`inbox\|processing\|done\|failed`), with terminal statuses.                                                                                                                                                  |
| `junco retry <name…\|--all> [--config <path>]`                  | Move failed tickets back to the inbox for a fresh run — claim stamp, appended result blocks, and retry bookkeeping stripped.                                                                                                                            |
| `junco outbox [flush] [--config <path>]`                        | List the offline GitHub backlog (operation type, target issue/branch, age, attempt count, dead-letter count), or `flush` to push it now instead of waiting for the next daemon sweep.                                                                   |
| `junco doctor [--config <path>]`                                | Preflight: config parses, node/git/gh present, `gh` authenticated, endpoint reachable, model advertised, queue/worktree/data dirs writable.                                                                                                             |
| `junco dashboard [--config <path>]`                             | Interactive terminal UI for GitHub-integrated mode: watch repos, review plans, dispatch/approve/re-plan issues. With no config yet, opens the guided setup walkthrough first (re-run anytime from the command palette's "setup"). Needs a real TTY.     |
| `junco restart [--config <path>]`                               | Restart the supervised daemon so it picks up config and code changes: finds the launchd/systemd user unit referencing your config, kicks it with the platform-correct verb, verifies the pid changed.                                                   |
| `junco logs [-f] [-n N] [--json\|--human] [--config <path>]`    | Tail (or follow with `-f`) the worker log — human-readable on a TTY, raw JSON when piped or with `--json`; `--human` forces the readable format even when piped (used by the dashboard's command palette).                                              |
| `junco --help` / `-h`                                           | Print usage.                                                                                                                                                                                                                                            |

## Health & observability

When `observability.healthEnabled = true`, Junco serves HTTP on `healthHost:healthPort` (default `127.0.0.1:8787`).

| Endpoint      | Success                                         | Use                                                                                                                                                                                                                                                                     |
| ------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /live`   | `200 {status:"alive", pid, uptimeSeconds}`      | Liveness — is the process up?                                                                                                                                                                                                                                           |
| `GET /ready`  | `200 {status:"ready"}` or `503`                 | Readiness — can the endpoint be reached? A latched or backed-off provider gate forces the 503 (with the gate's reason) regardless of the probe result.                                                                                                                  |
| `GET /health` | `200 {status:"ok", ready, metrics:{...}, gate}` | Full metrics: uptime, poll count, in-flight tickets (`currentTickets`), live per-ticket progress (`currentProgress`: turns, last tool, output tokens), tasks processed/succeeded/failed, task counts by status, token totals, duration totals, plus `gate` (see below). |

```bash
# Quick checks:
curl http://127.0.0.1:8787/live
curl http://127.0.0.1:8787/ready
curl http://127.0.0.1:8787/health | jq .
```

### Provider gate

Junco classifies inference-endpoint failures and, for the ones an operator (not a retry) has to fix, pauses ticket claiming instead of burning tickets against a provider that will keep saying no. The gate's `gate` field on `/health` is `{state, reason, since, until}` — `reason` is the classified error text, `since`/`until` are ISO timestamps (`until` is `null` except for the until-based states below). `gate` itself is `null` only when no gate is wired at all.

| State              | Entered on                                                                      | Clears on                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`               | default / no active failure                                                     | —                                                                                                                                                                         |
| `auth_error`       | auth failure (401/403, unauthorized/forbidden, invalid API key or bearer token) | a successful session, a config hot-reload apply, or a daemon restart                                                                                                      |
| `quota_exhausted`  | quota/billing error                                                             | a successful session, a config hot-reload apply, or a daemon restart                                                                                                      |
| `misconfig`        | model not found / doesn't resolve                                               | a successful session, a config hot-reload apply, or a daemon restart                                                                                                      |
| `rate_limited`     | 429 / rate-limit / overloaded response                                          | the above, or automatically once the backoff `until` elapses — the delay doubles on each further rate-limit report, capped at 900 s                                       |
| `outage_backoff`   | 5xx / connection error (timeout, refused, DNS…)                                 | the above, or automatically once the backoff `until` elapses — a single, non-doubling `worker.retryBackoffSeconds` interval                                               |
| `budget_exhausted` | today's spend (`worker.dailyBudgetUsd`, 0 disables it) reaches the cap          | a config hot-reload apply (operator raised the cap — re-latches on the next poll if still exceeded), or automatically at local midnight — **not** by a successful session |

`auth_error`/`quota_exhausted`/`misconfig` are latches: once entered they hold until an explicit clear (they never expire on their own, and a later rate-limit/outage report can't downgrade them). `rate_limited`/`outage_backoff` are backoffs: they lapse to `ok` the moment they're read past their `until` deadline, with no timer required. `budget_exhausted` is a hybrid: it lapses to `ok` at its `until` (local midnight) like a backoff, but — unlike every other state — a successful session does NOT clear it, since finishing a session doesn't un-spend money; only midnight or an operator's config hot-reload ends it early. None of the above overwrite an existing `auth_error`/`quota_exhausted`/`misconfig` latch — latch wins. Tickets that trip the gate are returned to the inbox with a fresh `not_before` but their retry budget untouched — see [Reliability](tickets.md#reliability).

The interactive dashboard (`junco dashboard`) shows the gate as a colored dot on the daemon panel (red for a latch, yellow for a backoff) with a reason line underneath when the state isn't `ok`.

### Spend

`/health` also carries a `spend` field: `{todayUsd, dailyBudgetUsd} | null` — today's tallied USD spend and the live `worker.dailyBudgetUsd` cap (`0` means no cap configured), `null` only when no spend ledger is wired at all. Every completed session's actual resolved cost — Q&A, `assess`, `analyze`, and PR-flow's main run/critic pass/corrective re-dispatch — is recorded against the local calendar day regardless of whether a cap is set — see [Configuration § Daily spend cap](configuration.md#daily-spend-cap). The dashboard's daemon panel prints a matching `spend $X.XX today` line, appending `/ $Y.YY budget` once a cap is configured.

`metrics.totalCostUsd` (in the `/health` metrics block) and `spend.todayUsd` both track real dollars but can legitimately diverge: `totalCostUsd` only accumulates once a ticket reaches a terminal state (`finalize`'s `recordTask`) and resets on daemon restart, whereas the ledger records every session's cost immediately — including sessions whose ticket goes on to requeue — and persists across restarts, resetting only at local midnight. A ticket that requeues a few times before finishing shows up once in `totalCostUsd` but once per attempt in the ledger.

**Logs** are structured JSON on stdout (colorized human format on a TTY; set `JUNCO_LOG_JSON=1` to force JSON) and are also written to `<dataDir>/worker.log` (default `~/.local/state/junco/worker.log`, rotated at 10 MB). `junco logs -f` follows them, and the dashboard's [LOCAL `logs` section](dashboard.md#local-mode) tails the same file live without leaving the TUI. Set `observability.logLevel` to `debug` for verbose output, `info` for normal operation.

**Transcripts:** every agent session appends its event stream (turns, tool calls, results — no token deltas) to `<dataDir>/transcripts/<ticket-id>.jsonl`, the debugging record for failed runs. Disable with `observability.transcripts = false`.

**Concurrency:** `worker.maxConcurrent` (default 1) runs that many tickets in parallel. Tickets targeting the same `repo:` always serialize, and a graceful stop drains in-flight work.

> The health server binds to loopback (`127.0.0.1`) by default. To expose it on a network interface, change `observability.healthHost`. Do so with care — there is no authentication.

## Running as a service

`junco service` renders a platform-native service file to stdout. Pipe it to the right location and load it.

### macOS (launchd)

```bash
junco service --platform launchd --config ~/junco/config.json \
  > ~/Library/LaunchAgents/com.junco.worker.plist

launchctl load ~/Library/LaunchAgents/com.junco.worker.plist
launchctl start com.junco.worker
```

### Linux (systemd)

```bash
junco service --platform systemd --config ~/junco/config.json \
  > ~/.config/systemd/user/junco.service

systemctl --user daemon-reload
systemctl --user enable --now junco
```

### Lock semantics and supervisor restart loops

`junco start` acquires `worker.lock` (next to `config.json`). If a second instance starts while the first holds the lock, it **exits 0** — it does not error out. This means your supervisor (launchd, systemd) will not enter a restart loop if you accidentally start Junco twice.

`junco run-once` does **not** acquire the lock — it is safe for cron and dev use alongside a running daemon.

### Restarting after config or code changes

The daemon reads its config and code once at startup. `junco restart` bounces the supervised daemon correctly: it discovers the launchd plist / systemd user unit that references your config path and uses `launchctl kickstart -k` / `systemctl --user restart` — the verbs that relaunch unconditionally. (A plain SIGTERM is _not_ a restart: with launchd's `SuccessfulExit=false` keep-alive, a graceful exit stays down.) It validates the config first — refusing to bounce the daemon onto a config it can't parse — and confirms the new pid before reporting success.

## Security model

The inbox is a **code-execution boundary**. Junco runs a coding agent with bash/file tools against whatever ticket lands in `inbox/`, and `## Verification` blocks run as your user — anyone who can write to the inbox can act as you. Keep the inbox on a local disk you own, don't point it at a synced/shared folder others can write to, and set `git.allowedRepoRoots` to confine PR-flow tickets to approved checkout locations:

```json
{
  "git": {
    "allowedRepoRoots": ["~/code"]
  }
}
```

(`[]`, the default, means any path on disk.)

### Sandboxing the agent + a dedicated identity

Two defenses harden the code-execution boundary above. They are independent — use either or both.

**1. Native execution sandbox (`sandbox`).** **On by default**, agent tool execution is confined with OS-level isolation (Seatbelt on macOS, bubblewrap on Linux; no container, works offline). Writes are restricted to the worktree, network is denied by default, and credentials/API keys are scrubbed from the agent's environment. It **fails closed** if the backend binary is missing (`junco doctor` preflights it) — on a Linux host without `bwrap`, install it or set `sandbox.backend: "none"` / `sandbox.enabled: false`. Toggle it live from the `,` config editor or `junco config set sandbox.enabled false` (no restart). Run `junco config list` (the `sandbox.*` levers) for the full policy, and use the per-ticket `network: true` frontmatter opt-in to widen egress for one ticket. The in-process fs tools (read/write/edit/…) run under a JS path-jail; to keep a compromised agent from winning a symlink-swap race against it, bash execution is serialized against fs-ops (only bash can plant a symlink) and bash's process group is reaped on completion — so while the sandbox is enabled a long bash briefly blocks concurrent fs-ops. Residual: a `setsid`-escaping background process on macOS can still race the jail (bwrap's PID namespace reaps it on Linux); the fully atomic close (a native `openat2`/`openat` resolver) is tracked on [#159](https://github.com/ironforgesoftware/junco/issues/159). A second, Linux-only residual: the bwrap backend masks a deny-listed **file** by ro-binding `/dev/null` over it and skips deny mounts for paths that don't exist at spawn, so a daemon-owned receipt file (`spend.json` / `watchlist.json` / `metrics.json` / …) that does **not yet exist** when a session spawns is readable by raw `bash` if the daemon creates it mid-session. Low sensitivity (the exposed class is late-created root receipts on a fresh install), the in-process fs-tool path-jail still denies these by name, and Seatbelt masks them regardless of existence — but on Linux a mid-session receipt read by raw bash is not blocked for the life of that session.

**2. Dedicated GitHub identity.** Junco performs every `git push` / `gh pr create` itself; the agent never needs a token. Authenticate the **daemon** as a dedicated machine GitHub account (or a fine-grained PAT under one) scoped to only the repos junco may touch, with only `contents:write` + `pull_requests:write`. Combined with the sandbox's env scrub (which keeps the token off the agent plane entirely), a prompt-injected or runaway agent cannot exfiltrate a reusable credential or act as your personal account.

## Troubleshooting

### Inference endpoint unreachable at boot

By default (`worker.startupWait = true`) Junco blocks startup and retries every `startupPollSeconds` (default 30) until the endpoint responds. Check that your inference server is running and that `model.baseUrl` points to the correct address.

Set `worker.startupWait = false` to let Junco start immediately and fail individual tickets if the endpoint is down.

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
mv <dataDir>/queue/processing/<ticket.md> <dataDir>/queue/inbox/
```

Existing result frontmatter written by the worker is stripped; your original frontmatter is preserved.

### Plan-lint rejections

If a ticket lands in `failed/` immediately (before any agent run), plan-lint rejected it. Open the ticket file — the `## Result` block describes the specific lint error. Common causes:

- `repo:` path does not exist or is not a git repository
- Label names in `labels:` do not exist on the target GitHub repo (`planLint.checkLabels = true`)
- `## Verification` block contains `cd <repo>` (forbidden — verification runs inside the worktree already)
- Missing required frontmatter fields

Fix the frontmatter and resubmit:

```bash
junco submit ./fixed-ticket.md --config ~/junco/config.json
```

### Verification failure blocks the PR

If `verify.blockOnFail = true` and the `## Verification` block fails, the ticket moves to `failed/` and the worktree is preserved at `<worktreeRoot>/<id>`. Inspect it directly:

```bash
cd <worktreeRoot>/<ticket-id>
# run the failing verification commands manually
```

Fix and resubmit the ticket, or set `verify.blockOnFail = false` if you want Junco to open the PR regardless.
