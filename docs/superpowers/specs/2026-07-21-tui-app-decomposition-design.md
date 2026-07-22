# TUI App Decomposition — Design

Date: 2026-07-21. Sub-project B of the two-part effort begun in
`2026-07-21-test-suite-consolidation-design.md` (sub-project A, merged as #255).

## Goal

Decompose `src/tui/App.tsx` (3,077 lines, one `App` component holding ~121
hooks: 43 `useState`, 18 `useRef`, 18 `useEffect`, 19 `useMemo`, 22
`useCallback`) into coherent, independently-testable custom hooks — improving
**testability, isolation, and performance**. Behavior is preserved exactly; the
189 black-box TUI tests that render `App` are the invariant safety net and must
stay green at every commit.

The render tree is already fully extracted into `src/tui/components/`. Only
state, effects, and handlers remain in `App`. This effort extracts those.

## Decisions (user-confirmed)

- **Depth:** leaves **and** the fused issues/PRs core. Not a leaves-only pass.
- **Performance:** the `React.memo` pass on the big render components is a
  committed deliverable, not measure-gated — but baseline and after render
  counts are measured and reported so the actual impact is known, not assumed.
- **The nav spine stays in `App`.** `view`/`pane`/`railSel` and their derived
  `currentNwo`/`sysSection`/`body`/`railIdx`/`selectedRow` are read by nearly
  every domain; they remain App-level state passed _into_ the domain hooks as
  the shared focus context.

## Architecture: three extraction tiers + a composition spine

### Tier 1 — leaf hooks (low risk, extract first)

Each owns isolated state with few or no cross-reads (map §3). New files under
`src/tui/hooks/` (a new directory; existing `use*.ts` at `src/tui/` root stay
where they are — `useScroll`, `useLogTail`, `useTerminalSize`, `useGuardedInput`,
`useSuspend` are shared mechanics, not domain hooks).

| Hook                                                        | Returns                                                | Absorbs (App lines)        |
| ----------------------------------------------------------- | ------------------------------------------------------ | -------------------------- |
| `useToast()`                                                | `{ toast, showToast, dismissToast }`                   | 321, 322, 557, 562, 1552   |
| `useConfirm()`                                              | `{ confirm, askConfirm, clearConfirm }`                | 359, 1229                  |
| `useHealth(client, pollMs)`                                 | `health`                                               | 323, 921                   |
| `useQueueSnapshot(queueFn, pollMs)`                         | `{ queueSnap, queueNow }`                              | 324, 325, 936              |
| `useAssessHistory(fn, pollMs)`                              | `assessHistory`                                        | 326, 954                   |
| `useUpdateCheck(fn?)`                                       | `updateLatest`                                         | 377, 972                   |
| `useBotLogin(fn?)`                                          | `botLogin`                                             | 381, 994                   |
| `useReview(client, showToast, …)`                           | `{ reviewState, …transitions }`                        | 311, 1702–1834 slice       |
| `useCmdOutput(runCliFn, …)`                                 | `{ cmd, cmdElapsed, runPaletteCommand }`               | 333, 334, 1261, 1268, 1269 |
| `usePalette(runPaletteCommand, showToast, onRequestWizard)` | `{ palette state, paletteEnter }`                      | 329–332, 1295              |
| `useLogOverlay(logPath, logsPollMs?, logReaderDeps?)`       | `{ overlay state, logEntries, handleLogOverlayInput }` | 363–374, 460, 471, 2200    |
| `useAddRepoForm(watchlist.addEntry, showToast, setView)`    | `{ addRepoError, addRepoBusy, handleAddRepo }`         | 327, 328, 1385             |

`useToast` is extracted **first**: `showToast` is called from nearly every other
domain, so establishing it as a clean service simplifies every later extraction.
`useQueueSnapshot` exposes `queueNow` — the shared render clock passed to Header,
rail, lists, and cards.

### Tier 2 — `useWatchlist(watchlistFile, configRepos)`

Returns `{ repoMappings, watchlistEntries, watchlistError, addEntry, removeEntry }`.
Owns Domain A (274, 277) and the `repoMappings` memo (387) — the union of
`configRepos` and the mutable watchlist that feeds all GitHub data. Moderate
risk: `repoMappings` identity flows into `refreshAll`'s deps.

### Tier 3 — `useGithubData({ nav, repoMappings, client, showToast, aliveRef })`

The hard core. Absorbs Domains B (issues) + C (PRs) + the unified-refresh
sub-domain and its three anchor-validation effects. `nav` is the read-only
spine input (`currentNwo`, `view`, `pane`, `bodyKind`).

Returns:

```
{
  issues, staleAt, prs, prStaleByRepo,            // data
  selectedNum, prSel, pane3SelNum,                // selection anchors
  refreshedAt, refreshing, refreshAll,            // unified refresh
  loadIssues, loadPrs, loadPrsFor, setIssueLabels,// loaders
  moveIssue, movePr, movePane3, …,                // movers (Domain B/C)
  evictRepo,                                        // for unwatch's cross-domain cleanup
}
```

Absorbs App lines: 282–306 (data/anchors), 335/338/341/343/653/661/670/806/808/893
(refs), 732/765/792/816/1017 (loaders), 850/865/880/894/911/1009 (effects),
and the B/C mover/window blocks (1495–1543).

### Stays in `App` (composition spine)

Never extracted (map §5): the nav spine D (`view`/`pane`/`railSel` +
derived), `useScroll`/`scrollKey` (439, 452 — one instance multiplexed across
surfaces), the two mouse hooks (2177, 2181), both `useGuardedInput` handlers
(2190 quit, 2289 the ~330-line dispatch cascade), the unmount `aliveRef` (1031),
and the derivation stack `bindingContext → bindings → actionHandlers →
structuralChipActions → chipActions` (1589–2162), which reads every domain by
construction and feeds both the footer chips and the keyboard tail.

Two **cross-domain composers** stay in `App` as thin orchestrators, because they
legitimately span two hooks:

- `unwatch` (1331): `watchlist.removeEntry(nwo)` then `github.evictRepo(nwo)`,
  plus `showToast`.
- `handleAddRepo`: lives in `useAddRepoForm`, calls the injected
  `watchlist.addEntry` and `setView`.

## Data flow

`App` composes: nav-spine state → derived `currentNwo`/`sysSection`/`body` →
passed as `nav` into `useGithubData` and read by leaf hooks that need it
(`useLogOverlay` reads `sysSection`/`view` for `logActive`). Each hook's returned
`{data, selection, actions}` flows into its render component. The binding stack
consumes all hook outputs and produces `chips`/`chipActions` for the footer and
the input handler. `queueNow` (from `useQueueSnapshot`) and `showToast` (from
`useToast`) are the two cross-cutting services threaded to consumers.

No hook reaches into another hook's state. Where a handler spans domains
(`unwatch`), `App` orchestrates via each hook's exposed mutator. This is the
isolation invariant: a hook can be understood and tested without reading any
other hook's internals.

## Performance

**Committed deliverable:** wrap the big leaf render components in `React.memo`
so a poll that updates one domain (e.g. `health` @5s) does not re-render
unrelated subtrees (e.g. `IssueList`, `PrList`, `UnifiedRail`, `RepoDetail`,
`Preview`, `PrPreview`, the section views). Their props are already derived via
`useMemo`; memoization pays off when those derivations are stable across an
unrelated poll.

**Measured, not assumed.** A test-harness render counter (a `data-testid`-style
counter incremented in each target component's body under a test flag, or a
counting wrapper injected via the existing fixture seam) records how many times
each big component renders across a fixed poll sequence — captured at baseline
(before any change) and after the memo pass. The delta is reported in the final
summary. Honest expectation: on a terminal polling every 3–30s the perceptible
win may be small; the number will say so either way.

## Testing

Two layers:

1. **The 189 black-box tests are the invariant.** They drive `stdin.write` and
   assert `lastFrame()` through App's prop seam, so they are refactor-invariant
   as long as composed behavior is preserved. All must stay green at **every**
   commit. Harnesses: `tests/helpers/localFixtures.tsx` (`renderApp`, 120-col
   wide, 8 files) and `tests/tuiApp.test.tsx`'s own `renderApp` (100-col medium).
   CLAUDE.md Ink gotcha: never assert one fixed `setTimeout` tick — use the
   `until()`/`tap` loop-until-condition helpers.

2. **Each extracted hook gets a focused unit test** (the isolation payoff),
   following the repo's established pattern (`tests/useLogTail.test.tsx`): a tiny
   `Probe` component calls the hook and renders its state as text, driven via
   `ink-testing-library`'s `render`/`rerender`, asserting on `lastFrame()`. Poll
   hooks inject a fake `fn` and a large `pollMs`; `useToast` asserts
   show-then-auto-dismiss; `useGithubData` gets the most coverage (anchor
   validation on repo change, refresh aggregation, `evictRepo`).

## Sequencing (de-risking)

1. **Baseline** — instrument the render counter, capture counts, full suite green.
2. **Leaves**, one hook per commit, in dependency order: `useToast` → `useConfirm`
   → `useHealth` → `useQueueSnapshot` → `useAssessHistory` → `useUpdateCheck` →
   `useBotLogin` → `useReview` → `useCmdOutput` → `usePalette` → `useLogOverlay`
   → `useAddRepoForm`. Each: extract hook + Probe unit test + full suite green.
3. **`useWatchlist`** — extract, unit test, suite green.
4. **`useGithubData`** — the hard core, done last. May be split into sub-commits
   (data+loaders first, then anchor effects, then movers) but each sub-commit
   keeps the suite green.
5. **Memoization pass** — `React.memo` the big components, re-measure, report the
   before/after render deltas.
6. **Docs** — update `ARCHITECTURE.md`'s TUI module note if the hook layout
   warrants it; CLAUDE.md only if a new gotcha emerges.

Each step is behind the 189 tests. App shrinks progressively; the risky core is
attempted only after the leaves have proven the pattern and reduced the surface.

## Risks

- **The fused core (Tier 3).** `refreshAll`, `unwatch`, and the three anchor
  effects weld A+B+C together (map §3, Hub 2). Mitigation: extract it last,
  behind an interface that returns exactly what App currently derives; keep the
  189 black-box tests green at each sub-commit; split into data → effects →
  movers if a single commit is too large to verify confidently.
- **Effect dependency identity.** `useGithubData`'s `refreshAll` dep array must
  reproduce the current identity behavior (an A change re-identities it, driving
  effect #13). A subtle change here causes either a missed refresh or a poll
  storm. The anchor effects (865/880/894) must fire on the same transitions.
- **`logReaderDeps` stability.** AppProps documents that `logReaderDeps` must
  stay `undefined` in production so `useLogTail`'s effect dep identity is stable
  (App.tsx 123–126). `useLogOverlay` must preserve this exactly.
- **Live runtime.** The daemon renders this TUI from the main checkout. Test-
  green at every commit is the guard; the memo pass must not change what renders,
  only when.

## Out of scope

- The nav-spine state machine (D) itself — it stays in App by design.
- The `bindingContext → chipActions` router — composition-level, stays.
- Any change to the render components' output — memo wraps them, does not alter
  them.
- Splitting App into multiple mounted components (a bigger architectural change
  than hook extraction; not needed for the goal).
