# Unified view-scoped refresh — Design

**Goal:** one `↻ Xs` refresh indicator in the dashboard's top bar covering everything on
screen, replacing the per-pane issues/PRs stamps (PR #13) — backed by ONE poll cycle
whose scope follows the current view, so the indicator reports the thing that actually
runs.

**Chosen over** (a) a display-only aggregate chip on top of the existing two timers and
(b) a most-recent-update chip: the maintainer picked full poller unification as the
cleanest model, then scoped it: polling is O(1) per cycle in the main view instead of a
watchlist-wide fan-out every 60s.

## Cycle semantics

One interval, `refreshPollMs` (default 30_000, replacing `issuePollMs` 30s and
`prPollMs` 60s — both were internal App defaults; nothing external configures them).
Each cycle's scope follows the view, read via refs so the interval never goes stale:

- **Main view** (and its overlays: detail, palette, queue, …): `listIssues(currentNwo)`
  - `listPrs(currentNwo)` — the rail-selected repo only. 2 API calls per cycle
    regardless of watchlist size.
- **PR monitor** (`p` view, and `prDetail` on top of it): `listPrs(nwo)` for EVERY
  watched repo — the monitor is the one place cross-repo freshness is the point. No
  issues call. (Confirmed: `listPrs` returns junco-authored PRs only — head branch
  under `cfg.branchPrefix`, via the shared `fetchJuncoPrs` core.)

Immediate cycles outside the interval:

- Rail selection change (and mount): scoped cycle for the new repo (replaces the
  current `useEffect([currentNwo]) → loadIssues` body).
- Entering the PR monitor (`p`): full sweep cycle.
- `r` in BOTH the main view and the monitor: run the current view's cycle now, with the
  existing `refreshing` spinner wiring. One keypress means one thing everywhere.
- Startup additionally runs ONE full PR sweep (dedicated mount effect) so the ⚑
  attention chip and the monitor's aggregate list are populated. After that,
  non-selected repos' PR data ages until the next monitor visit — the accepted cost of
  O(1) polling.

## Stamp semantics

New App state `refreshedAt: string | null` (replaces `issuesFetchedAt` per-repo map and
`prsFetchedAt`), set when a cycle completes:

- All delivered sources fresh → completion time.
- Any source cache-served (offline) → the OLDEST `staleAt` among the cycle's delivered
  sources — the stamp shows the true age of the stalest data; a cycle that fetched
  nothing fresh never rejuvenates it (PR #13's pinned regression, carried over).
- A source that failed outright is ignored (its failure surfaces via the existing
  toast/offline paths); a cycle where NOTHING delivered does not advance the stamp.

## PR aggregate becomes per-repo mergeable

`loadPrs` (all-repos loop) gains a single-repo sibling `loadPrsFor(nwo)` that replaces
just that repo's slice of the `prs` aggregate and re-sorts. The single aggregate
`prStaleAt` becomes a per-repo map (`prStaleByRepo`), with the list's stale marker
derived as the oldest non-null entry among watched repos — a scoped fresh fetch clears
only its own repo's staleness. Loaders return their delivery outcome
(`{ delivered: boolean; staleAt: string | null }`) so the cycle can aggregate the stamp.

## UI

- `Header` (Chrome.tsx) gains `refreshedAt: string | null`, rendered as a dim
  `↻ 12s` chip in the right-hand chip group (`relTimeShort`, ticking off the `now` the
  Header already receives; `flexShrink: 0`; present in wide AND narrow modes; hidden
  until the first cycle completes).
- `IssueList` and `PrList` lose their `fetchedAt` prop and `↻` title stamp. The older
  `offline · HH:MM` badge (staleAt-keyed) is untouched.

## Tests

- `renderApp`'s `issuePollMs`/`prPollMs` params collapse to one `refreshPollMs`
  (3rd position); the deflaked anchor tests keep their advance-latch semantics.
- Pane-stamp tests (tuiIssueList/tuiPrList) are replaced by Header-chip tests plus App
  cycle tests: stamp on completion; oldest-cache-age wins; nothing-delivered doesn't
  advance; `r` fires both fetches in main view; monitor entry sweeps every watched
  repo; a main-view cycle calls `listPrs` ONLY for the selected repo (post-startup).
- Docs: `docs/dashboard.md`, `docs/github-mode.md` — per-pane stamp text → top-bar
  chip + scoped-polling description.
