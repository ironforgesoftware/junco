# `junco restart` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline — 2 tasks). Checkbox steps.

**Goal:** `junco restart` discovers the service unit supervising the daemon for the resolved config and restarts it with the platform-correct verb, verifying the pid changed. Spec: `docs/superpowers/specs/2026-07-06-junco-restart-design.md`.

**Architecture:** One new module `src/restartCmd.ts` (discovery + restart + verify, all behind `RestartDeps`), a `restart` case in `cli.ts` with a `runRestartFn` seam, a dev npm script, docs.

**Tech Stack:** TS strict/ESM; `plutil` for plist→JSON (zero new deps); vitest with fixture plists.

## Global Constraints

- No new dependencies; stack-agnostic shipped text; no AI attribution; vitest exit-code discipline (`> /tmp/out 2>&1; echo "exit: $?"`); prettier before commit; suite green per commit; never run junco start/dashboard/restart against the live config from tests.

---

### Task 1: `src/restartCmd.ts` — discovery, restart, verification

**Files:** Create `src/restartCmd.ts`; Test `tests/restartCmd.test.ts`.

**Interfaces (produced):**

```ts
export interface ServiceRef {
  platform: "launchd" | "systemd";
  id: string;
}
export interface RestartDeps {
  execFn?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  readdirFn?: (dir: string) => string[]; // [] on missing dir
  homedirFn?: () => string;
  platform?: NodeJS.Platform;
  uid?: number;
  lockHolderFn?: (lockPath: string) => number | null;
  sleepFn?: (ms: number) => Promise<void>;
  printFn?: (s: string) => void;
  timeoutMs?: number; // default 15_000
}
export async function discoverService(
  configPath: string,
  deps?: RestartDeps,
): Promise<ServiceRef | null>;
export async function runRestartCommand(configPath: string, deps?: RestartDeps): Promise<number>;
```

Behavior: launchd discovery = for each `~/Library/LaunchAgents/*.plist`, `plutil -convert json -o - <file>` → JSON `{Label, ProgramArguments}`; match when `ProgramArguments` includes the RESOLVED config path; unreadable/unparseable → skip. Multiple matches → first wins + warn listing the rest. systemd discovery = `systemctl --user list-unit-files --no-legend --plain "junco*"` → unit names; for each, `systemctl --user cat <unit>` and match `ExecStart` containing the config path; no path match but exactly one junco unit → use it. Restart = `launchctl kickstart -k gui/<uid>/<label>` / `systemctl --user restart <unit>`; non-zero → print stderr, exit 1. Verify = old pid via `lockHolderFn(dirname(config)/worker.lock)`; poll every 500ms up to `timeoutMs` for a live holder `!== oldPid` (old `null` → any pid); success prints `restarted: pid <old ?? "—"> → <new>`; timeout prints the drain warning, exit 1.

- [ ] Step 1: failing tests (fixture plists via tmp dir; fake execFn dispatches on `cmd`+argv: `plutil` returns canned JSON per file path, `launchctl` records, `systemctl` canned; `lockHolderFn` scripted sequence old→old→new; `sleepFn` instant-but-tick `await new Promise(r => setTimeout(r, 1))`). Cases: (1) finds the plist whose ProgramArguments contain the config path among two decoys, returns `{platform:"launchd", id:<Label>}`; (2) no match → `runRestartCommand` prints guidance containing "junco service" and returns 1 with no launchctl call; (3) kickstart invoked as `["kickstart","-k","gui/501/<label>"]` (uid injected 501); (4) success path prints `restarted: pid 100 → 200`, returns 0; (5) pid never changes → returns 1, prints drain warning; (6) linux platform: unit `junco.service` matched via ExecStart, `systemctl --user restart junco.service` invoked; (7) unreadable plist skipped (plutil code 1) while a later one matches.
- [ ] Step 2: verify FAIL. Step 3: implement per the interfaces above. Step 4: focused + full suite green.
- [ ] Step 5: commit `feat(restart): discover + kick the supervising service unit (launchd/systemd)`.

### Task 2: CLI wiring + npm script + docs

**Files:** Modify `src/cli.ts` (USAGE + `CliDeps.runRestartFn` + case), `package.json` (scripts: `"daemon:restart": "npm run build && junco restart"`), README (CLI table row + a sentence in Running as a service), CHANGELOG (Unreleased→Added); Test `tests/cli.test.ts`.

- [ ] Step 1: failing cli routing test — `run(["restart","--config","/x/config.toml"], { loadConfigFn: ..., runRestartFn: spy → 0 })` returns 0 and the spy received the RESOLVED config path (mirror the dashboard-case test shape; note the seam passes configPath, not cfg — restart needs the path for lock/plist matching; loadConfig is still called first so a broken config fails fast with a clear error).
- [ ] Step 2: FAIL. Step 3: implement — case loads config (fail-fast validation only), then `const runRestartFn = deps.runRestartFn ?? (async (p) => (await import("./restartCmd.js")).runRestartCommand(p));` USAGE line: `restart      Restart the supervised daemon (picks up config + code changes)`.
- [ ] Step 4: full gate. Step 5: commit `feat(cli): junco restart subcommand + daemon:restart dev script + docs`.
