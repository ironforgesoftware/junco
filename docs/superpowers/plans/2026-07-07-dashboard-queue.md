# Dashboard Queue Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the local ticket queue in `junco dashboard`: an always-on queue strip (running ticket + live progress + next-up) and a full queue view on `t`.

**Architecture:** A new pure-ish `src/tui/queueSnapshot.ts` reads the queue dirs (mirroring `claimNextTask`'s exact ordering) and the daemon's `/health` progress into one `QueueSnapshot`; two new Ink components render it; `App.tsx` polls it on a 2 s interval. One additive daemon change: `RunMetrics` progress entries gain `startedAt` so elapsed time is displayable.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), Ink 7.1.0 + React 19.2.7 (already present — NO new dependencies), vitest + ink-testing-library.

**Spec:** `docs/superpowers/specs/2026-07-07-dashboard-queue-design.md`

## Global Constraints

- Branch: `feat/dashboard-queue` off `main`. Conventional commits, suite green at every commit. **No AI attribution** (no `Co-Authored-By: Claude`, no "Generated with Claude Code") — amend it away if a tool appends it.
- **No new dependencies, no new config keys.** Dependencies are exact-pinned; nothing here needs one.
- The queue-view key is **`t`** — `q` quits the dashboard and must keep doing so.
- Waiting order MUST mirror `claimNextTask` (`src/runOnce.ts`): lexicographic filename discovery → skip-unreadable → **stable sort by priority rank descending** → `not_before` gate (unparseable stamp = eligible). `PRIORITY_RANK` moves to `src/types.ts` and stays the ONLY definition.
- The `/health` JSON change is **additive only**: `currentProgress` entries gain `startedAt`; no field is renamed or removed.
- Every side effect behind an injectable deps seam; tests never touch the network or a real daemon.
- Never map ticket → issue by parsing filenames; use the parsed `github:` frontmatter (`TicketGithub`).
- Ink/TUI tests: never assert one fixed `setTimeout` tick after a state change — loop-until-condition with bounded retries (CLAUDE.md gotcha).
- Vitest exit-code trap: never pipe test output through a filter; capture `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`.
- Run `npx prettier --write` on touched files before every commit (100-col config).
- This checkout doubles as the maintainer's live runtime: NEVER touch `config.toml`, `tickets/`, `worktrees/`, `launchd.out/err`; never run `junco start` here. All queue-dir tests use `mkdtempSync` sandboxes.

---

### Task 1: `RunMetrics` progress entries gain `startedAt`

**Files:**
- Modify: `src/metrics.ts` (progress record type ~line 33 and ~line 59; `taskStarted` ~line 94; `setTaskProgress` ~line 111)
- Test: `tests/metrics.test.ts` (append to the existing progress describe-block near line 274)

**Interfaces:**
- Consumes: existing `RunMetrics` (constructor takes `now: () => Date`).
- Produces: `MetricsSnapshot.currentProgress` entries typed `{ turns: number; lastTool: string | null; outputTokens: number; startedAt: string; updatedAt: string }`. `taskStarted(id)` seeds an entry (`turns: 0, lastTool: null, outputTokens: 0`) stamped `startedAt = updatedAt = now`. `setTaskProgress` preserves an existing `startedAt`, defaulting to now when the entry doesn't exist. Task 2's health consumer relies on `startedAt` being present for every in-flight ticket.

- [ ] **Step 1: Write the failing tests**

Append to `tests/metrics.test.ts` (inside or alongside the existing progress tests; match the file's existing `RunMetrics` import and style):

```ts
describe("progress startedAt (dashboard elapsed-time support)", () => {
  it("taskStarted seeds a progress entry stamped startedAt", () => {
    let t = new Date("2026-07-07T10:00:00Z");
    const m = new RunMetrics(() => t);
    m.taskStarted("t-1");
    const p0 = m.snapshot().currentProgress["t-1"];
    expect(p0).toBeDefined();
    expect(p0.startedAt).toBe("2026-07-07T10:00:00.000Z");
    expect(p0.turns).toBe(0);
    expect(p0.lastTool).toBeNull();
    expect(p0.outputTokens).toBe(0);
  });

  it("setTaskProgress preserves startedAt and advances updatedAt", () => {
    let t = new Date("2026-07-07T10:00:00Z");
    const m = new RunMetrics(() => t);
    m.taskStarted("t-1");
    t = new Date("2026-07-07T10:05:00Z");
    m.setTaskProgress("t-1", { turns: 4, lastTool: "bash", outputTokens: 1200 });
    const p = m.snapshot().currentProgress["t-1"];
    expect(p.startedAt).toBe("2026-07-07T10:00:00.000Z");
    expect(p.updatedAt).toBe("2026-07-07T10:05:00.000Z");
    expect(p.turns).toBe(4);
  });

  it("setTaskProgress without a prior taskStarted defaults startedAt to now", () => {
    const m = new RunMetrics(() => new Date("2026-07-07T10:00:00Z"));
    m.setTaskProgress("t-2", { turns: 1, lastTool: null, outputTokens: 0 });
    expect(m.snapshot().currentProgress["t-2"].startedAt).toBe("2026-07-07T10:00:00.000Z");
  });

  it("taskStarted twice does not reset startedAt", () => {
    let t = new Date("2026-07-07T10:00:00Z");
    const m = new RunMetrics(() => t);
    m.taskStarted("t-1");
    t = new Date("2026-07-07T10:09:00Z");
    m.taskStarted("t-1"); // idempotent re-add must not clobber
    expect(m.snapshot().currentProgress["t-1"].startedAt).toBe("2026-07-07T10:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/metrics.test.ts > /tmp/t1 2>&1; echo "exit: $?"; tail -20 /tmp/t1`
Expected: FAIL — `p0` is undefined (taskStarted doesn't seed progress today) and `startedAt` missing.

- [ ] **Step 3: Implement**

In `src/metrics.ts`, make these four changes:

1. `MetricsSnapshot.currentProgress` (~line 33) and the private `_progress` field (~line 59) both gain `startedAt: string`:

```ts
  /** Live per-ticket progress (turns, last tool, output tokens) keyed by id. */
  currentProgress: Record<
    string,
    {
      turns: number;
      lastTool: string | null;
      outputTokens: number;
      startedAt: string;
      updatedAt: string;
    }
  >;
```

(mirror the same shape on the private field's type)

2. `taskStarted` seeds a progress entry so every in-flight ticket has a `startedAt` from the moment it starts (not only after the first progress event):

```ts
  /** A task entered execution. Seeds its progress entry (startedAt = now). */
  taskStarted(id: string): void {
    if (!this._current.includes(id)) this._current.push(id);
    if (!this._progress[id]) {
      const now = this._now().toISOString();
      this._progress[id] = {
        turns: 0,
        lastTool: null,
        outputTokens: 0,
        startedAt: now,
        updatedAt: now,
      };
    }
  }
```

3. `setTaskProgress` preserves `startedAt` (defaulting for embedders that never call `taskStarted`):

```ts
  /** Record a live progress snapshot for an in-flight ticket. */
  setTaskProgress(
    id: string,
    p: { turns: number; lastTool: string | null; outputTokens: number },
  ): void {
    const now = this._now().toISOString();
    this._progress[id] = {
      ...p,
      startedAt: this._progress[id]?.startedAt ?? now,
      updatedAt: now,
    };
  }
```

4. No change needed in `snapshot()`/`reset()` (they spread/clear the record as-is).

- [ ] **Step 4: Run the full metrics + health suites**

Run: `npx vitest run tests/metrics.test.ts tests/healthServer.test.ts tests/health.test.ts tests/daemon.test.ts > /tmp/t1 2>&1; echo "exit: $?"; tail -5 /tmp/t1`
Expected: PASS (the `healthServer.test.ts` snapshot literal uses `currentProgress: {}` — unaffected). If any other test builds a full progress-entry literal, add `startedAt` there too.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/metrics.ts tests/metrics.test.ts
git add src/metrics.ts tests/metrics.test.ts
git commit -m "feat(metrics): stamp startedAt on in-flight ticket progress"
```

---

### Task 2: `queueSnapshot` module (+ `PRIORITY_RANK` promoted to types.ts)

**Files:**
- Modify: `src/types.ts` (add `PRIORITY_RANK` after the `Ticket` interface, ~line 156)
- Modify: `src/runOnce.ts` (delete local `PRIORITY_RANK` at line 22; import from types)
- Create: `src/tui/queueSnapshot.ts`
- Test: `tests/queueSnapshot.test.ts`

**Interfaces:**
- Consumes: `parseTicket(path, raw, defaultTimeoutMinutes)` from `src/ticket.ts`; `queuePaths(cfg)` from `src/config.ts`; `Ticket`, `TicketGithub`, `Config` from `src/types.ts`; Task 1's `startedAt` in `/health` `currentProgress`.
- Produces (Tasks 3–5 rely on these exact names):
  - `PRIORITY_RANK: Record<Ticket["priority"], number>` exported from `src/types.ts`.
  - `interface QueueRunning { id: string; github: TicketGithub | null; turns: number | null; lastTool: string | null; outputTokens: number | null; startedAt: string | null; stale: boolean }`
  - `interface QueueWaiting { id: string; github: TicketGithub | null; kind: "pr" | "ask" | "plan"; priority: "low" | "normal" | "high"; retryCount: number; notBefore: string | null; deferred: boolean }`
  - `interface QueueRecent { id: string; github: TicketGithub | null; status: "done" | "failed"; finishedAt: string }`
  - `interface QueueSnapshot { daemonUp: boolean; maxConcurrent: number; running: QueueRunning[]; waiting: QueueWaiting[]; recent: QueueRecent[]; error: string | null }`
  - `makeQueueSnapshotFn(cfg: Config, deps?: QueueSnapshotDeps): () => Promise<QueueSnapshot>`
  - `stripStamp(name: string): string` (exported for tests)

- [ ] **Step 1: Write the failing tests**

Create `tests/queueSnapshot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeQueueSnapshotFn, stripStamp } from "../src/tui/queueSnapshot.js";
import type { Config } from "../src/types.js";

/** Minimal config over a sandboxed queue root (same cast style as dashboardCmd.test.ts). */
function makeQueueCfg(root: string, overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: root,
    juncoSubdir: "q",
    defaultTimeoutMinutes: 30,
    maxConcurrent: 1,
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    ...overrides,
  } as unknown as Config;
}

function setupDirs(): { root: string; inbox: string; processing: string; done: string; failed: string } {
  const root = mkdtempSync(join(tmpdir(), "junco-qsnap-"));
  const dirs = {
    root,
    inbox: join(root, "q", "inbox"),
    processing: join(root, "q", "processing"),
    done: join(root, "q", "done"),
    failed: join(root, "q", "failed"),
  };
  for (const d of [dirs.inbox, dirs.processing, dirs.done, dirs.failed]) {
    mkdirSync(d, { recursive: true });
  }
  return dirs;
}

function writeTicket(dir: string, name: string, fm: string, body = "do the thing"): void {
  writeFileSync(join(dir, name), `---\n${fm}\n---\n\n${body}\n`);
}

/** /health fetch fake: resolve with the given metrics, or reject. */
function healthFetch(metrics: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({ ready: true, metrics }),
  })) as unknown as typeof fetch;
}
const downFetch: typeof fetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

describe("stripStamp", () => {
  it("strips the claim prefix and leaves clean names alone", () => {
    expect(stripStamp("2026-07-07T1005Z__gh-a-b-46-plan")).toBe("gh-a-b-46-plan");
    expect(stripStamp("gh-a-b-46-plan")).toBe("gh-a-b-46-plan");
    expect(stripStamp("my__odd__name")).toBe("my__odd__name"); // no stamp → untouched
  });
});

describe("waiting list", () => {
  it("orders by priority rank desc, stable (filename order) within rank", async () => {
    const d = setupDirs();
    writeTicket(d.inbox, "a-normal.md", "id: a-normal");
    writeTicket(d.inbox, "b-high.md", "id: b-high\npriority: high");
    writeTicket(d.inbox, "c-normal.md", "id: c-normal");
    writeTicket(d.inbox, "d-low.md", "id: d-low\npriority: low");
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.waiting.map((w) => w.id)).toEqual(["b-high", "a-normal", "c-normal", "d-low"]);
  });

  it("marks future not_before as deferred (keeps position); past/garbage are eligible", async () => {
    const d = setupDirs();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    writeTicket(d.inbox, "a.md", `id: a\nnot_before: "${future}"\nretry_count: 2`);
    writeTicket(d.inbox, "b.md", `id: b\nnot_before: "${past}"`);
    writeTicket(d.inbox, "c.md", 'id: c\nnot_before: "not-a-date"');
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.waiting.map((w) => [w.id, w.deferred])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    expect(snap.waiting[0].notBefore).toBe(future);
    expect(snap.waiting[0].retryCount).toBe(2);
    expect(snap.waiting[1].notBefore).toBeNull();
  });

  it("derives kind: github kind wins; manual repo → pr; manual bare → ask", async () => {
    const d = setupDirs();
    writeTicket(
      d.inbox,
      "a-plan.md",
      "id: a-plan\ngithub:\n  nwo: acme/api\n  issue: 46\n  kind: plan",
    );
    writeTicket(d.inbox, "b-repo.md", "id: b-repo\nrepo: ~/src/thing");
    writeTicket(d.inbox, "c-bare.md", "id: c-bare");
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.waiting.map((w) => [w.id, w.kind])).toEqual([
      ["a-plan", "plan"],
      ["b-repo", "pr"],
      ["c-bare", "ask"],
    ]);
    expect(snap.waiting[0].github).toEqual({ nwo: "acme/api", issue: 46, kind: "plan" });
    expect(snap.waiting[1].github).toBeNull();
  });

  it("skips unreadable inbox files instead of failing the snapshot", async () => {
    const d = setupDirs();
    writeTicket(d.inbox, "good.md", "id: good");
    writeTicket(d.inbox, "gone.md", "id: gone");
    const readFileFn = (p: string): string => {
      if (p.endsWith("gone.md")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return require("node:fs").readFileSync(p, "utf8") as string;
    };
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: downFetch,
      readFileFn,
    })();
    expect(snap.waiting.map((w) => w.id)).toEqual(["good"]);
    expect(snap.error).toBeNull();
  });
});

describe("running", () => {
  it("daemon up: currentTickets enriched from currentProgress and processing/ github map", async () => {
    const d = setupDirs();
    writeTicket(
      d.processing,
      "2026-07-07T1005Z__gh-acme-api-46.md",
      "id: gh-acme-api-46\nrepo: /c/api\ngithub:\n  nwo: acme/api\n  issue: 46\n  kind: pr",
    );
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: healthFetch({
        currentTickets: ["gh-acme-api-46"],
        currentProgress: {
          "gh-acme-api-46": {
            turns: 14,
            lastTool: "bash",
            outputTokens: 12345,
            startedAt: "2026-07-07T10:00:00.000Z",
            updatedAt: "2026-07-07T10:04:00.000Z",
          },
        },
      }),
    })();
    expect(snap.daemonUp).toBe(true);
    expect(snap.running).toEqual([
      {
        id: "gh-acme-api-46",
        github: { nwo: "acme/api", issue: 46, kind: "pr" },
        turns: 14,
        lastTool: "bash",
        outputTokens: 12345,
        startedAt: "2026-07-07T10:00:00.000Z",
        stale: false,
      },
    ]);
  });

  it("daemon up but no progress entry yet: nulls, not a crash", async () => {
    const d = setupDirs();
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: healthFetch({ currentTickets: ["mystery"], currentProgress: {} }),
    })();
    expect(snap.running).toEqual([
      {
        id: "mystery",
        github: null,
        turns: null,
        lastTool: null,
        outputTokens: null,
        startedAt: null,
        stale: false,
      },
    ]);
  });

  it("daemon down: falls back to processing/ files, stamp stripped, stale: true", async () => {
    const d = setupDirs();
    writeTicket(
      d.processing,
      "2026-07-07T1005Z__gh-acme-api-9-plan.md",
      "github:\n  nwo: acme/api\n  issue: 9\n  kind: plan",
    );
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), { fetchFn: downFetch })();
    expect(snap.daemonUp).toBe(false);
    expect(snap.running).toEqual([
      {
        id: "gh-acme-api-9-plan",
        github: { nwo: "acme/api", issue: 9, kind: "plan" },
        turns: null,
        lastTool: null,
        outputTokens: null,
        startedAt: null,
        stale: true,
      },
    ]);
  });

  it("healthEnabled=false never fetches and uses the fallback", async () => {
    const d = setupDirs();
    let fetched = 0;
    const spyFetch: typeof fetch = (async () => {
      fetched++;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const snap = await makeQueueSnapshotFn(
      makeQueueCfg(d.root, { healthEnabled: false } as Partial<Config>),
      { fetchFn: spyFetch },
    )();
    expect(fetched).toBe(0);
    expect(snap.daemonUp).toBe(false);
  });
});

describe("recent", () => {
  it("merges done+failed newest-first by mtime, caps at 5, status from dir", async () => {
    const d = setupDirs();
    for (let i = 1; i <= 4; i++) {
      writeTicket(d.done, `2026-07-07T100${i}Z__done-${i}.md`, `id: done-${i}`);
    }
    for (let i = 1; i <= 3; i++) {
      writeTicket(d.failed, `2026-07-07T100${i}Z__fail-${i}.md`, `id: fail-${i}`);
    }
    // Deterministic mtimes via statFn fake: encode order from the filename digit.
    const statFn = (p: string): { mtimeMs: number } => {
      const m = /(\d)\.md$/.exec(p);
      const base = p.includes("fail-") ? 0.5 : 0; // interleave: done-1, fail-1, done-2, ...
      return { mtimeMs: Number(m![1]) * 1000 + base * 1000 };
    };
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: downFetch,
      statFn,
    })();
    expect(snap.recent).toHaveLength(5);
    expect(snap.recent[0].id).toBe("done-4"); // highest mtime
    expect(snap.recent.map((r) => r.status)).toContain("failed");
    expect(new Date(snap.recent[0].finishedAt).getTime()).toBe(4000);
  });
});

describe("never-throws contract", () => {
  it("an unexpected failure returns error set, empty lists", async () => {
    const d = setupDirs();
    const snap = await makeQueueSnapshotFn(makeQueueCfg(d.root), {
      fetchFn: downFetch,
      nowFn: () => {
        throw new Error("clock boom");
      },
    })();
    expect(snap.error).toBe("clock boom");
    expect(snap.waiting).toEqual([]);
    expect(snap.running).toEqual([]);
  });

  it("missing queue dirs (fresh install) → empty snapshot, no error", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-qsnap-empty-"));
    const snap = await makeQueueSnapshotFn(makeQueueCfg(root), { fetchFn: downFetch })();
    expect(snap).toMatchObject({ waiting: [], running: [], recent: [], error: null });
  });
});
```

Note for the `readFileFn` fake: use a top-level `import { readFileSync } from "node:fs"` instead of `require` — this is an ESM test file. Write it as:

```ts
    const readFileFn = (p: string): string => {
      if (p.endsWith("gone.md")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return readFileSync(p, "utf8");
    };
```

(and add `readFileSync` to the `node:fs` import at the top).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/queueSnapshot.test.ts > /tmp/t2 2>&1; echo "exit: $?"; tail -20 /tmp/t2`
Expected: FAIL — module `../src/tui/queueSnapshot.js` not found.

- [ ] **Step 3: Move `PRIORITY_RANK` to types.ts**

In `src/types.ts`, after the `Ticket` interface (~line 156):

```ts
/** Claim-order priority ranking (higher claims first). Shared by runOnce.ts
 * (scheduling) and tui/queueSnapshot.ts (display) — keep this the ONLY definition. */
export const PRIORITY_RANK: Record<Ticket["priority"], number> = { high: 2, normal: 1, low: 0 };
```

In `src/runOnce.ts`: delete line 22 (`const PRIORITY_RANK: Record<string, number> = ...`) and add `PRIORITY_RANK` to the existing `./types.js` import (it currently imports types only — note `PRIORITY_RANK` is a value, so it must NOT be in a `import type` clause; add a value import: `import { PRIORITY_RANK } from "./types.js";`).

- [ ] **Step 4: Implement `src/tui/queueSnapshot.ts`**

```ts
/**
 * Local queue snapshot for the dashboard: the queue dirs + the daemon's
 * /health progress merged into one render-ready structure. The waiting order
 * MUST mirror claimNextTask (runOnce.ts) — lexicographic filename discovery,
 * skip-unreadable, stable priority sort, not_before gate — so a position shown
 * here is the position the daemon will actually claim in.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config, TicketGithub, Ticket } from "../types.js";
import { PRIORITY_RANK } from "../types.js";
import { queuePaths } from "../config.js";
import { parseTicket } from "../ticket.js";

export interface QueueRunning {
  id: string;
  github: TicketGithub | null;
  turns: number | null;
  lastTool: string | null;
  outputTokens: number | null;
  startedAt: string | null;
  /** true when sourced from processing/ because /health was unreachable. */
  stale: boolean;
}

export interface QueueWaiting {
  id: string;
  github: TicketGithub | null;
  kind: "pr" | "ask" | "plan";
  priority: "low" | "normal" | "high";
  retryCount: number;
  /** ISO stamp when deferred (future not_before), else null. */
  notBefore: string | null;
  deferred: boolean;
}

export interface QueueRecent {
  id: string;
  github: TicketGithub | null;
  status: "done" | "failed";
  finishedAt: string; // file mtime, ISO
}

export interface QueueSnapshot {
  daemonUp: boolean;
  maxConcurrent: number;
  running: QueueRunning[];
  waiting: QueueWaiting[]; // claim order
  recent: QueueRecent[]; // newest-first, cap 5
  error: string | null;
}

export interface QueueSnapshotDeps {
  readdirFn?: (dir: string) => string[];
  readFileFn?: (p: string) => string;
  statFn?: (p: string) => { mtimeMs: number };
  fetchFn?: typeof fetch;
  nowFn?: () => Date;
}

const HEALTH_TIMEOUT_MS = 1500;
const RECENT_CAP = 5;

/** Claimed/finalized basenames carry a `<UTC-stamp>__` prefix (queue.ts
 * utcStamp — YYYY-MM-DDTHHMMZ). Strip exactly that; other `__` are content. */
export function stripStamp(name: string): string {
  return name.replace(/^\d{4}-\d{2}-\d{2}T\d{4}Z__/, "");
}

interface HealthProgress {
  turns?: number;
  lastTool?: string | null;
  outputTokens?: number;
  startedAt?: string;
}

export function makeQueueSnapshotFn(
  cfg: Config,
  deps: QueueSnapshotDeps = {},
): () => Promise<QueueSnapshot> {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string): string => readFileSync(p, "utf8"));
  const statFn = deps.statFn ?? statSync;
  const fetchFn = deps.fetchFn ?? fetch;
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const paths = queuePaths(cfg);

  const listMd = (dir: string): string[] => {
    try {
      return readdirFn(dir)
        .filter((n) => n.endsWith(".md"))
        .map((n) => join(dir, n))
        .sort();
    } catch {
      return []; // missing dir (fresh install) or transient error — render empty
    }
  };

  // Same defensive posture as claimNextTask: the queue can change between
  // discover and read; one vanished/unreadable file must not sink the snapshot.
  const parseAt = (p: string): Ticket | null => {
    try {
      return parseTicket(p, readFileFn(p), cfg.defaultTimeoutMinutes);
    } catch {
      return null;
    }
  };

  const displayId = (t: Ticket): string => stripStamp(t.id);

  return async (): Promise<QueueSnapshot> => {
    const base: QueueSnapshot = {
      daemonUp: false,
      maxConcurrent: cfg.maxConcurrent,
      running: [],
      waiting: [],
      recent: [],
      error: null,
    };
    try {
      const now = nowFn().getTime();

      // -- waiting: mirror claimNextTask ordering exactly ------------------
      const waiting = listMd(paths.inbox)
        .flatMap((p) => {
          const t = parseAt(p);
          return t ? [t] : [];
        })
        .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority])
        .map((t): QueueWaiting => {
          const ts = t.notBefore ? Date.parse(t.notBefore) : NaN;
          const deferred = Number.isFinite(ts) && ts > now; // unparseable = eligible (runOnce parity)
          return {
            id: displayId(t),
            github: t.github,
            kind: t.github?.kind ?? (t.hasRepo ? "pr" : "ask"),
            priority: t.priority,
            retryCount: t.retryCount,
            notBefore: deferred ? t.notBefore : null,
            deferred,
          };
        });

      // -- processing/: id → ticket map (github enrichment + down-fallback) --
      const proc = listMd(paths.processing).flatMap((p) => {
        const t = parseAt(p);
        return t ? [{ path: p, ticket: t }] : [];
      });
      const procById = new Map(proc.map((e) => [displayId(e.ticket), e.ticket]));

      // -- running: /health when up, processing/ fallback when not ----------
      let daemonUp = false;
      let running: QueueRunning[] = [];
      if (cfg.healthEnabled) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
          try {
            const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, {
              signal: ctrl.signal,
            });
            if (resp.ok) {
              const j = (await resp.json()) as {
                metrics?: {
                  currentTickets?: string[];
                  currentProgress?: Record<string, HealthProgress>;
                };
              };
              daemonUp = true;
              const prog = j.metrics?.currentProgress ?? {};
              running = (j.metrics?.currentTickets ?? []).map((id): QueueRunning => {
                const p = prog[id];
                return {
                  id,
                  github: procById.get(id)?.github ?? null,
                  turns: p?.turns ?? null,
                  lastTool: p?.lastTool ?? null,
                  outputTokens: p?.outputTokens ?? null,
                  startedAt: p?.startedAt ?? null,
                  stale: false,
                };
              });
            }
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // unreachable/timeout — fall through to the processing/ fallback
        }
      }
      if (!daemonUp) {
        running = proc.map(
          (e): QueueRunning => ({
            id: displayId(e.ticket),
            github: e.ticket.github,
            turns: null,
            lastTool: null,
            outputTokens: null,
            startedAt: null,
            stale: true,
          }),
        );
      }

      // -- recent: done/ + failed/ by mtime, newest first, cap --------------
      const recent = [
        ...listMd(paths.done).map((p) => ({ p, status: "done" as const })),
        ...listMd(paths.failed).map((p) => ({ p, status: "failed" as const })),
      ]
        .flatMap((e) => {
          try {
            return [{ ...e, mtimeMs: statFn(e.p).mtimeMs }];
          } catch {
            return []; // vanished between readdir and stat
          }
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, RECENT_CAP)
        .map((e): QueueRecent => {
          const t = parseAt(e.p);
          return {
            id: t ? displayId(t) : stripStamp(basename(e.p).replace(/\.md$/, "")),
            github: t?.github ?? null,
            status: e.status,
            finishedAt: new Date(e.mtimeMs).toISOString(),
          };
        });

      return { ...base, daemonUp, running, waiting, recent };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/queueSnapshot.test.ts tests/runOnce.test.ts > /tmp/t2 2>&1; echo "exit: $?"; tail -5 /tmp/t2`
Expected: PASS (runOnce suite proves the `PRIORITY_RANK` move didn't change scheduling).

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/types.ts src/runOnce.ts src/tui/queueSnapshot.ts tests/queueSnapshot.test.ts
git add src/types.ts src/runOnce.ts src/tui/queueSnapshot.ts tests/queueSnapshot.test.ts
git commit -m "feat(tui): queue snapshot — claim-order mirror of the local queue + /health progress"
```

---

### Task 3: `queueFmt` helpers + `QueueStrip` component

**Files:**
- Create: `src/tui/queueFmt.ts`
- Create: `src/tui/components/QueueStrip.tsx`
- Test: `tests/tuiQueue.test.tsx`

**Interfaces:**
- Consumes: Task 2's `QueueSnapshot`/`QueueRunning`/`QueueWaiting` types; `TicketGithub` from `src/types.ts`.
- Produces (Task 4 + 5 rely on):
  - `queueLabel(github: TicketGithub | null, id: string): string` — `#46 exec` / `#9 plan` / `#3 ask` for bridged tickets (`pr` renders as `exec`), else the id truncated to 24 chars with `…`.
  - `fmtElapsed(startedAt: string | null, now: Date): string | null` — `45s`, `4m32s`, `1h12m`; null for null/garbage/future stamps.
  - `fmtAge(iso: string, now: Date): string` — `12s ago`, `12m ago`, `3h ago`, `2d ago`.
  - `fmtTokens(n: number | null): string | null` — `740 tok`, `12.3k tok`.
  - `fmtClock(iso: string): string` — local `HH:MM`.
  - `QueueStrip({ snap, now }: { snap: QueueSnapshot | null; now: Date })` — the always-on strip.

- [ ] **Step 1: Write the failing tests**

Create `tests/tuiQueue.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { QueueStrip } from "../src/tui/components/QueueStrip.js";
import { queueLabel, fmtElapsed, fmtAge, fmtTokens, fmtClock } from "../src/tui/queueFmt.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const NOW = new Date("2026-07-07T10:05:00Z");

const IDLE: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  running: [],
  waiting: [],
  recent: [],
  error: null,
};

const BUSY: QueueSnapshot = {
  ...IDLE,
  running: [
    {
      id: "gh-acme-api-46",
      github: { nwo: "acme/api", issue: 46, kind: "pr" },
      turns: 14,
      lastTool: "bash",
      outputTokens: 12345,
      startedAt: "2026-07-07T10:00:28Z",
      stale: false,
    },
  ],
  waiting: [
    {
      id: "gh-acme-api-51-plan",
      github: { nwo: "acme/api", issue: 51, kind: "plan" },
      kind: "plan",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
    {
      id: "manual-tide-fix",
      github: null,
      kind: "pr",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
    {
      id: "gh-acme-api-52-plan",
      github: { nwo: "acme/api", issue: 52, kind: "plan" },
      kind: "plan",
      priority: "normal",
      retryCount: 1,
      notBefore: "2026-07-07T11:00:00Z",
      deferred: true,
    },
    {
      id: "gh-acme-api-53-plan",
      github: { nwo: "acme/api", issue: 53, kind: "plan" },
      kind: "plan",
      priority: "low",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
  ],
};

describe("queueFmt", () => {
  it("queueLabel: bridged → #N word (pr→exec); manual → truncated id", () => {
    expect(queueLabel({ nwo: "a/b", issue: 46, kind: "pr" }, "x")).toBe("#46 exec");
    expect(queueLabel({ nwo: "a/b", issue: 9, kind: "plan" }, "x")).toBe("#9 plan");
    expect(queueLabel({ nwo: "a/b", issue: 3, kind: "ask" }, "x")).toBe("#3 ask");
    expect(queueLabel(null, "manual-tide-fix")).toBe("manual-tide-fix");
    expect(queueLabel(null, "a".repeat(30))).toBe("a".repeat(23) + "…");
  });

  it("fmtElapsed buckets and guards", () => {
    expect(fmtElapsed("2026-07-07T10:04:15Z", NOW)).toBe("45s");
    expect(fmtElapsed("2026-07-07T10:00:28Z", NOW)).toBe("4m32s");
    expect(fmtElapsed("2026-07-07T08:53:00Z", NOW)).toBe("1h12m");
    expect(fmtElapsed(null, NOW)).toBeNull();
    expect(fmtElapsed("garbage", NOW)).toBeNull();
    expect(fmtElapsed("2026-07-07T11:00:00Z", NOW)).toBeNull(); // future
  });

  it("fmtAge / fmtTokens / fmtClock", () => {
    expect(fmtAge("2026-07-07T09:53:00Z", NOW)).toBe("12m ago");
    expect(fmtAge("2026-07-05T10:05:00Z", NOW)).toBe("2d ago");
    expect(fmtTokens(740)).toBe("740 tok");
    expect(fmtTokens(12345)).toBe("12.3k tok");
    expect(fmtTokens(null)).toBeNull();
    expect(fmtClock("2026-07-07T11:00:00Z")).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("QueueStrip", () => {
  it("renders loading, idle, and error variants", () => {
    expect(render(<QueueStrip snap={null} now={NOW} />).lastFrame()).toContain(
      "queue — loading…",
    );
    expect(render(<QueueStrip snap={IDLE} now={NOW} />).lastFrame()).toContain("queue — idle");
    expect(
      render(<QueueStrip snap={{ ...IDLE, error: "clock boom" }} now={NOW} />).lastFrame(),
    ).toContain("queue unavailable: clock boom");
  });

  it("renders counts, running progress, and the next-up line", () => {
    const frame = render(<QueueStrip snap={BUSY} now={NOW} />).lastFrame()!;
    expect(frame).toContain("queue — 1 running · 4 waiting");
    expect(frame).toContain("#46 exec");
    expect(frame).toContain("turn 14");
    expect(frame).toContain("bash");
    expect(frame).toContain("12.3k tok");
    expect(frame).toContain("4m32s");
    expect(frame).toContain("next:");
    expect(frame).toContain("1) #51 plan");
    expect(frame).toContain("2) manual-tide-fix");
    expect(frame).toContain("⏲3) #52 plan"); // deferred marker
    expect(frame).toContain("+1 more");
    expect(frame).toContain("[t]");
  });

  it("shows max only when maxConcurrent > 1", () => {
    expect(render(<QueueStrip snap={BUSY} now={NOW} />).lastFrame()).not.toContain("max");
    expect(
      render(<QueueStrip snap={{ ...BUSY, maxConcurrent: 3 }} now={NOW} />).lastFrame(),
    ).toContain("· max 3");
  });

  it("daemon down: warning + stale running line", () => {
    const down: QueueSnapshot = {
      ...BUSY,
      daemonUp: false,
      running: [{ ...BUSY.running[0], turns: null, startedAt: null, stale: true }],
    };
    const frame = render(<QueueStrip snap={down} now={NOW} />).lastFrame()!;
    expect(frame).toContain("daemon ○ down — nothing will run");
    expect(frame).toContain("processing (daemon down)");
  });

  it("caps running lines at 2 with +N more", () => {
    const many: QueueSnapshot = {
      ...IDLE,
      maxConcurrent: 4,
      running: [1, 2, 3].map((n) => ({
        id: `t-${n}`,
        github: null,
        turns: n,
        lastTool: "bash",
        outputTokens: 100,
        startedAt: null,
        stale: false,
      })),
    };
    const frame = render(<QueueStrip snap={many} now={NOW} />).lastFrame()!;
    expect(frame).toContain("t-1");
    expect(frame).toContain("t-2");
    expect(frame).not.toContain("turn 3");
    expect(frame).toContain("+1 more running");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiQueue.test.tsx > /tmp/t3 2>&1; echo "exit: $?"; tail -10 /tmp/t3`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/tui/queueFmt.ts`**

```ts
/** Pure presentation helpers shared by QueueStrip and QueueView. */

import type { TicketGithub } from "../types.js";

const ID_MAX = 24;

/** `#46 exec` for bridged tickets (kind `pr` reads as `exec`), else the id. */
export function queueLabel(github: TicketGithub | null, id: string): string {
  if (github) return `#${github.issue} ${github.kind === "pr" ? "exec" : github.kind}`;
  return id.length > ID_MAX ? id.slice(0, ID_MAX - 1) + "…" : id;
}

export function fmtElapsed(startedAt: string | null, now: Date): string | null {
  if (!startedAt) return null;
  const ms = now.getTime() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export function fmtAge(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTokens(n: number | null): string | null {
  if (n === null) return null;
  return n < 1000 ? `${n} tok` : `${(n / 1000).toFixed(1)}k tok`;
}

/** Local wall-clock HH:MM (not_before display). */
export function fmtClock(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

/** `turn 14 · bash · 12.3k tok · 4m32s` — null segments omitted. */
export function progressLine(
  r: { turns: number | null; lastTool: string | null; outputTokens: number | null; startedAt: string | null; stale: boolean },
  now: Date,
): string {
  if (r.stale) return "processing (daemon down)";
  const parts = [
    r.turns !== null ? `turn ${r.turns}` : null,
    r.lastTool,
    fmtTokens(r.outputTokens),
    fmtElapsed(r.startedAt, now),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : "starting…";
}
```

- [ ] **Step 4: Implement `src/tui/components/QueueStrip.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { QueueSnapshot } from "../queueSnapshot.js";
import { queueLabel, progressLine } from "../queueFmt.js";

const RUNNING_LINES = 2;
const NEXT_SHOWN = 3;

/** Always-on compact queue strip: header counts, running ticket(s) with live
 * progress, next-up in claim order. `t` (handled by App) expands to the view. */
export function QueueStrip({
  snap,
  now,
}: {
  snap: QueueSnapshot | null;
  now: Date;
}): React.JSX.Element {
  if (snap === null) {
    return (
      <Box borderStyle="round" paddingX={1}>
        <Text dimColor>queue — loading…</Text>
      </Box>
    );
  }
  if (snap.error !== null) {
    return (
      <Box borderStyle="round" paddingX={1}>
        <Text dimColor wrap="truncate-end">
          queue unavailable: {snap.error}
        </Text>
      </Box>
    );
  }
  if (snap.running.length === 0 && snap.waiting.length === 0 && snap.daemonUp) {
    return (
      <Box borderStyle="round" paddingX={1}>
        <Text dimColor>queue — idle</Text>
      </Box>
    );
  }

  const header =
    `queue — ${snap.running.length} running · ${snap.waiting.length} waiting` +
    (snap.maxConcurrent > 1 ? ` · max ${snap.maxConcurrent}` : "");
  const next = snap.waiting.slice(0, NEXT_SHOWN);
  const moreNext = snap.waiting.length - next.length;
  const shown = snap.running.slice(0, RUNNING_LINES);
  const moreRunning = snap.running.length - shown.length;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box gap={2}>
        <Text bold>{header}</Text>
        {!snap.daemonUp && <Text color="yellow">daemon ○ down — nothing will run</Text>}
      </Box>
      {shown.map((r) => (
        <Text key={r.id} wrap="truncate-end">
          <Text color="cyan">◐ </Text>
          <Text bold>{queueLabel(r.github, r.id)}</Text>
          <Text dimColor>  {progressLine(r, now)}</Text>
        </Text>
      ))}
      {moreRunning > 0 && <Text dimColor>+{moreRunning} more running</Text>}
      {next.length > 0 && (
        <Text wrap="truncate-end">
          <Text dimColor>next: </Text>
          {next.map((w, i) => (
            <Text key={w.id}>
              {i > 0 ? "  " : ""}
              {w.deferred ? "⏲" : ""}
              {i + 1}) {queueLabel(w.github, w.id)}
            </Text>
          ))}
          {moreNext > 0 ? <Text dimColor>  +{moreNext} more</Text> : null}
          <Text dimColor>  [t]</Text>
        </Text>
      )}
    </Box>
  );
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/tuiQueue.test.tsx > /tmp/t3 2>&1; echo "exit: $?"; tail -5 /tmp/t3`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui/queueFmt.ts src/tui/components/QueueStrip.tsx tests/tuiQueue.test.tsx
git add src/tui/queueFmt.ts src/tui/components/QueueStrip.tsx tests/tuiQueue.test.tsx
git commit -m "feat(tui): queue strip — always-on running/waiting indicators"
```

---

### Task 4: `QueueView` component (full queue on `t`)

**Files:**
- Create: `src/tui/components/QueueView.tsx`
- Test: `tests/tuiQueue.test.tsx` (append)

**Interfaces:**
- Consumes: Task 2's `QueueSnapshot`, Task 3's `queueLabel`/`progressLine`/`fmtAge`/`fmtClock`.
- Produces: `QueueView({ snap, scroll, now }: { snap: QueueSnapshot | null; scroll: number; now: Date })` — Task 5 renders it in the main-area slot and drives `scroll`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tuiQueue.test.tsx` (reuses `BUSY`, `IDLE`, `NOW` from Task 3):

```tsx
import { QueueView } from "../src/tui/components/QueueView.js";

describe("QueueView", () => {
  const FULL: QueueSnapshot = {
    ...BUSY,
    recent: [
      {
        id: "gh-acme-api-44",
        github: { nwo: "acme/api", issue: 44, kind: "pr" },
        status: "done",
        finishedAt: "2026-07-07T09:53:00Z",
      },
      {
        id: "gh-acme-api-40",
        github: { nwo: "acme/api", issue: 40, kind: "pr" },
        status: "failed",
        finishedAt: "2026-07-07T09:05:00Z",
      },
    ],
  };

  it("renders all three sections with detail", () => {
    const frame = render(<QueueView snap={FULL} scroll={0} now={NOW} />).lastFrame()!;
    expect(frame).toContain("RUNNING (1/1)");
    expect(frame).toContain("#46 exec");
    expect(frame).toContain("gh-acme-api-46"); // dim id next to the label
    expect(frame).toContain("turn 14 · bash · 12.3k tok · 4m32s");
    expect(frame).toContain("WAITING (4)");
    expect(frame).toContain("1. #51 plan");
    expect(frame).toContain("2. manual-tide-fix");
    expect(frame).toContain("retry 1");
    expect(frame).toContain("not before");
    expect(frame).toContain("⏲ deferred");
    expect(frame).toContain("low"); // non-normal priority shown
    expect(frame).toContain("RECENT");
    expect(frame).toContain("✓ #44 exec");
    expect(frame).toContain("12m ago");
    expect(frame).toContain("✗ #40 exec");
  });

  it("renders dim placeholders for empty sections", () => {
    const frame = render(<QueueView snap={IDLE} scroll={0} now={NOW} />).lastFrame()!;
    expect(frame).toContain("RUNNING (0/1)");
    expect(frame).toContain("WAITING (0)");
    // Empty sections show an em-dash placeholder.
    expect(frame.split("—").length).toBeGreaterThanOrEqual(3);
  });

  it("scroll slices rendered rows", () => {
    const top = render(<QueueView snap={FULL} scroll={0} now={NOW} />).lastFrame()!;
    const scrolled = render(<QueueView snap={FULL} scroll={6} now={NOW} />).lastFrame()!;
    expect(top).toContain("RUNNING");
    expect(scrolled).not.toContain("RUNNING (1/1)");
  });

  it("loading state", () => {
    expect(render(<QueueView snap={null} scroll={0} now={NOW} />).lastFrame()).toContain(
      "loading…",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiQueue.test.tsx > /tmp/t4 2>&1; echo "exit: $?"; tail -10 /tmp/t4`
Expected: FAIL — `QueueView.js` not found.

- [ ] **Step 3: Implement `src/tui/components/QueueView.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { QueueSnapshot, QueueWaiting } from "../queueSnapshot.js";
import { queueLabel, progressLine, fmtAge, fmtClock } from "../queueFmt.js";

const PAGE = 100; // rows rendered from `scroll`; terminal height clips the rest

function waitingNote(w: QueueWaiting): string {
  const parts: string[] = [];
  if (w.priority !== "normal") parts.push(w.priority);
  if (w.retryCount > 0) parts.push(`retry ${w.retryCount}`);
  if (w.notBefore !== null) parts.push(`not before ${fmtClock(w.notBefore)}`);
  if (w.deferred) parts.push("⏲ deferred");
  return parts.join(" · ");
}

/** Full queue view (main-area slot, opened with `t`): RUNNING / WAITING /
 * RECENT built as flat rows so App's scroll offset can slice them. */
export function QueueView({
  snap,
  scroll,
  now,
}: {
  snap: QueueSnapshot | null;
  scroll: number;
  now: Date;
}): React.JSX.Element {
  if (snap === null) {
    return (
      <Box borderStyle="round" paddingX={1} flexGrow={1}>
        <Text dimColor>queue — loading…</Text>
      </Box>
    );
  }

  const rows: React.JSX.Element[] = [];
  const dash = (key: string): void => {
    rows.push(
      <Text key={key} dimColor>
        {"  "}—
      </Text>,
    );
  };

  rows.push(
    <Text key="run-h" bold>
      RUNNING ({snap.running.length}/{snap.maxConcurrent})
    </Text>,
  );
  if (snap.running.length === 0) dash("run-none");
  for (const r of snap.running) {
    rows.push(
      <Text key={`r-${r.id}`} wrap="truncate-end">
        {"  "}
        <Text color="cyan">◐ </Text>
        <Text bold>{queueLabel(r.github, r.id)}</Text>
        <Text dimColor>  {r.id}</Text>
      </Text>,
    );
    rows.push(
      <Text key={`rp-${r.id}`} dimColor wrap="truncate-end">
        {"     "}
        {progressLine(r, now)}
      </Text>,
    );
  }

  rows.push(
    <Text key="wait-h" bold>
      {" "}
    </Text>,
  );
  rows.push(
    <Text key="wait-h2" bold>
      WAITING ({snap.waiting.length})
    </Text>,
  );
  if (snap.waiting.length === 0) dash("wait-none");
  snap.waiting.forEach((w, i) => {
    const note = waitingNote(w);
    rows.push(
      <Text key={`w-${w.id}`} wrap="truncate-end">
        {"  "}
        {i + 1}. <Text bold>{queueLabel(w.github, w.id)}</Text>
        <Text dimColor>  {w.github ? w.id : w.kind}</Text>
        {note !== "" ? <Text color="yellow">  {note}</Text> : null}
      </Text>,
    );
  });

  rows.push(
    <Text key="rec-h" bold>
      {" "}
    </Text>,
  );
  rows.push(
    <Text key="rec-h2" bold>
      RECENT
    </Text>,
  );
  if (snap.recent.length === 0) dash("rec-none");
  for (const r of snap.recent) {
    rows.push(
      <Text key={`f-${r.id}-${r.finishedAt}`} wrap="truncate-end">
        {"  "}
        <Text color={r.status === "done" ? "green" : "red"}>
          {r.status === "done" ? "✓" : "✗"}{" "}
        </Text>
        {queueLabel(r.github, r.id)}
        <Text dimColor>  {fmtAge(r.finishedAt, now)}</Text>
      </Text>,
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      {rows.slice(scroll, scroll + PAGE)}
    </Box>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/tuiQueue.test.tsx > /tmp/t4 2>&1; echo "exit: $?"; tail -5 /tmp/t4`
Expected: PASS. (If the `✓ #44 exec` assertion fails on spacing, match the component's actual glyph+space rendering — the assertion and component must agree, with the glyph colored and a space before the label.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/QueueView.tsx tests/tuiQueue.test.tsx
git add src/tui/components/QueueView.tsx tests/tuiQueue.test.tsx
git commit -m "feat(tui): full queue view — running/waiting/recent on t"
```

---

### Task 5: Wire into App, ShortcutBar, HelpOverlay, dashboardCmd

**Files:**
- Modify: `src/tui/App.tsx` (props ~line 31; View union ~line 48; state ~line 133; polls ~line 225; useInput ~line 432; render ~line 547)
- Modify: `src/tui/components/ShortcutBar.tsx`
- Modify: `src/tui/components/HelpOverlay.tsx`
- Modify: `src/dashboardCmd.ts` (~line 43)
- Test: `tests/tuiApp.test.tsx` (renderApp helper + new tests), `tests/dashboardCmd.test.ts` (no change expected — verify)

**Interfaces:**
- Consumes: Tasks 2–4 (`QueueSnapshot`, `makeQueueSnapshotFn`, `QueueStrip`, `QueueView`).
- Produces: `AppProps` gains **required** `queueFn: () => Promise<QueueSnapshot>` and optional `queuePollMs?: number` (default `2_000`); `BarView`/`View` unions gain `"queue"`.

- [ ] **Step 1: Write the failing tests**

In `tests/tuiApp.test.tsx`:

1. Add imports and a canned snapshot near the other fixtures:

```tsx
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const QUEUE_SNAP: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  running: [
    {
      id: "gh-acme-api-46",
      github: { nwo: "acme/api", issue: 46, kind: "pr" },
      turns: 3,
      lastTool: "bash",
      outputTokens: 500,
      startedAt: "2026-07-07T10:00:00Z",
      stale: false,
    },
  ],
  waiting: [
    {
      id: "gh-acme-api-51-plan",
      github: { nwo: "acme/api", issue: 51, kind: "plan" },
      kind: "plan",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
  ],
  recent: [],
  error: null,
};
```

2. Extend the `renderApp` helper with a `queueFn` parameter (defaulted so existing call sites stay untouched):

```tsx
function renderApp(
  client: DashboardClient,
  watchlistFile: string,
  issuePollMs = 999999,
  runCliFn?: (name: string, extraArgs: string[]) => Promise<CliRunResult>,
  queueFn: () => Promise<QueueSnapshot> = async () => QUEUE_SNAP,
) {
  return render(
    <App
      client={client}
      trigger="junco"
      configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
      watchlistFile={watchlistFile}
      configPath="/x/config.toml"
      clonesDir={CLONES_DIR}
      issuePollMs={issuePollMs}
      healthPollMs={999999}
      queuePollMs={999999}
      queueFn={queueFn}
      runCliFn={runCliFn}
      onExit={() => {}}
    />,
  );
}
```

3. New describe-block (bounded until-loop helper — copy the file's existing retry pattern if one exists, otherwise use this):

```tsx
async function until(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(cond()).toBe(true); // final assert with a real failure message
}

describe("queue strip + queue view", () => {
  it("renders the strip from the initial queue poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("queue — 1 running · 1 waiting"));
    expect(r.lastFrame()).toContain("#46 exec");
  });

  it("t opens the queue view, esc returns; t toggles too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q2-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("queue —"));
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    expect(r.lastFrame()).toContain("WAITING (1)");
    r.stdin.write(String.fromCharCode(27)); // esc — reuse the file's ESC const if in scope
    await until(() => !(r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    r.stdin.write("t"); // t closes as well
    await until(() => !(r.lastFrame() ?? "").includes("RUNNING (1/1)"));
  });

  it("queue view scrolls with ] and [", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q3-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("queue —"));
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    r.stdin.write("]");
    await until(() => !(r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    r.stdin.write("[");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
  });

  it("shortcut bar advertises t in main view", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q4-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("t queue"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiApp.test.tsx > /tmp/t5 2>&1; echo "exit: $?"; tail -10 /tmp/t5`
Expected: FAIL — TS/prop errors (`queueFn` unknown) and missing strip content.

- [ ] **Step 3: Implement**

`src/tui/components/ShortcutBar.tsx`:
- `BarView` union gains `"queue"`.
- Add a case before `"main"`:

```ts
    case "queue":
      return [
        ["[ / ]", "scroll"],
        ["esc/t", "back"],
      ];
```

- In BOTH main-view arrays, insert `["t", "queue"]` immediately before `[":", "commands"]`.

`src/tui/components/HelpOverlay.tsx`: add `["t", "queue — running / waiting / recent tickets"],` after the `["r", "refresh now"]` row.

`src/tui/App.tsx`:

1. Imports:

```tsx
import { QueueStrip } from "./components/QueueStrip.js";
import { QueueView } from "./components/QueueView.js";
import type { QueueSnapshot } from "./queueSnapshot.js";
```

2. `AppProps` — after `healthPollMs`:

```tsx
  /** Local queue snapshot source (dashboardCmd wires makeQueueSnapshotFn). */
  queueFn: () => Promise<QueueSnapshot>;
  queuePollMs?: number; // default 2_000
```

3. `type View` gains `"queue"`; destructure `queueFn` from props and `const queuePollMs = props.queuePollMs ?? 2_000;` next to the other poll defaults.

4. State (next to `health`):

```tsx
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot | null>(null);
  const [queueNow, setQueueNow] = useState<Date>(() => new Date());
```

5. Poll effect — copy the shape of the existing health-poll effect (immediate first run + interval; `queueFn` is stable from props):

```tsx
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const s = await queueFn();
      if (!alive) return;
      setQueueSnap(s);
      setQueueNow(new Date());
    };
    void run();
    const id = setInterval(() => void run(), queuePollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [queueFn, queuePollMs]);
```

6. `useInput` — add a queue-view branch alongside the detail branch (BEFORE the main-view section):

```tsx
    if (view === "queue") {
      if (key.escape || input === "t") return void setView("main");
      if (input === "]" || key.downArrow) return void setScroll((s) => s + 1);
      if (input === "[" || key.upArrow) return void setScroll((s) => Math.max(0, s - 1));
      return;
    }
```

And in the main-view section (next to the `":"` handler):

```tsx
    if (input === "t") {
      setScroll(0);
      setView("queue");
      return;
    }
```

7. Render — the main-area ternary chain gains a queue slot (between the `cmdOutput` case and the `IssueTable` fallback):

```tsx
        ) : view === "queue" ? (
          <QueueView snap={queueSnap} scroll={scroll} now={queueNow} />
        ) : (
```

And insert the strip between the top `<Box>` and `<StatusBar …>`:

```tsx
      <QueueStrip snap={queueSnap} now={queueNow} />
```

`src/dashboardCmd.ts` — add the module to the parallel dynamic imports and wire the prop:

```ts
  const [{ App }, { makeGhDashboardClient }, { watchlistPath }, { makeQueueSnapshotFn }, react, ink] =
    await Promise.all([
      import("./tui/App.js"),
      import("./tui/ghClient.js"),
      import("./watchlist.js"),
      import("./tui/queueSnapshot.js"),
      import("react"),
      import("ink"),
    ]);
```

and in the `createElement(App, { … })` props: `queueFn: makeQueueSnapshotFn(cfg),`.

- [ ] **Step 4: Run the TUI + dashboard suites**

Run: `npx vitest run tests/tuiApp.test.tsx tests/tuiQueue.test.tsx tests/tuiComponents.test.tsx tests/tuiInteractive.test.tsx tests/tuiPalette.test.tsx tests/dashboardCmd.test.ts > /tmp/t5 2>&1; echo "exit: $?"; tail -5 /tmp/t5`
Expected: PASS. (Only `tuiApp.test.tsx` renders `<App>`; if any other file does, give it the same `queueFn` default.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/App.tsx src/tui/components/ShortcutBar.tsx src/tui/components/HelpOverlay.tsx src/dashboardCmd.ts tests/tuiApp.test.tsx
git add src/tui/App.tsx src/tui/components/ShortcutBar.tsx src/tui/components/HelpOverlay.tsx src/dashboardCmd.ts tests/tuiApp.test.tsx
git commit -m "feat(dashboard): queue strip + t queue view wired into the app"
```

---

### Task 6: Docs + full gate

**Files:**
- Modify: `README.md` (dashboard key table ~line 542; palette paragraph ~line 550 unchanged; add a short queue paragraph after the watchlist paragraph ~line 552)
- Modify: `ARCHITECTURE.md` (`tui/` row ~line 202)

**Interfaces:** none — documentation of Tasks 1–5 as shipped.

- [ ] **Step 1: README**

Add to the key table (keep the table's existing style, rows are alphabetical-ish by key group — place `t` near `r`):

```markdown
| `t`              | queue view — running / waiting / recent tickets (the strip above the status bar shows the same at a glance)                                                                                                                                                                  |
```

After the watchlist paragraph (~line 552), add:

```markdown
The **queue strip** above the status bar shows the daemon's local queue at all times: what's running (with live turn/token progress from the daemon's health endpoint), what's waiting in claim order, and how deep the queue is. Press `t` for the full view — waiting positions match the order the daemon will actually claim (priority first, then filename), deferred tickets show their retry backoff (`not before HH:MM`), and RECENT lists the last few finished tickets. The strip covers the *whole* local queue, including tickets submitted with `junco submit` — not just GitHub-dispatched ones. When the daemon is down the strip says so rather than implying queued work will run.
```

- [ ] **Step 2: ARCHITECTURE.md**

Update the `tui/` row description to: `Ink dashboard: pure state derivation, gh client seam, queue snapshot (claim-order mirror + /health progress), components, App.`

- [ ] **Step 3: Full gate**

Run: `npm run lint && npm run format:check && npm run build && npx vitest run > /tmp/gate 2>&1; echo "exit: $?"; tail -5 /tmp/gate`
Expected: exit 0, all suites green.

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: dashboard queue strip + t view"
```
