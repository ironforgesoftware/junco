# Dashboard Queue Visibility — Design

**Date:** 2026-07-07
**Status:** approved (layout: strip + expand view; scope: whole local queue)

## Goal

Make the local ticket queue visible from `junco dashboard`: an always-on compact
**queue strip** (running ticket with live progress, next-up list, counts) plus a
full **queue view** on `t` (running / waiting / recent, retry and backoff detail).
Covers the _entire_ local queue — GitHub-bridged and manually dispatched tickets.

## Background facts the design relies on

- Claim order (`claimNextTask` in `src/runOnce.ts`): discover inbox `*.md`
  **lexicographically sorted**, parse each defensively (unreadable → skip),
  **stable-sort by priority rank descending** (high > normal > low), filter out
  tickets whose `not_before` is in the future (unparseable stamp = eligible),
  then skip busy-repo tickets. The dashboard's waiting list MUST mirror the
  lexicographic + priority-stable-sort ordering; deferred (`not_before` future)
  tickets stay visible but marked, since their position is time-dependent.
- Claimed files are renamed to `processing/<UTC-stamp>__<basename>`.
- `/health` already exposes `currentTickets` and per-ticket `currentProgress`
  (`turns`, `lastTool`, `outputTokens`, `updatedAt`) — rendered nowhere today.
- Tickets carry `github: { nwo, issue, kind }` frontmatter when bridged (parse
  frontmatter for issue mapping — NEVER parse filenames; hyphenated owner/repo
  names make `gh-<owner>-<repo>-<n>` splits ambiguous).
- `q` quits the dashboard, so the queue view key is **`t`** (tickets).
- Live config runs `max_concurrent = 1` (the default); same-repo tickets always
  serialize even above 1.

## Data model (`src/tui/queueSnapshot.ts`)

```ts
export interface QueueRunning {
  id: string; // ticket id (stamp prefix stripped)
  github: TicketGithub | null;
  turns: number | null; // null when no progress yet / daemon-down fallback
  lastTool: string | null;
  outputTokens: number | null;
  startedAt: string | null; // ISO; null on daemon-down fallback
  stale: boolean; // true when sourced from processing/ dir (daemon down)
}

export interface QueueWaiting {
  id: string;
  github: TicketGithub | null;
  kind: "pr" | "ask" | "plan"; // github.kind; manual tickets: hasRepo ? "pr" : "ask"
  priority: "low" | "normal" | "high";
  retryCount: number;
  notBefore: string | null; // ISO when deferred (future), else null
  deferred: boolean; // notBefore parseable AND in the future at snapshot time
}

export interface QueueRecent {
  id: string;
  github: TicketGithub | null;
  status: "done" | "failed"; // = which dir it sits in
  finishedAt: string; // file mtime, ISO
}

export interface QueueSnapshot {
  daemonUp: boolean;
  maxConcurrent: number; // from cfg
  running: QueueRunning[];
  waiting: QueueWaiting[]; // claim order (see Background)
  recent: QueueRecent[]; // newest-first across done/ + failed/, cap 5
  error: string | null; // non-null → strip renders one dim error line
}
```

`makeQueueSnapshotFn(cfg, deps) => () => Promise<QueueSnapshot>` with an
injectable deps seam (`readdirFn`, `readFileFn`, `statFn`, `fetchFn`, `nowFn`) —
never throws; any unexpected failure returns a snapshot with `error` set.

### Building rules

- **waiting** — read `inbox/*.md` (sorted), `parseTicket` each (skip parse
  failures and ENOENT races silently — same defensive posture as
  `claimNextTask`), stable-sort by priority rank descending, map to
  `QueueWaiting`. Deferred tickets keep their sorted position, `deferred: true`.
  Manual (non-github) tickets derive `kind` from the PR/Q&A split the runner
  uses: `hasRepo ? "pr" : "ask"` (there is no `mode` frontmatter field).
- **running** — fetch `/health`. Up: one `QueueRunning` per `currentTickets`
  entry, enriched from `currentProgress[id]` (fields null when absent),
  `stale: false`. Down (or `healthEnabled = false`): fall back to listing
  `processing/*.md` (stamp prefix `^.*?__` stripped for id, frontmatter parsed
  for github), all-null progress, `stale: true` — the UI labels these
  "processing (daemon down)".
- **recent** — list `done/*.md` + `failed/*.md`, `statFn` mtime, sort
  newest-first, take 5, parse each for github mapping. Status = source dir.
- One snapshot call does at most: 1 health fetch + 3 readdirs + O(queue) file
  reads. Queues are small (tens); a 2 s poll is cheap and local.

## Daemon change (additive only)

`RunMetrics.taskStarted(id)` seeds `currentProgress[id] = { turns: 0,
lastTool: null, outputTokens: 0, startedAt: now, updatedAt: now }`;
`setTaskProgress` preserves an existing `startedAt` (defaults to now when the
entry doesn't exist — embedder path). `MetricsSnapshot.currentProgress` entries
gain `startedAt: string`. Purely additive JSON — no existing consumer breaks.

## UI

### QueueStrip (always rendered, between issue table and status bar)

- Bordered box, header: `queue — 1 running · 3 waiting` (append ` · max N` only
  when `maxConcurrent > 1`; append `· daemon ○ down — nothing will run` in
  yellow when `!daemonUp` and anything is queued).
- Up to 2 running lines: `◐ #46 exec  turn 14 · bash · 12.3k tok · 4m32s`
  (label = `#<issue> <kind>` for github tickets, else ticket id truncated to
  ~24 chars; elapsed from `startedAt`, omitted when null; `+N more` when > 2).
- One `next:` line — first 3 waiting as `1) #51 plan`, deferred entries
  prefixed `⏲`, then `+N more`, then a dim `[t]` hint.
- Idle (nothing running or waiting, daemon up): single dim line `queue — idle`.
- `error` set: single dim line `queue unavailable: <error>`.

### QueueView (main-area view on `t`)

- Sections: `RUNNING (n/max)` — per ticket: glyph, label, id (dim), then a
  progress line (`turn 14 · last tool: bash · 12.3k tok · 4m32s`, or
  `processing (daemon down)` when stale). `WAITING (n)` — numbered rows: label,
  kind, priority shown only when not `normal`, `retry N · not before HH:MM`
  when relevant, `⏲ deferred` marker. `RECENT` — `✓`/`✗`, label, relative age
  (`12m ago`). Empty sections render a dim `—`.
- Keys: `[`/`]` (and arrows) scroll, `esc` or `t` returns to main. Follows the
  detail-view scroll pattern (slice rendered lines by scroll offset).

### App wiring

- New props: `queueFn: () => Promise<QueueSnapshot>` (test seam, like
  `runCliFn`), `queuePollMs?: number` (default 2_000).
- New state `queueSnap: QueueSnapshot | null`; polled on an interval like the
  existing health poll (immediate first fetch, then every `queuePollMs`).
- `View` union gains `"queue"`. Main view: `t` opens. ShortcutBar main context
  gains `t queue`; new queue-view context (`[ ] scroll · esc back`);
  HelpOverlay gains the `t` line.
- `dashboardCmd.ts` constructs the real `queueFn` via
  `makeQueueSnapshotFn(cfg)` and passes it through. No new config keys.

## Explicitly out of scope (YAGNI)

- No queue manipulation from the dashboard (no cancel/reprioritize/retry —
  the palette already runs `junco retry`).
- No issue-table row annotations (lifecycle badges already cover per-issue
  state); no fs.watch push updates; no per-second elapsed ticker (elapsed
  refreshes with the poll).

## Testing

- `tests/queueSnapshot.test.ts` — ordering (priority beats lexicographic;
  stable within rank), deferred marking, unparseable-ticket skip, ENOENT race
  skip, daemon-down processing fallback (stamp stripped, stale flag), recent
  mtime ordering + cap, github mapping from frontmatter, health-fetch failure
  → `daemonUp: false`, never-throws contract.
- `tests/metrics.test.ts` (extend) — `taskStarted` seeds progress with
  `startedAt`; `setTaskProgress` preserves it; `taskEnded` clears.
- TUI tests — strip frames (running/idle/error/daemon-down variants), queue
  view frames, `t` open/close interaction, scroll. All waits are bounded
  until-loops (CLAUDE.md Ink gotcha); fake `queueFn` resolves canned snapshots.
- Audit existing tests that build full `MetricsSnapshot`/`currentProgress`
  literals for the new `startedAt` field (runtime-failure class, per CLAUDE.md).
