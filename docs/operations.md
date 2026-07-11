# Operations

Running junco day to day — the full CLI reference, health checks, service supervision, the security model, and troubleshooting.

[← back to the README](../README.md)

## CLI reference

All commands accept `--config <path>` to point at a non-default `config.json`. When omitted, junco uses `./config.json` if present, else the user-level default `~/.config/junco/config.json` (respects `XDG_CONFIG_HOME`) — so junco works from any directory after first-run setup. No global install needed either: `npx @ironforgesoftware/junco <command>` works the same as the installed `junco` binary.

| Command                                                         | Description                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `junco start [--config <path>] [--once]`                        | Run the daemon. Polls forever; `--once` processes one task then exits. Acquires a single-instance lock (`worker.lock` next to `config.json`); exits 0 if another instance holds the lock.                                                |
| `junco run-once [--config <path>]`                              | One-shot: process a single available task and exit. No lock — convenient for dev or cron.                                                                                                                                                |
| `junco submit <file\|-> [--config <path>]`                      | Atomically place a ticket into the configured inbox. Use `-` to read from stdin. The inbox filename is derived from the ticket's `id` frontmatter field.                                                                                 |
| `junco inbox-path [--config <path>]`                            | Print the resolved inbox directory path.                                                                                                                                                                                                 |
| `junco schema`                                                  | Print the ticket-frontmatter JSON Schema (the typed contract for all frontmatter fields).                                                                                                                                                |
| `junco init [--config <path>] [--yes]`                          | Interactive setup wizard: prompts for vault + model, **writes `config.json`**, and creates the queue directories. With a config already present, just creates the dirs (never overwrites). `--yes` scaffolds defaults non-interactively. |
| `junco` (no subcommand)                                         | First run (no config yet) → the setup wizard; otherwise → `start`.                                                                                                                                                                       |
| `junco service [--platform launchd\|systemd] [--config <path>]` | Render a service file to stdout. Defaults to `launchd` on macOS, `systemd` elsewhere.                                                                                                                                                    |
| `junco status [--config <path>]`                                | One-glance view: daemon (pid/uptime), endpoint readiness, in-flight tickets, processed counts, queue sizes.                                                                                                                              |
| `junco list [box] [--config <path>]`                            | Newest-first ticket listing per queue box (`inbox\|processing\|done\|failed`), with terminal statuses.                                                                                                                                   |
| `junco retry <name…\|--all> [--config <path>]`                  | Move failed tickets back to the inbox for a fresh run — claim stamp, appended result blocks, and retry bookkeeping stripped.                                                                                                             |
| `junco outbox [flush] [--config <path>]`                        | List the offline GitHub backlog (operation type, target issue/branch, age, attempt count, dead-letter count), or `flush` to push it now instead of waiting for the next daemon sweep.                                                    |
| `junco doctor [--config <path>]`                                | Preflight: config parses, node/git/gh present, `gh` authenticated, endpoint reachable, model advertised, queue/worktree/state dirs writable.                                                                                             |
| `junco dashboard [--config <path>]`                             | Interactive terminal UI for GitHub-integrated mode: watch repos, review plans, dispatch/approve/re-plan issues. Needs a real TTY.                                                                                                        |
| `junco restart [--config <path>]`                               | Restart the supervised daemon so it picks up config and code changes: finds the launchd/systemd user unit referencing your config, kicks it with the platform-correct verb, verifies the pid changed.                                    |
| `junco logs [-f] [-n N] [--json\|--human] [--config <path>]`    | Tail (or follow with `-f`) the worker log — human-readable on a TTY, raw JSON when piped or with `--json`; `--human` forces the readable format even when piped (used by the dashboard's command palette).                               |
| `junco --help` / `-h`                                           | Print usage.                                                                                                                                                                                                                             |

## Health & observability

When `observability.healthEnabled = true`, Junco serves HTTP on `healthHost:healthPort` (default `127.0.0.1:8787`).

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

**Logs** are structured JSON on stdout (colorized human format on a TTY; set `JUNCO_LOG_JSON=1` to force JSON) and are also written to `<state_dir>/worker.log` (default `~/.local/state/junco/worker.log`, rotated at 10 MB). `junco logs -f` follows them. Set `observability.logLevel` to `debug` for verbose output, `info` for normal operation.

**Transcripts:** every agent session appends its event stream (turns, tool calls, results — no token deltas) to `<state_dir>/transcripts/<ticket-id>.jsonl`, the debugging record for failed runs. Disable with `observability.transcripts = false`.

**Concurrency:** `worker.maxConcurrent` (default 1) runs that many tickets in parallel. Tickets targeting the same `repo:` always serialize, and a graceful stop drains in-flight work.

> The health server binds to loopback (`127.0.0.1`) by default. To expose it on a network interface, change `health_host`. Do so with care — there is no authentication.

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
mv <vault_root>/Junco/processing/<ticket.md> <vault_root>/Junco/inbox/
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

If `verify.blockOnFail = true` and the `## Verification` block fails, the ticket moves to `failed/` and the worktree is preserved at `<worktree_root>/<id>`. Inspect it directly:

```bash
cd <worktree_root>/<ticket-id>
# run the failing verification commands manually
```

Fix and resubmit the ticket, or set `block_on_fail = false` if you want Junco to open the PR regardless.
