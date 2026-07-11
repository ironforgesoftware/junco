# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Junco is a TypeScript (Node ≥ 22.19, ESM/NodeNext, strict) task-queue worker that turns Markdown tickets into git pull requests by driving the Pi coding agent **in-process** (`@earendil-works/pi-coding-agent` — no subprocess). Read `ARCHITECTURE.md` before touching the runtime; it is accurate and maintained. Implementation plans live in `docs/superpowers/plans/` and are executed task-by-task with a commit per task (TDD: failing test first).

## Commands

| Action    | Command                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| Build     | `npm run build` (tsc → `dist/`; compiles `src/` only — `tests/` are excluded)                        |
| All tests | `npm test` (vitest, ~1,500 tests, under a minute)                                                    |
| One file  | `npx vitest run tests/<name>.test.ts`                                                                |
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
- **Never import the Pi SDK at module top level in `src/`** (type-only imports are fine). The runtime `await import(...)` lives only inside `makePiSessionFactory` — everything else stays pure and unit-testable against the minimal `AgentSessionLike` seam.
- **Every side effect goes behind an injectable `deps` seam** (see any module's `*Deps` interface). Tests never touch the network or a real model: fake `gh` is an inline-generated shell script, fake sessions implement `AgentSessionLike`.
- Dependencies are **exact-pinned** (no `^`): add with `npm install --save-exact <pkg>`.
- Many comments cite `worker.py` line numbers (Python-port provenance) or SDK `.d.ts` locations — they are verification evidence, not noise. Keep them true or delete them with the code they describe; never let them drift.

## Testing gotchas (each of these has burned a session)

- **Adding a `Config` field? Update every test fixture that builds a full `Config` literal** — `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts` each have a `makeConfig`/`cfg()` helper. `npm run typecheck` catches misses at CI time (vitest doesn't type-check and `tsconfig.json` excludes `tests/` — the eslint tsconfig covers them).
- Scheduler/daemon tests: an instant-resolve fake `sleep` starves the macrotask queue (the loop spins on microtasks; `setTimeout`-based fake tasks never settle → OOM). Yield a real tick: `await new Promise((r) => setTimeout(r, 1))`.
- Repo/PR/worktree tests run a real git harness (bare remote + clone in tmp); they need `git config user.*` (CI sets it globally).
- Prettier may reformat files between your read and your edit; re-read before editing and run `npx prettier --write` on touched files before committing.
- Ink/TUI tests: never assert one fixed `setTimeout` tick after a state change — slow CI runners race React's commit (this flaked a release gate). Loop-until-condition with a bounded retry, then assert.
- Sandbox (`agent/sandbox/`) tests: `buildPolicy`/path-jail `canonicalize()` **realpaths** real paths, so `/tmp` and `/var` collapse to `/private/...` on macOS. Use synthetic non-existent paths (`/sbxroot/...`) in unit tests so canonicalization is a no-op; the platform-gated `sandbox.integration.test.ts` exercises real Seatbelt/bwrap enforcement and skips when the backend binary is absent.

## The repo doubles as the maintainer's live runtime — do not disturb

`config.toml` (repo root), `tickets/`, `worktrees/`, `launchd.out/err` are **live, gitignored runtime state**, and a launchd daemon may be running from this checkout. Never delete, modify, or `git clean` them; never run `junco start` here; never submit test tickets to the real inbox. Config resolution prefers `./config.toml`, so running the CLI from the repo root picks up the **live** config — sandbox every smoke test:

```bash
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /path/to/junco/dist/cli.js init --yes && <smoke> ; cd / && rm -rf "$SB"
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
- Per-ticket event transcripts (the debugging record for failed runs): `<state_dir>/transcripts/<ticket-id>.jsonl`, default `~/.local/state/junco/`.

## Git & release

- Branch `feat/<topic>` off `main`; conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, optional scope); suite green at every commit.
- **No AI attribution, ever:** no `Co-Authored-By: Claude` trailers, no "Generated with Claude Code" lines. Subagent-driven commits auto-append the trailer — amend it away before finishing.
- **Release HOLD (absolute):** never push, tag, `gh release create`, or publish without the maintainer's explicit, per-release approval — generic approval of the work does not cover release actions. Once approved, the flow is: bump `package.json` + `CHANGELOG.md` (Keep a Changelog) via PR → quality gate green → merge → annotated tag `vX.Y.Z` → `gh release create vX.Y.Z` (this triggers `.github/workflows/publish.yml` → npm publish via OIDC trusted publishing with provenance (no NPM_TOKEN)) → verify with `npm view @ironforgesoftware/junco version`. `publish.yml` checks out the TAG — a gate-blocking fix after tagging means delete release+tag, fix, re-tag, re-release (harmless while nothing reached npm).
- The npm package ships only the `files` allowlist (`dist`, `templates`, `skills`, `examples`, README/CHANGELOG/LICENSE). Everything that ships is **stack-agnostic**: no personal-setup strings in wizard text, templates, README, or the `junco-dispatch` skill; user-visible runtime text says "inference endpoint", never a specific server.

## Maintaining this file

Add a line only if it is (a) not derivable from the code in under a minute and (b) likely to change an agent's behavior. Delete lines the moment they stop being true — stale guidance is worse than none. Keep it under ~120 lines.
