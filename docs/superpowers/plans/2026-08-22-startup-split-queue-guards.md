# Split-queue startup guards (WS-5, #274 + #273) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #274 (warn at startup and in `doctor` when the resolved queue is empty while another known queue root holds tickets) and #273 (refuse the setup walkthrough when a daemon is live or the resolved data tree is already populated).

**Architecture:** Both issues come from the same 2026-08-01 incident: the dashboard wrote tickets to one queue root while the worker polled another, and both sides reported healthy. #274 adds the detector that would have caught it after the fact; #273 closes the door that caused it. They share one new primitive — an enumerator of every queue root junco has ever used — which does not exist today.

**Tech Stack:** TypeScript strict/ESM, vitest. Config resolution is a pure function of the environment with injectable `existsFn`/`readdirFn` seams.

**Spec:** GitHub issues #274 and #273 (both trace to PR #272).

## Global Constraints

- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. **Capture the vitest exit code explicitly** — never pipe into `grep`/`tail` as the last stage: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`. `npm test` does NOT type-check; always run `npm run typecheck` too.
- Every side effect behind an injectable `*Deps` seam. Read env through an injected `env` object, never `process.env`.
- New `Config` fields go in `tests/helpers/config.ts` and nowhere else. **This plan adds none.**
- Ink/TUI tests: never assert one fixed `setTimeout` tick after a state change — loop-until-condition with a bounded retry. `src/tui/**` runs `eslint-plugin-react-hooks` with both rules at **error**; fix deps by stabilizing the source, never `eslint-disable`.
- Conventional commits, suite green at every commit, **no AI-attribution trailers**. No version bump (release HOLD).
- Branch `feat/startup-split-queue-guards` off `main` @ `dc86b27`.
- **Keep out of PR #305's way** in `src/doctor.ts`: it inserts a warn between `:222` and `:224` and rewrites the `./config.js` and `./dataMigrate.js` import lines. Do not touch the 2a→2c gap or those imports.

---

### Task 1: `knownQueueRoots` — enumerate every queue root junco has ever used

**Files:**

- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces — Produces:**

```ts
export interface KnownQueueRoot {
  /** Absolute path to the queue root (the dir holding inbox/processing/...). */
  root: string;
  /** Operator-facing label, e.g. "canonical", "legacy data root", "vault". */
  label: string;
  /** True for the root the running config actually resolves to. */
  resolved: boolean;
}
/** Every queue root this installation could plausibly own, deduped, with the
 *  resolved one flagged. Pure: no I/O, no cwd, no argv. */
export function knownQueueRoots(
  cfg: Pick<Config, "queueRoot">,
  env?: Record<string, string | undefined>,
): KnownQueueRoot[];
```

**Why this is its own task:** no enumerator exists. All four roots collapse into one expression at `src/config.ts:570` (`nVault ? join(expandHome(vaultRoot), juncoSubdir) : join(dataDir, "queue")`), with `dataDir` from `resolveDataRoot` (`:516-537`). The nearest kin are `dataRootPairs` (`src/dataMigrate.ts:181`, which yields _pairs_ and deliberately drops the identity `queue` pair) and module-private `queueSteps` (`src/dataMigrateCmd.ts:201`). `queuePaths(cfg)` (`:720`) only fans one root into four boxes and structurally cannot express a second root.

The four roots to cover: canonical `~/.junco/queue` (`:532`); legacy data root `~/.local/state/junco/queue` (`:527-530`); legacy vault `<vaultRoot>/<juncoSubdir>` (default subdir `"Junco"`, `:255`); and an explicit `dataDir`/`stateDir` override (`:523`).

**Dedupe by resolved path**, not by label — on a machine where the canonical and override paths coincide, one entry must come back, flagged `resolved`, not two.

- [ ] **Step 1: Write the failing tests** in `tests/config.test.ts`, pure style (plain env literals, no fs):

```ts
it("enumerates canonical, legacy data root, and vault, flagging the resolved one", () => {
  const roots = knownQueueRoots({ queueRoot: "/h/.junco/queue" }, { HOME: "/h" });
  expect(roots.map((r) => r.root)).toContain("/h/.junco/queue");
  expect(roots.find((r) => r.root === "/h/.junco/queue")?.resolved).toBe(true);
  expect(roots.filter((r) => r.resolved)).toHaveLength(1);
});

it("dedupes roots that resolve to the same path", () => {
  const roots = knownQueueRoots({ queueRoot: "/h/.junco/queue" }, { HOME: "/h" });
  expect(new Set(roots.map((r) => r.root)).size).toBe(roots.length);
});

it("always includes the resolved root even when it matches no known shape", () => {
  const roots = knownQueueRoots({ queueRoot: "/somewhere/odd" }, { HOME: "/h" });
  expect(roots.find((r) => r.root === "/somewhere/odd")?.resolved).toBe(true);
});

it("is a pure function of its inputs — no cwd, no argv", () => {
  const a = knownQueueRoots({ queueRoot: "/h/.junco/queue" }, { HOME: "/h" });
  const b = knownQueueRoots({ queueRoot: "/h/.junco/queue" }, { HOME: "/h" });
  expect(a).toEqual(b);
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/config.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"`. Expected: FAIL, `knownQueueRoots` is not exported.
- [ ] **Step 3: Implement.** Reuse the existing resolution helpers rather than re-deriving path shapes — a second spelling of "where the legacy root is" is exactly the drift this codebase keeps getting bitten by.
- [ ] **Step 4: Verify green, `npm run typecheck`, commit** — `feat(config): knownQueueRoots enumerates every queue root`.

---

### Task 2: the split-queue detector

**Files:**

- Create: `src/splitQueue.ts`
- Test: `tests/splitQueue.test.ts`

**Interfaces — Consumes** Task 1's `knownQueueRoots`. **Produces:**

```ts
export interface SplitQueueFinding {
  resolvedRoot: string;
  /** Other roots that hold pending tickets, with counts. */
  others: { root: string; label: string; pending: number }[];
}
export interface SplitQueueDeps {
  listInbox?: (dir: string) => string[]; // ENOENT-tolerant
}
/** Non-null only when the resolved queue has NO pending tickets and at least
 *  one other known root does. Null in every other case — including "everything
 *  is empty" (a fresh install) and "the resolved queue has work". */
export function detectSplitQueue(
  cfg: Pick<Config, "queueRoot">,
  env?: Record<string, string | undefined>,
  deps?: SplitQueueDeps,
): SplitQueueFinding | null;
```

**Ruling — count `inbox/` only, never `done/` or `failed/`.** This is the single most important decision in #274 and the issue text does not make it. A machine that has legitimately completed `junco data migrate` keeps a permanently non-empty legacy `done/`; counting terminal boxes would fire this warning on _every start, forever_, on exactly the well-maintained installs that did the right thing. A warning that always fires is a warning operators learn to ignore, which is worse than no warning. Count `inbox/` (the actionable backlog). `processing/` may be included — decide and state why in the report; a stale `processing/` entry on another root is also a real split-queue signal, but it is likelier to be crash residue.

**Fresh installs must stay silent.** All-empty returns `null`.

- [ ] **Step 1: Write the failing tests** — `tests/splitQueue.test.ts`, injected `listInbox`, synthetic paths:

```ts
it("returns null when every known root is empty (a fresh install must stay silent)", () => {
  /* … */
});
it("returns null when the resolved root has pending tickets", () => {
  /* … */
});
it("reports the other root when the resolved one is empty and another holds tickets", () => {
  /* … */
});
it("ignores done/ and failed/ — a completed migrate leaves those populated forever", () => {
  // listInbox is only ever asked for inbox; assert it is never called with a
  // done/ or failed/ path, so the implementation cannot quietly start counting them.
});
it("tolerates a missing directory (ENOENT) without throwing", () => {
  /* … */
});
```

That fourth test is load-bearing: it pins the ruling above against a future "let's also count done/" change.

- [ ] **Step 2-4:** verify fail, implement, verify green, typecheck, commit — `feat(queue): detect a split queue across known roots`.

---

### Task 3: warn at daemon startup

**Files:**

- Modify: `src/daemon.ts`
- Test: `tests/daemon.test.ts`

**Insertion point: after the collaborator block ends (`src/daemon.ts:634`) and BEFORE `migLock` (`:651`).**

**Why exactly there — this is easy to get wrong.** The startup order is: migrate (`:656`) → `mkdirs`/`ensureDataTree` (`:671`) → skill links (`:678`) → `recoverOrphans` (`:692`, destructive) → `pruneStaleWorktrees` (`:693`, destructive) → `waitForEndpoint` (`:694`) → "worker online" (`:696`) → health bind (`:706`). **`ensureDataTree` creates the resolved queue**, so a check placed after it degrades from "your tickets are in the other root" to "you have no tickets yet" — the detector still works, but the operator loses the signal that something is wrong. It must also precede both destructive steps.

Match the existing prominent-warning idiom at `src/cli.ts:576-580`: prose message plus structured path fields plus an `advice:` field. Logger API: `src/logging.ts:179-184`.

**The message must name both paths and a remedy.** A warning that says "something is off" without saying what to do is the kind operators route to /dev/null.

- [ ] **Step 1: Write the failing test** in `tests/daemon.test.ts` (full-DI, `vi.fn()` spies): a config whose resolved queue is empty while another known root holds tickets logs a warning naming both paths, and the warning is emitted **before** `recoverOrphans` and before `ensureDataTree`. Assert ordering with `mock.invocationCallOrder`, not just presence — presence alone would pass if the warning moved after the destructive steps.
- [ ] Also test the negative: a normal single-root install logs nothing.
- [ ] **Step 2-4:** verify fail, implement, verify green, typecheck, commit — `feat(daemon): warn at startup when another queue root holds tickets`.

---

### Task 4: the same cross-check in `doctor`

**Files:**

- Modify: `src/doctor.ts`
- Test: `tests/doctor.test.ts`

Slot it as check **7-bis, immediately after `src/doctor.ts:529`**. `doctor` is a flat script with a local `report(v, label, detail)` closure (`:181-186`); warns never affect the exit code (`:700-703`), which is correct here — a split queue is an operator decision, not a broken install. The `existsFn`/`readdirFn` deps already exist (`:177-178`); reuse them rather than adding new ones.

**Stay out of PR #305's way:** it adds a warn between `:222` and `:224` and rewrites the `./config.js` / `./dataMigrate.js` import lines. Keep this diff at 7-bis and do not reorganize imports.

- [ ] **Steps 1-4:** failing test (a split queue reports a warn naming both roots; a normal install reports pass), verify fail, implement, verify green, commit — `feat(doctor): report a split queue across known roots`.

---

### Task 5: gate the setup walkthrough (#273)

**Files:**

- Modify: `src/cli.ts` (the FTUE door)
- Test: `tests/cli.test.ts`

**The door is `src/cli.ts:887`:** `!existsFn(resolve(configPath))` → `runDashboardFn(null, …)`. The `null` is the fresh-FTUE signal.

**Ruling — gate ONLY the fresh path, never the re-run path.** The issue says the FTUE "must refuse to run" when a daemon is live. Taken literally that would also block the _re-run_ path, and that would be a serious mistake: re-run mode reads and writes back the **same** file (`src/wizard.ts:100-118`, `:193-199`) and is therefore structurally incapable of creating the competing config the incident was about. Only `mode === "fresh"` (`:182-191`) can. There is no `junco setup` subcommand (`src/tui/usePalette.ts:56-58`), so the walkthrough is the _only_ door an operator has for fixing a broken config — refusing it while a daemon happens to be running would lock them out of the one tool that fixes their problem. Gate `cfg === null` only.

**Ruling — refuse on a live daemon; refuse on a populated data tree with a distinct message.** Both signals are cheap and authoritative:

- Daemon liveness: `fetchHealthBody(cfg, deps)` (`src/tui/healthBody.ts:34`) returns `HealthBody | null`, 1500 ms timeout (`HEALTH_TIMEOUT_MS`, `src/config.ts:13`), defaults `127.0.0.1:8787`. There is no config to read here, so obtain defaults config-free via `assembleConfig(ConfigSchema.parse({}), env)`. Cheaper config-free peer worth using as a first probe: `readLockHolder(join(dirname(resolve(configPath)), "worker.lock"))` (`src/lock.ts:47`).
- Populated tree: `dataRootHasTree(root, existsFn)` (`src/config.ts:106`) against `resolveDataRoot(undefined, env, existsFn).dataDir`, which `buildWizardIO` already computes (`src/wizard.ts:145-149`).

**Note this also closes a live finding from PR #307's review:** a typo'd `JUNCO_CONFIG` currently routes bare `junco` into the FTUE and writes a fresh config, because no file exists at the typo'd path. A populated data tree with no config at the resolved path is exactly that situation, and refusing there turns a silent competing-config into a readable error.

**`buildWizardIO` is synchronous** (`src/wizard.ts:80`), so an async health probe cannot live there. Gate at `src/cli.ts:887` (or `src/dashboardCmd.ts:56`).

**Exit code 1, not 130** — `130` means user-cancelled (`src/dashboardCmd.ts:149`).

**The refusal must not be a dead end.** Print: what was found (the live daemon's pid/uptime, or the populated root), the resolved config path it expected, and the concrete next steps (`junco doctor`, `junco status`, and how to re-run setup deliberately once a config exists).

- [ ] **Step 1: Write the failing tests** in `tests/cli.test.ts`: (a) bare `junco` with no config but a live daemon refuses with exit 1 and names the daemon; (b) bare `junco` with no config but a populated data tree refuses and names the root; (c) bare `junco` on a genuinely fresh machine still launches the walkthrough; (d) the **re-run** path is unaffected while a daemon is live — the critical negative test.
- [ ] **Steps 2-4:** verify fail, implement, verify green, full gate, commit — `feat(cli): refuse the setup walkthrough against a live daemon or populated tree`.

---

## Final verification

- [ ] Full gate, five exit codes captured separately.
- [ ] `CHANGELOG.md` under Unreleased for both behaviours. No version bump.
- [ ] Confirm the daemon warning does **not** fire on a fresh install, by running the detector against a synthetic fresh tree — the "trained to ignore it" failure mode is the one that would quietly ruin this feature.
