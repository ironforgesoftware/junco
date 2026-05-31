import { AsyncLocalStorage } from "node:async_hooks";

type Level = "debug" | "info" | "warn" | "error";
const store = new AsyncLocalStorage<{ ticket: string }>();

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const ticket = store.getStore()?.ticket ?? "-";
  const entry = { ts: new Date().toISOString(), level, ticket, msg, ...fields };
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
