# PR Tracking — dashboard PRs view + `junco prs` CLI

## Context

Junco authors PRs (14-phase prFlow, GitHub-mode `Closes #N`, offline outbox) but has **zero surface for tracking them afterward**: fresh PRs persist only a `pr_url` in done/ tickets (src/finalize.ts:103), no number/title, and the operator falls back to the GitHub website. The story: track junco-authored PRs with all available metadata and one-key link access, from the dashboard — plus a `junco prs` CLI (user opted in).

**Key insight from exploration:** junco PRs are reliably identified live via `gh pr list` filtered by head-branch prefix — `deriveBranchName` (src/repoContext.ts:31) creates `<branchPrefix><ticket-slug>` (`cfg.branchPrefix`, default `"junco/"`, src/config.ts:164). The branch name also **encodes the originating ticket id** — free ticket linkage. No new config keys needed (reuses watched repos + branchPrefix). Zero new dependencies.

**Scope decisions (user-confirmed):** show open + recent history (`--state all`, limit 50/repo, attention-first sort); ship `junco prs` CLI + palette entry alongside the dashboard view.

## Design summary

- **`p`** toggles a PRs view in the pane-2 slot (same 6-touch-point pattern as the `t` queue view): selection list (IssueList-style windowing/`▌` bar), cross-repo flat aggregate, rows `glyph · #num · title · repo · ✓/✗/◍ checks · review · ±stats · age`. **`o`/`enter` opens the selected PR in the browser** (`gh pr view --web`).
- **Wide mode (≥110 cols)**: pane-3 renders a zero-fetch `PrPreview` card from data already in the row — checks breakdown, review decision, mergeable, `branch ← base`, **ticket slug** (branch minus prefix), ±stats, merged age.
- **Header pulse chip**: `⚑N PR` = count needing attention (checks-failing + changes-requested); `theme.error` when any failing else `theme.warn`; essentials tier; hidden at 0.
- **Selection anchored by `{nwo, number}`** — PR numbers collide across repos; a bare-number anchor would jump on re-sort.
- **Offline**: per-repo disk cache mirroring the issue-list pattern (`prs-<owner>__<repo>.json`, serve on `isOffline` with a stale marker).
- `derivePrState` precedence: `merged → closed → draft → checks-failing → changes-requested → checks-pending → approved → review-pending`. Sort groups: failing/changes=0, pending/review=1, approved=2, draft=3, merged/closed=4; recency within group.

## Files

### New

- **`src/tui/prState.ts`** (pure): `DashPr` interface (number/title/url/headRefName/baseRefName/isDraft/state/reviewDecision/mergeable/mergeStateStatus/reduced `checks {pass,fail,pending,total}`/additions/deletions/changedFiles/createdAt/updatedAt/mergedAt/author/labels + injected `nwo`), `PrLifecycle` (8 states above), `derivePrState`, `prStateMeta` (glyph/color/badge — semantic palette only, never `theme.accent`), `sortPrs`, `filterPrs`, `reduceChecks(rollup: unknown)` (handles CheckRun `status/conclusion` + StatusContext `state` shapes; `null`/non-array → zeros), `ticketSlugFromBranch(headRefName, branchPrefix): string | null`.
- **`src/tui/components/PrList.tsx`**: clone of IssueList mechanics (src/tui/components/IssueList.tsx:35-115 — windowSlice + useRef prevStart, selection bar, height budget, position indicator, offline marker; reuse exported `relTime`).
- **`src/tui/components/PrPreview.tsx`**: pane-3 card, no fetch/scroll/cache (all data is in the row).
- **`src/prsCmd.ts`**: `runPrsCommand(cfg, deps)` — reuses the same listing logic (share `listPrs`'s fetch/filter/map via a small exported helper in ghClient or a shared module so CLI and TUI can't drift — decide at implementation; prefer exporting the fetch+map from `src/tui/prState.ts`-adjacent pure code with gh args built once). Output: one line per PR — `#num  state-badge  checks  title  url`, grouped attention-first; `prs empty` when none; exit 0. Mirror retryCmd's deps/printFn conventions (src/retryCmd.ts).

### Modified

- **`src/tui/ghClient.ts`**: `DashboardClient` gains `listPrs(nwo): Promise<Result<{prs: DashPr[]; staleAt: string | null}>>` (gh args: `pr list --repo <nwo> --state all --limit 50 --json number,title,url,headRefName,baseRefName,isDraft,state,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,additions,deletions,changedFiles,createdAt,updatedAt,mergedAt,labels,author`; map + branch-prefix filter at map time so the cache stays compact; cache/serve mirroring listIssues at ghClient.ts:181-225 with new `prs-` cache path — do NOT change the exported `cachePathFor`) and `openPrInBrowser(nwo, num)` (clone of openInBrowser at :343 with `pr view --web`).
- **`src/tui/App.tsx`**: View union + `"prs"`; props `branchPrefix: string`, `prPollMs?: number` (default 60_000); cross-repo aggregate poll (alive-guard pattern like health/queue at :302-331, NOT the per-selected-repo nwoRef pattern); `{nwo,number}` selection anchor with index-clamp fallback (mirror :207-216); input-router `prs` branch (peer of `queue` at :621-629): ↑/↓ j/k move, g/G, `o`/`enter` open browser, `esc`/`p` back with `setScroll(0)`; main-view `p` key next to `t` (:695); pane-2 ternary entry (:865); pane-3 gate widened to `view==="main" || view==="prs"` with `PrPreview` for prs; `prAttention` useMemo (analog of reviewCount :233-245) → Header.
- **`src/tui/components/Chrome.tsx`**: `HintView` + `"prs"`; `Header` gains `prAttention` + chip after the review chip (flexShrink 0, one-line CHROME_ROWS invariant); `hintsFor` case `prs` (`["↑/↓","move"],["o/enter","open"],["esc/p","back"]`) + `["p","PRs"]` in main pane-2 hints.
- **`src/tui/components/HelpModal.tsx`**: `p` row in "panes & views".
- **`src/dashboardCmd.ts`**: pass `branchPrefix: cfg.branchPrefix` into App.
- **`src/cli.ts`**: `prs` case (lazy import) + USAGE line; **`src/tui/cliRunner.ts`**: palette roster `cmd("prs", null, "List junco-authored pull requests")`.
- **`docs/dashboard.md`**: `p` key row, PRs-view zone bullet, pulse-chip mention. **README.md**: CLI table gains `junco prs`.

## Task breakdown (TDD, commit per task, suite green each commit)

1. **`prState.ts`** + `tests/tuiPrState.test.ts` — it.each lifecycle table, precedence, `reduceChecks` shapes (CheckRun/StatusContext/mixed/null), sortPrs, filterPrs, ticketSlugFromBranch (prefix-without-trailing-slash, non-junco → null).
2. **ghClient `listPrs` + `openPrInBrowser`** + `tests/tuiGhClient.test.ts` (extend `fakes()` router with `pr list`/`pr view`) — mapping, junco-filter, offline cache-serve, malformed rollup tolerance. **Same commit: stub the two methods into every `DashboardClient` literal** (`tuiApp.test.tsx` makeClient :63-101 AND makeSeqClient :105-137) — closed interface, build breaks otherwise.
3. **`PrList`** + `tests/tuiPrList.test.tsx` — rows, windowing, selection, empty state, offline marker (frames ≤100 cols).
4. **`PrPreview`** + `tests/tuiPrPreview.test.tsx` — checks line, review, branch ← base, ticket slug + "—" fallback, merged age.
5. **App integration** + `tests/tuiApp.test.tsx` — `p` opens/toggles, cross-repo aggregation renders both repos, `o` calls openPrInBrowser with `{nwo,number}`, re-sort keeps the anchored PR, esc returns. `renderApp` gains `branchPrefix="junco/"`. **Every async-dependent assertion uses the file's bounded `until()` helper — never fixed ticks** (this file's flake history is the cautionary tale).
6. **`junco prs` CLI** + `tests/prsCmd.test.ts` + cli.ts/USAGE + palette roster (extend the roster↔USAGE consistency test in `tests/tuiCliRunner.test.ts`).
7. **Chrome/help/docs wiring** + `tests/tuiChrome.test.tsx` — Header fixture sweep (`prAttention` on all Header literals), chip show/hide/color, hintsFor("prs"), README/docs rows.

## Verification

- Per task: named vitest suites green; full gate (`npm run lint && npm run format:check && npm run build && npx vitest run`, exit codes captured, never piped through filters) at every commit.
- Fixture-sweep hotspots (build breaks if missed): `tuiApp.test.tsx` makeClient/makeSeqClient literals (Task 2), `tuiChrome.test.tsx` Header fixtures (Task 7), `tuiGhClient.test.ts` fakes router (Task 2).
- End-to-end (maintainer TTY smoke, read-only): `junco dashboard` on the live watchlist → `p` shows the PRs junco opened on hawaiian-coral with real check/review states → `o` opens the browser; `junco prs` prints the same list with URLs. No dispatching on live issues.
- Execution: subagent-driven (implementer + reviewer per task, final whole-branch review) on branch `feat/pr-tracking` stacked on `feat/arrow-nav` (PR #3's branch — this story rides the same release train per "before we send off").

## Risks (accepted/mitigated)

- Cross-repo poll cost: `statusCheckRollup` is a heavier GraphQL call — 60s interval, limit 50, per-repo independence (one offline repo serves its cache, never blocks others).
- Branch-prefix false negatives: tickets with custom `branch_name` frontmatter won't appear (documented caveat); coincidental `junco/` branches would (acceptable).
- `reviewDecision` `""` vs null treated identically ("no decision"); repos with no CI → zeroed checks, never spurious "failing".
- Shared `scroll` reset on view enter/exit (the stale-scroll lesson from the workspace build).
- `/` filter in the PRs view: `filterPrs` built + tested but wired as follow-up (filter-state interplay with repo switching kept out of v1).
