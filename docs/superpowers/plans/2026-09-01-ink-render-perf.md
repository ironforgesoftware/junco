# Ink Render Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard produce zero Ink frames when polled data is unchanged, keep animation cheap on the wire, and pin both with a frame-level regression test.

**Architecture:** A test harness mounts the real `App` under Ink's own `render()` and counts committed frames via Ink's `onRender` metric. Every poll sink then keeps its previous state when the fresh value is structurally equal (`node:util` `isDeepStrictEqual`), so React bails out and no frame is committed; the per-poll `queueNow` clock becomes a standalone 5 s `useClock`. Finally `Spinner` moves to Ink 7.1's shared-timer `useAnimation`, and `incrementalRendering: true` makes animation frames rewrite only changed lines.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), React 19.2, Ink 7.1.0, vitest 4, ink-testing-library 4 (for hook probes), Ink's real `render()` (for frame counting).

**Spec:** `docs/superpowers/specs/2026-09-01-ink-render-perf-design.md`

## Global Constraints

- Node ≥ 22.19; no new dependencies (equality uses `node:util`'s `isDeepStrictEqual`).
- `src/tui/**` runs `react-hooks/rules-of-hooks` and `exhaustive-deps` at **error**; every new hook must have a complete dep array — never `eslint-disable`.
- Never assert one fixed `setTimeout` tick after a state change; loop-until-condition with `tests/helpers/until.ts` (bounded retry).
- Suite green at every commit; run `npx prettier --write` on every touched file before committing; conventional commits; **no AI attribution trailers** (CLAUDE.md).
- Exit-code trap: capture vitest's exit explicitly — `npx vitest run <file> > /tmp/out 2>&1; echo "exit: $?"` — never pipe into `grep`/`tail`.
- The age clock is a fixed 5 s tick (`clockMs` default `5_000`); test fixtures freeze it with `999_999`.
- Health `uptimeSeconds` and `LocalCheap.daemon.uptimeSeconds` are compared at whole-minute granularity (what `fmtUp` / `fmtDur` render); the stored values keep raw seconds.

---

## File map

| File | Responsibility |
| --- | --- |
| `tests/helpers/inkFrames.tsx` (new) | Mount `App` under Ink's real `render()` on fake TTY streams; expose per-frame `renderTime`, bytes written, `reset`, `unmount`. |
| `tests/framePerf.test.tsx` (new) | Acceptance + regression test: constant-data poll ticks → 0 frames; a real change → ≥ 1 frame; the clock → frames on its own tick. Writes numbers to `JUNCO_PERF_OUT`. |
| `src/tui/hooks/keepIfEqual.ts` (new) | `keepIfEqual`, `keepIfEqualBy`, `wholeMinutes` — the equality gate every poll sink uses. |
| `tests/keepIfEqual.test.ts` (new) | Unit tests for the three helpers. |
| `src/tui/hooks/useQueueSnapshot.ts` | Gate `queueSnap`; drop `queueNow`. |
| `src/tui/hooks/useHealth.ts` | Gate `health` with uptime quantized to minutes. |
| `src/tui/hooks/useAssessHistory.ts` | Rebuild the `Map` only when the fetched rows change. |
| `src/tui/hooks/useClock.ts` (new) | `useClock(intervalMs): Date` — the standalone age clock. |
| `tests/useClock.test.tsx` (new) | Tick + cleanup. |
| `src/tui/App.tsx` | `clockMs` prop, `useClock`, gated local-cheap/heavy sinks, `now={now}` at 13 sites. |
| `src/tui/hooks/useGithubData.ts` | Gate issues / PRs / stale maps on the refresh path. |
| `tests/helpers/localFixtures.tsx`, `tests/tuiApp.test.tsx`, `tests/useQueueSnapshot.test.tsx`, `tests/useHealth.test.tsx`, `tests/useAssessHistory.test.tsx` (new) | Fixture + probe updates. |
| `src/tui/components/Spinner.tsx`, `tests/tuiComponents.test.tsx` | `useAnimation` spinner + shared-tick test. |
| `src/dashboardCmd.ts`, `tests/dashboardCmd.test.ts`, `tests/useSuspendTty.test.tsx` | `incrementalRendering: true` + suspend/resume full-repaint test. |

---

### Task 1: Frame harness + baseline frame test (Tier 0)

**Files:**
- Create: `tests/helpers/inkFrames.tsx`
- Create: `tests/framePerf.test.tsx`

**Interfaces:**
- Consumes: `App`, `AppProps` (`src/tui/App.tsx`), `MouseProvider` (`src/tui/MouseProvider.tsx`), `makeAppProps`, `EMPTY_QUEUE`, `CHEAP`, `HEAVY` (`tests/helpers/localFixtures.tsx`), `until` (`tests/helpers/until.ts`).
- Produces: `mountForFrames(over?: Partial<AppProps>, opts?: FrameMountOpts): FrameMount` where `FrameMount = { frames: number[]; bytes(): number; reset(): void; unmount(): void }` and `FrameMountOpts = { columns?: number; rows?: number; incrementalRendering?: boolean }`. Later tasks (4, 5) extend `tests/framePerf.test.tsx`.

- [ ] **Step 1: Write the harness**

```tsx
// tests/helpers/inkFrames.tsx — mount the real App under Ink's own render()
// so committed FRAMES are observable. ink-testing-library cannot see a frame
// whose output is identical to the previous one (Ink skips the write), but
// Ink still paid the layout + compositor cost — `onRender` reports every one.
import React from "react";
import { render as inkRender } from "ink";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { App, type AppProps } from "../../src/tui/App.js";
import { MouseProvider } from "../../src/tui/MouseProvider.js";
import { makeAppProps } from "./localFixtures.js";

export interface FrameMount {
  /** Ink's own `renderTime` (ms) for every frame committed since `reset()`. */
  frames: number[];
  /** Bytes written to the fake stdout since `reset()`. */
  bytes: () => number;
  reset: () => void;
  unmount: () => void;
}

export interface FrameMountOpts {
  columns?: number; // default 120 (wide layout, like localFixtures)
  rows?: number; // default 30
  incrementalRendering?: boolean; // default false (Ink's default)
}

interface CountingStdout extends NodeJS.WriteStream {
  bytesWritten: () => number;
  resetBytes: () => void;
}

function fakeStdout(columns: number, rows: number): CountingStdout {
  let bytes = 0;
  const s = new Writable({
    write(chunk, _enc, cb) {
      bytes += chunk.length;
      cb();
    },
  }) as unknown as CountingStdout;
  Object.assign(s, {
    columns,
    rows,
    isTTY: true,
    bytesWritten: () => bytes,
    resetBytes: () => {
      bytes = 0;
    },
  });
  return s;
}

function fakeStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(s, {
    isTTY: true,
    setRawMode: () => s,
    setEncoding: () => s,
    read: () => null,
    ref: () => s,
    unref: () => s,
    pause: () => s,
    resume: () => s,
  });
  return s;
}

export function mountForFrames(
  over: Partial<AppProps> = {},
  opts: FrameMountOpts = {},
): FrameMount {
  const columns = opts.columns ?? 120;
  const rows = opts.rows ?? 30;
  const stdout = fakeStdout(columns, rows);
  const frames: number[] = [];
  const inst = inkRender(
    <MouseProvider>
      <App {...makeAppProps({ sizeOverride: { columns, rows }, ...over })} />
    </MouseProvider>,
    {
      stdout,
      stdin: fakeStdin(),
      stderr: fakeStdout(columns, rows),
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
      incrementalRendering: opts.incrementalRendering ?? false,
      onRender: (m) => {
        frames.push(m.renderTime);
      },
    },
  );
  return {
    frames,
    bytes: () => stdout.bytesWritten(),
    reset: () => {
      frames.length = 0;
      stdout.resetBytes();
    },
    unmount: () => inst.unmount(),
  };
}
```

- [ ] **Step 2: Write the baseline test (documents today's behavior; task 5 flips it)**

```tsx
// tests/framePerf.test.tsx — frame-level perf guard (spec
// 2026-09-01-ink-render-perf-design.md, tier 0). Counts the frames Ink
// COMMITS (via onRender) while every poller returns unchanged data.
//
// BASELINE (task 1): every constant-data poll tick still commits a frame —
// each hook stores a fresh object and useQueueSnapshot bumps queueNow, so
// React never bails out. The idle assertion below is written against that
// measured defect and is flipped to `toBe(0)` by task 5 once every sink is
// change-gated. Numbers per scenario go to JUNCO_PERF_OUT when set (same
// convention as renderPerf.test.tsx) so before/after tables are reproducible.
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { mountForFrames, type FrameMount } from "./helpers/inkFrames.js";
import { EMPTY_QUEUE, CHEAP, HEAVY } from "./helpers/localFixtures.js";
import { until } from "./helpers/until.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const POLL_MS = 25;
const TICKS = 20;
/** Mount-settle: initial data arrival is a GENUINE frame; wait it out. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

let mounted: FrameMount | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const report: Record<string, { frames: number; meanMs: number }> = {};
function record(name: string, m: FrameMount): void {
  const n = m.frames.length;
  const meanMs = n === 0 ? 0 : m.frames.reduce((a, b) => a + b, 0) / n;
  report[name] = { frames: n, meanMs: Number(meanMs.toFixed(2)) };
}
afterAll(() => {
  if (process.env.JUNCO_PERF_OUT) writeFileSync(process.env.JUNCO_PERF_OUT, JSON.stringify(report, null, 2));
});

/** Pollers that return the SAME data on every call and count queue ticks. */
function constantPollers(): {
  ticks: () => number;
  queueFn: () => Promise<QueueSnapshot>;
  localCheapFn: () => Promise<typeof CHEAP>;
  localHeavyFn: () => Promise<typeof HEAVY>;
  assessHistoryFn: () => Promise<never[]>;
} {
  let ticks = 0;
  return {
    ticks: () => ticks,
    queueFn: async () => {
      ticks++;
      return EMPTY_QUEUE;
    },
    localCheapFn: async () => CHEAP,
    localHeavyFn: async () => HEAVY,
    assessHistoryFn: async () => [],
  };
}

describe("frame perf — constant-data polls", () => {
  it("idle: unchanged poll data commits frames (BASELINE — flipped to 0 by task 5)", async () => {
    const p = constantPollers();
    mounted = mountForFrames({
      queuePollMs: POLL_MS,
      healthPollMs: POLL_MS,
      localCheapPollMs: POLL_MS,
      assessHistoryPollMs: POLL_MS,
      queueFn: p.queueFn,
      localCheapFn: p.localCheapFn,
      localHeavyFn: p.localHeavyFn,
      assessHistoryFn: p.assessHistoryFn,
    });
    await settle();
    mounted.reset();
    const t0 = p.ticks();
    await until(() => p.ticks() >= t0 + TICKS, 200);
    record("idle-constant-polls", mounted);
    expect(mounted.frames.length).toBeGreaterThan(0);
  });

  it("a changed poll still paints (positive control for the gate)", async () => {
    let depth = EMPTY_QUEUE.outboxDepth;
    const queueFn = async (): Promise<QueueSnapshot> => ({ ...EMPTY_QUEUE, outboxDepth: depth });
    mounted = mountForFrames({ queuePollMs: POLL_MS, queueFn });
    await settle();
    mounted.reset();
    depth = 7; // next tick delivers a structurally different snapshot
    await until(() => (mounted?.frames.length ?? 0) >= 1, 200);
    record("one-change", mounted);
    expect(mounted.frames.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run the new file; expect both tests to pass (the baseline assertion matches today's behavior)**

Run: `npx vitest run tests/framePerf.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -8 /tmp/out`
Expected: `exit: 0`, 2 passed. Also run with numbers: `JUNCO_PERF_OUT=/tmp/perf-before.json npx vitest run tests/framePerf.test.tsx > /tmp/out 2>&1; echo "exit: $?"; cat /tmp/perf-before.json` — keep this file; the final PR body quotes it. Expect `idle-constant-polls.frames` ≥ 10 — roughly one frame per Ink throttle window (30 fps default), since four pollers at 25 ms coalesce into ~33 ms windows.

- [ ] **Step 4: Typecheck + lint the new files, format, commit**

Run: `npx prettier --write tests/helpers/inkFrames.tsx tests/framePerf.test.tsx && npm run typecheck && npx eslint tests/helpers/inkFrames.tsx tests/framePerf.test.tsx`
Expected: clean.

```bash
git add tests/helpers/inkFrames.tsx tests/framePerf.test.tsx
git commit -m "test(tui): frame harness under Ink's real render + baseline frame-per-poll measurement"
```

---

### Task 2: `keepIfEqual` helpers

**Files:**
- Create: `src/tui/hooks/keepIfEqual.ts`
- Create: `tests/keepIfEqual.test.ts`

**Interfaces:**
- Produces:
  - `keepIfEqual<T>(prev: T, next: T): T` — returns `prev` when `isDeepStrictEqual(prev, next)`, else `next`.
  - `keepIfEqualBy<T>(prev: T, next: T, key: (v: T) => unknown): T` — same, comparing `key(prev)` to `key(next)`.
  - `wholeMinutes(seconds: number | null): number | null` — `Math.floor(seconds / 60)`, null passthrough.

- [ ] **Step 1: Write the failing test**

```ts
// tests/keepIfEqual.test.ts
import { describe, it, expect } from "vitest";
import { keepIfEqual, keepIfEqualBy, wholeMinutes } from "../src/tui/hooks/keepIfEqual.js";

describe("keepIfEqual", () => {
  it("returns the previous reference when the next value is structurally equal", () => {
    const prev = { a: 1, rows: [{ id: "x", n: null }] };
    const next = { a: 1, rows: [{ id: "x", n: null }] };
    expect(keepIfEqual(prev, next)).toBe(prev);
  });
  it("returns the next value when anything differs", () => {
    const prev = { a: 1, rows: [{ id: "x" }] };
    const next = { a: 1, rows: [{ id: "y" }] };
    expect(keepIfEqual(prev, next)).toBe(next);
  });
  it("null → value adopts the value; value → null adopts null", () => {
    const v = { a: 1 };
    expect(keepIfEqual<{ a: number } | null>(null, v)).toBe(v);
    expect(keepIfEqual<{ a: number } | null>(v, null)).toBe(null);
  });
  it("is strict: 1 vs '1' and undefined vs missing key differ", () => {
    expect(keepIfEqual<unknown>({ a: 1 }, { a: "1" })).toEqual({ a: "1" });
    expect(keepIfEqual<unknown>({ a: undefined }, {})).toEqual({});
  });
});

describe("keepIfEqualBy", () => {
  it("compares through the key: equal keys keep prev even when raw values differ", () => {
    const prev = { uptime: 61 };
    const next = { uptime: 119 };
    expect(keepIfEqualBy(prev, next, (v) => wholeMinutes(v.uptime))).toBe(prev);
  });
  it("different keys adopt next", () => {
    const prev = { uptime: 61 };
    const next = { uptime: 120 };
    expect(keepIfEqualBy(prev, next, (v) => wholeMinutes(v.uptime))).toBe(next);
  });
});

describe("wholeMinutes", () => {
  it("floors to minutes and passes null through", () => {
    expect(wholeMinutes(0)).toBe(0);
    expect(wholeMinutes(59)).toBe(0);
    expect(wholeMinutes(60)).toBe(1);
    expect(wholeMinutes(4242)).toBe(70);
    expect(wholeMinutes(null)).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/keepIfEqual.test.ts > /tmp/out 2>&1; echo "exit: $?"; grep -m1 -E "Cannot find|Failed to resolve" /tmp/out`
Expected: `exit: 1` — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/hooks/keepIfEqual.ts
import { isDeepStrictEqual } from "node:util";

/** Return `prev` when `next` is structurally identical, else `next`. Used as
 * `setX((prev) => keepIfEqual(prev, next))` at every poll sink: an updater
 * that returns the previous reference lets React bail out (Object.is), so an
 * unchanged poll produces no commit — and therefore no Ink frame (spec
 * 2026-09-01-ink-render-perf-design.md, tier 1). Strict deep equality on
 * plain data; anything non-plain (functions, class instances) compares by
 * reference and simply falls through to today's behavior (a frame). */
export function keepIfEqual<T>(prev: T, next: T): T {
  return isDeepStrictEqual(prev, next) ? prev : next;
}

/** `keepIfEqual` through a projection: compare `key(prev)` to `key(next)` so
 * a sink can ignore fields it renders at a coarser granularity than they
 * change (uptime seconds rendered as minutes) while still STORING the raw
 * value. */
export function keepIfEqualBy<T>(prev: T, next: T, key: (v: T) => unknown): T {
  return isDeepStrictEqual(key(prev), key(next)) ? prev : next;
}

/** Whole minutes for equality keys — the granularity `fmtUp` (Chrome) and
 * `fmtDur` (sections) render uptime at. */
export function wholeMinutes(seconds: number | null): number | null {
  return seconds === null ? null : Math.floor(seconds / 60);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/keepIfEqual.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: `exit: 0`, 8 passed.

- [ ] **Step 5: Format, commit**

```bash
npx prettier --write src/tui/hooks/keepIfEqual.ts tests/keepIfEqual.test.ts
git add src/tui/hooks/keepIfEqual.ts tests/keepIfEqual.test.ts
git commit -m "feat(tui): keepIfEqual equality gate for poll sinks"
```

---

### Task 3: Gate `useQueueSnapshot`, `useHealth`, `useAssessHistory`

**Files:**
- Modify: `src/tui/hooks/useQueueSnapshot.ts` (the `run` body)
- Modify: `src/tui/hooks/useHealth.ts` (the `run` body + a private key)
- Modify: `src/tui/hooks/useAssessHistory.ts` (the `run` body + a rows ref)
- Modify: `tests/useQueueSnapshot.test.tsx`, `tests/useHealth.test.tsx`
- Create: `tests/useAssessHistory.test.tsx`

**Interfaces:**
- Consumes: `keepIfEqual`, `keepIfEqualBy`, `wholeMinutes` (task 2).
- Produces: unchanged hook signatures (`useQueueSnapshot` still returns `{ queueSnap, queueNow }` until task 4 removes `queueNow`).

The probe pattern for "same reference": a component collects every distinct non-null state reference in a `Set` held in a ref and renders its size — an equal poll must not grow it.

- [ ] **Step 1: Add the failing tests**

Append to `tests/useQueueSnapshot.test.tsx` (inside the existing `describe`), and add the `useRef` import (`import React, { useRef } from "react";`):

```tsx
  it("an equal poll keeps the previous snapshot reference; a changed one replaces it", async () => {
    let depth = 1;
    // A FRESH but structurally equal object on every call — the gate must see through it.
    const queueFn = async (): Promise<QueueSnapshot> => ({ ...MARKER_QUEUE, outboxDepth: depth });
    let calls = 0;
    const counting = async (): Promise<QueueSnapshot> => {
      calls++;
      return queueFn();
    };
    function RefProbe(): React.JSX.Element {
      const { queueSnap } = useQueueSnapshot(counting, 15);
      const seen = useRef(new Set<QueueSnapshot>());
      if (queueSnap) seen.current.add(queueSnap);
      return <Text>{`refs:${seen.current.size}:calls:${calls}`}</Text>;
    }
    const r = render(<RefProbe />);
    await until(() => calls >= 6);
    expect(r.lastFrame()).toMatch(/^refs:1:/);
    depth = 2;
    await until(() => r.lastFrame()?.startsWith("refs:2:") ?? false);
    r.unmount();
  });
```

Append to `tests/useHealth.test.tsx` (add `useRef` to the React import):

```tsx
  it("keeps the previous health reference while uptime stays in the same minute", async () => {
    let uptime = 4242; // minute 70
    let calls = 0;
    const client = {
      health: async () => {
        calls++;
        return { ...MARKER_HEALTH, uptimeSeconds: uptime };
      },
    } as unknown as DashboardClient;
    function RefProbe(): React.JSX.Element {
      const health = useHealth(client, 15);
      const seen = useRef(new Set<HealthInfo>());
      if (health) seen.current.add(health);
      return <Text>{`refs:${seen.current.size}:up:${health?.uptimeSeconds ?? "-"}`}</Text>;
    }
    const r = render(<RefProbe />);
    await until(() => calls >= 4);
    uptime = 4250; // still minute 70 → equal key → same reference, raw seconds NOT updated
    await until(() => calls >= 8);
    expect(r.lastFrame()).toBe("refs:1:up:4242");
    uptime = 4320; // minute 72 → new reference carrying the raw seconds
    await until(() => r.lastFrame() === "refs:2:up:4320");
    r.unmount();
  });
```

Create `tests/useAssessHistory.test.tsx`:

```tsx
// tests/useAssessHistory.test.tsx
import { describe, it, expect } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAssessHistory } from "../src/tui/hooks/useAssessHistory.js";
import type { AssessHistory } from "../src/assessHistory.js";
import { until } from "./helpers/until.js";

const ROW = (id: string): AssessHistory => ({
  id,
  lastSuccessAt: "2026-07-01T00:00:00Z",
  lastFound: 3,
  lastParked: 1,
  lastFailureAt: null,
  lastFailureReason: null,
});

describe("useAssessHistory", () => {
  it("rebuilds the Map only when the fetched rows change", async () => {
    let rows: AssessHistory[] = [ROW("acme/api")];
    let calls = 0;
    const fn = async (): Promise<AssessHistory[]> => {
      calls++;
      return rows.map((r) => ({ ...r })); // fresh objects, equal content
    };
    function RefProbe(): React.JSX.Element {
      const map = useAssessHistory(fn, 15);
      const seen = useRef(new Set<Map<string, AssessHistory>>());
      seen.current.add(map);
      return <Text>{`refs:${seen.current.size}:size:${map.size}`}</Text>;
    }
    const r = render(<RefProbe />);
    await until(() => calls >= 6);
    // The initial empty Map plus the first real one = 2 distinct references, never more.
    expect(r.lastFrame()).toBe("refs:2:size:1");
    rows = [ROW("acme/api"), ROW("beta/two")];
    await until(() => r.lastFrame() === "refs:3:size:2");
    r.unmount();
  });
});
```

- [ ] **Step 2: Run to verify the three new cases fail**

Run: `npx vitest run tests/useQueueSnapshot.test.tsx tests/useHealth.test.tsx tests/useAssessHistory.test.tsx > /tmp/out 2>&1; echo "exit: $?"; grep -E "✓|×|failed|passed" /tmp/out | tail -8`
Expected: `exit: 1`; the three new cases fail (`refs:` counts grow every poll).

- [ ] **Step 3: Implement the gates**

`src/tui/hooks/useQueueSnapshot.ts` — replace `setQueueSnap(s);` with:

```ts
      setQueueSnap((prev) => keepIfEqual(prev, s));
```

and add `import { keepIfEqual } from "./keepIfEqual.js";`. Leave `setQueueNow(new Date())` in place (task 4 removes it).

`src/tui/hooks/useHealth.ts` — add the import and a private key, and gate:

```ts
import { keepIfEqualBy, wholeMinutes } from "./keepIfEqual.js";

/** Equality key: the header renders uptime in whole minutes (Chrome's fmtUp),
 * so a poll that only advanced the seconds must not repaint. */
const healthKey = (h: HealthInfo | null): unknown =>
  h === null ? null : { ...h, uptimeSeconds: wholeMinutes(h.uptimeSeconds) };
```

and replace `if (alive) setHealth(h);` with `if (alive) setHealth((prev) => keepIfEqualBy(prev, h, healthKey));`.

`src/tui/hooks/useAssessHistory.ts` — compare the fetched rows to the last adopted rows and rebuild only on change:

```ts
import { useState, useEffect, useRef } from "react";
import { isDeepStrictEqual } from "node:util";
import type { AssessHistory } from "../../assessHistory.js";

// Assess-history polling (also fires once on mount). Slower than the queue
// cadence: a record only changes when an assess run finalizes (#193). The
// Map is rebuilt only when the fetched rows differ from the last adopted
// rows, so an unchanged poll never commits (spec 2026-09-01-ink-render-perf).
export function useAssessHistory(
  fn: () => Promise<AssessHistory[]>,
  pollMs: number,
): Map<string, AssessHistory> {
  const [assessHistory, setAssessHistory] = useState<Map<string, AssessHistory>>(new Map());
  const lastRows = useRef<AssessHistory[] | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const rows = await fn();
      if (!alive) return;
      if (lastRows.current !== null && isDeepStrictEqual(lastRows.current, rows)) return;
      lastRows.current = rows;
      setAssessHistory(new Map(rows.map((h) => [h.id, h])));
    };
    void run();
    const id = setInterval(() => void run(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fn, pollMs]);
  return assessHistory;
}
```

- [ ] **Step 4: Run the three files, then the full suite**

Run: `npx vitest run tests/useQueueSnapshot.test.tsx tests/useHealth.test.tsx tests/useAssessHistory.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: `exit: 0`.
Run: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: `exit: 0` (framePerf's baseline case still passes — `localCheap` and `queueNow` still churn).

**Found during execution:** `tests/renderPerf.test.tsx` drives its "unrelated App re-render" with a health poll whose fake returns an *unchanged* object — exactly what the gate now suppresses, so its `waitForNextAppRender` never resolves (4 of 8 cases fail). Fix the fixture, not the gate: add a `tickingHealthClient()` there (spread `stubClient`, `health` returns the stub answer with `tasksProcessed: ++n` — a Header-only field) and pass `client: tickingHealthClient()` in each of its 8 `renderApp` calls, with a comment explaining why the answer must change per tick. Include the file in this task's commit.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/tui/hooks/useQueueSnapshot.ts src/tui/hooks/useHealth.ts src/tui/hooks/useAssessHistory.ts tests/useQueueSnapshot.test.tsx tests/useHealth.test.tsx tests/useAssessHistory.test.tsx
npx eslint src/tui/hooks tests/useQueueSnapshot.test.tsx tests/useHealth.test.tsx tests/useAssessHistory.test.tsx
git add src/tui/hooks/useQueueSnapshot.ts src/tui/hooks/useHealth.ts src/tui/hooks/useAssessHistory.ts tests/useQueueSnapshot.test.tsx tests/useHealth.test.tsx tests/useAssessHistory.test.tsx
git commit -m "perf(tui): change-gate the queue, health and assess-history poll sinks"
```

---

### Task 4: `useClock` replaces the per-poll `queueNow`

**Files:**
- Create: `src/tui/hooks/useClock.ts`
- Create: `tests/useClock.test.tsx`
- Modify: `src/tui/hooks/useQueueSnapshot.ts` (drop `queueNow`), `tests/useQueueSnapshot.test.tsx` (probe no longer reads `queueNow`)
- Modify: `src/tui/App.tsx` — `AppProps` (line ~115, next to `queuePollMs`), the hook call (line 333), 13 `now={queueNow}` sites (lines 2541–2835)
- Modify: `tests/helpers/localFixtures.tsx` (`makeAppProps` default), `tests/tuiApp.test.tsx` (every `<App>` mount that sets the poll knobs)
- Modify: `tests/framePerf.test.tsx` (add the clock case)

**Interfaces:**
- Produces: `useClock(intervalMs: number): Date`; `AppProps.clockMs?: number` (default `5_000`); `useQueueSnapshot` now returns `{ queueSnap: QueueSnapshot | null }`.

- [ ] **Step 1: Write the failing clock test**

```tsx
// tests/useClock.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useClock } from "../src/tui/hooks/useClock.js";
import { until } from "./helpers/until.js";

function Probe({ ms }: { ms: number }): React.JSX.Element {
  const now = useClock(ms);
  return <Text>{String(now.getTime())}</Text>;
}

describe("useClock", () => {
  it("starts at mount time and advances on its own interval", async () => {
    const before = Date.now();
    const r = render(<Probe ms={15} />);
    const first = Number(r.lastFrame());
    expect(first).toBeGreaterThanOrEqual(before);
    await until(() => Number(r.lastFrame()) > first);
    r.unmount();
  });

  it("a frozen interval never ticks", async () => {
    const r = render(<Probe ms={999_999} />);
    const first = r.lastFrame();
    await new Promise((res) => setTimeout(res, 60));
    expect(r.lastFrame()).toBe(first);
    r.unmount();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/useClock.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: `exit: 1` — module not found.

- [ ] **Step 3: Implement `useClock`**

```ts
// src/tui/hooks/useClock.ts
import { useState, useEffect } from "react";

/** The dashboard's age clock: the `now` every "Ns ago" / elapsed string is
 * computed against. A standalone tick (default 5 s in App) instead of a bump
 * on every queue poll, so a poll that delivered unchanged data commits
 * nothing (spec 2026-09-01-ink-render-perf-design.md). Consumers render ages
 * at minute granularity except the sub-minute "Ns ago" form, where a 5 s step
 * is the accepted trade-off. */
export function useClock(intervalMs: number): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}
```

- [ ] **Step 4: Run the clock test**

Run: `npx vitest run tests/useClock.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: `exit: 0`.

- [ ] **Step 5: Remove `queueNow` from `useQueueSnapshot`**

`src/tui/hooks/useQueueSnapshot.ts` becomes:

```ts
import { useState, useEffect } from "react";
import type { QueueSnapshot } from "../queueSnapshot.js";
import { keepIfEqual } from "./keepIfEqual.js";

export function useQueueSnapshot(
  queueFn: () => Promise<QueueSnapshot>,
  pollMs: number,
): { queueSnap: QueueSnapshot | null } {
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot | null>(null);

  // Queue polling (also fires once on mount). An unchanged snapshot keeps the
  // previous reference so React bails out — the age clock is useClock's job.
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const s = await queueFn();
      if (!alive) return;
      setQueueSnap((prev) => keepIfEqual(prev, s));
    };
    void run();
    const id = setInterval(() => void run(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [queueFn, pollMs]);

  return { queueSnap };
}
```

In `tests/useQueueSnapshot.test.tsx`, the first probe becomes:

```tsx
function Probe({ queueFn }: { queueFn: () => Promise<QueueSnapshot> }) {
  const { queueSnap } = useQueueSnapshot(queueFn, 999999);
  return <Text>{queueSnap ? `depth:${queueSnap.outboxDepth}` : "none"}</Text>;
}
```

and its assertion `await until(() => r.lastFrame() === "depth:4242");`.

- [ ] **Step 6: Wire the clock into `App`**

In `src/tui/App.tsx`:

1. `AppProps` — after the `queuePollMs?: number;` line add:
   ```ts
   clockMs?: number; // default 5_000 — the age clock ("Ns ago", elapsed); tests freeze it
   ```
2. Where the poll defaults are read (`const queuePollMs = props.queuePollMs ?? 1_000;`) add:
   ```ts
   const clockMs = props.clockMs ?? 5_000;
   ```
3. Replace `const { queueSnap, queueNow } = useQueueSnapshot(queueFn, queuePollMs);` with:
   ```ts
   const { queueSnap } = useQueueSnapshot(queueFn, queuePollMs);
   const now = useClock(clockMs);
   ```
   and add `import { useClock } from "./hooks/useClock.js";` next to the other hook imports.
4. Replace every `now={queueNow}` with `now={now}` (13 sites; `grep -n "queueNow" src/tui/App.tsx` must then print nothing).

- [ ] **Step 7: Freeze the clock in every App fixture**

- `tests/helpers/localFixtures.tsx` `makeAppProps`: add `clockMs: 999_999,` after `queuePollMs: 999999,`.
- `tests/tuiApp.test.tsx`: every `<App …>` element that sets `queuePollMs={999999}` (7 sites — `grep -n "queuePollMs={999999}" tests/tuiApp.test.tsx`) gets `clockMs={999_999}` on the next line.

- [ ] **Step 8: Add the clock case to `tests/framePerf.test.tsx`**

Append inside the `describe`:

```tsx
  it("the clock paints on its own tick, and only then", async () => {
    mounted = mountForFrames({ clockMs: 40 }); // every poll stays frozen at the fixture's 999999
    await settle();
    mounted.reset();
    await until(() => (mounted?.frames.length ?? 0) >= 2, 100);
    record("clock-only", mounted);
    expect(mounted.frames.length).toBeGreaterThanOrEqual(2);
  });
```

**Found during execution:** with `queueNow` gone, the idle case reported 0 frames already — the fixtures returned the SAME object reference per poll, so App's still-ungated `setLocalCheap(c)` bailed out on `Object.is`. The real pollers build a fresh snapshot per call, so `constantPollers()` must return `structuredClone(...)` per call (and its header comment says why); the baseline assertion then still holds here and flips honestly in task 5.

- [ ] **Step 9: Typecheck, run the touched files, then the full suite**

Run: `npm run typecheck && npx vitest run tests/useClock.test.tsx tests/useQueueSnapshot.test.tsx tests/framePerf.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: `exit: 0`.
Run: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: `exit: 0`. If an age assertion in an App suite changed, the fixture in step 7 is missing on that mount — fix the fixture, never the assertion.

- [ ] **Step 10: Format, lint, commit**

```bash
npx prettier --write src/tui/hooks/useClock.ts src/tui/hooks/useQueueSnapshot.ts src/tui/App.tsx tests/useClock.test.tsx tests/useQueueSnapshot.test.tsx tests/helpers/localFixtures.tsx tests/tuiApp.test.tsx tests/framePerf.test.tsx
npm run lint
git add src/tui/hooks/useClock.ts src/tui/hooks/useQueueSnapshot.ts src/tui/App.tsx tests/useClock.test.tsx tests/useQueueSnapshot.test.tsx tests/helpers/localFixtures.tsx tests/tuiApp.test.tsx tests/framePerf.test.tsx
git commit -m "perf(tui): standalone 5s age clock replaces the per-poll queueNow bump"
```

---

### Task 5: Gate the local and GitHub poll sinks; flip the idle assertion to zero

**Files:**
- Modify: `src/tui/App.tsx` — `forceLocalRefresh` (two `set…` calls), the cheap-poll effect (`setLocalCheap(c)`), the heavy-poll effect (`setLocalHeavy(h)`), plus a module-level `localCheapKey`
- Modify: `src/tui/hooks/useGithubData.ts` — `loadIssues` (`setIssues`, `setStaleAt`), `loadPrs` (`setPrs`, `setPrStaleByRepo`), `loadPrsFor` (`setPrs`, `setPrStaleByRepo`)
- Modify: `tests/framePerf.test.tsx` (flip the idle assertion; add a GitHub-refresh case)
- Modify: `docs/superpowers/specs/2026-09-01-ink-render-perf-design.md` (add `refreshedAt` to the known residual)

**Interfaces:**
- Consumes: `keepIfEqual`, `keepIfEqualBy`, `wholeMinutes` (task 2); `mountForFrames` (task 1).

- [ ] **Step 1: Flip the idle assertion (the failing test)**

In `tests/framePerf.test.tsx` rename the case to `"idle: unchanged poll data commits NO frames"`, change `expect(mounted.frames.length).toBeGreaterThan(0);` to `expect(mounted.frames.length).toBe(0);`, and rewrite the file-header comment: replace the BASELINE paragraph with

```
// MEASURED: before tier 1 every constant-data poll tick committed a frame
// (~20 frames per 20 ticks — see the task-1 commit body); after gating every
// sink the same window commits 0. The positive-control case guards the gate
// from hiding a real change.
```

Also append a GitHub-refresh case — the refresh path stores a fresh `refreshedAt` timestamp on every cycle (a real, rendered change: "↻ Ns ago"), so it is asserted as *bounded*, not zero:

```tsx
  it("a constant GitHub refresh commits at most one frame per refresh cycle", async () => {
    let cycles = 0;
    const p = constantPollers();
    mounted = mountForFrames({
      refreshPollMs: POLL_MS,
      queueFn: p.queueFn,
      localCheapFn: p.localCheapFn,
      localHeavyFn: p.localHeavyFn,
      assessHistoryFn: p.assessHistoryFn,
      client: {
        ...stubClient,
        listIssues: async (nwo) => {
          cycles++;
          return stubClient.listIssues(nwo);
        },
      },
    });
    await settle();
    mounted.reset();
    const c0 = cycles;
    await until(() => cycles >= c0 + TICKS, 200);
    record("github-refresh-constant", mounted);
    expect(mounted.frames.length).toBeLessThanOrEqual(cycles - c0);
  });
```

and import `stubClient` from `./helpers/localFixtures.js`.

- [ ] **Step 2: Run to verify the idle case fails**

Run: `npx vitest run tests/framePerf.test.tsx > /tmp/out 2>&1; echo "exit: $?"; grep -E "✓|×" /tmp/out`
Expected: `exit: 1`; the idle case fails with `expected 20 to be 0` (or similar), the others pass.

- [ ] **Step 3: Gate App's local sinks**

In `src/tui/App.tsx` add the import `import { keepIfEqual, keepIfEqualBy, wholeMinutes } from "./hooks/keepIfEqual.js";` and, at module level (after the other top-level helpers, before `export function App`):

```ts
/** Equality key for the cheap local snapshot: the daemon section renders
 * uptime in whole minutes (sections' fmtDur), so a poll that only advanced
 * the seconds must not repaint. Everything else compares as-is. */
const localCheapKey = (c: LocalCheap | null): unknown =>
  c === null ? null : { ...c, daemon: { ...c.daemon, uptimeSeconds: wholeMinutes(c.daemon.uptimeSeconds) } };
```

Then:
- in `forceLocalRefresh`: `setLocalCheap(c);` → `setLocalCheap((prev) => keepIfEqualBy(prev, c, localCheapKey));` and `if (aliveRef.current) setLocalHeavy(h);` → `if (aliveRef.current) setLocalHeavy((prev) => keepIfEqual(prev, h));`
- in the cheap-poll effect: `setLocalCheap(c);` → `setLocalCheap((prev) => keepIfEqualBy(prev, c, localCheapKey));`
- in the heavy-poll effect: `setLocalHeavy(h);` → `setLocalHeavy((prev) => keepIfEqual(prev, h));`

(`LocalCheap` is already imported as a type in App.tsx — check with `grep -n "LocalCheap" src/tui/App.tsx | head -3`; add it to the existing type import from `./localSnapshot.js` if missing.)

**Found during execution:** App has a FOURTH local-cheap sink the file map missed — the section-switch refresh (`void localCheapFn({ section: … }).then((c) => { if (aliveRef.current) setLocalCheap(c); })`, App.tsx ~line 1019). Gate it the same way; `grep -n "setLocalCheap(c)\|setLocalHeavy(h)" src/tui/App.tsx` must print nothing afterwards.

- [ ] **Step 4: Gate the GitHub refresh sinks**

In `src/tui/hooks/useGithubData.ts` add `import { keepIfEqual } from "./keepIfEqual.js";` and:

- `loadIssues`:
  ```ts
  setIssues((prev) => keepIfEqual(prev, { ...prev, [nwo]: sortIssues(res.value.issues, trigger) }));
  setStaleAt((prev) => keepIfEqual(prev, { ...prev, [nwo]: res.value.staleAt }));
  ```
- `loadPrs`:
  ```ts
  setPrs((prev) => keepIfEqual(prev, sortPrs(all)));
  setPrStaleByRepo((prev) => keepIfEqual(prev, staleMap));
  ```
- `loadPrsFor`:
  ```ts
  setPrs((prev) => keepIfEqual(prev, sortPrs([...prev.filter((p) => p.nwo !== nwo), ...res.value.prs])));
  setPrStaleByRepo((prev) => keepIfEqual(prev, { ...prev, [nwo]: res.value.staleAt }));
  ```

- [ ] **Step 5: Run framePerf; if the idle case still counts frames, find the last churning sink**

Run: `npx vitest run tests/framePerf.test.tsx > /tmp/out 2>&1; echo "exit: $?"; grep -E "✓|×|expected" /tmp/out`
Expected: `exit: 0`, idle case reports 0 frames. If not: temporarily set `JUNCO_RENDER_COUNT=1` and log `renderCounts()` from `src/tui/renderCount.ts` in the test to see which component re-rendered, then trace its prop back to the un-gated `set…` — every sink in the spec's table must use the gate. Do not loosen the assertion.

- [ ] **Step 6: Record the after numbers, run the full suite**

Run: `JUNCO_PERF_OUT=/tmp/perf-after.json npx vitest run tests/framePerf.test.tsx > /tmp/out 2>&1; echo "exit: $?"; cat /tmp/perf-after.json`
Run: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: `exit: 0` for both.

- [ ] **Step 7: Note the `refreshedAt` residual in the spec**

In the spec's **Known residual** paragraph append one sentence: "The GitHub refresh cycle likewise stores a fresh `refreshedAt` timestamp (rendered as "↻ Ns ago"), so a refresh commits at most one frame per `refreshPollMs` (default 30 s) even when the issue and PR lists are unchanged."

- [ ] **Step 8: Format, lint, commit**

```bash
npx prettier --write src/tui/App.tsx src/tui/hooks/useGithubData.ts tests/framePerf.test.tsx
npm run lint
git add src/tui/App.tsx src/tui/hooks/useGithubData.ts tests/framePerf.test.tsx docs/superpowers/specs/2026-09-01-ink-render-perf-design.md
git commit -m "perf(tui): change-gate the local and GitHub poll sinks — idle commits zero frames"
```

Put the before/after numbers (`/tmp/perf-before.json` from task 1, `/tmp/perf-after.json`) in this commit's body as a two-row table.

---

### Task 6: `Spinner` on Ink's shared animation timer

**Files:**
- Modify: `src/tui/components/Spinner.tsx`
- Modify: `tests/tuiComponents.test.tsx` (add one case to `describe("cursor + spinner polish")`)

**Interfaces:**
- Produces: unchanged — `Spinner` component and `SPINNER_FRAMES` export.

- [ ] **Step 1: Write the failing test (two spinners must share one tick)**

Append inside `describe("cursor + spinner polish", …)` in `tests/tuiComponents.test.tsx`:

```tsx
  it("two Spinners advance on the same shared tick", async () => {
    const { Spinner, SPINNER_FRAMES } = await import("../src/tui/components/Spinner.js");
    const { Text } = await import("ink");
    const r = render(
      <Text>
        <Spinner />|<Spinner />
      </Text>,
    );
    const glyphs = (f: string): string[] => f.split("|").map((s) => s.trim());
    const first = r.lastFrame()!;
    await until(() => r.lastFrame() !== first);
    // Sample several frames: the two glyphs are always identical because
    // useAnimation drives every spinner from ONE timer (ink 7.1), so N mounted
    // spinners cost one commit per tick, not N.
    for (let i = 0; i < 5; i++) {
      const [a, b] = glyphs(r.lastFrame()!);
      expect(SPINNER_FRAMES).toContain(a);
      expect(a).toBe(b);
      const cur = r.lastFrame();
      await until(() => r.lastFrame() !== cur);
    }
    r.unmount();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiComponents.test.tsx -t "shared tick" > /tmp/out 2>&1; echo "exit: $?"; grep -E "×|expected" /tmp/out | head -3`
Expected: `exit: 1` — with two independent `setInterval`s the glyphs drift apart within a few samples. (If it happens to pass by phase luck, run it three times; the implementation in step 3 is required regardless — it is the spec's deliverable.)

- [ ] **Step 3: Implement**

```tsx
// src/tui/components/Spinner.tsx
import React from "react";
import { Text, useAnimation } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Braille spinner on Ink's shared animation timer (ink 7.1 useAnimation):
 * every mounted spinner ticks from ONE interval, coalesced with Ink's render
 * throttle, so N spinners cost one commit per tick — not N — and a spinner
 * never schedules a commit inside a throttled window. ~10fps, cyan. */
export function Spinner(): React.JSX.Element {
  const { frame } = useAnimation({ interval: 100 });
  return <Text color="cyan">{FRAMES[frame % FRAMES.length]}</Text>;
}

export const SPINNER_FRAMES = FRAMES;
```

- [ ] **Step 4: Run the component file and the App spinner test, then the full suite**

Run: `npx vitest run tests/tuiComponents.test.tsx tests/tuiApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: `exit: 0`.
Run: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: `exit: 0`.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/tui/components/Spinner.tsx tests/tuiComponents.test.tsx
npx eslint src/tui/components/Spinner.tsx tests/tuiComponents.test.tsx
git add src/tui/components/Spinner.tsx tests/tuiComponents.test.tsx
git commit -m "perf(tui): Spinner rides Ink's shared useAnimation timer"
```

---

### Task 7: Incremental rendering + suspend/resume full-repaint guard

**Files:**
- Modify: `src/dashboardCmd.ts:35` (`INK_RENDER_OPTIONS`)
- Modify: `tests/dashboardCmd.test.ts` (the `INK_RENDER_OPTIONS` describe)
- Modify: `tests/useSuspendTty.test.tsx` (new case)

**Interfaces:**
- Produces: `INK_RENDER_OPTIONS = { exitOnCtrlC: false, alternateScreen: true, incrementalRendering: true } as const`.

- [ ] **Step 1: Write the failing option test**

Append to the `describe("INK_RENDER_OPTIONS …")` block in `tests/dashboardCmd.test.ts`:

```ts
  it("renders incrementally so an animation frame rewrites only changed lines", () => {
    expect(INK_RENDER_OPTIONS.incrementalRendering).toBe(true);
  });
```

- [ ] **Step 2: Write the failing suspend/resume test**

Append a second `describe` to `tests/useSuspendTty.test.tsx`. It needs a stdout fake that keeps every chunk, so add this helper below `fakeTtyStreams`:

```tsx
/** Like fakeTtyStreams, but stdout keeps every chunk so the bytes written
 * after the alt-screen re-entry can be inspected. */
function recordingTtyStreams(chunks: string[]): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
} {
  const { stdin } = fakeTtyStreams([]);
  const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  });
  return { stdin, stdout };
}
```

and the case:

```tsx
describe("useSuspend under incrementalRendering", () => {
  it("repaints the whole UI after resume, not a diff against the pre-suspend frame", async () => {
    const chunks: string[] = [];
    let done = false;
    function Probe(): React.JSX.Element {
      const suspend = useSuspend();
      useEffect(() => {
        void suspend(async () => {}).then(() => {
          done = true;
        });
      }, []);
      return (
        <>
          <Text>line-alpha</Text>
          <Text>line-bravo</Text>
          <Text>line-charlie</Text>
        </>
      );
    }
    const { stdin, stdout } = recordingTtyStreams(chunks);
    const app = render(
      <SuspendProvider>
        <Probe />
      </SuspendProvider>,
      { stdin, stdout, exitOnCtrlC: false, patchConsole: false, incrementalRendering: true },
    );
    unmountFn = () => app.unmount();
    await until(() => done);
    // Let the post-resume commit land (bounded): the resumed frame must be on the wire.
    await until(() => chunks.slice(lastAltEnter(chunks) + 1).join("").includes("line-charlie"));

    const after = chunks.slice(lastAltEnter(chunks) + 1).join("");
    // Incremental log-update diffs against the EMPTY frame written during
    // suspension, so every line is rewritten — the cleared alt screen shows
    // nothing to diff against. All three lines must be present after re-entry.
    expect(after).toContain("line-alpha");
    expect(after).toContain("line-bravo");
    expect(after).toContain("line-charlie");
  });
});

function lastAltEnter(chunks: string[]): number {
  let idx = -1;
  chunks.forEach((c, i) => {
    if (c.includes("\x1b[?1049h")) idx = i;
  });
  return idx;
}
```

(Hoist `lastAltEnter` above the `describe` if `no-use-before-define` complains.)

- [ ] **Step 3: Run both files; expect the option test to fail and the suspend test to pass**

Run: `npx vitest run tests/dashboardCmd.test.ts tests/useSuspendTty.test.tsx > /tmp/out 2>&1; echo "exit: $?"; grep -E "✓|×" /tmp/out`
Expected: `exit: 1`; only "renders incrementally" fails (`undefined` vs `true`). The suspend case passes already — it pins Ink-internal behavior the option relies on; if it FAILS, stop: the option is unsafe with the custom suspend path and the finding goes back to the maintainer.

- [ ] **Step 4: Set the option**

In `src/dashboardCmd.ts` replace the constant with:

```ts
export const INK_RENDER_OPTIONS = {
  exitOnCtrlC: false,
  alternateScreen: true,
  // Line-diff writes: an animation frame (spinner) rewrites only the changed
  // line(s) — measured 15.6 KiB → 0.4 KiB per frame — CPU unchanged (spec
  // 2026-09-01-ink-render-perf-design.md, tier 2). Safe with useSuspend's
  // blank-frame handoff: tests/useSuspendTty.test.tsx pins the full repaint.
  incrementalRendering: true,
} as const;
```

and extend the comment block above it (line ~33, "scrollback pollution, terminal restored on exit.") only if it enumerates the options — keep it truthful.

- [ ] **Step 5: Run both files, then the full suite**

Run: `npx vitest run tests/dashboardCmd.test.ts tests/useSuspendTty.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: `exit: 0`.
Run: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: `exit: 0`.

- [ ] **Step 6: Format, lint, commit**

```bash
npx prettier --write src/dashboardCmd.ts tests/dashboardCmd.test.ts tests/useSuspendTty.test.tsx
npx eslint src/dashboardCmd.ts tests/dashboardCmd.test.ts tests/useSuspendTty.test.tsx
git add src/dashboardCmd.ts tests/dashboardCmd.test.ts tests/useSuspendTty.test.tsx
git commit -m "perf(dashboard): incremental rendering — animation frames rewrite only changed lines"
```

---

### Task 8: Full gate, numbers, and hand-off

**Files:**
- Modify: `CHANGELOG.md` (Unreleased → Changed)

- [ ] **Step 1: Run the full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/out 2>&1; echo "exit: $?"; tail -6 /tmp/out`
Expected: every stage clean, `exit: 0`.

- [ ] **Step 2: Coverage floor**

Run: `npx vitest run --coverage > /tmp/cov 2>&1; echo "exit: $?"; grep -E "ERROR|threshold" /tmp/cov | head -5`
Expected: `exit: 0`, no threshold errors.

- [ ] **Step 3: Changelog entry**

Under `## [Unreleased]` → `### Changed` (create the heading if absent) add:

```
- Dashboard idle cost: a poll that delivers unchanged data no longer commits an Ink frame — every poll sink keeps its previous state on structural equality, and the age clock ticks on its own 5 s interval instead of every queue poll. Sub-minute "Ns ago" strings now step in 5 s increments. Spinners share Ink's animation timer, and the dashboard renders incrementally so an animation frame rewrites only changed lines. A frame-level perf test (`tests/framePerf.test.tsx`) pins zero frames per constant-data poll tick.
```

- [ ] **Step 4: Commit and hand off**

```bash
npx prettier --check CHANGELOG.md || true
git add CHANGELOG.md
git commit -m "docs(changelog): dashboard idle frames, shared spinner timer, incremental rendering"
```

Then invoke `superpowers:finishing-a-development-branch` (merge `origin/main` first; open the PR with the before/after table from `/tmp/perf-before.json` and `/tmp/perf-after.json`; no release action — release HOLD per CLAUDE.md).
