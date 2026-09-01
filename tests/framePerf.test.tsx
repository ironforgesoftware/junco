// tests/framePerf.test.tsx — frame-level perf guard (spec
// 2026-09-01-ink-render-perf-design.md, tier 0). Counts the frames Ink
// COMMITS (via onRender) while every poller returns unchanged data.
//
// MEASURED: before tier 1 every constant-data poll tick committed a frame —
// each sink stored a fresh object and useQueueSnapshot bumped queueNow, so
// React never bailed out (10 frames per 20 ticks at the 30 fps throttle, see
// the task-1 commit body). After gating every sink the same window commits
// 0. The real pollers build a new snapshot per call, so the fixtures return a
// fresh structuredClone per call too — a same-reference fixture would pass
// on Object.is alone and prove nothing. The positive-control case guards the
// gate from ever hiding a real change. Numbers per scenario go to
// JUNCO_PERF_OUT when set (same convention as renderPerf.test.tsx).
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { mountForFrames, type FrameMount } from "./helpers/inkFrames.js";
import { EMPTY_QUEUE, CHEAP, HEAVY, stubClient } from "./helpers/localFixtures.js";
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
  if (process.env.JUNCO_PERF_OUT) {
    writeFileSync(process.env.JUNCO_PERF_OUT, JSON.stringify(report, null, 2));
  }
});

/** Pollers that return the SAME data (a fresh, structurally equal clone — as
 * the real pollers do) on every call and count queue ticks. */
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
      return structuredClone(EMPTY_QUEUE);
    },
    localCheapFn: async () => structuredClone(CHEAP),
    localHeavyFn: async () => structuredClone(HEAVY),
    assessHistoryFn: async () => [],
  };
}

describe("frame perf — constant-data polls", () => {
  it("idle: unchanged poll data commits NO frames", async () => {
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
    expect(mounted.frames.length).toBe(0);
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

  it("the clock paints on its own tick, and only then", async () => {
    mounted = mountForFrames({ clockMs: 40 }); // every poll stays frozen at the fixture's 999999
    await settle();
    mounted.reset();
    await until(() => (mounted?.frames.length ?? 0) >= 2, 100);
    record("clock-only", mounted);
    expect(mounted.frames.length).toBeGreaterThanOrEqual(2);
  });

  it("a constant GitHub refresh commits at most one frame per refresh cycle", async () => {
    // The refresh path stores a fresh `refreshedAt` timestamp every cycle — a
    // real, rendered change ("↻ Ns ago") — so this is bounded, not zero.
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
});
