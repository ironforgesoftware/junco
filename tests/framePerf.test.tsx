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
  if (process.env.JUNCO_PERF_OUT) {
    writeFileSync(process.env.JUNCO_PERF_OUT, JSON.stringify(report, null, 2));
  }
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
