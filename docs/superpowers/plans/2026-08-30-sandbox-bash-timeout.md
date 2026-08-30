# Sandboxed bash: default wall-clock ceiling + honest kill status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single sandboxed `bash` call can no longer pin a worker until the ticket timeout: a configurable default ceiling (`sandbox.bashTimeoutSeconds`, default 600, 0 = none) applies whenever the agent passes no `timeout`; the agent's explicit `timeout` (seconds) is honored as seconds; and a killed command surfaces to the agent as "Command timed out after N seconds" / "Command aborted" instead of a silent success.

**Architecture:** Three defects in `src/agent/sandbox/bashOps.ts`, found during the #320 incident (a runaway `grep -r` ran ~37 min until the ticket abort): (1) Pi's bash tool hands a custom `BashOperations.exec` the model's `timeout` in **seconds** (its own default implementation converts to ms itself — `dist/core/tools/bash.js:46-47`), but `bashOps.exec` feeds `options.timeout` straight into `setTimeout` as **milliseconds**, so `timeout: 60` kills after 60 ms; (2) there is no ceiling when the model passes none (Pi's schema: "optional, no default timeout"); (3) after a reap the child closes with `code: null`, `exec` resolves `{ exitCode: null }`, and Pi's tool treats `null` as success (`if (exitCode !== 0 && exitCode !== null) throw …`, `bash.js:347`) — the agent sees a truncated "successful" result with no status. The fix: a new config leaf `sandbox.bashTimeoutSeconds` (schema + `SandboxConfig` + lever + resolution) threaded into `SandboxPolicy.bashTimeoutMs` by `buildPolicy`; `bashOps.exec` computes `limitMs = (explicit seconds × 1000) ?? policy.bashTimeoutMs`, and on a timer-driven or abort-driven reap **rejects** with `Error("timeout:<secs>")` / `Error("aborted")` — exactly the errors Pi's own implementation throws (`bash.js:49,101,104`), which the tool renders as "Command timed out after N seconds" / "Command aborted" (`bash.js:337-341`). The integration suite kills a real `sleep` under the real backend.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest (fake timers for the unit tests), zod config schema, prettier 100 cols. Sandbox backends: Seatbelt (macOS), bubblewrap (Linux), none.

**Spec:** GitHub issue #320's "Proposed fix" item 4 (secondary hardening) and the whole-branch review of PR #321 (minor: runaway bash pins the worker). Maintainer chose this follow-up in-session; default ceiling **600 s** is the controller's assumption (state it in the PR; one lever to change).

## Global Constraints

- **Adding a `Config` field:** add it to `tests/helpers/config.ts` (the only full `Config` literal) AND to every hand-written `SandboxConfig`/`Config` literal the typecheck flags: `tests/sandboxConfig.test.ts` (defaults assertion + explicit-section test), `tests/doctor.test.ts` `sandboxConfig()`, `tests/sandboxPolicy.test.ts` (the `cfg:` objects passed to `buildPolicy`), `tests/sessionSandboxWiring.test.ts` `cfgWith` — `npm run typecheck` is the arbiter (vitest does not type-check).
- **Lever ↔ schema bijection** (`tests/configLevers.test.ts`): every schema leaf has exactly one lever; a number lever's `min`/`max` must match the zod `.min()/.max()`; `default` must match the zod default.
- Every side effect behind an injectable seam (`BashOpsDeps` already has `spawnFn`/`killFn`/`env`). Unit tests use `vi.useFakeTimers()` and the existing `fakeProc()` — never a real sleep. Only `tests/sandbox.integration.test.ts` runs real processes, and every enforcement case calls `requireBackend(ctx)`.
- `bashOps.ts` must keep the contract Pi expects (`BashOperations.exec` shape: `Promise<{ exitCode: number | null }>`, errors `"aborted"` / `"timeout:<secs>"` on kill) — verified against `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js` 0.84.2. No SDK import in `src/`.
- `src/ticketSchema.ts` untouched. Prettier 100 cols; conventional commits; **no AI attribution**; suite green at every commit; full gate before done (`npm run lint && npm run format:check && npm run typecheck && npm run build`, then `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`).
- This shell aliases `grep` to `ugrep`; use `/usr/bin/grep` or `sed`.

---

### Task 1: The `sandbox.bashTimeoutSeconds` leaf, end to end

**Files:**

- Modify: `src/config.ts` (sandbox zod object ~line 432–443; sandbox resolution block ~line 764–770)
- Modify: `src/types.ts` (`SandboxConfig` ~line 120–133)
- Modify: `src/configLevers.ts` (after the `sandbox.extraAllowWrite` lever ~line 535–541)
- Modify: `src/agent/sandbox/policy.ts` (`SandboxPolicy` ~line 104–107; `buildPolicy`'s return object ~line 178)
- Modify: `tests/helpers/config.ts` (sandbox block ~line 132), `tests/sandboxConfig.test.ts`, `tests/doctor.test.ts` (~line 203), `tests/sandboxPolicy.test.ts` (every `cfg: { enabled, backend, network, extraDenyRead, extraAllowWrite }` literal), `tests/sessionSandboxWiring.test.ts` (`cfgWith`'s sandbox object), `tests/sandboxBashOps.test.ts` (the `policy` literal ~line 7)

**Interfaces:**

- Produces: `SandboxConfig.bashTimeoutSeconds: number` (0 = no ceiling); `SandboxPolicy.bashTimeoutMs: number | undefined` (`undefined` when the config value is 0); lever `sandbox.bashTimeoutSeconds` (number, default 600, min 0, editable, live). Task 2 consumes `policy.bashTimeoutMs`.

- [ ] **Step 1: Write the failing tests**

In `tests/sandboxConfig.test.ts`, extend the defaults assertion to include `bashTimeoutSeconds: 600`, and add after the "parses an explicit section" test:

```ts
it("accepts sandbox.bashTimeoutSeconds (0 = no ceiling) and rejects negatives", () => {
  expect(
    loadConfig(writeConfig({ ...BASE, sandbox: { bashTimeoutSeconds: 0 } })).sandbox
      .bashTimeoutSeconds,
  ).toBe(0);
  expect(
    loadConfig(writeConfig({ ...BASE, sandbox: { bashTimeoutSeconds: 90 } })).sandbox
      .bashTimeoutSeconds,
  ).toBe(90);
  expect(() => loadConfig(writeConfig({ ...BASE, sandbox: { bashTimeoutSeconds: -1 } }))).toThrow();
});
```

(Match how the existing "parses an explicit section" test builds its input — `BASE` and `writeConfig` are that file's fixtures; if `sandbox` merges over `BASE.sandbox`, spread accordingly.)

In `tests/sandboxPolicy.test.ts`, inside `describe("buildPolicy", …)` add:

```ts
it("threads sandbox.bashTimeoutSeconds into the policy as milliseconds; 0 means no ceiling", () => {
  expect(
    buildPolicy({ ...base, cfg: { ...base.cfg, bashTimeoutSeconds: 600 } }).bashTimeoutMs,
  ).toBe(600_000);
  expect(
    buildPolicy({ ...base, cfg: { ...base.cfg, bashTimeoutSeconds: 0 } }).bashTimeoutMs,
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/sandboxConfig.test.ts tests/sandboxPolicy.test.ts` → FAIL (`bashTimeoutSeconds` absent / `bashTimeoutMs` undefined). `npm run typecheck` also fails once the literals lack the field — expected until Step 3.

- [ ] **Step 3: Implement**

`src/config.ts`, sandbox zod object — add after `extraAllowWrite`:

```ts
      // Ceiling on ONE sandboxed bash call when the agent passes no `timeout`
      // (seconds; 0 = none). The agent's explicit timeout always wins. A
      // runaway `grep -r` once pinned a worker until the ticket timeout (#320).
      bashTimeoutSeconds: z.number().int().min(0).default(600),
```

sandbox resolution block — add `bashTimeoutSeconds: d.sandbox.bashTimeoutSeconds,`.

`src/types.ts` `SandboxConfig` — add after `extraAllowWrite`:

```ts
// Ceiling in seconds on one sandboxed bash call when the agent passes no
// timeout; 0 = no ceiling. The agent's explicit timeout always wins.
bashTimeoutSeconds: number;
```

`src/configLevers.ts` — add after the `sandbox.extraAllowWrite` lever:

```ts
  {
    path: "sandbox.bashTimeoutSeconds",
    type: "number",
    default: 600,
    min: 0,
    editable: true,
    reload: "live",
    description:
      "Ceiling (seconds) on one sandboxed bash call when the agent passes no timeout; 0 = none. The agent's explicit timeout always wins.",
  },
```

`src/agent/sandbox/policy.ts` — in `SandboxPolicy` add after `scratchDir`:

```ts
/** Default wall-clock ceiling for one bash call, ms; undefined = no ceiling.
 *  The agent's explicit `timeout` (seconds) always overrides it. */
bashTimeoutMs: number | undefined;
```

and in `buildPolicy`'s return object add `bashTimeoutMs: cfg.bashTimeoutSeconds > 0 ? cfg.bashTimeoutSeconds * 1000 : undefined,`.

Test literals: add `bashTimeoutSeconds: 600` to every `SandboxConfig` literal named in **Files** (`tests/helpers/config.ts` sandbox block, `tests/doctor.test.ts`, the `cfg:` objects in `tests/sandboxPolicy.test.ts`, `cfgWith` in `tests/sessionSandboxWiring.test.ts`), and `bashTimeoutMs: undefined` to the `SandboxPolicy` literal in `tests/sandboxBashOps.test.ts`. The `sandboxConfig.test.ts` defaults assertion gains `bashTimeoutSeconds: 600`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck` (clean — it finds any literal you missed), then `npx vitest run tests/sandboxConfig.test.ts tests/sandboxPolicy.test.ts tests/configLevers.test.ts tests/doctor.test.ts tests/sessionSandboxWiring.test.ts tests/sandboxBashOps.test.ts` → PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/config.ts src/types.ts src/configLevers.ts src/agent/sandbox/policy.ts tests/helpers/config.ts tests/sandboxConfig.test.ts tests/doctor.test.ts tests/sandboxPolicy.test.ts tests/sessionSandboxWiring.test.ts tests/sandboxBashOps.test.ts
npm run lint
git add -A src tests
git commit -m "feat(sandbox): sandbox.bashTimeoutSeconds — default ceiling for one bash call, threaded into the policy"
```

No attribution trailer (`git log -1 --format=%B`).

---

### Task 2: `bashOps.exec` — seconds, default ceiling, honest kill status

**Files:**

- Modify: `src/agent/sandbox/bashOps.ts` (`BashExecOptions.timeout` doc; `exec` body ~lines 49–107)
- Test: `tests/sandboxBashOps.test.ts`

**Interfaces:**

- Consumes: `policy.bashTimeoutMs` (Task 1). Pi's contract: `options.timeout` is **seconds**; on kill the promise must **reject** with `Error("timeout:<secs>")` or `Error("aborted")` (mirrors `bash.js:49,101,104`).
- Produces: nothing new; behavior only.

- [ ] **Step 1: Write the failing tests**

In `tests/sandboxBashOps.test.ts`, replace the two cases "kills the process group on timeout and resolves exitCode null" and "kills the process group on abort signal" with:

```ts
it("treats the agent's timeout as SECONDS (Pi passes the raw schema value) and rejects with timeout:<secs>", async () => {
  vi.useFakeTimers();
  const proc = fakeProc();
  const kills: Array<[number, string]> = [];
  const ops = makeSandboxedBashOperations(noneBackend, policy, {
    spawnFn: (() => proc) as any,
    killFn: (pid, sig) => kills.push([pid, sig]),
  });
  const p = ops.exec("sleep", "/work/tree", { onData: () => {}, timeout: 2 });
  vi.advanceTimersByTime(1999);
  expect(kills).toEqual([]); // 2 s, not 2 ms
  vi.advanceTimersByTime(2);
  expect(kills).toContainEqual([-4242, "SIGKILL"]); // negative pid = the group
  proc.emit("close", null);
  await expect(p).rejects.toThrow("timeout:2");
  vi.useRealTimers();
});

it("applies the policy's default ceiling when the agent passes no timeout", async () => {
  vi.useFakeTimers();
  const proc = fakeProc();
  const kills: Array<[number, string]> = [];
  const ops = makeSandboxedBashOperations(
    noneBackend,
    { ...policy, bashTimeoutMs: 3_000 },
    {
      spawnFn: (() => proc) as any,
      killFn: (pid, sig) => kills.push([pid, sig]),
    },
  );
  const p = ops.exec("sleep", "/work/tree", { onData: () => {} });
  vi.advanceTimersByTime(3_001);
  expect(kills).toContainEqual([-4242, "SIGKILL"]);
  proc.emit("close", null);
  await expect(p).rejects.toThrow("timeout:3");
  vi.useRealTimers();
});

it("the agent's explicit timeout overrides the default ceiling in both directions", async () => {
  vi.useFakeTimers();
  const proc = fakeProc();
  const kills: Array<[number, string]> = [];
  const ops = makeSandboxedBashOperations(
    noneBackend,
    { ...policy, bashTimeoutMs: 1_000 },
    {
      spawnFn: (() => proc) as any,
      killFn: (pid, sig) => kills.push([pid, sig]),
    },
  );
  const p = ops.exec("sleep", "/work/tree", { onData: () => {}, timeout: 5 });
  vi.advanceTimersByTime(4_999);
  expect(kills).toEqual([]); // the 1 s default did not fire
  vi.advanceTimersByTime(2);
  expect(kills).toContainEqual([-4242, "SIGKILL"]);
  proc.emit("close", null);
  await expect(p).rejects.toThrow("timeout:5");
  vi.useRealTimers();
});

it("no ceiling at all when the policy has none and the agent passes no timeout", async () => {
  vi.useFakeTimers();
  const proc = fakeProc();
  const kills: Array<[number, string]> = [];
  const ops = makeSandboxedBashOperations(
    noneBackend,
    { ...policy, bashTimeoutMs: undefined },
    {
      spawnFn: (() => proc) as any,
      killFn: (pid, sig) => kills.push([pid, sig]),
    },
  );
  const p = ops.exec("sleep", "/work/tree", { onData: () => {} });
  vi.advanceTimersByTime(3_600_000);
  expect(kills.filter(([pid]) => pid === -4242)).toEqual([]);
  proc.emit("close", 0);
  await expect(p).resolves.toEqual({ exitCode: 0 });
  vi.useRealTimers();
});

it("kills the process group on abort and rejects with 'aborted' (Pi renders 'Command aborted')", async () => {
  const proc = fakeProc();
  const kills: Array<[number, string]> = [];
  const ac = new AbortController();
  const ops = makeSandboxedBashOperations(noneBackend, policy, {
    spawnFn: (() => proc) as any,
    killFn: (pid, sig) => kills.push([pid, sig]),
  });
  const p = ops.exec("x", "/work/tree", { onData: () => {}, signal: ac.signal });
  ac.abort();
  expect(kills).toContainEqual([-4242, "SIGKILL"]);
  proc.emit("close", null);
  await expect(p).rejects.toThrow("aborted");
});

it("a command killed by something else still resolves exitCode null (not a timeout, not an abort)", async () => {
  const proc = fakeProc();
  const ops = makeSandboxedBashOperations(noneBackend, policy, { spawnFn: (() => proc) as any });
  const p = ops.exec("x", "/work/tree", { onData: () => {} });
  proc.emit("close", null); // e.g. OOM-killed
  await expect(p).resolves.toEqual({ exitCode: null });
});
```

Keep the "#159 reap on completion" case as is (it asserts the reap on a normal close; still true).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/sandboxBashOps.test.ts` → the seconds case fails (kill at 2 ms), the ceiling case fails (no kill), the abort/timeout cases fail on `rejects` (currently resolve).

- [ ] **Step 3: Implement**

In `src/agent/sandbox/bashOps.ts`, update the option doc and the `exec` body:

```ts
export interface BashExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  /** SECONDS — the model's raw `timeout` argument. Pi's own local backend
   *  converts to ms itself (bash.js resolveTimeoutMs); a custom
   *  BashOperations receives the schema value untouched. */
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}
```

Inside `exec`, after `const env = …` and before `new Promise`, compute the limit; then replace the promise body's timer/abort/finish wiring:

```ts
// The agent's explicit timeout (seconds) wins; otherwise the policy's
// default ceiling (ms; undefined = none). Both reap the whole process
// group and REJECT with the exact errors Pi's own backend throws, so the
// tool renders "Command timed out after N seconds" / "Command aborted"
// instead of treating the killed child's null exit code as success.
const limitMs = options.timeout !== undefined ? options.timeout * 1000 : policy.bashTimeoutMs;
const limitSecs = limitMs === undefined ? undefined : Math.round(limitMs / 1000);

return new Promise<{ exitCode: number | null }>((resolve, reject) => {
  // … existing spawn + reap unchanged …
  let settled = false;
  let timedOut = false;
  let aborted = false;
  const finish = (exitCode: number | null): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
    reap(); // sweep any surviving group members before settling
    if (timedOut) reject(new Error(`timeout:${limitSecs}`));
    else if (aborted) reject(new Error("aborted"));
    else resolve({ exitCode });
  };

  proc.stdout?.on("data", (c: Buffer) => options.onData(c));
  proc.stderr?.on("data", (c: Buffer) => options.onData(c));

  const timer =
    limitMs !== undefined && limitMs > 0
      ? setTimeout(() => {
          timedOut = true;
          reap();
        }, limitMs)
      : undefined;

  const onAbort = (): void => {
    aborted = true;
    reap();
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort);
  }

  proc.on("error", () => finish(null));
  proc.on("close", (code: number | null) => finish(code));
});
```

(Keep `reap` exactly as it is; only the settle logic, the timer computation and the abort handler change. `policy` is already in scope — it is the second parameter of `makeSandboxedBashOperations`.)

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/sandboxBashOps.test.ts tests/sessionSandboxWiring.test.ts` → PASS. `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Format, commit**

```bash
npx prettier --write src/agent/sandbox/bashOps.ts tests/sandboxBashOps.test.ts
git add src/agent/sandbox/bashOps.ts tests/sandboxBashOps.test.ts
git commit -m "fix(sandbox): bash timeout is seconds, a default ceiling applies, and a killed command reports timeout/abort instead of success"
```

---

### Task 3: Integration — a real `sleep` is killed under the real backend

**Files:**

- Modify: `tests/sandbox.integration.test.ts` (new case inside `describe.each(["v2", "flat"])`, after the "#320 can commit" case)

**Interfaces:**

- Consumes: `shippedTree(layout)` (async), `runShipped(command, t)`, `requireBackend(ctx)`, `makeSandboxedBashOperations`.

- [ ] **Step 1: Write the test**

`runShipped` builds ops from `t.policy`; add a variant with a 1 s ceiling. Add this helper next to `runShipped`:

```ts
/** Like runShipped, but with a policy whose default bash ceiling is `ms`. */
async function runShippedWithCeiling(command: string, t: ShippedTree, ms: number): Promise<string> {
  const ops = makeSandboxedBashOperations(
    backend,
    { ...t.policy, bashTimeoutMs: ms },
    {
      env: () => ({ ...process.env, HOME: t.home }),
    },
  );
  let out = "";
  await ops.exec(command, t.worktree, { onData: (d) => (out += d.toString()) });
  return out;
}
```

and the case:

```ts
it("a runaway command is killed at the default ceiling and reported as a timeout", async (ctx) => {
  requireBackend(ctx);
  const t = await shippedTree(layout);
  const started = Date.now();
  await expect(
    runShippedWithCeiling(`echo started; sleep 30; echo finished`, t, 1_000),
  ).rejects.toThrow("timeout:1");
  // Killed at ~1 s, not after the 30 s sleep — and the whole group is gone.
  expect(Date.now() - started).toBeLessThan(10_000);
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/sandbox.integration.test.ts` → PASS on this host (real Seatbelt); cases skip with a named reason only where no backend exists.

- [ ] **Step 3: Format, lint, commit**

```bash
npx prettier --write tests/sandbox.integration.test.ts
npm run lint && npm run typecheck
git add tests/sandbox.integration.test.ts
git commit -m "test(sandbox): a runaway bash call is killed at the default ceiling under the real backend"
```

---

### Task 4: Docs + changelog

**Files:**

- Modify: `docs/operations.md` (the sandbox paragraph: after the sentence ending `…use the per-ticket \`network: true\` frontmatter opt-in to widen egress for one ticket.`)
- Modify: `CHANGELOG.md` (`[Unreleased]`: one `### Added` bullet, one `### Fixed` bullet as the first of each list)

- [ ] **Step 1: operations.md** — insert after that sentence:

```
One sandboxed `bash` call is capped at `sandbox.bashTimeoutSeconds` (default 600; 0 = no cap) when the agent passes no `timeout`; the agent's own `timeout` argument (seconds) always wins, so a legitimately long build can ask for more. A command that hits either limit is killed as a process group and the agent sees "Command timed out after N seconds" — it can retry narrower, instead of a runaway `grep -r` pinning the worker until the ticket timeout.
```

- [ ] **Step 2: CHANGELOG.md**

`### Added`, first bullet:

```
- `sandbox.bashTimeoutSeconds` (default 600, 0 = none): a wall-clock ceiling on one sandboxed `bash` call when the agent passes no `timeout`. The agent's explicit `timeout` always wins. Live-reload lever (`junco config set sandbox.bashTimeoutSeconds 900`).
```

`### Fixed`, first bullet:

```
- **Sandbox: a killed bash command looked like a success, and the agent's `timeout` was off by 1000×.** Pi hands a custom `BashOperations.exec` the model's `timeout` in seconds; junco fed it to `setTimeout` as milliseconds, so `timeout: 60` killed after 60 ms. And after any kill (timeout or abort) junco resolved `{ exitCode: null }`, which Pi's tool treats as success — the agent saw a truncated result with no status. `exec` now converts seconds, applies the new default ceiling, and rejects with the same `timeout:<secs>` / `aborted` errors Pi's own backend throws, so the tool reports "Command timed out after N seconds" / "Command aborted". Found while diagnosing #320, where an unbounded `grep -r` over a source tree pinned the worker for the whole 60-minute ticket timeout.
```

- [ ] **Step 3: Format, commit**

```bash
npx prettier --write docs/operations.md CHANGELOG.md
npx prettier --check docs/operations.md CHANGELOG.md
git add docs/operations.md CHANGELOG.md
git commit -m "docs: sandbox bash ceiling lever; timeout/abort status in the changelog"
```

---

### Task 5: Full gate

- [ ] `npm run lint && npm run format:check && npm run typecheck && npm run build`
- [ ] `npx vitest run > /tmp/junco-gate-bash.out 2>&1; echo "exit: $?"; tail -6 /tmp/junco-gate-bash.out`
- [ ] `git log origin/main..HEAD --format=%B` — plain conventional one-liners only.
