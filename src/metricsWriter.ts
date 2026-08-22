/**
 * Debounced, atomic writer for metrics.json — an OUT-OF-PROCESS view of
 * daemon state. `metrics.json` is declared in both data-tree layouts
 * (dataTree.ts), denied to the agent sandbox, has a migration pair, and is
 * already stat'd by `junco data` — but nothing has ever written it. This is
 * that writer.
 *
 * Nothing IN-PROCESS reads this file: the health server (healthServer.ts)
 * serves the live `metrics` singleton's snapshot() straight from memory.
 * This file exists purely for external visibility — `junco data`, an ad-hoc
 * `cat`, a future cold read of the data tree.
 *
 * Debounced because the two hottest producers of a MetricsSnapshot fire far
 * faster than any external reader needs a fresh file: setTaskProgress() once
 * per agent turn, recordPoll() once per poll tick. Writing on every mutation
 * would be several writes a second during an active ticket, for a file
 * nothing in-process depends on. `write()` persists at most once per
 * METRICS_WRITE_INTERVAL_MS; `flush()` (startup stamp, shutdown) always
 * writes, ignoring the debounce window.
 *
 * Same atomic-write discipline as the spend ledger (spendLedger.ts) and the
 * watchlist (watchlist.ts): mkdir -p, sibling `.tmp`, rename onto the real
 * path — a reader never observes a partial file. Unlike spendLedger, this
 * module is write-only: nothing here ever reads metrics.json back, so there
 * is no read path and no `readFileFn` seam.
 *
 * Failures are swallowed, never thrown: this is observability, and a full
 * disk or a read-only mount must not take the daemon down over a file
 * nothing critical depends on (same stance as ensureSkillLinks).
 *
 * Staleness: the snapshot carries `pid` and `startedAt`. This file is a
 * point-in-time copy, up to METRICS_WRITE_INTERVAL_MS behind the live
 * in-memory state, and the process that wrote it may since have exited. A
 * reader must NOT treat the file as live — it should check that `pid` is
 * still a running process (e.g. `kill(pid, 0)`) before trusting the numbers
 * as current; a dead pid means this is a stale leftover from the daemon's
 * last run, not its present state.
 */

import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logging.js";
import type { MetricsSnapshot } from "./metrics.js";

/** Far slower than the per-turn/per-tick producers, far faster than a human
 * or `junco data` refreshing. A module constant, not a Config field — this
 * is an internal debounce cadence, not an operator-facing knob. */
const METRICS_WRITE_INTERVAL_MS = 10_000;

/** Monotonic milliseconds — the same source (and spelling) every other daemon
 * debounce uses (`monoMs` in daemon.ts, `sleepInterruptible`). Deliberately
 * NOT `Date.now()`: a backwards wall-clock step (NTP correction, DST on a
 * localtime-keyed clock) makes `t - lastWriteAt` negative, which is `<` the
 * interval, so every debounced write would be suppressed for the duration of
 * the step. The value has no epoch meaning — only differences are used. */
const monoMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

export interface MetricsWriterDeps {
  /** Monotonic ms source for the debounce window (default: `monoMs`). Only
   * differences between successive calls are ever read, never an absolute
   * time — a test clock can start anywhere. */
  now?: () => number;
  writeFileFn?: typeof writeFileSync;
  renameFn?: typeof renameSync;
  mkdirFn?: typeof mkdirSync;
}

export interface MetricsWriter {
  /** Persist `snap`, but at most once per METRICS_WRITE_INTERVAL_MS. A call
   * inside the debounce window is silently dropped — there is no queueing of
   * skipped snapshots, since the next call after the window passes will
   * carry a fresher one anyway (metrics.json only ever needs "recent
   * enough", not "every value that ever passed through"). */
  write(snap: MetricsSnapshot): void;
  /** Persist `snap` unconditionally, ignoring the debounce window. For the
   * startup stamp and shutdown, where the caller wants the write to land
   * now, not on the next debounce tick. */
  flush(snap: MetricsSnapshot): void;
}

export function makeMetricsWriter(file: string, deps: MetricsWriterDeps = {}): MetricsWriter {
  const now = deps.now ?? monoMs;
  const writeFileFn = deps.writeFileFn ?? writeFileSync;
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? mkdirSync;

  let lastWriteAt: number | null = null;

  /** Atomic write: mkdir -p, sibling tmp, rename (watchlist.ts:72-77). Never
   * throws — a failure here is observability-only and must not propagate
   * into the daemon loop (full disk, read-only mount, etc). `lastWriteAt` is
   * stamped up front, success or failure, so a persistently broken
   * filesystem is retried at the normal debounce cadence rather than
   * hammered on every producer tick. */
  function persist(snap: MetricsSnapshot): void {
    lastWriteAt = now();
    try {
      mkdirFn(dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      writeFileFn(tmp, JSON.stringify(snap, null, 2) + "\n", "utf8");
      renameFn(tmp, file);
    } catch (e) {
      log.warn("metricsWriter: failed to persist metrics.json", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    write(snap: MetricsSnapshot): void {
      const t = now();
      if (lastWriteAt !== null && t - lastWriteAt < METRICS_WRITE_INTERVAL_MS) return;
      persist(snap);
    },
    flush(snap: MetricsSnapshot): void {
      persist(snap);
    },
  };
}
