# Bare `junco` Ensures the Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bare `junco` (no subcommand) ensure the supervised daemon is running, then open the dashboard — one command that "does the right thing."

**Architecture:** A new `src/ensureDaemon.ts` checks the singleton lock; if the daemon is down and a launchd/systemd unit references this config, it kickstarts that unit and blocks briefly for the lock to appear, then returns a discriminated result. `src/cli.ts` calls it only on the **bare** interactive path before handing off to the existing dashboard; explicit `junco dashboard` and `junco start` are untouched. The launchctl/systemd relaunch step is factored out of `restartCmd.ts` into a shared `kickstartService` so both call sites use one implementation.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), vitest, dependency-injection `*Deps` seams (no real launchctl/lock/fs in unit tests).

## Global Constraints

- Node ≥ 22.19, ESM/NodeNext, strict TypeScript. `.js` import specifiers for local modules.
- Every side effect behind an injectable `deps` seam; unit tests never touch launchctl, a real lock, or the network.
- Never import the Pi SDK at module top level (not relevant here — no SDK use).
- `src/ticketSchema.ts` is a frozen contract — untouched by this work.
- No AI attribution in commits (no `Co-Authored-By: Claude`, no "Generated with" lines).
- Prettier 100-col; re-read a file before editing (prettier may reformat between read and edit); `npx prettier --write` touched files before committing.
- Full gate before "done": `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- **Escape hatches are load-bearing:** `junco start` stays the explicit foreground daemon; `junco dashboard` stays a pure observer that starts nothing. Only bare `junco` gets the pre-flight.

---

### Task 1: Extract `kickstartService` from `restartCmd.ts`

Behavior-preserving refactor: pull the launchctl/systemd relaunch out of `runRestartCommand` so `ensureDaemon` (Task 2) can reuse it. The existing `restart` suite is the guard that behavior is unchanged.

**Files:**

- Modify: `src/restartCmd.ts` (add exported `kickstartService`; replace the inline kick in `runRestartCommand`, currently `src/restartCmd.ts:145-157`)
- Test: `tests/restartCmd.test.ts` (add a `kickstartService` describe)

**Interfaces:**

- Produces: `export function kickstartService(svc: ServiceRef, deps?: RestartDeps): Promise<{ code: number; stdout: string; stderr: string }>` — launchd → `launchctl kickstart -k gui/<uid>/<label>`; systemd → `systemctl --user --no-block restart <unit>`. `ServiceRef` and `RestartDeps` are already exported from `src/restartCmd.ts`.

- [ ] **Step 1: Write the failing test**

Add to `tests/restartCmd.test.ts` (import `kickstartService` — update the top import on line 2 to `import { discoverService, kickstartService, runRestartCommand, type RestartDeps, type ServiceRef } from "../src/restartCmd.js";`):

```typescript
describe("kickstartService", () => {
  it("launchd → launchctl kickstart -k gui/<uid>/<label>", async () => {
    const calls: string[][] = [];
    const deps: RestartDeps = {
      uid: 501,
      execFn: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const svc: ServiceRef = { platform: "launchd", id: "com.edelweiss.junco-worker" };
    const r = await kickstartService(svc, deps);
    expect(r.code).toBe(0);
    expect(calls).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.edelweiss.junco-worker"]]);
  });

  it("systemd → systemctl --user --no-block restart <unit>", async () => {
    const calls: string[][] = [];
    const deps: RestartDeps = {
      execFn: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const svc: ServiceRef = { platform: "systemd", id: "junco.service" };
    await kickstartService(svc, deps);
    expect(calls).toEqual([["systemctl", "--user", "--no-block", "restart", "junco.service"]]);
  });

  it("propagates a non-zero exit + stderr", async () => {
    const deps: RestartDeps = {
      execFn: async () => ({ code: 1, stdout: "", stderr: "kick boom" }),
    };
    const r = await kickstartService({ platform: "launchd", id: "x" }, deps);
    expect(r).toMatchObject({ code: 1, stderr: "kick boom" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/restartCmd.test.ts -t kickstartService > /tmp/t1.txt 2>&1; echo "exit: $?"`
Expected: FAIL — `kickstartService` is not exported (`SyntaxError`/import error).

- [ ] **Step 3: Add `kickstartService` and call it from `runRestartCommand`**

In `src/restartCmd.ts`, add the new exported function immediately **above** `runRestartCommand` (i.e. before the `/** Restart the discovered unit... */` comment at line 119):

```typescript
/**
 * Relaunch a discovered service unit unconditionally. `launchctl kickstart -k`
 * and `systemctl --user restart` both start a stopped unit and restart a running
 * one, so this doubles as "ensure up" for a down daemon. Shared by
 * runRestartCommand and ensureDaemon so the platform command shapes live in one place.
 *
 * systemd `--no-block` returns as soon as the restart job is ENQUEUED instead of
 * waiting out the unit's TimeoutStopSec (sized to the ticket timeout, potentially
 * minutes) — which would outlive defaultExec's 15s budget, get killed
 * (err.code=null → exit 1), and be misreported as a failed restart. The caller's
 * lock poll is what actually confirms the relaunch. (#117)
 */
export function kickstartService(
  svc: ServiceRef,
  deps: RestartDeps = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const execFn = deps.execFn ?? defaultExec;
  return svc.platform === "launchd"
    ? execFn("launchctl", [
        "kickstart",
        "-k",
        `gui/${deps.uid ?? process.getuid?.() ?? 0}/${svc.id}`,
      ])
    : execFn("systemctl", ["--user", "--no-block", "restart", svc.id]);
}
```

Then in `runRestartCommand`, replace the inline kick block (current `src/restartCmd.ts:145-157`, the `const kick = svc.platform === "launchd" ? await execFn(...) : ... await execFn("systemctl", ...);` expression **and** its inline `--no-block` comment) with:

```typescript
const kick = await kickstartService(svc, deps);
```

Leave the surrounding `const oldPid = ...`, the `if (kick.code !== 0)` handling, and the poll loop exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/restartCmd.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"`
Expected: PASS — the new `kickstartService` describe **and** every pre-existing `runRestartCommand`/`discoverService` test green (proves the refactor changed no behavior).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/restartCmd.ts tests/restartCmd.test.ts
git add src/restartCmd.ts tests/restartCmd.test.ts
git commit -m "refactor(restart): extract kickstartService for reuse by ensureDaemon"
```

---

### Task 2: `src/ensureDaemon.ts`

The core: check the lock; if down, discover the unit, kickstart it, and block up to a ceiling for the lock to appear. Fully injectable — no real launchctl/lock in tests.

**Files:**

- Create: `src/ensureDaemon.ts`
- Test: `tests/ensureDaemon.test.ts`

**Interfaces:**

- Consumes: `readLockHolder` (`src/lock.ts`), `discoverService` + `kickstartService` + `ServiceRef` (`src/restartCmd.ts`, the latter from Task 1).
- Produces:

  ```typescript
  export type EnsureResult =
    | { state: "running"; pid: number }
    | { state: "started"; pid: number }
    | { state: "start-failed"; ref: ServiceRef }
    | { state: "no-service" };
  export function ensureDaemon(configPath: string, deps?: EnsureDaemonDeps): Promise<EnsureResult>;
  ```

  (No `cfg` param — everything derives from `configPath`.)

- [ ] **Step 1: Write the failing test**

Create `tests/ensureDaemon.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ensureDaemon, type EnsureDaemonDeps } from "../src/ensureDaemon.js";
import type { ServiceRef } from "../src/restartCmd.js";

const CONFIG = "/Users/u/junco/config.json";
const SVC: ServiceRef = { platform: "launchd", id: "com.edelweiss.junco-worker" };

/** Base deps: no real launchctl/lock, instant sleep, captured prints. */
function base(over: Partial<EnsureDaemonDeps> = {}): {
  deps: EnsureDaemonDeps;
  prints: string[];
  kick: ReturnType<typeof vi.fn>;
} {
  const prints: string[] = [];
  const kick = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const deps: EnsureDaemonDeps = {
    lockHolderFn: () => null,
    discoverServiceFn: async () => SVC,
    kickstartFn: kick,
    sleepFn: async () => {},
    printFn: (s) => prints.push(s),
    waitMs: 1000,
    pollMs: 250,
    ...over,
  };
  return { deps, prints, kick };
}

describe("ensureDaemon", () => {
  it("running: lock already held → no discover/kickstart", async () => {
    const discover = vi.fn(async () => SVC);
    const { deps, kick } = base({ lockHolderFn: () => 4242, discoverServiceFn: discover });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "running", pid: 4242 });
    expect(discover).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it("started: down + unit → kickstart, lock appears on a later poll", async () => {
    // null (initial), null (poll 1), then 999 (poll 2)
    const seq = [null, null, 999] as (number | null)[];
    const { deps, kick } = base({ lockHolderFn: () => (seq.length > 1 ? seq.shift()! : seq[0]) });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "started", pid: 999 });
    expect(kick).toHaveBeenCalledWith(SVC);
  });

  it("start-failed: down + unit → kickstart, lock never appears within the ceiling", async () => {
    const { deps } = base({ lockHolderFn: () => null, waitMs: 500, pollMs: 250 });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "start-failed", ref: SVC });
  });

  it("start-failed: kickstart returns non-zero", async () => {
    const { deps } = base({ kickstartFn: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "start-failed", ref: SVC });
  });

  it("start-failed: kickstart rejects (never throws out of ensureDaemon)", async () => {
    const { deps } = base({
      kickstartFn: async () => {
        throw new Error("launchctl exploded");
      },
    });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "start-failed", ref: SVC });
  });

  it("no-service: no unit references this config", async () => {
    const { deps, kick } = base({ discoverServiceFn: async () => null });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "no-service" });
    expect(kick).not.toHaveBeenCalled();
  });

  it("no-service: discover rejects → mapped, never throws", async () => {
    const { deps } = base({
      discoverServiceFn: async () => {
        throw new Error("plutil exploded");
      },
    });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "no-service" });
  });

  it("prints the 'no supervised daemon' guidance on no-service", async () => {
    const { deps, prints } = base({ discoverServiceFn: async () => null });
    await ensureDaemon(CONFIG, deps);
    expect(prints.join("")).toMatch(/junco service/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ensureDaemon.test.ts > /tmp/t2.txt 2>&1; echo "exit: $?"`
Expected: FAIL — `../src/ensureDaemon.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/ensureDaemon.ts`:

```typescript
/**
 * `junco` (bare, interactive) pre-flight: make sure the supervised daemon is up
 * before the dashboard opens. Checks the singleton lock; if the daemon is down
 * and a launchd/systemd unit references this config, kickstarts the unit and
 * blocks up to a short ceiling for the lock to appear. Never spawns an
 * unsupervised daemon, and never throws — every failure degrades to a result the
 * caller opens the dashboard on top of (the dashboard surfaces live daemon state
 * regardless). See docs/superpowers/specs/2026-07-16-bare-junco-ensure-daemon-design.md.
 */

import { join, dirname, resolve } from "node:path";
import { readLockHolder } from "./lock.js";
import { discoverService, kickstartService, type ServiceRef } from "./restartCmd.js";

export type EnsureResult =
  | { state: "running"; pid: number }
  | { state: "started"; pid: number }
  | { state: "start-failed"; ref: ServiceRef }
  | { state: "no-service" };

export interface EnsureDaemonDeps {
  /** Live lock holder (pid) or null. Default: readLockHolder. */
  lockHolderFn?: (lockPath: string) => number | null;
  /** Find the unit referencing configPath, or null. Default: discoverService. */
  discoverServiceFn?: (configPath: string) => Promise<ServiceRef | null>;
  /** Relaunch the unit. Default: kickstartService. */
  kickstartFn?: (svc: ServiceRef) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Sleep between polls. Default: real setTimeout. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Status line sink. Default: process.stdout.write. */
  printFn?: (s: string) => void;
  /** Ceiling to wait for the lock after a kickstart. Default: 5000ms. */
  waitMs?: number;
  /** Poll interval. Default: 250ms. */
  pollMs?: number;
}

export async function ensureDaemon(
  configPath: string,
  deps: EnsureDaemonDeps = {},
): Promise<EnsureResult> {
  const lockHolderFn = deps.lockHolderFn ?? readLockHolder;
  const discoverServiceFn = deps.discoverServiceFn ?? ((p: string) => discoverService(p));
  const kickstartFn = deps.kickstartFn ?? ((svc: ServiceRef) => kickstartService(svc));
  const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const waitMs = deps.waitMs ?? 5000;
  const pollMs = deps.pollMs ?? 250;

  const lockPath = join(dirname(resolve(configPath)), "worker.lock");

  const existing = lockHolderFn(lockPath);
  if (existing !== null) {
    print(`daemon already running (pid ${existing})\n`);
    return { state: "running", pid: existing };
  }

  let svc: ServiceRef | null;
  try {
    svc = await discoverServiceFn(configPath);
  } catch {
    svc = null;
  }
  if (!svc) {
    print("no supervised daemon installed — run `junco service` to install one\n");
    return { state: "no-service" };
  }

  print(`daemon not running — starting via ${svc.platform}…\n`);
  try {
    const kick = await kickstartFn(svc);
    if (kick.code !== 0) {
      print(`could not start daemon (${svc.id}): ${kick.stderr.trim() || `exit ${kick.code}`}\n`);
      return { state: "start-failed", ref: svc };
    }
  } catch (e) {
    print(`could not start daemon (${svc.id}): ${e instanceof Error ? e.message : String(e)}\n`);
    return { state: "start-failed", ref: svc };
  }

  // Poll a fixed number of times so the wait is deterministic under a fake sleep.
  const maxPolls = Math.max(1, Math.ceil(waitMs / pollMs));
  for (let i = 0; i < maxPolls; i++) {
    const pid = lockHolderFn(lockPath);
    if (pid !== null) {
      print(`daemon up (pid ${pid})\n`);
      return { state: "started", pid };
    }
    await sleepFn(pollMs);
  }
  print(`daemon did not come up within ${Math.round(waitMs / 1000)}s — opening dashboard anyway\n`);
  return { state: "start-failed", ref: svc };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ensureDaemon.test.ts > /tmp/t2.txt 2>&1; echo "exit: $?"`
Expected: PASS — all eight cases.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/ensureDaemon.ts tests/ensureDaemon.test.ts
git add src/ensureDaemon.ts tests/ensureDaemon.test.ts
git commit -m "feat(daemon): ensureDaemon pre-flight — start the supervised unit if down"
```

---

### Task 3: Wire the pre-flight into bare `junco` (cli.ts) + docs

Route bare `junco` to the dashboard always, and on the interactive bare-with-config path run `ensureDaemon` first. Explicit `dashboard`/`start` untouched. Update the stale header/USAGE/ARCHITECTURE claims.

**Files:**

- Modify: `src/cli.ts` (CliDeps additions; default-subcommand line at `src/cli.ts:331`; dashboard branch at `src/cli.ts:719-734`; header comment `src/cli.ts:6-10`; USAGE note `src/cli.ts:204-205`)
- Modify: `ARCHITECTURE.md:197` (the cli.ts row's bare-invocation sentence)
- Test: `tests/cli.test.ts` (rewrite the bare-invocation describe at `tests/cli.test.ts:400-414`; add explicit-dashboard and non-TTY cases)

**Interfaces:**

- Consumes: `ensureDaemon` / `EnsureResult` from `src/ensureDaemon.ts` (Task 2).
- Produces: two new optional `CliDeps` fields —

  ```typescript
  ensureDaemonFn?: (configPath: string) => Promise<import("./ensureDaemon.js").EnsureResult>;
  isTTYFn?: () => boolean;
  ```

- [ ] **Step 1: Write the failing tests**

In `tests/cli.test.ts`, add the `EnsureResult` type import near the top imports (after line 25):

```typescript
import type { EnsureResult } from "../src/ensureDaemon.js";
```

Replace the entire existing describe block `describe("run([]) — first-run aware bare invocation", ...)` (currently `tests/cli.test.ts:400-414`) with:

```typescript
describe("run([]) — bare invocation ensures the daemon, then dashboard", () => {
  it("ensures the daemon THEN opens the dashboard when a config exists (bare, TTY)", async () => {
    const { cfg } = freshDispatchVault();
    const ensure = vi.fn(async (): Promise<EnsureResult> => ({ state: "running", pid: 7 }));
    const dash = vi.fn(async () => 0);
    const deps = makeDeps({
      existsFn: () => true,
      isTTYFn: () => true,
      loadConfigFn: () => cfg,
      ensureDaemonFn: ensure,
      runDashboardFn: dash,
    });
    expect(await run([], deps)).toBe(0);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(dash).toHaveBeenCalledTimes(1);
    // ordering: ensured BEFORE the dashboard opened
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(dash.mock.invocationCallOrder[0]);
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });

  it("routes to the dashboard FTUE (no pre-flight) when no config exists", async () => {
    const ensure = vi.fn(async (): Promise<EnsureResult> => ({ state: "running", pid: 1 }));
    const dash = vi.fn(async () => 0);
    const deps = makeDeps({
      existsFn: () => false,
      isTTYFn: () => true,
      ensureDaemonFn: ensure,
      runDashboardFn: dash,
    });
    expect(await run([], deps)).toBe(0);
    expect(dash).toHaveBeenCalledWith(null, expect.any(String));
    expect(ensure).not.toHaveBeenCalled();
    expect(deps.mainLoopFn).not.toHaveBeenCalled();
  });

  it("bare + config but NON-TTY skips the pre-flight (no daemon started in pipes/CI)", async () => {
    const { cfg } = freshDispatchVault();
    const ensure = vi.fn(async (): Promise<EnsureResult> => ({ state: "running", pid: 1 }));
    const dash = vi.fn(async () => 0);
    const deps = makeDeps({
      existsFn: () => true,
      isTTYFn: () => false,
      loadConfigFn: () => cfg,
      ensureDaemonFn: ensure,
      runDashboardFn: dash,
    });
    expect(await run([], deps)).toBe(0);
    expect(ensure).not.toHaveBeenCalled();
    expect(dash).toHaveBeenCalledTimes(1);
  });

  it("explicit `dashboard` does NOT run the pre-flight (pure observer)", async () => {
    const { cfg } = freshDispatchVault();
    const ensure = vi.fn(async (): Promise<EnsureResult> => ({ state: "running", pid: 1 }));
    const dash = vi.fn(async () => 0);
    const deps = makeDeps({
      existsFn: () => true,
      isTTYFn: () => true,
      loadConfigFn: () => cfg,
      ensureDaemonFn: ensure,
      runDashboardFn: dash,
    });
    expect(await run(["dashboard"], deps)).toBe(0);
    expect(ensure).not.toHaveBeenCalled();
    expect(dash).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/cli.test.ts -t "ensures the daemon" > /tmp/t3.txt 2>&1; echo "exit: $?"`
Expected: FAIL — `isTTYFn`/`ensureDaemonFn` are not yet wired, so `ensure` is never called (assertion fails), and/or a TS build error on the unknown deps fields.

- [ ] **Step 3: Add the CliDeps fields**

In `src/cli.ts`, inside the `CliDeps` interface (after `maxQueuedTimeoutSecondsFn?`, near `src/cli.ts:130`), add:

```typescript
  /** Bare-invocation daemon pre-flight (bare `junco` on an interactive TTY only).
   *  Default: lazily imports ensureDaemon.js so every other subcommand stays off
   *  its (restartCmd → launchctl/systemd) require graph. */
  ensureDaemonFn?: (configPath: string) => Promise<import("./ensureDaemon.js").EnsureResult>;
  /** Interactivity probe gating the bare pre-flight. Default: stdout+stdin both TTY. */
  isTTYFn?: () => boolean;
```

- [ ] **Step 4: Change the default subcommand + detect bare**

In `src/cli.ts`, replace the default-subcommand line (`src/cli.ts:331`):

```typescript
const subcommand = positionals[0] ?? (existsFn(configPath) ? "start" : "dashboard");
```

with:

```typescript
// Bare `junco` (no explicit subcommand) always heads to the dashboard; the
// dashboard branch adds a daemon pre-flight on the interactive bare path.
const bare = positionals[0] === undefined;
const subcommand = positionals[0] ?? "dashboard";
```

- [ ] **Step 5: Run the pre-flight in the dashboard branch**

In `src/cli.ts`, resolve the two new deps alongside the other default wiring at the top of `run()` (near the `withBotAuthFn` line, `src/cli.ts:304`):

```typescript
const isTTYFn = deps.isTTYFn ?? (() => Boolean(process.stdout.isTTY && process.stdin.isTTY));
const ensureDaemonFn =
  deps.ensureDaemonFn ?? (async (p: string) => (await import("./ensureDaemon.js")).ensureDaemon(p));
```

Then in the `dashboard` branch (`src/cli.ts:719-734`), change the config-loaded tail so the pre-flight runs first on the bare interactive path. Replace:

```typescript
const cfg = loadConfigFn(configPath);
setLogLevel(cfg.logLevel);
return runDashboardFn(cfg, configPath);
```

with:

```typescript
const cfg = loadConfigFn(configPath);
setLogLevel(cfg.logLevel);
// Bare `junco` on an interactive TTY ensures the supervised daemon is up
// before the panel opens. Explicit `junco dashboard` stays a pure observer.
if (bare && isTTYFn()) {
  await ensureDaemonFn(configPath);
}
return runDashboardFn(cfg, configPath);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/cli.test.ts > /tmp/t3.txt 2>&1; echo "exit: $?"`
Expected: PASS — the four new bare/dashboard cases and every pre-existing cli test.

- [ ] **Step 7: Update the in-file docs (header + USAGE)**

In `src/cli.ts`, update the header comment (`src/cli.ts:6-10`). Replace:

```
 *   junco                                    — bare → dashboard setup walkthrough
 *                                              on first run (no config yet), else
 *                                              start
```

with:

```
 *   junco                                    — bare → ensure the supervised daemon
 *                                              is up (interactive TTY), then open
 *                                              the dashboard; first run (no config)
 *                                              opens the setup walkthrough
```

Update the USAGE bare-invocation note (`src/cli.ts:204-205`). Replace:

```
  (no subcommand) → opens the dashboard setup walkthrough on first run
                    (no config yet), otherwise starts the daemon.
```

with:

```
  (no subcommand) → ensures the supervised daemon is running (interactive
                    terminal), then opens the dashboard; first run (no config)
                    opens the setup walkthrough. Use `junco start` for an
                    explicit foreground daemon, `junco dashboard` to observe
                    without starting anything.
```

- [ ] **Step 8: Update ARCHITECTURE.md**

In `ARCHITECTURE.md:197` (the `cli.ts` row), replace the sentence:

```
A bare invocation with no config routes to `dashboard` (FTUE walkthrough); with a config, to `start`.
```

with:

```
A bare invocation with no config routes to `dashboard` (FTUE walkthrough); with a config on an interactive terminal it ensures the supervised daemon is up (ensureDaemon.ts) then opens the dashboard. `junco start` remains the explicit foreground daemon; `junco dashboard` observes without starting anything.
```

- [ ] **Step 9: Full gate + commit**

```bash
npx prettier --write src/cli.ts tests/cli.test.ts
npm run lint && npm run format:check && npm run typecheck && npm run build && \
  npx vitest run > /tmp/gate.txt 2>&1; echo "vitest exit: $?"
git add src/cli.ts tests/cli.test.ts ARCHITECTURE.md
git commit -m "feat(cli): bare junco ensures the daemon, then opens the dashboard"
```

Expected: lint/format/typecheck/build clean; `vitest exit: 0`.

---

## Self-Review

**Spec coverage:**

- Requirement 1 (bare only; escape hatches) → Task 3 (`bare` gate; explicit-dashboard test; `start` untouched). ✓
- Requirement 2 (never spawn unsupervised; service-manager only; no-service informs) → Task 2 (`no-service` branch, no spawn path anywhere). ✓
- Requirement 3 (blocking wait ~5s) → Task 2 (`waitMs` default 5000, poll loop). ✓
- Requirement 4 (graceful, never fatal) → Task 2 (kickstart non-zero/reject and discover reject all map to results; ensureDaemon never throws). ✓
- Requirement 5 (interactive only) → Task 3 (`isTTYFn` gate; non-TTY test). ✓
- Requirement 6 (no config → FTUE unchanged) → Task 3 (FTUE test, no pre-flight). ✓
- Behavior table rows → Tasks 2 (states) + 3 (routing). ✓
- `restartCmd` refactor → Task 1. ✓
- Docs (ARCHITECTURE, cli header/USAGE) → Task 3. ✓ (README:155 already reads true — "bare `junco` on a first run opens the guided setup" — no edit needed.)

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `EnsureResult`/`EnsureDaemonDeps`/`ensureDaemon(configPath, deps)` identical across Tasks 2 and 3; `kickstartService(svc, deps)` signature identical across Tasks 1 and 2; `ServiceRef` sourced from `restartCmd.ts` throughout. The CliDeps `ensureDaemonFn` is `(configPath) => Promise<EnsureResult>`, matching the real default and the test spies.

**Note (deviation from spec):** the spec sketched `ensureDaemon(cfg, configPath, deps)`; planning found `cfg` unused (lock path, discovery, and kickstart all derive from `configPath`), so the implemented signature drops it. No behavioral difference.
