/**
 * Shared reader for the daemon's `<dataDir>/worker.log` (JSON-lines, written by
 * logging.ts's rotating sink). Owns the byte-offset follow mechanics extracted
 * from logsCmd: incremental read from a stored offset, rotation reset on size
 * shrink, partial-line carry. Deps-injectable over fs so it is unit-testable
 * with an in-memory file. `parseLogLine` is tolerant — a non-JSON line
 * (crash output) passes through as raw at level null; it never throws.
 */

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";

export interface LogEntry {
  ts: string | null;
  level: "debug" | "info" | "warn" | "error" | null;
  ticket: string | null;
  msg: string;
  fields: Record<string, unknown>;
  raw: string;
}

export interface LogReaderDeps {
  statFn?: (p: string) => { size: number };
  openFn?: (p: string, flags: string) => number;
  readFn?: (fd: number, buf: Buffer, off: number, len: number, pos: number) => number;
  closeFn?: (fd: number) => void;
  existsFn?: (p: string) => boolean;
}

const LEVELS = new Set(["debug", "info", "warn", "error"]);

export function parseLogLine(raw: string): LogEntry {
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") obj = parsed as Record<string, unknown>;
  } catch {
    obj = null;
  }
  if (obj === null) {
    return { ts: null, level: null, ticket: null, msg: raw, fields: {}, raw };
  }
  const level =
    typeof obj.level === "string" && LEVELS.has(obj.level)
      ? (obj.level as LogEntry["level"])
      : null;
  const ticketRaw = typeof obj.ticket === "string" ? obj.ticket : null;
  const { ts, level: _l, ticket: _t, msg: _m, ...fields } = obj;
  return {
    ts: typeof ts === "string" ? ts : null,
    level,
    ticket: ticketRaw === "-" ? null : ticketRaw,
    msg: typeof obj.msg === "string" ? obj.msg : "",
    fields,
    raw,
  };
}

export function readTail(path: string, n: number, deps: LogReaderDeps = {}): LogEntry[] {
  const existsFn = deps.existsFn ?? existsSync;
  if (!existsFn(path)) return [];
  // Destructure to local consts: TS narrows a property-access expression like
  // `deps.statFn` for later reads of that same expression, but does not carry
  // that narrowing when `deps` as a whole is passed to a differently-typed
  // parameter — so the ternary below needs these narrowed locals, not `deps`.
  const { statFn, openFn, readFn, closeFn } = deps;
  let content: string;
  try {
    // The reader has no injectable whole-file read seam; the fake-fs tests drive
    // readTail via statFn/readFn below when deps are supplied, and production
    // uses readFileSync. Prefer the seam when present.
    content =
      statFn && readFn && openFn && closeFn
        ? readViaSeam(path, { statFn, openFn, readFn, closeFn })
        : readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((l) => l !== "");
  return lines.slice(-n).map(parseLogLine);
}

/** Read the whole file through the injected fs seam (tests). */
function readViaSeam(
  path: string,
  deps: Required<Pick<LogReaderDeps, "statFn" | "openFn" | "readFn" | "closeFn">>,
): string {
  const size = deps.statFn(path).size;
  const fd = deps.openFn(path, "r");
  try {
    const buf = Buffer.alloc(size);
    deps.readFn(fd, buf, 0, size, 0);
    return buf.toString("utf8");
  } finally {
    deps.closeFn(fd);
  }
}

export interface LogTailer {
  poll(): LogEntry[];
  rotated: boolean;
}

export function makeLogTailer(path: string, deps: LogReaderDeps = {}): LogTailer {
  const statFn = deps.statFn ?? ((p: string) => ({ size: statSync(p).size }));
  const openFn = deps.openFn ?? ((p: string) => openSync(p, "r"));
  const readFn = deps.readFn ?? ((fd, buf, off, len, pos) => readSync(fd, buf, off, len, pos));
  const closeFn = deps.closeFn ?? closeSync;

  let pos = sizeOrZero(); // start at EOF: only new lines follow
  let carry = "";
  const tailer: LogTailer = {
    rotated: false,
    poll(): LogEntry[] {
      this.rotated = false;
      let size: number;
      try {
        size = statFn(path).size;
      } catch {
        return []; // vanished mid-poll — next tick re-stats
      }
      if (size < pos) {
        pos = 0; // rotation: new file is smaller
        carry = "";
        this.rotated = true;
      }
      if (size <= pos) return [];
      const fd = openFn(path, "r");
      try {
        const buf = Buffer.alloc(size - pos);
        readFn(fd, buf, 0, buf.length, pos);
        pos = size;
        const chunk = carry + buf.toString("utf8");
        const parts = chunk.split("\n");
        carry = parts.pop() ?? "";
        return parts.filter((l) => l !== "").map(parseLogLine);
      } finally {
        closeFn(fd);
      }
    },
  };
  return tailer;

  function sizeOrZero(): number {
    try {
      return statFn(path).size;
    } catch {
      return 0;
    }
  }
}
