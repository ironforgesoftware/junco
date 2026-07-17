# Bare `junco` ensures the daemon, then opens the dashboard (design)

**Date:** 2026-07-16
**Status:** approved
**Branch:** `feat/junco-ensure-daemon` (off `main`)

## Problem

Bare `junco` (no subcommand) is the command a human is most likely to type, but today it is
a poor default: with a config present it routes to `start`, running the daemon **in the
foreground** and blocking the terminal; with no config it opens the dashboard FTUE. Neither
gives the "one command that opens my control panel" experience. Meanwhile the daemon that
actually matters is the launchd/systemd-supervised one, and the dashboard is a pure
observer that never starts it — so a human whose supervised daemon happens to be down (post
crash-gap, post-`SIGTERM` with `KeepAlive` off, fresh boot) gets a dashboard with nothing
running behind it and no nudge to fix that.

We want bare `junco` to be the single "do the right thing" entry point: make sure the
supervised daemon is up, then drop the user into the dashboard.

## Requirements (settled in brainstorming)

1. **Bare `junco` only** gets the smart pre-flight. Both escape hatches stay intact:
   `junco start` is still the explicit foreground daemon; `junco dashboard` is still the
   explicit **pure observer** that touches no daemon (the "just show me the panel" path).
2. **Never spawn an unsupervised background daemon.** Bringing the daemon up means asking
   the service manager (launchd/systemd) to (re)start the installed unit — matching the
   supervised model. If no unit is installed, inform and continue; do not fork a detached
   `junco start`.
3. **Blocking wait** after a kickstart: block up to a ceiling (~5s) for the lock to appear
   so the panel opens already-green in the common case, then open regardless.
4. **Graceful, never fatal.** A kickstart failure, a missing unit, or a slow start all fall
   through to opening the dashboard (which already surfaces live daemon state).
5. **Interactive only.** The auto-start fires only on an interactive TTY; non-TTY bare
   `junco` falls through to the dashboard's existing non-TTY refusal — no daemon is started
   in pipes/CI.
6. **No config → unchanged:** bare `junco` with no config still routes to the dashboard
   FTUE walkthrough with no pre-flight (there is no daemon to start yet).

## Behavior

| State at launch                     | Result                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| No config yet                       | Dashboard FTUE walkthrough (unchanged)                                        |
| Config, daemon already running      | Straight to the dashboard (no-op pre-flight)                                  |
| Config, daemon down, unit installed | Kickstart the unit, block ≤5s for the lock, then dashboard                    |
| Config, daemon down, no unit        | Print "no supervised daemon — run `junco service`", open dashboard (observer) |
| Non-TTY bare `junco`                | No pre-flight; dashboard's existing non-TTY refusal fires                     |

The dashboard already tracks daemon liveness (`src/tui/queueSnapshot.ts` computes `daemonUp`
from a `/health` probe every ~3s, with a dedicated "daemon" local section), so no new banner
is needed — its live indicator reflects whatever the pre-flight achieved and keeps updating.

## Architecture

### `src/ensureDaemon.ts` (new)

`ensureDaemon(cfg, configPath, deps): Promise<EnsureResult>` where

```
EnsureResult =
  | { state: "running";      pid: number }   // lock already held — nothing done
  | { state: "started";      pid: number }   // unit kickstarted, lock appeared
  | { state: "start-failed"; ref: ServiceRef } // unit found, kickstart ran, lock never came
  | { state: "no-service" }                  // no unit references this config
```

Logic:

1. `lockHolderFn(lockPath)` (default `readLockHolder`, the same check `status`/`restart`
   use). Alive → `{ running, pid }`. `lockPath` is derived exactly as elsewhere:
   `join(dirname(resolve(configPath)), "worker.lock")`.
2. Else `discoverServiceFn(configPath)` (default `discoverService` from `restartCmd.ts`).
   `null` → `{ no-service }`.
3. Else `kickstartFn(ref)` (the launchctl/systemd relaunch factored out of
   `runRestartCommand` — see below), then poll `lockHolderFn` up to ceiling (default 5000ms,
   250ms interval via injected `sleepFn`). Lock appears → `{ started, pid }`; ceiling
   reached → `{ start-failed, ref }`.

All collaborators injected (`lockHolderFn`, `discoverServiceFn`, `kickstartFn`, `sleepFn`,
`printFn`, `waitMs`, `pollMs`), so tests never touch launchctl or a real lock/pidfile. The
function emits one human line per outcome via `printFn` (e.g. `daemon already running (pid
N)`, `starting daemon via launchd…` / `daemon up (pid N)`, `daemon did not come up in Ns —
opening dashboard anyway`, `no supervised daemon installed — run 'junco service' to install
one`). It is quiet otherwise and never throws — a `kickstartFn`/`discoverServiceFn` rejection
is caught and mapped to `start-failed`/`no-service` respectively.

### `restartCmd.ts` refactor — extract `kickstartService`

`runRestartCommand` currently discovers the unit and relaunches it inline. Factor the
relaunch step into an exported `kickstartService(ref: ServiceRef, deps): Promise<{ code:
number; stderr: string }>` (`launchctl kickstart -k gui/<uid>/<label>` for launchd;
`systemctl --user restart <unit>` for systemd) so `ensureDaemon` and `runRestartCommand`
share one implementation. `runRestartCommand` keeps its own post-kickstart holder-changed
verification and messaging; `ensureDaemon` does its own lock-appears poll. No behavior change
to `restart`.

### `cli.ts` wiring

- Distinguish the bare invocation from an explicit subcommand: `const bare = positionals[0]
=== undefined`. The default subcommand becomes `"dashboard"` unconditionally (replacing the
  `existsFn(configPath) ? "start" : "dashboard"` ternary at cli.ts:331).
- New injectable `ensureDaemonFn` on `CliDeps` (default wires to the real `ensureDaemon`).
- In the `dashboard` branch, **only when `bare` and a config exists and stdout+stdin are
  TTYs**, `await ensureDaemonFn(cfg, configPath)` before `runDashboardFn(cfg, configPath)`.
  Explicit `junco dashboard`, the no-config FTUE path, and non-TTY all skip the pre-flight.
- Update the file header comment (cli.ts:6-10) and the USAGE bare-invocation note
  (cli.ts:204-205) to describe the new behavior. Drop the now-unused first-run ternary
  rationale.

### Docs

- `README.md` / `ARCHITECTURE.md`: wherever bare-invocation behavior is documented, update
  to "bare `junco` ensures the supervised daemon is up, then opens the dashboard; `junco
start` is the explicit foreground daemon; `junco dashboard` is the pure observer."

## Edge cases

- **Kickstart throws / launchctl non-zero:** caught → `start-failed`, warn, open dashboard.
- **Multiple units match the config:** `discoverService` already picks the first and warns —
  inherited unchanged.
- **Lock slow to appear:** ceiling hit → open dashboard; its live `daemonUp` catches up.
- **Config present but user does not want a daemon on this machine:** they use `junco
dashboard` explicitly (the observer escape hatch) — bare `junco` honoring the request to
  auto-start is the intended behavior.
- **`KeepAlive` off after a graceful stop:** `kickstart -k` relaunches unconditionally, which
  is exactly the documented reason `restart` exists — the down-unit case is a plain start.

## Testing

- `ensureDaemon.test.ts` (injected deps, no real launchctl/lock): the four branches —
  running (lock held, no discover/kickstart calls); down+unit→lock appears mid-poll →
  `started`; down+unit→lock never appears → `start-failed` after the ceiling; down+no-unit →
  `no-service`. Plus: `kickstartFn` rejection → `start-failed` (never throws); `printFn`
  lines asserted per outcome; poll respects injected `waitMs`/`pollMs` (fake `sleepFn`).
- `restartCmd.test.ts`: `runRestartCommand` behavior unchanged after the `kickstartService`
  extraction (existing suite is the guard); a direct `kickstartService` test pins the
  launchd/systemd command shapes via the exec fake.
- `cli.test.ts`: bare `junco` + config + TTY calls `ensureDaemonFn` **then** `runDashboardFn`
  (order asserted); explicit `["dashboard"]` does **not** call `ensureDaemonFn`; bare + no
  config → FTUE (`runDashboardFn(null, …)`, no `ensureDaemonFn`); bare + non-TTY skips
  `ensureDaemonFn` and hits the non-TTY refusal. TTY is injected (the existing `isTTY`/
  `existsFn` dep pattern) so tests are deterministic.

## Out of scope

Spawning a detached/unsupervised `junco start` (rejected in brainstorming); auto-installing a
service unit from the pre-flight; any change to `junco start`, `junco restart`, or `junco
dashboard`'s own behavior; a new in-TUI daemon-status banner (the existing `daemonUp`
indicator already covers it); changing the daemon lifecycle or the launchd/systemd unit
contract.
