// tests/useLogOverlay.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { Text } from "ink";
import { afterEach } from "vitest";
import { useLogOverlay } from "../src/tui/hooks/useLogOverlay.js";
import type { View } from "../src/tui/App.js";
import type { LocalSection } from "../src/tui/localSnapshot.js";
import type { LogReaderDeps } from "../src/logReader.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

// Copied from tests/useLogTail.test.tsx: a tiny in-memory file backing the fs
// deps, mutable via append.
function fakeFs(initial = "") {
  let content = Buffer.from(initial, "utf8");
  const deps: LogReaderDeps = {
    existsFn: () => content !== null,
    statFn: () => ({ size: content.length }),
    openFn: () => 1,
    closeFn: () => undefined,
    readFn: (_fd, buf, off, len, pos) => {
      const slice = content.subarray(pos, pos + len);
      slice.copy(buf, off);
      return slice.length;
    },
  };
  return {
    deps,
    append: (s: string) => {
      content = Buffer.concat([content, Buffer.from(s, "utf8")]);
    },
  };
}

function Probe({
  logPath,
  logsPollMs,
  logReaderDeps,
  sysSection,
  view,
  onReady,
}: {
  logPath: string;
  logsPollMs?: number;
  logReaderDeps?: LogReaderDeps;
  sysSection: LocalSection | null;
  view: View;
  onReady: (api: ReturnType<typeof useLogOverlay>) => void;
}) {
  const api = useLogOverlay({ logPath, logsPollMs, logReaderDeps, sysSection, view });
  onReady(api);
  return (
    <Text>
      {`overlay:${api.logOverlay}:follow:${api.logFollow}:active:${api.logActive}:count:${api.logEntries.length}`}
    </Text>
  );
}

describe("useLogOverlay", () => {
  it("initial state: logOverlay false, logFollow true", async () => {
    let api!: ReturnType<typeof useLogOverlay>;
    const r = render(
      <Probe logPath="/w.log" sysSection={null} view="main" onReady={(a) => (api = a)} />,
    );
    await until(() => api !== undefined);
    expect(api.logOverlay).toBe(false);
    expect(api.logFollow).toBe(true);
    r.unmount();
  });

  it("onLogExpand() sets logOverlay true AND logFollow true", async () => {
    let api!: ReturnType<typeof useLogOverlay>;
    const r = render(
      <Probe logPath="/w.log" sysSection={null} view="main" onReady={(a) => (api = a)} />,
    );
    await until(() => api !== undefined);
    // Flip follow false first so the assertion can't pass vacuously (default
    // is already true) — onLogExpand must still force it back to true.
    api.setLogFollow(false);
    await until(() => api.logFollow === false);
    api.onLogExpand();
    await until(() => api.logOverlay === true && api.logFollow === true);
    r.unmount();
  });

  it("logActive is true when sysSection==='logs' && view==='main' even with logOverlay false", async () => {
    let api!: ReturnType<typeof useLogOverlay>;
    const r = render(
      <Probe logPath="/w.log" sysSection="logs" view="main" onReady={(a) => (api = a)} />,
    );
    await until(() => api !== undefined);
    expect(api.logOverlay).toBe(false);
    expect(api.logActive).toBe(true);
    r.unmount();
  });

  it("logActive is true when logOverlay is true (regardless of sysSection/view)", async () => {
    let api!: ReturnType<typeof useLogOverlay>;
    const r = render(
      <Probe logPath="/w.log" sysSection={null} view="main" onReady={(a) => (api = a)} />,
    );
    await until(() => api !== undefined);
    expect(api.logActive).toBe(false);
    api.onLogExpand();
    await until(() => api.logOverlay === true);
    expect(api.logActive).toBe(true);
    r.unmount();
  });

  it("logEntries populates from an injected logReaderDeps fake while active (proves pass-through)", async () => {
    const f = fakeFs([line({ msg: "a" }), line({ msg: "b" }), ""].join("\n"));
    let api!: ReturnType<typeof useLogOverlay>;
    const r = render(
      <Probe
        logPath="/w.log"
        logsPollMs={15}
        logReaderDeps={f.deps}
        sysSection="logs"
        view="main"
        onReady={(a) => (api = a)}
      />,
    );
    await until(() => api !== undefined && api.logEntries.length === 2);
    expect(api.logEntries.map((e) => e.msg)).toEqual(["a", "b"]);
    f.append(line({ msg: "c" }) + "\n");
    await until(() => api.logEntries.length === 3);
    expect(api.logEntries.map((e) => e.msg)).toEqual(["a", "b", "c"]);
    r.unmount();
  });
});
