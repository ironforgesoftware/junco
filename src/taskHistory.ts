/**
 * Per-task finalize ledger — append-only JSONL under <dataDir>/history/,
 * sharded by UTC month of the record's `at` (`tasks-YYYY-MM.jsonl`). Written
 * at runOnce's finalized points beside metrics.recordTask; read by the queue
 * stats layer and `junco status`. Writer never throws (a failed history
 * append must not fail a finalize); reader skips corrupt lines (reviewStore
 * read discipline) and memoizes per shard on mtimeMs.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { HISTORY_SUBDIR } from "./dataTree.js";
import { log } from "./logging.js";

export interface TaskRecord {
  v: 1;
  at: string; // ISO — when the task finalized
  id: string;
  kind: "pr" | "ask" | "plan" | "assess" | "analyze";
  status: string; // terminal status (finalize.ts statusFor / computePrStatus)
  durationSeconds: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  nwo?: string;
  issue?: number;
  prUrl?: string;
  retryCount: number;
}

export interface TaskHistoryDeps {
  mkdirFn?: (d: string, opts: { recursive: true }) => void;
  appendFn?: (p: string, s: string, enc: "utf8") => void;
  readFileFn?: (p: string) => string;
  statFn?: (p: string) => { mtimeMs: number };
  nowFn?: () => Date;
}

export function historyDir(cfg: Config): string {
  return join(cfg.dataDir, HISTORY_SUBDIR);
}

/** Shard basename for a record stamp: UTC month straight off the ISO string. */
function shardName(atIso: string): string {
  return `tasks-${atIso.slice(0, 7)}.jsonl`;
}

export function appendTaskRecord(cfg: Config, rec: TaskRecord, deps: TaskHistoryDeps = {}): void {
  const mkdirFn = deps.mkdirFn ?? mkdirSync;
  const appendFn = deps.appendFn ?? appendFileSync;
  try {
    const dir = historyDir(cfg);
    mkdirFn(dir, { recursive: true });
    // One appendFileSync of one line: O_APPEND keeps concurrent finalizes
    // (max_concurrent > 1) from interleaving records.
    appendFn(join(dir, shardName(rec.at)), JSON.stringify(rec) + "\n", "utf8");
  } catch (e) {
    log.warn("taskHistory: append failed", {
      id: rec.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** UTC months ("YYYY-MM") overlapping [since, now], oldest first. Bounded at
 * 24 iterations so a garbage `since` can never spin the loop. */
function monthsBetween(since: Date, now: Date): string[] {
  if (since.getTime() > now.getTime()) return [];
  const out: string[] = [];
  let y = since.getUTCFullYear();
  let m = since.getUTCMonth();
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth();
  while ((y < endY || (y === endY && m <= endM)) && out.length < 24) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

function parseShard(readFileFn: (p: string) => string, p: string): TaskRecord[] {
  let raw: string;
  try {
    raw = readFileFn(p);
  } catch {
    return [];
  }
  const out: TaskRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const j = JSON.parse(line) as Partial<TaskRecord>;
      if (
        typeof j.at === "string" &&
        typeof j.id === "string" &&
        typeof j.status === "string" &&
        typeof j.durationSeconds === "number"
      ) {
        out.push(j as TaskRecord);
      }
    } catch {
      // corrupt line — skip (reviewStore read discipline)
    }
  }
  return out;
}

export function makeTaskHistoryReader(
  cfg: Config,
  deps: TaskHistoryDeps = {},
): (since: Date) => TaskRecord[] {
  const readFileFn = deps.readFileFn ?? ((p: string): string => readFileSync(p, "utf8"));
  const statFn = deps.statFn ?? statSync;
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const memo = new Map<string, { mtimeMs: number; records: TaskRecord[] }>();
  return (since: Date): TaskRecord[] => {
    const out: TaskRecord[] = [];
    const sinceMs = since.getTime();
    for (const month of monthsBetween(since, nowFn())) {
      const p = join(historyDir(cfg), `tasks-${month}.jsonl`);
      let st: { mtimeMs: number };
      try {
        st = statFn(p);
      } catch {
        memo.delete(p); // absent shard (or vanished) — drop any stale memo
        continue;
      }
      const hit = memo.get(p);
      let records: TaskRecord[];
      if (hit !== undefined && hit.mtimeMs === st.mtimeMs) {
        records = hit.records;
      } else {
        records = parseShard(readFileFn, p);
        memo.set(p, { mtimeMs: st.mtimeMs, records });
      }
      for (const r of records) {
        const t = Date.parse(r.at);
        if (Number.isFinite(t) && t >= sinceMs) out.push(r);
      }
    }
    return out;
  };
}

/** One-shot read (statusCmd). The dashboard uses makeTaskHistoryReader so its
 * 2s polling amortizes shard parsing via the memo. */
export function readTaskHistory(
  cfg: Config,
  opts: { since: Date },
  deps: TaskHistoryDeps = {},
): TaskRecord[] {
  return makeTaskHistoryReader(cfg, deps)(opts.since);
}
