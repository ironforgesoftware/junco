# Queue Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable per-task history + a derived stats layer so the queue surfaces (QueueView, rail card, `junco status`) show gate pauses, heartbeat, stalls, wait ages, enriched results, and restart-surviving 24h/7d throughput stats.

**Architecture:** A new `<dataDir>/history/` JSONL ledger (month shards) written at runOnce's finalized points; `buildQueueStats` derives windows/ETA/gate/spend from the ledger + one `/health` body + queue-dir mtimes; `QueueSnapshot` widens additively and QueueView/Rail/statusCmd render it. Spec: `docs/superpowers/specs/2026-07-19-queue-monitoring-design.md`.

**Tech Stack:** TypeScript (NodeNext, strict), Ink/React TUI, vitest.

## Global Constraints

- Every side effect goes behind an injectable `*Deps` seam; tests never touch network or a real model.
- `npm run typecheck` (tsconfig.eslint.json) covers `tests/` — additive **required** fields on snapshot types WILL break test fixture literals; each task that widens a type sweeps the fixtures in the same commit.
- Ink/TUI tests: never assert one fixed `setTimeout` tick after a state change — loop-until-condition with a bounded retry, then assert.
- Vitest exit-code trap: `npx vitest run tests/<f>.test.ts > /tmp/out 2>&1; echo "exit: $?"` — never pipe into grep/tail.
- Conventional commits (`feat:`/`fix:`/`refactor:`/`docs:` with optional scope). **No AI attribution, ever** — no `Co-Authored-By: Claude`, no "Generated with Claude Code". Subagent commits auto-append the trailer — amend it away before finishing.
- Prettier may reformat between read and edit; re-read before editing and run `npx prettier --write` on touched files before committing.
- No new Config field (no LEVERS entry needed). No ticket-schema change. All snapshot/flow-result widenings additive.
- LOCAL selectable-row contract: `selectedRow` indexes the WAITING ∪ RECENT concatenation; STATS and other new rows must never become actionable or shift those indices.
- Never import the Pi SDK at module top level (not touched by this plan, but binding).
- Stall threshold: `STALL_MS = 5 * 60_000` module constant in QueueView. Sparkline glyphs `▁▂▃▄▅▆▇█` scaled to the 7-day max.

---

### Task 1: `resultMeta.ts` — shared junco-result parser

**Files:**

- Create: `src/resultMeta.ts`
- Modify: `src/listCmd.ts` (switch `ticketStatusOf` to the shared parser)
- Test: `tests/resultMeta.test.ts`

**Interfaces:**

- Produces: `interface ResultMeta { status: string | null; durationSeconds: number | null; prUrl: string | null }`, `parseResultMeta(content: string): ResultMeta` (never throws; the LAST junco-result block wins, matching `ticketStatusOf`).
- `listCmd.ts` keeps exporting `ticketStatusOf` (same signature) but implements it via `parseResultMeta`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/resultMeta.test.ts
import { describe, it, expect } from "vitest";
import { parseResultMeta } from "../src/resultMeta.js";

const BLOCK = (meta: string): string =>
  `# t\n\nbody\n\n---\n<!-- junco-result\n${meta}\n-->\n\n## Result\n\nok\n`;

describe("parseResultMeta", () => {
  it("parses status, duration_seconds, and pr_url from a PR result block", () => {
    const c = BLOCK(
      "status: timeout_partial\nstop_reason: length\nduration_seconds: 3661\npr_url: https://github.com/o/r/pull/7\nbranch: junco/x\npushed: true",
    );
    expect(parseResultMeta(c)).toEqual({
      status: "timeout_partial",
      durationSeconds: 3661,
      prUrl: "https://github.com/o/r/pull/7",
    });
  });

  it("parses a Q&A block (no pr fields)", () => {
    expect(parseResultMeta(BLOCK("status: completed\nduration_seconds: 12"))).toEqual({
      status: "completed",
      durationSeconds: 12,
      prUrl: null,
    });
  });

  it("last block wins on a retried ticket", () => {
    const c =
      BLOCK("status: failed\nduration_seconds: 5") +
      BLOCK("status: completed\nduration_seconds: 9");
    expect(parseResultMeta(c).status).toBe("completed");
    expect(parseResultMeta(c).durationSeconds).toBe(9);
  });

  it("returns all-null on content without a result block and never throws on garbage", () => {
    expect(parseResultMeta("# plain ticket\n")).toEqual({
      status: null,
      durationSeconds: null,
      prUrl: null,
    });
    expect(parseResultMeta("<!-- junco-result\nstatus:")).toEqual({
      status: "",
      durationSeconds: null,
      prUrl: null,
    });
  });

  it("non-numeric duration_seconds yields null, not NaN", () => {
    expect(
      parseResultMeta(BLOCK("status: completed\nduration_seconds: soon")).durationSeconds,
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — must fail (module not found)**

Run: `npx vitest run tests/resultMeta.test.ts > /tmp/t1 2>&1; echo "exit: $?"` → non-zero, "Cannot find module".

- [ ] **Step 3: Implement**

```ts
// src/resultMeta.ts
/**
 * Parser for the `<!-- junco-result ... -->` metadata block that finalize.ts
 * appends to every done/failed ticket (src/finalize.ts renderResult /
 * renderPrResult). The LAST block wins — a retried ticket accumulates one
 * block per attempt (same rule as listCmd's ticketStatusOf, which this
 * replaces as the single parser). Never throws; absent keys are null.
 */

export interface ResultMeta {
  status: string | null;
  durationSeconds: number | null;
  prUrl: string | null;
}

const BLOCK_RE = /<!-- junco-result\n([\s\S]*?)(?:-->|$)/g;

export function parseResultMeta(content: string): ResultMeta {
  let last: string | null = null;
  for (const m of content.matchAll(BLOCK_RE)) last = m[1];
  if (last === null) return { status: null, durationSeconds: null, prUrl: null };
  const field = (key: string): string | null => {
    const m = new RegExp(`^${key}: ?(.*)$`, "m").exec(last as string);
    return m ? m[1].trim() : null;
  };
  const durRaw = field("duration_seconds");
  const dur = durRaw !== null && /^\d+$/.test(durRaw) ? parseInt(durRaw, 10) : null;
  return { status: field("status"), durationSeconds: dur, prUrl: field("pr_url") };
}
```

Then in `src/listCmd.ts`: delete `RESULT_STATUS_RE` and reimplement (keep the export — other code/tests may import it):

```ts
import { parseResultMeta } from "./resultMeta.js";

/** The status recorded by the LAST junco-result block, or null. */
export function ticketStatusOf(content: string): string | null {
  return parseResultMeta(content).status;
}
```

- [ ] **Step 4: Run new test + listCmd regression**

Run: `npx vitest run tests/resultMeta.test.ts tests/listCmd.test.ts > /tmp/t1 2>&1; echo "exit: $?"` → 0. (If no `tests/listCmd.test.ts` exists, run the full suite.)

- [ ] **Step 5: Commit**

`git add src/resultMeta.ts src/listCmd.ts tests/resultMeta.test.ts && git commit -m "refactor: extract shared junco-result parser (resultMeta)"`

---

### Task 2: dataTree registration for `history/`

**Files:**

- Modify: `src/dataTree.ts` (constant, paths, ensure, sandbox deny), `src/dataCmd.ts` (counts + listing row)
- Test: `tests/dataTree.test.ts`, `tests/dataCmd.test.ts` (extend existing suites)

**Interfaces:**

- Produces: `HISTORY_SUBDIR = "history"`, `DataTreePaths.history: string`. Task 3 imports `HISTORY_SUBDIR`.

- [ ] **Step 1: Failing tests.** In `tests/dataTree.test.ts` (follow the file's existing patterns/fixtures exactly):
  - `dataTreePaths(cfg).history` === `join(cfg.dataDir, "history")`.
  - `ensureDataTree` creates the history dir (extend the existing created-dirs assertion).
  - `sandboxDenyPaths(cfg).dirs` contains the history dir (daemon-owned stats — the agent has no reason to read it; same rationale as `assessHistory`).
    In `tests/dataCmd.test.ts`: the `junco data` output includes a `history` line with a shard-file count, `(absent)` when missing (mirror the `assessHistory` row's test).

- [ ] **Step 2: Run — fail.** `npx vitest run tests/dataTree.test.ts tests/dataCmd.test.ts > /tmp/t2 2>&1; echo "exit: $?"` → non-zero.

- [ ] **Step 3: Implement.** In `src/dataTree.ts`:

```ts
export const HISTORY_SUBDIR = "history";
```

`DataTreePaths` gains `history: string; // per-task finalize records (tasks-YYYY-MM.jsonl shards)` and `dataTreePaths` returns `history: join(r, HISTORY_SUBDIR),`. `ensureDataTree`'s `dirs` array gains `p.history`. `sandboxDenyPaths().dirs` gains `p.history, // daemon-owned task-history ledger` (next to `p.assessHistory`).

In `src/dataCmd.ts`: counts gain `history: { files: number }` via the same `countJson`-style helper the file uses (count `.jsonl` files — add a tiny `countJsonl` beside `countJson` if needed), and the print section gains a row modeled on the `assessHistory` one:

```ts
`history ${existsFn(p.history) ? `${counts.history.files} shards` : "(absent)"}   ${p.history}\n`;
```

(Match the file's real formatting/alignment conventions when editing — read the surrounding rows first.)

- [ ] **Step 4: Run — pass.** Same command → 0.
- [ ] **Step 5: Commit.** `git commit -m "feat: register history/ ledger dir in the data tree"` (include all touched files).

---

### Task 3: `taskHistory.ts` — append + memoized reader

**Files:**

- Create: `src/taskHistory.ts`
- Test: `tests/taskHistory.test.ts`

**Interfaces:**

- Produces:
  - `interface TaskRecord { v: 1; at: string; id: string; kind: "pr" | "ask" | "plan" | "assess" | "analyze"; status: string; durationSeconds: number; tokensIn: number; tokensOut: number; costUsd: number; nwo?: string; issue?: number; prUrl?: string; retryCount: number }`
  - `interface TaskHistoryDeps { mkdirFn?; appendFn?; readFileFn?; statFn?: (p: string) => { mtimeMs: number }; nowFn?: () => Date }`
  - `appendTaskRecord(cfg: Config, rec: TaskRecord, deps?: TaskHistoryDeps): void` — never throws.
  - `makeTaskHistoryReader(cfg: Config, deps?: TaskHistoryDeps): (since: Date) => TaskRecord[]` — per-shard memo keyed on `mtimeMs`.
  - `readTaskHistory(cfg: Config, opts: { since: Date }, deps?: TaskHistoryDeps): TaskRecord[]` — one-shot wrapper.
- Consumes: `HISTORY_SUBDIR` (Task 2), `log` from `./logging.js`.

Note (spec deviation, deliberate): the shard memo keys on `mtimeMs` alone, not `(mtimeMs, size)` — appends always bump mtime, and this keeps the shared `statFn` seam at the `{ mtimeMs }` shape `queueSnapshot` already uses. Record it in Task 10's docs sweep.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/taskHistory.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  appendTaskRecord,
  makeTaskHistoryReader,
  readTaskHistory,
  type TaskRecord,
} from "../src/taskHistory.js";
import type { Config } from "../src/types.js";

// Minimal cfg: taskHistory reads only dataDir. Cast through unknown like the
// other store suites do for narrow-surface fixtures.
const cfg = { dataDir: "/data" } as unknown as Config;

const rec = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  v: 1,
  at: "2026-07-19T10:00:00.000Z",
  id: "t-1",
  kind: "pr",
  status: "completed",
  durationSeconds: 120,
  tokensIn: 1000,
  tokensOut: 200,
  costUsd: 0.05,
  retryCount: 0,
  ...over,
});

describe("appendTaskRecord", () => {
  it("mkdir -p's the history dir and appends one JSON line to the UTC-month shard", () => {
    const mk: string[] = [];
    const appended: Array<{ p: string; s: string }> = [];
    appendTaskRecord(cfg, rec(), {
      mkdirFn: ((d: string) => void mk.push(d)) as never,
      appendFn: ((p: string, s: string) => void appended.push({ p, s })) as never,
    });
    expect(mk).toEqual([join("/data", "history")]);
    expect(appended).toHaveLength(1);
    expect(appended[0].p).toBe(join("/data", "history", "tasks-2026-07.jsonl"));
    expect(appended[0].s.endsWith("\n")).toBe(true);
    expect(JSON.parse(appended[0].s) as TaskRecord).toEqual(rec());
  });

  it("never throws when the append fails", () => {
    expect(() =>
      appendTaskRecord(cfg, rec(), {
        mkdirFn: (() => {
          throw new Error("EROFS");
        }) as never,
      }),
    ).not.toThrow();
  });
});

describe("makeTaskHistoryReader", () => {
  const NOW = new Date("2026-07-19T12:00:00Z");
  const shard = (recs: (TaskRecord | string)[]): string =>
    recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";

  it("reads only shards overlapping [since, now] and filters by at >= since", () => {
    const files: Record<string, string> = {
      [join("/data", "history", "tasks-2026-06.jsonl")]: shard([
        rec({ at: "2026-06-30T23:00:00.000Z", id: "june" }),
      ]),
      [join("/data", "history", "tasks-2026-07.jsonl")]: shard([
        rec({ at: "2026-07-11T00:00:00.000Z", id: "old" }),
        rec({ at: "2026-07-19T01:00:00.000Z", id: "fresh" }),
      ]),
    };
    const read = makeTaskHistoryReader(cfg, {
      readFileFn: (p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p];
      },
      statFn: (p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return { mtimeMs: 1 };
      },
      nowFn: () => NOW,
    });
    // 7d window: only the July shard qualifies; only "fresh" is inside it.
    expect(read(new Date("2026-07-12T12:00:00Z")).map((r) => r.id)).toEqual(["fresh"]);
    // 30d window spans June + July.
    expect(read(new Date("2026-06-20T00:00:00Z")).map((r) => r.id)).toEqual([
      "june",
      "old",
      "fresh",
    ]);
  });

  it("skips corrupt and alien-shaped lines", () => {
    const p = join("/data", "history", "tasks-2026-07.jsonl");
    const files: Record<string, string> = {
      [p]: shard([rec({ id: "good" }), "{not json", JSON.stringify({ hello: "world" }), ""]),
    };
    const read = makeTaskHistoryReader(cfg, {
      readFileFn: (q: string) =>
        files[q] ??
        ((): never => {
          throw new Error("ENOENT");
        })(),
      statFn: () => ({ mtimeMs: 1 }),
      nowFn: () => NOW,
    });
    expect(read(new Date("2026-07-01T00:00:00Z")).map((r) => r.id)).toEqual(["good"]);
  });

  it("memoizes per shard on mtimeMs and re-reads when it changes", () => {
    const p = join("/data", "history", "tasks-2026-07.jsonl");
    let content = shard([rec({ id: "a" })]);
    let mtime = 1;
    let reads = 0;
    const read = makeTaskHistoryReader(cfg, {
      readFileFn: () => {
        reads++;
        return content;
      },
      statFn: () => ({ mtimeMs: mtime }),
      nowFn: () => NOW,
    });
    const since = new Date("2026-07-01T00:00:00Z");
    read(since);
    read(since);
    expect(reads).toBe(1); // second call served from memo
    content = shard([rec({ id: "a" }), rec({ id: "b" })]);
    mtime = 2;
    expect(read(since).map((r) => r.id)).toEqual(["a", "b"]);
    expect(reads).toBe(2);
  });

  it("missing dir/shards yield [] and a since in the future yields []", () => {
    const read = makeTaskHistoryReader(cfg, {
      readFileFn: () => {
        throw new Error("ENOENT");
      },
      statFn: () => {
        throw new Error("ENOENT");
      },
      nowFn: () => NOW,
    });
    expect(read(new Date("2026-07-01T00:00:00Z"))).toEqual([]);
    expect(read(new Date("2027-01-01T00:00:00Z"))).toEqual([]);
  });
});

describe("readTaskHistory", () => {
  it("is a one-shot wrapper over the reader", () => {
    const p = join("/data", "history", "tasks-2026-07.jsonl");
    const files: Record<string, string> = { [p]: JSON.stringify(rec({ id: "x" })) + "\n" };
    const out = readTaskHistory(
      cfg,
      { since: new Date("2026-07-01T00:00:00Z") },
      {
        readFileFn: (q: string) =>
          files[q] ??
          ((): never => {
            throw new Error("ENOENT");
          })(),
        statFn: () => ({ mtimeMs: 1 }),
        nowFn: () => new Date("2026-07-19T12:00:00Z"),
      },
    );
    expect(out.map((r) => r.id)).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Run — fail.** `npx vitest run tests/taskHistory.test.ts > /tmp/t3 2>&1; echo "exit: $?"` → non-zero.

- [ ] **Step 3: Implement**

```ts
// src/taskHistory.ts
/**
 * Per-task finalize ledger — append-only JSONL under <dataDir>/history/,
 * sharded by UTC month of the record's `at` (`tasks-YYYY-MM.jsonl`). Written
 * at runOnce's finalized points beside metrics.recordTask; read by the queue
 * stats layer and `junco status`. Writer never throws (a failed history
 * append must not fail a finalize); reader skips corrupt lines (reviewStore
 * read discipline) and memoizes per shard on mtimeMs.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { HISTORY_SUBDIR } from "./dataTree.js";
import { log } from "./logging.js";

export interface TaskRecord {
  v: 1;
  at: string; // ISO — when the task finalized
  id: string;
  kind: "pr" | "ask" | "plan" | "assess" | "analyze";
  status: string; // terminal status (finalize.ts statusFor / computePrStatus)
  durationSeconds: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  nwo?: string;
  issue?: number;
  prUrl?: string;
  retryCount: number;
}

export interface TaskHistoryDeps {
  mkdirFn?: (d: string, opts: { recursive: true }) => void;
  appendFn?: (p: string, s: string, enc: "utf8") => void;
  readFileFn?: (p: string) => string;
  statFn?: (p: string) => { mtimeMs: number };
  nowFn?: () => Date;
}

export function historyDir(cfg: Config): string {
  return join(cfg.dataDir, HISTORY_SUBDIR);
}

/** Shard basename for a record stamp: UTC month straight off the ISO string. */
function shardName(atIso: string): string {
  return `tasks-${atIso.slice(0, 7)}.jsonl`;
}

export function appendTaskRecord(cfg: Config, rec: TaskRecord, deps: TaskHistoryDeps = {}): void {
  const mkdirFn = deps.mkdirFn ?? mkdirSync;
  const appendFn = deps.appendFn ?? appendFileSync;
  try {
    const dir = historyDir(cfg);
    mkdirFn(dir, { recursive: true });
    // One appendFileSync of one line: O_APPEND keeps concurrent finalizes
    // (max_concurrent > 1) from interleaving records.
    appendFn(join(dir, shardName(rec.at)), JSON.stringify(rec) + "\n", "utf8");
  } catch (e) {
    log.warn("taskHistory: append failed", {
      id: rec.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** UTC months ("YYYY-MM") overlapping [since, now], oldest first. Bounded at
 * 24 iterations so a garbage `since` can never spin the loop. */
function monthsBetween(since: Date, now: Date): string[] {
  if (since.getTime() > now.getTime()) return [];
  const out: string[] = [];
  let y = since.getUTCFullYear();
  let m = since.getUTCMonth();
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth();
  while ((y < endY || (y === endY && m <= endM)) && out.length < 24) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

function parseShard(readFileFn: (p: string) => string, p: string): TaskRecord[] {
  let raw: string;
  try {
    raw = readFileFn(p);
  } catch {
    return [];
  }
  const out: TaskRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const j = JSON.parse(line) as Partial<TaskRecord>;
      if (
        typeof j.at === "string" &&
        typeof j.id === "string" &&
        typeof j.status === "string" &&
        typeof j.durationSeconds === "number"
      ) {
        out.push(j as TaskRecord);
      }
    } catch {
      // corrupt line — skip (reviewStore read discipline)
    }
  }
  return out;
}

export function makeTaskHistoryReader(
  cfg: Config,
  deps: TaskHistoryDeps = {},
): (since: Date) => TaskRecord[] {
  const readFileFn = deps.readFileFn ?? ((p: string): string => readFileSync(p, "utf8"));
  const statFn = deps.statFn ?? statSync;
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const memo = new Map<string, { mtimeMs: number; records: TaskRecord[] }>();
  return (since: Date): TaskRecord[] => {
    const out: TaskRecord[] = [];
    const sinceMs = since.getTime();
    for (const month of monthsBetween(since, nowFn())) {
      const p = join(historyDir(cfg), `tasks-${month}.jsonl`);
      let st: { mtimeMs: number };
      try {
        st = statFn(p);
      } catch {
        memo.delete(p); // absent shard (or vanished) — drop any stale memo
        continue;
      }
      const hit = memo.get(p);
      let records: TaskRecord[];
      if (hit !== undefined && hit.mtimeMs === st.mtimeMs) {
        records = hit.records;
      } else {
        records = parseShard(readFileFn, p);
        memo.set(p, { mtimeMs: st.mtimeMs, records });
      }
      for (const r of records) {
        const t = Date.parse(r.at);
        if (Number.isFinite(t) && t >= sinceMs) out.push(r);
      }
    }
    return out;
  };
}

/** One-shot read (statusCmd). The dashboard uses makeTaskHistoryReader so its
 * 2s polling amortizes shard parsing via the memo. */
export function readTaskHistory(
  cfg: Config,
  opts: { since: Date },
  deps: TaskHistoryDeps = {},
): TaskRecord[] {
  return makeTaskHistoryReader(cfg, deps)(opts.since);
}
```

- [ ] **Step 4: Run — pass.** Same command → 0.
- [ ] **Step 5: Commit.** `git commit -m "feat: task-history ledger — month-sharded JSONL append + memoized reader"`

---

### Task 4: write history at runOnce's finalized points

**Files:**

- Modify: `src/prFlow.ts` (`PrFlowResult` + `flowResult`), `src/runOnce.ts` (helper + 5 call sites + deps seam)
- Test: `tests/runOnce.test.ts` (extend), plus typecheck sweep of flow-result fakes

**Interfaces:**

- Consumes: `appendTaskRecord`, `TaskRecord` (Task 3); `AssessFlowResult.result` / `AnalyzeFlowResult.result` (already exist — carry the full `RunResult`).
- Produces: `PrFlowResult` gains `usage?: Usage; durationMs?: number` (additive optional — `requeuedResult` leaves them undefined). `RunOnceDeps` gains `appendTaskRecordFn?: typeof appendTaskRecord` and (if not already present) `nowFn?: () => Date`.

- [ ] **Step 1: Failing tests.** In `tests/runOnce.test.ts`, using the suite's existing harness (fake flows, `makeConfig`, fake session factory):
  - PR path: run a ticket through a fake `prFlowFn` returning `{ ..., status: "completed", requeued: false, prUrl: "https://x/pull/1", usage: { input: 10, output: 5, cacheRead: 0, total: 15, costUsd: 0.01 }, durationMs: 4000 }`; inject `appendTaskRecordFn` capturing calls; assert exactly one record with `kind: "pr"`, `status: "completed"`, `durationSeconds: 4`, `tokensIn: 10`, `tokensOut: 5`, `costUsd: 0.01`, `prUrl: "https://x/pull/1"`, `retryCount` matching the ticket, and `at` matching `/^\d{4}-\d{2}-\d{2}T/`.
  - Assess path: fake `assessFlowFn` (result carries usage/durationMs) → one record, `kind: "assess"`.
  - Analyze path: fake `analyzeFlowFn` → one record, `kind: "analyze"`.
  - Ask path: plain Q&A ticket through the fake session → one record, `kind: "ask"`; a bridged plan ticket (`github: { kind: "plan", ... }`) → `kind: "plan"`.
  - Requeued flow (`requeued: true`) → zero records. Transient-failure requeue on the Q&A path → zero records.
  - Crash containment (session factory rejects, retry budget exhausted so it finalizes) → one record with `status: "failed"`, zero tokens.
  - A ticket with `github` set → record carries `nwo` + `issue`; without → both keys absent.

- [ ] **Step 2: Run — fail.** `npx vitest run tests/runOnce.test.ts > /tmp/t4 2>&1; echo "exit: $?"` → non-zero (unknown deps field / no records captured).

- [ ] **Step 3: Implement.**

`src/prFlow.ts` — `PrFlowResult` gains:

```ts
  /** Token usage of the underlying run — threaded so runOnce can write the
   * task-history record without re-plumbing RunResult (additive; absent on
   * requeuedResult, which never produces a record). */
  usage?: Usage;
  durationMs?: number;
```

and `flowResult()` returns `..., usage: result.usage, durationMs: result.durationMs,` (import `Usage` type if not present; `requeuedResult` untouched).

`src/runOnce.ts` — deps + helpers:

```ts
import { appendTaskRecord, type TaskRecord } from "./taskHistory.js";

// in RunOnceDeps:
  /** Task-history ledger seam (tests capture records; default real append). */
  appendTaskRecordFn?: typeof appendTaskRecord;
  nowFn?: () => Date; // only if not already present

// module scope (near outcomeFromQa):
/** Execution kind for the history record — branch order mirrors this
 * function's own dispatch (analyze → assess → pr → Q&A) and queueSnapshot's
 * kind derivation. */
function kindOf(next: Ticket): TaskRecord["kind"] {
  if (next.analyze) return "analyze";
  if (next.assess) return "assess";
  if (next.github?.kind === "plan") return "plan";
  return next.hasRepo ? "pr" : "ask";
}
```

Inside the run function, after `const reporter = ...` (where `cfg`, `next`, `deps` are in scope), a local closure:

```ts
const recordHistory = (
  status: string,
  usage: Usage | undefined,
  durationMs: number | undefined,
  prUrl?: string | null,
): void => {
  (deps.appendTaskRecordFn ?? appendTaskRecord)(cfg, {
    v: 1,
    at: (deps.nowFn?.() ?? new Date()).toISOString(),
    id: next.id,
    kind: kindOf(next),
    status,
    durationSeconds: Math.round((durationMs ?? 0) / 1000),
    tokensIn: usage?.input ?? 0,
    tokensOut: usage?.output ?? 0,
    costUsd: usage?.costUsd ?? 0,
    ...(next.github ? { nwo: next.github.nwo, issue: next.github.issue } : {}),
    ...(prUrl != null && prUrl !== "" ? { prUrl } : {}),
    retryCount: next.retryCount,
  });
};
```

Call sites (each guarded so requeues never record):

1. analyze — after `log.info("finalized (analyze)", ...)`: `if (!flow.requeued) recordHistory(flow.status, flow.result.usage, flow.result.durationMs);`
2. assess — after `log.info("finalized (assess)", ...)`: `if (!flow.requeued) recordHistory(flow.status, flow.result.usage, flow.result.durationMs);`
3. pr-flow — after `log.info("finalized (pr-flow)", ...)`: `if (!flow.requeued) recordHistory(flow.status, flow.usage, flow.durationMs, flow.prUrl);`
4. ask — after `log.info("finalized", ...)`: `recordHistory(fin.status, result.usage, result.durationMs);`
5. crash containment — after `log.info("finalized (crash containment)", ...)`: `recordHistory(fin.status, crashResult.usage, crashResult.durationMs);` (inside the same try — never after the catch that leaves for orphan recovery).

- [ ] **Step 4: Typecheck sweep.** `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/tc4 2>&1; echo "exit: $?"` — fix any test fixture building a `PrFlowResult` literal that now fails (fields are optional, so expect zero breaks; the sweep is verification, and ~57 pre-existing unrelated errors may already exist — compare against a pre-change baseline, only NEW errors count).
- [ ] **Step 5: Run — pass.** `npx vitest run tests/runOnce.test.ts tests/prFlow.test.ts > /tmp/t4 2>&1; echo "exit: $?"` → 0.
- [ ] **Step 6: Commit.** `git commit -m "feat: append task-history records at runOnce's finalized points"`

---

### Task 5: relocate `HealthBody`/`fetchHealthBody` to `healthBody.ts`

**Files:**

- Create: `src/tui/healthBody.ts`
- Modify: `src/tui/localSnapshot.ts` (import + re-export), `src/tui/queueSnapshot.ts` (type import path only — behavior change comes in Task 7)
- Test: existing `tests/localSnapshotCheap.test.ts` / `tests/localSnapshotDaemon.test.ts` stay green unchanged (they import from `localSnapshot`, which re-exports).

**Interfaces:**

- Produces: `src/tui/healthBody.ts` exporting `HealthBody` and `fetchHealthBody(cfg, deps: { fetchFn?: typeof fetch })` — verbatim moves of localSnapshot.ts's current definitions (`HealthBody` interface, the `fetchHealthBody` function, and its `HEALTH_TIMEOUT_MS` import). The narrow deps type replaces `LocalSnapshotDeps` in the moved function's signature (it only ever used `fetchFn`).
- `localSnapshot.ts` re-exports both: `export { fetchHealthBody, type HealthBody } from "./healthBody.js";` so every existing importer keeps compiling. This breaks the future `queueSnapshot → localSnapshot` runtime cycle before it exists.

- [ ] **Step 1: Move the code** (pure refactor, no test first — the existing suites are the net). Create `healthBody.ts` with a header comment noting it exists to be importable from `queueSnapshot` without a runtime cycle; delete the moved definitions from `localSnapshot.ts` and add the re-export; switch `queueSnapshot.ts`'s `import type { HealthBody }` to `"./healthBody.js"`.
- [ ] **Step 2: Verify.** `npx vitest run tests/localSnapshotCheap.test.ts tests/localSnapshotDaemon.test.ts tests/queueSnapshot.test.ts > /tmp/t5 2>&1; echo "exit: $?"` → 0, and `npx tsc --noEmit -p tsconfig.eslint.json` shows no new errors.
- [ ] **Step 3: Commit.** `git commit -m "refactor(tui): extract healthBody module (cycle-free health fetch for queueSnapshot)"`

---

### Task 6: `queueStats.ts` — derived stats

**Files:**

- Create: `src/tui/queueStats.ts`
- Test: `tests/queueStats.test.ts`

**Interfaces:**

- Consumes: `HealthBody` (Task 5), `TaskRecord` (Task 3), `TERMINAL_DONE_STATUSES` from `../types.js`, `queuePaths` from `../config.js`.
- Produces:

```ts
export interface QueueStats {
  gate: { state: string; reason: string | null; until: string | null } | null;
  lastPollAt: string | null;
  window24h: {
    done: number;
    failed: number;
    successRate: number | null;
    avgDurationSeconds: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
    costUsd: number | null;
  };
  perDay7d: { done: number; failed: number }[];
  etaSeconds: number | null;
  spend: { todayUsd: number; dailyBudgetUsd: number } | null;
  guards: { nudges: number; kills: number; requeues: number } | null;
  outbox: { depth: number; dead: number };
  pendingRestartFields: string[];
}

export interface QueueStatsInputs {
  healthBody: HealthBody | null;
  history: (since: Date) => TaskRecord[];
  eligibleWaiting: number; // non-deferred waiting count (ETA numerator)
  outbox: { depth: number; dead: number };
}

export interface QueueStatsDeps {
  nowFn?: () => Date;
  readdirFn?: (dir: string) => string[];
  statFn?: (p: string) => { mtimeMs: number };
}

export function buildQueueStats(
  cfg: Config,
  inputs: QueueStatsInputs,
  deps?: QueueStatsDeps,
): QueueStats;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/queueStats.test.ts — sketch; follow existing suite conventions
import { describe, it, expect } from "vitest";
import { buildQueueStats } from "../src/tui/queueStats.js";
// fixtures: cfg with dataDir/queueRoot + maxConcurrent 2 (cast-through-unknown
// or reuse a makeConfig helper if one exists for tui suites); NOW =
// 2026-07-19T12:00:00Z; a history fake returning canned TaskRecords.
```

Cases (one `it` each):

1. **Ledger 24h window**: records within 24h — 3 done (`completed`, durations 60/120/180, tokens 10/20/30 in, 1/2/3 out, cost 0.1 each) + 1 failed (`timeout`, duration 120, tokens 30 in / 4 out, cost 0.1) → `window24h` = `{ done: 3, failed: 1, successRate: 0.75, avgDurationSeconds: 120, tokensIn: 90, tokensOut: 10, costUsd: 0.4 }` — the avg and sums cover ALL finalized tasks in the window, done + failed (a slot is busy either way; that's what the ETA consumer needs). Records older than 24h but inside 7d appear in `perDay7d` but not `window24h`.
2. **Done classification** uses `TERMINAL_DONE_STATUSES` (e.g. `timeout_partial` counts done, `aborted_no_changes` counts failed — pick two real statuses and assert).
3. **perDay7d**: records on three different LOCAL calendar days → 7 buckets oldest→newest with counts in the right slots (construct record times at local noon via `new Date(y, m, d, 12).toISOString()` so the test is TZ-proof); empty history → `[]`.
4. **Dir fallback**: history returns `[]`; `readdirFn`/`statFn` fake done/ (2 files ≤24h, 1 older) and failed/ (1 file ≤24h) → `window24h` = `{ done: 2, failed: 1, successRate: 2/3, avgDurationSeconds: null, tokensIn: null, tokensOut: null, costUsd: null }`, `perDay7d: []`.
5. **ETA**: avg 120s, `eligibleWaiting: 3`, `maxConcurrent: 2` → `etaSeconds: 180`; `avgDurationSeconds: null` → `etaSeconds: null`; `eligibleWaiting: 0` → `etaSeconds: 0`.
6. **healthBody passthrough**: gate `{ state: "rate_limited", reason: "429", since: "...", until: "..." }` → `gate` keeps state/reason/until; `metrics.lastPollAt`, `spend`, guards (`guardNudges/guardKills/requeues`), `pendingRestartFields` all mapped.
7. **Daemon down** (`healthBody: null`) → `gate/lastPollAt/spend/guards` all null, `pendingRestartFields: []`, while window/outbox fields still populate.
8. **successRate null** when done+failed === 0 (both paths).

- [ ] **Step 2: Run — fail.** `npx vitest run tests/queueStats.test.ts > /tmp/t6 2>&1; echo "exit: $?"` → non-zero.

- [ ] **Step 3: Implement**

```ts
// src/tui/queueStats.ts
/**
 * Derived queue statistics: the task-history ledger (24h/7d windows), the
 * one /health body the snapshot layer already fetched (gate/heartbeat/spend/
 * guards), and queue-dir mtimes (fallback counts when the ledger is empty in
 * the window — fresh upgrade). Pure w.r.t. deps seams; never throws.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../types.js";
import { TERMINAL_DONE_STATUSES } from "../types.js";
import { queuePaths } from "../config.js";
import type { HealthBody } from "./healthBody.js";
import type { TaskRecord } from "../taskHistory.js";

// … interfaces from the task header verbatim …

const DAY_MS = 86_400_000;

/** mtimes (ms) of the .md files in a queue dir; unreadable dir/file → skipped. */
function mdMtimes(
  dir: string,
  readdirFn: (d: string) => string[],
  statFn: (p: string) => { mtimeMs: number },
): number[] {
  try {
    return readdirFn(dir)
      .filter((n) => n.endsWith(".md"))
      .flatMap((n) => {
        try {
          return [statFn(join(dir, n)).mtimeMs];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** LOCAL calendar-day key (spendLedger precedent: the operator's wall-clock
 * day, not UTC). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function buildQueueStats(
  cfg: Config,
  inputs: QueueStatsInputs,
  deps: QueueStatsDeps = {},
): QueueStats {
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const readdirFn = deps.readdirFn ?? readdirSync;
  const statFn = deps.statFn ?? statSync;
  const now = nowFn();
  const since24 = new Date(now.getTime() - DAY_MS);
  const since7d = new Date(now.getTime() - 7 * DAY_MS);

  const recs7d = inputs.history(since7d);
  const recs24 = recs7d.filter((r) => Date.parse(r.at) >= since24.getTime());
  const isDone = (status: string): boolean => TERMINAL_DONE_STATUSES.has(status);

  let window24h: QueueStats["window24h"];
  if (recs24.length > 0) {
    const done = recs24.filter((r) => isDone(r.status)).length;
    const failed = recs24.length - done;
    const sum = (f: (r: TaskRecord) => number): number => recs24.reduce((a, r) => a + f(r), 0);
    window24h = {
      done,
      failed,
      successRate: done / recs24.length,
      // Average over ALL finalized tasks in the window (done + failed) — the
      // ETA consumer wants "how long does a slot stay busy", not "how long do
      // successes take".
      avgDurationSeconds: Math.round(sum((r) => r.durationSeconds) / recs24.length),
      tokensIn: sum((r) => r.tokensIn),
      tokensOut: sum((r) => r.tokensOut),
      costUsd: sum((r) => r.costUsd),
    };
  } else {
    // Fresh-upgrade fallback: stat-only counts from the terminal dirs.
    const paths = queuePaths(cfg);
    const doneN = mdMtimes(paths.done, readdirFn, statFn).filter(
      (t) => t >= since24.getTime(),
    ).length;
    const failedN = mdMtimes(paths.failed, readdirFn, statFn).filter(
      (t) => t >= since24.getTime(),
    ).length;
    window24h = {
      done: doneN,
      failed: failedN,
      successRate: doneN + failedN > 0 ? doneN / (doneN + failedN) : null,
      avgDurationSeconds: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
    };
  }
  if (window24h.done + window24h.failed === 0) window24h.successRate = null;

  let perDay7d: QueueStats["perDay7d"] = [];
  if (recs7d.length > 0) {
    const keys: string[] = [];
    for (let i = 6; i >= 0; i--) keys.push(dayKey(new Date(now.getTime() - i * DAY_MS)));
    const byDay = new Map(keys.map((k) => [k, { done: 0, failed: 0 }]));
    for (const r of recs7d) {
      const b = byDay.get(dayKey(new Date(r.at)));
      if (b) isDone(r.status) ? b.done++ : b.failed++;
    }
    perDay7d = keys.map((k) => byDay.get(k) as { done: number; failed: number });
  }

  const avg = window24h.avgDurationSeconds;
  const etaSeconds =
    avg === null
      ? null
      : Math.round((inputs.eligibleWaiting * avg) / Math.max(1, cfg.maxConcurrent));

  const m = inputs.healthBody?.metrics ?? null;
  return {
    gate:
      inputs.healthBody?.gate != null
        ? {
            state: inputs.healthBody.gate.state,
            reason: inputs.healthBody.gate.reason,
            until: inputs.healthBody.gate.until,
          }
        : null,
    lastPollAt: m?.lastPollAt ?? null,
    window24h,
    perDay7d,
    etaSeconds,
    spend:
      inputs.healthBody?.spend != null
        ? {
            todayUsd: inputs.healthBody.spend.todayUsd,
            dailyBudgetUsd: inputs.healthBody.spend.dailyBudgetUsd,
          }
        : null,
    guards:
      m !== null
        ? { nudges: m.guardNudges ?? 0, kills: m.guardKills ?? 0, requeues: m.requeues ?? 0 }
        : null,
    outbox: inputs.outbox,
    pendingRestartFields: m?.pendingRestartFields ?? [],
  };
}
```

(Adjust the `isDone ? b.done++ : b.failed++` expression-statement to an `if/else` if eslint complains about unused expressions.)

- [ ] **Step 4: Run — pass.** Same command → 0.
- [ ] **Step 5: Commit.** `git commit -m "feat(tui): buildQueueStats — ledger windows, ETA, gate/heartbeat/spend passthrough"`

---

### Task 7: widen `QueueSnapshot` (stats + row fields + shared health fetch)

**Files:**

- Modify: `src/tui/queueSnapshot.ts`, `src/tui/localSnapshot.ts` (`emptyQueue` gains `stats: null`)
- Test: `tests/queueSnapshot.test.ts` (extend) + fixture sweep across any test building `QueueSnapshot`/row literals (expect `tests/{tuiApp,rail,queueView,localDashboard,tuiMouseApp}.test.*` and `tests/helpers/localFixtures.tsx` — find them all with `grep -rln "QueueSnapshot\|daemonUp" tests/`)

**Interfaces:**

- Produces (all required, null-able — matching the existing field style):
  - `QueueRunning.updatedAt: string | null`
  - `QueueWaiting.queuedAt: string | null`
  - `QueueRecent.resultStatus: string | null; durationSeconds: number | null; prUrl: string | null`
  - `QueueSnapshot.stats: QueueStats | null` (null only on the error-path base object)
- Consumes: `fetchHealthBody` (Task 5), `buildQueueStats` (Task 6), `makeTaskHistoryReader` (Task 3), `parseResultMeta` (Task 1), `outboxDepth` + `deadCount` from `../githubOutbox.js` (if `deadCount` lacks a deps parameter, extend it additively with `{ readdirFn? }` mirroring `outboxDepth`).

- [ ] **Step 1: Failing tests** in `tests/queueSnapshot.test.ts` (existing harness style — injected readdir/readFile/stat/fetch fakes):
  - Waiting rows carry `queuedAt` = the inbox file's mtime ISO; stat failure → `queuedAt: null`.
  - Running rows carry `updatedAt` from `currentProgress[id].updatedAt`; absent → null; processing-fallback rows → null.
  - Recent rows: a done file whose content ends with a junco-result block (`status: timeout_partial`, `duration_seconds: 61`, `pr_url: ...`) → `resultStatus/durationSeconds/prUrl` populated; a legacy file without a block → all three null and the row otherwise identical to today.
  - `snap.stats` is populated: with a fake healthBody (via `healthOverride`) carrying gate/lastPollAt, and a fake ledger shard readable through `readFileFn`/`statFn`, assert `stats.gate.state`, `stats.lastPollAt`, `stats.window24h.done`, and `stats.outbox.depth/dead` (fake outbox dirs).
  - Self-fetch path (no `healthOverride`): the fake `fetchFn` returns a full HealthBody JSON — assert gate reaches `stats.gate` (proves the fetch now parses the full body).
  - Error path (`nowFn` throws) → `stats: null` (base object).
  - `eligibleWaiting` honored: one deferred + two eligible waiting with a ledger avg → `stats.etaSeconds` uses 2, not 3.

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement** in `queueSnapshot.ts`:
  - `HealthProgress` gains `updatedAt?: string`; `mkRunning` maps `updatedAt: p?.updatedAt ?? null`; the processing-fallback literal gains `updatedAt: null`.
  - Waiting map: wrap `statFn(p)` in try/catch to produce `queuedAt` (ISO from mtimeMs) — restructure the flatMap to keep the path alongside the parsed ticket.
  - Recent map: read content once, then `parseTicket` (try→null) + `parseResultMeta(content)` (try→all-null wrapper) — replacing the `parseAt(e.p)` call so the file is read a single time.
  - Health: replace the inline self-fetch with `const body = deps.healthOverride !== undefined ? deps.healthOverride.body : await fetchHealthBody(cfg, { fetchFn });` then `daemonUp = body !== null`, `running = mkRunning(body.metrics?.currentTickets ?? [], body.metrics?.currentProgress ?? {})` when up. Delete the now-dead narrow JSON parse and `HEALTH_TIMEOUT_MS`/AbortController plumbing (it lives in `fetchHealthBody`).
  - Factory scope: `const historyReader = makeTaskHistoryReader(cfg, { readFileFn: deps.readFileFn, statFn: deps.statFn, nowFn: deps.nowFn });` (memo survives across ticks).
  - After `outboxDepth`: `const outboxDead = deadCount(cfg, { readdirFn });` and

```ts
const stats = buildQueueStats(
  cfg,
  {
    healthBody: body,
    history: historyReader,
    eligibleWaiting: waiting.filter((w) => !w.deferred).length,
    outbox: { depth: outboxDepth, dead: outboxDead },
  },
  { nowFn: deps.nowFn, readdirFn, statFn },
);
return { ...base, daemonUp, running, waiting, recent, outboxDepth, stats };
```

- `base` gains `stats: null`; `emptyQueue` in `localSnapshot.ts` gains `stats: null`.

- [ ] **Step 4: Fixture sweep.** `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/tc7 2>&1; echo "exit: $?"` — every test literal building `QueueSnapshot`/`QueueRunning`/`QueueWaiting`/`QueueRecent` needs the new null fields. Fix them all in this commit (compare error list against the pre-change baseline; only NEW errors count).
- [ ] **Step 5: Run — pass.** `npx vitest run tests/queueSnapshot.test.ts > /tmp/t7 2>&1; echo "exit: $?"` → 0, then the full suite `npx vitest run > /tmp/t7f 2>&1; echo "exit: $?"` → 0.
- [ ] **Step 6: Commit.** `git commit -m "feat(tui): QueueSnapshot carries stats + wait/stall/result enrichment"`

---

### Task 8: QueueView rendering + `queueFmt` helpers

**Files:**

- Modify: `src/tui/queueFmt.ts`, `src/tui/components/QueueView.tsx`
- Test: `tests/queueFmt.test.ts` (extend), `tests/queueView.test.tsx` (extend; if QueueView is covered inside another suite, extend that one — locate with `grep -rln "QueueView" tests/`)

**Interfaces:**

- `queueFmt.ts` produces:
  - `fmtDurShort(seconds: number): string` — `45s` / `12m` / `2h13m` (minutes floor; hours + remainder minutes).
  - `fmtSpark(values: number[]): string` — `▁▂▃▄▅▆▇█` per value scaled to `max(values, 1)`; `v === 0` → `▁`, else `BARS[Math.max(1, Math.round((v / max) * 7))]`.
  - `oldestQueuedAt(waiting: { queuedAt: string | null; deferred: boolean }[]): string | null` — min `queuedAt` among ELIGIBLE (non-deferred) rows, null when none.
- QueueView consumes `snap.stats` + the Task 7 row fields. `STALL_MS = 5 * 60_000` module constant.

- [ ] **Step 1: Failing tests.**
  - `queueFmt`: table-driven cases for the three helpers (incl. `fmtSpark([0,0])` → `▁▁`, `fmtSpark([1, 8])` → `▁█`-adjacent, `oldestQueuedAt` skipping deferred and nulls).
  - QueueView render (ink-testing-library, loop-until-condition):
    1. Gate ≠ ok → a `▸ paused — rate limited (retry HH:MM)` line under the title (state underscores → spaces; `until` → `(retry ${fmtClock(until)})`; no until + reason → ` — ${reason}`); gate ok/null → no line.
    2. `daemonUp` + `lastPollAt` → RUNNING header contains `· ↻ poll 2s ago`; daemon down → header unchanged from today.
    3. Running row with `updatedAt` older than 5m → an extra `⚠ no activity 6m` line; fresher → no line; `stale` rows → no line.
    4. WAITING header: 3 rows (1 deferred) with queuedAt values → `WAITING (3 · 1 deferred · oldest 42m)`; no deferred/no queuedAt → plain `WAITING (3)`.
    5. Waiting row with `queuedAt` → trailing dim `· queued 42m` segment.
    6. Recent row with resultMeta → `✓ #45 exec completed 11m · 2h ago`; without → today's exact rendering (regression assert).
    7. STATS section: with a full `stats` fixture assert the four content lines render (`24h 14✓ 2✗ (88%) · avg 12m · ETA ~36m`, `7d 84✓ 9✗ ` + 7 spark glyphs, `spend $4.20/$10.00 · tok 1.2M in 340k out`, `guards 1 nudges · 3 requeues · outbox 2 queued`) plus `⚠ restart to apply: max_concurrent` when pendingRestartFields non-empty; with nulls (fallback stats) the avg/ETA/7d/tok segments/lines are absent; `stats: null` → no STATS section at all.
    8. **Selectable-index stability**: LOCAL-style props (`selectable`, `selectedRow` on a RECENT row, `onRowPress`) with full stats present — pressing the row still reports the same index, and the selected row is the same ticket as before the stats existed (assert via rendered `▌` position).
  - ETA/segment omission rules: `etaSeconds: 0` or null → no ETA segment; `successRate: null` → no `(NN%)`.

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement.**

`queueFmt.ts`:

```ts
/** `45s` / `12m` / `2h13m` — result-duration and avg/ETA column format. */
export function fmtDurShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

const SPARK_BARS = "▁▂▃▄▅▆▇█";

/** One glyph per value, scaled to the series max (0 pins to ▁). */
export function fmtSpark(values: number[]): string {
  const max = Math.max(...values, 1);
  return values
    .map((v) => (v <= 0 ? SPARK_BARS[0] : SPARK_BARS[Math.max(1, Math.round((v / max) * 7))]))
    .join("");
}

/** Earliest queuedAt among ELIGIBLE (non-deferred) waiting rows, else null. */
export function oldestQueuedAt(
  waiting: { queuedAt: string | null; deferred: boolean }[],
): string | null {
  let oldest: string | null = null;
  for (const w of waiting) {
    if (w.deferred || w.queuedAt === null) continue;
    if (oldest === null || Date.parse(w.queuedAt) < Date.parse(oldest)) oldest = w.queuedAt;
  }
  return oldest;
}
```

`QueueView.tsx` (all inside the existing flat-row build; STATS rows use plain `rows.push(<Text …>)` — never `pressable`, so `selRowIndex` bookkeeping is untouched):

- After the title row: the paused banner (`theme.warn`, `wrap="truncate-end"`).
- RUNNING header text becomes `` `RUNNING (${n}/${max})` `` plus, when `snap.daemonUp && snap.stats?.lastPollAt`, a dim ` · ↻ poll ${fmtAge(lastPollAt, now)}` suffix.
- After each running progress line: the stall line when `!r.stale && r.updatedAt !== null && now.getTime() - Date.parse(r.updatedAt) >= STALL_MS` → `⚠ no activity ${fmtAgeShort(r.updatedAt, now)}` (`theme.warn`, indented like the progress line).
- WAITING header: deferred count + `oldest ${fmtAgeShort(oldestQueuedAt(snap.waiting), now)}` segments, each omitted when empty/null.
- Waiting rows: after the yellow note, a dim ` · queued ${fmtAgeShort(w.queuedAt, now)}` when non-null (separator only when a note precedes).
- Recent rows: when `r.resultStatus !== null` insert ` {resultStatus}` (+ ` ${fmtDurShort(durationSeconds)}` when non-null) between label and the dim age, and the age gains a `· ` prefix (matching the mock); null → exactly today's output.
- STATS section after the recent rows: blank spacer + `STATS` bold header + the lines per the omission rules above (spend renders `$X.XX/$Y.YY` only when `dailyBudgetUsd > 0`, else `$X.XX today`; the guards line drops zero segments and is omitted entirely when everything is zero; tokens use `fmtCompact`).

- [ ] **Step 4: Run — pass.** New/extended suites + `npx vitest run > /tmp/t8 2>&1; echo "exit: $?"` → 0 (App-level suites asserting queue output may need their expectations extended — update them to the new lines, never by weakening assertions).
- [ ] **Step 5: Commit.** `git commit -m "feat(tui): QueueView monitoring — pause banner, heartbeat, stalls, wait ages, STATS"`

---

### Task 9: rail card + `junco status` parity

**Files:**

- Modify: `src/tui/components/Rail.tsx`, `src/statusCmd.ts`
- Test: `tests/rail.test.tsx` (or wherever Rail renders are covered — `grep -rln "Rail" tests/`), `tests/statusCmd.test.ts`

**Interfaces:**

- Rail consumes `queue.stats` (already on its `QueueSnapshot` prop) + `oldestQueuedAt`.
- `StatusDeps` gains `readTaskHistoryFn?: typeof readTaskHistory` and `nowFn?: () => Date`; statusCmd consumes `readTaskHistory` (Task 3), `fmtDurShort`-equivalent local formatting (statusCmd has its own `fmtUptime` — reuse it for avg/oldest to avoid a CLI→tui import; do NOT import from `src/tui/`).

- [ ] **Step 1: Failing tests.**
  - Rail: gate ≠ ok in `queue.stats` → a warn `▸ paused — rate limited` line directly under the `queue` header; ok/null → absent. Waiting line with queuedAt data → `3 waiting · oldest 42m`; without → `3 waiting` (regression).
  - statusCmd: with a fake `readTaskHistoryFn` returning 24h records → output contains `stats:     24h 3 ok / 1 failed · avg 2m · oldest wait 42m` (oldest from fake inbox mtimes via the existing dir counting seams — statusCmd stats inbox files with `statSync`; inject through a new optional `statFn` dep if the suite can't reach it otherwise); with empty history AND empty dirs → no `stats:` line; /health body with gate `{ state: "rate_limited", reason: "429 from provider" }` → `gate:      rate_limited — 429 from provider` line; gate ok → no line.

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement.**
  - Rail: import `oldestQueuedAt, fmtAgeShort`; under the `queue` header add

```tsx
{
  queue?.stats?.gate != null && queue.stats.gate.state !== "ok" && (
    <Text color={theme.warn} wrap="truncate">
      ▸ paused — {queue.stats.gate.state.replace(/_/g, " ")}
    </Text>
  );
}
```

    and extend the waiting line: `{queue.waiting.length} waiting` gains ` · oldest ${fmtAgeShort(oldest, now)}` when `oldestQueuedAt(queue.waiting)` is non-null.

- statusCmd: parse `gate` off the /health body (widen the inline response type with `gate?: { state: string; reason: string | null }`); push a `gate:` detail line when state ≠ "ok". After the `queue:` line, compute: `const recs = (deps.readTaskHistoryFn ?? readTaskHistory)(cfg, { since: new Date(now - 86_400_000) });` → done/failed via `TERMINAL_DONE_STATUSES`, avg from `durationSeconds`; fallback to done/failed dir mtime counts when `recs.length === 0` (reuse the countMd pattern with stat); oldest wait from inbox file mtimes. Print the `stats:` line only when any component is non-empty. Formatting: counts plain, avg/oldest via `fmtUptime`-style rendering.

- [ ] **Step 4: Run — pass.** Affected suites + full run → 0.
- [ ] **Step 5: Commit.** `git commit -m "feat: queue stats reach the rail card and junco status"`

---

### Task 10: docs truth sweep

**Files:**

- Modify: `ARCHITECTURE.md`, `CHANGELOG.md` (Unreleased), `docs/dashboard.md`, `docs/superpowers/specs/2026-07-19-queue-monitoring-design.md`; check `docs/data*.md` / anything `grep -rl "assess-history\|dataDir" docs/` surfaces that enumerates the data tree.

- [ ] **Step 1: Sweep.**
  - ARCHITECTURE.md: add `taskHistory.ts` / `queueStats.ts` / `resultMeta.ts` / `healthBody.ts` to the module map; document the `history/` shard store in the data-tree section; note the finalized-point hook.
  - CHANGELOG.md Unreleased → Added: task-history ledger; queue monitoring in the TUI (pause banner, heartbeat, stall detection, wait ages, enriched RECENT, STATS section); rail + `junco status` stats. No Behavior-change entries needed (all additive).
  - docs/dashboard.md: update the queue-section description to the new rendering.
  - Spec: append a short "Implementation deviations" note — (a) assess/analyze flow results already carried `result: RunResult`, so only `PrFlowResult` gained the additive fields; (b) the shard memo keys on `mtimeMs` alone (appends always bump mtime; keeps the shared statFn seam shape).
- [ ] **Step 2: Full gate.** `npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/gate 2>&1; echo "exit: $?"` → 0 (capture vitest exit explicitly).
- [ ] **Step 3: Commit.** `git commit -m "docs: queue monitoring — architecture, changelog, dashboard docs"`
