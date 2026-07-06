# `junco dashboard` — Terminal UI for GitHub Mode

- **Date:** 2026-07-06
- **Status:** Approved
- **Branch:** `feat/dashboard` (off `feat/github-inbox` — depends on the planner-stage bridge)

## Motivation

GitHub mode's workflow today spans two surfaces: the GitHub web UI (label issues,
read plan comments, approve) and the terminal (`junco status`/`list`/`logs`). The
dashboard collapses the loop into one keyboard-driven screen: watch repos, see every
issue's lifecycle state at a glance, dispatch/approve/re-cycle without leaving the
terminal — while remaining a **GitHub client, not a queue client**: every action is a
label mutation by the operator's own authenticated `gh` identity, so the bridge's
permission gates apply unchanged.

## Decisions

| Decision          | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Command           | `junco dashboard` (fullscreen, alternate screen buffer; non-TTY → clean error pointing at `junco list`/`status`)                                                                                                                                                                                                                                                                                                                                             |
| Framework         | **Ink 7 (7.1.0) + React 19** — pure JS, exact-pinnable, `ink-testing-library` renders frames as strings (vitest-testable, no TTY). OpenTUI evaluated and declined for v1: its wins (uncapped render rate, mouse, Bun-first Zig core) don't intersect a keystroke-and-poll dashboard, and a pre-1.0 native binary is a packaging liability on plain-Node npm installs. Components stay pure over an injected data client, so the renderer is swappable later. |
| New deps          | `ink`, `react` (runtime, exact-pinned); `ink-testing-library`, `@types/react` (dev). Widgets hand-rolled — the dep tree grows by exactly two runtime packages.                                                                                                                                                                                                                                                                                               |
| Lazy loading      | `cli.ts` loads the dashboard via `await import(...)` inside the subcommand — no other CLI path (and never the daemon) pays the React/Ink import cost. Mirrors the Pi-SDK lazy-load rule.                                                                                                                                                                                                                                                                     |
| Watchlist storage | `<state_dir>/github-watchlist.json`, atomic tmp+rename writes. `resolveWatchedRepos(cfg)` = config `[[github.repos]]` ∪ watchlist file, deduped by nwo, config wins. The bridge sweep resolves per sweep → **hot reload, no daemon restart**. Config entries render read-only in the dashboard.                                                                                                                                                              |
| Action scope (v1) | Full lifecycle: dispatch, dispatch-as-ask, approve, re-plan, re-cycle, open-in-browser, add/remove watched repo.                                                                                                                                                                                                                                                                                                                                             |
| State derivation  | An issue's lifecycle state is derived purely from its labels (raw → planning → plan-ready → approved → queued → working → done/failed/denied). The dashboard holds no queue state.                                                                                                                                                                                                                                                                           |

## Architecture

```
┌ repos ────────────┐┌ issues: alxedelweiss/hawaiian-coral ─────────────────┐
│ ▸ acme/api    3●  ││ ● #42 Add rate limiting              plan-ready  2h │
│   acme/web    1●  ││ ◐ #40 Fix upload timeout             working     5m │
│   alx…/coral  2●  ││ ✓ #38 Add CONTRIBUTING.md            done        1d │
│                   ││ ○ #43 Dark mode                      —           3h │
│ [A]dd [x] remove  ││                                                      │
└───────────────────┘└──────────────────────────────────────────────────────┘
┌ status ──────────────────────────────────────────────────────────────────┐
│ daemon ● up 2h · sweep 12s ago · 2 bridged   d dispatch a approve ? help │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Repos pane:** watched repos with per-state issue counts; `A` opens the add-repo
  form, `x` unwatches (watchlist entries only).
- **Issues pane:** state glyph + number + title + lifecycle badge + relative
  updated-at, color-coded. `enter` opens the detail view: issue body plus the latest
  junco plan comment (fetched on demand, scrollable) — the plan is reviewable
  in-terminal before approving.
- **Status bar:** daemon liveness + last bridge sweep (`/health`, lockfile fallback)
  and contextual key hints; also the toast line for action results/errors.
- **Keys:** `j/k` move · `tab` (or `h/l`) switch panes · `enter` detail · `d`
  dispatch · `D` dispatch-as-ask · `a` approve (plan-ready only) · `R` re-plan /
  re-cycle (contextual: removes `plan-ready`, or `done`/`failed`) · `o` open in
  browser · `A` add repo · `x` unwatch · `r` refresh · `?` help overlay · `q` quit.
  Action keys are enabled/disabled by the selected issue's derived state; disabled
  actions show why in the toast line.

## Modules

| File                       | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/watchlist.ts`         | Shared by dashboard + bridge: read/validate/write the watchlist file (atomic), `resolveWatchedRepos(cfg, deps)` union with config precedence.                                                                                                                                                                                                                                                                         |
| `src/tui/ghClient.ts`      | The only GitHub-touching module in the TUI: issue lists (`gh issue list --json number,title,labels,updatedAt,url`), issue detail (`gh issue view --json body` + the plan-comment fetch reusing the bridge's marker/author rules), label mutations, repo validation (`gh repo view`), trigger-label ensure. Injected `ghFn` (same wrapper as the bridge); every call best-effort with typed errors for the toast line. |
| `src/tui/state.ts`         | Pure: labels → lifecycle state, state → glyph/color/allowed-actions, issue sorting (actionable states first, then updated-at).                                                                                                                                                                                                                                                                                        |
| `src/tui/App.tsx`          | Root: pane focus, key routing, polling loops (issues 30s, health 5s), optimistic label mutations with rollback on error.                                                                                                                                                                                                                                                                                              |
| `src/tui/components/*.tsx` | `RepoList`, `IssueTable`, `IssueDetail`, `StatusBar`, `AddRepoForm`, `HelpOverlay` — pure render given props.                                                                                                                                                                                                                                                                                                         |
| `src/dashboardCmd.ts`      | Subcommand entry: TTY guard, config load, lazy Ink render, exit handling.                                                                                                                                                                                                                                                                                                                                             |

## Add-repo flow (closes a known gotcha)

The `A` form asks nwo + local clone path, then validates exactly what `doctor`
checks: path exists and is a git clone; `origin` resolves to the nwo
(`nwoFromRemoteUrl`); repo reachable via `gh repo view`. On success it also
**creates the trigger label if missing** (`gh label create <trigger> --force`-less
create-or-skip) — the manual-testing gap where `--add-label junco` fails on a fresh
repo — then writes the watchlist atomically. The next bridge sweep (≤ poll interval)
picks the repo up with no restart.

## Daemon-side change (small, contained)

`pollGithubInbox` iterates `resolveWatchedRepos(cfg, deps)` instead of
`cfg.github.repos` directly. Watchlist read failures degrade to config-only (log
warn). Origin/label caches stay keyed by nwo as today. `doctor` validates watchlist
entries alongside config mappings and reports the watchlist path when enabled.

## Error handling

| Failure                                | Behavior                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gh` call fails (list/detail/mutation) | Toast in the status bar; stale data stays visible with a staleness marker; mutations roll back optimistic state. Never crashes the app.                |
| Daemon down                            | Status bar shows `daemon ○ not running`; dashboard remains fully functional (it's a GitHub client — dispatches queue up for whenever the daemon runs). |
| Watchlist file corrupt                 | Dashboard: error banner + treat as empty (never clobber the corrupt file without an explicit re-add). Bridge: log warn, config-only.                   |
| Not a TTY                              | Exit 1 with guidance before any Ink import.                                                                                                            |
| Terminal resize                        | Ink reflows (flexbox); panes have min-width floors.                                                                                                    |

## Testing

- **Components/App:** `ink-testing-library` — render with a fake client, assert
  frames (rows, badges, counts, toasts), drive keys via `stdin.write`, assert the
  fake recorded the intended label ops (dispatch/approve/re-cycle), including
  disabled-action paths and optimistic rollback on injected failure.
- **watchlist.ts:** tmp-dir unit tests — atomic write, merge precedence (config wins),
  corrupt-file degradation.
- **Bridge:** one sweep test proving a watchlist entry added between sweeps is swept
  without restart (inject the watchlist path via deps).
- **state.ts:** table-driven labels→state→actions tests.
- **CLI:** non-TTY guard; `dashboard` subcommand routes and lazy-loads (no react in
  the module graph until invoked — assert via a spy on the dynamic import seam).

## Out of scope (v1) — seams kept

Log-tail pane; editing plan comments in-terminal (use `o` → browser); mouse support;
OpenTUI renderer; queue-file browsing; multi-account; issue creation from the
dashboard; non-GitHub forges.
