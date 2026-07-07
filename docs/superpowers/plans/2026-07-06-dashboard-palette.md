# Dashboard Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline — 3 tasks). Checkbox steps. Spec: `docs/superpowers/specs/2026-07-06-dashboard-palette-design.md`.

**Goal:** `w`/`i` pane-focus keys and a `:` command palette that runs junco CLI subcommands as subprocesses with captured output.

## Global Constraints

No new deps; no shell (argv arrays only); vitest exit-code discipline; prettier per commit; suite green per commit; stack-agnostic text; no AI attribution; never run junco start/dashboard against the live config in tests.

### Task 1: `src/tui/cliRunner.ts` — roster + subprocess runner

Produces: `PaletteCommand { name, argsHint: string | null, description, defaultArgs: string[], excluded: string | null }`; `PALETTE_COMMANDS: PaletteCommand[]` (11 runnable + 3 excluded-with-reason); `CliRunResult { code: number | null, output: string, timedOut: boolean }`; `runCliCommand(configPath, name, extraArgs, deps?: { spawnFn?, cliPath?, timeoutMs? }): Promise<CliRunResult>` — spawns `process.execPath [cliPath, name, ...extraArgs, "--config", configPath]`, merges stdout+stderr in arrival order, SIGKILL + `timedOut: true` at timeout (default 120s), ENOENT/spawn-error → `{ code: null, output: <error message> }`. `cliPath` default resolves `../cli.js` from the module URL (correct under `dist/`; tests always inject). Tests: fake spawnFn EventEmitter-style (emit stdout/stderr chunks, close(code)); capture order; timeout kill (fake never closes until killed — assert `kill` called + timedOut); ENOENT via error event; roster shape (excluded entries carry reasons; `logs` defaultArgs `["-n","200"]`).

- [ ] Failing tests → red → implement → green → commit `feat(tui): palette roster + CLI subprocess runner`.

### Task 2: `CommandPalette.tsx` + `CommandOutput.tsx`

Produces: `<CommandPalette commands filter selected argsMode argsValue onFilter onSelect onArgs onRun onCancel />` (pure; renders name+description rows, greyed excluded rows with reason, filter line, args TextField step) and `<CommandOutput title running elapsedS output scroll exitCode timedOut />` (IssueDetail-style line windowing + status header). Frame tests: filter narrows, excluded row shows reason and is skipped by selection movement, args step renders placeholder, output view shows header/exit/timeout states and scroll hint.

- [ ] Failing tests → red → implement → green → commit `feat(tui): command palette + output view components`.

### Task 3: App wiring, `w`/`i` keys, configPath threading, docs

`AppProps.configPath: string`; `runDashboard(cfg, configPath, deps?)` (cli case passes the resolved path; dashboardCmd tests updated); App: `:` opens palette (main view only), palette state machine (filter → optional args → run → cmdOutput view with 1s elapsed ticker), `esc` unwinds output→palette→main, `w`/`i` focus jumps, Help overlay gains the three keys. Tests: `w`/`i` focus frames; `:` → run `status` via fake runner (inject `runCliFn` — add `runCliFn?: (name, extraArgs) => Promise<CliRunResult>` to AppProps for testability, defaulting to the real runner bound to configPath) → output view shows captured text; palette `restart` run does not unmount (frame still renders after resolve); excluded `init` cannot be run (enter on it is a no-op toast). Docs: README dashboard section (keys + palette paragraph), CHANGELOG bullet. Full gate.

- [ ] Failing tests → red → implement → green → gate → commit `feat(tui): ':' command palette wired into the dashboard + w/i focus keys + docs`.
