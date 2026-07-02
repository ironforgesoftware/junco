import { describe, it, expect, beforeEach } from "vitest";
import { RunMetrics } from "../src/metrics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeClock(startMs: number): { nowMs: { value: number }; clock: () => Date } {
  const nowMs = { value: startMs };
  return { nowMs, clock: () => new Date(nowMs.value) };
}

const BASE_MS = 1_700_000_000_000; // arbitrary fixed point

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RunMetrics", () => {
  let nowMs: { value: number };
  let clock: () => Date;
  let m: RunMetrics;

  beforeEach(() => {
    ({ nowMs, clock } = makeClock(BASE_MS));
    m = new RunMetrics(clock);
  });

  // -------------------------------------------------------------------------
  // initial snapshot
  // -------------------------------------------------------------------------
  describe("initial snapshot", () => {
    it("has null startedAt and zero uptimeSeconds", () => {
      const s = m.snapshot();
      expect(s.startedAt).toBeNull();
      expect(s.uptimeSeconds).toBe(0);
    });

    it("has process.pid", () => {
      expect(m.snapshot().pid).toBe(process.pid);
    });

    it("has all counts zero and empty maps", () => {
      const s = m.snapshot();
      expect(s.pollCount).toBe(0);
      expect(s.lastPollAt).toBeNull();
      expect(s.currentTicket).toBeNull();
      expect(s.tasksProcessed).toBe(0);
      expect(s.tasksSucceeded).toBe(0);
      expect(s.tasksFailed).toBe(0);
      expect(s.tasksByStatus).toEqual({});
      expect(s.totalTokensIn).toBe(0);
      expect(s.totalTokensOut).toBe(0);
      expect(s.totalDurationMs).toBe(0);
      expect(s.lastTaskAt).toBeNull();
      expect(s.lastTaskStatus).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // markStarted — idempotent
  // -------------------------------------------------------------------------
  describe("markStarted", () => {
    it("sets startedAt on first call", () => {
      m.markStarted();
      const s = m.snapshot();
      expect(s.startedAt).toBe(new Date(BASE_MS).toISOString());
    });

    it("is idempotent: second call does not reset startedAt", () => {
      m.markStarted(); // t0
      const firstStartedAt = m.snapshot().startedAt;

      nowMs.value += 5_000; // advance 5 s
      m.markStarted(); // must NOT overwrite

      const s = m.snapshot();
      expect(s.startedAt).toBe(firstStartedAt);
    });

    it("uptimeSeconds reflects elapsed time after markStarted", () => {
      m.markStarted();
      nowMs.value += 5_000; // advance 5 s
      m.markStarted(); // idempotent call
      expect(m.snapshot().uptimeSeconds).toBe(5);
    });

    it("uptimeSeconds is 0 when not started", () => {
      nowMs.value += 10_000;
      expect(m.snapshot().uptimeSeconds).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // recordPoll
  // -------------------------------------------------------------------------
  describe("recordPoll", () => {
    it("increments pollCount on each call", () => {
      m.recordPoll();
      expect(m.snapshot().pollCount).toBe(1);
      m.recordPoll();
      expect(m.snapshot().pollCount).toBe(2);
    });

    it("lastPollAt reflects the most recent call timestamp", () => {
      m.recordPoll(); // t0
      const first = m.snapshot().lastPollAt;

      nowMs.value += 3_000;
      m.recordPoll(); // t0 + 3 s

      const s = m.snapshot();
      expect(s.pollCount).toBe(2);
      expect(s.lastPollAt).toBe(new Date(BASE_MS + 3_000).toISOString());
      expect(s.lastPollAt).not.toBe(first);
    });
  });

  // -------------------------------------------------------------------------
  // setCurrentTicket
  // -------------------------------------------------------------------------
  describe("setCurrentTicket", () => {
    it("sets the current ticket id", () => {
      m.setCurrentTicket("task-a");
      expect(m.snapshot().currentTicket).toBe("task-a");
    });

    it("clears the current ticket when set to null", () => {
      m.setCurrentTicket("task-a");
      m.setCurrentTicket(null);
      expect(m.snapshot().currentTicket).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // recordTask — success path
  // -------------------------------------------------------------------------
  describe("recordTask success", () => {
    it("records a completed task correctly", () => {
      m.recordTask("completed", { input: 100, output: 200 }, 1500);
      const s = m.snapshot();
      expect(s.tasksProcessed).toBe(1);
      expect(s.tasksSucceeded).toBe(1);
      expect(s.tasksFailed).toBe(0);
      expect(s.tasksByStatus).toEqual({ completed: 1 });
      expect(s.totalTokensIn).toBe(100);
      expect(s.totalTokensOut).toBe(200);
      expect(s.totalDurationMs).toBe(1500);
      expect(s.lastTaskStatus).toBe("completed");
      expect(s.lastTaskAt).toBe(new Date(BASE_MS).toISOString());
    });
  });

  // -------------------------------------------------------------------------
  // recordTask — failure classification
  // -------------------------------------------------------------------------
  describe("recordTask failure classification", () => {
    it("classifies done-routed statuses as success", () => {
      for (const status of ["completed", "completed_no_changes", "aborted_partial"]) {
        const fresh = new RunMetrics(clock);
        fresh.recordTask(status, { input: 1, output: 1 }, 100);
        const s = fresh.snapshot();
        expect(s.tasksSucceeded).toBe(1);
        expect(s.tasksFailed).toBe(0);
      }
    });

    it("classifies failed/timeout/aborted_no_changes as failure", () => {
      for (const status of ["failed", "timeout", "aborted_no_changes"]) {
        const fresh = new RunMetrics(clock);
        fresh.recordTask(status, { input: 1, output: 1 }, 100);
        const s = fresh.snapshot();
        expect(s.tasksSucceeded).toBe(0);
        expect(s.tasksFailed).toBe(1);
      }
    });

    it("mixed calls: timeout and aborted_no_changes → tasksFailed 2", () => {
      m.recordTask("timeout", { input: 10, output: 20 }, 500);
      m.recordTask("aborted_no_changes", { input: 10, output: 20 }, 500);
      expect(m.snapshot().tasksFailed).toBe(2);
      expect(m.snapshot().tasksSucceeded).toBe(0);
    });

    it("aborted_partial counts as success (done-routed)", () => {
      m.recordTask("timeout", { input: 10, output: 20 }, 500);
      m.recordTask("aborted_no_changes", { input: 10, output: 20 }, 500);
      m.recordTask("aborted_partial", { input: 10, output: 20 }, 500);
      const s = m.snapshot();
      expect(s.tasksFailed).toBe(2);
      expect(s.tasksSucceeded).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // recordTask — accumulation
  // -------------------------------------------------------------------------
  describe("accumulation", () => {
    it("accumulates tokens and duration across multiple recordTask calls", () => {
      m.recordTask("completed", { input: 100, output: 200 }, 1000);
      nowMs.value += 1_000;
      m.recordTask("failed", { input: 50, output: 75 }, 500);
      const s = m.snapshot();
      expect(s.tasksProcessed).toBe(2);
      expect(s.totalTokensIn).toBe(150);
      expect(s.totalTokensOut).toBe(275);
      expect(s.totalDurationMs).toBe(1500);
    });

    it("accumulates tasksByStatus buckets correctly", () => {
      m.recordTask("completed", { input: 1, output: 1 }, 100);
      m.recordTask("completed", { input: 1, output: 1 }, 100);
      m.recordTask("failed", { input: 1, output: 1 }, 100);
      m.recordTask("timeout", { input: 1, output: 1 }, 100);
      expect(m.snapshot().tasksByStatus).toEqual({ completed: 2, failed: 1, timeout: 1 });
    });

    it("lastTaskAt reflects the most recent recordTask call", () => {
      m.recordTask("completed", { input: 1, output: 1 }, 100);
      nowMs.value += 2_000;
      m.recordTask("failed", { input: 1, output: 1 }, 100);
      expect(m.snapshot().lastTaskAt).toBe(new Date(BASE_MS + 2_000).toISOString());
      expect(m.snapshot().lastTaskStatus).toBe("failed");
    });
  });

  // -------------------------------------------------------------------------
  // snapshot isolation (deep copy)
  // -------------------------------------------------------------------------
  describe("snapshot isolation", () => {
    it("mutating returned tasksByStatus does not affect subsequent snapshots", () => {
      m.recordTask("completed", { input: 1, output: 1 }, 100);
      const s1 = m.snapshot();
      s1.tasksByStatus["completed"] = 999; // mutate returned copy
      s1.tasksByStatus["injected"] = 42;
      const s2 = m.snapshot();
      expect(s2.tasksByStatus).toEqual({ completed: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------
  describe("reset", () => {
    it("restores initial state after recording activity", () => {
      m.markStarted();
      m.recordPoll();
      m.setCurrentTicket("task-x");
      m.recordTask("completed", { input: 100, output: 200 }, 1500);
      m.reset();
      const s = m.snapshot();
      expect(s.startedAt).toBeNull();
      expect(s.uptimeSeconds).toBe(0);
      expect(s.pollCount).toBe(0);
      expect(s.lastPollAt).toBeNull();
      expect(s.currentTicket).toBeNull();
      expect(s.tasksProcessed).toBe(0);
      expect(s.tasksSucceeded).toBe(0);
      expect(s.tasksFailed).toBe(0);
      expect(s.tasksByStatus).toEqual({});
      expect(s.totalTokensIn).toBe(0);
      expect(s.totalTokensOut).toBe(0);
      expect(s.totalDurationMs).toBe(0);
      expect(s.lastTaskAt).toBeNull();
      expect(s.lastTaskStatus).toBeNull();
    });
  });
});

describe("task progress", () => {
  it("is exposed in the snapshot and cleared with the task", () => {
    const m = new RunMetrics();
    m.setTaskProgress("t-1", { turns: 3, lastTool: "bash", outputTokens: 120 });
    const snap = m.snapshot();
    expect(snap.currentProgress["t-1"].turns).toBe(3);
    expect(snap.currentProgress["t-1"].lastTool).toBe("bash");
    expect(typeof snap.currentProgress["t-1"].updatedAt).toBe("string");
    m.clearTaskProgress("t-1");
    expect(m.snapshot().currentProgress["t-1"]).toBeUndefined();
  });

  it("reset() clears progress too", () => {
    const m = new RunMetrics();
    m.setTaskProgress("t-1", { turns: 1, lastTool: null, outputTokens: 0 });
    m.reset();
    expect(m.snapshot().currentProgress).toEqual({});
  });
});

describe("multi-ticket tracking (max_concurrent > 1)", () => {
  it("tracks several in-flight tickets; currentTicket stays first-or-null for back-compat", () => {
    const m = new RunMetrics();
    m.taskStarted("a");
    m.taskStarted("b");
    expect(m.snapshot().currentTickets).toEqual(["a", "b"]);
    expect(m.snapshot().currentTicket).toBe("a");
    m.taskEnded("a");
    expect(m.snapshot().currentTickets).toEqual(["b"]);
    expect(m.snapshot().currentTicket).toBe("b");
    m.taskEnded("b");
    expect(m.snapshot().currentTicket).toBeNull();
    expect(m.snapshot().currentTickets).toEqual([]);
  });

  it("taskEnded clears that ticket's progress", () => {
    const m = new RunMetrics();
    m.taskStarted("a");
    m.setTaskProgress("a", { turns: 1, lastTool: "bash", outputTokens: 10 });
    m.taskEnded("a");
    expect(m.snapshot().currentProgress).toEqual({});
  });
});

describe("bridge metrics", () => {
  it("records sweeps, bridged counts, and errors", () => {
    const m = new RunMetrics(() => new Date("2026-07-02T00:00:00Z"));
    m.recordBridgeSweep(2);
    m.recordBridgeSweep(0);
    m.recordBridgeError();
    const s = m.snapshot();
    expect(s.bridgeSweeps).toBe(2);
    expect(s.ticketsBridged).toBe(2);
    expect(s.bridgeErrors).toBe(1);
    expect(s.lastBridgeSweepAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("reset clears bridge fields", () => {
    const m = new RunMetrics();
    m.recordBridgeSweep(1);
    m.recordBridgeError();
    m.reset();
    const s = m.snapshot();
    expect(s.bridgeSweeps).toBe(0);
    expect(s.ticketsBridged).toBe(0);
    expect(s.bridgeErrors).toBe(0);
    expect(s.lastBridgeSweepAt).toBeNull();
  });
});
