import { AsyncLocalStorage } from "node:async_hooks";
import { statSync, renameSync } from "node:fs";

type Level = "debug" | "info" | "warn" | "error";
const store = new AsyncLocalStorage<{ ticket: string }>();

// Severity ordering — a message is emitted only when its level is at or above
// the current threshold. Default "info" mirrors the [observability].log_level
// default; the CLI calls setLogLevel(cfg.logLevel) at startup.
const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel: Level = "info";

/**
 * Set the process-wide log threshold. Levels below it are suppressed.
 * Guards against an unrecognized value (e.g. a partial Config stub in tests):
 * an invalid level is ignored so the threshold can never become `undefined`.
 */
export function setLogLevel(level: Level): void {
  if (level in LEVEL_ORDER) currentLevel = level;
}

let sink: ((jsonLine: string) => void) | null = null;
let format: "json" | "human" = "json";

/**
 * Tee every emitted entry (as its JSON line) to a sink — the daemon points
 * this at the state-dir worker.log so `junco logs` has a file to read. null
 * disables. The sink ALWAYS receives JSON, independent of the stdout format.
 */
export function setLogSink(fn: ((jsonLine: string) => void) | null): void {
  sink = fn;
}

/** "human" renders colorized single-line output for TTYs; "json" (default)
 * keeps the machine-readable structured stream. */
export function setLogFormat(f: "json" | "human"): void {
  format = f;
}

const LEVEL_COLOR: Record<Level, string> = {
  debug: "\x1b[2m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

/** Render one structured entry for human eyes (also used by `junco logs`). */
export function formatHumanLine(entry: Record<string, unknown>): string {
  const ts = typeof entry.ts === "string" ? entry.ts.slice(11, 19) : "";
  const level = (typeof entry.level === "string" ? entry.level : "info") as Level;
  const ticket = entry.ticket && entry.ticket !== "-" ? `[${String(entry.ticket)}] ` : "";
  const rest: Record<string, unknown> = { ...entry };
  delete rest.ts;
  delete rest.level;
  delete rest.ticket;
  delete rest.msg;
  const fields = Object.keys(rest).length > 0 ? " " + JSON.stringify(rest) : "";
  const color = LEVEL_COLOR[level] ?? "";
  return `${ts} ${color}${level.toUpperCase().padEnd(5)}${RESET} ${ticket}${String(entry.msg ?? "")}${fields}`;
}

/** Size-capped single-generation rotation: worker.log → worker.log.1. Called
 * once at daemon startup, before the append stream opens. */
export function rotateLogIfLarge(path: string, maxBytes = 10 * 1024 * 1024): void {
  try {
    if (statSync(path).size > maxBytes) renameSync(path, path + ".1");
  } catch {
    /* missing file → nothing to rotate */
  }
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  // Drop messages below the active threshold (debug < info < warn < error).
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const ticket = store.getStore()?.ticket ?? "-";
  // Spread caller fields FIRST so the canonical keys (ts/level/ticket/msg)
  // always win — a stray field named e.g. "level" can't corrupt the log shape.
  const entry = { ...fields, ts: new Date().toISOString(), level, ticket, msg };
  const jsonLine = JSON.stringify(entry);
  if (sink) sink(jsonLine);
  process.stdout.write((format === "human" ? formatHumanLine(entry) : jsonLine) + "\n");
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};

export function withTicket<T>(ticket: string, fn: () => T): T {
  return store.run({ ticket }, fn);
}
