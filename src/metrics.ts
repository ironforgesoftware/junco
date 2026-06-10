// ---------------------------------------------------------------------------
// Run-metrics registry
// ---------------------------------------------------------------------------
// Shared in-memory state updated by the daemon loop and read by the health
// HTTP server (M5-T2). Synchronous; depends only on types.ts.
// ---------------------------------------------------------------------------

import { TERMINAL_DONE_STATUSES } from "./types.js";

export interface MetricsSnapshot {
  startedAt: string | null; // ISO; null until markStarted()
  uptimeSeconds: number; // 0 if not started
  pid: number; // process.pid
  pollCount: number;
  lastPollAt: string | null; // ISO of the most recent recordPoll()
  currentTicket: string | null; // the ticket being processed, or null when idle
  tasksProcessed: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksByStatus: Record<string, number>; // e.g. { completed: 3, failed: 1, timeout: 1 }
  totalTokensIn: number;
  totalTokensOut: number;
  totalDurationMs: number;
  lastTaskAt: string | null; // ISO of the most recent recordTask()
  lastTaskStatus: string | null;
}

export class RunMetrics {
  private _now: () => Date;

  private _startedAt: Date | null = null;
  private _pollCount = 0;
  private _lastPollAt: Date | null = null;
  private _currentTicket: string | null = null;
  private _tasksProcessed = 0;
  private _tasksSucceeded = 0;
  private _tasksFailed = 0;
  private _tasksByStatus: Record<string, number> = {};
  private _totalTokensIn = 0;
  private _totalTokensOut = 0;
  private _totalDurationMs = 0;
  private _lastTaskAt: Date | null = null;
  private _lastTaskStatus: string | null = null;

  constructor(now: () => Date = () => new Date()) {
    this._now = now;
  }

  /** Set startedAt to now. Idempotent — first call wins. */
  markStarted(): void {
    if (this._startedAt === null) {
      this._startedAt = this._now();
    }
  }

  /** Increment pollCount and record the timestamp. */
  recordPoll(): void {
    this._pollCount++;
    this._lastPollAt = this._now();
  }

  /** Set or clear the currently-processing ticket id. */
  setCurrentTicket(id: string | null): void {
    this._currentTicket = id;
  }

  /**
   * Record a completed task.
   *
   * @param status  Terminal status string (e.g. "completed", "failed", "timeout")
   * @param usage   Token usage — only input and output are summed here
   * @param durationMs  Wall-clock duration for the task
   */
  recordTask(status: string, usage: { input: number; output: number }, durationMs: number): void {
    this._tasksProcessed++;

    // Bucket by status
    this._tasksByStatus[status] = (this._tasksByStatus[status] ?? 0) + 1;

    // Classify success / failure against the done-routed set
    if (TERMINAL_DONE_STATUSES.has(status)) {
      this._tasksSucceeded++;
    } else {
      this._tasksFailed++;
    }

    this._totalTokensIn += usage.input;
    this._totalTokensOut += usage.output;
    this._totalDurationMs += durationMs;

    this._lastTaskAt = this._now();
    this._lastTaskStatus = status;
  }

  /** Return a fresh plain-object snapshot (internal references do not leak). */
  snapshot(): MetricsSnapshot {
    const now = this._now();
    const uptimeSeconds =
      this._startedAt !== null ? Math.floor((now.getTime() - this._startedAt.getTime()) / 1000) : 0;

    return {
      startedAt: this._startedAt ? this._startedAt.toISOString() : null,
      uptimeSeconds,
      pid: process.pid,
      pollCount: this._pollCount,
      lastPollAt: this._lastPollAt ? this._lastPollAt.toISOString() : null,
      currentTicket: this._currentTicket,
      tasksProcessed: this._tasksProcessed,
      tasksSucceeded: this._tasksSucceeded,
      tasksFailed: this._tasksFailed,
      tasksByStatus: { ...this._tasksByStatus }, // deep-copy (values are numbers)
      totalTokensIn: this._totalTokensIn,
      totalTokensOut: this._totalTokensOut,
      totalDurationMs: this._totalDurationMs,
      lastTaskAt: this._lastTaskAt ? this._lastTaskAt.toISOString() : null,
      lastTaskStatus: this._lastTaskStatus,
    };
  }

  /** Restore every field to initial state (used by tests). */
  reset(): void {
    this._startedAt = null;
    this._pollCount = 0;
    this._lastPollAt = null;
    this._currentTicket = null;
    this._tasksProcessed = 0;
    this._tasksSucceeded = 0;
    this._tasksFailed = 0;
    this._tasksByStatus = {};
    this._totalTokensIn = 0;
    this._totalTokensOut = 0;
    this._totalDurationMs = 0;
    this._lastTaskAt = null;
    this._lastTaskStatus = null;
  }
}

/** Process-wide singleton — the daemon loop and health server share this. */
export const metrics = new RunMetrics();
