# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `junco assess discard <id>` — explicitly archive a pending review batch; filing no longer auto-archives.

### Changed

- `junco assess` filing (CLI `assess file`, TUI `f`) stamps per-finding filed accounting (created/queued/dup + timestamp + URL) and keeps the batch in the review list; the TUI review view shows batch age, `filed n/m` chips, and per-finding ✓ accounting, and `x` discards an open batch.

## [0.8.0] - 2026-07-17

### Added

- Full-TUI mouse control with hover feedback: config editor, command palette, queue, review, help, add-repo, LOCAL dashboard, plus clickable footer hint chips in every view.
- First-run setup lives in the dashboard: `junco dashboard` (or bare `junco`) with no config opens the guided walkthrough, then lands in the dashboard. Re-run it anytime from the command palette ("setup").
- `junco config init` — headless default-config scaffold (the old `junco init --yes`).
- Mouse support in the setup walkthrough: clickable choices, back/quit chips, click-to-finish.
- Dedicated bot-account identity for daemon GitHub traffic (`junco auth login`, wizard Account
  chapter, `botAccount` config block).
- Permission-aware repo access: `junco auth grant <owner/repo>` (invite as you, accept as the
  bot), dashboard auto-grant after adding a watched repo, and doctor/wizard grant hints. Dispatch
  to an unwatched repo the bot can push to now goes direct instead of forking — and
  **auto-onboards** that repo permanently into the watchlist (bridge-swept from then on, no
  confirmation step); this includes `junco assess` scoped to a single issue on such a repo.
  Fork-PR mode is unchanged for public repos the bot can't push to.
- `junco assess` now records a per-repo history (last successful audit, its finding counts, and a
  marker when the most recent attempt failed), surfaced as a column in the dashboard rail and in
  `junco status` / `junco doctor`. Issue-scoped runs (`junco assess owner/repo#N`) deliberately do
  not refresh a repo's freshness — they audit only the code the issue implicates. The history lives
  at `<dataDir>/assess-history/` (one file per repo).
- **Unified data root:** a new top-level `dataDir` config key (default `~/.local/state/junco`)
  that every on-disk path — the ticket queue, parked `assess`/`analyze` review items, the GitHub
  outbox, cloned repos, PR-flow worktrees, transcripts, and watchlist/spend/metrics/log files —
  now resolves under. The tree is materialized eagerly at daemon startup — every directory except
  `clones/external/` and `worktrees/` (still created on demand, since a legacy override can point
  them outside the root) — and the root gets a self-`.gitignore` (`*`, written only when absent)
  so pointing `dataDir` inside a git checkout — including junco's own — can never dirty a commit.
- `junco data [--json]` — a pure, read-only view of the resolved tree: live counts per node,
  legacy-override provenance, pending migrations, and config deprecations.
- `junco data migrate [--dry-run|--force]` — the opt-in full unification for a config still
  carrying legacy path keys: moves the queue into `<dataDir>/queue`, normalizes the state tree,
  rewrites `config.json` to drop the legacy keys, and prints a receipt. Refuses while the daemon
  looks like it's running (`--force` to override).
- An in-place state-tree migration (old directory names → new ones, e.g. `assess-review` →
  `review/assess`) runs automatically at every daemon startup — journaled, idempotent, and never
  destructive on a name conflict.
- Daemon startup logs a one-line warning per deprecated legacy config key set, plus a warning for
  any state-tree migration conflict it had to skip; `junco doctor` and `junco data` additionally
  report pending (not-yet-run) migrations as informational findings, pointing at
  `junco data migrate`.
- Update notification: the dashboard header, `junco status`, and `junco doctor` now surface a newer
  npm release (best-effort daily check against the npm registry, cached in
  `<dataDir>/update-check.json`; opt out with `"updateCheck": false`).
- `junco update` — install the latest release and drain-restart the supervised daemon.
- `junco --version`.
- Tickets can request a bot-created tracking issue: `github_request: { create_issue: true }` makes the worker create the issue at claim time (own gh identity — bot account when configured) and link the PR (`Closes owner/repo#N`), so merging closes it. Best-effort; fork-push tickets are skipped.

### Changed

- Bare `junco` now ensures the supervised daemon is up, then opens the dashboard. On an
  interactive terminal, if the daemon is down and a launchd/systemd service references your
  config, it starts that service and waits briefly for it to come up before landing in the
  dashboard; with no service installed it opens the dashboard and points you at `junco service`.
  Previously bare `junco` with a config ran the daemon in the foreground (blocking the terminal).
  Never starts an unsupervised daemon, and non-interactive invocations (pipes/CI) skip the
  pre-flight entirely. `junco start` (explicit foreground daemon) and `junco dashboard` (observe
  without starting anything) are unchanged.
- Dashboard mouse protocol upgraded to SGR any-motion tracking (hover); click targets now resolve via a render-time hit-region registry.
- Default on-disk locations moved under the unified `dataDir` root (existing configs are
  unaffected — see Deprecated below):

  | What                      | Old default                           | New default                  |
  | ------------------------- | ------------------------------------- | ---------------------------- |
  | Ticket queue              | `<vaultRoot>/<juncoSubdir>/{inbox,…}` | `<dataDir>/queue/{inbox,…}`  |
  | Assess review parking     | `<stateDir>/assess-review/`           | `<dataDir>/review/assess/`   |
  | Analyze review parking    | `<stateDir>/comment-review/`          | `<dataDir>/review/comments/` |
  | GitHub outbox             | `<stateDir>/github-outbox/`           | `<dataDir>/outbox/`          |
  | Dashboard-cloned repos    | `<stateDir>/repos/`                   | `<dataDir>/clones/watched/`  |
  | External (fork-PR) clones | `<stateDir>/external/`                | `<dataDir>/clones/external/` |
  | PR-flow worktrees         | `~/junco/worktrees`                   | `<dataDir>/worktrees/`       |
  | Watchlist                 | `<stateDir>/github-watchlist.json`    | `<dataDir>/watchlist.json`   |

  `worker.log`, `transcripts/`, and `spend.json` were already under `stateDir` and simply move
  with it to `dataDir`. `metrics.json` is a reserved, forward-looking path — listed in the tree
  (and by `junco data`) now, written by a planned metrics-persistence follow-up.

- The setup wizard's Workspace question now scaffolds `dataDir` into a fresh `config.json`, but
  only when it differs from the default — a fully-default fresh config still carries no path keys
  at all.

### Deprecated

- Four legacy, single-purpose path keys are now optional per-subtree overrides — each still works
  exactly as before, but logs a one-line deprecation warning at daemon startup and is flagged by
  `junco doctor`/`junco data`: `vaultRoot` + `juncoSubdir` (queue root), `observability.stateDir`
  (the whole data root), `git.worktreeRoot` (worktrees root), and `github.externalReposRoot`
  (external-clones root). Run `junco data migrate` to drop them and unify onto `dataDir`.

### Fixed

- Dashboard rail: the `▌` selection bar could be squeezed to zero width by a long `owner/repo`
  name, leaving no visible selection — and no fallback on `NO_COLOR` terminals, where `▌` is the
  only selection cue. The rail row now pins the selection bar and the assess column and truncates
  the repo name between them.

### Removed

- **Breaking:** the `junco init` subcommand. Interactive setup → `junco dashboard`; scripted scaffold → `junco config init`.

## [0.7.0] - 2026-07-12

### Added

- Hosted catalog model resolution: a provider-prefixed `model.id` (e.g.
  `anthropic/claude-sonnet-4-5`) with no explicit `model.baseUrl` now resolves
  from the embedded SDK's builtin provider catalog (real endpoint, cost, and
  context-window metadata). `model.source` (`auto`/`catalog`/`inline`) pins the
  behavior explicitly.
- `model.apiKey` may be omitted (the provider's environment variable, e.g.
  `ANTHROPIC_API_KEY`, applies at request time) or set to an `"$ENV_VAR"`
  reference; `"!command"` values are rejected.
- `model.retry.maxRetries` / `model.retry.baseDelayMs` — SDK auto-retry levers.
- Endpoint probing (startup wait, readiness, doctor) is skipped for hosted
  catalog models.
- **Provider gate:** infrastructure failures from the inference endpoint now
  pause ticket claiming instead of quietly retrying against a provider that
  will keep saying no. Seven states — `ok`, `auth_error`, `quota_exhausted`,
  `misconfig`, `rate_limited`, `outage_backoff`, `budget_exhausted` — are
  latched or backed off based on the failure text (auth/quota/model-not-found/
  rate-limit/outage/daily-budget); any successful session, a config hot-reload
  apply, or a daemon restart clears the gate, and `rate_limited`/
  `outage_backoff` also expire on their own once their backoff window passes
  (`budget_exhausted` is the one exception — see below).
- `worker.endpointProbe` (`"auto"` / `"always"` / `"never"`) controls whether
  the inference endpoint is probed for reachability, overriding the
  catalog-skip default; probe results are cached for ~10 seconds and shared
  across the claim gate, `/health`, and `/ready`.
- `/health` gains a `gate: {state, reason, since, until}` field (`null` when
  no gate is wired); `/ready` returns its 503 body with the gate's reason
  whenever the gate is latched or backed off.
- The interactive dashboard (`junco dashboard`) shows the provider gate's
  state as a colored dot on the daemon panel (red for a latch, yellow for a
  backoff) plus a reason line when the gate isn't `ok`.
- **Cost accounting.** Every completed session (main run, critic pass,
  corrective re-dispatch) records its resolved USD cost to a per-day spend
  ledger. A Q&A/assess/analyze ticket's `## Result` footer gains a
  `cost=$X.XXXX` field alongside elapsed time and tokens; `/health` gains a
  `spend: {todayUsd, dailyBudgetUsd} | null` field; the dashboard's daemon
  panel prints a `spend $X.XX today` line (`/ $Y.YY budget` once a cap is
  configured).
- `worker.dailyBudgetUsd` (default `0`, disabled): once today's spend reaches
  the cap, the provider gate enters `budget_exhausted` and pauses ticket
  claiming until local midnight or an operator's config hot-reload raises the
  cap — unlike every other gate state, a successful session does NOT clear
  it, since finishing a session doesn't un-spend money.
- `junco doctor` runs a hosted-aware preflight for a catalog-resolved model:
  echoes the resolved provider and base URL, reports the api-key source (a
  `$ENV_VAR` reference, a config literal, or the provider's own environment
  variable), and — when a key is configured — runs a live per-provider auth
  check against the resolved endpoint.
- `junco init` gains a "hosted provider from the built-in catalog"
  model-source option alongside the inline-endpoint and models.json paths:
  pick a provider then a model straight from the embedded catalog, then the
  same shared api-key step (a blank key defers to the provider's own
  environment variable at runtime).

### Changed

- **Behavior:** auth, quota, model-not-found, and rate-limit failures no
  longer consume the ticket's `retry_count` budget. Previously every
  infrastructure failure went through the same budgeted transient-retry path;
  now these four classes are recognized as the provider's fault, not the
  ticket's — the ticket is stamped with a fresh `not_before` and returned to
  the inbox with `retry_count` untouched. Outage (network/5xx) and
  unclassified failures keep the existing budgeted transient-retry path.
- `junco init` is now a full-screen guided walkthrough (Ink): chapter rail,
  machine preflight, live model discovery, repo-containment and GitHub-bridge
  setup, an extras multiselect, a review-before-write step, and a post-write
  flight check. Re-running `junco init` on an existing config enters a tune-up
  mode that pre-fills current values and writes only what changed (all other
  keys preserved). `--yes` still scaffolds the same minimal default config
  non-interactively.

- **Behavior:** a provider-prefixed `model.id` without an explicit
  `model.baseUrl` previously bound to the local default endpoint
  (`http://127.0.0.1:1234/v1`); it now resolves from the builtin catalog.
  Explicitly set `model.baseUrl` (or `model.source: "inline"`) to keep the old
  binding. A provider-prefixed id that is NOT actually in the builtin catalog
  falls through to inline resolution — an explicit `model.baseUrl` +
  `model.apiKey` are then required, and the session build fails with an
  actionable error if the key is missing; endpoint probing is still skipped
  for any catalog-eligible config, including this fall-through case.
- The agent session no longer reads or creates `~/.pi/agent/auth.json`,
  `~/.pi/agent/settings.json`, or a target repo's `.pi/settings.json` — auth
  and settings are fully injected from junco config.

### Removed

- `@clack/prompts` dependency — the old prompt-based wizard is gone, replaced
  by the Ink walkthrough above.

## [0.6.0] - 2026-07-11

### Added

- `junco config path|list|get|set` and an in-dashboard config editor (press `,`), backed by a single lever registry that also powers `junco config list` (#161).
- Daemon hot-reload: live-safe settings apply at the next poll; structural changes surface `pendingRestartFields` in `junco status` / `/health` (#161).
- **Agent execution sandbox (`sandbox`).** Native OS isolation of the Pi agent's tool execution — **Seatbelt** on macOS, **bubblewrap** on Linux, no container runtime, works fully offline. Confines tool writes to the worktree + a per-session scratch dir, denies network by default (per-ticket `network: true` frontmatter opts one ticket in), scrubs credentials (`GH_TOKEN`/API keys) from the agent's environment, applies a read deny-list over `~/.ssh`/`~/.config/gh`/etc., and freezes ambient `~/.pi` extension loading. **On by default**; **fails closed** when a required backend binary is unavailable — never a silent unsandboxed run. `junco doctor` preflights availability. Toggle it (and `backend`/`network`) live from the in-dashboard config editor (`,` → sandbox section) or `junco config set sandbox.enabled false`; changes apply to the next ticket with no restart. Pair with a dedicated GitHub identity for full credential separation (see `docs/operations.md` § Security model) (#160).
- **Two-phase assess with a review queue.** `junco assess` no longer files issues straight from the audit — the daemon **parks** every finding for review, and nothing lands on a tracker until a human confirms the batch (`junco assess review` to inspect, `junco assess file <id> --all | --only <fingerprints>` to file). Filing runs under your own `gh` auth and works on **any watched repo, owned or not** — owned repos get `junco:finding` + `severity/<level>` labels best-effort; repos you don't own get label-free issues. An authoritative dedup re-runs at file time so a finding filed by hand in the interim is skipped, not duplicated (#95).
- **Dashboard assess review view.** Press `v` in the dashboard to open a per-finding checklist with the same select-and-confirm-to-file flow as the CLI (#96).
- **`junco analyze owner/repo#N`** — a read-only issue investigation that parks a comment draft for review and **never posts without operator confirmation**. Shares the issue-target resolution (`gh issue view`, then watched-repo lookup or auto-provision) that dispatch uses (#98).
- **Issue-scoped assess: `junco assess owner/repo#N`.** Steers the audit to the code an issue implicates, auto-provisions an unwatched repo (fork, clone, watchlist add), and stamps each filed finding's body with a `Context: owner/repo#N` cross-reference so it shows up on the original issue's timeline. Dedup stays shared, not scoped — an issue-scoped run and a whole-repo run never double-file the same defect (#99).
- **Two-mode dashboard** with an actionable LOCAL runtime-visibility mode alongside the GitHub-integrated view (#97).

### Changed

- **The execution sandbox is now ON by default** (`sandbox.enabled` defaults to `true`). On macOS this is transparent (Seatbelt is always available). On Linux without `bwrap` installed, tickets **fail closed** with a clear error — install bubblewrap, or set `sandbox.enabled: false` / `sandbox.backend: "none"` (via `junco config set` or the `,` config editor). Run `junco doctor` to preflight. See `docs/operations.md` § Sandboxing the agent (#166).
- **BREAKING:** configuration is now `config.json` (camelCase) instead of `config.toml`; the `smol-toml` dependency is removed. Convert existing `config.toml` files by hand (see docs/configuration.md); junco errors with a pointer if it finds a leftover `config.toml`. Legacy `[pi]`/`[oMLX]` sections are gone — set `model.*` directly; the tool allowlist is now top-level `tools`, and `commit_leftovers` is `worker.commitLeftovers`.

### Fixed

- **Transcripts:** every flow's transcript path routes through one slugifying helper, so a frontmatter id with path-unsafe characters can't escape the transcripts directory (#94, #100).
- **Daemon & queue:** the scheduler drains in-flight tasks in a `finally` on a claim error and the third-signal hard-exit is testable (#142); malformed-frontmatter tickets route to `failed/` instead of looping, with a multi-level requeue collision suffix (#143); claims are guarded against a same-minute overwrite and `submit` uses a unique temp with an exclusive-create fallback (#144); `repoKey` is canonicalized so aliased repo paths serialize (#147).
- **Health & CLI:** IPv6 health URLs are bracketed, `junco list` tolerates a missing queue-box dir (ENOENT), and the health server keeps a persistent error handler (#152).
- **PR flow & GitHub bridge:** an offline soft-abort that made commits now routes to `done/` like its online twin (#146); the outbox embeds its idempotency marker on live comment posts and author-scopes the dedup scan (#148); the bridge vouches issue-body edits, `junco prs` includes external repos, ticket ids are unambiguous, plans are CRLF-normalized, and a null author is guarded (#150); managed external clones + syncs are asserted contained within `externalReposRoot` (#151).
- **Assess & analyze:** a review batch is preserved when every filing fails and an empty `--only` selection is rejected (#149); assess/analyze issue numbers are bounded and branch/base names pattern-checked, with refreshed docs (#154, #155).
- **Agent runtime:** dropped a phantom nudge on an output-budget kill, gated nudge-ignored on delivery, and injected the transcript sink (#153).
- **Service:** non-blocking systemd restart with the stop timeout sized to the max ticket timeout (#145).
- **TUI:** `aliveRef` guards extended to the remaining async handlers, plus a non-TTY `useTerminalSize` fallback (#156).
- **Config hot-reload follow-ups:** `github.triggerLabel`/`askLabel` reclassified `restart` (and frozen so the bridge and reporter can't drift); the watcher single-parses and re-applies `logLevel` only when it changed; stale JSDoc dropped (#167, closes #162–#164).
- **Migration follow-ups:** analyze threads its client's `gh`/`git` deps; the analyze branch uses a no-op reporter so it can never post; the unconsumed `issue_title` is dropped; read-only assess clones fork-lessly (no stray fork); the review store gains read-time shape validation + ENOENT-safe archiving; a transcript-slugify CI flake is fixed; TUI review-view scroll/badge polish (#168, closes #101–#106, #157).

### Security

- **Agent execution sandbox fs-tool path jail hardened against a symlink-swap TOCTOU** (#169, closes #159): bash execution is serialized against the in-process fs tools (only bash can plant a symlink) and bash's process group is reaped, so a compromised agent can't win a check→syscall swap race against the jail. The OS sandbox backend (Seatbelt/bwrap) remains the primary containment; a `setsid`-escaping background process on macOS is a documented residual.

## [0.5.0] - 2026-07-09

### Added

- **`junco-dispatch` skill now recognizes repo-audit requests.** Phrases like "assess this repo" or "have junco audit this repo" route to a new Assess mode that runs `junco assess` (a read-only audit that files one GitHub issue per finding) instead of authoring a plan ticket.
- **Guard & requeue observability.** Guard decisions (nudges, escalations, kills) are logged, recorded in the per-ticket transcript, and counted in run metrics; `junco status` and `/health` surface the requeue and guard counters.

### Changed

- **README restructured GitHub-first.** New tagline (_Issues in. Pull requests out._), a "The loop" walkthrough (label → plan → approve → PR, with the lifecycle labels and a real `junco logs -f` transcript), an assess section, fork-PR mode in the CLI table, and the dashboard mock up front. `package.json#homepage` and the README now point at the project's one-page site, [junco.ironforgesoftware.com](https://junco.ironforgesoftware.com).

### Fixed

- **Bridge:** the plan is recovered from the whole planning-session text when the junco-ticket fence isn't the last message (#86).
- **PR flow:** fork PRs are recovered via `gh pr list --head owner:branch` (#75); only network/transient `gh pr create` failures requeue (#73); a pushed branch with no PR is recovered instead of stranded; an offline amend's push reports as queued, not unqualified success; `ls-remote` selects the exact ref sha, never a sibling ref (#72); fresh-mode resume is gated on crash-recovery provenance (#70); the fresh-mode fallback branch force-resets to `origin/<base>`.
- **Locking:** one shared, hardened pidfile-lock helper — atomic stale-steal via rename-aside with post-move verify, ABA-steal and pid-reuse protection, a locale-stable `ps` start-time discriminator, and a fallback for filesystems without hard-link support.
- **Outbox:** the finalize tail survives when a created-PR op dead-letters, and the flush lock is hardened against ABA steal and pid reuse.
- **Assess:** code findings are fingerprinted by line bucket with a normalized title — dedup survives code drift and retitles — and findings parse from the whole run's text, not just the last message.
- **Agent sessions:** a fallback grace deadline aborts wedged sessions; repetition-guard buffers clear after a nudge; `RunResult.finalText` is the last assistant message, not the whole run; transcript paths slugify the frontmatter id; subscribe-callback observability is guarded against throws.
- **Queue & dispatch:** ticket placement is atomic (`linkSync` EEXIST, not check-then-act), and same-named terminal records uniquify instead of overwriting.
- **Service & config:** systemd units escape `$` and `%` per field-expansion rules and double-quote `ExecStart`/`Environment` values; an empty `health_host` normalizes to loopback, and non-loopback binds warn at startup and in `junco doctor`.
- **Logging & verification:** `worker.log` rotates mid-run as a single-writer, lock-holder concern; verification blocks are capped in count, bounded in aggregate wall clock, and run with a scrubbed child environment.
- **Daemon & schema:** the stop flag is re-checked before claiming in the serial poll loop; the ticket contract bounds `timeout_minutes` (> 0) and `amends_pr` (≥ 1).

## [0.4.0] - 2026-07-06

### Added

- **GitHub-integrated inbox mode.** Trigger-labeled GitHub issues are **planned first, then executed**: the daemon sweeps watched repos (`[github]` config section, default off — zero GitHub calls when disabled), verifies the labeler has write access (fail-closed), and dispatches a daemon-authored planning ticket built from the `junco-dispatch` skill's template (read-only session at the mapped clone; `planner_model_id` optionally plans with a different model). The plan is posted back as one editable issue comment for review; a write+ collaborator applies `junco:approved` to authorize execution (or set `require_approval = false` to auto-execute — recommended only for trusted private repos), and Junco then reads the (possibly edited) plan back out of the comment to build the execution ticket. Silent lifecycle labels track every step (`junco:planning/plan-ready/approved/queued/working/done/failed/denied`), and exactly one finalize comment lands per hop (the plan, or the PR link + summary / Q&A answer / failure reason). PR bodies gain a deterministic `Closes owner/repo#N`; an ask label skips planning entirely and routes straight to the read-only Q&A path; sub-issue parents are attached as background context for the planner. `junco doctor` validates repo mappings (clone exists, origin matches, reachable via `gh`) and that the planner template is readable; `junco status` and `/health` report bridge sweeps.
- **Ticket schema (additive):** worker-managed `github` provenance block and `workdir` (Q&A session cwd, validated against `allowed_repo_roots`).
- **`junco dashboard`** — an interactive terminal UI for GitHub-integrated mode: a repos pane with per-state issue counts, an issues pane with lifecycle glyphs, and a status bar with daemon health, plus in-terminal plan review before dispatch/approve/re-plan. Repos can be added or removed at runtime through a hot-reloaded watchlist file (no daemon restart) that lives alongside, and defers to, `config.toml`'s repo mappings.
- **`junco restart`** — restart the supervised daemon (picks up config + code changes): discovers the launchd/systemd user unit whose invocation references your config path, kicks it with the platform-correct verb (`launchctl kickstart -k` / `systemctl --user restart`), validates the config first (never bounces onto an unparseable config), and verifies the pid changed.
- **Dashboard command palette + focus keys** — `:` opens a palette that runs junco CLI subcommands from inside the dashboard (spawns the real CLI against the same config; output + exit code in a scrollable pane; args field for `list`/`retry`/`submit`/`logs`/`service`; `logs` bounded; `init`/`start`/`dashboard` excluded with reasons). `w` opens add-repo (the watchlist key); `i` jumps to the issues pane; a persistent context-aware shortcut bar shows the full key set at all times. Add-repo can auto-clone: leave the path empty and the repo is cloned into a managed directory under the state dir, then validated and watched as usual.

## [0.3.0] - 2026-06-10

### Added

- **Self-healing retries.** Transient failures (endpoint errors, truncated streams) with no commits requeue the ticket with backoff (`[worker].max_transient_retries`, default 2; worker-managed `retry_count`/`not_before` frontmatter). Crashed tickets found in `processing/` at startup requeue under the same budget instead of failing.
- **Endpoint-aware claiming.** The daemon probes readiness before every claim — an endpoint outage queues work instead of burning the inbox into `failed/`.
- **Timeout salvage.** Sessions that hit the ticket timeout after committing get their commits pushed and a draft PR opened (new terminal status `timeout_partial`, routed to `done/`) with a partial-run banner.
- **Force-stop.** Second SIGTERM/SIGINT aborts the in-flight session and salvages commits; third hard-exits. Rendered service units now set `ExitTimeOut`/`TimeoutStopSec` sized to the ticket timeout so supervisors don't SIGKILL a draining worker.
- **Day-2 CLI:** `junco status`, `junco list [box]`, `junco retry <name…|--all>`, `junco doctor`, `junco logs [-f] [-n N] [--json]`.
- **Concurrency.** `[worker].max_concurrent` (default 1) runs tickets in parallel with per-repo serialization and graceful drain; `/health` reports `currentTickets`.
- **Observability.** Structured logs tee to `<state_dir>/worker.log` (10 MB rotation) with a human-readable TTY format; per-ticket transcripts under `<state_dir>/transcripts/`; live progress (turns, last tool, output tokens) in `/health` (`currentProgress`).
- **Per-ticket `tools:` override** — Q&A tickets stay read-only by default and can opt into more (e.g. `tools: [read, grep, bash]`).
- **`[git].allowed_repo_roots`** confines PR-flow tickets to approved repo roots; the README now documents the inbox trust model.
- `not_before` frontmatter — schedule a ticket for later (also the worker's retry-backoff mechanism).
- Plain (non-Obsidian) ticket templates under `templates/plain/`; CI test workflow on push/PR; prettier + eslint (`no-floating-promises`).

### Changed

- User-level config discovery: `--config` → `./config.toml` → `~/.config/junco/config.toml` (the wizard writes the user-level path by default, so `junco` works from any directory).
- Stack-agnostic naming: daemon logs say "inference endpoint"; bare model ids default to the `local` provider (previously `omlx`).
- The diff-vs-spec critic is told when its diff was truncated, preventing false MISSING verdicts on very large diffs.
- The Pi event stream is typed at the session boundary (`AgentEvent`).

### Fixed

- README troubleshooting referenced the legacy `[oMLX].url` key instead of `[model].base_url`.
- Stale-worktree cleanup failures now surface as a clear `GitOpError` instead of a raw fs error.

## [0.2.2] - 2026-06-01

### Added

- Colorized `junco init` wizard (via `@clack/prompts`): boxed prompts and an arrow-key model picker that **discovers models from your endpoint** (`GET /v1/models`) or lists the entries in a Pi `models.json`, with a spinner while it fetches. Falls back to manual entry when the endpoint is unreachable.
- Graceful cancel: Ctrl-C / Ctrl-D during setup exits cleanly (exit 130, no stack trace).

### Changed

- The wizard now writes `junco_subdir = ""`, so the queue lives directly under the chosen directory (default `~/Junco/{inbox,…}`) — no redundant `Junco/` subfolder. Existing configs are unaffected (the schema default stays `Junco`).
- Removed personal-stack strings from the shipped surface — wizard prompts, the legacy `[pi].model_id` fallback default, and doc-comment examples now use neutral placeholders. The wizard infers the provider label from the endpoint host.

## [0.2.1] - 2026-06-01

### Changed

- Pinned all dependencies to exact versions (removed `^` ranges) for fully reproducible installs.
- CI: bumped `actions/checkout` → v6 and `actions/setup-node` → v6, and the publish runner to Node 24 — clears the Node-20 runner deprecation warning.

## [0.2.0] - 2026-06-01

### Added

- **Interactive setup wizard.** `junco init` now prompts for the vault directory and model (an OpenAI-compatible endpoint, or a Pi `models.json`), **writes `config.toml`**, and creates the queue directories — no more hand-writing the config. `--yes` scaffolds defaults non-interactively (for CI/scripts).
- **First-run-aware bare invocation.** `junco` (or `npx @ironforgesoftware/junco`) with no config present runs the setup wizard; with a config present it starts the daemon as before. A non-TTY guard prints guidance instead of hanging on a prompt in pipes/CI.

### Changed

- `junco init` no longer requires a pre-existing `config.toml`; when one already exists it just ensures the queue dirs and never overwrites it.

## [0.1.0] - 2026-05-31

### Added

- Configurable model + inference provider via a `[model]` config section — the API style, context window, max tokens, thinking format, and the rest of the model's capabilities are configurable, so junco can drive any model on any Pi-supported provider (OpenAI-compatible, Anthropic, Google, Bedrock, …). Two modes: point `[model].models_json` at a Pi-style `models.json` to load the provider+model from that file, or describe it inline with `[model]` fields. The legacy `[pi].model_id` and `[oMLX]` keys still work as fallbacks for `id` / `base_url` / `api_key`.
- Daemon (`junco start`) with configurable poll loop, single-instance lock via PID file, orphan recovery on restart, and graceful SIGTERM/SIGINT shutdown.
- PR flow: per-ticket git worktree isolation, plan-lint gating (validates frontmatter + discipline rules before the agent runs), loop guards via the supervisor (per-kind budgets, escalation-window turn cap, per-turn and post-commit output budgets), `## Verification` bash-block runner (executed in the worktree after the agent session, results surfaced in the PR body), diff-vs-spec critic pass with one configurable corrective re-dispatch, `gh pr create` integration, and amend mode (`amends_pr`) for adding commits to existing PRs.
- Q&A ticket mode: tickets without a `repo:` field are answered in-place by the agent with no git operations.
- Embedded coding agent over any OpenAI-compatible inference endpoint (`[oMLX]` config section); agent driven via the `pi` SDK with a configurable tool allowlist and per-ticket timeout.
- Observability: `/live`, `/ready`, and `/health` HTTP endpoints; per-run metrics (turn count, output tokens, elapsed time); structured JSON logs; configurable log level (`debug` | `info` | `warn` | `error`).
- Dispatch CLI: `junco submit <ticket>` (enqueue a ticket), `junco inbox-path` (print the inbox directory), `junco schema` (print the ticket-frontmatter JSON Schema), `junco init` (scaffold `~/junco/config.toml`), `junco service` (render a launchd plist or systemd unit for the daemon).
- Typed ticket-frontmatter contract validated with Zod; all fields documented in the schema subcommand output.
- Harness-agnostic `junco-dispatch` Claude Code skill for scaffolding plan-lint-clean tickets from natural-language prompts.
- Service rendering for launchd (macOS) and systemd (Linux) via `junco service`.
