# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- On the dashboard, `t` on a GitHub issue opens the transcript of the ticket the bridge built for it — live-following while the run is in flight — so a labeled issue can be watched without hunting for its row in the queue section (#330). Works from the issue list and from the open issue detail view; a toast explains when nothing is in flight for that issue (`enter` still opens the issue body).
- Apply tickets: a ticket body carrying a `junco-patch` fence (a `git format-patch` mbox series) executes with zero model turns — `git am --3way` applies AND commits the series directly in the worktree, so the series' own commit messages become the PR's commits, in order. Verification (`## Verification`) still runs and still gates the PR; the critic pass is skipped, since the diff already is the spec. A conflict fails the ticket outright rather than requeuing it (a conflict is deterministic, not transient), with the `git am` output folded into the failure note and the worktree preserved for inspection. New `junco lint`/`submit --dry-run` rules: `patch_parses` and `patch_paths_sane` (errors — a malformed series, or one touching traversal/absolute paths or carrying a binary hunk) and `patch_has_verification` (warning); the prose rules are skipped for these tickets. See [Apply tickets](docs/tickets.md#apply-tickets).
- Apply tickets gain a one-shot escalation ladder, gated by `worker.applyFallbackToAgent` (default **true**): a failed `git am --3way`, or a clean apply whose `## Verification` block then fails, dispatches exactly one agent session instead of failing the ticket — the patch series handed to the agent as a specification to implement against the current tree, plus the failure detail, never as bytes to replay. Because a fallback breaks the GitHub route's byte-identical approval guarantee (a human's trigger label approved a specific diff, not whatever the agent produces instead), the PR body carries an explicit disclosure banner whenever it fires, and the critic pass — skipped on a clean apply — runs again once an agent has touched the ticket. Set the lever to `false` for the old hard-failure behavior. See [Tickets § Escalation ladder](docs/tickets.md#escalation-ladder-when-a-patch-does-not-apply-cleanly) and [Configuration § Apply-ticket fallback](docs/configuration.md#apply-ticket-fallback).
- `junco submit --patch <file> --repo <path> [--title T] [--why W] [--verify CMD]` composes and submits an apply ticket directly from an existing `git format-patch` file — no hand-authored `junco-patch` fence required — and composes into the same `--as-issue`/`--dry-run` routing as a file-sourced ticket.
- The `junco-dispatch` skill now teaches apply-mode authoring: a drafting-time mode question (does the agent already know the exact bytes to land?), a dedicated "Apply mode (patch tickets)" section covering how to produce a series, the fence-length rule, when not to use it, and what the fallback means for the byte-identical guarantee, plus a minimal apply-ticket shape in `TEMPLATE.md`.
- Apply-ticket execution now shows up in observability: each pull-request-kind task-history record (`<dataDir>/data/history/tasks-YYYY-MM.jsonl`) carries a `mode` field — `"apply"` (clean apply, no fallback), `"apply_fallback"` (either escalation rung fired), or `"agent"` (an ordinary agent-driven ticket) — so the wall-clock/token difference between modes is queryable instead of inferred from logs. Apply runs also now write a transcript: `junco_meta` + a `junco_run_start` (`flow: "apply"`) + a `junco_run_end` frame bracket the `git am` attempt on both the success and the failure path, and a failed-then-escalated ticket's fallback session appends to the same file — one chronological record, not two.
- Apply tickets can now be claimed while the inference endpoint is unreachable or the provider gate is latched — `claimNextTask` narrows an otherwise-blocked claim pass to just the eligible apply tickets instead of leaving the whole inbox untouched, since `git am` needs neither the endpoint nor a provider quota. The daemon's startup endpoint wait is unaffected (this narrowing is per-claim only), and a claimed apply ticket whose patch then fails to apply can still fail on the fallback's own agent session being unable to reach the same downed endpoint — cleanly, bounded by the existing transient-retry cap. See [Operations § Inference endpoint unreachable at boot](docs/operations.md#inference-endpoint-unreachable-at-boot).

### Changed

- Dashboard idle cost: a poll that delivers unchanged data no longer commits an Ink frame — every poll sink keeps its previous state on structural equality, and the age clock ticks on its own 5 s interval instead of every queue poll. Sub-minute "Ns ago" strings now step in 5 s increments. Spinners share Ink's animation timer, and the dashboard renders incrementally so an animation frame rewrites only changed lines. A frame-level perf test (`tests/framePerf.test.tsx`) pins zero frames per constant-data poll tick.
- Corrects four Stage-1 apply-tickets claims that the escalation ladder above supersedes, all previously stated as unconditional facts about every apply ticket and now true only for a clean apply with the fallback lever left untriggered: (1) apply runs are **not** transcript-less — `docs/tickets.md`/`docs/github-mode.md` said an apply ticket runs no agent session so `junco transcript`/the dashboard's transcript view have nothing to show for it, but apply runs now write their own transcript frames (see the Added entry above); (2) a conflict does **not** always fail the ticket outright — with the fallback lever on (the default) it escalates to an agent instead; (3) the critic pass is **not** always skipped — it runs again once either escalation rung fires; (4) "no agent session runs" and "leftovers are never swept" hold only until a fallback fires, after which the ticket is an ordinary agent ticket for the rest of the pipeline. `docs/github-mode.md`'s claim that labeling a parked apply-mode issue approves "the exact diff that will land" is corrected the same way: labeling approves the diff shown in the issue, which is what lands only when it applies cleanly.

- A parked `--as-issue` body now carries the plan **once** — rendered markdown wrapped in invisible `junco:ticket` delimiters — instead of a rendered copy plus a collapsed machine fence (#329). Half the issue size, no desync surface between the two copies, and editing the parked plan in GitHub's UI before applying the label now edits exactly what runs. The bridge reads markers first and still falls back to a `junco-ticket` fence, so issues parked by older versions launch unchanged; `--as-issue --plan` keeps its fence (YAML payload). Mixed-fleet note: an older bridge sweeping an issue parked by a newer CLI finds no fence (markers are invisible to it) and routes the issue to the planner instead of queueing the parked plan verbatim — upgrade the daemon before parking with a newer CLI.
- The `junco-dispatch` skill drops authored boilerplate the CLI and worker now own: the per-ticket `created:` timestamp, running `junco lint` again after a clean `dry-run` (whose output already carries the full lint verdict), the separate monitor-the-ticket and repo-target-confirmation `AskUserQuestion` asks (monitoring is now folded into the same call as the dispatch preview; the repo target is confirmed by the preview's `repo:` line instead of a standalone question), the unconditional `EXAMPLE.md` read before drafting (now conditional on an unfamiliar plan shape or a prior structural lint failure), and authoring-time `gh label list` pre-checks (labels are validated by dry-run/lint's own `labels_exist` check instead). The preview itself is now codified as a curated essence — key design decisions, a Files/Steps summary, and the dry-run's destination/reason/carried/discard/timeout lines — plus the temp-file path for full reading, never the raw ticket body.
- The worker's prompt preamble now carries the full strict working discipline (trust-the-ticket, no-scope-expansion, graceful-stop-on-mismatch, final-summary) for every run, so `TEMPLATE.md` and `EXAMPLE.md` no longer ship an authored "Notes for the agent" block and plan-lint's `notes_block_present` rule is retired. An existing ticket that still carries a Notes block stays valid — it's simply wasted tokens now, not a required section.
- **Breaking:** `junco dispatch` is renamed `junco import`, `junco assess` is renamed `junco audit`, and `junco analyze` is renamed `junco investigate`. The old verb names are gone, not aliased — running any of them now prints a usage error and exits `2`; scripts, muscle memory, and the `junco-dispatch` skill all move to the new names. Every CLI usage line, `doctor`/`status` label, dashboard mnemonic (`u` audit, `n` investigate, `m` import), and doc reference has moved with them; the guide pages move too (`docs/assess.md` → [docs/audit.md](docs/audit.md), `docs/analyze.md` → [docs/investigate.md](docs/investigate.md)).
- Ticket frontmatter gains `audit:`/`investigate:` as the canonical mapping names for the renamed flavors (authored by `junco audit`/`junco investigate` respectively). The legacy `assess:`/`analyze:` keys are **permanently accepted** as aliases — never removed — so tickets and tooling authored against the old names keep working; when a ticket carries both the old and new key, the new one wins. See [Tickets § Key frontmatter fields](docs/tickets.md#key-frontmatter-fields).
- The `junco-dispatch` skill decomposes a plan into a ticket set on four seams in the work — independent reviewability, an ordering dependency, separate verification, or mixed certainty — instead of the old ">180 min → decompose" clock rule; `timeout_minutes` is now sizing for an already-scoped ticket, not the decomposition trigger. The skill also states the audit-vs-investigate distinction plainly (audit sweeps a repo into findings that become issues; investigate deep-reads one issue into a comment) and distinguishes its own "dispatch to junco" act from the CLI's separate `junco import` verb.

### Fixed

- The phantom `todo_write` call: both the fresh and amend worker preambles instructed the agent to call a `todo_write` tool that does not exist in the agent layer, wasting a failed tool call whenever the agent obeyed. The instructions and the dead `todo_write` loop-guard threshold that referenced it are removed.

## [0.12.0] - 2026-08-30

### Added

- `junco lint <file>` validates a ticket — plan-lint plus repo/branch preflight (repo path exists and is a git repo, origin remote exists and is GitHub, the derived branch is not already on origin, frontmatter labels exist on the repo) — without submitting it.
- `junco submit --dry-run <file>` reports the routing verdict (`destination: issue|inbox` plus a `reason:` per cause), on the issue route the `watched:` repo, the `carried:`/`would discard:` frontmatter and the effective `timeout:`, and the same lint results as `junco lint` — all without writing anything.
- Bounded `timeout_minutes` carry through `submit --as-issue`: a valid value is now clamped to 1–480 minutes and stamped as a marker in the vouched issue body by the bridge's fence door, instead of always falling back to the daemon's default.
- `sandbox.bashTimeoutSeconds` (default 600, 0 = none): a wall-clock ceiling on one sandboxed `bash` call when the agent passes no `timeout`. The agent's explicit `timeout` wins when positive and finite; a zero, negative or malformed value falls back to the ceiling. Live-reload lever (`junco config set sandbox.bashTimeoutSeconds 900`).
- Transcript viewer. `junco transcript <ticket-id|path.jsonl> [--thinking] [--tools] [--width N] [--json]` prints a ticket's recorded event transcript — one header per run (flow, model, outcome, duration, tokens; the error line for a failed attempt), each turn's text, and every tool call with a one-line result summary (`--tools` prints the bodies, `--thinking` the model's reasoning). The dashboard opens the same view with `enter` on any running or recent queue row: `j`/`k` move over tool calls, `enter` expands a result inline (capped at 400 lines), `t` toggles thinking, and a running ticket's transcript follows live (`f`/`G` follow, scrolling pauses) until the run ends. RUNNING queue rows are now selectable for this; retry/delete stay inert on them.
- Plan-driven ticket sets: tickets gained `depends_on:` frontmatter (with worker-managed `deps_satisfied` stamping), and the worker now claims a ticket only after every dependency has finished AND its PR — when one was opened — has merged, checked by a throttled dependency sweep in both the serial loop and the scheduler. A failed dependency cascades its dependents to `failed/` with a `dependency_failed` marker naming the edge, and `junco retry <parent>` resurrects the cascaded dependents transitively. `junco list`, `status` and `submit` surface dependency state, and `submit` warns on a `depends_on` that names nothing queued or finished — sets may arrive out of order, so it never refuses.
- Plan-set compiler, behind the new `[planSets]` config section (`enabled` — default false, `mergePollSeconds`, `maxTasks`): one fenced `junco-plan` document compiles into a dependency-ordered ticket set — each task its own ticket and pull request, executed via the `depends_on` machinery above. Two doors: `junco submit --plan <file> --repo <path>` locally, and — with the GitHub bridge — a labeled issue whose vouched body carries a `junco-plan` fence or whose planning session emits one. An edited, re-approved plan supersedes the previous revision's unclaimed tickets; the sweep maintains a plan-set dashboard comment, lifecycle labels, and a degraded-mode comment when compilation fails.
- `junco submit --as-issue <file>` (`--as-issue --plan <file> --repo <path>` for a plan-set fence) files a locally-authored ticket as a **parked, unlabeled** GitHub issue instead of dropping it in the inbox — bot-authored (requires `botAccount.enabled`), refused unless the target repo is owned, bridge-watched, and GitHub integration is enabled. No labels are applied; a human's own trigger label is what launches it later. The GitHub bridge's labeled-issue sweep gained a matching precedence door: a vouched issue body carrying a `junco-ticket` fence (or, with `planSets.enabled`, a `junco-plan` fence, checked first) now queues verbatim — skipping the planning session entirely — while ask still wins over any fence and a fenceless body still falls through to the planner unchanged. Zero new config keys: the planner remains the fence _producer_ for issues that arrive without one, not a route. The ticket's `repo:` may be the watched clone path or the operator's own checkout of a watched repo (matched by its `origin`). For a plain fresh single ticket, the `junco-dispatch` skill takes this route by default whenever GitHub integration and the bot account are on and the target repo is bridge-watched (amend tickets and hand-authored `depends_on` sets stay on the inbox; `junco-local:` forces the inbox; "park it on github" / "junco as issue: …" / "dispatch as issue" force the issue).
- `JUNCO_CONFIG` names the config file explicitly, for scripted, CI and sandbox contexts. It overrides the canonical `~/.junco/config.json` (a leading `~` expands; the value must be absolute — a relative value is rejected with an error; an empty value is ignored), and the daemon's `worker.lock` follows it — so two configs each take their own lock. **They are independent instances only if they also set different `dataDir`s**: the lock sits next to `config.json`, not under the data root, so two configs over one `dataDir` take two independent `worker.lock`s that never see each other — it's the shared-root claims below (#310) that stop the second one from actually starting. See `docs/configuration.md`. The overridden config is denied to the agent sandbox alongside the canonical and legacy ones.
- The daemon now writes `metrics.json` into the data tree (`<dataDir>/data/metrics.json`; `<dataDir>/metrics.json` on a pre-0.10 `flat` root) — the counters `junco status` and the dashboard read over `/health`, persisted for out-of-process readers. Written atomically, debounced, and stamped at startup and shutdown; a write failure is logged and never interrupts the worker.

- Split-queue detection (#274): `junco start` warns at startup — ahead of both destructive recovery steps (`recoverOrphans`, `pruneStaleWorktrees`) and ahead of the endpoint wait, so the operator sees the mismatch before the daemon acts on the wrong root — and `junco doctor` reports a matching warn when the resolved queue's `inbox/` is empty while another queue root this installation could own still holds pending tickets. The roots enumerated are the canonical `~/.junco/queue`, the legacy `~/.local/state/junco/queue` data root, and whatever `queueRoot` resolves to on this run (labeled `configured` when it is neither of those — a vault or an explicit `dataDir`/`stateDir` override lands here), deduped by resolved path. A root that is no longer the resolved one is **not** checked and cannot be: a vault or explicit override is folded into `queueRoot` by config assembly and not retained separately, so an abandoned one leaves no path behind to look at. Only `inbox/` is counted: a completed `junco data migrate` leaves the legacy `done/` populated forever, and a warning that fires on every start is one operators learn to ignore. An all-empty (fresh) install stays silent, and the check never moves an exit code — a split queue is an operator decision, not a broken install.
- `junco start` now claims two additional pidfiles in the shared state a daemon actually contends for, without moving `worker.lock` (#310): `<dataDir>/daemon-tree.lock` and `<queueRoot>/daemon-queue.lock`. `worker.lock` alone only catches a second daemon resolving the _same_ config file — two configs sharing a `dataDir` (or, via a legacy `vaultRoot`, sharing a queue with two different data roots) previously took two independent `worker.lock`s that never saw each other, and both ran, polling one queue. Now the second `junco start` refuses outright, printing the shared root, the claim file, and the first daemon's pid; there is no `--force` escape hatch for `start`. The refusal **exits 0**, like the existing `worker.lock` refusal and for the same reason — the rendered service units restart on failure, so a non-zero exit would respawn-loop a misconfigured second unit every 30 seconds forever; the message carries the loudness and says the daemon did not start. All three pidfile paths are resolved through symlinks, so two configs that reach one data root or queue by different names collide on one claim rather than taking two and both starting. `junco doctor` surfaces the conflict as a `daemon claim` warning naming the root, the holding pid and the claim file — the refusal itself is written before the log sink opens and never reaches `worker.log` — and `junco restart` / bare `junco` point at `doctor` when the daemon never comes up. `junco data migrate`'s daemon-up guard gained the same two claims as a third signal alongside its existing `/health` and `worker.lock` checks, closing the matching blind spot where a `JUNCO_CONFIG`-overridden peer's pidfile sat somewhere migrate never looked; a new phase also clears (and never touches a live one) a claim left behind by a crashed daemon, before it can be mistaken for real queue or data content by a later conflict check. Two incidental fixes rode along: `junco doctor`'s daemon check now normalizes the config path like every other lock-path reader, instead of reporting a live daemon as "not running" for a relative config path; and a pre-existing leak where a throw between acquiring `worker.lock` and entering the main loop left it behind for the next start to steal is closed by releasing every pidfile claim from one outer `finally` — which now also covers the two claim acquisitions themselves, and, in `junco data migrate`, the stale-claim sweep's own `migrate.lock`s.

### Changed

- The `junco-dispatch` skill now delegates destination and validation to `submit --dry-run` / `lint` instead of probing config and re-deriving the verdict itself, previews quote the dry-run's carried/discarded frontmatter and effective timeout before approval, both destinations now offer to monitor the ticket through to completion, and every dispatch ends with a machine-checkable `DISPATCHED <id> -> <destination>` line.
- The `junco-dispatch` skill's preview gate is now destination-templated: the `Yes, dispatch` option's description must be copied from a per-destination template (`Park as a GitHub issue on <owner>/<repo> — nothing runs until a human applies the trigger label.` vs `Submit to the local junco inbox — the worker claims and runs it within ~15s; no further gate.`), so the approval prompt itself names where the ticket goes. Previously the destination lived only in a free-text line before the preview plus the question sentence, and a dispatching model could present an inbox-worded gate for an issue-routed dispatch.
- `junco data migrate` reports what it did more honestly (#281). **Two user-visible changes:** on a machine where the canonical and legacy roots both hold a subtree pending the _same_ destination, the first run now exits **1** with a `skipped-conflict (contended source)` naming both sources, where it previously exited **0** and silently left the legacy straggler unplanned for a later run to fail on — the old success was the bug. And `junco data --json` gains an always-present top-level `pendingConfigRelocation: {from,to} | null`; no existing key changed, and it is deliberately kept out of `pendingMigrations`, which also carries doctor's unmigrated data dirs. Alongside those: an interrupted cross-device copy now records itself, so a later run names the obstruction instead of reporting a generic "destination already exists"; a failure right after the config relocation no longer prints `config: nothing to relocate` about a file that just moved; gh-creds conflicts print under their own heading instead of the data-root one; the `--dry-run` preview no longer promises a legacy-root removal the acting run would skip; and `junco doctor` and `junco data` now surface a pending config relocation the way they already surfaced pending data pairs — except under `JUNCO_CONFIG`, where an explicitly-named config is deliberately never relocated and a warning could never be cleared.
- The setup walkthrough now refuses to run on the **fresh** path when this machine already has a junco (#273), instead of scaffolding a competing config: bare `junco` (or `junco dashboard`) with no config at the resolved path exits 1 when a daemon is live — the `worker.lock` holder beside the config, or a `/health` answer on the defaults — or when the resolved data root is already populated. Each refusal names what it found, the config path it expected, and `junco doctor` — the one diagnostic that still works with no config, since `junco status` and friends load it unconditionally and would die with a fatal ENOENT in exactly the state the refusal prints in. The populated-tree refusal additionally offers `junco config init` to scaffold at that path deliberately; the live-daemon refusal does not, and should not be "reconciled" to match — `config init` is ungated and would write the very competing config this guard exists to prevent when HOME is what moved. The **re-run** path is deliberately never gated: it rewrites the same file it read, so it cannot split a queue, and with no `junco setup` subcommand it is the only door for repairing a broken config.
- Upgraded `@earendil-works/pi-coding-agent` to 0.84.2. Session creation migrated from the removed `authStorage`/`modelRegistry` options to the SDK's async `ModelRuntime`, with the operator's API key supplied through a junco-owned in-memory credential store — it still never reaches disk or the agent's environment. Operator `models.json` files using `compat.sendSessionIdHeader` must switch to `sessionAffinityFormat` (removed upstream in 0.80.7).

### Fixed

- Thinking level now reaches chat-template models: the default thinking format emitted only enable/preserve-thinking flags and never forwarded `reasoning_effort`, so on templates that steer thinking depth through that kwarg every configured `model.thinkingLevel` silently ran at the template's own default. The default is now the generic chat-template format with declared kwargs, and the new `model.thinkingLevelMap` leaf (+ lever) collapses junco's six levels onto the template's vocabulary; `examples/config.json` drops its explicit `thinkingFormat` so copies inherit the fixed default.
- **Sandbox: the agent could not `git commit`.** junco runs the agent in a _linked_ worktree, whose index/HEAD live in `<repo>/.git/worktrees/<name>` and whose commits write `<repo>/.git/objects` and `refs` — none of it under the cwd, which was the only writable root besides scratch. The first commit died with `fatal: Unable to create '<repo>/.git/worktrees/<name>/index.lock': Operation not permitted`, and an agent that went looking for a writable path could burn the whole ticket timeout on it (#320). `resolveSandbox` now asks `git rev-parse --git-dir --git-common-dir` in the cwd at session start and adds exactly what a commit needs to the writable roots — the worktree's gitdir plus the common dir's `objects/`, `refs/` and `logs/`, creating a fresh clone's missing `logs/` first because bubblewrap aborts on a missing bind source; a standalone clone adds nothing. The common dir itself — `hooks/`, `config`, `info/`, `packed-refs` — stays unwritable, so an agent cannot plant a hook or a `core.hooksPath` that junco's own unsandboxed git calls would execute at daemon privilege; an in-session `git config`, `gc`, `pack-refs` or ref deletion fails loud instead (none is needed). docs/operations.md states the posture. The automatic grant needs git ≥ 2.31 (`--path-format=absolute`); on older git the resolver detects the echoed flag and keeps the cwd-only policy. The integration suite now commits for real inside the sandboxed worktree on both backends.
- **Sandbox: a killed bash command looked like a success, and the agent's `timeout` was off by 1000×.** Pi hands a custom `BashOperations.exec` the model's `timeout` in seconds; junco fed it to `setTimeout` as milliseconds, so `timeout: 60` killed after 60 ms. And after any kill (timeout or abort) junco resolved `{ exitCode: null }`, which Pi's tool treats as success — the agent saw a truncated result with no status. `exec` now converts seconds, applies the new default ceiling, and rejects with the same `timeout:<secs>` / `aborted` errors Pi's own backend throws, so the tool reports "Command timed out after N seconds" / "Command aborted". Found while diagnosing #320, where an unbounded `grep -r` over a source tree pinned the worker for the whole 60-minute ticket timeout. Limits above 2 147 483 s (Node's setTimeout ceiling) are clamped rather than firing after 1 ms, and a reaped command whose escaped descendant keeps the stdio pipes open now settles on exit plus a short grace instead of hanging until the ticket timeout.
- **Sandbox (macOS): the agent's `git` could not run at all.** Since the data root started being denied wholesale, `git rev-parse`, `git status` and `git diff` failed inside the agent's own worktree with `fatal: Invalid path '<dataDir>': Operation not permitted` — every PR ticket, on the default configuration (`sandbox.enabled` defaults to true, `backend` to `auto`). junco gives the agent a _linked_ worktree, so its `.git` is a file pointing at a gitdir under the denied data root, and git resolves that path by `lstat`ing every component; the Seatbelt profile denied `file-read*` on the root, which denies `lstat` too. Reading files kept working, which is why nothing caught it. The generated profile now grants `file-read-metadata` on exactly the denied directories that are path components of an allowed path (two of them under the v2 layout, one under flat) — `stat()` on those directory nodes and nothing else: their listings, their contents, and every receipt, `config.json`, transcript, queue entry, mirror and github-cache under them stay denied. Linux/bubblewrap and the in-process path jail were never affected — bubblewrap masks a denied directory with a tmpfs, which leaves the node stattable. `junco doctor` and the real-backend integration suite now run `git` under the generated profile in both data-tree layouts.
- `junco doctor` now preflights the sandbox _policy_, not just backend availability. A configuration that `buildPolicy` refuses (an allow-back or writable root sitting above a by-name denied file — a `git.worktreeRoot`, `github.externalReposRoot`, `sandbox.extra_allow_write` or `JUNCO_CONFIG` pointed into the wrong tier) used to report healthy and then fail 100% of tickets at sandbox setup. It is now a `✗ sandbox policy` failure carrying the same actionable message, and that message now names `JUNCO_CONFIG` — a verified trigger it used to omit — and says plainly that the refusal is sandbox setup rather than something the ticket did.
- Skill links: `junco skill install` now decides its exit code and its per-line output from structured report entries instead of prefix- and suffix-matching rendered warning strings, so rewording a message can no longer silently change behaviour; the wizard and the CLI compare harness directories by one normalized rule, so an already-consented harness no longer renders unchecked on a rerun (or gets written twice in two spellings); and the setup walkthrough now surfaces skill-link failures instead of discarding them. One observable side effect of the structural comparison: `junco skill install --harness <x>` no longer exits non-zero for a failure on an unrelated harness whose path merely shares a string prefix with a requested one (e.g. a sibling `skills-extra` directory) — the old rule matched raw string prefixes against the rendered warning text, the new one matches harness directories exactly.
- Sandbox: plan-set records (`plans/`, `data/plans`) and `migrate.lock` are now denied to the agent sandbox. The plan-set records directory joined the data tree with the plan-sets work but was never added to the sandbox deny list, leaving control-plane state (repo paths, issue numbers, task ids) agent-readable. A new classification test fails if a future data-tree entry is added without being denied or explicitly exempted.
- Plan sets: a dependent ticket no longer claims while its dependency's PR is still queued for offline delivery — the offline endgame now records a machine-readable `pr_queued` marker, the dependency sweep waits on it, and the outbox writes the real `pr_url` back onto the finalized ticket when the PR opens.
- Plan sets: the maintenance sweep stops probing the plan comment of sets closed more than 30 days ago, so its per-sweep GitHub cost no longer grows with every set ever created.
- Plan sets: a disposed child now renders as `superseded` on the dashboard instead of counting as a failure; a deferred supersede no longer skips the record's whole maintenance sweep; a child stranded by a fan-out failure is retried instead of waiting for another plan edit; `junco submit --plan` supersedes the previous revision's unclaimed tickets on a re-run and prints real destination paths; and the plan compiler now refuses smuggled frontmatter delimiters in every free-text field plus code fences in `verification`.
- `junco data migrate` now rewrites the absolute paths stored _inside_ data files — the watchlist, queue tickets (`repo:`/`workdir:`), pending assess batches, pending comment drafts, outbox push/PR ops, and plan-set records — so a migrated install keeps working instead of pointing at the removed root. It also moves the plan-set records tree, which had no migration pair, and unlinks the `skills` symlink mount that made the legacy-root removal fail on every machine whose daemon had run.
- Sandbox: an unavailable backend now says **why** it is unavailable. The availability probe discarded the child's stderr and reported a bare exit code, so `junco doctor`, the setup walkthrough and the daemon's auto-degrade warning could only say "bwrap unavailable" and advise "install bubblewrap" — actively wrong advice when bubblewrap _is_ installed and something else refused (a kernel policy such as ubuntu-24.04's `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks an unprivileged user namespace). The probe's own words are now quoted in all three places, ahead of the install hint, collapsed to one line and truncated at 400 characters. The exit code remains the sole decision input — availability, degrade and fail-closed behaviour are unchanged.
- `junco doctor` warns when both the canonical and legacy data roots hold a tree. That signal is ambiguous — it can mean a pre-0.10 binary was run after a completed migrate and recreated the legacy root, or an interrupted `junco data migrate` left stragglers behind — so the warning names both possibilities and recommends re-running `junco data migrate`, which is safe under either (it resumes safely and never overwrites).

### Security

- Sandbox reads are now deny-by-default across the junco data tree. The three sandbox backends gained allow-overrides-deny precedence (longest-prefix-wins, shared by the Seatbelt profile, the bwrap mount list, and the in-process path jail), and the data root (`~/.junco`) is denied wholesale instead of by a hand-maintained enumeration of its sensitive subtrees. Only the agent's execution roots are allowed back — `cache/clones` and `cache/worktrees` under the v2 layout, `clones/` and `worktrees/` under the flat one — with `cache/mirror`, `cache/github-cache` and the root receipt files denied at their own depth. Everything else the daemon owns (tickets, review queues, outbox ops, transcripts, plan-set records, task history, logs, `config.json`) is now unreadable to the agent by containment rather than by remembering to list it, closing the class of gap that left `plans/` agent-readable until 2026-08-21. Every daemon-owned subtree is _also_ denied at its own depth, so the deprecated `git.worktreeRoot` / `github.externalReposRoot` overrides cannot re-expose transcripts, plan-set records, the outbox or task history by being pointed at a whole tier — containment covers what nobody listed, the explicit denies survive an allow-back that moves. `<dataDir>/skills` — a symlink mount for external harnesses that the sandboxed agent never reads — is denied along with the rest of the root.
- Sandbox (Linux/bubblewrap): the TUI's GitHub issue/PR cache directory is now created at daemon startup instead of on its first write. bubblewrap skips a deny mount whose target does not exist, so on a tree where the TUI had never cached anything that deny was dropped while the surrounding `cache/` tier stayed bound read-only — opening the TUI during a long agent run put its token-fetched GitHub data inside the agent's readable view. macOS/Seatbelt and the in-process path jail deny it by name unconditionally and were never affected.
- Sandbox: an allow-back can no longer sit above a denied **file**. `buildPolicy` refuses any policy in which an allow — a read allow-back _or_ a writable root — is a strict ancestor of a by-name denied file, and the v2 allow-back narrowed from the whole `cache/` tier to `cache/clones`. bubblewrap must skip a deny mount whose target does not exist (it cannot create a mountpoint under a read-only bind), so the lazily-written receipts — `spend.json`, `metrics.json`, and v2's `cache/update-check.json` — had no surviving deny inside an allow-back on Linux: each became readable through that bind the moment the daemon wrote it. Reaching the first two took a mis-set `git.worktreeRoot` / `github.externalReposRoot` pointed at a whole tier; `cache/update-check.json` was inside the default v2 allow-back, which is why that allow-back moved down. macOS/Seatbelt and the in-process path jail deny by name regardless of existence and were never affected. The refusal is fail-closed and names the allow, the file, and the settings to check — the alternatives were worse: silently dropping the allow costs the agent a tier it may legitimately need, and for a writable root it walls the agent out of its own worktree. Deny _directories_ nested inside an allow-back are unaffected and still supported: every one of them is materialized at daemon startup, so bubblewrap never skips one, and a deny at its own depth already out-specifies a shallower allow on all three backends.
- Sandbox: `sandbox.extra_allow_write: ["/"]` no longer escapes the allow-above-a-denied-file refusal. The boundary test appended a path separator to the allow, which produces `"//"` at the filesystem root and therefore matched nothing — so the guard could not fire for an allow at `/`, and on bubblewrap that allow was emitted as `--bind / /` _after_ every deny, re-exposing `~/.ssh` and the whole data tree read-write. A pathological configuration, but a real escape; it is now refused like every other allow above a denied file.
- Sandbox: `sandbox.extra_deny_read` entries are now classified by what they actually are, rather than all being forced through the subtree deny kind. An entry observed to name a regular file becomes a by-name file deny (Seatbelt `literal`, bubblewrap `/dev/null` mask, path-jail exact match) — bubblewrap renders a subtree deny as `--tmpfs`, which cannot be mounted on a file at all, so denying an existing file used to abort the whole sandbox spawn on Linux. Denying a `.env` inside the agent's own worktree keeps working exactly as documented, and now means the same thing on all three backends. A directory — and a path that does not exist yet, which has nothing to observe — stays a subtree deny: that rule is the stronger of the two wherever the name is what's enforced, so it is right whichever the path turns out to be, and on bubblewrap a mount at a missing target is skipped either way.
- Cleared 9 Dependabot alerts (4 high, 5 moderate). They were unfixable downstream: the SDK's own `npm-shrinkwrap.json` pinned vulnerable `undici`, `protobufjs`, and `brace-expansion`, which root-level `overrides` cannot reach. 0.84.2's shrinkwrap ships patched pins; `npm audit` now reports 0 vulnerabilities.

## [0.11.0] - 2026-08-19

### Added

- `junco replay <ticket-id|path.jsonl> [--budget-per-kind N] [--escalation-window N] [--output-budget-per-turn N] [--output-budget-post-commit N] [--json]` — re-runs a recorded per-ticket event transcript through a fresh guard manager under a chosen (or default) policy and reports what the guards would decide today: a per-run recorded-vs-replayed decision comparison, a verdict, and caveats (`--json` prints the raw report instead). Each of the four supervisor knobs resolves independently by precedence — an explicit flag, then the file's first `junco_run_start.guard`, then the loaded config, then GuardManager's own built-in defaults.
- Per-ticket event transcripts (`<dataDir>/data/transcripts/<id>.jsonl`) now carry v2 frame records: `junco_run_start`/`junco_run_end` bracket every agent run (flow, body, cwd, model id, tools, timeout, and the guard policy in effect) and `junco_guard_decision` records each nudge/kill — enough to reconstruct a run's identity and guard history from the transcript alone, and what `junco replay` reads.
- `junco unwatch <owner/repo> [--plan]` — stop watching a repo and delete its junco-owned operational state: inbox tickets, the worktree namespace, and outbox/review/history/mirror/cache traces. `--plan` prints the itemized deletion as JSON and deletes nothing; a ticket for the repo in `processing/` blocks the run; re-running sweeps residue idempotently (including orphaned worktree namespaces). The dashboard's unwatch (`u`) plans first, shows the itemized confirm, and executes through the same CLI core.
- Skill-link distribution: `<dataDir>/skills` is a junco-managed symlink mount to the packaged `skills/` directory, and the new `skills.harnessDirs` config key lists the harness skills directories (standing consent — junco never writes into a directory not listed) that receive a `junco-dispatch` link through the mount. Links are created and self-healed at daemon startup and after `junco update`; `junco skill install [--harness <name|path>]...` (names: `claude`, `codex`, `pi`, `omp`, `opencode`) adds consent and links on demand; the setup walkthrough gains a Skills chapter that detects installed harnesses and offers them as a multi-select; `junco doctor` reports link health, including the blocked-by-a-real-file state that self-heal deliberately refuses to fix. A valid symlink is never repointed, so a hand-managed mount survives.
- The dashboard's add-repo flow now runs a bot-grant preflight and asks for explicit confirmation before inviting the bot account into a private personal repository.

### Changed

- Every agent flow (Q&A, assess, analyze, PR main, PR corrective) now runs through one wrapper, `runEnveloped` (`src/agent/runEnvelope.ts`), which builds the guard manager, opens and frames the per-ticket transcript, calls the agent, and records spend — replacing five hand-copied call sites whose parity previously rested on comments.

### Internal

- Lockfile security bumps: brace-expansion 5.0.9 and nanoid 3.3.18 (transitive). Runtime dependencies unchanged.

## [0.10.0] - 2026-08-16

### Changed

- **Breaking:** junco now lives under a single root: `~/.junco`. The config's canonical location is `~/.junco/config.json`, and the default data root is `~/.junco` with a reorganized v2 layout — durable state under `data/` (outbox, history, assess-history, transcripts, spend.json, metrics.json), regenerable state under `cache/` (mirror, clones, worktrees, github-cache, update-check.json — `rm -rf ~/.junco/cache` is always safe), logs under `logs/`, and `queue/`, `review/`, `watchlist.json` at the root. Existing installs keep working untouched: while `~/.junco` holds no data tree and the legacy `~/.local/state/junco` root exists, junco keeps using the legacy root in its flat layout and surfaces a deprecation pointing at `junco data migrate`. An explicit `dataDir` is honored verbatim and never triggers the fallback.
- **Breaking:** config resolution is environment-only. The config is found at `~/.junco/config.json` (the legacy `~/.config/junco/config.json` is honored until migrated); `./config.json` in the current working directory is no longer consulted, so the directory a command runs from can never select a different config — the root cause of a split-queue incident where the dashboard and the worker disagreed about the inbox. The `--config` flag is deprecated and inert: still parsed so installed pre-0.10 service units don't crash, ignored for resolution, with a one-line stderr notice.
- Service units are rendered flagless — launchd/systemd invocations end at `start` with no `--config`; `junco restart` still discovers pre-0.10 flagged units. `worker.lock` now sits next to the canonical config at `~/.junco/worker.lock`.
- The bot account's gh config home default moves from `~/.config/junco/gh` to `~/.junco/gh`. An existing legacy login keeps working until `junco data migrate` moves it; an explicitly configured `botAccount.configDir` is honored as-is.
- The setup wizard follows the single root: the workspace default and placeholder are `~/.junco`, and when existing legacy data is detected the Workspace chapter says so ("found existing data at … — junco will keep using it") instead of silently defaulting elsewhere. Saving with defaults still writes no explicit `dataDir` key.
- The agent sandbox now denies the config file itself (it can hold `model.apiKey`) — at the canonical location, and on a not-yet-migrated machine at the legacy location too, since that is the active config there.

### Added

- `junco data migrate` now unifies everything under `~/.junco`: it moves the data tree (including the flat→v2 restructure), the bot gh credentials, and the config file itself into the single root, journaling every step to `migrated.json`. It refuses to run while the daemon is up (`--force` overrides), takes a `migrate.lock` at every root it may touch, resumes cleanly after an interruption, and never overwrites: conflicts are reported, exit non-zero, and nothing is rolled back. `--dry-run` prints the full plan without touching anything. The emptied legacy root is removed afterwards.
- Pending single-root migration is reported everywhere it matters: `junco data` marks a legacy root with `legacy — run 'junco data migrate'` (and gains `layout` + `legacy` fields in `--json`), `junco doctor` folds the pending moves into its `unmigrated data dirs` warning, and daemon startup prints the config deprecations.

### Fixed

- `junco data migrate` could never actually remove the emptied legacy root: the root's own scaffolded `.gitignore` made the removal fail every time. It is now removed when its content is exactly the scaffolded `*` line; a customized one is left in place and reported.
- On a not-yet-migrated machine the active (legacy-path) config file was readable from inside the agent sandbox; both config locations are now on the deny list.
- A live config edit while a daemon restart was pending could pair the frozen `dataDir` with a live `dataLayout` and split the data tree; `dataLayout` is now pinned alongside `dataDir` across restarts.

### Internal

- All data-tree path construction routes through one `dataTreePaths(cfg)` table (~15 modules previously joined paths ad hoc); the packaged smoke test now asserts containment — a fresh `config init` writes nothing outside `$HOME/.junco`.
- Dependency bumps via dependabot: eslint 9 → 10 (dev), plus brace-expansion and postcss security patches (transitive). Runtime dependencies unchanged.
- Docs: `configuration.md` and `operations.md` rewritten for the single root (v2 tree diagram, migrate walkthrough, flagless service snippets); new watercolor junco mascot artwork.

## [0.9.1] - 2026-07-26

### Changed

- README now leads with the junco mascot on a transparent background, rendered for both GitHub and npm; the package description reads "coding-agent worker" rather than "task-queue worker". No runtime changes.

## [0.9.0] - 2026-07-22

### Changed

- **Breaking:** dashboard shortcuts are now derived mnemonics. Every named option's hotkey is the highlighted letter inside its own footer chip (first letter when free, cascading otherwise; uppercase = shift-guarded destructive verbs, which keep their confirm modals; `q` quit and `?` help reserved everywhere). Notable changes: browser `o`→`b`, approve `a`→`o`, analyze `c`→`n`, add-repo `w`→`a`, unwatch `x`→`u`, queue-jump `t`→`e`, requeue `R`→`t` (retry), delete `x`→`D`, prune `x`→`P`, restart `X`→`R`, review discard `x`→`D`, assess auto-plan `S`→`A`. One derived table per view drives the chips, the help modal, and key dispatch, so they can never disagree.

- **Breaking:** the dashboard's GITHUB/LOCAL two-mode split is gone — one unified view. The rail lists every repo junco knows about (watched GitHub repos _and_ local checkouts discovered on disk) with a pinned `system` group (queue, outbox, worktrees, daemon, logs) below; the body follows the cursor. The `m`/Shift+Tab mode toggle and the header tab pair are removed; `t` now jumps to the queue system row instead of opening a separate queue view; `enter` on a rail repo row opens a new repo detail panel (path, origin, branch@sha, dirty flag, worktrees, recent queue activity — also the body for local-only checkouts, and for every repo when `github.enabled = false`). Queue snapshot rows now carry the ticket's `repo:` path so the panel can scope queue activity per repo.

- `junco assess` filing (CLI `assess file`, TUI `f`) stamps per-finding filed accounting (created/queued/deduped — shown as "dup" in the TUI — + timestamp + URL) and keeps the batch in the review list; the TUI review view shows batch age, `filed n/m` chips, and per-finding ✓ accounting, and `x` discards an open batch.

- Dashboard polish: digit-free panes (1/2/3 keys removed), grouped live-metric top bar (24h record, running ticket, ETA, gate/restart warnings; breadcrumb trail), columnar issue/PR tables with header strips and state pills, always-reserved third column (activity card), daemon panel stat grid with refresh stamp and spend gauge, scrollbars, clickable confirm buttons, bot-authored rows highlighted.

- The dashboard re-renders far less: its large components — the issue and PR lists, the unified rail, and the repo/daemon detail panels — now re-paint only when their own data changes, not on every background health/queue poll. The view is memoized and its callback props are stabilized.

### Added

- `junco assess discard <id>` — explicitly archive a pending review batch; filing no longer auto-archives.
- Durable per-task history: every finalized ticket (PR flow, ask, assess, analyze, or a crash-containment path) appends a record — kind, terminal status, duration, tokens, cost, and (for GitHub-bridged tickets) `nwo`/issue/PR url — to `<dataDir>/history/` (UTC-month JSONL shards). Requeues never append.
- Queue monitoring in the dashboard's queue view (`t`, and the LOCAL queue section): a `▸ paused — <reason>` banner when the daemon's provider gate is backed off or blocked (rate limit, outage, budget, or an auth/config problem), a `↻ poll Ns ago` heartbeat on the RUNNING header, `⚠ no activity Nm` stall warnings on a wedged running task, deferred/oldest-wait context on the WAITING header plus a `queued Nm` age per row, real result status + duration on RECENT rows, and an always-on STATS section (24h ok/failed counts and success rate, avg duration, ETA, a 7-day sparkline, spend and token totals, guard/requeue counts, outbox depth, and a pending-restart notice) built from the new history ledger with a done/failed-dir-mtime fallback when the ledger is still empty.
- The rail's queue card and `junco status` pick up the same signals: a paused line and `oldest Nm` on the waiting line in the rail, and a `stats:` line (24h ok/failed · avg duration · oldest wait) plus a `gate:` line (when not healthy) in `junco status`.
- Live daemon-log view in the TUI: a compact `logs` section in the LOCAL rail tails the latest lines, and Enter/click expands it into a full-screen overlay with level-threshold, ticket, and text filters, a follow toggle, and scrollback. `junco logs` and the TUI now share one tail implementation.

### Internal

- Behaviour-preserving engineering work under the hood: the test suite's duplicated scaffolding was consolidated into one shared `Config`/harness fixture layer behind a `@vitest/coverage-v8` floor; the ~3,000-line dashboard `App` component was decomposed into per-domain hooks; and `eslint-plugin-react-hooks` (rules-of-hooks + exhaustive-deps) is now enforced across the dashboard.

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
