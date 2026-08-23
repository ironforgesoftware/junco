# One daemon per data tree and per queue (#310) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #310 — stop two daemons running over one queue — **without moving `worker.lock`**.

**Architecture:** `worker.lock` is derived from the config file's directory and stays exactly where it is. The daemon additionally takes two pidfile claims in the **shared state** it actually contends for: one at the resolved data root, one at the resolved queue root. Two daemons that disagree about where the config lives but agree about where the *tickets* live now collide on those.

**Tech Stack:** TypeScript strict/ESM, vitest. `acquirePidfileLock` (`src/pidfileLock.ts`) already implements exactly this pattern for `migrate.lock`.

**Spec:** GitHub issue #310 and its comment.

## Global Constraints

- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. **Capture the vitest exit code explicitly** — never pipe into `grep`/`tail` as the last stage. `npm test` does NOT type-check; always run `npm run typecheck` too.
- Every side effect behind an injectable `*Deps` seam; read env through an injected `env` object.
- New `Config` fields go in `tests/helpers/config.ts` and nowhere else. **This plan adds none.**
- Conventional commits, suite green at every commit, **no AI-attribution trailers**. No version bump (release HOLD).
- Branch `fix/lock-keyed-to-data-tree` off `main` @ `436a78e`.
- **This repo doubles as the maintainer's live runtime.** Every test that touches a lock must inject its paths — a test that acquires a real lock under the maintainer's `~/.junco` could block their daemon.

## The ruling: we do NOT implement the fix the issue proposes

#310 says "key the lock to the resolved `dataDir`". **We are not doing that, and the reason matters.**

A bare re-key makes one upgrade path *strictly worse than today*: the new binary acquires `<dataDir>/worker.lock` while an old-binary daemon holds `<configdir>/worker.lock`, so during the upgrade window two daemons start where previously one was refused. That is the very bug being fixed, fired by an upgrade instead of a misconfiguration.

The three obvious transitions were each evaluated and rejected:

- **Move it during `junco data migrate`** — category error. A pidfile has no durable content to carry across, migrate *refuses while a daemon is live* so at the moment it could act there is nothing to move, and a custom-`dataDir` install is under no obligation to ever run migrate.
- **Write `dataDir` into the payload and refuse when a live holder names the same tree** (the issue comment's suggestion, and mine) — **unimplementable as stated**. To read a live holder's payload you must first *find* its lock file, which under the current keying sits beside a config file this process has never heard of. There is no registry to enumerate. The only location every instance of a shared queue can agree on is the shared tree itself.
- **Dual-path deprecation window** — asymmetric and un-closable. The *old* binary cannot be taught to look at the new path, so a rollback beside a live new daemon still doubles up; and no one can prove every install has restarted, so the dual check never ends.

**And the decisive one: a bare re-key breaks `junco update` on the very installs whose lock moves.** `updateCmd.ts:141` → `restartCmd.ts:173` poll the *old* path while the restarted daemon writes the *new* one, so `restartCmd.ts:206` reports `lock holder did not change within 15s` and exits 1 **on a successful upgrade** — and the operator's natural remedy, `junco start`, then succeeds into a second daemon. It is invisible on a default install, and **the suite cannot catch it**: the `restartCmd`/`updateCmd`/`ensureDaemon` tests inject `lockHolderFn` closures that ignore the path entirely.

**The affected population is not exotic.** The lock moves for an explicit `dataDir`, an explicit `observability.stateDir`, a `JUNCO_CONFIG` override — and for any install that upgraded past 0.10 and has simply not run `junco data migrate` yet. That last shape requires no misconfiguration at all.

**What we do instead is additive and monotonic:** `worker.lock` keeps doing its current job unchanged, and two new claims are added in the shared tree. Nothing moves, so there is no window in which protection is *lost* — the worst case during an upgrade is today's behaviour.

**Naming is load-bearing: the new claims must NOT be called `worker.lock`.** On a default install `dataDir === dirname(configPath)`, so a same-named claim would have the process contend with itself and refuse to start. This is the single easiest way to break this change.

---

### Task 1: one spelling of the lock paths

**Files:** Modify `src/config.ts` (or wherever the helper best lives — justify), and the six modules that derive the path. Test: `tests/config.test.ts`.

**Interfaces — Produces:**

```ts
/** Every pidfile path the daemon singleton uses, derived once. */
export interface DaemonLockPaths {
  /** Beside the resolved config — unchanged, the existing worker.lock. */
  worker: string;
  /** The shared data root's claim. NEVER named worker.lock (see below). */
  dataTree: string;
  /** The shared queue root's claim. */
  queue: string;
}
export function daemonLockPaths(configPath: string, cfg: Pick<Config, "dataDir" | "queueRoot">): DaemonLockPaths;
```

**Why first:** nine expressions across six modules construct the lock path today, and **`doctor.ts:808` omits `resolve()` while every other site includes it** — a second spelling that already disagrees for a relative path. Collapsing them is unambiguously right regardless of the rest of this plan, and it eliminates that bug as a side effect.

**Two constraints the call sites impose — check both before designing the signature:**

- **`cli.ts:437` has no `cfg` in scope.** It reads the lock holder from a resolved config *path* alone, before any config is loaded. So the helper cannot require a `Config` for the `worker` path — that one must be derivable from `configPath` by itself, with the two tree claims available only where a `cfg` exists. Split the signature rather than forcing a config to be loaded early.
- **`tests/cli.test.ts:39`'s `stubConfig()` has no `dataDir`.** Adding one may be the right move, but say so explicitly — it is a shared fixture and the blast radius belongs in the report.

The nine sites: `cli.ts:703` (acquire), `cli.ts:437`, `cli.ts:817`, `cli.ts:1152`, `doctor.ts:808`, `ensureDaemon.ts:50`, `restartCmd.ts:173`, `updateCmd.ts:141`, `dataMigrateCmd.ts:833`. Comment-only references that must stay true: `config.ts:171-181`, `config.ts:214-223`, `statusCmd.ts:24`, `githubOutbox.ts:469`, and **`daemon.ts:767-771`** — whose #281 item-7 safety argument depends verbatim on the current derivation, so re-read it and confirm it still holds.

- [ ] **Step 1: Write the failing tests** — the helper returns all three paths; `worker` is byte-identical to today's `dirname(resolve(configPath))/worker.lock` for absolute and relative inputs; `dataTree` and `queue` are **not** named `worker.lock`; and on a default install (where `dataDir === dirname(configPath)`) the three paths are pairwise distinct.

  That last assertion is the one that matters — it is what stops the self-contention bug.

- [ ] **Step 2:** verify they fail. **Step 3:** implement and rewire all nine derivations onto it. **Behaviour must be byte-identical** except `doctor.ts` gaining the missing `resolve()` — call that out explicitly as the one intended change.
- [ ] **Step 4:** verify green, typecheck, commit — `refactor(lock): one helper for every daemon pidfile path`.

**Falsification:** revert one call site to its inline derivation and confirm a test catches it.

---

### Task 2: claim the data root

**Files:** Modify `src/cli.ts` (the `start` branch). Test: `tests/cli.test.ts`.

Immediately after `worker.lock` is acquired, acquire `daemonLockPaths().dataTree` via `acquirePidfileLock` (`src/pidfileLock.ts` — the same primitive `migrate.lock` uses). **Release it in the same `finally` that releases `worker.lock`** — a claim that outlives its process is a stale lock the next start has to steal.

On failure to acquire: refuse to start, naming the holder's pid and the shared root. The message must make the situation legible — the operator's two configs look independent to them, and the whole point is to say why they are not.

- [ ] **Step 1: Write the failing tests** — (a) a second start against the same `dataDir` but a *different* config path refuses, naming the pid; (b) a normal single-instance start still succeeds; (c) the claim is released on shutdown, including on a mid-startup throw; (d) **a default install where `dataDir === dirname(configPath)` starts fine** — the self-contention regression test.
- [ ] **Steps 2-4.** Commit — `feat(daemon): claim the data root so two configs cannot share one tree`.

**Falsification:** rename the claim to `worker.lock` and confirm test (d) fails. That mutation is the exact mistake this design invites.

---

### Task 3: claim the queue root

**Files:** Modify `src/cli.ts`. Test: `tests/cli.test.ts`.

Same treatment for `daemonLockPaths().queue`.

**This covers a shape the issue's own proposed fix misses entirely.** With a legacy `vaultRoot`, `queueRoot` lives *outside* `dataDir` — so two configs with different data roots but the same vault queue would both start and both poll the same tickets. "One daemon per data tree" does not catch that; "one daemon per queue" does, and the queue is the thing whose corruption actually loses work.

- [ ] Skip or dedupe when the queue claim resolves to the same file as the data-tree claim (the default layout puts `queue/` under `dataDir`, so the two files are distinct but adjacent — confirm which and state it).
- [ ] **Steps 1-4.** Commit — `feat(daemon): claim the queue root so a shared vault queue cannot be double-polled`.

---

### Task 4: migrate's guard reads the new claims

**Files:** Modify `src/dataMigrateCmd.ts` (phase 1a). Test: `tests/dataMigrateCmd.test.ts`.

Migrate refuses while a daemon appears to be running, judged by a `/health` answer and a live `worker.lock` holder. Under `JUNCO_CONFIG` that pidfile check reads a **different file** from the one a running daemon holds, so it silently misses — the second symptom recorded on #310.

Add the data-tree and queue claims **alongside** the existing `worker.lock` read, not as a replacement. Two signals: during the upgrade window `worker.lock` still catches an old daemon; afterwards the new claims catch a `JUNCO_CONFIG` peer.

- [ ] **Steps 1-4.** Commit — `fix(migrate): the daemon guard sees a peer that resolved a different config`.

---

### Task 5: docs and CHANGELOG

**Files:** `ARCHITECTURE.md`, `docs/configuration.md`, `CHANGELOG.md`.

`docs/configuration.md` currently warns that two configs over one `dataDir` mean two daemons on one queue "which corrupts it" — that warning was added by #307 and is now **out of date**: the collision is refused. Correct it rather than leaving a warning about a hazard that no longer exists.

Check `ARCHITECTURE.md` for the lock's stated contract and update it. Do this last so it describes the final code.

- [ ] Commit — `docs: the daemon singleton is per data tree and per queue`.

---

## Final verification

- [ ] Full gate, five exit codes captured separately.
- [ ] **Reproduce the issue's own scenario end-to-end** in a sandboxed `HOME`: two configs at different paths sharing one `dataDir`; confirm the second `junco start` refuses and names the first daemon's pid. This is the acceptance test for the whole plan — if it does not refuse, nothing else here matters.
- [ ] Confirm a default single-instance install still starts, stops, and restarts cleanly.
