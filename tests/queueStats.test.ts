import { describe, it, expect } from "vitest";
import { buildQueueStats } from "../src/tui/queueStats.js";
import type { Config } from "../src/types.js";
import type { TaskRecord } from "../src/taskHistory.js";
import type { HealthBody } from "../src/tui/healthBody.js";
import type { MetricsSnapshot } from "../src/metrics.js";

const NOW = new Date("2026-07-19T12:00:00Z");

/** Minimal config (same cast-through-unknown style as queueSnapshot.test.ts). */
function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    queueRoot: "/q",
    dataDir: "/data",
    defaultTimeoutMinutes: 30,
    maxConcurrent: 2,
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    ...overrides,
  } as unknown as Config;
}

/** Minimal MetricsSnapshot (only the fields buildQueueStats reads matter). */
function makeMetrics(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    startedAt: null,
    uptimeSeconds: 0,
    pid: 1,
    pollCount: 0,
    lastPollAt: null,
    currentTicket: null,
    currentTickets: [],
    tasksProcessed: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    tasksByStatus: {},
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalDurationMs: 0,
    totalCostUsd: 0,
    lastTaskAt: null,
    lastTaskStatus: null,
    bridgeSweeps: 0,
    lastBridgeSweepAt: null,
    ticketsBridged: 0,
    bridgeErrors: 0,
    outboxDepth: 0,
    outboxEnqueued: 0,
    outboxFlushed: 0,
    outboxDead: 0,
    lastFlushAt: null,
    requeues: 0,
    guardNudges: 0,
    guardKills: 0,
    gateTransitions: {},
    currentProgress: {},
    pendingRestartFields: [],
    ...overrides,
  };
}

function makeHealthBody(overrides: Partial<HealthBody> = {}): HealthBody {
  return {
    status: "ok",
    ready: true,
    metrics: makeMetrics(),
    ...overrides,
  };
}

function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    v: 1,
    at: NOW.toISOString(),
    id: "t1",
    kind: "pr",
    status: "completed",
    durationSeconds: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    retryCount: 0,
    ...overrides,
  };
}

const emptyOutbox = { depth: 0, dead: 0 };

describe("buildQueueStats", () => {
  it("case 1: ledger 24h window sums done+failed across ALL finalized tasks", () => {
    const within24h = [
      makeRecord({
        id: "d1",
        status: "completed",
        durationSeconds: 60,
        tokensIn: 10,
        tokensOut: 1,
        costUsd: 0.1,
      }),
      makeRecord({
        id: "d2",
        status: "completed",
        durationSeconds: 120,
        tokensIn: 20,
        tokensOut: 2,
        costUsd: 0.1,
      }),
      makeRecord({
        id: "d3",
        status: "completed",
        durationSeconds: 180,
        tokensIn: 30,
        tokensOut: 3,
        costUsd: 0.1,
      }),
      makeRecord({
        id: "f1",
        status: "timeout",
        durationSeconds: 120,
        tokensIn: 30,
        tokensOut: 4,
        costUsd: 0.1,
      }),
    ];
    // Older than 24h but inside 7d — must show up in perDay7d, NOT window24h.
    const older = new Date(NOW.getTime() - 2 * 86_400_000);
    const outsideWindow = makeRecord({
      id: "old1",
      at: older.toISOString(),
      status: "completed",
      durationSeconds: 999,
      tokensIn: 999,
      tokensOut: 999,
      costUsd: 99,
    });
    const all = [...within24h, outsideWindow];
    const stats = buildQueueStats(
      makeCfg(),
      {
        healthBody: null,
        history: () => all,
        eligibleWaiting: 0,
        outbox: emptyOutbox,
      },
      { nowFn: () => NOW },
    );
    expect(stats.window24h).toEqual({
      done: 3,
      failed: 1,
      successRate: 0.75,
      avgDurationSeconds: 120,
      tokensIn: 90,
      tokensOut: 10,
      costUsd: 0.4,
    });
  });

  it("case 2: done classification follows TERMINAL_DONE_STATUSES", () => {
    const recs = [
      makeRecord({ id: "a", status: "timeout_partial", durationSeconds: 10 }), // done
      makeRecord({ id: "b", status: "aborted_no_changes", durationSeconds: 10 }), // failed
    ];
    const stats = buildQueueStats(
      makeCfg(),
      { healthBody: null, history: () => recs, eligibleWaiting: 0, outbox: emptyOutbox },
      { nowFn: () => NOW },
    );
    expect(stats.window24h.done).toBe(1);
    expect(stats.window24h.failed).toBe(1);
  });

  it("case 3: perDay7d buckets by LOCAL calendar day, oldest to newest; empty history -> []", () => {
    // NOW = 2026-07-19T12:00:00Z. Build local-noon timestamps for three
    // distinct local calendar days within the 7-day window.
    const local = (d: Date, dayOffset: number): Date => {
      const base = new Date(d);
      base.setDate(base.getDate() - dayOffset);
      return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12);
    };
    const day0 = local(NOW, 0); // today
    const day2 = local(NOW, 2);
    const day5 = local(NOW, 5);
    const recs = [
      makeRecord({ id: "a", at: day0.toISOString(), status: "completed" }),
      makeRecord({ id: "b", at: day0.toISOString(), status: "timeout" }),
      makeRecord({ id: "c", at: day2.toISOString(), status: "completed" }),
      makeRecord({ id: "d", at: day5.toISOString(), status: "timeout" }),
    ];
    const stats = buildQueueStats(
      makeCfg(),
      { healthBody: null, history: () => recs, eligibleWaiting: 0, outbox: emptyOutbox },
      { nowFn: () => NOW },
    );
    expect(stats.perDay7d).toHaveLength(7);
    // Oldest -> newest: index 0 is 6 days ago, index 6 is today.
    expect(stats.perDay7d[6]).toEqual({ done: 1, failed: 1 }); // today (day0)
    expect(stats.perDay7d[4]).toEqual({ done: 1, failed: 0 }); // 2 days ago
    expect(stats.perDay7d[1]).toEqual({ done: 0, failed: 1 }); // 5 days ago
    // The untouched buckets stay zeroed.
    expect(stats.perDay7d[0]).toEqual({ done: 0, failed: 0 });
    expect(stats.perDay7d[2]).toEqual({ done: 0, failed: 0 });
    expect(stats.perDay7d[3]).toEqual({ done: 0, failed: 0 });
    expect(stats.perDay7d[5]).toEqual({ done: 0, failed: 0 });

    const emptyStats = buildQueueStats(
      makeCfg(),
      { healthBody: null, history: () => [], eligibleWaiting: 0, outbox: emptyOutbox },
      { nowFn: () => NOW },
    );
    expect(emptyStats.perDay7d).toEqual([]);
  });

  it("case 4: dir fallback when history is empty — stat-based done/failed counts, no duration/token/cost data", () => {
    const doneFiles: Record<string, { mtimeMs: number }> = {
      "a.md": { mtimeMs: NOW.getTime() - 3600_000 }, // within 24h
      "b.md": { mtimeMs: NOW.getTime() - 7200_000 }, // within 24h
      "c.md": { mtimeMs: NOW.getTime() - 2 * 86_400_000 }, // older than 24h
    };
    const failedFiles: Record<string, { mtimeMs: number }> = {
      "d.md": { mtimeMs: NOW.getTime() - 1000 }, // within 24h
    };
    const cfg = makeCfg({ queueRoot: "/q" });
    const stats = buildQueueStats(
      cfg,
      { healthBody: null, history: () => [], eligibleWaiting: 0, outbox: emptyOutbox },
      {
        nowFn: () => NOW,
        readdirFn: (dir: string) => {
          if (dir === "/q/done") return Object.keys(doneFiles);
          if (dir === "/q/failed") return Object.keys(failedFiles);
          return [];
        },
        statFn: (p: string) => {
          const name = p.split("/").pop() as string;
          if (name in doneFiles) return doneFiles[name];
          if (name in failedFiles) return failedFiles[name];
          throw new Error("ENOENT");
        },
      },
    );
    expect(stats.window24h).toEqual({
      done: 2,
      failed: 1,
      successRate: 2 / 3,
      avgDurationSeconds: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
    });
    expect(stats.perDay7d).toEqual([]);
  });

  it("case 5: ETA derived from avgDurationSeconds, eligibleWaiting, maxConcurrent", () => {
    const recs = [
      makeRecord({ id: "a", status: "completed", durationSeconds: 60 }),
      makeRecord({ id: "b", status: "completed", durationSeconds: 180 }), // avg 120
    ];
    const withAvg = buildQueueStats(
      makeCfg({ maxConcurrent: 2 }),
      { healthBody: null, history: () => recs, eligibleWaiting: 3, outbox: emptyOutbox },
      { nowFn: () => NOW },
    );
    expect(withAvg.window24h.avgDurationSeconds).toBe(120);
    expect(withAvg.etaSeconds).toBe(180);

    const noAvg = buildQueueStats(
      makeCfg({ maxConcurrent: 2 }),
      { healthBody: null, history: () => [], eligibleWaiting: 3, outbox: emptyOutbox },
      {
        nowFn: () => NOW,
        readdirFn: () => [],
        statFn: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(noAvg.window24h.avgDurationSeconds).toBeNull();
    expect(noAvg.etaSeconds).toBeNull();

    const zeroWaiting = buildQueueStats(
      makeCfg({ maxConcurrent: 2 }),
      { healthBody: null, history: () => recs, eligibleWaiting: 0, outbox: emptyOutbox },
      { nowFn: () => NOW },
    );
    expect(zeroWaiting.etaSeconds).toBe(0);
  });

  it("case 6: healthBody passthrough — gate, lastPollAt, spend, guards, pendingRestartFields", () => {
    const hb = makeHealthBody({
      gate: {
        state: "rate_limited",
        reason: "429",
        since: "2026-07-19T11:00:00Z",
        until: "2026-07-19T13:00:00Z",
      },
      spend: { todayUsd: 1.5, dailyBudgetUsd: 10 },
      metrics: makeMetrics({
        lastPollAt: "2026-07-19T11:59:00Z",
        guardNudges: 2,
        guardKills: 1,
        requeues: 4,
        pendingRestartFields: ["maxConcurrent"],
      }),
    });
    const stats = buildQueueStats(
      makeCfg(),
      { healthBody: hb, history: () => [], eligibleWaiting: 0, outbox: { depth: 5, dead: 1 } },
      {
        nowFn: () => NOW,
        readdirFn: () => [],
        statFn: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(stats.gate).toEqual({
      state: "rate_limited",
      reason: "429",
      until: "2026-07-19T13:00:00Z",
    });
    expect(stats.lastPollAt).toBe("2026-07-19T11:59:00Z");
    expect(stats.spend).toEqual({ todayUsd: 1.5, dailyBudgetUsd: 10 });
    expect(stats.guards).toEqual({ nudges: 2, kills: 1, requeues: 4 });
    expect(stats.pendingRestartFields).toEqual(["maxConcurrent"]);
    expect(stats.outbox).toEqual({ depth: 5, dead: 1 });
  });

  it("case 7: daemon down (healthBody: null) — gate/lastPollAt/spend/guards null, pendingRestartFields empty; window/outbox still populate", () => {
    const recs = [makeRecord({ id: "a", status: "completed", durationSeconds: 60 })];
    const stats = buildQueueStats(
      makeCfg(),
      { healthBody: null, history: () => recs, eligibleWaiting: 1, outbox: { depth: 2, dead: 0 } },
      { nowFn: () => NOW },
    );
    expect(stats.gate).toBeNull();
    expect(stats.lastPollAt).toBeNull();
    expect(stats.spend).toBeNull();
    expect(stats.guards).toBeNull();
    expect(stats.pendingRestartFields).toEqual([]);
    expect(stats.window24h.done).toBe(1);
    expect(stats.outbox).toEqual({ depth: 2, dead: 0 });
  });

  it("case 8: successRate is null when done+failed === 0, in both the ledger and fallback paths", () => {
    const ledgerStats = buildQueueStats(
      makeCfg(),
      { healthBody: null, history: () => [], eligibleWaiting: 0, outbox: emptyOutbox },
      {
        nowFn: () => NOW,
        readdirFn: () => [],
        statFn: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(ledgerStats.window24h.successRate).toBeNull();

    // Records exist but all fall outside the 24h window (so recs24 is empty,
    // AND the fallback dirs are also empty) -> still null, not NaN.
    const older = new Date(NOW.getTime() - 2 * 86_400_000);
    const stats = buildQueueStats(
      makeCfg(),
      {
        healthBody: null,
        history: () => [makeRecord({ id: "old", at: older.toISOString(), status: "completed" })],
        eligibleWaiting: 0,
        outbox: emptyOutbox,
      },
      {
        nowFn: () => NOW,
        readdirFn: () => [],
        statFn: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(stats.window24h.successRate).toBeNull();
  });
});

describe("mixed-source render (#236): empty 24h ledger + populated 7d ledger + dirs", () => {
  it("window24h takes the dir-mtime fallback while perDay7d still buckets the older records", () => {
    // Ledger: two records 2 days old (one done, one failed) — inside the 7d
    // window, OUTSIDE the 24h window, so recs24 is empty and the 24h line
    // must fall back to dir mtimes while the sparkline still populates.
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
    const records = [
      makeRecord({ at: twoDaysAgo, status: "completed" }),
      makeRecord({ at: twoDaysAgo, status: "failed" }),
    ];
    const doneFiles: Record<string, { mtimeMs: number }> = {
      "a.md": { mtimeMs: NOW.getTime() - 3600_000 }, // within 24h
    };
    const failedFiles: Record<string, { mtimeMs: number }> = {
      "b.md": { mtimeMs: NOW.getTime() - 1000 }, // within 24h
      "c.md": { mtimeMs: NOW.getTime() - 3 * 86_400_000 }, // outside 24h
    };
    const stats = buildQueueStats(
      makeCfg({ queueRoot: "/q" } as never),
      { healthBody: null, history: () => records, eligibleWaiting: 0, outbox: emptyOutbox },
      {
        nowFn: () => NOW,
        readdirFn: (dir: string) => {
          if (dir === "/q/done") return Object.keys(doneFiles);
          if (dir === "/q/failed") return Object.keys(failedFiles);
          return [];
        },
        statFn: (p: string) => {
          const name = p.split("/").pop() as string;
          if (name in doneFiles) return doneFiles[name];
          if (name in failedFiles) return failedFiles[name];
          throw new Error("ENOENT");
        },
      },
    );
    // 24h line: fallback counts from dir mtimes (no enrichment fields).
    expect(stats.window24h.done).toBe(1);
    expect(stats.window24h.failed).toBe(1); // only b.md is within 24h
    expect(stats.window24h.avgDurationSeconds).toBeNull();
    expect(stats.window24h.tokensIn).toBeNull();
    // Sparkline: the 2-days-ago bucket comes from the LEDGER records.
    expect(stats.perDay7d).toHaveLength(7);
    expect(stats.perDay7d[4]).toEqual({ done: 1, failed: 1 }); // 2 days ago
    expect(stats.perDay7d[6]).toEqual({ done: 0, failed: 0 }); // today: ledger-empty
  });
});
