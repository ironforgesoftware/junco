# Update notification + `junco update` — design

**Date:** 2026-07-16
**Status:** approved (brainstormed + design approval in session)

## 1. Summary

Junco has no way to tell an operator that a newer version exists on npm, no
`--version` flag, and no update path short of remembering the
`npm install -g` incantation. This design adds a **best-effort update check**
(CLI/TUI-side, cached on disk, silent on failure), surfaces it as a **dashboard
header chip**, a **`junco status` line**, and a **`junco doctor` report row**,
and adds a **`junco update` command** that installs the latest version and —
when a service-managed daemon is running — restarts it through the existing
drain-and-kickstart path so in-flight tickets finish before the swap.

The daemon itself is untouched: the check runs only where a human is looking
(TUI, `status`, `doctor`), so there is no new network egress from the daemon
and no health-payload schema change. No network → no badge; the feature
degrades to exactly today's behavior.

## 2. Goals

- Operators learn about a newer published version passively, in the dashboard
  header and in `status`/`doctor` output.
- One command (`junco update`) performs the update end-to-end: install,
  graceful daemon restart (drain first), verify.
- The check is best-effort and quiet: offline, slow, or garbage registry
  responses never produce errors, delays past a hard 2s cap, or false badges.
- The mechanism is fork-friendly and stack-agnostic: package name and current
  version are read from junco's own `package.json`, never hardcoded.
- Opt-out available (`updateCheck: false`) for operators who do not want any
  phone-home.

## 3. Non-goals

- Auto-update. The daemon never updates or restarts itself.
- Download-count display or any other npm stats in the product.
- Update support for non-npm installs (source checkouts get guidance, not an
  install).
- Prerelease/dist-tag awareness. Junco publishes plain `X.Y.Z` to `latest`;
  anything unparseable is treated as "no update".

## 4. Core module: `src/updateCheck.ts`

Pure module, every side effect behind an injectable `UpdateCheckDeps` seam
(`fetchFn`, `readFileFn`, `writeFileFn`, `renameFn`, `nowFn`, `selfPkgFn`).

### 4.1 `getOwnVersion()` / `getOwnPackageName()`

Read `new URL("../package.json", import.meta.url)` — resolves to the repo root
from `src/` (vitest) and to the package root from `dist/` (installed CLI).
Returns `{ name, version }`. Also powers the new `junco --version` flag
(section 6.4).

### 4.2 `compareVersions(a, b): -1 | 0 | 1 | null`

Numeric triple compare over `X.Y.Z`. Returns `null` when either side fails to
parse (leading `v` tolerated, anything else → `null`). `null` propagates as
"no update available" — never a badge on garbage.

### 4.3 `checkForUpdate(cfg, deps): Promise<UpdateInfo | null>`

```ts
interface UpdateInfo {
  current: string; // running version
  latest: string; // newest on the registry (possibly from cache)
  available: boolean; // compareVersions(latest, current) === 1
}
```

Algorithm:

1. If `cfg.updateCheck === false`, return `null` immediately.
2. Read the cache file (section 5). Cache stores **only**
   `{ latest?, checkedAt?, lastAttempt? }` (all optional — a first-ever failed
   check writes just `lastAttempt`) — `available` is always recomputed
   against the _running_ version, so the badge clears the instant the operator
   is actually updated, with no cache-expiry wait.
3. Cache fresh (`now - checkedAt < 24h`) → return cached `latest` compared to
   current. No network.
4. Cache stale/missing and `now - lastAttempt < 1h` → serve stale cache if
   present, else `null`. (Failure backoff: offline machines retry at most
   hourly.)
5. Otherwise fetch `https://registry.npmjs.org/<name>/latest` with
   `AbortSignal.timeout(2000)`, parse `.version`. On success, write the cache
   atomically (tmp file + rename, same dir) and return. On any failure
   (network, non-2xx, bad JSON), stamp `lastAttempt` in the cache and serve
   the stale `latest` if present, else `null`. **Never throws.**

`forceFresh: true` (used by `junco update`) skips steps 3–4.

## 5. Cache placement and dataTree registration

Single file `update-check.json` at the data root. Full dataTree checklist
(post-#194 discipline):

- `UPDATE_CHECK_FILENAME` constant in `src/dataTree.ts`.
- Entry in `DataTreePaths` + `dataTreePaths()`.
- Added to `sandboxDenyPaths().files` — agents have no business reading or
  writing runtime state.
- Listed by `junco data` (annotated, shown even when absent, like
  `watchlist.json`).
- No `ensureDataTree` change: the file is created lazily by the first
  successful check; the data root itself already exists.

## 6. Surfaces

### 6.1 Config lever

Optional `updateCheck?: boolean` (JSON, camelCase per schema convention) / `updateCheck?: boolean` (Config),
default `true`. Optional-with-default → no test-fixture sweep. The daemon
never reads it (it never checks), so it is neither a hot-reload lever nor a
frozen-restart field — `configLevers.ts` and `overlayFrozenRestartFields` are
untouched. Documented in the config reference as the phone-home opt-out.

### 6.2 TUI dashboard

- `App`-level effect: `checkForUpdate` fires async after first mount (never
  blocks first paint) and re-fires on a 24h interval while the TUI stays open.
  Result lands in state and flows to `Chrome` as an optional prop.
- `Chrome.tsx` header chip, joining the existing `watchlist!` / `● review` /
  `⚑ PR` chip row: `⬆ v0.8.0` in `theme.accent`. Hidden when `null` /
  not-available / narrow-width (drops with the other bridge chips).
- `HelpModal` gains one line naming `junco update` when an update is known to
  be available.
- Known skew, accepted: after `junco update` restarts the daemon, an
  already-open TUI still runs old code and keeps its chip until relaunched.

### 6.3 `junco status` and `junco doctor`

- `status`: one line, printed only when an update is available:
  `update: v0.8.0 available (run: junco update)`.
- `doctor`: always reports. `ok junco v0.7.0 (latest)` / warn
  `junco v0.7.0 — v0.8.0 available (run: junco update)` / skip
  `update check skipped (offline or disabled)`.

### 6.4 `junco --version`

Prints `getOwnVersion()`. Freebie now that the plumbing exists; also what
`junco update` execs post-install to verify.

## 7. `junco update` — `src/updateCmd.ts`

Deps seam: `execFn`, `lockHolderFn` (reuse `readLockHolder`), restart
machinery imported from `restartCmd.ts` (service discovery by config path +
kickstart), plus the `updateCheck` module.

Sequence:

1. **Source-checkout guard.** If `.git` exists at the package root (the
   directory holding our own `package.json`), refuse:
   `running from a source checkout — update with: git pull && npm run build`.
   Covers the maintainer's live checkout and dev clones.
2. **Fresh check** (`forceFresh`). Not available → `already up to date
(v0.7.0)`, exit 0. Check itself failed → error out (an update command may
   be loud, unlike the passive check), exit 1.
3. **Install.** `npm install -g <name>@latest` via `execFn`, npm resolved from
   `PATH`, stdout/stderr streamed through. Non-zero exit → surface npm's
   output, exit 1, **daemon untouched** (install strictly precedes restart).
4. **Restart, only if warranted.** Daemon lock held →
   - service unit found (launchd/systemd, discovered by config path): reuse
     `restartCmd`'s kickstart path. This is the drain-then-restart semantics:
     TERM-first window → `stopFlag.requested` → in-flight ticket runs to
     completion → relaunch on new code.
   - no unit (foreground `junco start`): print
     `daemon running outside a service manager — restart it manually`.
     No lock → skip silently.
5. **Verify.** Exec `junco --version` from `PATH` (the freshly installed
   binary — the running process is still old code) and print
   `updated v0.7.0 → v0.8.0`. Verification failure is a warning, not a
   rollback.

## 8. Error handling summary

| Failure                        | Behavior                                                  |
| ------------------------------ | --------------------------------------------------------- |
| Registry unreachable / timeout | Passive check: stale cache or silence; `doctor`: skip row |
| Registry garbage / bad semver  | Treated as no update, never a badge                       |
| Cache unreadable/corrupt       | Treated as missing; next check rewrites it                |
| `npm install -g` fails         | stderr surfaced, exit 1, no restart                       |
| Restart discovery fails        | Install kept; manual-restart guidance printed             |
| Post-install verify fails      | Warning only; install already succeeded                   |

The passive check can never delay TUI first paint (async post-mount) and can
never hold `status`/`doctor` past the 2s fetch cap.

## 9. Testing

- `updateCheck.test.ts`: compare table (incl. `null` cases); fake
  fetch/fs/clock through the deps seam — fresh cache short-circuits network,
  stale triggers fetch + atomic rewrite, offline serves stale, offline+bare
  returns null, failure stamps `lastAttempt` and backs off for 1h,
  `update_check: false` short-circuits, `forceFresh` bypasses cache.
- `updateCmd.test.ts`: recording `execFn` — source-checkout refusal (no exec
  calls at all), up-to-date exits 0 pre-install, install failure aborts before
  restart, lock-held + unit found → kickstart invoked, lock-held + no unit →
  guidance, no lock → no restart, verify output shape.
- `dataTree.test.ts`: `update-check.json` present in paths, sandbox-deny
  files, and `junco data` output.
- TUI: chip renders when `UpdateInfo.available` (ink-testing-library,
  loop-until-condition — never a fixed-tick assert), hidden when null/current.
- `doctor`/`status`: line presence/absence with a fake checker injected.
- No required `Config` field → no `makeConfig` fixture sweep; `updateCheck` is
  optional.

## 10. Rollout

Single PR (`feat/update-notification`). Additive only: no ticket-schema
change, no health-payload change, no daemon behavior change. Docs touched:
config reference (`update_check`), README command table (`update`,
`--version`), CHANGELOG under Unreleased.
