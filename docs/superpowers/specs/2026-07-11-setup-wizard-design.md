# Setup wizard walkthrough — design

**Date:** 2026-07-11
**Status:** approved
**Replaces:** the clack-based `junco init` wizard (`src/wizard.ts` + `src/wizard/prompter.ts`)

## Goal

Make `junco init` a best-in-class onboarding walkthrough: a full-screen Ink wizard that
gets a new user from zero to a verified, working setup in one sitting, teaches the
settings that actually change behavior, and leaves everything else on documented safe
defaults. Friendly "junco tips" (warm guide voice — a bird glyph and plain-language
notes, not a chatty mascot) explain each decision where it is made.

Research base: create-astro (personality at the bookends only), `gh auth login`
(detect-then-offer, receipts after every state change), Stripe CLI (trust copy at
authority-transfer moments), create-cloudflare (express and guided as one code path),
sv create (batch extras into one multiselect), shadcn (the config file is the product),
clig.dev (defaults everywhere, no dead ends, errors carry their fix).

## Non-goals

- Covering all ~75 config levers. The wizard tours the ~12 decisions that matter;
  `junco config list` and the dashboard ConfigView (`,`) remain the full-surface editors.
- A separate `junco tour` command. One state-aware wizard.
- Replacing `junco doctor`. The wizard's flight check reuses the same probe helpers but
  doctor stays the standalone, exhaustive preflight.
- Accessibility/plain-prompt fallback mode. Non-interactive paths are `--yes` and flags;
  a TTY without raw-mode support gets a clear pointer to `--yes` (see Error handling).

## UX flow

One flow, six chapters plus a welcome and a finale. Every question has a safe default
preselected, so the express path is holding Enter (~20 s); the guided path is reading
the tips. `--yes` stays fully non-interactive and writes the same defaults as today
(packaged smoke-test contract).

### Layout: chapter rail

Left rail lists chapters with `✓` (done) / `▶` (current); the active chapter renders on
the right. Mirrors the dashboard/ConfigView visual language. On terminals narrower than
80 columns the rail collapses to a `4/6` breadcrumb in the header (via the existing
`useTerminalSize` hook). Footer always shows the key legend:
`enter continue · ← back · q quit`.

### Keyboard model

- **Enter** commits the focused field / advances the chapter.
- **← / Esc** goes back one chapter (Esc on Welcome quits).
- **q** quits (outside text fields), **Ctrl-C** quits anywhere.
- Multiselect: **space** toggles, **enter** continues. Selects: **↑/↓** move.
- Quit before Review confirm → "Setup cancelled — nothing written." exit 130.

### Chapters

**0 · Welcome & preflight.** Greeting personalized via `git config user.name` first
name (fallback: "friend"), one line from a small rotating pool (3–5 variants, no
seasonal pools). While the user reads, preflight probes run with spinners and settle
into receipts: node ≥ 22.19, git present, gh present + authenticated as `<login>`,
existing config detected (→ re-run mode) or not. Detect-then-offer: what the machine
already has right is shown, never asked. Tip: *"Every answer lands in one editable
file — config.json. Nothing here is permanent."*

**1 · Workspace.** `vaultRoot` text field (default `~/Junco`). Writes `juncoSubdir: ""`
exactly like today, so the queue lives directly under the chosen root. Tip: *"This is
junco's nest — tickets fly into inbox/, get worked in processing/, and land in done/ or
failed/."*

**2 · Model.** Source select: inline OpenAI-compatible endpoint (default) or a Pi-style
models.json. Inline: base URL (default `http://127.0.0.1:1234/v1`), API key, then a
live probe with receipt ("✓ reachable — 12 models found") and a model picker with an
"enter manually" escape; discovered/bare ids get the inferred provider prefix, ids
containing `/` are kept as-is (today's rules, `inferProvider` unchanged). models.json:
path (default `~/.pi/agent/models.json`), parse, pick. An unreachable endpoint is a
warning receipt, never a dead-end — the flight check re-probes at the finale. Tip:
*"junco drives a coding agent through this inference endpoint. Any OpenAI-compatible
/v1 works."* (Stack-agnostic copy — never a specific server product.)

**3 · Repo safety.** `git.allowedRepoRoots`: repeated add-a-folder field (submit empty
to finish; suggestion placeholder `~/code`). Honest about the default: leaving it empty
means tickets may target any repo path. Trust copy at the authority-transfer moment:
*"junco only works in throwaway worktrees and opens pull requests — it never commits to
your branches. Folders you list here are the only places a ticket can point it."*

**4 · GitHub bridge.** Enabled toggle, default off, with the zero-cost framing: *"Off
means zero gh calls — junco stays fully local. Flip it later with `junco config set
github.enabled true`."* When enabled, reveal: watched repos (repeat: `owner/repo` +
local clone path, empty to finish; adding none is fine — doctor warns, dashboard `a`
adds later) and the `requireApproval` toggle (default on) with copy explaining that
off means plan-ready tickets auto-execute.

**5 · Extras.** One multiselect, recommended set pre-checked, matching real schema
defaults: `sandbox.enabled` (on — *"agent commands run inside an OS sandbox; if the
backend is missing, tickets fail closed rather than run unconfined"*), `verify.enabled`
(on — build/test before the PR opens), `observability.healthEnabled` (on — *"127.0.0.1
only"*), `observability.transcripts` (on — the per-ticket debugging record). Footer
shows the focused row's `LEVERS` description, ConfigView-style. Unchecking writes an
explicit `false`.

**6 · Review & write.** Fresh mode: the exact `config.json` to be written, with
non-default lines highlighted, plus *"~65 more levers keep their safe defaults —
`junco config list` shows every one."* Re-run mode: an old → new diff of just the
changed paths; zero changes → "Nothing changed — config untouched." and skip to the
finale. Confirm select: Write / Go back / Quit. On write: validate, atomic temp+rename,
create queue dirs + worktree root, then receipts ("✓ Wrote …", "✓ Created queue …").

**Finale · Flight check & next steps.** Inline doctor-lite receipts: endpoint
reachable, configured model advertised (warn-only), queue/worktree/state dirs writable,
gh auth (warn-only), sandbox backend availability when enabled. Failures print their
fix command but never block — config is already safely written; `junco doctor` is the
standalone re-check. Then a staged-reveal next-steps panel (~150 ms per line):
`junco start`, `junco submit <ticket>.md`, `junco` (dashboard), `junco config list`,
docs link. Sign-off: *"The nest is ready. 🐦"*

### Re-run mode (config exists)

`junco init` with an existing config enters the same wizard in tune-up mode: Welcome
says "Found your config at `<path>` — let's tune it. q leaves everything untouched."
Answers are pre-filled from the current file; Review shows a diff; the write applies
`setAtPath` per changed lever onto the **raw parsed JSON object** (ConfigView's write
pattern), so keys the wizard doesn't cover are preserved verbatim. Queue dirs are
ensured either way (today's dir-repair behavior). Bare `junco` with a config still
routes to `start` — re-run is only ever explicit.

## Architecture

Pure logic, thin Ink skin:

- **`src/wizard/flow.ts`** — chapter state machine: `WizardAnswers` (superset of
  today's), chapter order, conditional steps (GitHub sub-steps only when enabled),
  per-field validation, `defaultAnswers()`, and `buildConfigObject(answers)` /
  `applyAnswers(rawConfig, answers)` for the two write modes. No Ink, no IO.
- **`src/wizard/detect.ts`** — preflight + flight-check probes returning
  `{ verdict: "ok" | "warn" | "fail", label, detail }` records, behind injectable deps
  (`execFn`, `fetchModelsFn`, `accessOkFn`) — the same seam shapes doctor uses. Reuses
  `endpointReachable`, `fetchModels`, `selectBackend`/`classifyAvailability` directly;
  doctor itself is not refactored.
- **`src/wizard/tips.ts`** — the copy registry: greetings pool, chapter tips, trust
  copy, sign-off. One file so the stack-agnostic gate is a grep and copy review is a
  single diff.
- **`src/tui/wizard/`** — `WizardApp.tsx` (rail, chapter router, footer) + one
  component per chapter, reusing `TextField`, `Spinner`, and the TUI theme. Lazy-loaded
  with `await import` (dashboard pattern) so `--yes`/non-TTY never load React.
- **`src/wizard.ts`** — `runInitWizard(configPath, deps)` keeps its signature and exit
  codes (0 ok, 130 cancelled). `--yes` → `defaultAnswers()` → same minimal config as
  today, no Ink. Interactive → render `WizardApp`, receive final answers (or
  cancellation), write, flight-check. The interactive collection step sits behind an
  injectable `collectFn` seam so `runInitWizard`'s write/dir/exit-code contract is
  testable without a TTY.
- **Deleted:** `src/wizard/prompter.ts` and the `@clack/prompts` dependency (the wizard
  is its only consumer). `wizard/models.ts` is unchanged (doctor imports it too).

### Config write shapes

- **Fresh:** minimal file — `vaultRoot`, `juncoSubdir: ""`, `model.{…}`, plus only
  answers that differ from schema defaults: `git.allowedRepoRoots` when non-empty,
  `github.{enabled, repos, requireApproval}` when enabled, and explicit `false` for any
  unchecked extra. Must round-trip through `loadConfig`.
- **Re-run:** read raw JSON → `setAtPath` only changed lever paths →
  `validateConfigObject` → atomic temp+rename. Unknown/uncovered keys preserved.

### CLI wiring changes (`src/cli.ts`)

- `init` with existing config: replace the "Config already exists" message path with
  the wizard in re-run mode (still non-TTY-guarded; `--yes` with existing config keeps
  today's repair-dirs-and-exit behavior — it must stay non-destructive).
- Help text: describe init as the guided walkthrough; note re-run tunes an existing
  config.
- First-run detection (bare `junco` → init when no config) unchanged.

## Error handling

- Cancel (q/Esc-at-Welcome/Ctrl-C): exit 130; fresh mode has written nothing, re-run
  mode leaves the file untouched. Ink unmounts cleanly (no raw-mode residue).
- Endpoint unreachable / no models listed: warning receipt + continue; manual model
  entry always available.
- Config write failure: error with the path and fix hint, exit 1.
- TTY without raw-mode support (`stdin.isTTY` true but `setRawMode` unavailable):
  print the existing non-interactive guidance (use `--yes` or create config.json),
  exit 1 — never render a broken UI.
- Flight-check failures: ⚠/✗ receipts with fix commands (clig.dev: errors carry their
  fix), exit stays 0 once the config is written.

## Testing

Mirrors existing repo patterns; vitest throughout.

- **flow tests** (pure): chapter transitions incl. conditional GitHub steps; defaults;
  validation; `buildConfigObject` round-trips through `loadConfig` (inline,
  models_json, extras-unchecked, repo-roots cases); `applyAnswers` preserves uncovered
  keys and yields a diff-only change set; `--yes` output pinned to today's defaults
  (`~/Junco`, `local/my-model`, `http://127.0.0.1:1234/v1`, key `1234`).
- **detect tests**: fake `execFn`/`fetchFn` → receipt records for each verdict.
- **tips tests**: extend the existing "no personal-stack strings" guard over the whole
  copy registry (no omp/omlx/launchd/vault/model-name strings; "inference endpoint"
  language); every chapter has a tip.
- **WizardApp tests** (ink-testing-library): Enter-through yields default answers;
  cancel path; rail progress marks; narrow-terminal breadcrumb; bounded-retry
  condition loops per the CLAUDE.md flake rule — never a fixed single tick.
- **wizard tests**: `runInitWizard` contract — `--yes` writes config + creates the five
  dirs with no prompt; injected `collectFn` cancellation → 130 and no write; receipts
  printed.
- **cli tests**: init routing with existing config now enters re-run mode; non-TTY
  guard unchanged; `--yes` passthrough unchanged.
- **package-smoke.sh**: unchanged and must stay green (`init --yes` writes the XDG
  config non-interactively).

## Docs & packaging

- README quick start: screenshot-style walkthrough blurb, `--yes` note.
- `docs/configuration.md`: point at the wizard for first-run and re-run tune-up.
- CLI `USAGE` text, CHANGELOG entry (Keep a Changelog).
- Dependencies: `@clack/prompts` is removed; nothing new is added (ink/react already
  ship).
- All wizard copy is stack-agnostic (packaging rule): "inference endpoint", never a
  product name.
