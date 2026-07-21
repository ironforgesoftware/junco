# Dashboard TUI Nits — Freshness Stamp, Mouse Support, Visible Links — Design

**Date:** 2026-07-08
**Status:** Awaiting user review
**Release hold:** Do NOT push / tag / release / `npm publish` without explicit maintainer
approval. Work locally; show diffs + green tests first.

## Goal

Three operator-experience nits in `junco dashboard`, designed together because they share
geometry and plumbing:

1. **Freshness stamp** — an always-visible "↻ 12s" data-age indicator on the issues and
   PRs pane titles. Manual `r` refresh stays.
2. **Mouse support** — click to focus panes and select rows, click-again to enter/open,
   wheel to scroll, with no new dependency.
3. **Visible browser links** — every resource (repository, issue, PR) gets both a
   consistent `o` keybinding and a visible, clickable link line; three open paths so it
   works in every terminal.

## Background / triage

- The dashboard already auto-polls: issues 30s, PRs 60s, queue 2s, health 5s. Manual `r`
  exists in main + PRs views. Verdict (maintainer-confirmed): keep `r`, add visibility.
- The reported "PRs lost browser routing" is **not a regression** — `o`/Enter →
  `openPrInBrowser` is intact (`App.tsx`, prs view handler). What's missing is a _visible_
  URL affordance; the maintainer confirmed that reading.
- Ink 7.1.0 has no built-in mouse support. Approach chosen (of hand-rolled / community
  package / yoga-introspection registry): **hand-rolled SGR protocol + pure hit-test
  module** — no new dependency, fully unit-testable, and junco's layout is already
  deterministic (`layout.ts` constants, `windowSlice`).

## Locked decisions

1. Keep `r`; add the freshness stamp (no poll-interval changes).
2. Mouse scope: clicks + wheel, always on (no config opt-out).
3. Mouse architecture: hand-rolled SGR codec + central pure `hitTest` (approach A).
4. Link line on both preview cards; OSC 8 hyperlinks via Ink `<Transform>`; new `o` on the
   rail opens the repository page. No URL text in the rail itself (26 cols).
5. No `Config` changes at all (avoids the fixture-update tax; nothing here is policy).

## Section 1 — Freshness stamp

**UI:** pane titles gain a dim age stamp ticking at seconds granularity:
`2 issues · 14 · ↻ 12s` and `prs · 8 · ↻ 45s`.

**Mechanics:**

- `App` records last-fetch times: per-repo for issues (set when `listIssues` resolves),
  one aggregate for PRs (set when `loadPrs` completes).
- When a list is cache-served offline (`staleAt !== null`), the stamp shows the **cache's
  age** (from `staleAt`) — the stamp always answers "how old is this data". The existing
  amber `offline · HH:MM` marker stays unchanged beside it.
- Rendering ticks off the existing 2s `queueNow` clock already passed into both list
  components — **no new timer**; seconds jump in 2s steps, acceptable.
- New pure `relTimeShort(iso, now)` formatter: seconds tier below the existing minute tier
  (`12s` → `3m` → `2h` → `3d`). Lives beside `relTime` (single definition, reused by both
  panes).
- `r` behavior unchanged in both views; the stamp visibly resetting to `↻ 0s` doubles as
  its feedback. Queue and health panes get no stamp (2s/5s polls are effectively live).

## Section 2 — Mouse layer

Three new units; only the hook touches I/O.

### `src/tui/mouse.ts` — SGR codec (pure)

- `MOUSE_ENABLE` / `MOUSE_DISABLE` constants: `\x1b[?1000;1006h` / `l` (click + wheel
  reporting, SGR encoding; no drag tracking).
- `parseMouse(data: string): MouseEvent[]` parsing `\x1b[<b;x;yM|m` → events
  `{ kind: "press" | "release" | "wheelUp" | "wheelDown", x, y }` with 0-based coords.
  Wheel is buttons 64/65; only left-button (`b % 4 === 0`) presses are surfaced as
  `press`. Malformed/partial sequences are ignored (no throw).

### `src/tui/hitTest.ts` — geometry resolver (pure)

- `hitTest(input, x, y)` where `input` carries: `layout`, terminal `size`, current `view`,
  (already-filtered) list lengths, and window starts. Returns a discriminated target:
  `{ type: "pane", pane }` · `{ type: "repoRow", index }` · `{ type: "issueRow", index }`
  · `{ type: "prRow", index }` · `{ type: "linkLine" }` · `{ type: "none" }`.
- **Geometry single-source-of-truth:** the per-pane row budgets currently inlined in
  `Rail` (`height − 2 − 1 − 1 − QUEUE_CARD_ROWS`), `IssueList`/`PrList` (`height − 4`),
  and the preview cards' reserved rows move to exported helpers in a small
  `src/tui/geometry.ts`, consumed by BOTH the components and `hitTest` so they cannot
  drift. The chrome row map is fixed: row 0 header, rows 1..N body, then toast, footer.

### `useMouse` hook (`src/tui/useMouse.ts`)

- Wires ink's `useStdin`: writes `MOUSE_ENABLE` on mount, parses incoming stdin data,
  invokes a handler per event, writes `MOUSE_DISABLE` on unmount.
- Best-effort `process.on("exit")` restore so a crash never leaves the terminal in mouse
  mode (ink already restores the alt screen; this is the mouse-mode analogue).

### Supporting refactor — window starts lift into `App`

`windowSlice`'s sticky `prevStart` currently lives in a `useRef` inside each of
`Rail`/`IssueList`/`PrList`. It lifts into `App` (three refs), and `{ start, end }` is
passed down as a prop. Rendering and click-row resolution then share one window offset.
Components become presentational; no behavior change.

### Semantics

- **Main view:** click a pane → focus it; click a rail/issue row → focus + select; click
  the **already-selected** issue row → Enter (wide: pane 3; medium: detail); click a
  preview link line → open browser.
- **PRs view:** click a row → select; click the selected row → open the PR; click the
  PrPreview link line → open the selected PR.
- **Detail / queue / cmdOutput views and all modals:** no click targets in v1 (keyboard
  owns them). Wheel still scrolls their content.
- **Wheel scrolls what's under the cursor:** over rail/issues/prs → move selection ±1 per
  event; over pane 3 / detail / queue / cmdOutput → scroll content ±1 line.
- A click that lands on no target (borders, empty space, header/footer) is a no-op. Every
  click still dismisses an active toast (same as keystrokes).

### Known hazard — escape-sequence leak into `useInput`

With mouse reporting on, ink's `useInput` may deliver the raw sequences as keystrokes —
which would type garbage into the `/` filter. The `App` `useInput` handler gets an early
guard that drops mouse-shaped input (`\x1b[<` prefix / SGR tail match), with a regression
test: enable filtering, write a click sequence to stdin, assert the filter text is
unchanged.

### Trade-off (accepted)

Terminal-native drag-select requires shift+drag while mouse reporting is on — the standard
trade every mouse-enabled TUI makes (htop, lazygit). No opt-out in v1 per maintainer.

## Section 3 — Visible browser links

| Resource                  | Key                | Visible link                                |
| ------------------------- | ------------------ | ------------------------------------------- |
| Repository (rail, pane 1) | `o` — **new**      | none (26-col rail; key + click cover it)    |
| Issue (panes 2/3)         | `o` — exists       | **new** link line on the issue preview card |
| PR (PRs view)             | `o`/Enter — exists | **new** link line on the PR preview card    |

**Link line:** a dim, fixed-position row on both preview cards directly under the card
heading: `↗ owner/repo#123`. Its pane-relative row index is an exported geometry constant
(trivially hit-testable, cannot drift from rendering). Three open paths:

1. **Our mouse layer** — click calls the existing `openInBrowser` / `openPrInBrowser`
   (`gh … --web`). Terminal-independent.
2. **OSC 8 hyperlink** — text wrapped post-layout via Ink `<Transform>` with a pure
   `hyperlink(text, url)` helper (`\x1b]8;;URL\x1b\\text\x1b]8;;\x1b\\`), so width math is
   untouched. Cmd+click works natively in iTerm2 / Ghostty / WezTerm / kitty.
3. **`o` keybinding** — now consistent across all three panes.

**Client addition:** `openRepoInBrowser(nwo)` on `DashboardClient` →
`gh repo view <nwo> --web`, same `Result`/toast error contract as the existing two
open methods. URLs come from data already carried (`DashIssue.url`, `DashPr.url`; repo URL
derived from the nwo).

**Chrome:** footer hints gain `o open` on pane 1; the help modal documents the new `o`,
the mouse gestures, and the link line.

## Error handling

- Parser never throws; unknown/partial sequences are dropped.
- Clicks resolve through the same guarded action paths as keys (missing selection → no-op;
  gh failures → error toast, exactly as today).
- Mouse mode is disabled on unmount AND process exit; non-TTY invocations never reach the
  Ink app (existing guard in `dashboardCmd.ts`).

## Testing

- **Pure units:** `parseMouse` (valid/malformed/split sequences, wheel, button masks),
  `hitTest` (every region × wide/medium layouts, window offsets, boundary rows),
  geometry helpers, `relTimeShort`, `hyperlink`.
- **Component/integration (ink-testing-library):** write real SGR byte sequences to fake
  stdin and assert frames — click-to-focus, click-to-select, click-selected-to-enter,
  wheel scroll, link-line click calling the client fake; freshness stamp rendering with an
  injected `now`; the escape-leak filter regression test.
- **CLAUDE.md flake rule:** all async assertions use bounded until-loops, never one fixed
  timeout tick.
- **No `Config` fixture updates needed** (no config changes).
- Full gate before done: `npm run lint && npm run format:check && npm run build && npm test`.

## Out of scope (v1)

- Clickable rows in modals (palette, add-repo, help).
- Drag selection, double-click timing (click-selected-again replaces it), right/middle
  button semantics.
- Any config surface for mouse behavior.
- Poll-interval changes.
