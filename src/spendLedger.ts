/**
 * Per-day spend ledger — tracks USD spent "today" (LOCAL calendar day, per an
 * injected clock) for the budget gate's `until`. Backed by a single JSON file
 * (the FULL path is the caller's — a caller passes `dataTreePaths(cfg).spendFile`;
 * dataTree.ts is the only place that joins "spend.json" onto the data root);
 * same atomic-write discipline as the watchlist (`src/watchlist.ts:22-77`):
 * mkdir -p, sibling `.tmp`, rename. Read discipline mirrors `readWatchlist`
 * (`src/watchlist.ts:28-77`): missing/corrupt/stale file never throws — it
 * degrades to a fresh `{today, 0}` instead.
 *
 * Input discipline: `recordUsd` accepts only finite, positive amounts.
 * Non-finite input (a bad upstream SDK float) is dropped with a warn —
 * summing it would poison the file and zero the day's total; `usd <= 0`
 * is a silent skip (0 per contract, negatives have no refund semantics).
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logging.js";

export interface SpendLedgerDeps {
  now?: () => number;
  readFileFn?: typeof readFileSync;
  writeFileFn?: typeof writeFileSync;
  renameFn?: typeof renameSync;
  mkdirFn?: typeof mkdirSync;
}

export interface SpendLedger {
  recordUsd(usd: number): void;
  todayUsd(): number;
  nextMidnightMs(): number;
}

interface LedgerFile {
  date: string; // LOCAL "YYYY-MM-DD"
  usd: number;
}

/** LOCAL "YYYY-MM-DD" — built from getFullYear/getMonth/getDate, deliberately
 * NOT toISOString() (UTC): the ledger tracks the operator's wall-clock day,
 * so rollover must follow the injected clock's local date, not UTC. */
function localDateString(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function makeSpendLedger(file: string, deps: SpendLedgerDeps = {}): SpendLedger {
  const now = deps.now ?? (() => Date.now());
  const readFileFn = deps.readFileFn ?? readFileSync;
  const writeFileFn = deps.writeFileFn ?? writeFileSync;
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? mkdirSync;

  /** Never throws: missing → {today, 0}; corrupt/invalid shape → {today, 0};
   * stale day (rollover) → {today, 0} (watchlist read discipline,
   * src/watchlist.ts:28-77 — same shape of try/catch, just a single record
   * instead of an array). */
  function read(): LedgerFile {
    const today = localDateString(now());
    let raw: string;
    try {
      raw = readFileFn(file, "utf8");
    } catch {
      return { date: today, usd: 0 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { date: today, usd: 0 };
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as Record<string, unknown>).date !== "string" ||
      typeof (parsed as Record<string, unknown>).usd !== "number" ||
      !Number.isFinite((parsed as Record<string, unknown>).usd as number)
    ) {
      return { date: today, usd: 0 };
    }
    const p = parsed as LedgerFile;
    if (p.date !== today) return { date: today, usd: 0 }; // rollover on read
    return { date: p.date, usd: p.usd };
  }

  /** Atomic write: mkdir -p, sibling tmp, rename (watchlist.ts:72-77). */
  function write(ledger: LedgerFile): void {
    mkdirFn(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileFn(tmp, JSON.stringify(ledger) + "\n", "utf8");
    renameFn(tmp, file);
  }

  return {
    recordUsd(usd: number): void {
      // Reject non-finite and non-positive amounts BEFORE touching the file.
      // A single NaN/Infinity would poison the sum (current.usd + NaN → NaN,
      // which JSON.stringify serializes as `null` → the next read hits the
      // corrupt-file branch and silently zeroes the day's legitimately
      // recorded spend — the budget cap would stop working for the rest of
      // the day). Negative dollars have no refund semantics here; 0 is the
      // documented skip-the-write no-op. Only the non-finite case warns:
      // it means an upstream SDK float went bad and must be visible.
      if (!Number.isFinite(usd)) {
        log.warn("spendLedger: ignoring non-finite USD amount", { usd: String(usd) });
        return;
      }
      if (usd <= 0) return; // no-op: skip the write entirely (0 and negatives)
      const current = read(); // rollover on write: read() folds in the day change
      write({ date: current.date, usd: current.usd + usd });
    },
    todayUsd(): number {
      return read().usd;
    },
    nextMidnightMs(): number {
      const d = new Date(now());
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
    },
  };
}
