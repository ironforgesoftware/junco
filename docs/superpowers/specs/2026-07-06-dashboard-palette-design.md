# Dashboard v1.1 — `w`/`i` Focus Keys + Command Palette

- **Date:** 2026-07-06 · **Status:** Approved · **Branch:** `feat/dashboard-palette` (off `feat/restart-cmd`)

## Decisions

| Decision        | Choice                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus keys      | Main view: `w` focuses the repos (watchlist) pane, `i` the issues pane — direct jumps complementing `tab`/`h`/`l`. Help updated.                                                                                                                                                                                                                                                                                                  |
| Palette         | `:` opens an overlay of CLI subcommands (name + USAGE description), typed prefix filter, `j/k`/arrows select, `enter` runs, `esc` closes. Arg-taking commands (`list`, `retry`, `submit`, `logs`, `service`) show a TextField args step first (whitespace-split argv — no shell, no injection surface).                                                                                                                           |
| Execution model | **Spawn the real CLI**: `process.execPath` + sibling `cli.js` (module-URL resolution; correct in `dist/`) + subcommand + args + `--config <the dashboard's config path>`. stdout+stderr merged into a scrollable output view (IssueDetail-style windowing; header = command line + exit code; spinner + elapsed while running; 120s kill timeout). Thin shell — future subcommands need only a roster row.                        |
| Roster          | Runnable: `status`, `list`, `retry`, `doctor`, `logs` (bounded default `-n 200`; `-f` never offered), `run-once`, `restart` (daemon is a separate process — the dashboard survives, test-pinned), `service`, `inbox-path`, `schema`, `submit`. Excluded, shown greyed with the reason: `init` (competing raw-mode wizard can't nest in Ink), `dashboard` (recursion), `start` (foreground daemon blocks forever — use `restart`). |
| Plumbing        | `runDashboard(cfg, configPath, deps?)` — the CLI case threads the resolved path; `AppProps.configPath`. New `src/tui/cliRunner.ts` (roster + `runCliCommand` behind a `spawnFn` seam) and `CommandPalette.tsx`/`CommandOutput.tsx`; App gains `palette`/`cmdOutput` view states.                                                                                                                                                  |

## Error handling

Runner failures (ENOENT, non-zero exit, timeout kill) render in the output view with the exit status — never crash the app. `q` quits only from the main view; `esc` unwinds output → palette → main. No cross-view conflicts by construction: views are exclusive and `:` binds only in the main view.

## Testing

Runner unit tests with a fake `spawnFn` (capture/merge, exit code, timeout SIGKILL, ENOENT); palette frame tests (filter, selection, greyed exclusions with reasons, args step); App wiring tests (`:` opens, run populates output view, `esc` unwinds, `w`/`i` focus, palette `restart` does not unmount the app); roster-vs-USAGE consistency test (every runnable roster name appears in cli.ts USAGE).
