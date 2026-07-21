// App-level suite for the compact `logs` system row: the last rail row, whose
// body is the section-variant LogView fed by useLogTail. The log source is
// injected as an in-memory fake fs via the `logReaderDeps` prop (the same seam
// shape as tests/logReader.test.ts) + a small `logsPollMs`, so these tests
// never touch a real worker.log and can spy on the reader to prove the poll is
// gated to exactly the logs surface.
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup } from "ink-testing-library";
import type { LogReaderDeps } from "../src/logReader.js";
import { sectionBadge } from "../src/tui/components/sections.js";
import { renderApp, CHEAP, HEAVY } from "./helpers/localFixtures.js";
import { until, fireUntil } from "./helpers/until.js";

afterEach(cleanup);

const logLine = (o: Record<string, unknown>): string => JSON.stringify(o) + "\n";

// In-memory file backing the log reader deps, with spies on the two fs calls
// the reader actually makes (statFn for size, readFn for bytes) so a test can
// assert the poll never touched disk while the logs surface was off screen.
function spyFakeFs(initial = "") {
  let content = Buffer.from(initial, "utf8");
  const statFn = vi.fn((_p: string) => ({ size: content.length }));
  const readFn = vi.fn((_fd: number, buf: Buffer, _off: number, len: number, pos: number) => {
    const slice = content.subarray(pos, pos + len);
    slice.copy(buf, 0);
    return slice.length;
  });
  const deps: LogReaderDeps = {
    existsFn: () => true,
    statFn,
    openFn: () => 1,
    closeFn: () => undefined,
    readFn,
  };
  return {
    deps,
    statFn,
    readFn,
    append: (s: string): void => {
      content = Buffer.concat([content, Buffer.from(s, "utf8")]);
    },
  };
}

describe("logs system row", () => {
  it("renders as the LAST rail row; G jumps the rail cursor onto it", async () => {
    const fs = spyFakeFs(logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "seed" }));
    const r = renderApp({ logReaderDeps: fs.deps, logsPollMs: 15 });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    expect(r.lastFrame()).toContain("logs");
    // G jumps to the last rail row — logs — and its section body mounts.
    await fireUntil(r.stdin, "G", () =>
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("▌") && l.includes("logs")),
    );
  });

  it("selecting logs renders a LogView tailing the injected file (seed + live poll)", async () => {
    const fs = spyFakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "daemon booted" }),
    );
    const r = renderApp({ logReaderDeps: fs.deps, logsPollMs: 15 });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    // Jump to logs → the section-variant LogView mounts and seeds from the file.
    await fireUntil(r.stdin, "G", () => (r.lastFrame() ?? "").includes("daemon booted"));
    // A line appended after mount lands on the next poll — proves it live-tails.
    fs.append(logLine({ ts: "2026-07-20T05:00:01.000Z", level: "warn", msg: "guard nudge fired" }));
    await until(() => (r.lastFrame() ?? "").includes("guard nudge fired"));
  });

  it("gates the reader: no disk read while another body is on screen, reads once logs is selected", async () => {
    const fs = spyFakeFs(logLine({ ts: "t", level: "info", msg: "x" }));
    const r = renderApp({ logReaderDeps: fs.deps, logsPollMs: 15 });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    // The issues body is active (first repo row) → the hook is inactive. Give
    // several poll intervals (pollMs=15) a chance; a wrongly-active hook would
    // have read.
    await new Promise((res) => setTimeout(res, 80));
    expect(fs.statFn).not.toHaveBeenCalled();
    expect(fs.readFn).not.toHaveBeenCalled();
    // Select logs → the reader activates and reads the file.
    await fireUntil(r.stdin, "G", () => fs.statFn.mock.calls.length > 0);
    expect(fs.readFn).toHaveBeenCalled();
  });

  it("sectionBadge('logs', …) is empty — the follow dot lives in the LogView header", () => {
    expect(sectionBadge("logs", CHEAP, HEAVY)).toBe("");
    expect(sectionBadge("logs", null, null)).toBe("");
  });
});

describe("daemon liveness in the logs header (#239)", () => {
  it("a down daemon marks the logs body — old lines never read as live", async () => {
    const fs = spyFakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "stale-l" }),
    );
    const r = renderApp({
      localCheapFn: async () => ({ ...CHEAP, daemon: { ...CHEAP.daemon, up: false } }),
      logReaderDeps: fs.deps,
      logsPollMs: 15,
    });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    await fireUntil(r.stdin, "G", () => (r.lastFrame() ?? "").includes("stale-l"));
    await until(() => (r.lastFrame() ?? "").includes("daemon ○ — showing last logs"));
  });
});
