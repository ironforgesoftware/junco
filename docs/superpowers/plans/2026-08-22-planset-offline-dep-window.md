# Plan-sets priority pair: offline-PR dependency window + closed-record TTL (WS-3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two priority follow-ups from issue #298 — dependents must not claim before an offline parent's PR actually exists, and the plan-set sweep must stop paying an unbounded per-sweep GitHub cost for sets closed long ago.

**Architecture:** Two independent fixes in one branch. (1) The dependency sweep decides from the done ticket's `junco-result` block; an offline PR endgame finalizes with no `pr_url`, which the sweep currently reads as "no PR, edge satisfied". We make the queued state machine-readable, teach the sweep to wait on it, and have the outbox write the real `pr_url` back into the done file when it finally opens the PR. (2) `maintainPlanSets` probes every record's plan comment every sweep, closed or not; we stamp a close time and stop probing cold records.

**Tech Stack:** TypeScript strict/ESM, vitest. Plan-set bridge tests drive a real fake-`gh` shell script written to `cfg.ghBin`; outbox/prFlow tests use a real git harness.

**Spec:** GitHub issue #298, items 1 and 2 under "Priority" — the pair the maintainer named as blocking a recommendation of plan sets for offline-heavy setups.

## Global Constraints

- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Capture vitest exit explicitly: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — never pipe into `grep`/`tail` as the last stage (the pipeline reports the filter's status).
- **`src/ticketSchema.ts` is a stable public contract — additive changes only.** This plan does not change it: `pr_queued` lives in the `junco-result` metadata block (`src/resultMeta.ts`), which is junco-authored output, not the ticket input schema.
- **Additive-optional discipline for on-disk records.** `PlanSetRecord` is read with only a `v === 1` check (`src/planSets.ts:64-73`), so new fields MUST be optional and every reader must tolerate their absence — records written by older builds stay valid. Same rule for `OutboxOp`: ops already queued on disk must still parse.
- Every side effect behind an injectable `*Deps` seam; tests never touch the network or a real model.
- New `Config` fields go in `tests/helpers/config.ts` and nowhere else. (This plan adds none.)
- Scheduler/daemon tests: an instant-resolve fake `sleep` starves the macrotask queue. Yield a real tick with `await new Promise((r) => setTimeout(r, 1))`.
- Conventional commits, suite green at every commit, no AI-attribution trailers.
- Branch `fix/planset-offline-dep-window` off `main` @ `c018431`.
- **Release HOLD:** no version bump, no tag, no publish.

---

### Task 1: Make "PR queued" machine-readable, and make the sweep wait on it

**Files:**

- Modify: `src/resultMeta.ts` (the `ResultMeta` interface and `parseResultMeta`)
- Modify: `src/finalize.ts` (`renderPrResult`'s frontmatter block, the `fm.push(...)` run around the `pushed:` line)
- Modify: `src/ticketDeps.ts` (the done-branch in `sweepDependencies`, the `prUrl === null` case)
- Test: `tests/resultMeta.test.ts` (if absent, add cases to whichever suite covers `parseResultMeta`), `tests/ticketDeps.test.ts`, `tests/prFlow.test.ts`

**Interfaces:**

- Produces: `ResultMeta.prQueued: boolean` — `true` when the result block carries `pr_queued: true`. Task 2 consumes nothing from this task directly, but the same block is what Task 2's upsert rewrites.
- Consumes: `PrOutcome.prQueued` (already exists — `src/prFlow.ts` sets it on the offline endgames; `computePrStatus` in `finalize.ts:90-92` already reads it).

**Why the sweep is wrong today:** `sweepDependencies` reads `parseResultMeta(...).prUrl` from the dependency's done file (`src/ticketDeps.ts`, the `prUrl === null` branch) and treats "no PR recorded" as "this dependency produced no PR, so the edge is satisfied". That is right for a Q&A ticket and wrong for an offline PR endgame, where `finalizePr` routes to `done/` with `prQueued` true and no URL. The only trace today is the human sentence "PR queued for offline push…" in the Result section (`finalize.ts`, the `prOutcome.prQueued` branch). So dependents claim and start work against a base branch whose parent PR does not exist yet.

- [ ] **Step 1: Write the failing tests**

In `tests/ticketDeps.test.ts`, add a case to the stamping describe block. Build a done ticket whose result block carries `pr_queued: true` and no `pr_url`, a waiting ticket that `depends_on` it, then assert the sweep does NOT stamp:

```ts
it("does not satisfy an edge whose dependency has a queued (not yet opened) offline PR", async () => {
  const { paths } = makeQueue(); // follow this file's existing fixture helper
  writeDone(paths, "parent", "status: completed\npr_queued: true");
  writeWaiting(paths, "child", ["parent"]);
  const report = await sweepDependencies(cfg, { prStateFn: async () => "open" });
  expect(report.stamped).toBe(0);
  expect(readWaitingIds(paths)).toContain("child");
});
```

Match the file's existing fixture helpers and naming rather than inventing new ones — read the surrounding tests first and mirror them.

Add the companion case proving the ordinary no-PR path still stamps (this is the regression the change could cause):

```ts
it("still satisfies an edge whose dependency finished with no PR at all (Q&A ticket)", async () => {
  const { paths } = makeQueue();
  writeDone(paths, "parent", "status: completed");
  writeWaiting(paths, "child", ["parent"]);
  const report = await sweepDependencies(cfg, { prStateFn: async () => "open" });
  expect(report.stamped).toBe(1);
});
```

And a parser case wherever `parseResultMeta` is covered:

```ts
it("parses pr_queued", () => {
  expect(
    parseResultMeta("<!-- junco-result\nstatus: completed\npr_queued: true\n-->").prQueued,
  ).toBe(true);
  expect(parseResultMeta("<!-- junco-result\nstatus: completed\n-->").prQueued).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ticketDeps.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t1.txt`

Expected: FAIL — the queued-PR case stamps (report.stamped === 1) because nothing distinguishes it from a no-PR dependency, and `prQueued` does not exist on `ResultMeta`.

- [ ] **Step 3: Add `prQueued` to the parser**

In `src/resultMeta.ts`, add the field to the `ResultMeta` interface next to `superseded`, with a doc comment in the established style:

```ts
/** Offline PR endgame marker (finalize.ts renderPrResult): the ticket
 * finalized DONE with its push→PR sequence parked in the outbox, so the PR
 * does not exist yet and `prUrl` is null. The dependency sweep must WAIT on
 * such an edge rather than treating "no PR" as "no PR was ever coming"
 * (#298). Cleared when the outbox flush upserts the real pr_url. */
prQueued: boolean;
```

Add it to BOTH returns — the no-block early return gets `prQueued: false`, and the parsed return gets:

```ts
    prQueued: field("pr_queued") === "true",
```

- [ ] **Step 4: Emit it from finalize**

In `src/finalize.ts`'s `renderPrResult`, in the `fm` block, immediately after the `fm.push(\`pushed: ${prOutcome.pushed}\`);` line:

```ts
// Machine-readable twin of the human "PR queued for offline push" line below
// — the dependency sweep reads this to know the PR is coming but absent
// (#298). Only emitted while the URL is genuinely unknown.
if (prOutcome.prQueued && !prOutcome.prUrl) fm.push("pr_queued: true");
```

- [ ] **Step 5: Teach the sweep to wait**

In `src/ticketDeps.ts`, replace the `prUrl === null` branch. It currently reads the URL alone; read the whole meta and branch on the queued marker:

```ts
const meta = parseResultMeta(readFileSync(doneFile, "utf8"));
const prUrl = meta.prUrl;
if (prUrl === null) {
  // An offline endgame finalized DONE with its PR parked in the outbox:
  // the PR is coming but does not exist yet, so the edge is NOT
  // satisfiable — wait for the flush to upsert pr_url (Task 2). Without
  // this, dependents claim and build against a base that has no PR
  // (#298). A dependency that simply produced no PR (Q&A) still stamps.
  if (meta.prQueued) continue;
  if (stampSatisfied(t, d)) {
    report.stamped++;
    changed = true;
  }
  continue;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/ticketDeps.test.ts tests/resultMeta.test.ts tests/prFlow.test.ts tests/finalize.test.ts > /tmp/t1b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t1b.txt`

Expected: PASS. If `tests/resultMeta.test.ts` or `tests/finalize.test.ts` does not exist, drop it from the command and say so in your report.

- [ ] **Step 7: Full suite, then commit**

```bash
npx vitest run > /tmp/t1c.txt 2>&1; echo "exit: $?"; tail -8 /tmp/t1c.txt
npx prettier --write src/resultMeta.ts src/finalize.ts src/ticketDeps.ts tests/ticketDeps.test.ts
git add -A
git commit -m "fix(deps): wait on a dependency whose offline PR is still queued

An offline PR endgame finalizes DONE with the push->PR sequence parked in
the outbox and no pr_url in its result block. The dependency sweep read
that as 'this dependency produced no PR' and satisfied the edge, so
dependents claimed and built against a base branch whose PR did not exist
yet. finalize now emits a machine-readable pr_queued marker and the sweep
waits on it; a dependency that genuinely produced no PR still stamps."
```

---

### Task 2: Have the outbox write the real `pr_url` back when it opens the PR

**Files:**

- Modify: `src/resultMeta.ts` (new exported helper)
- Modify: `src/githubOutbox.ts` (the `OutboxOp` `pr` variant; the `case "pr"` flush, right after the URL is learned and checkpointed)
- Modify: `src/prFlow.ts` (`queueOfflinePr`'s enqueued op)
- Test: `tests/githubOutbox.test.ts`, `tests/prFlow.test.ts`, and a parser case alongside Task 1's

**Interfaces:**

- Consumes: `ResultMeta.prQueued` from Task 1 (the marker this task clears).
- Produces: `upsertResultPrUrl(content: string, url: string): string` in `src/resultMeta.ts` — returns `content` with the LAST `junco-result` block's `pr_url` set to `url` and any `pr_queued` line removed; returns `content` unchanged when there is no block. And `OutboxOp` (`pr` variant) gains `ticketId?: string | null`.

**Why a new field rather than reusing `finalize.ticketId`:** `queueOfflinePr` deliberately sets `finalize: null` for external tickets and for plan-set children, because their comment/label traffic is owned elsewhere. Those are exactly the tickets `depends_on` cares about, so the op carries no id for them today. `ticketId` is a separate, always-populated field; it must not revive the suppressed finalize behaviour.

- [ ] **Step 1: Write the failing tests**

Parser/helper cases (alongside Task 1's):

```ts
it("upsertResultPrUrl adds pr_url to the last block and clears pr_queued", () => {
  const before = "body\n<!-- junco-result\nstatus: completed\npushed: true\npr_queued: true\n-->\n";
  const after = upsertResultPrUrl(before, "https://github.com/o/r/pull/7");
  expect(parseResultMeta(after).prUrl).toBe("https://github.com/o/r/pull/7");
  expect(parseResultMeta(after).prQueued).toBe(false);
  expect(after).toContain("status: completed");
  expect(after).toContain("pushed: true");
});

it("upsertResultPrUrl rewrites only the LAST block", () => {
  const two =
    "<!-- junco-result\nstatus: failed\n-->\n<!-- junco-result\nstatus: completed\npr_queued: true\n-->\n";
  const after = upsertResultPrUrl(two, "https://x/1");
  expect(after).toContain("status: failed");
  expect(parseResultMeta(after).prUrl).toBe("https://x/1");
});

it("upsertResultPrUrl leaves content with no block untouched", () => {
  expect(upsertResultPrUrl("no block here\n", "https://x/1")).toBe("no block here\n");
});
```

In `tests/githubOutbox.test.ts`, add a flush case: queue a `pr` op carrying `ticketId`, place a matching done ticket with `pr_queued: true`, flush with a fake `gh` that returns a PR URL, then assert the done file now parses with that `prUrl` and `prQueued === false`. Mirror the file's existing pr-op flush fixtures (it already covers create and the "already exists" view-recovery path). Add a second case where the done file is ABSENT and assert the flush still succeeds (the op must not dead-letter because a ticket was archived or retried away).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/githubOutbox.test.ts > /tmp/t2.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t2.txt`

Expected: FAIL — `upsertResultPrUrl` is not exported, and the flush does not touch the done file.

- [ ] **Step 3: Implement the upsert helper**

In `src/resultMeta.ts`, below `parseResultMeta`:

```ts
/**
 * Set `pr_url` in the LAST `junco-result` block and drop any `pr_queued`
 * marker, returning the rewritten content. Used by the outbox when an offline
 * PR op finally opens its PR (#298): the ticket already finalized to done/
 * with no URL, and the dependency sweep needs the real one to probe. Content
 * with no block is returned unchanged — callers treat that as "nothing to
 * update", never as an error.
 */
export function upsertResultPrUrl(content: string, url: string): string {
  const blocks = [...content.matchAll(BLOCK_RE)];
  const last = blocks[blocks.length - 1];
  if (!last) return content;
  const body = last[1];
  const kept = body
    .split("\n")
    .filter((l) => !/^pr_queued:/.test(l) && !/^pr_url:/.test(l))
    .join("\n")
    .replace(/\n+$/, "");
  const rebuilt = `${kept}\npr_url: ${url}\n`;
  const start = last.index ?? 0;
  return (
    content.slice(0, start) + last[0].replace(body, rebuilt) + content.slice(start + last[0].length)
  );
}
```

Note `BLOCK_RE` is a module-level `g`-flagged regex — `matchAll` consumes it safely, but do NOT interleave `.exec` calls on it.

- [ ] **Step 4: Carry the ticket id on the op**

In `src/githubOutbox.ts`, add to the `pr` variant of `OutboxOp`, next to `finalize`:

```ts
      /** The finalized ticket this PR belongs to, so the flush can write the
       * real pr_url back into its done file when the PR is finally opened
       * (#298). Distinct from `finalize.ticketId`, which is deliberately null
       * for external tickets and plan-set children — exactly the tickets
       * `depends_on` cares about. Optional: ops queued by older builds parse
       * without it and simply skip the upsert. */
      ticketId?: string | null;
```

In `src/prFlow.ts`'s `queueOfflinePr`, add to the enqueued object (alongside `pushed` / `prUrl`):

```ts
      ticketId: task.id,
```

- [ ] **Step 5: Upsert on flush**

In `src/githubOutbox.ts`'s `case "pr"`, inside the `if (op.prUrl === null) { ... }` block, immediately AFTER the `rewrite(s)` that checkpoints the newly learned URL:

```ts
// The ticket finalized to done/ before this PR existed (offline
// endgame). Write the real URL into its result block so the
// dependency sweep can probe it — dependents are parked waiting on
// exactly this (#298). Best-effort: a missing or unreadable done
// file must never fail the op, which has already succeeded.
if (op.ticketId) {
  try {
    const doneFile = findTicketFile(queuePaths(cfg).done, op.ticketId);
    if (doneFile) {
      writeFileSync(doneFile, upsertResultPrUrl(readFileSync(doneFile, "utf8"), op.prUrl), "utf8");
    }
  } catch (e) {
    log.warn("outbox: could not record pr_url on the done ticket", {
      ticket: op.ticketId,
      error: msg(e),
    });
  }
}
```

Add whatever imports this needs (`findTicketFile`, `queuePaths`, `upsertResultPrUrl`, and the file's existing error-message helper). Follow the module's existing import and logging conventions — read the top of the file first. If the module already has an fs seam in `FlushDeps`, route the read/write through it rather than importing `fs` directly, and say which you did in your report.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/githubOutbox.test.ts tests/prFlow.test.ts tests/ticketDeps.test.ts > /tmp/t2b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t2b.txt`

Expected: PASS.

- [ ] **Step 7: Full suite, then commit**

```bash
npx vitest run > /tmp/t2c.txt 2>&1; echo "exit: $?"; tail -8 /tmp/t2c.txt
npx prettier --write src/resultMeta.ts src/githubOutbox.ts src/prFlow.ts tests/githubOutbox.test.ts
git add -A
git commit -m "fix(outbox): record the real pr_url on the done ticket after an offline PR opens

Closes the other half of the offline dependency window: the ticket
finalized to done/ before its PR existed, so the sweep had nothing to
probe. The pr op now carries its ticket id (separate from the deliberately
suppressed finalize step) and writes pr_url back into the result block
when the PR is created, clearing pr_queued. Best-effort — a missing done
file never fails an op whose network work already succeeded."
```

---

### Task 3: Stop probing plan-set records closed long ago

**Files:**

- Modify: `src/planSets.ts` (`PlanSetRecord`)
- Modify: `src/planSetBridge.ts` (`maintainPlanSets`'s per-record loop, and the close step)
- Test: `tests/planSetBridge.test.ts`

**Interfaces:**

- Produces: `PlanSetRecord.closedAt?: string` (ISO). Additive-optional — records from older builds have `closed: true` with no `closedAt`; those must be treated as **warm** (never silently skipped) so the change can only reduce cost, never lose a supersede.
- Consumes: `MaintainPlanSetsDeps.nowIso` (already exists) for a testable clock.

**Why:** `maintainPlanSets` iterates every record and calls `trySupersede` BEFORE the `record.closed` skip. `trySupersede`'s first act is `findOwnPlanComment`, a paginated `gh api repos/<nwo>/issues/<n>/comments` — one per record per sweep, forever, including sets closed months ago. Nothing ever prunes the plans dir, so the cost grows linearly with every set ever created.

- [ ] **Step 1: Write the failing test**

In `tests/planSetBridge.test.ts`, using the file's existing fake-`gh` harness (it writes a real shell script to `cfg.ghBin` and can log invocations), add:

```ts
it("does not probe a record closed longer ago than the cold window", async () => {
  // record: closed, closedAt well past the window
  writeRecord({ ...baseRecord, closed: true, closedAt: "2020-01-01T00:00:00.000Z" });
  const before = ghCallCount();
  await maintainPlanSets(cfg, { nowIso: "2026-08-22T00:00:00.000Z" });
  expect(ghCallCount()).toBe(before);
});

it("still probes a recently-closed record", async () => {
  writeRecord({ ...baseRecord, closed: true, closedAt: "2026-08-21T00:00:00.000Z" });
  const before = ghCallCount();
  await maintainPlanSets(cfg, { nowIso: "2026-08-22T00:00:00.000Z" });
  expect(ghCallCount()).toBeGreaterThan(before);
});

it("still probes a closed record from before closedAt existed", async () => {
  const { closedAt: _drop, ...noClosedAt } = { ...baseRecord, closed: true, closedAt: "x" };
  writeRecord(noClosedAt as PlanSetRecord);
  const before = ghCallCount();
  await maintainPlanSets(cfg, { nowIso: "2026-08-22T00:00:00.000Z" });
  expect(ghCallCount()).toBeGreaterThan(before);
});
```

Adapt `writeRecord`, `baseRecord`, and `ghCallCount` to whatever the file already provides — read its harness first (it writes the fake `gh` script and can re-write it mid-test). If no invocation counter exists, add one to the fake script (append a line to a log file per call) rather than restructuring the harness.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/planSetBridge.test.ts > /tmp/t3.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t3.txt`

Expected: FAIL — the cold record is still probed (call count rises), and `closedAt` is not on the type.

- [ ] **Step 3: Add the field**

In `src/planSets.ts`, add to `PlanSetRecord` after `closed`:

```ts
  /** When `closed` was set (ISO). Records closed longer ago than
   * PLAN_SET_COLD_MS stop being probed for plan-comment edits — without this,
   * every set ever created costs one paginated `gh api …/comments` call on
   * every sweep, forever (#298). Additive: a closed record written before this
   * field existed has no closedAt and is treated as WARM, so the change can
   * only remove cost, never silently drop a supersede. */
  closedAt?: string;
```

- [ ] **Step 4: Stamp it and skip cold records**

In `src/planSetBridge.ts`, at the close step (`state.allTerminal && !record.closed`):

```ts
if (state.allTerminal && !record.closed) {
  record.closed = true;
  record.closedAt = nowIso;
  changed = true;
}
```

Add the window constant near the file's other constants:

```ts
/** How long after close a plan-set record keeps being probed for plan-comment
 * edits. Past this, the sweep skips it entirely — the supersede path is for
 * live work, and an unbounded per-sweep gh call per historical set is the
 * cost #298 flagged. Generous on purpose: the probe is the only way a plan
 * edit is noticed, so this trades a rare very-late supersede for a bounded
 * steady-state cost. */
const PLAN_SET_COLD_MS = 30 * 24 * 60 * 60 * 1000;
```

Then in the per-record loop, between the `github === null` skip and the `trySupersede` call:

```ts
// Cold: closed long enough ago that we stop paying a gh probe for it every
// sweep. `closedAt` absent (older record) counts as warm — never skip on
// missing data.
if (storedRecord.closed && storedRecord.closedAt) {
  const age = Date.parse(nowIso) - Date.parse(storedRecord.closedAt);
  if (Number.isFinite(age) && age > PLAN_SET_COLD_MS) continue;
}
```

Confirm `nowIso` is in scope there and is the same value the close step stamps; if the function derives it differently, use whatever it already uses rather than introducing a second clock.

- [ ] **Step 5: Re-warm on a human re-trigger**

A cold record that the human later edits would never be noticed. Locate the path that re-triggers a plan set from a GitHub label event (start in `src/githubInbox.ts`, around the trigger/approval label handling that dispatches plan sets) and clear `closedAt` there — set it to `undefined` and persist, so the next sweep probes again.

**If there is no clean hook** — the label path does not load the record, or clearing it would tangle unrelated state — do NOT force it. Instead: leave the behaviour as-is, add a sentence to the `closedAt` doc comment stating that a set closed longer than the window will not notice further plan edits and must be re-submitted, and say clearly in your report that you chose this and why. A documented limitation is a fine outcome; a contorted hook is not.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/planSetBridge.test.ts tests/planSets.test.ts > /tmp/t3b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t3b.txt`

Expected: PASS.

- [ ] **Step 7: Full gate, changelog, commit**

Add under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md` (Keep a Changelog order; do NOT create a version heading or touch `package.json`):

```markdown
- Plan sets: a dependent ticket no longer claims while its dependency's PR is still queued for offline delivery — the offline endgame now records a machine-readable `pr_queued` marker, the dependency sweep waits on it, and the outbox writes the real `pr_url` back onto the finalized ticket when the PR opens.
- Plan sets: the maintenance sweep stops probing the plan comment of sets closed more than 30 days ago, so its per-sweep GitHub cost no longer grows with every set ever created.
```

```bash
npx prettier --write src/planSets.ts src/planSetBridge.ts tests/planSetBridge.test.ts CHANGELOG.md
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/gate.txt 2>&1; echo "vitest exit: $?"; tail -8 /tmp/gate.txt
git add -A
git commit -m "fix(plansets): stop probing plan comments for long-closed sets

maintainPlanSets called trySupersede — a paginated gh comments probe —
for every record every sweep, closed or not, and nothing ever prunes the
plans dir, so steady-state cost grew with every set ever created. Records
now stamp closedAt and are skipped past a 30-day window. A closed record
written before closedAt existed counts as warm, so this can only remove
cost, never silently drop a supersede."
```

---

## Self-review

**Spec coverage:** #298's two Priority items are Tasks 1+2 (the dependency window, both halves — the sweep must wait AND the URL must eventually arrive, since waiting alone would park dependents forever) and Task 3 (the TTL). The five "Smaller" items in that issue are deliberately out of scope here; they are WS-3b.

**Placeholder scan:** no TBDs. Two steps require judgment against code the plan cannot fully see — Task 2 Step 5 (whether `FlushDeps` already has an fs seam) and Task 3 Step 5 (whether a clean re-warm hook exists) — and both state explicitly what to do in each case and require reporting the choice.

**Type consistency:** `ResultMeta.prQueued` is added in Task 1 and consumed by Task 2's helper tests. `upsertResultPrUrl` is defined in Task 2 Step 3 before its use in Step 5. `OutboxOp.ticketId` is optional so queued ops from older builds still parse, and `prFlow` populates it. `PlanSetRecord.closedAt` is optional and its absence means warm. No `Config` field is added, so `tests/helpers/config.ts` is untouched.

**Known judgment calls (flag in the PR):** (1) `pr_queued` lives in the result block, not the ticket schema — junco-authored output, not the public contract; (2) a separate `ticketId` rather than reviving `finalize` for suppressed tickets; (3) the upsert is best-effort and never fails an op whose network work already succeeded; (4) a 30-day cold window with absent-`closedAt` treated as warm, trading a rare very-late supersede for bounded cost.
