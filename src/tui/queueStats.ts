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
    // Calendar-field arithmetic (spendLedger.ts nextMidnightMs() precedent),
    // NOT raw `now.getTime() - i * DAY_MS`: a fixed 24h step across a DST
    // transition lands on a 23h/25h local day, so the naive walk skips
    // (spring-forward) or double-counts (fall-back) a calendar-day key. The
    // Date constructor normalizes out-of-range day-of-month values, so
    // subtracting from `getDate()` correctly rolls across month/year
    // boundaries too.
    for (let i = 6; i >= 0; i--) {
      keys.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    }
    const byDay = new Map(keys.map((k) => [k, { done: 0, failed: 0 }]));
    for (const r of recs7d) {
      const b = byDay.get(dayKey(new Date(r.at)));
      if (b) {
        if (isDone(r.status)) {
          b.done++;
        } else {
          b.failed++;
        }
      }
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
