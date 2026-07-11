import { describe, it, expect, vi } from "vitest";
import { makeConfigHolder, watchConfig } from "../src/configWatcher.js";

type Snap = { parsed: any; config: any } | Error;
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
  const holder = makeConfigHolder(initial instanceof Error ? baseConfig : initial.config);
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
      return s.config;
    },
    setLogLevelFn: setLog,
    onRestartFields: restart,
  });
  return {
    fire: () => {
      idx++;
      fire();
    },
    holder,
    setLog,
    restart,
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
});
