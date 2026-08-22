# `JUNCO_CONFIG` override and the `metrics.json` writer (WS-7a + WS-7b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #275 (a `JUNCO_CONFIG` environment override for scripted/CI/sandbox contexts) and #279 (actually write the `metrics.json` that the data tree already reserves).

**Architecture:** Two independent features sharing a branch because both are small and neither touches the other's files. #275 adds one branch to `resolveConfigPath`, junco's single source of truth for where the config lives. #279 adds a debounced writer module modelled on `spendLedger.ts` and wires it into the daemon loop next to the spend ledger.

**Tech Stack:** TypeScript strict/ESM, vitest. `tests/config.test.ts` is pure (plain env literals, arrow `existsFn`); `tests/metrics.test.ts` is pure with an injectable clock; `tests/daemon.test.ts` is full-DI with `vi.fn()` spies.

**Spec:** GitHub issues #275 and #279.

## Global Constraints

- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Capture vitest exit explicitly — never pipe into `grep`/`tail` as the last stage. **`npm test` does not type-check**; always run `npm run typecheck` too.
- **Read env through an injected `env` object, never `process.env` directly.** The established signature is `env: Record<string, string | undefined> = process.env`, and non-empty checks use the `env.X && env.X.trim() !== ""` form. Only two vars in the whole codebase read `process.env` directly (`JUNCO_LOG_JSON`, `JUNCO_RENDER_COUNT`) and neither affects paths.
- Every side effect behind an injectable `*Deps` seam.
- New `Config` fields go in `tests/helpers/config.ts` and nowhere else. (This plan adds none.)
- **Do not add a field to `MetricsSnapshot`.** Three test files build it as an exhaustive literal (`tests/healthServer.test.ts`, `tests/localSnapshotDaemon.test.ts`, `tests/queueStats.test.ts`), so a new field means edits in all of them. This plan persists the existing shape unchanged.
- Conventional commits, suite green at every commit, no AI-attribution trailers.
- Branch `feat/config-env-metrics` off `main` @ `df59d16`.
- **Release HOLD:** no version bump, no tag, no publish.

---

### Task 1: `JUNCO_CONFIG` env override (#275)

**Files:**

- Modify: `src/config.ts` (`resolveConfigPath` and its doc comment)
- Modify: `src/dataMigrateCmd.ts` (a comment, and possibly a guard — see Step 4)
- Modify: `docs/configuration.md`
- Test: `tests/config.test.ts`, `tests/cli.test.ts`

**Interfaces:** no signature change. `resolveConfigPath(deps)` gains a first branch reading `deps.env.JUNCO_CONFIG`.

**Why:** config resolution is deliberately a pure function of the environment — never cwd, never argv (that was the split-queue incident). Scripted, CI and sandbox contexts still need to point junco at a specific config, and today the only lever is relocating `HOME`.

**Precedence: ABOVE the canonical path.** Below it, the variable would be useless on exactly the machines it exists for — any machine with a real `~/.junco/config.json` would ignore it.

**A non-existent value still wins.** `resolveConfigPath`'s contract already says the returned path may not exist (first-run detection is a separate check), and an explicit instruction should not be silently overridden by a fallback. This also lets a script name the config it is about to create. Document it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/config.test.ts`'s `resolveConfigPath` describe block, matching its pure style (plain env literals, arrow `existsFn`, no fs):

```ts
it("JUNCO_CONFIG overrides the canonical path even when the canonical file exists", () => {
  expect(
    resolveConfigPath({ existsFn: () => true, env: { HOME: "/h", JUNCO_CONFIG: "/w/cfg.json" } }),
  ).toBe("/w/cfg.json");
});

it("JUNCO_CONFIG wins even when the file does not exist (an explicit instruction)", () => {
  expect(
    resolveConfigPath({ existsFn: () => false, env: { HOME: "/h", JUNCO_CONFIG: "/w/cfg.json" } }),
  ).toBe("/w/cfg.json");
});

it("JUNCO_CONFIG expands a leading ~", () => {
  expect(
    resolveConfigPath({ existsFn: () => false, env: { HOME: "/h", JUNCO_CONFIG: "~/cfg.json" } }),
  ).toBe(join(homedir(), "cfg.json"));
});

it("an empty or whitespace JUNCO_CONFIG is ignored", () => {
  const env = { HOME: "/h", JUNCO_CONFIG: "   " };
  expect(resolveConfigPath({ existsFn: () => false, env })).toBe("/h/.junco/config.json");
});
```

Note the `~` case uses `homedir()`, not `env.HOME` — `expandHome` is deliberately `os.homedir()`-based while the rest of resolution is `env`-based. Match the existing behaviour rather than "fixing" it; the split is documented in `src/config.ts`.

In `tests/cli.test.ts`, add an end-to-end case to the `lock path derivation` describe block proving the override reaches the real `run()` **and** that the daemon lock follows it:

```ts
it("JUNCO_CONFIG relocates both the config and the worker.lock beside it", async () => {
  const acquireLockFn = vi.fn(() => makeFakeLock());
  const deps = makeDeps({
    acquireLockFn,
    loadConfigFn: vi.fn(() => stubConfig()),
    env: { HOME: "/tmp/foo", JUNCO_CONFIG: "/tmp/elsewhere/cfg.json" },
  });
  await run(["start"], deps);
  expect(acquireLockFn).toHaveBeenCalledWith(join("/tmp/elsewhere", "worker.lock"));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/config.test.ts tests/cli.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t1.txt`

Expected: FAIL — the variable is not read anywhere.

- [ ] **Step 3: Implement**

In `src/config.ts`, add the branch at the top of `resolveConfigPath` and extend the doc comment:

```ts
// An explicit JUNCO_CONFIG wins outright — above the canonical path, not
// below it. Below, the variable would be useless on exactly the machines it
// exists for (any machine with a real ~/.junco/config.json would ignore
// it). A non-existent value still wins: the contract already allows the
// returned path not to exist, and an explicit instruction should not be
// silently overridden — this also lets a script name the config it is about
// to create. Empty/whitespace is treated as unset, matching homeOf and
// legacyConfigPath. Still a pure function of the environment: no cwd, no
// argv (#275, and the split-queue incident this module was rewritten for).
const override = env.JUNCO_CONFIG;
if (override && override.trim() !== "") return expandHome(override.trim());
```

- [ ] **Step 4: Handle the two interactions — this is the part that is easy to miss**

**(a) The daemon lock follows the config.** `junco start` derives `worker.lock` as `dirname(resolve(configPath))/worker.lock`, and four other modules re-derive the same path. So `JUNCO_CONFIG` relocates the daemon-singleton identity. **That is correct** — a different config is a different instance — but it must be deliberate and documented, not incidental. Add a sentence to the doc comment saying so, and make sure the `tests/cli.test.ts` case above pins it.

**(b) The migrate command's legacy-config check.** `src/dataMigrateCmd.ts` computes `configPathIsLegacy = configPath === legacyConfigPath(env)` to decide whether to relocate the config into the canonical root. Under `JUNCO_CONFIG` the path is neither canonical nor legacy, so that phase silently never fires. **That is also correct** — an operator who named a config explicitly does not want it moved — but the current code reaches the right answer by accident. Add a comment there recording it, so a future reader does not "fix" the equality into something that would move a deliberately-placed config.

- [ ] **Step 5: Document it**

Add `JUNCO_CONFIG` to `docs/configuration.md` wherever environment variables or config resolution are described (read the file and find the right section — do not invent a new one). Cover: it overrides everything; `~` expands; empty is ignored; and **the `worker.lock` consequence**, since that is the surprising part for anyone running two junco instances.

- [ ] **Step 6: Run the tests and commit**

```bash
npx vitest run tests/config.test.ts tests/cli.test.ts tests/dataMigrateCmd.test.ts > /tmp/t1b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t1b.txt
npx prettier --write src/config.ts src/dataMigrateCmd.ts docs/configuration.md tests/config.test.ts tests/cli.test.ts
git add src/config.ts src/dataMigrateCmd.ts docs/configuration.md tests/config.test.ts tests/cli.test.ts
git commit -m "feat(config): JUNCO_CONFIG environment override

Config resolution stays a pure function of the environment — never cwd,
never argv — but scripted, CI and sandbox contexts need to name a config
without relocating HOME. The override sits ABOVE the canonical path
(below it, it would be ignored on exactly the machines it exists for) and
a non-existent value still wins, so a script can name the config it is
about to create. The daemon's worker.lock follows it, which is the
intended single-instance semantics and is now documented."
```

---

### Task 2: A debounced `metrics.json` writer (#279)

**Files:**

- Create: `src/metricsWriter.ts`
- Test: `tests/metricsWriter.test.ts`

**Interfaces:**

- Produces: `makeMetricsWriter(file: string, deps?: MetricsWriterDeps): MetricsWriter` with `MetricsWriter = { write(snap: MetricsSnapshot): void; flush(snap: MetricsSnapshot): void }`.
  - `write` is **debounced** — it persists at most once per interval.
  - `flush` writes unconditionally (startup stamp and shutdown).
- Consumes: `MetricsSnapshot` (type-only import from `src/metrics.ts` — do **not** import the singleton).

**Why:** `metrics.json` is already declared in both data-tree layouts, already denied to the agent sandbox, already has a migration pair, and is already stat'd by `junco data` — but nothing writes it, so it always reports `(absent)`.

**Why debounced:** the two hottest producers are `setTaskProgress` (once per agent turn) and `recordPoll` (once per poll tick). Writing on every mutation would be several writes a second during an active ticket, for a file nothing reads in-process — the health endpoint serves the live snapshot from memory.

**Model it on `src/spendLedger.ts`** — same file: `mkdir -p`, sibling `.tmp`, `rename`; same injected-fs shape (`readFileFn`/`writeFileFn`/`renameFn`/`mkdirFn`/`now`). Read it before writing this. This writer is write-only (no read path needed).

- [ ] **Step 1: Write the failing tests**

Create `tests/metricsWriter.test.ts`, pure with injected fs and clock (no real filesystem):

```ts
it("flush writes the snapshot atomically: tmp then rename", () => {
  /* assert write to a .tmp sibling, then rename onto the real path */
});
it("flush mkdir -p's the parent first", () => {
  /* … */
});
it("write persists the first call immediately", () => {
  /* … */
});
it("write skips a second call inside the debounce window", () => {
  /* advance the clock a little; expect one write */
});
it("write persists again once the window has passed", () => {
  /* advance past the interval; expect two writes */
});
it("flush always writes, even inside the debounce window", () => {
  /* … */
});
it("a write failure never throws", () => {
  /* writeFileFn throws; expect no throw */
});
it("serializes the snapshot as pretty JSON with a trailing newline", () => {
  /* match the repo's other JSON writers */
});
```

The failure-swallowing case matters: this is observability, and a full disk or a read-only mount must never take the daemon down.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/metricsWriter.test.ts > /tmp/t2.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t2.txt`

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/metricsWriter.ts` with a header explaining: what the file is for (an out-of-process view of daemon state — nothing in-process reads it, the health endpoint serves memory), why writes are debounced (the per-turn/per-tick producers), why failures are swallowed (observability must not fail the daemon), and the `pid`/`startedAt` staleness story — a reader must treat the file as belonging to that pid and check liveness itself.

Use a module constant for the interval (not a `Config` field — this is not an operator knob). Something around 10 seconds is right: far slower than the producers, far faster than a human refreshing.

- [ ] **Step 4: Run the tests and commit**

```bash
npx vitest run tests/metricsWriter.test.ts > /tmp/t2b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t2b.txt
npx prettier --write src/metricsWriter.ts tests/metricsWriter.test.ts
git add src/metricsWriter.ts tests/metricsWriter.test.ts
git commit -m "feat(metrics): debounced atomic writer for metrics.json

metrics.json is declared in both layouts, sandbox-denied, migrated and
reported by 'junco data' — but nothing wrote it. Same discipline as the
spend ledger (mkdir -p, sibling tmp, rename), debounced because the
hottest producers fire per agent turn and per poll tick, and
failure-swallowing because observability must never take the daemon down."
```

---

### Task 3: Wire the writer into the daemon (#279)

**Files:**

- Modify: `src/daemon.ts` (`MainLoopDeps`, the dep resolution block, startup, the poll tick, the shutdown `finally`)
- Modify: `CHANGELOG.md`
- Test: `tests/daemon.test.ts`

**Interfaces:**

- Produces: `MainLoopDeps.metricsWriter?: Pick<MetricsWriter, "write" | "flush">` — absent means the daemon builds its own.

**Why this wiring shape:** the spend ledger is the exact precedent, three lines away — `const spend = deps.spend ?? makeSpendLedger(dataTreePaths(cfg).spendFile);`. Copy it, including the important detail that it binds against the **frozen startup `cfg`**, not `activeCfg()`: `dataDir` is a restart-kind lever, so a live config reload must not move the file mid-run.

**Three write points:**

1. **Startup** — `flush` right after `metrics.markStarted()`, so the file exists and carries the new pid as soon as the daemon is up.
2. **Poll tick** — `write` (debounced) next to `metrics.recordPoll()`. Note there are **two** poll sites: the serial loop and the scheduler's. Wire both, or say which you did and why.
3. **Shutdown** — `flush` in the `finally` that already closes the health server, so the last state is durable.

- [ ] **Step 1: Write the failing tests**

In `tests/daemon.test.ts`'s observability describe block (which already resets the metrics singleton in `beforeEach`/`afterEach`), using the file's `makeDeps({...})` builder:

```ts
it("writes metrics at startup and flushes on shutdown", async () => {
  /* inject a fake metricsWriter; assert flush called at least twice */
});
it("writes metrics on the poll tick", async () => {
  /* assert write called */
});
it("binds the writer to the frozen config's data dir, not a reloaded one", async () => {
  /* … */
});
```

Adapt to the file's actual fixtures. For the third, follow how the existing tests exercise `configHolder`/frozen-config behaviour — read them first rather than inventing a mechanism.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/daemon.test.ts > /tmp/t3.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t3.txt`

Expected: FAIL — no such dep.

- [ ] **Step 3: Wire it**

Add the dep to `MainLoopDeps` with a doc comment in the surrounding style, resolve it next to `spend`, and add the three call sites. Keep the daemon's existing behaviour otherwise untouched — in particular, do not make a write failure observable in the loop.

- [ ] **Step 4: Full gate and changelog**

Add under `## [Unreleased]` → `### Added` in `CHANGELOG.md` (Keep a Changelog order; create the subsection only if absent; **no version heading, no version bump, `package.json` untouched**):

```markdown
- `JUNCO_CONFIG` names the config file explicitly, for scripted, CI and sandbox contexts. It overrides the canonical `~/.junco/config.json` (a leading `~` expands; an empty value is ignored), and the daemon's `worker.lock` follows it — so two configs mean two independent instances. Config resolution otherwise remains a pure function of the environment, never the working directory.
- The daemon now writes `data/metrics.json` — the counters `junco status` and the dashboard read over `/health`, persisted for out-of-process readers. Written atomically, debounced, and stamped at startup and shutdown; a write failure is logged and never interrupts the worker.
```

```bash
npx prettier --write src/daemon.ts tests/daemon.test.ts CHANGELOG.md
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/gate.txt 2>&1; echo "vitest exit: $?"; tail -8 /tmp/gate.txt
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts CHANGELOG.md
git commit -m "feat(daemon): persist metrics.json at startup, on tick, and at shutdown

Wired next to the spend ledger and bound to the FROZEN startup config —
dataDir is a restart-kind lever, so a live reload must not move the file
mid-run. Debounced on the poll tick; unconditional at startup and in the
shutdown finally so the last state is durable."
```

---

## Self-review

**Spec coverage:** #275 is Task 1, including both interactions the issue does not mention (the `worker.lock` derivation and the migrate legacy-config comparison). #279 is Tasks 2-3.

**Placeholder scan:** no TBDs in the production steps. Task 2 Step 1 and Task 3 Step 1 give test _names and intents_ rather than literal bodies — deliberate, because both files have strong existing fixture conventions the implementer must read and match, and the briefs say so explicitly.

**Type consistency:** `makeMetricsWriter`/`MetricsWriter`/`MetricsWriterDeps` are defined in Task 2 before Task 3 consumes them. `MetricsSnapshot` is imported type-only and **not modified**, so the three exhaustive test literals stay valid. `resolveConfigPath`'s signature is unchanged, so its single call site needs no edit. No `Config` field is added.

**Ordering dependency:** Task 2 before Task 3. Task 1 is independent of both.

**Known judgment calls (flag in the PR):** (1) `JUNCO_CONFIG` sits above the canonical path and a non-existent value still wins; (2) it deliberately relocates `worker.lock`, so two configs mean two instances; (3) migrate's config-relocation phase deliberately does not fire under it; (4) the debounce interval is a module constant, not an operator knob; (5) a metrics write failure is swallowed — observability must never fail the daemon.
