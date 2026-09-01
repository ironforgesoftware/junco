# Ink Render Performance — Design

Date: 2026-09-01. Follow-up to the `React.memo` perf pass (#259) and the
2026-07-21 App-decomposition spec. Scope approved by the maintainer: tiers 0–2
below (the frame harness, change-gated polls with a standalone age clock, and
the animation/bytes work). Tier 3 (terminal-focus-aware cadence) was offered
and deferred.

## Goal

Make the dashboard's idle state produce **no Ink frames** when no polled data
has changed, and make in-flight animation cheap on the wire — measured, with a
regression test that pins the result. Behavior of every view is preserved
exactly; the only observable change is that sub-minute "Ns ago" strings step
in 5 s increments instead of 1 s.

## Evidence (measured 2026-09-01, Ink 7.1.0, Node 22)

Real `App` under Ink's own `render()` with fake TTY streams and constant-data
polls (queue/health/local-cheap/assess-history all at 100 ms):

| Scenario                                | Result                                             |
| --------------------------------------- | -------------------------------------------------- |
| No polls, 220×60                        | 0 frames in 1 s — nothing animates at idle         |
| Constant-data polls, 220×60             | 1 frame per poll tick, 6.1 ms mean render          |
| Constant-data polls, 120×30             | 1 frame per poll tick, 2.8 ms mean render          |
| `incrementalRendering: true`            | same CPU; animation frames 15.6 KiB → 0.4 KiB      |
| Queue snapshot poll (50 / 1000 done)    | 1.0 ms / 2.9 ms                                    |
| CPU profile of one frame                | 48% ansi-tokenize (compositor), 19% GC, 3.6% Yoga  |

Conclusions that shape the design:

1. **Every poll tick with unchanged data still commits a frame.** Each poll
   hook stores a fresh object (`setQueueSnap(s)`, `setHealth(h)`, a new `Map`
   for assess history, fresh `LocalCheap`/`LocalHeavy`) and
   `useQueueSnapshot` bumps a `queueNow: Date` on every tick — so React never
   bails out, and Ink re-lays-out and re-serializes the whole screen. At the
   production cadence (queue 1 s, local-cheap 3 s, health 5 s, assess 15 s)
   that is ~1.6 frames/s at idle. Ink already skips the terminal *write* when
   the output string is identical, so this is CPU (≈1% of a core on a large
   terminal), not flicker.
2. **Per-frame cost is inside Ink's output compositor, not layout.** Yoga is
   3.6% of a frame; the ANSI tokenizer and its garbage are two thirds. So
   reducing Box nesting (fewer Yoga nodes) is *not* a lever and is rejected.
   The app-level levers are: fewer frames, and fewer bytes per frame.
3. The pollers themselves are cheap (1–3 ms); no caching work is warranted.

## Decisions (maintainer-confirmed)

- Scope: tiers 0–2. Tier 3 (focus events → slower cadence) deferred.
- The age clock is a fixed 5 s tick, not adaptive. Every `now` consumer
  renders ages at minute granularity except the sub-minute `Ns ago` form; a
  5 s step there is acceptable.
- Structural equality uses `node:util`'s `isDeepStrictEqual`. No new
  dependency; every gated value is plain data (strings, numbers, nulls,
  arrays, records).

## Architecture

Three tiers, each independently landable and revertible, in this order.

### Tier 0 — frame harness (measurement first)

**`tests/helpers/inkFrames.tsx`** — mounts `<MouseProvider><App …/></MouseProvider>`
through Ink's real `render()` (not ink-testing-library, which cannot observe
frames that produce identical output) on fake TTY streams:

- stdout: a `Writable` with `columns`/`rows`/`isTTY = true` and a byte
  counter; stdin: an `EventEmitter` with no-op `setRawMode`/`setEncoding`/
  `ref`/`unref`/`pause`/`resume`/`read`.
- Ink options: `{ exitOnCtrlC: false, patchConsole: false, alternateScreen:
  true, incrementalRendering, onRender }` — `onRender` records Ink's own
  `renderTime` per committed frame.
- Props come from `makeAppProps` (tests/helpers/localFixtures.tsx) with the
  caller's overrides.
- Returns `{ frames: number[], bytes(): number, reset(): void, unmount(): void }`.

**`tests/framePerf.test.tsx`** — the acceptance test for tier 1:

- *Idle is silent:* every poll fn returns the same fixture on every call and
  counts its calls; polls run at 25–50 ms; after mount-settle and `reset()`,
  wait (bounded `until`) for ≥ 20 further poll ticks, then assert
  `frames.length === 0`. Fails before tier 1 (≈ 1 frame per tick); passes
  after.
- *Change still paints (positive control):* flip the queue fixture once
  (e.g. add a waiting row); assert ≥ 1 frame within the bounded wait. This
  guards the gate from ever hiding a real update.
- *Clock paints:* with `clockMs` small and polls off, assert ≥ 1 frame per
  clock tick and that the frame count is bounded by the tick count (no
  double-commits).
- Writes mean `renderTime` per scenario to `JUNCO_PERF_OUT` when set (same
  convention as `renderPerf.test.tsx`), so before/after numbers in the PR are
  reproducible.

Timing rule (CLAUDE.md): never a single fixed tick after a state change —
count injected poll calls and loop-until-condition with a bounded retry.

### Tier 1 — change-gated polls + standalone clock

**`src/tui/hooks/keepIfEqual.ts`**

```ts
import { isDeepStrictEqual } from "node:util";
/** Return `prev` when `next` is structurally identical, so a `useState`
 * updater that returns it lets React bail out (Object.is) — no commit, no
 * Ink frame. */
export function keepIfEqual<T>(prev: T, next: T): T {
  return isDeepStrictEqual(prev, next) ? prev : next;
}
```

Applied as `setX((prev) => keepIfEqual(prev, next))` at every poll sink:

| Sink                                              | Gate                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `useQueueSnapshot` → `queueSnap`                  | `keepIfEqual`                                                                                          |
| `useHealth` → `health`                            | `keepIfEqual` after quantizing `uptimeSeconds` to whole minutes (`fmtUp` in Chrome renders minutes)     |
| `useAssessHistory` → `Map`                        | compare the fetched rows array to the previous rows (kept in a ref); rebuild the `Map` only on change   |
| App `localCheap` effect and `forceLocalRefresh`   | `keepIfEqual` after quantizing `daemon.uptimeSeconds` to whole minutes (`fmtDur` in sections renders minutes) |
| App `localHeavy` effect and `forceLocalRefresh`   | `keepIfEqual`                                                                                          |
| `useGithubData` `setIssues`/`setPrs`/stale maps   | per-key `keepIfEqual` on the sorted arrays and the stale records                                        |

`useTranscript` (already returns the previous state on `unchanged`) and
`useLogTail` (already sets state only when new lines arrive) are untouched.

**Known residual:** fields the daemon itself advances on its own poll loop
(`stats.lastPollAt` inside the queue snapshot, sourced from the health body)
legitimately change and will still paint — at most one frame per worker poll
interval (`worker.pollIntervalSeconds`, default 15 s), down from one per
dashboard poll tick. The GitHub refresh cycle likewise stores a fresh
`refreshedAt` timestamp (rendered as "↻ Ns ago"), so a refresh commits at most
one frame per `refreshPollMs` (default 30 s) even when the issue and PR lists
are unchanged. The harness's constant fixtures hold the daemon fields fixed,
so the acceptance test measures the dashboard's own churn only.

**`src/tui/hooks/useClock.ts`** — `useClock(intervalMs): Date`; initial value
`new Date()` at mount, then a `setInterval` tick; cleared on unmount.
`useQueueSnapshot` drops `queueNow` from its return; App calls
`const now = useClock(clockMs)` where `clockMs` is a new optional `AppProps`
field defaulting to `5_000`, and every `now={queueNow}` site (Header,
PrPreview, ReviewView, the outbox/daemon sections) becomes `now={now}`.
`makeAppProps` (tests/helpers/localFixtures.tsx) gains `clockMs: 999_999` as
its default so every existing App test runs with a frozen clock, exactly like
the existing poll knobs; tests that want ticks override it.

### Tier 2 — animation and bytes

- **Spinner → Ink 7.1 `useAnimation`.** `const { frame } = useAnimation({
  interval: 100 })` and `FRAMES[frame % FRAMES.length]`. All spinners then
  share one timer and coalesce with Ink's render throttle (one commit per
  tick regardless of how many are mounted). `SPINNER_FRAMES` stays exported;
  the existing until-loop tests keep passing unchanged.
- **`incrementalRendering: true`** added to `INK_RENDER_OPTIONS`
  (src/dashboardCmd.ts, the single render call for dashboard + hosted
  wizard). Ink then rewrites only changed lines: an animation frame drops
  from ~15 KiB to <1 KiB on the wire. CPU is unchanged (measured).
- **Suspend/resume under incremental mode is pinned by a test.** `useSuspend`
  blanks the UI (an empty frame) before handing the terminal to a child and
  relies on the next commit repainting in full. Ink's incremental log-update
  stores the empty frame as `previousOutput`, so the resume frame diffs
  against nothing and every line is written — but this is Ink-internal
  behavior, so `tests/useSuspendTty.test.tsx` gains a case that mounts with
  `incrementalRendering: true`, suspends around a fake child, and asserts the
  bytes written after `ALT_SCREEN_ENTER` contain every content line.

## Data flow (after)

```
poll fn → hook: next = await fn(); setX(prev => keepIfEqual(prev, next))
        → equal:   React bails out, no commit, no Ink frame, no bytes
        → changed: one commit → Ink frame → incremental line diff → bytes
useClock(5 s) → `now` → age strings → one frame per 5 s (write only if text changed)
useAnimation(100 ms) → shared tick → one coalesced frame while a spinner is mounted
```

Idle steady state: ~0.2 frames/s from the clock (+ the daemon-driven
residual above) instead of ~1.6 frames/s.

## Error handling

- `keepIfEqual` never throws on plain data; a value containing functions or
  class instances compares by reference and simply fails the equality — the
  fallback is today's behavior (a frame), never a missed update.
- The clock and animation timers are cleared on unmount; the harness unmounts
  in `afterEach` (same MouseProvider `process.on("exit")` hygiene as the App
  suites).
- Quantizing uptime for equality is display-only; the stored `health` /
  `localCheap` objects keep the raw seconds so nothing downstream changes.

## Testing

- Tier 0's `framePerf.test.tsx` is the acceptance test and stays in the suite
  as the regression guard (TDD: it fails first).
- Unit tests per hook: `keepIfEqual` identity semantics; `useClock` tick +
  cleanup; each gated hook returns the same reference on an equal poll and a
  new one on a changed poll.
- `dashboardCmd.test.ts` asserts `incrementalRendering: true`.
- `useSuspendTty.test.tsx` gains the incremental-mode full-repaint case.
- The full suite (~3,100 tests) stays green at every commit; the full gate
  (`lint && format:check && typecheck && build && test`) before the PR.
- The PR body reports the harness numbers before and after.

## Out of scope (with reasons)

- **Tier 3, focus-aware cadence** — deferred by the maintainer; terminal-
  dependent (Terminal.app sends no focus events) and hard to test.
- **Flattening Box-per-cell rows** — rejected: Yoga is 3.6% of a frame.
- **Poll-cost caching** — rejected: 1–3 ms per snapshot.
- **Replacing the custom `useSuspend` with Ink 7.1 `suspendTerminal()`** —
  worthwhile cleanup, but unrelated to rendering cost; separate ticket.
- **OpenTUI** — assessed the same day and judged not feasible on Node ≤ 24;
  see the maintainer's memory note.
