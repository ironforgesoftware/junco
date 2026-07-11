# Sandbox swap-exclusion (#159) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fs-tool intermediate-component TOCTOU (#159) in pure JS by making bash execution mutually exclusive with any fs-op's check→syscall window, plus reaping bash's process group.

**Architecture:** A per-session readers-writer async lock (fs-ops = shared, bash = exclusive, writer-priority) wraps every sandboxed operation at the `buildSandbox` seam; since only bash can plant an escaping symlink and it can never overlap an fs-op, no component can be swapped mid-op. Process-group reaping in `bashOps` stops a backgrounded swapper surviving between bash calls (bwrap's `--unshare-pid`/`--die-with-parent` already reap on Linux; reaping covers seatbelt/none on macOS).

**Tech Stack:** TypeScript (ESM/NodeNext, strict), vitest, Node `child_process`.

## Global Constraints

- Node ≥ 22.19; ESM/NodeNext; strict TS. Suite green at **every** commit.
- No new dependencies. **No AI attribution** in commits (no `Co-Authored-By: Claude`, no "Generated with" lines).
- Every side effect behind an injectable `deps` seam; tests never touch the network or real model. Fake `spawn` is injected.
- The lock exists **only** in a sandboxed build — zero cost/behavior change when `sandbox.enabled` is false.
- **Exit-code trap:** never pipe vitest into grep/tail — `npx vitest run <files> > /tmp/o 2>&1; echo "exit: $?"`.
- Full gate before "done": `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. `npx prettier --write` touched files before committing.
- Scope: `src/agent/sandbox/**` + docs only. Do not touch config, daemon, or unrelated modules.

---

## File Structure

- **Create** `src/agent/sandbox/opLock.ts` — the RW lock (`makeOpLock`) + the `lockSharedOps`/`lockExclusiveOps` wrappers.
- **Modify** `src/agent/sandbox/index.ts` — `buildSandbox` creates one lock and wraps each tool's operations (fs → shared, bash → exclusive).
- **Modify** `src/agent/sandbox/bashOps.ts` — spawn `detached`, reap the process group on close/timeout/abort.
- **Modify** docs (`docs/configuration.md` sandbox section) — residual + throughput note.
- **Create** tests: `tests/sandboxOpLock.test.ts`. **Modify** `tests/sandboxBashOps.test.ts`, and `tests/sandboxBuild.test.ts` (wiring/mutual-exclusion).

---

## Task 1: The readers-writer op-lock

**Files:**
- Create: `src/agent/sandbox/opLock.ts`
- Test: `tests/sandboxOpLock.test.ts`

**Interfaces:**
- Produces: `interface OpLock { runShared<T>(fn: () => Promise<T>): Promise<T>; runExclusive<T>(fn: () => Promise<T>): Promise<T> }`; `makeOpLock(): OpLock`.

- [ ] **Step 1: Write failing tests (`tests/sandboxOpLock.test.ts`).**

Deterministic gating with manually-resolved promises — no wall-clock races.

```ts
import { describe, it, expect } from "vitest";
import { makeOpLock } from "../src/agent/sandbox/opLock.js";

/** A promise you resolve by hand, to gate an in-flight critical section. */
function gate() {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
}

describe("makeOpLock", () => {
  it("runs shared sections concurrently", async () => {
    const lock = makeOpLock();
    const g1 = gate();
    let bothInside = false;
    const a = lock.runShared(async () => {
      // if b can enter while a is held, they overlap
      await g1.p;
    });
    const b = lock.runShared(async () => {
      bothInside = true; // reached only if not blocked by a's shared hold
    });
    await b; // b completes without waiting for a
    expect(bothInside).toBe(true);
    g1.release();
    await a;
  });

  it("exclusive excludes shared (and vice versa)", async () => {
    const lock = makeOpLock();
    const order: string[] = [];
    const g = gate();
    const excl = lock.runExclusive(async () => {
      order.push("excl-start");
      await g.p;
      order.push("excl-end");
    });
    // give excl a tick to acquire
    await Promise.resolve();
    const shared = lock.runShared(async () => {
      order.push("shared");
    });
    g.release();
    await Promise.all([excl, shared]);
    // shared must not run until excl fully released
    expect(order).toEqual(["excl-start", "excl-end", "shared"]);
  });

  it("writer-priority: a pending exclusive blocks a newly-arriving shared", async () => {
    const lock = makeOpLock();
    const order: string[] = [];
    const g = gate();
    const s1 = lock.runShared(async () => {
      order.push("s1-start");
      await g.p; // hold shared open
      order.push("s1-end");
    });
    await Promise.resolve();
    const w = lock.runExclusive(async () => order.push("w")); // queues, waits for s1
    await Promise.resolve();
    const s2 = lock.runShared(async () => order.push("s2")); // arrives AFTER w
    g.release();
    await Promise.all([s1, w, s2]);
    // s2 must wait behind the queued writer, not slip in with s1
    expect(order).toEqual(["s1-start", "s1-end", "w", "s2"]);
  });

  it("releases the lock even if the body throws", async () => {
    const lock = makeOpLock();
    await expect(lock.runExclusive(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // lock is free again:
    await expect(lock.runShared(async () => 42)).resolves.toBe(42);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/sandboxOpLock.test.ts > /tmp/t1.out 2>&1; echo "exit: $?"` → FAIL (module missing).

- [ ] **Step 3: Implement `src/agent/sandbox/opLock.ts`.**

```ts
/**
 * Readers-writer lock guarding the sandbox's in-process fs tools against a
 * concurrent bash-planted symlink swap (#159). fs-ops run SHARED (they cannot
 * create symlinks, so they are safe to run concurrently with each other); the
 * bash tool runs EXCLUSIVE for its whole subprocess lifetime, so no bash
 * execution ever overlaps an fs-op's check→syscall window. Writer-priority
 * keeps a stream of fs-ops from starving a pending bash.
 */
export interface OpLock {
  runShared<T>(fn: () => Promise<T>): Promise<T>;
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export function makeOpLock(): OpLock {
  let sharedCount = 0;
  let exclusiveActive = false;
  const queue: Array<{ exclusive: boolean; grant: () => void }> = [];

  function dispatch(): void {
    while (queue.length > 0) {
      const head = queue[0];
      if (head.exclusive) {
        if (sharedCount === 0 && !exclusiveActive) {
          queue.shift();
          exclusiveActive = true;
          head.grant();
        }
        return; // writer-priority: nothing behind an ungranted writer proceeds
      }
      if (exclusiveActive) return;
      queue.shift();
      sharedCount++;
      head.grant();
      // keep granting consecutive shared waiters at the head
    }
  }

  function acquire(exclusive: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      queue.push({ exclusive, grant: resolve });
      dispatch();
    });
  }

  return {
    async runShared<T>(fn: () => Promise<T>): Promise<T> {
      await acquire(false);
      try {
        return await fn();
      } finally {
        sharedCount--;
        dispatch();
      }
    },
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      await acquire(true);
      try {
        return await fn();
      } finally {
        exclusiveActive = false;
        dispatch();
      }
    },
  };
}
```

- [ ] **Step 4: Run to green.** `npx vitest run tests/sandboxOpLock.test.ts > /tmp/t1b.out 2>&1; echo "exit: $?"` → PASS (4/4).

- [ ] **Step 5: Format + commit.**
```bash
npx prettier --write src/agent/sandbox/opLock.ts tests/sandboxOpLock.test.ts
git add -A && git commit -m "feat(sandbox): readers-writer op-lock (fs shared, bash exclusive)"
```

---

## Task 2: Wrap operations + wire the lock into buildSandbox

**Files:**
- Modify: `src/agent/sandbox/opLock.ts` (add wrappers)
- Modify: `src/agent/sandbox/index.ts` (`buildSandbox` creates + applies the lock)
- Test: `tests/sandboxBuild.test.ts` (mutual-exclusion property)

**Interfaces:**
- Consumes: `OpLock` (Task 1).
- Produces: `lockOps<T extends object>(ops: T, lock: OpLock, mode: "shared" | "exclusive"): T` — returns an object whose every function-valued property runs under the lock in the given mode.

- [ ] **Step 1: Add the wrapper to `opLock.ts`.**

```ts
/** Wrap an operations object so every function-valued property runs under
 * `lock` in the given mode. Non-function properties pass through. */
export function lockOps<T extends object>(ops: T, lock: OpLock, mode: "shared" | "exclusive"): T {
  const run = mode === "shared" ? lock.runShared.bind(lock) : lock.runExclusive.bind(lock);
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(ops) as (keyof T)[]) {
    const v = ops[key];
    out[key as string] =
      typeof v === "function"
        ? (...args: unknown[]) => run(() => (v as (...a: unknown[]) => Promise<unknown>)(...args))
        : v;
  }
  return out as T;
}
```

- [ ] **Step 2: Write the failing mutual-exclusion test (`tests/sandboxBuild.test.ts`).**

Assert a bash `exec` and an fs-op provably cannot interleave when both go through the same lock. Build the two wrapped operations directly (no SDK) via a small helper; record enter/exit intervals and assert no overlap.

```ts
import { describe, it, expect } from "vitest";
import { makeOpLock, lockOps } from "../src/agent/sandbox/opLock.js";

describe("sandbox op mutual-exclusion (#159)", () => {
  it("a bash exec never overlaps an fs-op", async () => {
    const lock = makeOpLock();
    const events: string[] = [];
    const gate = (() => { let r!: () => void; const p = new Promise<void>((x) => (r = x)); return { p, r }; })();

    const fs = lockOps(
      { writeFile: async () => { events.push("fs-in"); events.push("fs-out"); } },
      lock,
      "shared",
    );
    const bash = lockOps(
      { exec: async () => { events.push("bash-in"); await gate.p; events.push("bash-out"); return { exitCode: 0 }; } },
      lock,
      "exclusive",
    );

    const b = (bash as { exec: () => Promise<unknown> }).exec();
    await Promise.resolve(); // let bash acquire exclusive
    const f = (fs as { writeFile: () => Promise<void> }).writeFile(); // must queue behind bash
    gate.r();
    await Promise.all([b, f]);
    // bash fully brackets before fs starts — no interleave
    expect(events).toEqual(["bash-in", "bash-out", "fs-in", "fs-out"]);
  });
});
```

- [ ] **Step 3: Run to verify failure** (`lockOps` import/behavior): `npx vitest run tests/sandboxBuild.test.ts > /tmp/t2.out 2>&1; echo "exit: $?"` → FAIL until Step 1 lands (if you wrote Step 1 first, this passes; keep the test as the regression lock).

- [ ] **Step 4: Wire into `buildSandbox` (`src/agent/sandbox/index.ts`).**

Import `makeOpLock, lockOps`. In `buildSandbox`, create one lock and wrap each tool's operations after `toolOptionsFor` returns them (bash → exclusive, everything else → shared). Leave `toolOptionsFor` building raw ops (keeps its existing callers/tests intact).

```ts
import { makeOpLock, lockOps } from "./opLock.js";
// ...
export function buildSandbox(factories: SdkToolFactories, opts: BuildSandboxOpts): BuildSandboxResult {
  const { cwd, toolNames, backend, policy, home, bashDeps } = opts;
  const lock = makeOpLock();
  const customTools: unknown[] = [];
  for (const name of toolNames) {
    if (!KNOWN_TOOLS.has(name)) continue;
    const factory = factoryFor(factories, name);
    if (!factory) continue;
    const raw = toolOptionsFor(name, cwd, backend, policy, bashDeps).operations;
    const operations =
      raw && typeof raw === "object"
        ? lockOps(raw as object, lock, name === "bash" ? "exclusive" : "shared")
        : raw;
    customTools.push(factory(cwd, { operations }));
  }
  const resourceLoader = new factories.DefaultResourceLoader({
    cwd,
    agentDir: join(home, ".pi", "agent"),
    noExtensions: true,
  });
  return { customTools, resourceLoader };
}
```

- [ ] **Step 5: Run tests.** `npx vitest run tests/sandboxBuild.test.ts tests/sandbox.integration.test.ts > /tmp/t2b.out 2>&1; echo "exit: $?"` → PASS. If a `buildSandbox` test asserted the operations object identity, adjust it to expect a wrapped object (same method names, callable) — do not weaken behavioral assertions.

- [ ] **Step 6: Format + commit.**
```bash
npx prettier --write src/agent/sandbox/opLock.ts src/agent/sandbox/index.ts tests/sandboxBuild.test.ts
git add -A && git commit -m "feat(sandbox): serialize bash against fs-ops via the op-lock at buildSandbox"
```

---

## Task 3: Reap bash's process group

**Files:**
- Modify: `src/agent/sandbox/bashOps.ts`
- Test: `tests/sandboxBashOps.test.ts`

**Interfaces:**
- Consumes: existing `makeSandboxedBashOperations(backend, policy, deps)`; the injected `spawnFn`.
- Produces: same signature; the spawned child is `detached`, and on close/timeout/abort the process **group** is killed.

- [ ] **Step 1: Write the failing reaping test (`tests/sandboxBashOps.test.ts`).**

Inject a fake `spawnFn` returning a fake child (pid, stdout/stderr EventEmitters, `on`, `kill`); drive `exec`, fire `close`, and assert the group kill (`process.kill(-pid, "SIGKILL")`) fired — via an injected `killFn` seam. Add a `killFn?: (pid: number, signal: NodeJS.Signals) => void` to `BashOpsDeps` (default `process.kill`), so the test asserts on it without signalling a real pid.

```ts
it("kills the process group on completion so backgrounded children can't survive (#159)", async () => {
  const kills: Array<[number, string]> = [];
  const child = fakeChild(4242); // helper: EventEmitter-based stdout/stderr, .on, .kill
  const ops = makeSandboxedBashOperations(noneBackend, policy, {
    spawnFn: (() => child) as never,
    killFn: (pid, sig) => kills.push([pid, sig]),
  });
  const done = ops.exec("echo hi & ", "/work", { onData: () => {} });
  child.emit("close", 0);
  await done;
  expect(kills).toContainEqual([-4242, "SIGKILL"]); // negative pid = the whole group
});
```
(Also assert the child was spawned with `detached: true` by capturing the `spawnFn` options.)

- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/sandboxBashOps.test.ts > /tmp/t3.out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement in `src/agent/sandbox/bashOps.ts`.**
- Add `killFn?: (pid: number, signal: NodeJS.Signals) => void` to `BashOpsDeps`; resolve `const killFn = deps.killFn ?? ((pid, sig) => process.kill(pid, sig));`.
- Spawn with `{ cwd, stdio: ["ignore", "pipe", "pipe"], env, detached: true }` (own process group).
- Add a `reap()` that best-effort kills the group: `if (proc.pid !== undefined) { try { killFn(-proc.pid, "SIGKILL"); } catch { /* group already gone */ } }`.
- Call `reap()` inside `finish()` (covers normal close, error) and in the timeout + `onAbort` handlers (replace the current `proc.kill("SIGKILL")` in timeout/abort with `reap()` so the whole group dies, not just the wrapper). Keep `finish(exitCode)` resolving the promise as before.
- Comment: on Linux, bwrap's `--unshare-pid` + `--die-with-parent` already reap the namespace; this group-kill covers seatbelt/`none` on macOS. Residual: a `setsid`-escaping child on macOS survives — documented, closed only by the deferred native `*at` resolver.

- [ ] **Step 4: Run to green.** `npx vitest run tests/sandboxBashOps.test.ts > /tmp/t3b.out 2>&1; echo "exit: $?"` → PASS. Confirm the abort/timeout paths still resolve `{exitCode}` (existing tests).

- [ ] **Step 5: Format + commit.**
```bash
npx prettier --write src/agent/sandbox/bashOps.ts tests/sandboxBashOps.test.ts
git add -A && git commit -m "fix(sandbox): reap bash process group so a backgrounded swapper can't survive (#159)"
```

---

## Task 4: Docs + close-out

**Files:**
- Modify: `docs/configuration.md` (the "agent execution sandbox" section)
- No code; update issue #159 after merge.

- [ ] **Step 1: Document the mechanism + residual + throughput** in `docs/configuration.md`'s sandbox section: a short paragraph — "fs-tool operations are serialized against bash execution (and bash's process group is reaped) so a compromised agent can't win a symlink-swap race against the in-process path jail; under `sandbox.enabled` a long bash briefly blocks concurrent fs-ops. Residual: a `setsid`-escaping background process on macOS can still race the jail; the fully atomic fix (native `openat2`/`openat` resolver) is tracked on #159."

- [ ] **Step 2: Full gate.**
```
npm run lint > /tmp/g.out 2>&1; echo "lint $?"
npm run format:check >> /tmp/g.out 2>&1; echo "fmt $?"
npm run typecheck >> /tmp/g.out 2>&1; echo "tc $?"
npm run build >> /tmp/g.out 2>&1; echo "build $?"
npx vitest run > /tmp/gt.out 2>&1; echo "test $?"
```
Expected: all green.

- [ ] **Step 3: Format + commit.**
```bash
npx prettier --write docs/configuration.md
git add -A && git commit -m "docs(sandbox): document fs-op/bash swap-exclusion + residual (#159)"
```

- [ ] **Step 4 (post-merge, not code):** comment on #159 that the pure-JS swap-exclusion shipped (bash↔fs mutual exclusion + process-group reaping), narrowing the remaining scope to the native `*at` resolver for the macOS `setsid` residual; keep #159 open (or split the native part into a fresh issue).

---

## Self-Review Results

- **Spec coverage:** RW lock (T1) · wiring at the single `buildSandbox` seam covering all fs-ops + bash (T2) · process-group reaping (T3) · docs/residual (T4). The read/mkdir gaps are covered because every fs-op is a shared-lock holder excluded from bash — no per-op-type work needed.
- **Type consistency:** `OpLock`/`makeOpLock`/`lockOps` (T1/T2) consumed in T2's `buildSandbox`; `killFn` added to `BashOpsDeps` (T3) defaults to `process.kill`.
- **No placeholders:** the lock (the subtle part) is complete; the wrapper + wiring + reaping are complete; test bodies are concrete. `fakeChild` is a small EventEmitter helper the implementer writes to match the existing `sandboxBashOps.test.ts` fake-spawn style (that file already fakes a child — reuse its pattern).
