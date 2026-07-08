# Dashboard Workspace — UX Facelift Design

**Date:** 2026-07-07
**Status:** proposed (direction: full workspace; presented while maintainer AFK — review before execution)
**Research basis:** three-track survey — workflow TUIs (lazygit, k9s, gh-dash, tig, lazydocker), visual design language (Charm/lipgloss, Textual, Catppuccin/Dracula/Rosé Pine), and Ink 7.1.0 capabilities (verified against the installed package's readme/.d.ts).

## Goal

Turn `junco dashboard` from an inline-rendered pane stack into a fullscreen,
responsive, themed workspace: alternate-screen rendering, a three-pane
master-detail layout on wide terminals, full-row selection, one accent color,
numbered pane navigation, `/` filtering, and context-first help — with **zero
new dependencies** (all native Ink 7.1.0) and all existing action keybindings
preserved.

## Research findings this design applies

1. **Master-detail is never a modal swap** (lazygit, gh-dash): the list stays
   visible next to its detail. Today junco's detail view replaces the list.
2. **Numbered panel jump beats cycling** (lazygit/lazydocker `1`–`5`).
3. **`/` = filter, `:` = command** — distinct, vim-derived, universal.
4. **Context-scoped help** (`?` shows what applies now — k9s/lazygit/gh-dash).
5. **Selection = full-row background block + pointer glyph** (reads under
   `NO_COLOR`); **focus = accent border + bold title, blurred = gray**.
6. **One accent, semantic tokens for the rest**; three-tier text hierarchy;
   structure tones separate from accent tones (Textual/Rosé Pine lesson).
7. **Fullscreen TUIs own the alt buffer** (no scrollback pollution); Ink 7 has
   this native: `render(el, {alternateScreen: true})`, `useWindowSize()`.
8. **`Text backgroundColor` covers only the character run; `Box
   backgroundColor` fills the row** — selection bars must wrap rows in a Box.
9. Windowing is the app's job: any frame taller than the terminal duplicates
   into scrollback on redraw. Every list must window to measured height.
10. Toasts auto-clear; loading is scoped to the region loading; empty states
    say why + next action; errors render inline in the error color.

## 1. Theme — "slate & rose" (`src/tui/theme.ts`)

Named for the bird: slate-gray body, pink bill.

```ts
export const theme = {
  accent: "#eb6f92",        // rose — focused border/title, selection bar glyph, brand chip, active hotkeys. Nowhere else.
  selectionBg: "#2a2e3a",   // subtle slate surface behind the selected row
  border: "gray",           // blurred pane borders
  success: "green",
  warn: "yellow",
  error: "red",
  info: "cyan",
} as const;
```

Muted and faint text are `dimColor` tiers, not color tokens (tier 2 =
`dimColor`, tier 3 = `dimColor` + `color="gray"`, used sparingly).

- Text hierarchy is exactly three tiers: default, `dimColor` (muted), and
  `dimColor` on `gray` (faint, rare). No ad-hoc fourth gray.
- Lifecycle state colors are unchanged (`state.ts stateMeta`) — they are
  semantic and already correct: plan-ready yellow, approved blue, working/
  planning/queued cyan, done green, failed red, denied magenta.
- Hex values pass through chalk, which downsamples to 256/16-color terminals
  and honors `NO_COLOR` (colors drop; the `▌` selection glyph and bold/dim
  hierarchy keep the UI legible colorless).
- Non-goal: light-terminal adaptive palette (Ink cannot query terminal
  background; tokens are chosen to survive light backgrounds acceptably).

## 2. Layout — fullscreen, responsive (`src/tui/layout.ts`)

`dashboardCmd` renders with `{alternateScreen: true, exitOnCtrlC: true}`.
Root component `Workspace` fills `useWindowSize()` exactly:

```
row 1        header (no border): ` junco ` accent chip · active repo ·
             right: daemon chip, queue chip (◐1 ⏳2), clock HH:MM
rows 2..n-2  body (flexGrow): pane row or modal, per mode below
row n-1      toast line (only while a toast is live; else collapsed)
row n        footer: context-scoped key hints (accent key · muted label)
```

`computeLayout(columns, rows)` is a pure function returning one of:

- **`wide`** (columns ≥ 110 and rows ≥ 14): `rail` (fixed 26 cols) +
  `list` (flexGrow) + `preview` (40% of columns, capped 60).
- **`medium`** (60 ≤ columns < 110, rows ≥ 14): `rail` + `list`;
  `enter` opens Preview full-body (windowed; `esc`/`enter` back).
- **`tooSmall`** (columns < 60 or rows < 14): centered message
  "terminal too small — junco needs at least 60×14" (never a broken frame).

It also returns `bodyRows` (rows − chrome) so every list windows itself; the
rendered frame height must NEVER exceed `rows` (Ink redraw constraint; also
sidesteps Ink issue #752's full-height edge). All views window through a pure
helper `src/tui/window.ts`:

```ts
/** Slice `total` rows to a `height` window that follows `cursor`. */
export function windowSlice(total: number, height: number, cursor: number, prev: number): { start: number; end: number }
```

(follow-the-cursor: keep cursor visible, move the window minimally; `prev` is
the previous start for stability). Lists show a `cursor+1/total` position
indicator in their pane footer line when `total > height`.

## 3. Navigation model

**Panes are numbered and titled** `1 repos`, `2 issues`, `3 preview`.

| Key | Action |
|---|---|
| `1` `2` `3` | jump focus to pane (3 = wide mode only) |
| `tab` / `h` / `l` | cycle / left / right (unchanged) |
| `j`/`k`, arrows | move selection in focused list; scroll preview when pane 3 focused |
| `[` / `]` | scroll up/down in preview/queue/output views (preserved everywhere) |
| `g` / `G` | first / last item in focused list |
| `/` | filter the issue list (live substring on `#num`, title, state badge); `esc` clears; filter chip shows in pane 2's title |
| `enter` | wide: focus preview; medium: open preview full-body |
| `d D a R o w x r : t q` | **unchanged** (dispatch, ask, approve, replan/recycle, browser, watch, unwatch, refresh, palette, queue view, quit) |
| `?` | categorized help modal, context section first |

Focused pane: accent border + bold title. Blurred: gray border, normal title.
Selection row: `▌` accent glyph + `selectionBg` full-row Box; state glyph and
badge keep their semantic colors on top of it.

**Preview auto-loads** for the selected issue in wide mode: selection settles
for 300 ms → fetch body+plan via the existing `client.issueDetail` → cache by
`nwo#number` (invalidated by `r` refresh). No enter needed to *see* detail;
enter is only for scrolling focus. Medium mode keeps today's enter-to-open
flow (rendered windowed instead of fixed-24-lines).

**Modals** (help, palette, add-repo): centered in the body area (flex
justify/align center), double-border, header/footer stay visible. Ink has no
z-axis; the modal replaces the body rather than floating over it — accepted.

**Views in the list slot**: `t` (queue) and palette output render in pane 2's
slot re-skinned, keeping rail context visible (today they replace the whole
main area).

## 4. Component architecture

New pure modules (unit-testable without Ink):
- `src/tui/theme.ts` — tokens above.
- `src/tui/layout.ts` — `computeLayout`, breakpoint constants.
- `src/tui/window.ts` — `windowSlice`.
- `src/tui/useTerminalSize.ts` — wraps Ink's `useWindowSize` with an optional
  `override` prop for tests (ink-testing-library has no resizable stdout).

New/reworked components (`src/tui/components/`):
- `Chrome.tsx` — `Header` (brand chip, context, daemon/queue chips, clock) and
  `Footer` (key hints, graceful truncate) and `Toast` (severity color,
  auto-expire ~4 s via App-held timer).
- `Rail.tsx` — pane 1: watched repos (badges as today) + compact queue card
  (running ticket + counts; replaces the full-width strip). Absorbs `RepoList`
  and `QueueStrip`'s content.
- `IssueList.tsx` — pane 2: windowed rows, full-row selection, aligned
  columns (glyph · #num · title[truncate] · badge · reltime right-aligned),
  filter chip in title, position indicator. Replaces `IssueTable`.
- `Preview.tsx` — pane 3 / full-body: issue title + state, body, plan
  comment, windowed with scroll; loading/empty/error states. Replaces
  `IssueDetail`.
- `Modal.tsx` — centered frame wrapper; `HelpModal.tsx` (categorized:
  current-context section first, then navigate / act on issue / panes & views
  / system); `CommandPalette` and `AddRepoForm` re-render inside `Modal`
  (logic unchanged).
- `QueueView` re-skinned (theme tokens, windowed via `windowSlice`) rendering
  in pane 2's slot.
- Deleted after migration: `StatusBar.tsx`, `ShortcutBar.tsx`, `RepoList.tsx`,
  `IssueTable.tsx`, `IssueDetail.tsx`, `QueueStrip.tsx` (content absorbed).

`App.tsx` remains the single stateful orchestrator — state, input router,
polls, optimistic actions, palette runner all survive with these additions:
focus is `pane: 1|2|3`, preview autoload effect (debounce + cache), filter
state, toast timer, layout mode from `useTerminalSize` + `computeLayout`.
Render delegates to `components/Workspace.tsx` (pure over props) so App stays
readable.

`dashboardCmd.ts`: adds `alternateScreen: true`; TTY and github-enabled
guards unchanged (alt-screen is a no-op when non-interactive, but the guard
already exits earlier).

Data flow is unchanged: same `DashboardClient`, same polls (issues 30 s,
health 5 s, queue 2 s), same optimistic label mutations. `IssueList` takes
`now` as a prop (from the queue poll tick) instead of calling `Date.now()` in
render, matching the queue components' purity.

## 5. States & feedback

- **Toasts**: severity (`info`/`success`/`error`) → color; auto-expire after
  4 s (App timer); still dismissed early by any keypress. Errors from actions
  render as error toasts; the watchlist-corrupt warning becomes a persistent
  header chip (not a toast).
- **Loading**: scoped spinner in the loading pane's title (issues refresh,
  preview fetch, add-repo busy) — never a full-screen blocker.
- **Empty states** (why + next action): no repos → "none watched — w adds a
  repo, or add [[github.repos]] to config.toml"; no issues → today's text; no
  selection (preview) → "select an issue — its body and plan render here";
  filter with no matches → "no issues match /query — esc clears".
- **Errors**: inline in the owning pane in `theme.error`; daemon down keeps
  the header chip yellow (`daemon ○`).

## 6. Testing

- Pure: `theme` (token shape), `layout` (breakpoint table), `window`
  (follow-cursor properties: cursor always inside, minimal movement, clamps).
- Components: ink-testing-library frame tests at fixed injected sizes
  (via `useTerminalSize` override): header/footer/toast, rail, issue list
  (selection bar, windowing, filter chip, position), preview (all states),
  modals, too-small mode.
- Interaction (App-level): pane jumps 1/2/3 + focus styling, `/` filter
  narrowing + esc clear, g/G, preview autoload (fake client, debounce
  flushed via bounded until-loops), enter flows per mode, toast expiry.
- **Migration**: existing TUI test files (`tuiApp`, `tuiInteractive`,
  `tuiPalette`, `tuiComponents`, `tuiQueue`) assert current frame strings;
  they are updated in the same commit as the App switch. All waits stay
  bounded until-loops (CLAUDE.md Ink gotcha).
- Suite must be green at every commit (component tasks land unwired, then one
  switch task rewires App + migrates tests atomically).

## 7. Risks & mitigations

- **Ink #752** (blank row at exactly full height) and **#907** (resize
  artifacts when wrapping changes row count): keep every frame ≤ rows,
  `wrap="truncate"` on all single-line rows, manual smoke checklist in the
  final task (resize storm, tiny terminal, 200-issue repo, daemon down).
- **Big-bang switch risk**: isolated to one task (T9-equivalent) with the
  most detailed brief; everything before it lands unwired and green.
- **Alt-screen debugging**: `patchConsole` stays default-on so stray logs
  can't corrupt frames; transcript-based debugging is unaffected.

## Out of scope (YAGNI)

- Mouse support, nerd-font icons, light/dark adaptive palettes, theme
  configurability, markdown rendering in preview, fuzzy (vs substring)
  filter, saved filter queries, alt-screen for non-dashboard commands.
