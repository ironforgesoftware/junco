# Assess History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a per-repo `junco assess` history (last successful audit + its finding counts, plus a failed-attempt marker) and surface it in the dashboard rail, `junco status`, and `junco doctor`.

**Architecture:** A third `reviewStore.ts` instantiation (`src/assessHistory.ts`) keyed by nwo, one JSON file per repo, upserted from the single terminal choke point in `assessFlow.ts`'s `finalizeAssess`. The rail row is restructured so a fixed-width right-hand indicator slot and the selection bar are pinned (`flexShrink={0}`) and the nwo truncates into what's left — which also fixes a live bug where long repo names squeeze the `▌` selection bar out of existence.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), vitest, ink + ink-testing-library.

**Spec:** GitHub issue #193. Where this plan and #193 disagree, **this plan wins** — see "Spec corrections" below.

## Global Constraints

- Node ≥ 22.19, ESM/NodeNext, strict TypeScript.
- **No new `Config` field.** No staleness threshold, no toggle. (Also avoids the `makeConfig`-fixture trap in CLAUDE.md.)
- **No AI attribution in commits.** No `Co-Authored-By: Claude`, no "Generated with Claude Code".
- Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`), suite green at every commit.
- Dependencies exact-pinned; **this plan adds no dependencies.**
- Run `npx prettier --write` on touched files before each commit (prettier reformats between read and edit).
- Vitest exit-code trap: never pipe into `grep`/`tail`. Use `npx vitest run <file> > /tmp/out 2>&1; echo "exit: $?"`.

## Spec corrections (found while planning — #193 is wrong on these)

1. **`fin.status === "completed"`, not `"done"`.** `finalize.ts:19-23` returns `"timeout" | "failed" | "completed"`; only `"completed"` routes to `done/`. #193 says `"done"` — that gate would never fire.
2. **The rail cannot show the indicator without restructuring.** `RAIL_WIDTH = 26` is a fixed constant (`layout.ts:7`). Border (2) + `paddingX={1}` (2) + selection bar (1) leaves **21 columns**. `ironforgesoftware/junco` is 23 and truncates before `(cfg)`, the badges, and anything else. Verified by rendering the real component at the real width on `origin/main`.
3. **Pre-existing bug, fixed here:** on long nwos the `▌` selection bar itself disappears — Ink flex-shrinks it to zero because neither sibling `Text` pins its width. `theme.ts:4` documents `▌` as the NO_COLOR accessibility fallback ("keeps selection legible colorless"), so this breaks colorless selection entirely. `tuiRail.test.tsx` misses it because its fixture is the 8-char `acme/api`. Task 4 fixes it and adds the regression test.
4. **Rail tests are synchronous.** #193 called for loop-until-condition per the CLAUDE.md Ink gotcha; that gotcha covers async state changes. `Rail` is a pure component and `tuiRail.test.tsx` asserts `render(...).lastFrame()` directly. Follow the existing synchronous idiom.

---

### Task 1: The `assessHistory` store

**Files:**

- Create: `src/assessHistory.ts`
- Test: `tests/assessHistory.test.ts`

**Interfaces:**

- Consumes: `makeReviewStore<T>(subdir, requiredFields)` from `src/reviewStore.ts` — returns `{dir, archiveDir, write, list, read, remove, count}`; `read` returns `{entry: T|null, error: string|null}`.
- Produces: `AssessHistory` interface; `listHistory(cfg, deps?) → AssessHistory[]`; `readHistory(cfg, nwo, deps?) → AssessHistory | null`; `recordRun(cfg, nwo, run, deps?) → void`; `assessHistoryDir(cfg) → string`; `type AssessHistoryDeps = ReviewStoreDeps`.

- [ ] **Step 1: Write the failing test**

Create `tests/assessHistory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordRun,
  listHistory,
  readHistory,
  assessHistoryDir,
  type AssessHistory,
} from "../src/assessHistory.js";
import type { Config } from "../src/types.js";

function cfg(stateDir: string): Config {
  return { stateDir } as unknown as Config; // only stateDir is read by this module
}
function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "junco-hist-"));
}

describe("assessHistory", () => {
  it("records a success with counts and no failure", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 4, parked: 3 });
    const h = readHistory(cfg(s), "o/r");
    expect(h).toEqual<AssessHistory>({
      id: "o/r",
      lastSuccessAt: "2026-07-16T00:00:00.000Z",
      lastFound: 4,
      lastParked: 3,
      lastFailureAt: null,
      lastFailureReason: null,
    });
  });

  it("upserts by nwo — a second run replaces, never duplicates", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-15T00:00:00.000Z", found: 4, parked: 4 });
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 0, parked: 0 });
    const all = listHistory(cfg(s));
    expect(all).toHaveLength(1);
    expect(all[0].lastSuccessAt).toBe("2026-07-16T00:00:00.000Z");
    expect(all[0].lastFound).toBe(0);
  });

  it("a failure preserves the last success and stamps the failure fields", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-15T00:00:00.000Z", found: 4, parked: 3 });
    recordRun(cfg(s), "o/r", { ok: false, at: "2026-07-16T00:00:00.000Z", reason: "boom" });
    const h = readHistory(cfg(s), "o/r")!;
    expect(h.lastSuccessAt).toBe("2026-07-15T00:00:00.000Z"); // age still tracks the success
    expect(h.lastFound).toBe(4);
    expect(h.lastParked).toBe(3);
    expect(h.lastFailureAt).toBe("2026-07-16T00:00:00.000Z");
    expect(h.lastFailureReason).toBe("boom");
  });

  it("a success clears a prior failure", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: false, at: "2026-07-15T00:00:00.000Z", reason: "boom" });
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 1, parked: 1 });
    const h = readHistory(cfg(s), "o/r")!;
    expect(h.lastFailureAt).toBeNull();
    expect(h.lastFailureReason).toBeNull();
    expect(h.lastSuccessAt).toBe("2026-07-16T00:00:00.000Z");
  });

  it("a failure with no prior history leaves the success fields null", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: false, at: "2026-07-16T00:00:00.000Z", reason: "boom" });
    const h = readHistory(cfg(s), "o/r")!;
    expect(h.lastSuccessAt).toBeNull();
    expect(h.lastFound).toBeNull();
    expect(h.lastFailureAt).toBe("2026-07-16T00:00:00.000Z");
  });

  it("keeps separate repos in separate files (no shared-map lost update)", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/one", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 1, parked: 1 });
    recordRun(cfg(s), "o/two", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 2, parked: 2 });
    expect(listHistory(cfg(s))).toHaveLength(2);
    expect(readHistory(cfg(s), "o/one")!.lastFound).toBe(1);
    expect(readHistory(cfg(s), "o/two")!.lastFound).toBe(2);
  });

  it("never throws on a missing store: unknown nwo → null, empty dir → []", () => {
    const s = sandbox();
    expect(readHistory(cfg(s), "nope/nope")).toBeNull();
    expect(listHistory(cfg(s))).toEqual([]);
    expect(assessHistoryDir(cfg(s))).toBe(join(s, "assess-history"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assessHistory.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`
Expected: FAIL — `Cannot find module '../src/assessHistory.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/assessHistory.ts`:

```ts
/**
 * Durable per-repo assess history — one JSON file per repo under
 * <state_dir>/assess-history/, keyed by nwo. assessFlow.ts writes one record
 * per TERMINAL whole-repo run; the rail, `junco status` and `junco doctor`
 * read it to answer "when was this last audited, and did it find anything?".
 * Issue #193.
 *
 * Third instantiation of reviewStore.ts. That factory is named for review
 * QUEUES and carries an archive-on-remove this store never calls; the reuse is
 * for its durable keyed-upsert core (atomic tmp+rename, never-throw reads,
 * slugifyId key confinement). Keyed by nwo rather than a ticket id, so `write`
 * is an upsert: the newest terminal run for a repo replaces its record.
 *
 * ONE FILE PER REPO IS LOAD-BEARING. The daemon runs max_concurrent > 1 and
 * serializes only SAME-repo tickets, so two repos can finalize an assess
 * concurrently. A single shared map file would lose updates across the
 * read-modify-write; per-repo files have no shared mutable state.
 */
import { makeReviewStore, type ReviewStoreDeps } from "./reviewStore.js";
import type { Config } from "./types.js";

export interface AssessHistory {
  id: string; // = nwo ("owner/repo") — the store key
  lastSuccessAt: string | null; // ISO; null until a whole-repo run succeeds
  lastFound: number | null; // counts.found at that success
  lastParked: number | null; // counts.parked at that success
  lastFailureAt: string | null; // ISO; cleared by the next success
  lastFailureReason: string | null; // cleared by the next success
}

export type AssessHistoryDeps = ReviewStoreDeps;

// Only `id` is required: every other field is nullable BY DESIGN (a repo whose
// only run failed has no lastSuccessAt), so a truncated or hand-edited file
// still reads rather than being skipped wholesale.
const store = makeReviewStore<AssessHistory>("assess-history", ["id"]);

export function assessHistoryDir(cfg: Config): string {
  return store.dir(cfg);
}

export function listHistory(cfg: Config, deps: AssessHistoryDeps = {}): AssessHistory[] {
  return store.list(cfg, deps);
}

export function readHistory(
  cfg: Config,
  nwo: string,
  deps: AssessHistoryDeps = {},
): AssessHistory | null {
  return store.read(cfg, nwo, deps).entry;
}

/** Record ONE terminal whole-repo assess run.
 *
 * Success stamps the success fields and CLEARS the failure fields; failure
 * stamps the failure fields and leaves the last success untouched. That
 * asymmetry is the whole point: the rail's age always tracks the last
 * SUCCESSFUL audit, so a crashed run can never mark a repo fresh, while a
 * repo whose audits keep failing stays visibly distinct from one nobody ran.
 */
export function recordRun(
  cfg: Config,
  nwo: string,
  run:
    | { ok: true; at: string; found: number; parked: number }
    | { ok: false; at: string; reason: string },
  deps: AssessHistoryDeps = {},
): void {
  const prev = readHistory(cfg, nwo, deps);
  const next: AssessHistory = run.ok
    ? {
        id: nwo,
        lastSuccessAt: run.at,
        lastFound: run.found,
        lastParked: run.parked,
        lastFailureAt: null,
        lastFailureReason: null,
      }
    : {
        id: nwo,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        lastFound: prev?.lastFound ?? null,
        lastParked: prev?.lastParked ?? null,
        lastFailureAt: run.at,
        lastFailureReason: run.reason,
      };
  store.write(cfg, next, deps);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/assessHistory.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`
Expected: PASS — 7 passed

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/assessHistory.ts tests/assessHistory.test.ts
git add src/assessHistory.ts tests/assessHistory.test.ts
git commit -m "feat(assess): durable per-repo assess history store"
```

---

### Task 2: `fmtAgeShort` + `fmtAssessIndicator` formatters

**Files:**

- Modify: `src/tui/queueFmt.ts` (add after `fmtAge`, ~line 29)
- Test: `tests/tuiQueue.test.tsx` (the existing home of queueFmt tests)

**Interfaces:**

- Consumes: `AssessHistory` from Task 1.
- Produces: `fmtAgeShort(iso, now) → string` (compact, no `" ago"` suffix); `fmtAssessIndicator(h, now) → string` where `h: AssessHistory | null`. Task 4 renders the string; Task 5 supplies `h`.

**Format contract** (`fmtAssessIndicator`):

| State                   | Output    | Notes                                            |
| ----------------------- | --------- | ------------------------------------------------ |
| `null` (never assessed) | `—`       | U+2014, already the `raw` badge in `state.ts:45` |
| success, 0 findings     | `2h 0✓`   |                                                  |
| success, N findings     | `21d 4⚠`  |                                                  |
| last attempt failed     | `21d! 4⚠` | `!` suffixes the age; age still the last success |
| failed, never succeeded | `— !`     | no age to show, but the failure must be visible  |

All glyphs are width-1 under this repo's `string-width` (verified: `⚠` U+26A0 bare, no VS16 — **never** emit `⚠️`).

- [ ] **Step 1: Write the failing test**

Append to `tests/tuiQueue.test.tsx`:

```ts
import { fmtAgeShort, fmtAssessIndicator } from "../src/tui/queueFmt.js";
import type { AssessHistory } from "../src/assessHistory.js";

const NOW = new Date("2026-07-16T12:00:00.000Z");
function hist(p: Partial<AssessHistory>): AssessHistory {
  return {
    id: "o/r",
    lastSuccessAt: null,
    lastFound: null,
    lastParked: null,
    lastFailureAt: null,
    lastFailureReason: null,
    ...p,
  };
}

describe("fmtAgeShort", () => {
  it("compact buckets with no ' ago' suffix", () => {
    expect(fmtAgeShort("2026-07-16T11:59:30.000Z", NOW)).toBe("30s");
    expect(fmtAgeShort("2026-07-16T11:30:00.000Z", NOW)).toBe("30m");
    expect(fmtAgeShort("2026-07-16T10:00:00.000Z", NOW)).toBe("2h");
    expect(fmtAgeShort("2026-06-25T12:00:00.000Z", NOW)).toBe("21d");
  });
  it("caps at 99d+ so the fixed indicator column cannot be blown out", () => {
    expect(fmtAgeShort("2020-01-01T00:00:00.000Z", NOW)).toBe("99d+");
  });
  it("clamps a future timestamp to 0s rather than going negative", () => {
    expect(fmtAgeShort("2027-01-01T00:00:00.000Z", NOW)).toBe("0s");
  });
});

describe("fmtAssessIndicator", () => {
  it("never assessed", () => {
    expect(fmtAssessIndicator(null, NOW)).toBe("—");
  });
  it("clean audit", () => {
    const h = hist({ lastSuccessAt: "2026-07-16T10:00:00.000Z", lastFound: 0, lastParked: 0 });
    expect(fmtAssessIndicator(h, NOW)).toBe("2h 0✓");
  });
  it("audit with findings", () => {
    const h = hist({ lastSuccessAt: "2026-06-25T12:00:00.000Z", lastFound: 4, lastParked: 3 });
    expect(fmtAssessIndicator(h, NOW)).toBe("21d 4⚠");
  });
  it("failed last attempt marks the age but does not move it", () => {
    const h = hist({
      lastSuccessAt: "2026-06-25T12:00:00.000Z",
      lastFound: 4,
      lastParked: 3,
      lastFailureAt: "2026-07-16T11:00:00.000Z",
      lastFailureReason: "boom",
    });
    expect(fmtAssessIndicator(h, NOW)).toBe("21d! 4⚠");
  });
  it("failed with no prior success", () => {
    const h = hist({ lastFailureAt: "2026-07-16T11:00:00.000Z", lastFailureReason: "boom" });
    expect(fmtAssessIndicator(h, NOW)).toBe("— !");
  });
  it("caps the count at 99+ to bound the column", () => {
    const h = hist({ lastSuccessAt: "2026-07-16T10:00:00.000Z", lastFound: 250, lastParked: 250 });
    expect(fmtAssessIndicator(h, NOW)).toBe("2h 99+⚠");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tuiQueue.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`
Expected: FAIL — `fmtAgeShort is not a function` / no export named `fmtAgeShort`

- [ ] **Step 3: Write minimal implementation**

Add to `src/tui/queueFmt.ts` immediately after `fmtAge` (line 29), and add the type import at the top:

```ts
import type { AssessHistory } from "../assessHistory.js";
```

```ts
/** Compact sibling of fmtAge for width-starved columns: no " ago" suffix, and
 * days cap at "99d+" so the rail's fixed indicator slot cannot be blown out by
 * an ancient timestamp. */
export function fmtAgeShort(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  return d > 99 ? "99d+" : `${d}d`;
}

/** The rail's assess column: `2h 0✓` · `21d 4⚠` · `21d! 4⚠` · `—` · `— !`.
 *
 * The age tracks the last SUCCESSFUL audit; `!` means the most recent attempt
 * failed (issue #193). Every glyph is width-1 under string-width — `⚠` is bare
 * U+26A0; emitting the VS16 form (⚠️) would make it width-2 and break the
 * fixed column. */
export function fmtAssessIndicator(h: AssessHistory | null, now: Date): string {
  if (!h || (h.lastSuccessAt === null && h.lastFailureAt === null)) return "—";
  const failed = h.lastFailureAt !== null;
  if (h.lastSuccessAt === null) return "— !"; // failed, never succeeded
  const age = fmtAgeShort(h.lastSuccessAt, now) + (failed ? "!" : "");
  const n = h.lastFound ?? 0;
  const count = n === 0 ? "0✓" : `${n > 99 ? "99+" : n}⚠`;
  return `${age} ${count}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tuiQueue.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`
Expected: PASS — all existing queueFmt tests plus the 9 new ones

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/queueFmt.ts tests/tuiQueue.test.tsx
git add src/tui/queueFmt.ts tests/tuiQueue.test.tsx
git commit -m "feat(tui): compact age + assess indicator formatters"
```

---

### Task 3: Write the record from `assessFlow`

**Files:**

- Modify: `src/assessFlow.ts` (add `recordNwo` beside `counts` ~line 108; assign at Phase 2 ~line 201; write inside `finalizeAssess` ~line 141-160)
- Test: `tests/assessFlow.test.ts`

**Interfaces:**

- Consumes: `recordRun`, `listHistory`, `readHistory` from Task 1.
- Produces: nothing new; this is the write side.

**The TDZ trap — read before touching this file.** `finalizeAssess` is defined at ~`:141`; `let nwo: string` is not assigned until Phase 2 at ~`:201`. Early-phase errors call `finalizeAssess` _before_ that assignment, so referencing `nwo` from the closure throws `ReferenceError` (temporal dead zone) and turns a clean phase error into a crash. Declare a separate `let recordNwo: string | null = null` **above** `finalizeAssess`, assign it at Phase 2, and read _that_. `null` then means "skip the write", which is exactly the right behaviour for a run that died before nwo resolution.

**Gate on `fin.status === "completed"`** — `finalize.ts:19-23` returns `"timeout" | "failed" | "completed"` and only `"completed"` routes to `done/`. A guard-killed agent carries an `errorMessage` with no `phaseError`, so `phaseError === null` is the wrong gate.

- [ ] **Step 1: Write the failing test**

Add to `tests/assessFlow.test.ts` inside `describe("runAssessFlow", ...)`:

```ts
it("records a per-repo history entry on a successful whole-repo run", async () => {
  const { root, j } = sandbox();
  const repo = mkRepo();
  const { path } = claim(j, ticketContent(repo));
  const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);

  const finalText = "found things\n\n" + findingsFence([codeFinding("XSS-1", "src/index.ts")]);
  const r = await runAssessFlow(cfg(root), ticket, path, {
    ghFn: ghDedupEmpty().ghFn,
    gitFn: fakeGit(originHttps),
    runCmdFn: fakeRunCmd(auditJson("high")),
    sessionFactoryFor: () => fakeSession(finalText),
    nowFn: () => new Date("2026-07-16T00:00:00.000Z"),
  });
  expect(r.status).toBe("completed");

  const h = readHistory(cfg(root), "o/r")!;
  expect(h.id).toBe("o/r");
  expect(h.lastSuccessAt).toBe("2026-07-16T00:00:00.000Z");
  expect(h.lastFound).toBe(2);
  expect(h.lastParked).toBe(2);
  expect(h.lastFailureAt).toBeNull();
});

it("records NOTHING for an issue-scoped run (it audits only the issue's code)", async () => {
  const { root, j } = sandbox();
  const repo = mkRepo();
  // ticketContent's scoped variant sets assess.issue — mirrors the existing
  // "threads the ticket's scoping issue into the parked batch" test.
  const { path } = claim(j, ticketContent(repo, { issue: 42 }));
  const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);

  const finalText = "found things\n\n" + findingsFence([codeFinding("XSS-1", "src/index.ts")]);
  const r = await runAssessFlow(cfg(root), ticket, path, {
    ghFn: ghDedupEmpty().ghFn,
    gitFn: fakeGit(originHttps),
    runCmdFn: fakeRunCmd(auditJson("high")),
    sessionFactoryFor: () => fakeSession(finalText),
    nowFn: () => new Date("2026-07-16T00:00:00.000Z"),
  });
  expect(r.status).toBe("completed");
  expect(listHistory(cfg(root))).toEqual([]); // scoped runs never touch history
});

it("a failed run stamps the failure and preserves the prior success", async () => {
  const { root, j } = sandbox();
  const repo = mkRepo();
  // Seed a prior success so we can prove the age does not move.
  recordRun(cfg(root), "o/r", {
    ok: true,
    at: "2026-07-15T00:00:00.000Z",
    found: 4,
    parked: 3,
  });

  const { path } = claim(j, ticketContent(repo));
  const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);

  // A non-network dedup error is fatal → finalizeAssess(phaseError) → failed/.
  const r = await runAssessFlow(cfg(root), ticket, path, {
    ghFn: fakeGh(() => {
      throw PERM_ERR;
    }),
    gitFn: fakeGit(originHttps),
    runCmdFn: fakeRunCmd(auditJson("high")),
    sessionFactoryFor: () =>
      fakeSession("x\n\n" + findingsFence([codeFinding("XSS-1", "src/index.ts")])),
    nowFn: () => new Date("2026-07-16T00:00:00.000Z"),
  });
  expect(r.status).toBe("failed");

  const h = readHistory(cfg(root), "o/r")!;
  expect(h.lastSuccessAt).toBe("2026-07-15T00:00:00.000Z"); // unmoved
  expect(h.lastFound).toBe(4);
  expect(h.lastFailureAt).toBe("2026-07-16T00:00:00.000Z");
  expect(h.lastFailureReason).toContain("dedup");
});

it("a phase error BEFORE nwo resolution records nothing and does not throw (TDZ regression)", async () => {
  const { root, j } = sandbox();
  const repo = mkRepo();
  const { path } = claim(j, ticketContent(repo));
  const ticket = parseTicket(path, readFileSync(path, "utf8"), 1);

  // origin is unparseable → Phase 2 fails → finalizeAssess runs with no nwo.
  const r = await runAssessFlow(cfg(root), ticket, path, {
    ghFn: ghDedupEmpty().ghFn,
    gitFn: fakeGit("not-a-github-remote\n"),
    runCmdFn: fakeRunCmd(auditJson("high")),
    sessionFactoryFor: () => fakeSession("x"),
    nowFn: () => new Date("2026-07-16T00:00:00.000Z"),
  });
  expect(r.status).toBe("failed"); // did NOT throw ReferenceError
  expect(listHistory(cfg(root))).toEqual([]);
});
```

Add to the imports at the top of `tests/assessFlow.test.ts`:

```ts
import { listHistory, readHistory, recordRun } from "../src/assessHistory.js";
```

> **If `ticketContent` has no `{ issue }` option**, copy the scoped-ticket construction from the existing test named `"threads the ticket's scoping issue into the parked batch"` (~line 361) verbatim rather than inventing a new helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assessFlow.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -30 /tmp/out`
Expected: FAIL — the 4 new tests fail (`readHistory(...)` returns null / `Cannot find module`)

- [ ] **Step 3: Write minimal implementation**

In `src/assessFlow.ts`, add the import:

```ts
import { recordRun } from "./assessHistory.js";
```

Add beside `counts` (~line 108-114), **above** `buildSummary`/`finalizeAssess`:

```ts
// nwo for the history record, tracked SEPARATELY from the Phase-2 `nwo`
// binding below. finalizeAssess is defined before `let nwo` is assigned, so
// an early-phase error that closed over `nwo` would throw a TDZ
// ReferenceError; this holder starts null and null means "skip the write"
// — exactly right for a run that died before nwo resolution (#193).
let recordNwo: string | null = null;
```

At the end of Phase 2, right after `nwo = parsed;` (~line 201):

```ts
nwo = parsed;
recordNwo = parsed;
```

Inside `finalizeAssess`, after `const fin = finalize(claimedPath, result, dirs);` and before the `log.info` call:

```ts
// Per-repo assess history (#193). Skipped for issue-scoped runs — they
// audit only the code the issue implicates, so letting one refresh the
// repo's freshness would overstate coverage — and for runs that died
// before nwo resolution (recordNwo === null: nothing to key on).
// Only "completed" routes to done/ (finalize.ts:19-23), so a timeout or a
// guard-kill correctly records as a failure and leaves the age alone.
if (recordNwo !== null && ticket.assess?.issue === undefined) {
  const at = nowFn().toISOString();
  recordRun(
    cfg,
    recordNwo,
    fin.status === "completed"
      ? { ok: true, at, found: counts.found, parked: counts.parked }
      : { ok: false, at, reason: result.errorMessage ?? `assess ${fin.status}` },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/assessFlow.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -30 /tmp/out`
Expected: PASS — all existing assessFlow tests plus the 4 new ones

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/assessFlow.ts tests/assessFlow.test.ts
git add src/assessFlow.ts tests/assessFlow.test.ts
git commit -m "feat(assess): record per-repo history at the assess terminal choke point"
```

---

### Task 4: Rail row restructure + indicator column

**Files:**

- Modify: `src/tui/components/Rail.tsx` (`RailRepo` ~line 9-13; the row `ClickableBox` ~line 70-84)
- Test: `tests/tuiRail.test.tsx`

**Interfaces:**

- Consumes: `fmtAssessIndicator` (Task 2), `AssessHistory` (Task 1).
- Produces: `RailRepo` gains `assess?: AssessHistory | null`; `RailProps` gains `now: Date`. Task 5 supplies both.

**Why the row changes.** At `RAIL_WIDTH = 26` the content box is 22 columns (border 2 + `paddingX` 2). Today the row is two unpinned `Text` siblings, so a 23-char nwo like `ironforgesoftware/junco` consumes everything and Ink flex-shrinks the `▌` sibling to **zero** — verified by rendering the real component at the real width. The fix pins both ends and lets the middle shrink:

```
│▌ironforgesof…  2h 0✓ │
 └┬┘└─────┬────┘└──┬──┘
  1    flex(≈13)   ≥8
```

`ClickableBox` is `Omit<ComponentProps<typeof Box>, "children"> & {...}`, so it takes every Box flex prop, and it renders as a plain Box with no `MouseProvider` above it — bare component tests work unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/tuiRail.test.tsx`:

```ts
import { fmtAssessIndicator } from "../src/tui/queueFmt.js";
import type { AssessHistory } from "../src/assessHistory.js";

const NOW = new Date("2026-07-16T12:00:00.000Z");
function hist(p: Partial<AssessHistory>): AssessHistory {
  return {
    id: "o/r",
    lastSuccessAt: null,
    lastFound: null,
    lastParked: null,
    lastFailureAt: null,
    lastFailureReason: null,
    ...p,
  };
}

describe("Rail assess indicator", () => {
  // REGRESSION (#193): before the row was restructured, a 23-char nwo
  // flex-shrank the ▌ sibling to zero — the NO_COLOR selection fallback
  // (theme.ts:4) vanished exactly on the maintainer's own repos. The old test
  // missed it because its fixture was the 8-char "acme/api".
  it("keeps the selection bar visible for a long nwo at the real RAIL_WIDTH", () => {
    const repos = [
      { nwo: "ironforgesoftware/junco", fromConfig: true, counts: {}, assess: null },
    ];
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={QUEUE}
        width={26}
        height={14}
        now={NOW}
        window={{ start: 0, end: 1 }}
      />,
    ).lastFrame()!;
    expect(f).toContain("▌");
  });

  it("shows the indicator for long nwos — it is pinned, never truncated away", () => {
    const repos = [
      {
        nwo: "ironforgesoftware/junco",
        fromConfig: true,
        counts: {},
        assess: hist({ lastSuccessAt: "2026-07-16T10:00:00.000Z", lastFound: 0, lastParked: 0 }),
      },
      {
        nwo: "ironforgesoftware/junco-site",
        fromConfig: true,
        counts: {},
        assess: hist({ lastSuccessAt: "2026-06-25T12:00:00.000Z", lastFound: 4, lastParked: 4 }),
      },
    ];
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={QUEUE}
        width={26}
        height={14}
        now={NOW}
        window={{ start: 0, end: 2 }}
      />,
    ).lastFrame()!;
    expect(f).toContain("2h 0✓");
    expect(f).toContain("21d 4⚠");
  });

  it("never-assessed renders an em dash", () => {
    const repos = [{ nwo: "acme/api", fromConfig: false, counts: {}, assess: null }];
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={QUEUE}
        width={26}
        height={14}
        now={NOW}
        window={{ start: 0, end: 1 }}
      />,
    ).lastFrame()!;
    expect(f).toContain("—");
  });

  it("no row exceeds the pane width (fixed column must not overflow)", () => {
    const repos = [
      {
        nwo: "ironforgesoftware/junco",
        fromConfig: true,
        counts: { "plan-ready": 2 as number },
        assess: hist({
          lastSuccessAt: "2026-06-25T12:00:00.000Z",
          lastFound: 250,
          lastParked: 250,
          lastFailureAt: "2026-07-16T11:00:00.000Z",
          lastFailureReason: "boom",
        }),
      },
    ];
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={QUEUE}
        width={26}
        height={14}
        now={NOW}
        window={{ start: 0, end: 1 }}
      />,
    ).lastFrame()!;
    for (const line of f.split("\n")) expect(line.length).toBeLessThanOrEqual(26);
  });
});
```

Also update the **existing** `Rail` tests in this file: every `<Rail .../>` needs the new required `now={NOW}` prop, and each fixture repo may add `assess: null`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tuiRail.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -30 /tmp/out`
Expected: FAIL — the long-nwo test fails on `expect(f).toContain("▌")` (the live bug), and the indicator tests fail (no indicator rendered)

- [ ] **Step 3: Write minimal implementation**

In `src/tui/components/Rail.tsx`, add imports:

```ts
import { queueLabel, fmtAssessIndicator } from "../queueFmt.js";
import type { AssessHistory } from "../../assessHistory.js";
```

Extend the interfaces:

```ts
export interface RailRepo {
  nwo: string;
  fromConfig: boolean;
  counts: Partial<Record<IssueLifecycle, number>>;
  /** Per-repo assess history (#193); null → never assessed. */
  assess?: AssessHistory | null;
}
```

```ts
export interface RailProps {
  repos: RailRepo[];
  selected: number;
  focused: boolean;
  queue: QueueSnapshot | null;
  width: number;
  height: number;
  /** Polled wall clock for the assess age column — NOT a live clock. */
  now: Date;
  window: { start: number; end: number };
  onRowPress?: (index: number) => void;
  onPanePress?: () => void;
  onWheel?: (dir: 1 | -1) => void;
}
```

Add `now` to the destructured params, and beside `COUNT_ORDER`:

```ts
/** Reserved columns for the assess indicator. The slot is flexShrink={0} with
 * this as a MINIMUM, so the rare over-long value (`99d+! 99+⚠`) grows the slot
 * and shrinks the nwo instead of overflowing the pane. */
const ASSESS_COL = 8;
```

Replace the row body (the `<Text color={theme.accent}>` + `<Text wrap="truncate">` pair) with:

```tsx
{
  /* Pinned: the ▌ NO_COLOR selection fallback (theme.ts:4). Without
                flexShrink={0} Ink squeezes it to zero on a long nwo — the row
                then has no visible selection at all (#193). */
}
<Box flexShrink={0}>
  <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
</Box>;
{
  /* Shrinks: nwo + (cfg) + lifecycle badges truncate together, as
                they already did before the indicator existed. */
}
<Box flexGrow={1} flexShrink={1} overflow="hidden">
  <Text wrap="truncate">
    {r.nwo}
    {r.fromConfig ? " (cfg)" : ""}
    {badges ? `  ${badges}` : ""}
  </Text>
</Box>;
{
  /* Pinned: the assess column is the point of the row — it must
                never be the thing that truncates. */
}
<Box flexShrink={0} minWidth={ASSESS_COL} justifyContent="flex-end">
  <Text dimColor={!sel}>{fmtAssessIndicator(r.assess ?? null, now)}</Text>
</Box>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tuiRail.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -30 /tmp/out`
Expected: PASS — including the `▌` regression test

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Rail.tsx tests/tuiRail.test.tsx
git add src/tui/components/Rail.tsx tests/tuiRail.test.tsx
git commit -m "fix(tui): pin the rail selection bar and add the assess indicator column

The ▌ selection glyph is the NO_COLOR selection fallback (theme.ts), but
unpinned flex siblings let a long nwo squeeze it to zero width — selection
was invisible for any repo whose name exceeded ~21 columns. Pin both ends of
the row and let the nwo shrink between them."
```

---

### Task 5: Wire history into the dashboard

**Files:**

- Modify: `src/tui/App.tsx` (props ~line 66; `repoRows` ~line 498-505; a poll effect modelled on the queue poll ~line 752-766; the `<Rail .../>` call site ~line 2221)
- Modify: `src/dashboardCmd.ts` (~line 67, beside `queueFn: makeQueueSnapshotFn(cfg)`)
- Test: `tests/dashboardCmd.test.ts`

**Interfaces:**

- Consumes: `listHistory` (Task 1); `RailRepo.assess` + `RailProps.now` (Task 4).
- Produces: `AppProps` gains `assessHistoryFn: () => Promise<AssessHistory[]>` and `assessHistoryPollMs?: number` (default `15_000`).

**Why a dedicated poll rather than folding into `queueFn`:** history changes only when an assess run finalizes (minutes-long), so it does not belong on the 2s queue cadence, and `QueueSnapshot` is about the queue. A separate injectable fn mirrors the established `queueFn` seam exactly and keeps tests able to supply a fake.

**`now`:** reuse the existing `queueNow` state (already `setQueueNow(new Date())` on each queue poll, App.tsx:266/758) — it is the established polled wall clock. Do **not** add a live clock.

- [ ] **Step 1: Write the failing test**

Add to `tests/dashboardCmd.test.ts` (mirror whatever assertion style that file already uses for `queueFn`):

```ts
it("wires an assessHistoryFn that reads the per-repo assess history store", async () => {
  // Arrange: a state dir holding one history record, written via the store.
  // Assert: the fn dashboardCmd hands App returns that record.
  // (Follow this file's existing harness for building cfg + capturing the
  // props dashboardCmd passes to App — do not invent a new one.)
});
```

> **Implementer:** replace the comment body with a real assertion in the idiom of the neighbouring `queueFn` test in this file. If `dashboardCmd.test.ts` has no `queueFn` coverage to mirror, cover the wiring in `tests/tuiApp.test.tsx` instead by passing a fake `assessHistoryFn` and asserting the rendered rail shows the indicator — and say so in the commit body.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboardCmd.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`src/tui/App.tsx` — import and props:

```ts
import { listHistory, type AssessHistory } from "../assessHistory.js";
```

```ts
  /** Per-repo assess history source (dashboardCmd wires makeAssessHistoryFn). */
  assessHistoryFn: () => Promise<AssessHistory[]>;
  assessHistoryPollMs?: number; // default 15_000 — assess runs take minutes
```

Destructure `assessHistoryFn` beside `queueFn`, and:

```ts
const assessHistoryPollMs = props.assessHistoryPollMs ?? 15_000;
const [assessHistory, setAssessHistory] = useState<Map<string, AssessHistory>>(new Map());
```

Add the poll effect, modelled exactly on the queue poll:

```ts
// Assess-history polling (also fires once on mount). Slower than the queue
// cadence: a record only changes when an assess run finalizes (#193).
useEffect(() => {
  let alive = true;
  const run = async (): Promise<void> => {
    const rows = await assessHistoryFn();
    if (!alive) return;
    setAssessHistory(new Map(rows.map((h) => [h.id, h])));
  };
  void run();
  const id = setInterval(() => void run(), assessHistoryPollMs);
  return () => {
    alive = false;
    clearInterval(id);
  };
}, [assessHistoryFn, assessHistoryPollMs]);
```

Extend `repoRows` (~line 498-505):

```ts
return {
  nwo: r.nwo,
  fromConfig: r.fromConfig,
  counts,
  assess: assessHistory.get(r.nwo) ?? null,
};
```

At the `<Rail .../>` call site add `now={queueNow}`.

`src/dashboardCmd.ts` — beside `queueFn: makeQueueSnapshotFn(cfg)`:

```ts
      assessHistoryFn: () => Promise.resolve(listHistory(cfg)),
```

with `import { listHistory } from "./assessHistory.js";`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboardCmd.test.ts tests/tuiApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`
Expected: PASS

- [ ] **Step 5: Typecheck (this task adds a required prop — fixtures will break)**

Run: `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/tc 2>&1; echo "exit: $?"; grep -c "error" /tmp/tc`
Every test that renders `<App />` or `<Rail />` now needs `assessHistoryFn` / `now`. Fix each until clean.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui/App.tsx src/dashboardCmd.ts tests/dashboardCmd.test.ts
git add -A
git commit -m "feat(tui): poll per-repo assess history into the rail"
```

---

### Task 6: `junco status` + `junco doctor`

**Files:**

- Modify: `src/statusCmd.ts` (after the `assess review` block, ~line 112-115)
- Modify: `src/doctor.ts` (after block 7d, ~line 415-420)
- Test: `tests/statusCmd.test.ts`, `tests/doctor.test.ts`

**Interfaces:**

- Consumes: `listHistory` (Task 1), `fmtAgeShort` is **not** used here (that is TUI-only); status/doctor print ISO-derived plain text.
- Produces: nothing.

**Output contract** — one line per repo with history, only when the store is non-empty, following the existing `assess review: N pending (junco assess review)` idiom:

```
assess:    o/r assessed 2026-07-16 · 4 found · 3 parked
assess:    o/other never assessed · last attempt failed 2026-07-16
```

- [ ] **Step 1: Write the failing test**

Add to `tests/statusCmd.test.ts` (match the file's existing harness for building cfg + capturing `print`):

```ts
it("prints an assess line per repo with history, and nothing when the store is empty", () => {
  // empty store → no "assess:" line at all
  // one success record → "assess:" line naming the repo, found and parked
  // Follow this file's existing assess-review assertion idiom.
});
```

Add the mirror to `tests/doctor.test.ts` asserting an informational (`ok`, not `warn`) report — a never-assessed repo is normal workflow state, not a health problem, exactly like the assess-review backlog at `doctor.ts:415-417`.

> **Implementer:** replace both comment bodies with real assertions in each file's existing idiom.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/statusCmd.test.ts tests/doctor.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`src/statusCmd.ts`, after the `assess review` block:

```ts
// Per-repo assess history (#193): age + outcome for every repo ever audited.
// Silent when nothing has been assessed — same "only when non-empty" rule as
// the review backlog above.
for (const h of listHistory(cfg)) {
  const when = h.lastSuccessAt ? `assessed ${h.lastSuccessAt.slice(0, 10)}` : "never assessed";
  const counts =
    h.lastSuccessAt !== null ? ` · ${h.lastFound ?? 0} found · ${h.lastParked ?? 0} parked` : "";
  const failed = h.lastFailureAt ? ` · last attempt failed ${h.lastFailureAt.slice(0, 10)}` : "";
  print(`assess:    ${h.id} ${when}${counts}${failed}\n`);
}
```

with `import { listHistory } from "./assessHistory.js";`.

`src/doctor.ts`, after block 7d:

```ts
// 7d-bis. Per-repo assess history — informational only (a never-assessed
// repo is normal workflow state, not a health problem), mirroring 7d.
for (const h of listHistory(cfg)) {
  const when = h.lastSuccessAt ? `assessed ${h.lastSuccessAt.slice(0, 10)}` : "never assessed";
  const failed = h.lastFailureAt ? ` (last attempt failed)` : "";
  report("ok", "assess history", `${h.id}: ${when}${failed}`);
}
```

with `import { listHistory } from "./assessHistory.js";`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/statusCmd.test.ts tests/doctor.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/statusCmd.ts src/doctor.ts tests/statusCmd.test.ts tests/doctor.test.ts
git add -A
git commit -m "feat(cli): surface per-repo assess history in status and doctor"
```

---

### Task 7: Docs + changelog

**Files:**

- Modify: `ARCHITECTURE.md` (module map ~line 210-218)
- Modify: `docs/assess.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: ARCHITECTURE.md — add the row and fix the count**

Add an `assessHistory.ts` row beside `assessReview.ts` / `commentReview.ts`:

```
| `assessHistory.ts`      | Durable per-repo assess history — the third `reviewStore.ts` instantiation (`makeReviewStore<AssessHistory>("assess-history")`), keyed by **nwo** rather than a ticket id so `write` is an upsert. `assessFlow.ts`'s `finalizeAssess` records one entry per TERMINAL whole-repo run: a success stamps `lastSuccessAt`/`lastFound`/`lastParked` and clears the failure fields; a failure stamps `lastFailureAt`/`lastFailureReason` and leaves the last success untouched (so the rail's age always tracks the last *successful* audit). Issue-scoped runs and runs that die before nwo resolution record nothing. One file per repo is deliberate: `max_concurrent > 1` serializes only same-repo tickets, so a shared map file would lose updates. Read by the rail, `status`, and `doctor`. |
```

Update the `reviewStore.ts` row: `assessReview.ts` and `commentReview.ts` are its two instantiations → **three**, adding `assessHistory.ts` (noting it uses the keyed-upsert core but never `remove`/archive).

- [ ] **Step 2: docs/assess.md — document the indicator**

Add a section covering: what the rail column means (`—` / `2h 0✓` / `21d 4⚠` / `21d! 4⚠`); that the age tracks the last **successful** whole-repo audit; that **issue-scoped runs deliberately do not refresh it** (they audit only the issue's code, so refreshing would overstate coverage); that a failed attempt is marked but never moves the age; and that `junco status` / `junco doctor` print the same data with the full breakdown.

- [ ] **Step 3: CHANGELOG.md — Keep a Changelog, under Unreleased**

```markdown
### Added

- `junco assess` now records a per-repo history (last successful audit, its finding counts, and a marker when the most recent attempt failed), surfaced as a column in the dashboard rail and in `junco status` / `junco doctor`. Issue-scoped runs (`junco assess owner/repo#N`) deliberately do not refresh a repo's freshness — they audit only the code the issue implicates.

### Fixed

- Dashboard rail: the `▌` selection bar could be squeezed to zero width by a long `owner/repo` name, leaving no visible selection — and no fallback on `NO_COLOR` terminals, where `▌` is the only selection cue. The rail row now pins the selection bar and the assess column and truncates the repo name between them.
```

- [ ] **Step 4: Full gate**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/full 2>&1; echo "exit: $?"; tail -5 /tmp/full
```

Expected: all green, ~1,500 tests passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(assess): document per-repo assess history + rail indicator"
```

---

## Self-review

**Spec coverage vs #193:** store (T1) · nwo keying + per-repo files (T1) · success/failure semantics (T1, T3) · write point + TDZ holder (T3) · issue-scoped skip (T3) · pre-nwo skip (T3) · `fmtAgeShort` (T2) · rail (T4) · status (T6) · doctor (T6) · ARCHITECTURE/docs/CHANGELOG (T7) · no Config field (Global Constraints). Four spec errors corrected up front (`"completed"` gate, rail width, `▌` bug, sync rail tests).

**Type consistency:** `AssessHistory` fields identical across T1/T2/T4; `recordRun`'s discriminated union matches its T3 call site; `RailRepo.assess?: AssessHistory | null` matches what T5 supplies; `fmtAssessIndicator(h: AssessHistory | null, now: Date)` matches its T4 call.

**Known soft spots (flagged, not hidden):** T5's and T6's test steps say "follow this file's existing idiom" rather than shipping literal assertions — those harnesses (`dashboardCmd.test.ts`, `statusCmd.test.ts`, `doctor.test.ts`) were not read during planning, and inventing their fixtures blind would be worse than pointing at the neighbours. T3's `ticketContent(repo, { issue: 42 })` assumes an option the existing scoped-batch test may build differently; the step says to copy that test verbatim if so.
