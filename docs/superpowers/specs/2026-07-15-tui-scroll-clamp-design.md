# TUI scroll: bottom clamp + one scroll mechanic

Date: 2026-07-15
Branch: `fix/tui-scroll-clamp` (off `origin/main` @ 5a24f35)

## Problem

Offset-driven TUI views scroll past the bottom of their content into a blank pane.

Junco's TUI has two families of scrollable views:

- **Cursor-driven lists** (Rail, PrList, IssueList, ReviewView rows) go through `windowSlice`
  (`src/tui/window.ts:4`), which clamps at both ends. These are correct and out of scope.
- **Offset-driven views** hold a raw `scroll` integer in `App.tsx` and clamp **only at the top**:
  `setScroll((s) => s + 1)` (`App.tsx:1565`), `Math.max(0, s + d)` (`App.tsx:2485`).

Every offset-driven view renders `lines.slice(scroll, scroll + visible)`. Once the offset passes
the content length the slice returns empty and **the pane renders blank** while scrolling
continues. The footer counter reads nonsense (`97-84/84`, `CommandOutput.tsx:53`). Because each
keypress past the end still increments state, returning costs the same number of presses in
reverse — dead input.

Four surfaces are unbounded: `QueueView`, `CommandOutput`, `Preview`, `DaemonSection`. A fifth,
the ReviewView comment draft, is the only one that clamps (`App.tsx:1660`) but uses
`max = lines - 1`, which still parks the last line at the top of an otherwise blank pane.

The clamp was never written because of a structural gap: **`App.tsx` owns the offset, but content
length and viewport height live inside each component**, and the reserved-row arithmetic differs
per component (`height - 5` in CommandOutput, `height - 3` in QueueView/DaemonSection). App has no
`max` to clamp against.

## Why three scroll states exist

They are not three mechanisms. They are one mechanism implemented three times, because each has a
different reset trigger and the reset is manual.

| State                         | Feeds                                          | Resets on             | Manual reset sites |
| ----------------------------- | ---------------------------------------------- | --------------------- | ------------------ |
| `scroll` (`App.tsx:262`)      | QueueView (github `t`), CommandOutput, Preview | view / content change | 14                 |
| `localScroll` (`App.tsx:301`) | QueueView (local), DaemonSection               | section change        | 4                  |
| `reviewState.open.scroll`     | ReviewView draft                               | modal open/close      | 0                  |

Two observations settle the design:

1. **`QueueView` is driven by two different App states depending on mode.** GitHub mode passes
   `scroll`; LOCAL mode passes `localScroll` via `LocalDashboard.tsx:581`. Same component, same
   scrolling, two states — the mechanism got wired from two directions.
2. **All 18 manual `setScroll(0)`/`setLocalScroll(0)` calls are paired with a content-identity
   change** — `setView`, `setDetail` (`App.tsx:842`), `setCmd` (`App.tsx:1041`), or a section
   switch (`App.tsx:369`). There is no reset that isn't "the content underneath changed."

The draft preview has zero manual resets precisely because its offset is nested inside the state
it belongs to, so it dies with the modal. That is the model to generalize: **reset should be a
lifecycle, not a thing you remember 18 times.**

## Decisions

- Bottom stop is `max = total - visibleRows`. The last line rests at the bottom of the viewport;
  blank rows are unreachable. ReviewView's draft converges onto this rule (behavior change).
- One `useScroll(key)` hook, **single instance**, keyed by content identity. Offset surfaces are
  mutually exclusive today — the render tree is `config | local | review | (rail + one of
queue/cmdOutput/preview)` (`App.tsx:2433`). Nothing in the hook assumes singleton; a future
  split pane instantiates it twice.

## Design

### 1. Pure primitives (`src/tui/window.ts`)

Beside `windowSlice`, unit-tested the same way:

```ts
export function maxScroll(total: number, height: number): number {
  if (height <= 0 || total <= 0) return 0;
  return Math.max(0, total - height);
}
export function clampScroll(offset: number, total: number, height: number): number {
  return Math.min(Math.max(offset, 0), maxScroll(total, height));
}
```

Content that fits gives `max = 0` — the view does not scroll at all.

### 2. The hook (`src/tui/useScroll.ts`)

```ts
export function useScroll(key: string): {
  scroll: number;
  scrollBy: (d: number) => void;
  onScrollMax: (max: number) => void;
};
```

- Owns the offset; holds `max` in a ref.
- **`key` change resets the offset to 0**, derived during render (`if (key !== lastKey.current)`),
  not in an effect — no one-frame flash of a stale offset.
- `onScrollMax` is called by the component _during render_ and writes the ref. No `setState`
  during render. This mirrors the established idiom: `LocalDashboard` already keeps windowing
  memory (`prevStart`) in a per-section ref written during render
  (`LocalDashboard.tsx:522-525` comment, ref used at `:572`).
- `scrollBy` clamps **both directions** against the ref: `Math.max(0, Math.min(next, max))`.

Clamping the up direction too is what makes a mid-scroll content shrink self-heal. If the queue
drains from 100 rows to 10 while parked at 50, the display is already correct (render clamp), and
the next keypress renormalizes the state instead of stepping down from a stale 50.

### 3. Two layers

- **Render clamp (authoritative).** Each component runs `clampScroll` at slice time against the
  rows it just built. Whatever App holds, the pane is never blank. This is the layer that fixes
  what you see, and it covers the one-frame staleness of the reported max.
- **Setter clamp (kills accumulation).** The hook clamps every mutation against the reported max,
  so the offset never climbs past the end and input is never dead.

### 4. Key derivation

| Surface                | Key                     |
| ---------------------- | ----------------------- |
| LOCAL body             | `local:${localSection}` |
| ReviewView draft       | `draft:${draftIdx}`     |
| CommandOutput          | `cmd:${cmdToken}`       |
| Preview (issue detail) | `detail:${nwo}#${num}`  |
| Other views            | the view name           |

`Preview` mounts only under `view === "detail"` (`App.tsx:2507`) — main view renders the
cursor-driven `IssueList`. So the issue identity is the whole key; the rail cursor never feeds it.

All 18 manual reset sites and both extra states delete.

### 5. Wiring

| Surface          | Component                | Visible rows         |
| ---------------- | ------------------------ | -------------------- |
| QueueView        | `QueueView.tsx:218`      | `max(1, height - 3)` |
| CommandOutput    | `CommandOutput.tsx:25`   | `max(1, height - 5)` |
| Preview          | `Preview.tsx:50`         | `viewHeight`         |
| DaemonSection    | `LocalDashboard.tsx:519` | `max(1, height - 3)` |
| ReviewView draft | `ReviewView.tsx:110`     | `bodyRows`           |

In QueueView the clamp applies to the base `start = scroll` **before** the existing selected-row
nudge (`QueueView.tsx:219-224`), leaving cursor-following behavior untouched.

`App.tsx:1660`'s duplicated `d.draft.split("\n").length - 1` is deleted in favor of the reported
max.

## Behavior changes

1. **Scrolling stops at the bottom on all five surfaces.** The fix.
2. **ReviewView draft stops one screen earlier** than today (`total - bodyRows` rather than
   `total - 1`), for one consistent rule.

No other user-visible behavior changes: every one of the 18 manual resets is replaced by a key
that fires on exactly the same transition.

## Testing

TDD, failing test first, one commit per task.

- `tests/tuiFoundation.test.ts` — `maxScroll`/`clampScroll` units beside the `windowSlice` block:
  content-fits → 0, exact fit, overshoot, negative, degenerate `height <= 0` / `total <= 0`.
- New `tests/tuiUseScroll.test.tsx` — key change resets to 0; `scrollBy` clamps both directions;
  shrink self-heals on next press.
- Per-component: render each of the five with `scroll={999}` and assert the last content line is
  visible and the pane is not blank.
- App-level (`tests/tuiInteractive.test.tsx`): press `]` well past the bottom, then `[` once, and
  assert the view moves immediately — the no-dead-input regression.

Per CLAUDE.md, Ink tests loop-until-condition with a bounded retry rather than asserting on a
fixed `setTimeout` tick; that pattern has flaked a release gate before.

## Out of scope

- `windowSlice` and the cursor-driven lists — already correct.
- `PrPreview` — not a scroll surface. It truncates (`rows.slice(0, maxRows)`,
  `PrPreview.tsx:164`) and takes no offset. Making it scrollable is a feature, not this fix.
- Any row-model refactor of QueueView / DaemonSection. Both carry explicit "byte-identical to the
  GitHub `t` view" guarantees with tests behind them; the two-layer design deliberately avoids
  touching how their rows are built.
- A lint/test guard that fails when a future offset view is wired without a clamp (considered,
  declined as YAGNI).
