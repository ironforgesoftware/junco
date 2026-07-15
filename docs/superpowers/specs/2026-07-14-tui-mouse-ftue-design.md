# TUI full mouse control + dashboard FTUE (init removal) — design

**Date:** 2026-07-14
**Status:** approved (maintainer walkthrough 2026-07-14)
**Workstream:** 1 of 2 for this session (workstream 2 — dedicated gh account for junco — is a separate spec)

## Goal

Make the entire junco TUI mouse-driven — every interactive element clickable, every
scrollable region wheel-scrollable, hover feedback everywhere — and make the dashboard
junco's only interactive flow: first open with no config runs the setup walkthrough as a
first-time-user experience (FTUE), and the standalone `junco init` subcommand is removed.

## Current state (verified 2026-07-14, v0.7.0)

- `src/tui/mouse.ts` speaks SGR `1000;1006` (click + wheel, no motion). `hitTest.ts` is a
  pure resolver that mirrors the dashboard grid via shared `geometry.ts` constants; it
  covers only GitHub-mode main/prs/detail/prDetail (rows, header tabs, ↗ link lines).
  `App.tsx:2000-2010` explicitly carves out config/help/palette/addRepo/review, the LOCAL
  body, and (implicitly) the whole wizard as keyboard-only "v1".
- `Workspace.tsx` renders a modal **instead of** the body (`modal !== null ? <Center> :
children`) — an open modal unmounts the underlying view. No z-stacking exists anywhere.
- The wizard (`WizardApp`) is a separate full-screen Ink app launched by `junco init`;
  chapters are freeform variable-height layouts (wrapping tips, staggered reveals).
- `junco init` handles: interactive wizard (fresh + rerun modes), `--yes` headless
  scaffold, existing-config ensure-dirs, and a non-TTY error path (`cli.ts:739`). Bare
  `junco` with no config routes to `init` (`cli.ts:265`). `scripts/package-smoke.sh` and
  the CLAUDE.md sandbox recipe call `junco init --yes`.

## Decisions (maintainer-confirmed)

1. Two workstreams, mouse first, separate specs/branches/PRs.
2. Mouse scope: the whole TUI — dashboard views **and** wizard.
3. **Full hover feedback** (not click-only) → requires any-motion tracking.
4. The dashboard is the **only** flow: `junco init` is rolled into the dashboard as its
   FTUE. `junco init` is **removed entirely** (breaking, → v0.8.0).
5. Hit-testing architecture: **registry everywhere** (option B) — the mirrored-resolver
   `hitTest.ts` retires; main/prs/detail migrate to the registry in this workstream.

## Section 1 — Event pipeline

- **Protocol:** enable becomes `ESC[?1000;1003;1006h` (any-motion tracking + SGR
  encoding); disable symmetric. `parseMouse` gains kind `"move"` (motion flag `b&32`,
  no button `b&3 === 3`). Right/middle clicks and held-button drag-motion stay dropped.
- **Leaked CSI:** with reporting on, Ink hands every mouse sequence to `useInput`
  handlers as a `[<b;x;yM…` keypress. The existing `isMouseInput` guard already matches
  motion; the copy-pasted early-returns are replaced by a shared `useGuardedInput`
  wrapper hook (same signature as `useInput`, drops mouse leaks). Every TUI `useInput`
  goes through it.
- **`MouseProvider`:** one provider at the app root (above both wizard and dashboard —
  see Section 4's `Root`). Owns stdin subscribe/unsubscribe and enable/disable writes,
  parses chunks, **coalesces motion** (last position per chunk wins), resolves the
  pointer against the region registry, and maintains `hoveredId` in a small external
  store. Components subscribe to _their own_ hover bit via `useSyncExternalStore`: a
  move that doesn't change the hovered target re-renders nothing; one that does
  re-renders exactly the two affected components. This is the churn control that makes
  SGR 1003 safe under Ink.

## Section 2 — Hit-region registry

- **`<ClickableBox>`** is the unit of interactivity: a drop-in `Box` replacement
  (spreads all Box props — no layout drift) plus `onPress`, `onWheel`, and hover
  styling (`hoverBg` shortcut, or a render-prop `hovered` flag for custom styling).
  Mount registers `{id, ref, handlers}`; unmount unregisters.
- **Lazy resolution at event time:** the dispatcher computes each registered ref's
  absolute rect by summing `yogaNode.getComputedLeft()/getComputedTop()` up the parent
  chain — the same math Ink's own `render-node-to-output.js` uses — then picks the
  **deepest** region containing the pointer. Rects are therefore always in sync with the
  last committed layout: windowed lists, wizard reveals, and resizes need no special
  code because re-rendered rows re-register.
- **Wheel:** resolves to the deepest containing region with `onWheel`, bubbling to
  ancestors, else a per-view default (scroll). **Miss:** a provider-level `onMiss` lets
  modal views map clicks on empty space to esc/cancel.
- **No layering:** modals replace the body (verified above), so only visible components
  hold registrations; no z-order arbitration exists or is needed.
- **Retired:** `hitTest.ts`, the hit bands in `geometry.ts`, `useMouse.ts`, and their
  tests. The main/prs/detail semantics move into `onPress` handlers on the row
  components themselves.
- **Acknowledged internals dependency:** `node.yogaNode` is semi-internal Ink API (what
  `measureElement` uses; ink exact-pinned at 7.1.0). All rect-walking lives in one small
  guarded module (`src/tui/mouseRegions.ts`) with its own tests, so an Ink upgrade that
  breaks it fails loudly in one place.

## Section 3 — Interaction semantics per surface

Principles: **click selects, click-again activates** (existing dashboard idiom); wheel
moves the cursor / scrolls; hover highlights via a new `theme.hoverBg` distinct from
selection; free-text entry stays keyboard-only (no click-to-position-cursor).

- **Migrated unchanged (+ hover):** rail repo rows, issue rows, PR rows, pane-3 rows,
  header mode tabs, ↗ link lines, queue/detail wheel-scroll.
- **ConfigView:** click section → switch section; click lever row → focus; click focused
  lever → activate (toggle boolean / cycle enum / open inline edit — enter semantics);
  wheel moves the lever cursor like ↑/↓; any click while an inline edit is open cancels
  the edit first, then handles the click.
- **Command palette:** click selects, click-again runs.
- **Queue view:** click actionable row selects, click-again = enter; wheel scrolls.
- **Review view:** click batch/draft rows move the cursor, click-again opens; click a
  finding row toggles its checkbox (space semantics).
- **Help modal:** click anywhere closes (matches any-key-closes).
- **Add-repo form:** click a field to focus it; click outside the modal cancels
  (`onMiss` → esc).
- **LOCAL dashboard:** click rail sections; click rows to move the cursor, click-again
  = enter; wheel moves the cursor.
- **Wizard:** `Select` option click = choose + advance (enter semantics);
  `MultiSelect` click toggles the entry; Next/Back clickable; text fields focus on
  click; Finale finishes on click. The chapter rail stays non-clickable — navigation
  remains linear.
- **Footer hint chips (all views incl. wizard):** every keyboard hint in the footer
  becomes a clickable chip firing its key's action — the discoverability row doubles as
  a button bar.
- **Exception:** confirm (`y/n`) modals stay keyboard-gated — destructive confirmation
  deliberately requires a keypress.

## Section 4 — FTUE handoff + init removal

- **`Root` switcher:** `junco dashboard` renders `<Root configPath>`, a three-state
  machine: no config → `WizardApp` (fresh mode); wizard completes → load the
  just-written config → `App`; `App` may request a re-run via a new command-palette
  entry ("setup walkthrough") → `WizardApp` (rerun/tune-up mode) → config-reloaded
  `App`. One Ink render root, one alternate screen, one `MouseProvider` at the top.
  Wizard internals (`src/wizard/*`, `src/tui/wizard/*` chapters) are unchanged — only
  their host changes; `runInitWizard` glue is absorbed into `dashboardCmd`.
- **CLI surface (breaking, → v0.8.0):**
  - `junco init` removed (unknown subcommand). `USAGE` rewritten dashboard-first.
  - Bare `junco`, no config, TTY → `dashboard` (FTUE). With config → `start` (unchanged;
    daemons depend on it).
  - `junco dashboard` / bare `junco` with no config, non-TTY → error with guidance
    (mentions `junco config init` and running in a terminal), instead of hanging.
  - Headless scaffold moves to **`junco config init`** — exact `init --yes` behavior:
    write default config if missing, never overwrite, ensure queue dirs. Joins the
    `config path|list|get|set` family.
- **Fallout sweep:** `scripts/package-smoke.sh` (`init --yes` → `config init`),
  CLAUDE.md sandbox recipe, README, `docs/operations.md`, `docs/configuration.md`,
  CHANGELOG breaking-change entry, cli routing tests.

## Section 5 — Testing

- **Pure units:** `parseMouse` motion parsing; registry store (register/unregister/
  deepest-wins resolution) against fake yoga nodes; rect-walk helper guards.
- **Component tests:** ink-testing-library with synthetic SGR sequences written to mock
  stdin; per-surface specs asserting selection/activation/hover. Bounded
  loop-until-condition assertions (CLAUDE.md TUI flake rule). `hitTest` tests retire
  with the module.
- **FTUE:** `Root` state machine with injected wizard/config seams; cli routing tests
  for the new no-config paths; the smoke script exercises `config init` end-to-end.

## Risks & mitigations

| Risk                              | Mitigation                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Ink `yogaNode` semi-internal API  | exact-pinned ink 7.1.0; one guarded module; loud test failure on upgrade                                              |
| Motion-event flood (1003)         | per-chunk coalescing + change-only hover store (`useSyncExternalStore`)                                               |
| Leaked CSI into `useInput`        | shared `useGuardedInput`; convention enforced across all TUI inputs                                                   |
| `<ClickableBox>` altering layout  | it _is_ a Box (props spread through); per-view component tests                                                        |
| Terminals without mouse reporting | no sequences arrive; keyboard paths unchanged                                                                         |
| Removing `init` breaks scripts/CI | `junco config init` keeps the headless scaffold; smoke script + docs updated in the same PR; CHANGELOG breaking entry |

## Out of scope

- Right/middle click, drag, click-to-position-cursor in text fields.
- Hover tooltips or any hover behavior beyond highlighting.
- tmux/terminal-specific mouse quirks beyond standard SGR (documented, not coded around).
- Workstream 2: dedicated GitHub account (`gh`) identity for junco — separate spec.
