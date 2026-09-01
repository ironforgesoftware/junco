# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Junco is a TypeScript (Node ≥ 22.19, ESM/NodeNext, strict) task-queue worker that turns Markdown tickets into git pull requests by driving the Pi coding agent **in-process** (`@earendil-works/pi-coding-agent` — no subprocess). Read `ARCHITECTURE.md` before touching the runtime; it is accurate and maintained. Implementation plans live in `docs/superpowers/plans/` and are executed task-by-task with a commit per task (TDD: failing test first).

## Commands

| Action    | Command                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| Build     | `npm run build` (tsc → `dist/`; compiles `src/` only — `tests/` are excluded)                        |
| All tests | `npm test` (vitest, ~4,300 tests, ~40s)                                                              |
| One file  | `npx vitest run tests/<name>.test.ts`                                                                |
| Coverage  | `npx vitest run --coverage` (floor pinned by `vitest.config.ts` thresholds; CI job `coverage`)       |
| Lint      | `npm run lint` (type-aware via `tsconfig.eslint.json`, which is what covers `tests/`)                |
| Typecheck | `npm run typecheck` (tsc over src/ + tests/ via `tsconfig.eslint.json` — vitest does not type-check) |
| Format    | `npm run format` / `npm run format:check` (prettier, 100 cols)                                       |
| Full gate | `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`             |

Run the full gate before claiming work done; CI (`.github/workflows/quality-gate.yml`) runs it on PRs and pushes to main across ubuntu/macos × node 22.19/24, plus a packaged-CLI smoke test; the aggregate `quality-gate` check is required to merge.

**Exit-code trap:** piping vitest into `grep`/`tail` makes the pipeline exit with the _filter's_ status — a failing suite reads as green. Capture it explicitly: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`.

## Architecture in one breath

Tickets (Markdown + YAML frontmatter) land in `inbox/`, are claimed by atomic rename into `processing/`, executed (PR flow in a git worktree, or read-only Q&A), then finalized into `done/`/`failed/` — or **requeued** to `inbox/` with `retry_count`/`not_before` backoff on transient failures and crash recovery. `prFlow.ts` is the 14-phase PR orchestrator; `daemon.ts` owns the serial poll loop plus `runScheduler` (`max_concurrent > 1`, same-repo tickets always serialize); `agent/` wires the Pi SDK, the four loop guards, and the supervisor (nudge → escalate → kill; guard kills and timeouts are SOFT aborts whose commits get salvaged into a PR). Module map: `ARCHITECTURE.md`.

## Hard rules

- **`src/ticketSchema.ts` is the stable public contract.** External dispatchers generate tickets against it — additive changes only. Q&A tickets default to read-only tools; never widen that default (per-ticket `tools:` frontmatter is the explicit opt-in).
- **Never import the Pi SDK at module top level in `src/`** (type-only imports are fine). The runtime `await import(...)` lives only inside `src/agent/session.ts` (the factory plus the doctor/wizard helpers) — everything else stays pure and unit-testable against the minimal `AgentSessionLike` seam.
- **Every side effect goes behind an injectable `deps` seam** (see any module's `*Deps` interface). Tests never touch the network or a real model: fake `gh` is an inline-generated shell script, fake sessions implement `AgentSessionLike`.
- Dependencies are **exact-pinned** (no `^`): add with `npm install --save-exact <pkg>`.
- Many comments cite `worker.py` line numbers (Python-port provenance) or SDK `.d.ts` locations — they are verification evidence, not noise. Keep them true or delete them with the code they describe; never let them drift.

## Testing gotchas (each of these has burned a session)

- **Adding a `Config` field? Add it to `tests/helpers/config.ts` and nowhere else** — it is the only full `Config` literal in the suite (it replaced 19). `makeConfig` returns `Config` unasserted, so a new field is a type error _there_, not a silent drift across fixtures. Its `ConfigSeams` are the ten keys whose value changes what a test exercises (`dataDir`, `queueRoot`, `worktreeRoot`, `tools`, and the six feature toggles); put the field there instead if callers must state it. `ghBin` defaults to `/nonexistent/gh` on purpose — a test needing `gh` passes its own fake. Shared fixtures: `tests/helpers/{config,gitHarness,fakeSession,until,forkHarness,localFixtures}`.
- Scheduler/daemon tests: an instant-resolve fake `sleep` starves the macrotask queue (the loop spins on microtasks; `setTimeout`-based fake tasks never settle → OOM). Yield a real tick: `await new Promise((r) => setTimeout(r, 1))`.
- Repo/PR/worktree tests run a real git harness (bare remote + clone in tmp); they need `git config user.*` (CI sets it globally).
- Prettier may reformat files between your read and your edit; re-read before editing and run `npx prettier --write` on touched files before committing.
- Ink tests that observe Ink's OWN stdout writes (frame bytes, repaint after suspend) must pass `interactive: true` to `render()`: Ink defaults it to `!isInCi && stdout.isTTY`, and CI sets `CI=true`, so on GitHub Ink writes no frames at all — green locally, red on every runner (PR #334). ink-testing-library assertions on `lastFrame()` are unaffected.
- Ink/TUI tests: never assert one fixed `setTimeout` tick after a state change — slow CI runners race React's commit (this flaked a release gate). Loop-until-condition with a bounded retry, then assert.
- `src/tui/**` runs `eslint-plugin-react-hooks` with **both** rules (`rules-of-hooks`, `exhaustive-deps`) at **error** — a hook with an incomplete dep array fails `npm run lint` (part of the gate). Fix the deps (stabilize the source: memoize the value/callback the hook closes over) — do NOT `eslint-disable` to get past it. App owns the nav spine (`view`/`pane`/`railSel` + derived `currentNwo`/`sysSection`) and passes it into the domain hooks in `src/tui/hooks/` as read-only inputs; domain E (`localCheap`/`localHeavy`) stays inline in App on purpose (a `sysSection ← localHeavy` render cycle blocks a clean hook — see #262).
- Sandbox (`agent/sandbox/`) tests: `buildPolicy`/path-jail `canonicalize()` **realpaths** real paths, so `/tmp` and `/var` collapse to `/private/...` on macOS. Use synthetic non-existent paths (`/sbxroot/...`) in unit tests so canonicalization is a no-op; the platform-gated `sandbox.integration.test.ts` exercises real Seatbelt/bwrap enforcement and skips when the backend binary is absent.

## The repo doubles as the maintainer's live runtime — do not disturb

`config.json` (repo root), `tickets/`, `worktrees/`, `launchd.out/err` are **live, gitignored runtime state**, and a launchd daemon may be running from this checkout. Never delete, modify, or `git clean` them; never run `junco start` here; never submit test tickets to the real inbox. Config resolution is HOME-anchored (`~/.junco/config.json`, legacy XDG fallback) — cwd never matters, but running the CLI with your real `HOME` still picks up the **live** config, so sandbox every smoke test:

```bash
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /path/to/junco/dist/cli.js config init && <smoke> ; cd / && rm -rf "$SB"
```

Parallel dev sessions: `claude -w <topic>` from the repo root, or a manual worktree under the
gitignored `worktrees-manual/` — **never under `worktrees/`** (daemon-owned; junco force-removes
paths there). The main checkout is the daemon's build home — park it on `main`, do feature work in
worktrees. Survey open PRs/branches before designing, and merge `origin/main` into multi-task
branches between tasks — a collision found mid-plan is a course correction; found at PR time it is
a semantic merge. Details: `docs/parallel-sessions.md`.

## Debugging & visibility

- `node dist/cli.js doctor` — preflight config, git/gh auth, endpoint, model, dirs.
- `node dist/cli.js status` / `list` / `logs -f` — daemon, queue, and log visibility; health JSON at `http://127.0.0.1:8787/health` (default).
- Per-ticket event transcripts (the debugging record for failed runs): `<dataDir>/data/transcripts/<ticket-id>.jsonl`, default `~/.junco/data/transcripts/` (a pre-0.10 `flat`-layout root keeps `<dataDir>/transcripts/`). `junco replay <id>` re-runs a transcript through the guards under any policy (flag > recorded > config > defaults) — a what-if report, not a live rerun. `junco transcript <id>` (or `enter` on the dashboard's queue row, `t` on an issue row) renders it: runs, tool calls + results, the agent's answer.

## Git & release

- Branch `feat/<topic>` off `main`; conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, optional scope); suite green at every commit.
- **No AI attribution, ever:** no `Co-Authored-By: Claude` trailers, no "Generated with Claude Code" lines. Subagent-driven commits auto-append the trailer — amend it away before finishing.
- **Release HOLD (absolute):** never push, tag, `gh release create`, or publish without the maintainer's explicit, per-release approval — generic approval of the work does not cover release actions. Once approved, the flow is: bump `package.json` + `CHANGELOG.md` (Keep a Changelog) via PR → quality gate green → merge → annotated tag `vX.Y.Z` → `gh release create vX.Y.Z` (this triggers `.github/workflows/publish.yml` → npm publish via OIDC trusted publishing with provenance (no NPM_TOKEN)) → verify with `npm view @ironforgesoftware/junco version`. `publish.yml` checks out the TAG — a gate-blocking fix after tagging means delete release+tag, fix, re-tag, re-release (harmless while nothing reached npm).
- **Pre-tag doc checklist** (each item is a drift the 2026-09 sweep found already shipped): diff `USAGE` in `src/cli.ts` against the README command table and the `docs/operations.md` CLI table; confirm every new `ConfigSchema` top-level key has a `docs/configuration.md` heading; add the new version to the link-reference block at the bottom of `CHANGELOG.md` and repoint `[Unreleased]` at it (`tests/docsChangelog.test.ts` pins the block to the headings and `package.json`; `tests/docsOperationsCli.test.ts` pins the operations table).
- The npm package ships only the `files` allowlist (`dist`, `templates`, `skills`, `examples`, README/CHANGELOG/LICENSE). Everything that ships is **stack-agnostic**: no personal-setup strings in wizard text, templates, README, or the `junco-dispatch` skill; user-visible runtime text says "inference endpoint", never a specific server.

## Maintaining this file

Add a line only if it is (a) not derivable from the code in under a minute and (b) likely to change an agent's behavior. Delete lines the moment they stop being true — stale guidance is worse than none. Keep it under ~120 lines.
