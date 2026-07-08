# Offline Junco — GitHub Outbox Design

**Date:** 2026-07-07
**Status:** proposed (design presented; scope = "everything" per the request's own wording: comments + PRs + UI indicator)

## Goal

When GitHub is unreachable, junco keeps working off its pre-synced state and
parks every GitHub side effect in a durable, replayable **outbox**: dashboard
label actions, daemon reporter comments/label flips, and the PR endgame
(push + `gh pr create`). A dashboard indicator shows unpushed depth; flush is
automatic on reconnect (daemon sweep) and manual (CLI/palette).

## What offline looks like today (verified against code)

- Dashboard actions: `applyAction` fails → toast + optimistic-label rollback.
- Reporter (`githubReport.ts` `guard`): **best-effort by contract** — comments
  and label flips are logged and silently LOST offline.
- prFlow phase 11/12: push failure finalizes the ticket with
  `push/commit failed` (worktree preserved); `gh pr create` failure finalizes
  with "branch pushed, open manually". The agent's completed work strands.
- `git.ts` already ships the classification seam: `isNetworkError(stderr)`
  patterns + `runWithRetry` exponential backoff (`retryNetwork: true` call
  sites). An error that escapes retryNetwork with a network pattern means
  genuinely offline.

## 1. Op model & storage (`src/githubOutbox.ts`)

Directory `<state_dir>/github-outbox/` (+ `dead/` subdir). One JSON file per
op, written atomically (tmp + rename — watchlist pattern). Filename
`<epoch-ms>-<seq>-<slug>.json`; lexicographic order = global FIFO, which also
preserves per-issue ordering.

Envelope: `{ id, createdAt, origin: "dashboard" | "reporter" | "prflow",
issueKey: "<nwo>#<n>" | null, attempts, lastError: string | null }`.

Op kinds:
- `labels` — `{ nwo, issue, add: string[], remove: string[] }`
- `comment` — `{ nwo, issue, body }`; the body gains an invisible trailing
  marker `<!-- junco:outbox:<id> -->`; before posting, the flusher scans the
  issue's comments for the marker (post-crash idempotency: crash between
  post and delete must not double-post).
- `push` — `{ repoPath, branch }` (amend flow: PR exists, URL known; the
  finalize comment travels separately as a `comment` op).
- `pr` (composite) — `{ repoPath, branch, nwo, issue, base, title, bodyText,
  finalize: { ticketId, status, finalText } }`. Flush: push → `gh pr create`
  → capture URL → build the finalize comment (same shape as
  `buildFinalComment`, now with the URL) → post it → flip labels
  (done/failed ↔ working). Progress checkpoints (`pushed: boolean`,
  `prUrl: string | null`) are written back into the op file after each step;
  a retry resumes mid-op. `gh pr create` "already exists" resolves the URL
  via `gh pr view <branch> --repo <nwo> --json url` instead of failing.
  `finalText` is capped at COMMENT_LIMIT before storage.

Branch refs live in the shared repo object store, so `push` works from
`repoPath` (the main clone) even if the worktree is later removed; the
offline path preserves the worktree regardless (see §4).

## 2. Detection

No global gh interception. The three integration layers wrap their calls
with a helper exported by `githubOutbox.ts`:

```ts
/** Try the live call; on a GitOpError whose stderr matches isNetworkError
 * (i.e. offline after retryNetwork's backoff), enqueue `op` and return
 * "queued". Non-network errors rethrow — callers keep today's handling. */
tryOrEnqueue(cfg, op: OutboxOp, live: () => Promise<void>): Promise<"sent" | "queued">
```

## 3. Flush

`flushOutbox(cfg, deps): Promise<FlushResult>` — `{ sent, dead, remaining,
offline: boolean }`:
- Ops in FIFO order; each executes by kind.
- **Network error → stop the whole flush** (still offline; queue intact,
  attempts NOT incremented for untried ops).
- Non-network error → `attempts++`, `lastError` recorded; at `attempts >= 3`
  the op file moves to `dead/` (warn log + metric). Poisoned ops never wedge
  the queue.
- Deps seam: `ghFn`, `gitFn`, fs fns, `nowFn` — tests use fakes with
  network-pattern stderr.

Triggers:
1. **Daemon** — top of every bridge sweep (before issue listing): reconnect
   auto-drains within one poll interval.
2. **CLI** — `junco outbox` lists queued ops (kind, issue, age, attempts);
   `junco outbox flush` drains and reports. Added to USAGE + palette roster
   (args field for `flush`).
3. **Dashboard** — indicator (§5) + palette command. No dedicated key.

## 4. Pipeline integration

- **Reporter** (`githubReport.ts`): `guard`'s catch branches — network error
  → enqueue the equivalent op (`labels` for swaps, `comment` for comments) and
  log at info; other errors keep the warn-and-swallow contract.
- **prFlow** (phases 11–12):
  - Fresh-PR push network failure → enqueue composite `pr` op; DO NOT fail
    the ticket: outcome carries `prQueued: true`; the reporter's onFinal
    SKIPS BOTH its finalize comment AND its done/working label flip for that
    ticket (the composite op owns both — otherwise the flip would be queued
    twice); worktree cleanup skipped (preserved); result section notes
    "PR queued for push — junco is offline; it will open automatically when
    GitHub is reachable (outbox op <id>)". Ticket routes to done/.
  - `gh pr create` network failure after successful push → same composite op
    with `pushed: true` checkpointed.
  - Amend-flow push network failure → `push` op; finalize comment proceeds
    through the reporter (URL already known) and lands via its own outbox
    path if still offline.
  - Repo fetch network failure at flow start → proceed from the local base;
    warn in the transcript; PR body gains a "built offline from a possibly
    stale base — rebase check recommended" line.
- **Bridge sweep** (`githubInbox.ts`): call `flushOutbox` first; if the
  sweep's own listing then fails with a network error, record the offline
  state (metric) and skip quietly — inbox tickets keep executing.

Outcome/reporter contract change is additive: `TicketOutcome` gains optional
`prQueued?: boolean` (internal interface, not ticket schema — the stable
`ticketSchema.ts` contract is untouched).

## 5. Dashboard

- **Actions**: `applyAction` uses `tryOrEnqueue`; on "queued" it returns
  `{ ok: true, queued: true }` — optimistic labels STAY (no rollback), toast
  (info): `offline — action queued (⇡N)`.
- **Pre-synced list**: on successful `listIssues`, persist
  `<state_dir>/github-cache/issues-<owner>__<repo>.json`
  (`{ fetchedAt, issues }`, atomic write). On network failure, serve the
  cache; the issues pane title gains a warn badge `offline · HH:MM` (cache
  age). No cache → today's error toast.
- **Indicator**: `QueueSnapshot` gains `outboxDepth: number` (readdir count,
  same 2 s poll); Header renders `⇡N unpushed` in warn color when > 0.
  HelpModal "system" section documents it; README explains the lifecycle.
- Preview/detail offline: existing error handling (in-memory cache serves
  already-viewed issues; others show the error state). Not persisted (YAGNI).

## 6. Observability

- Metrics (additive to `/health`): `outboxDepth`, `outboxEnqueued`,
  `outboxFlushed`, `outboxDead`, `lastFlushAt`.
- `junco status`: `outbox:    N queued · M dead` line when either > 0.
- `junco doctor`: warn when outbox depth > 0 (with the flush command) or
  dead/ non-empty.

## 7. Safety model (trust boundaries unchanged)

- Ops replay under the operator's own gh auth — the outbox never widens what
  the operator could do live.
- Approval trust checks (who applied the label, postdating the plan comment)
  still run at SWEEP time against live GitHub after flush — queuing an
  `approve` changes when the label lands, not how it is verified.
- Frontmatter stays machine-built; `src/ticketSchema.ts` untouched; Q&A
  read-only default untouched. No new config keys — the outbox is always on
  (queuing beats losing the effect; a healthy network never hits it).

## 8. Testing

- Outbox core: FIFO + per-issue order, atomic writes, envelope, depth.
- Flush: fake gh/git with on-demand network-pattern stderr — stop-on-network
  (attempts untouched), dead-letter at 3, comment marker idempotency,
  composite pr checkpoint resume (crash between push and create → no
  double-create; "already exists" → URL via pr view), labels idempotence.
- Reporter: network → enqueued op contents match the live call; permanent →
  swallowed as today.
- prFlow: offline push → done ticket + composite op + preserved worktree +
  suppressed reporter comment; amend offline → push op; offline fetch →
  stale-base PR body line. (Real git harness where the seam needs it, fake
  gh throughout.)
- Sweep: flush-first ordering; offline sweep leaves queue executing.
- Dashboard: queued action keeps optimistic labels + toast; cache serve with
  stale badge; `⇡N unpushed` chip renders/hides. Bounded until-loops.
- CLI: `junco outbox` list/flush output + exit codes; palette roster test.
- Config-fixture sweep: `QueueSnapshot.outboxDepth` addition → update every
  full-snapshot literal in tests (tuiApp QUEUE_SNAP, tuiQueue, tuiRail…).

## Out of scope (YAGNI)

- Persisted preview/detail cache; offline creation of NEW issues; conflict
  resolution UI for label drift while offline (flush is best-effort +
  dead-letter); cross-machine outbox; encryption at rest (state dir is the
  operator's own machine); configurable retry counts.
