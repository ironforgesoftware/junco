// ---------------------------------------------------------------------------
// Run-metrics registry
// ---------------------------------------------------------------------------
// Shared in-memory state updated by the daemon loop and read by the health
// HTTP server (M5-T2). Synchronous; depends only on types.ts.
// ---------------------------------------------------------------------------

import { TERMINAL_DONE_STATUSES } from "./types.js";
import type { FlushResult } from "./githubOutbox.js";

export interface MetricsSnapshot {
  startedAt: string | null; // ISO; null until markStarted()
  uptimeSeconds: number; // 0 if not started
  pid: number; // process.pid
  pollCount: number;
  lastPollAt: string | null; // ISO of the most recent recordPoll()
  currentTicket: string | null; // first in-flight ticket, or null when idle (back-compat)
  currentTickets: string[]; // every in-flight ticket (max_concurrent may be > 1)
  tasksProcessed: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksByStatus: Record<string, number>; // e.g. { completed: 3, failed: 1, timeout: 1 }
  totalTokensIn: number;
  totalTokensOut: number;
  totalDurationMs: number;
  lastTaskAt: string | null; // ISO of the most recent recordTask()
  lastTaskStatus: string | null;
  // GitHub bridge (issues → inbox): sweep counters, 0/null when disabled.
  bridgeSweeps: number;
  lastBridgeSweepAt: string | null;
  ticketsBridged: number;
  bridgeErrors: number;
  // GitHub outbox (store-and-forward side effects): outboxDepth is a GAUGE
  // (the queue length as of the last flush, not accumulated); the rest are
  // running counters. 0/null until the first sweep flush.
  outboxDepth: number;
  outboxEnqueued: number;
  outboxFlushed: number;
  outboxDead: number;
  lastFlushAt: string | null;
  // Requeue + loop-guard observability (issue #37). `requeues` counts every
  // transient/crash requeue-to-inbox (recordTask never fires on that path, so
  // a ticket that fails-and-retries N times was previously invisible).
  // `guardNudges`/`guardKills` count supervisor decisions realized mid-run.
  requeues: number;
  guardNudges: number;
  guardKills: number;
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
}

export class RunMetrics {
  private _now: () => Date;

  private _startedAt: Date | null = null;
  private _pollCount = 0;
  private _lastPollAt: Date | null = null;
  private _current: string[] = [];
  private _tasksProcessed = 0;
  private _tasksSucceeded = 0;
  private _tasksFailed = 0;
  private _tasksByStatus: Record<string, number> = {};
  private _totalTokensIn = 0;
  private _totalTokensOut = 0;
  private _totalDurationMs = 0;
  private _lastTaskAt: Date | null = null;
  private _lastTaskStatus: string | null = null;
  private _bridgeSweeps = 0;
  private _ticketsBridged = 0;
  private _bridgeErrors = 0;
  private _lastBridgeSweepAt: Date | null = null;
  private _outboxDepth = 0;
  private _outboxEnqueued = 0;
  private _outboxFlushed = 0;
  private _outboxDead = 0;
  private _lastFlushAt: Date | null = null;
  private _requeues = 0;
  private _guardNudges = 0;
  private _guardKills = 0;
  private _progress: Record<
    string,
    {
      turns: number;
      lastTool: string | null;
      outputTokens: number;
      startedAt: string;
      updatedAt: string;
    }
  > = {};

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

  /** A bridge sweep completed; `bridged` = tickets materialized this sweep. */
  recordBridgeSweep(bridged: number): void {
    this._bridgeSweeps++;
    this._ticketsBridged += bridged;
    this._lastBridgeSweepAt = this._now();
  }

  /** A bridge sweep failed (queue unaffected). */
  recordBridgeError(): void {
    this._bridgeErrors++;
  }

  /** An op was parked in the outbox (offline fallback). NOT wired into
   * tryOrEnqueue — that seam runs in the dashboard process too, and this
   * singleton is daemon-process-only. Depth (recordOutboxFlush, sweep-
   * computed) is the authoritative gauge either way; this counter is
   * available for a daemon-side caller (e.g. the reporter path) that wants a
   * cumulative enqueue count, if one is wired up later. */
  recordOutboxEnqueue(): void {
    this._outboxEnqueued++;
  }

  /** A sweep's outbox flush completed. `sent`/`dead` accumulate across
   * flushes; `depth` overwrites (it's a gauge — the queue length as of THIS
   * flush, sweep-computed via outboxDepth(cfg)). */
  recordOutboxFlush(r: FlushResult, depth: number): void {
    this._outboxFlushed += r.sent;
    this._outboxDead += r.dead;
    this._outboxDepth = depth;
    this._lastFlushAt = this._now();
  }

  /** A ticket was requeued to inbox for another attempt (transient failure or
   * crash containment). Counts every attempt, not distinct tickets. */
  recordRequeue(): void {
    this._requeues++;
  }

  /** A loop-guard supervisor decision was realized mid-run: a "nudge" injected
   * a steering prompt (the agent may still recover) or a "kill" soft-aborted
   * the run. Both were previously invisible outside the transcript. */
  recordGuardDecision(action: "nudge" | "kill"): void {
    if (action === "nudge") this._guardNudges++;
    else this._guardKills++;
  }

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

  /** A task left execution (however it ended). Clears its progress too. */
  taskEnded(id: string): void {
    this._current = this._current.filter((x) => x !== id);
    this.clearTaskProgress(id);
  }

  /** Legacy single-ticket setter (pre-concurrency API; kept for embedders).
   * Equivalent to taskStarted(id) / clearing everything on null. */
  setCurrentTicket(id: string | null): void {
    this._current = id === null ? [] : [id];
  }

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

  /** Drop a ticket's progress (always called when the ticket ends). */
  clearTaskProgress(id: string): void {
    delete this._progress[id];
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
      currentTicket: this._current[0] ?? null,
      currentTickets: [...this._current],
      tasksProcessed: this._tasksProcessed,
      tasksSucceeded: this._tasksSucceeded,
      tasksFailed: this._tasksFailed,
      tasksByStatus: { ...this._tasksByStatus }, // deep-copy (values are numbers)
      totalTokensIn: this._totalTokensIn,
      totalTokensOut: this._totalTokensOut,
      totalDurationMs: this._totalDurationMs,
      lastTaskAt: this._lastTaskAt ? this._lastTaskAt.toISOString() : null,
      lastTaskStatus: this._lastTaskStatus,
      bridgeSweeps: this._bridgeSweeps,
      lastBridgeSweepAt: this._lastBridgeSweepAt ? this._lastBridgeSweepAt.toISOString() : null,
      ticketsBridged: this._ticketsBridged,
      bridgeErrors: this._bridgeErrors,
      outboxDepth: this._outboxDepth,
      outboxEnqueued: this._outboxEnqueued,
      outboxFlushed: this._outboxFlushed,
      outboxDead: this._outboxDead,
      lastFlushAt: this._lastFlushAt ? this._lastFlushAt.toISOString() : null,
      requeues: this._requeues,
      guardNudges: this._guardNudges,
      guardKills: this._guardKills,
      currentProgress: { ...this._progress },
    };
  }

  /** Restore every field to initial state (used by tests). */
  reset(): void {
    this._startedAt = null;
    this._pollCount = 0;
    this._lastPollAt = null;
    this._current = [];
    this._tasksProcessed = 0;
    this._tasksSucceeded = 0;
    this._tasksFailed = 0;
    this._tasksByStatus = {};
    this._totalTokensIn = 0;
    this._totalTokensOut = 0;
    this._totalDurationMs = 0;
    this._lastTaskAt = null;
    this._lastTaskStatus = null;
    this._bridgeSweeps = 0;
    this._ticketsBridged = 0;
    this._bridgeErrors = 0;
    this._lastBridgeSweepAt = null;
    this._outboxDepth = 0;
    this._outboxEnqueued = 0;
    this._outboxFlushed = 0;
    this._outboxDead = 0;
    this._lastFlushAt = null;
    this._requeues = 0;
    this._guardNudges = 0;
    this._guardKills = 0;
    this._progress = {};
  }
}

/** Process-wide singleton — the daemon loop and health server share this. */
export const metrics = new RunMetrics();
