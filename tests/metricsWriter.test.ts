/**
 * Tests for src/metricsWriter.ts — debounced, atomic writer for metrics.json.
 * Written FIRST (TDD). Pure: fs and clock are injected, no real filesystem.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { dirname } from "node:path";
import { makeMetricsWriter } from "../src/metricsWriter.js";
import type { MetricsSnapshot } from "../src/metrics.js";
import { log } from "../src/logging.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    startedAt: "2026-05-31T00:00:00.000Z",
    uptimeSeconds: 42,
    pid: 12345,
    pollCount: 7,
    lastPollAt: "2026-05-31T00:00:30.000Z",
    currentTicket: null,
    currentTickets: [],
    tasksProcessed: 5,
    tasksSucceeded: 4,
    tasksFailed: 1,
    tasksByStatus: { completed: 4, failed: 1 },
    totalTokensIn: 1000,
    totalTokensOut: 2000,
    totalDurationMs: 30000,
    totalCostUsd: 0,
    lastTaskAt: "2026-05-31T00:00:28.000Z",
    lastTaskStatus: "completed",
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

const FILE = "/state/data/metrics.json";

/** Fresh set of fs spies for one writer instance. */
function makeFsSpies() {
  return {
    writeFileFn: vi.fn(),
    renameFn: vi.fn(),
    mkdirFn: vi.fn(),
  };
}

describe("makeMetricsWriter", () => {
  it("flush writes the snapshot atomically: tmp then rename", () => {
    const fs = makeFsSpies();
    const writer = makeMetricsWriter(FILE, { ...fs, now: () => 0 });
    const snap = makeSnapshot();

    writer.flush(snap);

    expect(fs.writeFileFn).toHaveBeenCalledTimes(1);
    expect(fs.writeFileFn.mock.calls[0]?.[0]).toBe(FILE + ".tmp");
    expect(fs.renameFn).toHaveBeenCalledTimes(1);
    expect(fs.renameFn).toHaveBeenCalledWith(FILE + ".tmp", FILE);
  });

  it("flush mkdir -p's the parent first", () => {
    const fs = makeFsSpies();
    const writer = makeMetricsWriter(FILE, { ...fs, now: () => 0 });

    writer.flush(makeSnapshot());

    expect(fs.mkdirFn).toHaveBeenCalledWith(dirname(FILE), { recursive: true });
  });

  it("write persists the first call immediately", () => {
    const fs = makeFsSpies();
    const writer = makeMetricsWriter(FILE, { ...fs, now: () => 0 });

    writer.write(makeSnapshot());

    expect(fs.writeFileFn).toHaveBeenCalledTimes(1);
    expect(fs.renameFn).toHaveBeenCalledTimes(1);
  });

  it("write skips a second call inside the debounce window", () => {
    const fs = makeFsSpies();
    let t = 0;
    const writer = makeMetricsWriter(FILE, { ...fs, now: () => t });

    writer.write(makeSnapshot());
    t += 1000; // well inside the ~10s window
    writer.write(makeSnapshot());

    expect(fs.writeFileFn).toHaveBeenCalledTimes(1);
    expect(fs.renameFn).toHaveBeenCalledTimes(1);
  });

  it("write persists again once the window has passed", () => {
    const fs = makeFsSpies();
    let t = 0;
    const writer = makeMetricsWriter(FILE, { ...fs, now: () => t });

    writer.write(makeSnapshot());
    t += 20_000; // past the ~10s window
    writer.write(makeSnapshot());

    expect(fs.writeFileFn).toHaveBeenCalledTimes(2);
    expect(fs.renameFn).toHaveBeenCalledTimes(2);
  });

  it("flush always writes, even inside the debounce window", () => {
    const fs = makeFsSpies();
    let t = 0;
    const writer = makeMetricsWriter(FILE, { ...fs, now: () => t });

    writer.write(makeSnapshot());
    t += 1000; // well inside the window
    writer.flush(makeSnapshot());

    expect(fs.writeFileFn).toHaveBeenCalledTimes(2);
    expect(fs.renameFn).toHaveBeenCalledTimes(2);
  });

  it("a write failure never throws", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const writer = makeMetricsWriter(FILE, {
      now: () => 0,
      writeFileFn: () => {
        throw new Error("boom: disk full");
      },
      renameFn: vi.fn(),
      mkdirFn: vi.fn(),
    });

    expect(() => writer.write(makeSnapshot())).not.toThrow();
    expect(() => writer.flush(makeSnapshot())).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("a mkdir failure never throws either", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const writer = makeMetricsWriter(FILE, {
      now: () => 0,
      writeFileFn: vi.fn(),
      renameFn: vi.fn(),
      mkdirFn: () => {
        throw new Error("boom: read-only mount");
      },
    });

    expect(() => writer.flush(makeSnapshot())).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("serializes the snapshot as pretty JSON with a trailing newline", () => {
    const fs = makeFsSpies();
    const writer = makeMetricsWriter(FILE, { ...fs, now: () => 0 });
    const snap = makeSnapshot();

    writer.flush(snap);

    const written = fs.writeFileFn.mock.calls[0]?.[1] as string;
    expect(written).toBe(JSON.stringify(snap, null, 2) + "\n");
    expect(written.endsWith("\n")).toBe(true);
  });
});
