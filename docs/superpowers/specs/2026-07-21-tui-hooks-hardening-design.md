# TUI Hooks Hardening — Design

Date: 2026-07-21. Addresses the four follow-ups filed from #258 (the App.tsx
hook decomposition): #259, #260, #261, #262.

## Goal

Close all four #258 follow-ups in **one PR**, ending with `eslint-plugin-react-hooks`
enforcing **both** `rules-of-hooks` and `exhaustive-deps` as errors — the state
that would have caught the very defects this cleanup fixes. Behavior-preserving
throughout; the ~189 black-box TUI tests stay green at every commit.

The four issues:

- **#259** — stabilize App's callback props so the 9 inert `React.memo` wrappers
  from #258 actually bail out (the performance win the memo pass set up but
  didn't deliver).
- **#260** — add `eslint-plugin-react-hooks`; rules-of-hooks is not currently
  lint-enforced.
- **#261** — unify the React type-import style across the TUI hooks (cosmetic).
- **#262** — extract the local-snapshot domain (E: `localCheap`/`localHeavy`/
  `sectionCursor`/`repoDetailTarget`) into `useLocalSnapshot`.

## Decisions (user-confirmed)

- **One PR** for all four. #262 is a real refactor but ships in the same branch.
- **Both rules as errors** is the end state. Reached via a warn→fix→ratchet path
  (below) so no intermediate commit is red.

## The sequencing: warn → fix → ratchet-to-error

`exhaustive-deps` fires on every hook-using file, which here is all of
`src/tui/` — App.tsx's ~330-line input cascade and its binding/action/memo stack
have large, deliberately-curated dep arrays. Adding the rule as an error before
fixing violations would leave the repo lint-red between commits, breaking the
green-at-every-commit discipline. So the **path** uses `warn` as the discovery
tool; the **end state** is `error`.

Five phases, sequenced:

1. **#261 — unify React type-imports.** Trivial, no dependencies. On
   `useReview.ts`'s named-`import type` style: `useGithubData.ts` (uses
   `import type React` + `React.Dispatch`) and `usePalette.ts`/`useLogOverlay.tsx`/
   `useAddRepoForm.ts` (use `React.*` via the UMD global, no import) convert to
   named imports (`Dispatch`/`SetStateAction`/`MutableRefObject`). ~4 files.

2. **#260a — add the plugin, `exhaustive-deps: warn`.** Install
   `eslint-plugin-react-hooks` (exact-pinned). Enable `rules-of-hooks: error`
   (zero violations exist today — the #258 whole-branch review verified this by
   inspection, so it passes clean) and `exhaustive-deps: warn`. Build stays green
   (warnings don't fail lint). The warning list is now the work queue.

3. **#259 + the exhaustive-deps triage.** The substantive middle. Run the linter,
   **enumerate every `exhaustive-deps` warning**, and triage each into one of two
   buckets:
   - **Fix (stabilize):** the prop-stabilization warnings — `railRowPress` and
     `sectionRowPress` (plain component-body functions → `useCallback`), plus the
     inline JSX arrows passed to the memo'd components (`onWheel={(d) => …}`,
     `onRowPress={(i) => …}`, `assess={(nwo) => …}`). Stabilizing these lets the
     9 inert memos bail out. Measure the win: re-run `tests/renderPerf.test.tsx`
     with the render-count seam; components that were bumping every render should
     go flat, and the perf test's assertions extend to them.
   - **Annotate (justify):** deliberately-curated dep arrays where a full dep set
     would be wrong (e.g. the input cascade reading many values but keyed to a
     narrower trigger, or an effect that must not re-fire on a value it reads).
     Each gets `// eslint-disable-next-line react-hooks/exhaustive-deps -- <reason>`
     with a concrete reason — never a blanket file-level disable.
     Multiple commits, each green, each shrinking the warning count. A stabilized
     callback must not introduce a stale closure — this is the real risk (see
     Risks).

4. **#260b — ratchet `exhaustive-deps` to `error`.** Once the warning count is
   zero, flip `warn` → `error`. Now fully enforced; a future unstable dep fails
   the build.

5. **#262 — extract `useLocalSnapshot`.** Move domain E out of App.tsx:
   `localCheap`/`localHeavy`/`sectionCursor`/`repoDetailTarget` + their two
   polling effects (cheap @3s section-scoped, heavy @15s). The hook takes the
   nav input it needs (`sysSection` scopes the cheap poll) and the injected
   `localCheapFn`/`localHeavyFn`; App reads back the values. Same seam pattern as
   the 14 hooks from #258, with a Probe unit test. Verified green under the
   now-strict lint (so the new hook's deps are enforced from birth).

## The one genuine unknown

The count of `exhaustive-deps` violations across `src/tui/` is not knowable until
the plugin runs — Phase 2 surfaces it. **Phase 3's size is discovered, not
predicted.** The plan's first substantive step is explicitly "run the linter,
enumerate the warnings, triage each." If that list is large enough that the
cascade fundamentally fights the rule (many unavoidable annotations), that is the
checkpoint to reconsider with the user whether `exhaustive-deps: error` earns its
maintenance cost — before doing the full audit. The plan carries this as an
explicit decision gate, not a silent assumption.

## Testing

- **The ~189 black-box TUI tests are the behavior invariant.** #259's
  stabilization and #262's extraction must not change observed behavior; all
  stay green at every commit.
- **`tests/renderPerf.test.tsx`** (from #258) is the perf oracle: it measures,
  via the `JUNCO_RENDER_COUNT=1` seam, whether a component re-renders on an
  unrelated poll. #259 extends its assertions to the newly-stabilized
  components; a stabilization that doesn't actually flatten a component's count
  fails the test.
- **`useLocalSnapshot` gets a Probe unit test** (the #258 pattern): the cheap/
  heavy polls populate their state; the cheap poll re-scopes on `sysSection`.
- **The lint config itself** is the meta-test: `npm run lint` green with both
  rules as errors is the acceptance criterion for #260.
- Full gate (`lint && format:check && typecheck && build && test`) green at
  every commit.

## Risks

- **Stale closures (the real one).** Wrapping `railRowPress`/`sectionRowPress`
  and the inline arrows in `useCallback` with an incomplete dep array produces a
  handler that reads stale state — a genuine bug the black-box tests may not
  catch if they don't exercise the exact stale path. Mitigation: `exhaustive-deps`
  (now on) is precisely the guard — a `useCallback` with a missing dep warns/errors,
  so the linter co-designs the stabilization. Prefer stabilizing the _source_
  (e.g. memoize the data the handler closes over) over widening the callback's
  deps until it re-identifies every render (which would defeat the memo).
- **`exhaustive-deps` audit size** (see The one genuine unknown) — bounded by the
  Phase-3 decision gate.
- **`useLocalSnapshot` ↔ nav coupling.** The cheap poll is `sysSection`-scoped;
  the extraction must pass `sysSection` as an input and preserve the re-scope-on-
  section-change behavior exactly (mirrors how #258 handled the useGithubData nav
  inputs). The black-box tests covering the system sections are the net.
- **Live runtime.** Merge promotes to the daemon; green-at-every-commit + the
  behavior invariant are the guard, same as #258.

## Out of scope

- Any behavior change to the dashboard. This is hygiene + perf-activation +
  one more extraction — all behavior-preserving.
- `exhaustive-deps` beyond `src/tui/` — the rule only fires on hook-using files,
  and hooks live under `src/tui/`; no other subtree is affected.
- The pre-existing `useWatchlist` render-phase `readWatchlist()` read (noted in
  #258's review as moved-not-introduced) — left as-is unless the audit implicates
  it.
