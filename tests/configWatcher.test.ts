import { describe, it, expect, vi } from "vitest";
import { makeConfigHolder, watchConfig } from "../src/configWatcher.js";

type Snap = { parsed: any; config: any } | { parsed: any; assembleError: Error } | Error;
const baseConfig = { vaultRoot: "/v", logLevel: "info", healthPort: 8787 } as any;
const baseline: Snap = {
  parsed: { vaultRoot: "/v", observability: { logLevel: "info", healthPort: 8787 } },
  config: baseConfig,
};

// initial seeds the baseline at construction; events are delivered one per fire().
function harness(initial: Snap, events: Snap[]) {
  let fire: () => void = () => {};
  let idx = -1; // -1 = construction/baseline; 0.. = events
  const setLog = vi.fn();
  const restart = vi.fn();
  const logError = vi.fn();
  const onApplied = vi.fn();
  const initialConfig =
    initial instanceof Error || "assembleError" in initial ? baseConfig : initial.config;
  const holder = makeConfigHolder(initialConfig);
  const cur = (): Snap => (idx < 0 ? initial : events[idx]);
  const handle = watchConfig("/dir/config.json", holder, {
    watchFn: (_dir, listener) => {
      fire = listener;
      return { close() {} };
    },
    scheduleFn: (cb) => {
      cb();
      return { cancel() {} };
    },
    parseFn: () => {
      const s = cur();
      if (s instanceof Error) throw s;
      return s.parsed;
    },
    assembleFn: () => {
      const s = cur();
      if (s instanceof Error) throw s;
      if ("assembleError" in s) throw s.assembleError;
      return s.config;
    },
    setLogLevelFn: setLog,
    onRestartFields: restart,
    logFn: { warn: vi.fn(), error: logError },
    onApplied,
  });
  return {
    fire: () => {
      idx++;
      fire();
    },
    holder,
    setLog,
    restart,
    logError,
    onApplied,
    handle,
  };
}

describe("configWatcher", () => {
  it("updates the holder and re-applies logLevel on a valid change", () => {
    const h = harness(baseline, [
      {
        parsed: { vaultRoot: "/v", observability: { logLevel: "debug", healthPort: 8787 } },
        config: { ...baseConfig, logLevel: "debug" },
      },
    ]);
    h.fire();
    expect(h.holder.current.logLevel).toBe("debug");
    expect(h.setLog).toHaveBeenCalledWith("debug");
  });

  it("reports a changed restart-kind lever", () => {
    const h = harness(baseline, [
      {
        parsed: { vaultRoot: "/v", observability: { logLevel: "info", healthPort: 9000 } },
        config: { ...baseConfig, healthPort: 9000 },
      },
    ]);
    h.fire();
    expect(h.restart).toHaveBeenCalledWith(expect.arrayContaining(["observability.healthPort"]));
  });

  it("does NOT report a restart when only a live lever changed", () => {
    const h = harness(baseline, [
      {
        parsed: {
          vaultRoot: "/v",
          observability: { logLevel: "info", healthPort: 8787 },
          worker: { pollIntervalSeconds: 20 },
        },
        config: { ...baseConfig },
      },
    ]);
    h.fire();
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("re-applies logLevel only when it changed", () => {
    // A reload that leaves logLevel at "info" must NOT call setLogLevel (#163).
    const h = harness(baseline, [
      {
        parsed: {
          vaultRoot: "/v",
          observability: { logLevel: "info", healthPort: 8787 },
          worker: { pollIntervalSeconds: 20 },
        },
        config: { ...baseConfig },
      },
    ]);
    h.fire();
    expect(h.setLog).not.toHaveBeenCalled();
  });

  it("keeps the last-good config when a reload fails", () => {
    const h = harness(baseline, [new Error("bad json")]);
    const before = h.holder.current;
    h.fire();
    expect(h.holder.current).toBe(before);
  });

  it("keeps the previous config and logs when assembly throws (bad apiKey, #CRIT-1)", () => {
    // assembleConfig can throw even when parsing succeeds — e.g. resolveApiKey
    // rejects an unset "$VAR" reference or a "!command" value. A schema-valid
    // config.json (parse succeeds) can still fail assembly; the watcher must
    // not let that escape the debounced setTimeout callback and crash the
    // daemon.
    const assembleError = new Error(
      "config: model.apiKey references $MISSING_KEY, but MISSING_KEY is not set in the daemon environment.",
    );
    const h = harness(baseline, [
      {
        parsed: { vaultRoot: "/v", observability: { logLevel: "info", healthPort: 8787 } },
        assembleError,
      },
    ]);
    const before = h.holder.current;
    expect(() => h.fire()).not.toThrow();
    expect(h.holder.current).toBe(before);
    expect(h.logError).toHaveBeenCalledWith(
      "config reload failed; keeping previous config",
      expect.objectContaining({ error: expect.stringContaining("MISSING_KEY") }),
    );
  });

  it("onApplied fires after a successful reload (Task 10 hot-reload clear)", () => {
    const h = harness(baseline, [
      {
        parsed: { vaultRoot: "/v", observability: { logLevel: "debug", healthPort: 8787 } },
        config: { ...baseConfig, logLevel: "debug" },
      },
    ]);
    h.fire();
    expect(h.onApplied).toHaveBeenCalledTimes(1);
  });

  it("onApplied does NOT fire when a reload's parse fails (bad json)", () => {
    const h = harness(baseline, [new Error("bad json")]);
    h.fire();
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  it("onApplied does NOT fire when a reload's assembly throws (bad apiKey)", () => {
    const assembleError = new Error("config: model.apiKey references $MISSING_KEY");
    const h = harness(baseline, [
      {
        parsed: { vaultRoot: "/v", observability: { logLevel: "info", healthPort: 8787 } },
        assembleError,
      },
    ]);
    h.fire();
    expect(h.onApplied).not.toHaveBeenCalled();
  });
});
