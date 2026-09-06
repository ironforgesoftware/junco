# Ink upgrade checklist

ink is exact-pinned (no `^`) because two TUI behaviors are coupled to ink
internals. Before merging any ink version bump, walk this list.

## 1. `mouseRegions.ts` walks ink's semi-internal `yogaNode`

Hit-region rects for mouse targets are computed by walking `yogaNode` on ink's
DOM elements — the only module touching that internal
(`src/tui/mouseRegions.ts`). `tests/tuiMouseRegions.test.ts` fails loudly if
the shape changes.

**On a bump:** run the mouse suites
(`npx vitest run tests/tuiMouseRegions.test.ts tests/tuiMouse.test.ts tests/tuiMouseApp.test.tsx`),
then verify click/hover/wheel in a real terminal (`junco dashboard`): rail
clicks, footer chips, LOCAL body rows, wheel in lists and the daemon panel.

## 2. `exitOnCtrlC: false` is load-bearing

`dashboardCmd.ts` renders with `exitOnCtrlC: false`: under ink 7.1.0, `true`
makes `useInput` skip every registered handler for Ctrl-C, which would break
WizardApp's post-write Ctrl-C reporting and the FTUE-cancel exit code (130).
App installs its own Ctrl-C quit hook and the second input cascade bails early
so Ctrl-C is never misread as a plain `c` (`src/tui/App.tsx`). Test streams
are non-TTY, so this CANNOT be fully validated by the suite.

**On a bump:** re-read ink's changelog for `exitOnCtrlC`/`useInput` changes,
then smoke in a real TTY: Ctrl-C from the dashboard (clean quit), Ctrl-C
mid-wizard (cancel + exit 130), and the wizard Account chapter's suspended
`gh auth login` (raw-mode handoff — issues #214/#216 regressed here before).

## Related

- `tests/tuiRoot.test.tsx` (exit codes) and `tests/useSuspendTty.test.tsx`
  (raw-mode drop during suspension) — light coverage; the real-TTY smoke above
  is the actual gate.
