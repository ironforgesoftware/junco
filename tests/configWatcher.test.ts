import { describe, it, expect, vi } from "vitest";
import { makeConfigHolder, watchConfig } from "../src/configWatcher.js";

const baseConfig = { vaultRoot: "/v", logLevel: "info", healthPort: 8787 } as any;

function harness(seq: { parsed: any; config: any }[] | Error[]) {
  let fire: () => void = () => {};
  let i = 0;
  const setLog = vi.fn();
  const restart = vi.fn();
  const holder = makeConfigHolder(baseConfig);
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
      const s = seq[i];
      if (s instanceof Error) throw s;
      return (s as any).parsed;
    },
    loadFn: () => {
      const s = seq[i++];
      if (s instanceof Error) throw s;
      return (s as any).config;
    },
    setLogLevelFn: setLog,
    onRestartFields: restart,
  });
  return { fire: () => fire(), holder, setLog, restart, handle };
}

describe("configWatcher", () => {
  it("updates the holder and re-applies logLevel on a valid change", () => {
    const h = harness([
      {
        parsed: { vaultRoot: "/v", observability: { logLevel: "debug", healthPort: 8787 } },
        config: { ...baseConfig, logLevel: "debug" },
      },
    ]);
    h.fire();
    expect(h.holder.current.logLevel).toBe("debug");
    expect(h.setLog).toHaveBeenCalledWith("debug");
  });

  it("records restart-kind changes but not live ones", () => {
    // Watcher diffs the parsed file object at lever-path granularity.
    const h = harness([
      {
        parsed: { vaultRoot: "/v", observability: { healthPort: 9000 } },
        config: { ...baseConfig, healthPort: 9000 },
      },
    ]);
    h.fire();
    expect(h.restart).toHaveBeenCalledWith(expect.arrayContaining(["observability.healthPort"]));
  });

  it("keeps the last-good config when a reload fails", () => {
    const h = harness([new Error("bad json")]);
    const before = h.holder.current;
    h.fire();
    expect(h.holder.current).toBe(before);
  });
});
