# Junco — Architecture

Junco is a TypeScript (Node ≥ 22.19) task-queue worker that turns Markdown tickets into git pull requests by driving a coding agent. It embeds the Pi coding agent (`@earendil-works/pi-coding-agent`) **in-process** via its SDK; the SDK talks to a configurable OpenAI-compatible inference endpoint. No subprocess is spawned for the agent — Pi runs inside the Junco process.

---

## How it works at a glance

```
ticket (.md)        queue directories       Junco worker
──────────────      ───────────────────     ────────────────────────────────────────
                    inbox/                  ← junco submit drops files here
                       ↓  claim (rename)       (not_before-gated; endpoint-readiness
                    processing/                 probed before every claim)
                       ↓  finalize          ← worker owns the ticket while running
                    done/ | failed/         ← terminal state + result block appended
                       ↖  requeue           ← transient failures + crash recovery go
                          (processing/ → inbox/)  back with retry_count++ / not_before
```

A ticket is a Markdown file with a YAML frontmatter block validated against the `junco schema`. If the frontmatter includes a `repo:` field, Junco runs the full **PR flow** (agent writes code, opens a pull request). Without `repo:`, it runs the lighter **Q&A path** (agent operates read-only, answer is appended to the ticket).

---

## The PR-flow pipeline

`prFlow.ts → runPrFlow` executes these phases in order:

```
 1. Validate repo context
    Resolve the GitHub repo from frontmatter; in amend mode resolve the existing PR.

 2. Plan-lint gate
    Deterministic ticket validation (planLint.ts).
    On failure → ticket moved to failed/; the agent NEVER runs.

 3. Provision a git worktree
    worktree.ts carves a worktree off origin/<base_branch>
    (or the existing branch in amend mode).

 4. Run the agent
    agent/session.ts drives Pi in-process inside the worktree.
    The loop-guard supervisor (agent/supervisor.ts) is attached to the event stream.

 5. Hard-exit check
    Non-guard error → transient (no commits) → requeue to inbox with backoff
    (retry_count++ / not_before, up to [worker].max_transient_retries);
    otherwise preserve worktree + fail.
    A guard kill is a SOFT abort, and so is a TIMEOUT: both continue through
    post-processing so commits made before the cutoff are salvaged.

 6. Count / commit
    Count new commits since the base; optionally commit unstaged leftovers (pr.ts).

 7. No-commits gate
    Timeout with no commits → preserve worktree + fail.
    stop_reason error/length with no commits → requeue (budget permitting),
    else fail. Clean no-change → terminal status completed_no_changes.

 8. Post-session review  (skipped on a guard abort or timeout)
    a. Run ## Verification bash blocks in the worktree (verify.ts).
    b. Run the critic (critic.ts): in-process diff-vs-spec review → PASS | MISSING.
    c. On MISSING + retries remaining + not amend mode →
       ONE corrective agent re-dispatch, then re-evaluate.

 9. Verification gate
    If block_on_fail and verification failures → preserve worktree + fail.

10. Push
    Branch is pushed to origin (pr.ts).

11. Open / update PR
    gh pr create --draft   (or, in amend mode, the existing PR auto-updates).

12. Finalize
    Worktree pruned; finalize.ts computes the terminal status, appends a result
    block to the ticket, and atomically moves it to done/ or failed/.
```

### The Q&A path

```
claim → runAgent (read-only tool subset) → finalize in place
```

No worktree, no git operations, no PR.

---

## The daemon lifecycle

`daemon.ts → mainLoop` runs these steps every time the worker starts:

```
ensure queue dirs
  → recoverOrphans  (orphans.ts: crashed tickets requeue to inbox under the
                     transient-retry budget; exhausted budget → failed/)
  → prune stale worktrees
  → waitForEndpoint (health.ts: blocks until the inference endpoint answers)
  → start health server (healthServer.ts)
  → poll loop (max_concurrent = 1, the default — serial):
        every poll_interval_seconds → runOnce (claim + execute one ticket)
        StopFlag checked between polls for graceful shutdown
    OR scheduler (max_concurrent > 1 — runScheduler):
        tops up to max_concurrent in-flight tickets; same-repo tickets
        always serialize; wakes on task-settle or poll tick; graceful stop
        drains in-flight work
  → on shutdown: close health server
```

The CLI `start` subcommand acquires the **single-instance lock** (`lock.ts`, pidfile + PID-liveness stale detection) before entering `mainLoop`. If the lock is already held by a live process, `start` exits 0 immediately. Signal handlers (`SIGTERM`/`SIGINT`) are installed by `installSignalHandlers` with **stop escalation**: the first signal requests a graceful stop (drain the in-flight ticket), the second force-stops (`StopFlag.forceSignal` aborts the agent session softly — committed work is salvaged like a guard kill), the third hard-exits (130). Both the lock and the handlers are released in a `finally` block. Rendered service units set `ExitTimeOut`/`TimeoutStopSec` sized to the ticket timeout so the supervisor outwaits a draining worker.

---

## The loop-guard model

When the agent is running, `agent/guardManager.ts` subscribes four guards to the Pi event stream:

| Guard                | What it detects                                     |
| -------------------- | --------------------------------------------------- |
| `RepetitionGuard`    | The agent repeating the same output                 |
| `ToolCallLoopGuard`  | The same tool being called in a tight loop          |
| `ToolErrorLoopGuard` | Repeated tool errors with no forward progress       |
| `OutputBudgetGuard`  | Total output tokens exceeding the configured budget |

When a guard fires it signals `agent/supervisor.ts`, which decides:

- **Nudge** — inject a mid-run steering prompt (from `agent/nudges.ts`) to redirect the agent without aborting.
- **Kill** — call `session.abort()` (a soft abort; any commits already made are preserved and the flow continues from phase 6).

---

## Observability

### Health endpoints (`healthServer.ts`)

| Endpoint      | Purpose                                     |
| ------------- | ------------------------------------------- |
| `GET /live`   | Liveness — process is up                    |
| `GET /ready`  | Readiness — inference endpoint is reachable |
| `GET /health` | Full metrics JSON                           |

The health server binds to loopback by default.

### Metrics (`metrics.ts`)

`RunMetrics` (process singleton) tracks: uptime, polls executed, the current ticket in flight, tasks processed / succeeded / failed, per-status bucket counts, and cumulative token + duration totals.

### Logging (`logging.ts`)

Structured JSON output. Per-ticket context is injected via `AsyncLocalStorage` (`withTicket`). Log level is configurable at runtime with `setLogLevel` (debug < info < warn < error).

---

## Module map

| File                    | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`                | Entrypoint; subcommands `start`, `run-once`, `submit`, `inbox-path`, `status`, `list`, `retry`, `outbox`, `prs`, `assess`, `doctor`, `dashboard`, `logs`, `schema`, `init`, `service`, `restart`. Exposes testable `run(argv, deps)`.                                                                                                                                                                                              |
| `daemon.ts`             | `mainLoop`, `runScheduler` (max_concurrent > 1), `StopFlag` (+ forceSignal), `installSignalHandlers`, `sleepInterruptible`.                                                                                                                                                                                                                                                                                                        |
| `lock.ts`               | Single-instance lock — pidfile + PID-liveness stale detection.                                                                                                                                                                                                                                                                                                                                                                     |
| `orphans.ts`            | `recoverOrphans`: requeue crashed tickets (budget permitting), else → `failed/`.                                                                                                                                                                                                                                                                                                                                                   |
| `health.ts`             | `endpointReachable` + `waitForEndpoint` (inference-endpoint probes).                                                                                                                                                                                                                                                                                                                                                               |
| `healthServer.ts`       | HTTP health server (`/live`, `/ready`, `/health`).                                                                                                                                                                                                                                                                                                                                                                                 |
| `metrics.ts`            | `RunMetrics` accumulator + process singleton.                                                                                                                                                                                                                                                                                                                                                                                      |
| `logging.ts`            | Structured JSON logger with `AsyncLocalStorage` per-ticket context.                                                                                                                                                                                                                                                                                                                                                                |
| `config.ts`             | `loadConfig`: zod-validated TOML → typed `Config`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `types.ts`              | Shared types, `queuePaths`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `queue.ts`              | `discoverTasks` + `claim` (atomic inbox → processing rename).                                                                                                                                                                                                                                                                                                                                                                      |
| `ticket.ts`             | Parse a ticket (YAML frontmatter + body).                                                                                                                                                                                                                                                                                                                                                                                          |
| `ticketSchema.ts`       | The frontmatter JSON-Schema contract (`junco schema`).                                                                                                                                                                                                                                                                                                                                                                             |
| `dispatch.ts`           | `inboxPath`, `submitTicket` (atomic placement into inbox).                                                                                                                                                                                                                                                                                                                                                                         |
| `runOnce.ts`            | `claimNextTask` (discover/filter/priority/claim) + `executeClaimed` (PR flow or Q&A → finalize) + serial `runOnce`.                                                                                                                                                                                                                                                                                                                |
| `planLint.ts`           | Deterministic ticket validation before the agent runs.                                                                                                                                                                                                                                                                                                                                                                             |
| `prFlow.ts`             | `runPrFlow`: the 14-phase PR orchestration. Offline endgame (phases 11–12 on network error): queues push+PR+comment+labels composite op to outbox; ticket finalizes done locally; staleBase flag set when base wasn't fetched offline.                                                                                                                                                                                             |
| `finalize.ts`           | Compute terminal status, append result block, move ticket atomically.                                                                                                                                                                                                                                                                                                                                                              |
| `repoContext.ts`        | Derive the repo context from frontmatter.                                                                                                                                                                                                                                                                                                                                                                                          |
| `repo.ts`               | Validate the repo context.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `worktree.ts`           | Provision / prune git worktrees.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `prPrompt.ts`           | Build the repo-aware agent preamble (commit rules + working discipline).                                                                                                                                                                                                                                                                                                                                                           |
| `pr.ts`                 | Count/list commits, commit leftovers, push, `gh pr create`, derive PR title.                                                                                                                                                                                                                                                                                                                                                       |
| `verify.ts`             | Run `## Verification` bash blocks in the worktree.                                                                                                                                                                                                                                                                                                                                                                                 |
| `critic.ts`             | In-process diff-vs-spec review; PASS / MISSING verdict; one corrective re-dispatch.                                                                                                                                                                                                                                                                                                                                                |
| `agent/session.ts`      | Pi SDK wiring (`makePiSessionFactory`, provider registration) + `runAgent`.                                                                                                                                                                                                                                                                                                                                                        |
| `agent/runResult.ts`    | Event → `RunResult` accumulator.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `agent/guards.ts`       | The four loop guards.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `agent/supervisor.ts`   | Decides nudge vs kill when a guard fires.                                                                                                                                                                                                                                                                                                                                                                                          |
| `agent/nudges.ts`       | Nudge message templates.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `agent/guardManager.ts` | Subscribes guards to the event stream; routes nudges and kills.                                                                                                                                                                                                                                                                                                                                                                    |
| `service.ts`            | Render a launchd plist / systemd unit (`junco service`), stop timeouts included.                                                                                                                                                                                                                                                                                                                                                   |
| `requeue.ts`            | Transient-failure classification + atomic requeue-to-inbox with backoff.                                                                                                                                                                                                                                                                                                                                                           |
| `planPrompt.ts`         | Planner prompt assembly — single-sources `skills/junco-dispatch/TEMPLATE.md` (shared verbatim with the interactive skill) into the planning session's preamble.                                                                                                                                                                                                                                                                    |
| `findings.ts`           | `junco assess` finding schema (zod) + sha256 fingerprinting (`kind\|ruleId\|locus`, line numbers excluded) + text sanitization + fenced-JSON extraction (`parseAgentFindings`) + `npm audit` → `Finding` mapping + GitHub issue title/body rendering + the `junco:finding`/`severity/<level>` label specs. Pure — no I/O.                                                                                                          |
| `assessPrompt.ts`       | `buildAssessPrompt`: the read-only vulnerability-audit prompt for `junco assess` ticket bodies; closes with the `junco-findings` fenced-JSON output contract `findings.ts` parses.                                                                                                                                                                                                                                                 |
| `assessFlow.ts`         | `runAssessFlow`: assess-ticket orchestrator — `npm audit` + a read-only agent audit → merge/severity-filter/within-run dedupe → GitHub-side dedup (`fetchFindingMarkers`) → cap at `[assess].max_issues_per_run` → file one issue per finding through the outbox. Mirrors the Q&A path for containment, read-only tools, guards, transcript, transient requeue, and finalize.                                                      |
| `githubOutbox.ts`       | Offline store-and-forward for GitHub side effects: FIFO op files under `<state_dir>/github-outbox/`, `tryOrEnqueue` seam (try live, queue on network error), flush executor (checkpointed composite PR ops, comment idempotency markers, dead-letter after 3 attempts). Also owns the `issue-create` op (`junco assess` findings) — re-runs `fetchFindingMarkers` fresh at flush time before creating, so replays stay dedup-safe. |
| `githubInbox.ts`        | GitHub bridge, dispatch side: sweep trigger-labeled issues → verify labeler permission (fail-closed) → issue→ticket conversion → `submitTicket`. Process-local caches for label creation + origin cross-checks.                                                                                                                                                                                                                    |
| `githubReport.ts`       | GitHub bridge, feedback side: `makeGithubReporter` — lifecycle label flips + the single finalize comment. Best-effort by contract (never fails a ticket); wraps label/comment ops through `tryOrEnqueue` for offline durability.                                                                                                                                                                                                   |
| `githubPrs.ts`          | Shared junco-PR listing: gh pr list fetch + DashPr mapping + branch-prefix filter — consumed by the dashboard client and prsCmd.                                                                                                                                                                                                                                                                                                   |
| `reporter.ts`           | `TicketReporter` seam (onStart/onRequeue/onFinal) + outcome mapping. `executeClaimed` is the only call site; default no-op.                                                                                                                                                                                                                                                                                                        |
| `statusCmd.ts`          | `junco status` — daemon /health + queue counts at a glance.                                                                                                                                                                                                                                                                                                                                                                        |
| `listCmd.ts`            | `junco list` — newest-first ticket listing with terminal statuses.                                                                                                                                                                                                                                                                                                                                                                 |
| `retryCmd.ts`           | `junco retry` — clean failed tickets and resubmit to the inbox.                                                                                                                                                                                                                                                                                                                                                                    |
| `prsCmd.ts`             | `junco prs` — cross-repo listing of junco-authored pull requests.                                                                                                                                                                                                                                                                                                                                                                  |
| `assessCmd.ts`          | `junco assess <path\|owner/repo> [--auto-plan]` — resolve the target (path, or a watched `owner/repo`), compose the machine-owned assess ticket (`buildAssessTicket`), and submit it; the daemon runs the actual audit via `assessFlow.ts`.                                                                                                                                                                                        |
| `doctor.ts`             | `junco doctor` — preflight config/toolchain/endpoint/model/dirs.                                                                                                                                                                                                                                                                                                                                                                   |
| `logsCmd.ts`            | `junco logs` — tail/follow the state-dir worker.log.                                                                                                                                                                                                                                                                                                                                                                               |
| `watchlist.ts`          | Dynamic watchlist; `resolveWatchedRepos` — config ∪ file, config wins; bridge reads per sweep.                                                                                                                                                                                                                                                                                                                                     |
| `tui/`                  | Ink dashboard (fullscreen workspace): theme/layout/window foundations, pure state derivation, gh client seam, queue snapshot, components, App.                                                                                                                                                                                                                                                                                     |
| `dashboardCmd.ts`       | `junco dashboard` — TTY guard + lazy Ink load.                                                                                                                                                                                                                                                                                                                                                                                     |

---

## Ticket lifecycle through the queue

```
GitHub issue         — trigger-labeled; bridge sweep verifies the labeler's
  ↓  pollGithubInbox   permission, then branches on the ask label:
                         junco:ask present → an ordinary Q&A ticket,
                                             junco:queued (skips the plan hop)
                         otherwise         → a PLANNING ticket (kind: plan,
                                             read-only session at the mapped
                                             clone; planPrompt.ts assembles
                                             the prompt), junco:planning
       │  (planning ticket runs the claim/processing/finalize cycle below
       │   like any Q&A ticket; reporter.onFinal is where the plan branches)
       ▼
  reporter.onFinal (kind: plan) — extracts the plan from the session's
    junco-ticket fence, posts it as ONE issue comment (<!-- junco:plan -->
    marker; editable before approval), junco:planning → junco:plan-ready
    (or, on failure/empty plan: a failure comment, junco:planning → junco:failed)
       │
       │  next sweep: require_approval=true waits for a junco:approved applied
       │  by a verified write+ collaborator AFTER the plan comment's timestamp;
       │  require_approval=false executes as soon as the plan comment exists.
       │  Either way, the (possibly hand-edited) comment is read back and an
       │  EXECUTION ticket (github: provenance block) is built from it —
       │  submits BEFORE swapping junco:plan-ready/junco:approved for
       │  junco:queued (a crash between the two self-heals via the duplicate
       │  guard, same submit-then-label ordering as the ask-label path below)
       ▼
inbox/               — submitted by junco submit, the bridge, or any atomic write
  ↓  claim()         — atomic rename, adds UTC-timestamp prefix
                       (not_before-gated; skipped while its repo is busy)
                       reporter.onStart: junco:queued → junco:working (plan
                       tickets skip this — the label stays junco:planning)
processing/          — owned by the worker; do not touch while worker is live
  ↓  finalize()      — appends result block, atomic rename
  ↘  requeueTicket() — transient failure / crash: back to inbox/ with
                       retry_count++ and a not_before backoff stamp
                       (reporter.onRequeue flips the label back to queued)
done/                — terminal: completed, completed_no_changes,
                       aborted_partial, timeout_partial
failed/              — terminal: plan-lint failure, agent error, verification
                       block, timeout with no commits, retry budget exhausted, …
  ↓  reporter.onFinal — pr/ask tickets: ONE issue comment (PR link + summary |
                       answer | failure reason), then junco:done|failed
```

Reporter calls live **only** in `executeClaimed` (single choke point; `prFlow`
stays reporter-free — it returns a structured `PrFlowResult` instead). Planning
tickets are ordinary `kind: plan` Q&A tickets under the hood — `githubReport.ts`
is what special-cases them, branching on `t.github.kind` to run the plan⇄execute
handoff instead of the terminal comment. The bridge is throttled inside the
daemon poll loop (`github.poll_interval_seconds`) and makes zero calls when
`[github].enabled = false`.

The **stable public contract** is the ticket frontmatter schema (`junco schema` / `ticketSchema.ts`). Changing it is a breaking change for any tool that generates tickets.
