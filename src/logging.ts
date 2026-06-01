import { AsyncLocalStorage } from "node:async_hooks";

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

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  // Drop messages below the active threshold (debug < info < warn < error).
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const ticket = store.getStore()?.ticket ?? "-";
  // Spread caller fields FIRST so the canonical keys (ts/level/ticket/msg)
  // always win — a stray field named e.g. "level" can't corrupt the log shape.
  const entry = { ...fields, ts: new Date().toISOString(), level, ticket, msg };
  process.stdout.write(JSON.stringify(entry) + "\n");
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
