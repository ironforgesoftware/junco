# `junco restart` — Restart the Supervised Daemon

- **Date:** 2026-07-06 · **Status:** Approved · **Branch:** `feat/restart-cmd` (off `feat/dashboard`)

## Motivation

The daemon loads config and `dist/` once at startup; promoting changes means bouncing
the service. Today that requires knowing your supervisor's label and the right verb —
which is subtle: a `KeepAlive.SuccessfulExit=false` launchd job is NOT respawned after
a graceful SIGTERM, so the naive "kill it" leaves the daemon down. `junco restart`
encapsulates the correct primitive per platform.

## Decisions

| Decision         | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery        | **By config path, not by name**: the unit whose invocation references the resolved `--config` path. launchd: scan `~/Library/LaunchAgents/*.plist` (parsed via `plutil -convert json`, zero new deps), match `ProgramArguments`. systemd: user units matching `junco*`, match `ExecStart` on the config path; a single `junco*` unit wins when no path match. Finds custom labels (e.g. `com.edelweiss.junco-worker`) and the `junco service`-rendered defaults alike. |
| Restart verb     | launchd: `launchctl kickstart -k gui/<uid>/<label>` (kill-and-relaunch regardless of KeepAlive semantics; launchd's TERM→KILL sequence preserves the daemon's graceful-stop window). systemd: `systemctl --user restart <unit>`.                                                                                                                                                                                                                                       |
| Verification     | Read the old pid from `worker.lock` (next to the config), poll up to 15s for a **different** live holder; report `restarted: pid <old> → <new>`. Timeout → warn + exit 1 (the kick was issued; the daemon may still be draining a ticket).                                                                                                                                                                                                                             |
| No service found | Exit 1 with guidance: render one with `junco service`, or note that an unsupervised daemon can only be stopped, not restarted.                                                                                                                                                                                                                                                                                                                                         |
| Rebuild          | **Not included** — published installs have nothing to build. The repo gains a dev npm script `"daemon:restart": "npm run build && junco restart"` (generic, shippable).                                                                                                                                                                                                                                                                                                |
| Seams            | `RestartDeps { execFn, readdirFn, homedirFn, platform, uid, lockHolderFn, sleepFn, printFn }` — tests use fixture plists + fake exec; no real launchctl/systemctl ever runs in tests.                                                                                                                                                                                                                                                                                  |

## Modules

- `src/restartCmd.ts` — `discoverService(configPath, deps): Promise<ServiceRef | null>`
  (`ServiceRef = { platform: "launchd" | "systemd"; id: string }`) and
  `runRestartCommand(configPath, deps): Promise<number>`.
- `src/cli.ts` — `restart` subcommand + `CliDeps.runRestartFn` seam + USAGE line.
- Docs: README CLI table + service section note; CHANGELOG.

## Error handling

| Failure                       | Behavior                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| No unit references the config | Guidance + exit 1                                                          |
| Multiple launchd matches      | First match wins, others listed in a warn line                             |
| `plutil`/unreadable plist     | Skip that file, keep scanning                                              |
| kickstart/systemctl non-zero  | Surface stderr + exit 1                                                    |
| Lock never changes within 15s | Warn ("kick issued; daemon may be draining — check junco status") + exit 1 |

## Testing

Unit tests with fixture plists in a tmp LaunchAgents dir (fake `plutil` via `execFn`):
discovery by config path among decoys; no-match guidance; kickstart target string;
pid-change success; same-pid timeout; systemd unit match; CLI routing via the seam.
