/**
 * Live tail of worker.log into a bounded in-memory buffer, gated on `active`
 * (the TUI passes true only while the logs section or overlay is on screen —
 * so nothing reads the disk when logs aren't being viewed). Seeds the recent
 * tail on activation, polls for deltas, resets on deactivation.
 */

import { useEffect, useState } from "react";
import { makeLogTailer, readTail, type LogEntry, type LogReaderDeps } from "../logReader.js";

export const LOG_BUFFER_CAP = 2000;

export const ROTATED_MARKER: LogEntry = {
  ts: null,
  level: null,
  ticket: null,
  msg: "─ log rotated ─",
  fields: {},
  raw: "",
};

export function appendBounded(buf: LogEntry[], add: LogEntry[], cap: number): LogEntry[] {
  if (add.length === 0) return buf;
  return [...buf, ...add].slice(-cap);
}

export interface UseLogTailOpts {
  pollMs?: number;
  seedN?: number;
  cap?: number;
  readerDeps?: LogReaderDeps;
}

export function useLogTail(path: string, active: boolean, opts: UseLogTailOpts = {}): LogEntry[] {
  const pollMs = opts.pollMs ?? 500;
  const seedN = opts.seedN ?? 200;
  const cap = opts.cap ?? LOG_BUFFER_CAP;
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (!active) {
      setEntries([]);
      return;
    }
    // Defensive `.slice(-cap)`: the seed is bounded by `seedN`, but a future
    // caller could pass `seedN > cap` — clamp so the buffer never opens larger
    // than the running cap that `appendBounded` enforces on every later poll.
    setEntries(readTail(path, seedN, opts.readerDeps).slice(-cap));
    const tailer = makeLogTailer(path, opts.readerDeps);
    const id = setInterval(() => {
      const fresh = tailer.poll();
      const add = tailer.rotated ? [ROTATED_MARKER, ...fresh] : fresh;
      if (add.length > 0) setEntries((buf) => appendBounded(buf, add, cap));
    }, pollMs);
    return () => {
      clearInterval(id);
    };
    // opts.readerDeps identity is stable per test; path/active/pollMs drive it.
  }, [path, active, pollMs, seedN, cap, opts.readerDeps]);

  return entries;
}
