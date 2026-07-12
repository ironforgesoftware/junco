import { watch } from "node:fs";
import { dirname, basename } from "node:path";
import type { Config } from "./types.js";
import { assembleConfig, parseConfigFile, type ConfigParsed } from "./config.js";
import { LEVERS, getAtPath } from "./configLevers.js";
import { setLogLevel, log } from "./logging.js";
import { metrics } from "./metrics.js";

export interface ConfigHolder {
  current: Config;
}
export function makeConfigHolder(initial: Config): ConfigHolder {
  return { current: initial };
}

const RESTART_PATHS = new Set(LEVERS.filter((l) => l.reload === "restart").map((l) => l.path));

export interface WatchConfigDeps {
  watchFn?: (dir: string, listener: () => void) => { close(): void };
  assembleFn?: (d: ConfigParsed) => Config;
  parseFn?: (p: string) => ConfigParsed;
  setLogLevelFn?: (l: Config["logLevel"]) => void;
  onRestartFields?: (fields: string[]) => void;
  logFn?: { warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
  scheduleFn?: (cb: () => void, ms: number) => { cancel(): void };
  debounceMs?: number;
  /** Invoked right after a SUCCESSFUL reload adopts the new config (never on a
   * failed parse/assemble, which returns early and keeps the previous
   * config). The daemon wires this to `gate.clearLatched()` (Task 10) so an
   * operator fixing a bad apiKey/model id in config.json doesn't have to wait
   * out the auth/misconfig latch or restart the daemon. Default: no-op. */
  onApplied?: () => void;
}

// A null `prev` means the construction-time seed failed (unexpected — the
// daemon loaded the config moments ago). Treat the first successful reload as
// the baseline: report nothing, just adopt it. With a seeded `prev`, a genuine
// edit diffs at lever-path granularity and reports only what actually changed.
function changedLeverPaths(prev: ConfigParsed | null, next: ConfigParsed): string[] {
  if (!prev) return [];
  return LEVERS.filter(
    (l) => JSON.stringify(getAtPath(prev, l.path)) !== JSON.stringify(getAtPath(next, l.path)),
  ).map((l) => l.path);
}

export function watchConfig(
  configPath: string,
  holder: ConfigHolder,
  deps: WatchConfigDeps = {},
): { close(): void } {
  const watchFn =
    deps.watchFn ??
    ((dir, listener) =>
      watch(dir, (_e, fn) => {
        if (fn === basename(configPath)) listener();
      }));
  const assembleFn = deps.assembleFn ?? assembleConfig;
  const parseFn = deps.parseFn ?? parseConfigFile;
  const setLogLevelFn = deps.setLogLevelFn ?? setLogLevel;
  const onRestartFields = deps.onRestartFields ?? ((f) => metrics.addPendingRestartFields(f));
  const onApplied = deps.onApplied ?? ((): void => {});
  const logger = deps.logFn ?? log;
  const schedule =
    deps.scheduleFn ??
    ((cb, ms) => {
      const t = setTimeout(cb, ms);
      return { cancel: () => clearTimeout(t) };
    });
  const debounceMs = deps.debounceMs ?? 200;

  // Seed the baseline from the config as it stands at watch-start (the daemon
  // just loaded it), so the first edit diffs against the real prior values and
  // reports ONLY genuinely-changed restart-kind levers. If this parse throws
  // (unexpected), fall back to null and let the first successful reload adopt
  // the baseline silently (see changedLeverPaths).
  let prevParsed: ConfigParsed | null = null;
  try {
    prevParsed = parseFn(configPath);
  } catch {
    prevParsed = null;
  }
  let pending: { cancel(): void } | null = null;

  const reload = (): void => {
    // Single read: parse the file once, then assemble the flat Config from that
    // parsed object (no second readFileSync via loadConfig). assembleFn can
    // throw too — it calls resolveApiKey, which throws on an unset $VAR
    // reference or a "!command" value — so it stays inside this try alongside
    // parseFn: either failure logs and keeps serving the previous config
    // rather than throwing out of this debounced setTimeout callback (which
    // would crash the daemon).
    let nextParsed: ConfigParsed;
    let nextConfig: Config;
    try {
      nextParsed = parseFn(configPath);
      nextConfig = assembleFn(nextParsed);
    } catch (e) {
      logger.error("config reload failed; keeping previous config", {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    // Re-apply the log threshold only when it actually changed (setLogLevel is a
    // cheap idempotent global, but "only if changed" matches the spec).
    const prevLogLevel = holder.current.logLevel;
    holder.current = nextConfig;
    onApplied();
    if (nextConfig.logLevel !== prevLogLevel) setLogLevelFn(nextConfig.logLevel);
    const changed = changedLeverPaths(prevParsed, nextParsed);
    prevParsed = nextParsed;
    const restart = changed.filter((p) => RESTART_PATHS.has(p));
    if (restart.length > 0) {
      onRestartFields(restart);
      logger.warn("config changed; restart to apply", { fields: restart });
    }
  };

  const watcher = watchFn(dirname(configPath), () => {
    if (pending) pending.cancel();
    pending = schedule(reload, debounceMs);
  });
  return {
    close: () => {
      if (pending) pending.cancel();
      watcher.close();
    },
  };
}
