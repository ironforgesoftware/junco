# Plan-sets hardening: the five smaller #298 items (WS-3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining five "Smaller" items in issue #298 (the two Priority items shipped in #302), finishing the issue.

**Architecture:** Six small, mostly independent changes across the plan-set stack: the compiler's smuggle checks, the dashboard's missing `superseded` row state, an injectable `submitFn` seam for the set path, letting a deferred/compile-failed supersede still do its maintenance pass, retrying a child stranded by a contained fan-out failure, and giving the CLI door real re-run semantics.

**Tech Stack:** TypeScript strict/ESM, vitest. `tests/planCompiler.test.ts` is fully pure; `tests/planSets.test.ts` uses a real tmpdir; `tests/planSetBridge.test.ts` drives a real fake-`gh` shell script; `tests/cli.test.ts` builds a real `~/.junco` vault with `HOME` overridden.

**Spec:** GitHub issue #298, the five unchecked items under "Smaller".

## Global Constraints

- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Capture vitest exit explicitly: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — never pipe into `grep`/`tail` as the last stage. **`npm test` does not type-check** — a merge can be suite-green and typecheck-red, so always run `npm run typecheck` too.
- **Additive-optional discipline for on-disk records.** `PlanSetRecord` is read with only a `v === 1` check, so any new field MUST be optional and absence must be safe. Records written by older builds stay valid.
- `src/ticketSchema.ts` is a stable public contract — do not touch it.
- Every side effect behind an injectable `*Deps` seam; tests never touch the network or a real model.
- New `Config` fields go in `tests/helpers/config.ts` and nowhere else. (This plan adds none.)
- Conventional commits, suite green at every commit, no AI-attribution trailers.
- Branch `fix/planset-hardening` off `main` @ `df59d16`.
- **Release HOLD:** no version bump, no tag, no publish.

---

### Task 1: Extend the compiler's smuggle checks to every free-text field

**Files:**

- Modify: `src/planCompiler.ts` — the per-task validation region (currently ~`:79-127`) and the verification-block emission in `compilePlan` (currently ~`:220-229`)
- Test: `tests/planCompiler.test.ts` (fully pure — no fs, no mocks)

**Interfaces:** no signature change. `parsePlanSet` gains error strings; `compilePlan`'s output is unchanged for well-formed input.

**Why:** `SMUGGLED_FM_RE` (`/^---\s*$/m`) is applied to exactly two fields — `shared_context` and per-task `description`. `title`, `acceptance[]`, `prohibitions[]`, and `verification` are unchecked. `verification` is the sharpest gap: `compilePlan` emits it **raw between literal ` ```bash ` fences**, so a triple backtick inside it closes the fence early and any following text lands in the child's body as ordinary markdown — and `src/verify.ts`'s global fence regex will execute a second ` ```bash ` block if the smuggled text opens one. This is defence-in-depth (the plan is human-approved and `verification` is executed as bash by design), but the asymmetry is exactly the kind that rots.

- [ ] **Step 1: Write the failing tests**

Add to `tests/planCompiler.test.ts`, following the file's existing style (YAML fence string constants fed to `parsePlanSet`):

```ts
it("refuses a frontmatter delimiter in title, acceptance, prohibitions, or verification", () => {
  for (const field of ["title", "acceptance", "prohibitions", "verification"] as const) {
    const r = parsePlanSet(planWithSmuggledDashes(field), { maxTasks: 10 });
    expect(r.ok, `${field} should be refused`).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/frontmatter delimiter/);
  }
});

it("refuses a triple backtick in verification (it would escape the bash fence)", () => {
  const r = parsePlanSet(planWithBacktickVerification(), { maxTasks: 10 });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join("\n")).toMatch(/code fence|backtick/i);
});
```

Write the two fixture builders in the file's existing idiom — a YAML fence where the named field carries a line that is exactly `---` (for the first) or contains ` ``` ` (for the second). Read the file's existing fixtures first and match them; do not invent a new helper style.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/planCompiler.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t1.txt`

Expected: FAIL — these fields are currently accepted.

- [ ] **Step 3: Check every free-text field**

In `src/planCompiler.ts`'s per-task loop, alongside the existing `description` check, add checks for the other fields. Keep the existing error wording style (`${at}: <field> contains a frontmatter delimiter (---) — frontmatter is machine-owned`). Cover: `title`, each entry of `acceptance`, each entry of `prohibitions`, and `verification`. Also add the same check to nothing else — do not touch `id` (already constrained by `TASK_ID_RE`).

Then add the fence-escape check for `verification` specifically:

````ts
// `verification` is emitted RAW between literal ```bash fences in
// compilePlan, so a triple backtick inside it closes the fence early: the
// remainder lands in the child body as prose, and verify.ts's global
// ```bash matcher will execute a second block if the smuggled text opens
// one. Refuse rather than escape — the fence is model-authored and the
// human approving the plan should see the attempt (#298).
if (verification !== null && verification.includes("```")) {
  errors.push(
    `${at}: verification contains a code fence (\`\`\`) — it is emitted inside a bash fence and would escape it`,
  );
}
````

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/planCompiler.test.ts > /tmp/t1b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t1b.txt`

Expected: PASS. The file's existing round-trip tests must still pass unchanged — a well-formed plan is unaffected.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planCompiler.ts tests/planCompiler.test.ts
git add src/planCompiler.ts tests/planCompiler.test.ts
git commit -m "fix(plansets): check every free-text plan field for smuggled delimiters

SMUGGLED_FM_RE was applied only to shared_context and description; title,
acceptance, prohibitions and verification were unchecked. verification is
the sharpest gap — it is emitted raw between literal bash fences, so a
triple backtick escapes the fence and verify.ts would execute whatever
follows as a second block."
```

---

### Task 2: Give the dashboard a `superseded` row state

**Files:**

- Modify: `src/planSets.ts` — `TaskRunState`, `TaskStatus`, `resolveSetState`, `renderDashboard`
- Test: `tests/planSets.test.ts` (real tmpdir, `record()` factory)

**Interfaces:**

- Produces: `TaskRunState` gains `"superseded"`; `TaskStatus` gains `superseded: string | null` (the pre-empting revision hash).
- Consumes: `ResultMeta.superseded` — already parsed (`src/resultMeta.ts`) and already written by `supersedeUnclaimed`. This task is purely a read-side change.

**THE TRAP — read this before writing code.** A disposed child is moved to `failed/`, so `ticketState` reports `"failed"` and the dashboard renders it as a plain failure. Introducing a distinct `"superseded"` state has two knock-on effects that MUST be handled together:

1. `anyFailed` (`tasks.some(t => t.state === "failed")`) stops counting it — **this is the intent** (a supersede must not trip the degraded comment or the `junco:failed` set label).
2. `terminal()` (`s === "done" || s === "failed"`) also stops counting it — **this is a bug** unless you widen it. `allTerminal` gates the close step, so a set containing a superseded child would never close and would be maintained forever.

Widen `terminal()` to include `"superseded"`. Do NOT widen `allDone`.

- [ ] **Step 1: Write the failing tests**

In `tests/planSets.test.ts`, using its existing tmpdir + `record()` fixtures:

```ts
it("reports a disposed child as superseded, not failed", () => {
  // a failed/ ticket whose result block carries `superseded: <hash>`
  writeFailedTicket(dirs, "t-a", "status: failed\nsuperseded: abc123");
  const state = resolveSetState(cfg, rec);
  expect(state.tasks[0].state).toBe("superseded");
  expect(state.anyFailed).toBe(false);
  expect(state.allTerminal).toBe(true);
});

it("still reports an ordinary failure as failed", () => {
  writeFailedTicket(dirs, "t-a", "status: failed");
  const state = resolveSetState(cfg, rec);
  expect(state.tasks[0].state).toBe("failed");
  expect(state.anyFailed).toBe(true);
});

it("renders a superseded row distinctly", () => {
  writeFailedTicket(dirs, "t-a", "status: failed\nsuperseded: abc123");
  const out = renderDashboard(rec, resolveSetState(cfg, rec));
  expect(out).toMatch(/superseded/);
  expect(out).not.toMatch(/`t-a` — failed/);
});
```

Adapt the fixture names to whatever the file actually provides — read it first.

The second test is the regression guard: without it, "treat every failed ticket as superseded" would pass the first test while silently suppressing every real failure.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/planSets.test.ts > /tmp/t2.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t2.txt`

Expected: FAIL — the state is `"failed"` and `anyFailed` is true.

- [ ] **Step 3: Widen the type and the resolver**

In `src/planSets.ts`:

```ts
export type TaskRunState =
  | "queued"
  | "waiting"
  | "processing"
  | "done"
  | "failed"
  | "superseded"
  | "absent";
```

Add to `TaskStatus`:

```ts
/** The plan revision that pre-empted this child before it ran (from the
 * result block's `superseded:` marker). Null for every other state. */
superseded: string | null;
```

In `resolveSetState`'s `done`/`failed` branch, read the marker and reclassify:

```ts
const meta = parseResultMeta(readFileSync(f, "utf8"));
prUrl = meta.prUrl;
dependencyFailed = meta.dependencyFailed;
superseded = meta.superseded;
// A disposed child was pre-empted by a plan edit — it never ran, so it
// is NOT a failure: counting it would trip the degraded comment and the
// set-level junco:failed label for what is ordinary set re-cycling
// (#298). It IS terminal, though — see the widened terminal() below.
if (st === "failed" && superseded !== null) state = "superseded";
```

Declare `let superseded: string | null = null;` alongside the existing locals, return it in the task object, and widen:

```ts
const terminal = (s: TaskRunState): boolean => s === "done" || s === "failed" || s === "superseded";
```

Leave `allDone`, `anyProcessing`, and `anyFailed` expressions untouched — `anyFailed` now excludes superseded children for free.

- [ ] **Step 4: Render the row**

In `renderDashboard`'s per-row branch, add alongside the existing `failed`/`waiting` branches:

```ts
if (t.state === "superseded")
  detail = t.superseded ? `superseded — pre-empted by rev \`${t.superseded}\`` : "superseded";
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/planSets.test.ts tests/planSetBridge.test.ts > /tmp/t2b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t2b.txt`

Expected: PASS. The bridge suite matters here — the degraded-comment and label tests exercise `anyFailed`, and the close step exercises `allTerminal`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/planSets.ts tests/planSets.test.ts
git add src/planSets.ts tests/planSets.test.ts
git commit -m "feat(plansets): render a disposed child as superseded, not failed

A child pre-empted by a plan edit is moved to failed/ with a superseded
marker, so the dashboard showed it as an ordinary failure and anyFailed
counted it — tripping the degraded comment and the set-level failed label
for what is routine set re-cycling. terminal() is widened alongside, or a
set containing a superseded child would never reach allTerminal and would
be maintained forever."
```

---

### Task 3: An injectable `submitFn` seam for the set path

**Files:**

- Modify: `src/planSets.ts` (`submitPlanSet`), `src/planSetBridge.ts` (`dispatchPlanSet`, and the supersede fan-out's `submitTicket` call), `src/githubInbox.ts` (the `dispatchPlanSet` call site)
- Test: `tests/planSetBridge.test.ts`

**Interfaces:**

- Produces: `submitPlanSet(cfg, children, deps?: { submitFn?: typeof submitTicket })` and `dispatchPlanSet(cfg, repo, issueNumber, fenceBody, nowIso, deps?: { submitFn?: typeof submitTicket })`. Both default to the real `submitTicket`, so every existing call site keeps working unchanged.
- Consumes: `BridgeDeps.submitFn`, already resolved to a default inside `pollGithubInbox`.

**Why:** the single-ticket path submits through the injectable `submitFn`; the set path calls `submitTicket` as a hard module import in two places. Because of that, `tests/planSetBridge.test.ts` carries a `vi.mock("../src/dispatch.js")` boxed passthrough purely to force a submit failure — a whole-module mock standing in for a missing seam. Use `typeof submitTicket` for the option type (matching `assessCmd`/`analyzeCmd`/`externalDispatch`), not `BridgeDeps`'s looser structural signature.

- [ ] **Step 1: Write the failing test**

In `tests/planSetBridge.test.ts`, add a test that injects a counting `submitFn` through `dispatchPlanSet` and asserts it is used instead of the real one:

```ts
it("submits set children through the injected submitFn", () => {
  const calls: string[] = [];
  const r = dispatchPlanSet(cfg, repo, 7, fence, NOW, {
    submitFn: (_cfg, _content, opts) => {
      calls.push(opts?.idHint ?? "?");
      return "/fake/dst.md";
    },
  });
  expect(r.ok).toBe(true);
  expect(calls.length).toBeGreaterThan(0);
});
```

Adapt names to the file's existing fixtures.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/planSetBridge.test.ts > /tmp/t3.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t3.txt`

Expected: FAIL — `dispatchPlanSet` takes no deps parameter (a TypeScript error, and the injected function is never called).

- [ ] **Step 3: Thread the seam**

Add an optional trailing deps parameter to `submitPlanSet` and `dispatchPlanSet`, each defaulting to `submitTicket`, and use it at the call sites. Then thread `BridgeDeps.submitFn` from `githubInbox.ts` into the `dispatchPlanSet` call — the resolved `submitFn` local already exists in `pollGithubInbox`; pass `{ submitFn }`.

Also route the supersede fan-out's direct `submitTicket(cfg, c.content, { idHint: c.ticketId })` call in `planSetBridge.ts` through the same seam. `maintainPlanSets` already has a `MaintainPlanSetsDeps` — add `submitFn?: typeof submitTicket` to it and thread it down to the fan-out.

- [ ] **Step 4: Retire the whole-module mock if it is now redundant**

The `vi.hoisted` + `vi.mock("../src/dispatch.js")` block near the top of `tests/planSetBridge.test.ts` exists only because there was no seam. Rewrite the test that used it (the crash-window / submit-failure test) to inject a throwing `submitFn` instead, and delete the mock **if nothing else in the file depends on it**. Check carefully first — the mock replaces the module for the whole file. If some other test does rely on it, leave it and say so in your report.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/planSetBridge.test.ts tests/planSets.test.ts tests/githubInbox.test.ts > /tmp/t3b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t3b.txt`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/planSets.ts src/planSetBridge.ts src/githubInbox.ts tests/planSetBridge.test.ts
git add src/planSets.ts src/planSetBridge.ts src/githubInbox.ts tests/planSetBridge.test.ts
git commit -m "refactor(plansets): submit set children through an injectable seam

The single-ticket path already submits through BridgeDeps.submitFn; the
set path called submitTicket as a hard import in two places, which is why
the bridge suite had to vi.mock the whole dispatch module to force a
submit failure. Both set call sites now take an optional submitFn
defaulting to the real one."
```

---

### Task 4: Let a deferred/compile-failed supersede still run its maintenance pass

**Files:**

- Modify: `src/planSetBridge.ts` — the `if (outcome.kind === "deferred" || outcome.kind === "compile-failed") continue;` line in `maintainPlanSets`
- Test: `tests/planSetBridge.test.ts`

**Interfaces:** none.

**Why:** that `continue` skips the record's ENTIRE maintenance pass for the sweep — dashboard sync, the degraded comment, the label swap, the close step, and the persist. `deferred` is the transient case (a child is still processing), so it repeats every sweep for as long as the child runs: **the dashboard is frozen for the whole duration of a long-running child, and a failure appearing in that window posts no degraded comment.** Only the supersede itself should be skipped, not the maintenance.

Note the existing line just below already handles record selection correctly:
`const record = outcome.kind === "superseded" ? outcome.record : storedRecord;`
so a fall-through naturally uses `storedRecord` for the deferred/compile-failed cases.

- [ ] **Step 1: Write the failing test**

Add a test asserting that when `trySupersede` defers (a child is processing while the plan comment differs), the dashboard is still synced that sweep. Use the file's fake-`gh` harness and its call log:

```ts
  it("still syncs the dashboard on a sweep where the supersede defers", async () => {
    // plan comment edited (hash differs) AND a child in processing/ → deferred
    ...
    await maintainPlanSets(cfg, { nowIso: NOW });
    expect(readLog().some((l) => l.includes("junco:plan-status"))).toBe(true);
  });
```

Adapt to the harness's actual logging shape.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/planSetBridge.test.ts > /tmp/t4.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t4.txt`

Expected: FAIL — no dashboard call is made on a deferred sweep.

- [ ] **Step 3: Fall through instead of skipping**

Replace the `continue` so only the supersede is skipped:

```ts
const outcome = await trySupersede(cfg, storedRecord, g, ghFn, ll, getLogin, nowIso);
// `deferred` (a child is mid-flight) and `compile-failed` (the edit does
// not compile) skip only the SUPERSEDE — not this record's maintenance.
// Skipping the whole pass froze the dashboard for the entire duration of
// a long-running child and suppressed the degraded comment for failures
// that appeared in that window (#298). The record selection below already
// falls back to storedRecord for both outcomes.
const record = outcome.kind === "superseded" ? outcome.record : storedRecord;
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/planSetBridge.test.ts > /tmp/t4b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t4b.txt`

Expected: PASS, including the existing compile-failed tests — verify the `lastFailedHash` persistence they assert still holds (it is written inside `trySupersede` before it returns, so falling through must not overwrite it with a stale record; if the existing tests catch that, fix it and say so).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planSetBridge.ts tests/planSetBridge.test.ts
git add src/planSetBridge.ts tests/planSetBridge.test.ts
git commit -m "fix(plansets): a deferred supersede no longer skips the whole sweep

deferred/compile-failed took a continue that skipped dashboard sync, the
degraded comment, the label swap, the close step and the persist — so a
long-running child froze its set's dashboard for the entire run. Only the
supersede is skipped now."
```

---

### Task 5: Retry a child stranded by a contained fan-out failure

**Files:**

- Modify: `src/planSets.ts` (`PlanSetRecord`), `src/planSetBridge.ts` (the supersede fan-out's catch, the fresh-record literal, and `trySupersede`'s hash gate)
- Test: `tests/planSetBridge.test.ts`

**Interfaces:**

- Produces: `PlanSetRecord.pendingFanout?: string[]` — ticket ids whose `submitTicket` threw during a supersede fan-out. Additive-optional; absent means none.

**Why:** in the fan-out loop, a `submitTicket` that throws for a non-collision reason is caught, logged, and the child pushed to `skipped`. The fresh record is then written with the NEW hash — so `trySupersede`'s hash gate (`newHash === record.hash` → `unchanged`) blocks any re-trigger, and because the child never landed there is no `failed/` file for `junco retry` either. Recovery today requires editing the plan again.

**Two things the implementation must get right:**

1. **`skipped` mixes three causes** — already `done`, already landed in inbox/processing, and submit-threw. **Only the catch branch** may feed `pendingFanout`; the first two are legitimate skips.
2. **The record stores only `{id, ticketId, dependsOn}`, not compiled content.** To retry, re-read the materialized plan markdown at `plansDir(cfg)/<planId>.md` (written by `materializePlanSet`), re-run `parsePlanSet` + `compilePlan` with the record's own `hash`/`repoPath`/`github` as the compile context, and pick out the children whose ids are in `pendingFanout`.

- [ ] **Step 1: Write the failing test**

In `tests/planSetBridge.test.ts`, using the injected `submitFn` from Task 3 (no module mock needed):

```ts
it("retries a child stranded by a fan-out failure on the next sweep", async () => {
  // sweep 1: plan edited → supersede fan-out, with submitFn throwing for one child
  let failFor: string | null = "t-b";
  const submitFn = (cfg, content, opts) => {
    if (opts?.idHint === failFor) throw new Error("disk full");
    return realSubmit(cfg, content, opts);
  };
  await maintainPlanSets(cfg, { ghFn, nowIso: NOW, submitFn });
  expect(readRecord().pendingFanout).toEqual(["t-b"]);

  // sweep 2: same plan (hash unchanged, so the gate would normally skip) —
  // the stranded child must still be submitted.
  failFor = null;
  await maintainPlanSets(cfg, { ghFn, nowIso: NOW2, submitFn });
  expect(ticketState(paths, "t-b")).not.toBe("absent");
  expect(readRecord().pendingFanout ?? []).toEqual([]);
});
```

Adapt to the file's fixtures. The second half is the point: it must pass **despite** the hash being unchanged.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/planSetBridge.test.ts > /tmp/t5.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t5.txt`

Expected: FAIL — `pendingFanout` does not exist, and sweep 2 leaves the child absent.

- [ ] **Step 3: Record the stranded ids**

Add to `PlanSetRecord` (`src/planSets.ts`), with the additive-optional doc-comment style the neighbouring fields use:

```ts
  /** Ticket ids whose submit THREW during a supersede fan-out (not ids that
   * were legitimately skipped as already-landed). The fresh record carries the
   * new hash, so trySupersede's gate would otherwise block any re-trigger and
   * — since the child never landed — there is no failed/ file for `junco
   * retry` either, stranding it until the human edits the plan again (#298).
   * The next sweep retries these before the gate. Additive: absent = none. */
  pendingFanout?: string[];
```

In the fan-out loop, collect throwers separately from `skipped` and put them on the fresh record. Keep them in `skipped` too if that preserves the existing log line's meaning — but the record field must contain ONLY the throwers.

- [ ] **Step 4: Retry before the hash gate**

In `trySupersede`, before the `newHash === record.hash` early return, drain any `pendingFanout`. Re-derive the children by re-reading the materialized plan and re-compiling:

```ts
  // A previous fan-out left children un-submitted (their submit threw). The
  // hash gate below would return "unchanged" and strand them forever, so
  // drain them first. The record stores ids only, so re-read the materialized
  // plan and re-compile to recover their bodies.
  if (record.pendingFanout && record.pendingFanout.length > 0) { ... }
```

Implement it to: read `join(plansDir(cfg), `${record.planId}.md`)`; if unreadable, log a warning and clear `pendingFanout` (nothing can be done, and retrying forever is worse); otherwise `parsePlanSet` + `compilePlan` with `{ planId: record.planId, repoPath: record.repoPath, hash: record.hash, github: record.github }`; submit only children whose `ticketId` is in `pendingFanout` **and** whose `ticketState` is `absent`; remove each successfully submitted (or no-longer-absent) id; persist the record. A child that throws again stays listed for the next sweep.

Return `{ kind: "unchanged" }` afterwards if the hash is unchanged — the retry is orthogonal to the supersede decision.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/planSetBridge.test.ts tests/planSets.test.ts > /tmp/t5b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t5b.txt`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/planSets.ts src/planSetBridge.ts tests/planSetBridge.test.ts
git add src/planSets.ts src/planSetBridge.ts tests/planSetBridge.test.ts
git commit -m "fix(plansets): retry children stranded by a contained fan-out failure

A child whose submit threw mid-supersede was skipped, and the fresh
record's new hash then blocked re-triggering — with no failed/ file for
junco retry either, so only another plan edit recovered it. Throwers are
now recorded on the record and drained before the hash gate."
```

---

### Task 6: Real re-run semantics for the CLI `submit --plan` door

**Files:**

- Modify: `src/cli.ts` (the `values.plan === true` branch), `src/planSets.ts` (`submitPlanSet`'s return shape)
- Test: `tests/cli.test.ts` (plan-set block)

**Interfaces:**

- Produces: `submitPlanSet` returns `{ submitted: { ticketId: string; dst: string }[]; skipped: string[] }` — carrying the real destination `submitTicket` returned.
- Consumes: `readPlanSetRecord`, `supersedeUnclaimed` (both already exported from `src/planSets.ts`).

**Why:** the CLI door calls `materializePlanSet` unconditionally, clobbering any existing record for that `planId` (which is derived from the FILENAME, so a re-run always collides). The old children stay queued under identical ids, and `submitPlanSet`'s `!== "absent"` guard silently skips every one — so the record's `rev` advertises a revision the queue does not contain. Separately, the printed path is reconstructed as `<inbox>/<id>.md` rather than the real `dst`, so a `uniqueDest` rename would print a path that does not exist.

- [ ] **Step 1: Write the failing tests**

In `tests/cli.test.ts`'s plan-set block:

```ts
  it("re-submitting an edited plan disposes the unclaimed old children", async () => {
    // submit v1, then edit the file and submit again
    ...
    expect(await run(["submit", "--plan", f, "--repo", repo], deps)).toBe(0);
    // the v1 child that never ran is now in failed/ with a superseded marker
    expect(readFailed("plan-p-t-a")).toMatch(/superseded:/);
    // and the v2 children are queued
    expect(existsSync(join(inbox, "plan-p-t-a.md"))).toBe(true);
  });

  it("prints the real destination path", async () => {
    ...
    expect(printed.join("")).toContain(actualDstReturnedBySubmit);
  });
```

Adapt to the file's `freshDispatchVault` harness. Note the existing tests at the plan-set block assert the literal `plan-my-plan-a.md` paths — those assertions stay valid as long as no rename occurs; update them only if your change alters the output format.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/cli.test.ts > /tmp/t6.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t6.txt`

Expected: FAIL — the old children are silently skipped, and the printed path is reconstructed.

- [ ] **Step 3: Supersede on a rev change**

In `src/cli.ts`'s plan branch, before `materializePlanSet`, read any existing record and dispose its unclaimed children when the hash differs:

```ts
// A re-run with an edited plan reuses the SAME planId (it is derived
// from the filename), so without this the old children stay queued
// under identical ids and submitPlanSet skips every one — the record's
// rev would advertise a revision the queue does not contain (#298).
// Mirrors the bridge's supersede: dispose only the UNCLAIMED ones.
const prior = readPlanSetRecord(cfg, planId);
if (prior !== null && prior.hash !== hash) {
  const { disposed } = supersedeUnclaimed(cfg, prior, hash);
  if (disposed.length > 0) {
    printFn(`plan set ${planId}: superseded ${disposed.length} unclaimed ticket(s)\n`);
  }
}
```

- [ ] **Step 4: Print the real destination**

Widen `submitPlanSet`'s `submitted` to carry the destination `submitTicket` returns, and print it:

```ts
for (const s of r.submitted) printFn(`submitted: ${s.dst}\n`);
```

Update every other `submitPlanSet` caller for the new shape — grep for it first (`src/planSetBridge.ts` uses it in `dispatchPlanSet`). Keep `skipped` as `string[]`.

- [ ] **Step 5: Full gate and changelog**

Add under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md` (Keep a Changelog order; no version heading, no `package.json` change):

```markdown
- Plan sets: a disposed child now renders as `superseded` on the dashboard instead of counting as a failure; a deferred supersede no longer skips the record's whole maintenance sweep; a child stranded by a fan-out failure is retried instead of waiting for another plan edit; `junco submit --plan` supersedes the previous revision's unclaimed tickets on a re-run and prints real destination paths; and the plan compiler now refuses smuggled frontmatter delimiters in every free-text field plus code fences in `verification`.
```

```bash
npx prettier --write src/cli.ts src/planSets.ts tests/cli.test.ts CHANGELOG.md
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/gate.txt 2>&1; echo "vitest exit: $?"; tail -8 /tmp/gate.txt
```

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/planSets.ts tests/cli.test.ts CHANGELOG.md
git commit -m "fix(cli): supersede on submit --plan re-run; print real destinations

planId is derived from the filename, so a re-run with an edited plan
always collides: the record was clobbered to the new hash while the old
children stayed queued under identical ids and were silently skipped.
Unclaimed children of the prior revision are now disposed first, and the
printed paths come from submitTicket rather than being reconstructed."
```

---

## Self-review

**Spec coverage:** #298's five remaining "Smaller" items map to Tasks 5 (stranded child), 6 (CLI re-run + printed paths), 2 (dashboard superseded state), 3 (seam consistency), and 1 (compiler asymmetry). Task 4 covers the second half of the dashboard-polish item (the deferred/compile-failed maintenance skip), which the issue lists in the same bullet as the superseded row state.

**Placeholder scan:** no TBDs. Every code step carries literal text; every run step carries a command and its expected outcome. Three steps require reading existing fixtures before writing tests, and say so explicitly rather than inventing helper names.

**Type consistency:** `TaskRunState` gains `"superseded"` in Task 2 and is consumed only within `planSets.ts`. `TaskStatus.superseded` is added and rendered in the same task. `submitPlanSet`'s deps parameter (Task 3) is added before its return shape changes (Task 6) — Task 6 must update the `dispatchPlanSet` caller Task 3 introduced. `PlanSetRecord.pendingFanout` is optional and only Task 5 touches it. No `Config` field is added.

**Ordering dependency:** Task 5's test uses the injected `submitFn` from Task 3, so 3 must land first. Task 6 changes a return shape Task 3 also touches, so 6 comes last. Tasks 1, 2, 4 are independent.

**Known judgment calls (flag in the PR):** (1) `verification` containing a code fence is REFUSED rather than escaped, matching the module's existing refuse-don't-strip stance; (2) `terminal()` includes `"superseded"` so sets still close, while `allDone` deliberately does not; (3) an unreadable materialized plan clears `pendingFanout` rather than retrying forever; (4) the CLI disposes only UNCLAIMED prior children, never anything already running or finished.
