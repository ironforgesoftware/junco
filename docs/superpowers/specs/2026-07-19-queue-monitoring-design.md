# Queue Monitoring Design

**Date:** 2026-07-19
**Status:** Approved (approach C — full monitoring; surfaces: QueueView t+LOCAL, rail queue card, `junco status` parity; STATS as an always-on section)

## Problem

The queue surfaces (rail card, `t` QueueView, LOCAL queue section) under-report what the
runtime already knows. The daemon's `RunMetrics` tracks gate state, heartbeat, per-run
activity, session totals, tokens, cost, guards, requeues, and outbox pressure — the TUI
fetches all of it every poll and throws most of it away. Worse, a queue stalled by the
provider gate (rate-limit / outage backoff / budget exhausted) renders identically to an
idle one. And because `RunMetrics` is in-memory — and the promote hook restarts the daemon
on every merge — "lifetime" counters are frequently minutes old, so nothing trend-like can
come from `/health` alone.

## Goals

1. Surface the live signals that are already fetched but never rendered (gate pause,
   heartbeat, per-run stall, outbox, guards, spend).
2. Add durable per-task history so throughput / success-rate / duration stats survive
   daemon restarts.
3. Render a compact always-on STATS section in QueueView, upgrade the rail card and
   `junco status`, and enrich RUNNING/WAITING/RECENT rows.

Non-goals (out of scope, may be follow-ups): transcript drill-in view, orphan-recovery
history records, ledger auto-prune, config levers for thresholds (constants in v1),
spend display while the daemon is down.

## Component 1 — task-history ledger (`src/taskHistory.ts`)

A new durable store under the data root, following the dataTree registration checklist
in full: `HISTORY_SUBDIR = "history"` constant, `paths.history`, `ensureDataTree`
creation, agent sandbox deny-list entry, and a `junco data` listing row.

**Files:** `<dataDir>/history/tasks-YYYY-MM.jsonl` — UTC-month shards keyed by the
record's `at` stamp. Append-only JSONL, one line per finalized task:

```json
{
  "v": 1,
  "at": "2026-07-19T21:04:11.312Z",
  "id": "junco-46-fix-tui",
  "kind": "pr",
  "status": "completed",
  "durationSeconds": 712,
  "tokensIn": 812345,
  "tokensOut": 45678,
  "costUsd": 0.42,
  "nwo": "ironforgesoftware/junco",
  "issue": 46,
  "prUrl": "https://github.com/...",
  "retryCount": 0
}
```

`kind` is the ticket's execution kind (`pr | ask | plan | assess | analyze`); `nwo`,
`issue`, `prUrl` are optional (omitted when absent). Sizing: ~200 B/record — a busy
month is ~1 MB; shards make later pruning trivial, so v1 ships without auto-prune.

**Writer.** `appendTaskRecord(cfg, rec, deps)`: mkdir -p, single-`appendFileSync` of one
line (O_APPEND — safe under `max_concurrent > 1`). Never-throw: a failed history append
logs a warning and must not fail the finalize that triggered it.

**Hook point.** `runOnce.ts`, at its existing "finalized" points (analyze, assess,
pr-flow, ask, crash containment) — the one layer where `cfg`, the parsed `Ticket`
(kind, `github`, `retry_count`), and the flow outcome are all in scope. The ask and
crash-containment paths call `finalize` directly in `runOnce` with the `RunResult` in
hand — no threading needed. The three flow-returning paths (`PrFlowResult` and the
assess/analyze result types) gain **additive** optional `usage?: Usage` and
`durationMs?: number` fields threaded from the underlying `RunResult` (populated in
`flowResult()` and the equivalent constructors). Requeued outcomes
(`status: "requeued"`) get **no** record — mirroring `metrics.recordTask`, which never
fires on the requeue path. Orphan recovery writes no record (no `RunResult` exists).

**Reader.** `readTaskHistory(cfg, { since }, deps)` → `TaskRecord[]`: reads only the
shard files whose month overlaps `[since, now]`, tolerant line-by-line parse (corrupt or
alien-shaped lines skipped — reviewStore read discipline), never-throw. The dashboard
factory memoizes per shard on `(mtimeMs, size)` so 2 s polling doesn't re-parse an
unchanged 1 MB file.

## Component 2 — derived stats (`src/tui/queueStats.ts`)

`buildQueueStats(cfg, { healthBody, history, dirs }, deps)` → `QueueStats`:

```ts
interface QueueStats {
  gate: { state: string; reason: string | null; until: string | null } | null; // null when daemon down
  lastPollAt: string | null; // daemon heartbeat
  window24h: {
    done: number;
    failed: number; // ledger, else dir-mtime fallback
    successRate: number | null; // null when done+failed === 0
    avgDurationSeconds: number | null; // ledger only — null under fallback
    tokensIn: number | null;
    tokensOut: number | null;
    costUsd: number | null;
  };
  perDay7d: { done: number; failed: number }[]; // oldest→newest, ledger only ([] under fallback)
  etaSeconds: number | null; // eligibleWaiting × avg24h ÷ maxConcurrent; null without avg
  spend: { todayUsd: number; dailyBudgetUsd: number } | null; // healthBody.spend passthrough
  guards: { nudges: number; kills: number; requeues: number } | null; // null when daemon down
  outbox: { depth: number; dead: number };
  pendingRestartFields: string[];
}
```

- **Windows** are computed from the ledger. **Fallback:** when the ledger has zero
  records in a window (fresh upgrade), 24 h `done`/`failed` come from done/failed dir
  mtimes (stat only, no file reads); duration/token/cost fields and the 7 d buckets stay
  null/empty, so stats appear immediately after upgrade and fill in as tasks finish.
- **Gate** is read from the full `HealthBody.gate` (including `until`, which the
  `DaemonGateInfo` projection drops — queueStats does not reuse that projection).
- `spend`, `guards`, `gate`, `lastPollAt` are null when the daemon is down; dir-derived
  and outbox fields still populate.

**Snapshot widening (all additive).** `QueueSnapshot` gains `stats: QueueStats | null`;
`QueueRunning` gains `updatedAt: string | null` (currently dropped by `mkRunning`);
`QueueWaiting` gains `queuedAt: string | null` (inbox file mtime — rewritten on requeue,
so it reads as "waiting since last enqueue"); `QueueRecent` gains
`resultStatus: string | null`, `durationSeconds: number | null`, `prUrl: string | null`,
parsed from the `junco-result` meta block of the (already capped at 5) recent files via a
shared parser extracted from `listCmd.ts`'s `RESULT_STATUS_RE` into `src/resultMeta.ts`
(status + `duration_seconds` + `pr_url`; `listCmd` switches to it).
`makeQueueSnapshotFn`'s self-fetch path switches to `fetchHealthBody` (the full body —
gate/spend included); the `healthOverride` seam already passes the full body.

## Component 3 — rendering

**QueueView** (shared by the GitHub `t` view and the LOCAL queue section), per the
approved mock:

```
queue
▸ paused — rate limited (retry 14:32)          ← only when gate.state ≠ ok
RUNNING (1/2) · ↻ poll 2s ago                  ← heartbeat only when daemonUp
  ◐ #46 exec  junco-46-fix-tui…
     turn 14 · bash · 12.3k tok · 4m32s
     ⚠ no activity 5m                          ← only when now − updatedAt > threshold
WAITING (3 · 1 deferred · oldest 42m)
  1. #52 exec  retry 1 · queued 42m
RECENT
  ✓ #45 exec  completed 11m · 2h ago           ← resultStatus + duration when parsed
  ✗ #44 exec  timeout_partial 61m · 5h ago
STATS
  24h 14✓ 2✗ (88%) · avg 12m · ETA ~36m
  7d 84✓ 9✗ ▂▄▆▂▇▃▁                            ← ledger only; line omitted under fallback
  spend $4.20/$10 · tok 1.2M in 340k out
  guards 1 nudge · 3 requeues · outbox 2 queued
  ⚠ restart to apply: max_concurrent           ← only when pendingRestartFields ≠ []
```

Rules: every line degrades to absence (null field → segment or line omitted, bare row
kept). STATS rows are **never selectable** — the LOCAL selectable-row contract
(`selectedRow` indexes the WAITING ∪ RECENT concatenation) is unchanged. Stall threshold
`STALL_MS = 5 * 60_000` as a module constant. Sparkline maps each day's `done + failed`
onto `▁▂▃▄▅▆▇█` scaled to the 7-day max. Compact formats reuse `queueFmt.ts`
(`fmtCompact`, `fmtAge`, `fmtElapsed`); new helpers (`fmtSpark`, duration-from-seconds)
land there.

**Rail queue card:** a `▸ paused — <state>` line (theme.warn) directly under the `queue`
header when gate.state ≠ ok, and the waiting line becomes `3 waiting · oldest 42m`.

**`junco status`:** a `stats:` line (`24h 14 ok / 2 failed · avg 12m · oldest wait 42m`)
sourced from the same ledger reader + dir fallback, and a `gate:` line when ≠ ok
(state + reason). Existing lines unchanged.

## Data flow

One `/health` fetch per tick, as today: LOCAL cheap tick already fetches the body and
threads `healthOverride`; the GitHub-mode queue poll's self-fetch becomes
`fetchHealthBody`. `buildQueueStats` runs inside `makeQueueSnapshotFn` (both modes get
stats for free); the history reader's shard memo lives in the snapshot factory closure.
`junco status` calls the reader directly.

## Testing

- `taskHistory`: append/read round-trip, month-shard routing, corrupt-line skip, missing
  dir, never-throw writer (injected fs failure), memo invalidation on mtime change.
- `queueStats`: windows + rates with a fake ledger and injected clock; dir fallback;
  ETA arithmetic incl. null cases; gate/spend passthrough; daemon-down nulls.
- `runOnce`: each finalized path appends the right record (kind, status, usage, prUrl);
  requeue and orphan paths append nothing. Fixture sweep: flow-result fakes across
  `tests/{runOnce,prFlow,daemon}.test.ts` compile with the additive fields.
- `resultMeta`: parse status/duration/pr_url from real result blocks; `listCmd` parity.
- `QueueView`/`Rail`: paused banner, heartbeat, stall line, deferred/oldest header,
  enriched RECENT, all five STATS lines, each field's absence-degradation, and LOCAL
  selectable-row indices unchanged with STATS present (loop-until-condition, never one
  fixed tick).
- `statusCmd`: stats + gate lines, silent when empty.
- dataTree: registration bijection (constant/paths/ensure/deny/`junco data`).

## Compatibility

Everything is additive: new optional fields on snapshot/flow-result types, a new store
directory, new render lines. No ticket-schema change, no config lever, no `/health`
payload change. Older done/failed files without parseable result blocks render exactly
as today.

## Implementation deviations

- **(a) `PrFlowResult` was the only flow-result type that needed widening.** The
  assess/analyze flow results already carried `result: RunResult` (with `usage`/
  `durationMs` on it), so `runOnce.ts` could read those directly — no new fields there.
  Only `PrFlowResult` gained the additive optional `usage?: Usage` / `durationMs?:
number` fields, threaded from the underlying `RunResult` in `flowResult()`.
- **(b) The shard memo keys on `mtimeMs` alone**, not `(mtimeMs, size)` as this doc
  originally sketched — an append always bumps mtime, so a single key is enough, and it
  keeps `TaskHistoryDeps`'s `statFn` seam the same shape as the codebase's other
  stat-based memoization.
- **(c) `kind` is passed explicitly by the executed branch, not derived from ticket
  shape at the finalize point.** A `kindOf`-style guess from ticket frontmatter can
  diverge from what actually ran — e.g. a `repo: ""` ticket has `hasRepo` true but falls
  through to the Q&A path, and a ticket carrying both `repo:` and `github.kind: "plan"`
  actually runs the PR flow. Every finalize call site in `runOnce.ts` names its own kind
  directly; only the top-level crash-containment catch — where the branch that ran is no
  longer knowable once execution has thrown — falls back to a documented best-effort
  `kindEstimate(next)`.
- **(d) `perDay7d` day keys use DST-safe calendar-field arithmetic, not fixed 24h
  steps.** `buildQueueStats` builds each of the 7 day keys with
  `new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)` — the `spendLedger.ts`
  `nextMidnightMs()` precedent — rather than `now.getTime() - i * DAY_MS`: a fixed 24h
  step across a DST transition lands on a 23h/25h local day and skips (spring-forward) or
  double-counts (fall-back) a calendar-day key.
