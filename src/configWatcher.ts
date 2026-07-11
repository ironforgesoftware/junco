import { watch } from "node:fs";
import { dirname, basename } from "node:path";
import type { Config } from "./types.js";
import { loadConfig, parseConfigFile, type ConfigParsed } from "./config.js";
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
  loadFn?: (p: string) => Config;
  parseFn?: (p: string) => ConfigParsed;
  setLogLevelFn?: (l: Config["logLevel"]) => void;
  onRestartFields?: (fields: string[]) => void;
  logFn?: { warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
  scheduleFn?: (cb: () => void, ms: number) => { cancel(): void };
  debounceMs?: number;
}

// getAtPath is null-safe (a null/undefined root short-circuits every segment
// to `undefined`), so a `prev` of `null` naturally diffs as "every
// currently-set path changed" — no special-casing needed here.
function changedLeverPaths(prev: ConfigParsed | null, next: ConfigParsed): string[] {
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
  const loadFn = deps.loadFn ?? loadConfig;
  const parseFn = deps.parseFn ?? parseConfigFile;
  const setLogLevelFn = deps.setLogLevelFn ?? setLogLevel;
  const onRestartFields = deps.onRestartFields ?? ((f) => metrics.addPendingRestartFields(f));
  const logger = deps.logFn ?? log;
  const schedule =
    deps.scheduleFn ??
    ((cb, ms) => {
      const t = setTimeout(cb, ms);
      return { cancel: () => clearTimeout(t) };
    });
  const debounceMs = deps.debounceMs ?? 200;

  // No eager parse here: `prevParsed` seeds from the FIRST successful reload
  // (below), not from a construction-time read. A watcher observes changes
  // relative to the config as it stood at watch-start; the first reload after
  // that establishes the baseline every later diff compares against.
  let prevParsed: ConfigParsed | null = null;
  let pending: { cancel(): void } | null = null;

  const reload = (): void => {
    let nextParsed: ConfigParsed;
    let nextConfig: Config;
    try {
      nextParsed = parseFn(configPath);
      nextConfig = loadFn(configPath);
    } catch (e) {
      logger.error("config reload failed; keeping previous config", {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    holder.current = nextConfig;
    setLogLevelFn(nextConfig.logLevel);
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
