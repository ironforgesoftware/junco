import { AsyncLocalStorage } from "node:async_hooks";

type Level = "debug" | "info" | "warn" | "error";
const store = new AsyncLocalStorage<{ ticket: string }>();

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
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
