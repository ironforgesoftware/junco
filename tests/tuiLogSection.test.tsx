// App-level suite for the compact LOCAL `logs` section (Task 6): the 6th rail
// section whose body is the section-variant LogView fed by useLogTail. The log
// source is injected as an in-memory fake fs via the `logReaderDeps` prop (the
// same seam shape as tests/logReader.test.ts) + a small `logsPollMs`, so these
// tests never touch a real worker.log and can spy on the reader to prove the
// poll is gated to exactly the logs surface.
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup } from "ink-testing-library";
import type { LogReaderDeps } from "../src/logReader.js";
import { sectionBadge } from "../src/tui/components/LocalDashboard.js";
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

describe("LOCAL logs section", () => {
  it("lists a logs section after daemon in the rail, navigable to the last slot", async () => {
    const fs = spyFakeFs(logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "seed" }));
    const r = renderApp({ initialUiMode: "local", logReaderDeps: fs.deps, logsPollMs: 15 });
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    // On the (default) queue section the LogView is NOT mounted, so "logs" here
    // can only be the rail row; the position line proves there are 6 sections.
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("logs");
    expect(frame).toContain("1/6");
    // G jumps to the last section — now `logs`, appended after `daemon`.
    await fireUntil(r.stdin, "G", () => (r.lastFrame() ?? "").includes("6/6"));
    expect(r.lastFrame()).toContain("6/6");
  });

  it("selecting logs renders a LogView tailing the injected file (seed + live poll)", async () => {
    const fs = spyFakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "daemon booted" }),
    );
    const r = renderApp({ initialUiMode: "local", logReaderDeps: fs.deps, logsPollMs: 15 });
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    // Jump to logs → the section-variant LogView mounts and seeds from the file.
    await fireUntil(r.stdin, "G", () => (r.lastFrame() ?? "").includes("daemon booted"));
    // A line appended after mount lands on the next poll — proves it live-tails.
    fs.append(logLine({ ts: "2026-07-20T05:00:01.000Z", level: "warn", msg: "guard nudge fired" }));
    await until(() => (r.lastFrame() ?? "").includes("guard nudge fired"));
  });

  it("gates the reader: no disk read on a non-logs section, reads once logs is selected", async () => {
    const fs = spyFakeFs(logLine({ ts: "t", level: "info", msg: "x" }));
    const r = renderApp({ initialUiMode: "local", logReaderDeps: fs.deps, logsPollMs: 15 });
    await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    // Queue section is active → the hook is inactive. Give several poll
    // intervals (pollMs=15) a chance; a wrongly-active hook would have read.
    await new Promise((res) => setTimeout(res, 80));
    expect(fs.statFn).not.toHaveBeenCalled();
    expect(fs.readFn).not.toHaveBeenCalled();
    // Select logs → the reader activates and reads the file.
    await fireUntil(r.stdin, "G", () => fs.statFn.mock.calls.length > 0);
    expect(fs.readFn).toHaveBeenCalled();
  });

  it("never reads the log in GitHub mode (the surface is off screen)", async () => {
    const fs = spyFakeFs(logLine({ ts: "t", level: "info", msg: "x" }));
    const r = renderApp({ initialUiMode: "github", logReaderDeps: fs.deps, logsPollMs: 15 });
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    await new Promise((res) => setTimeout(res, 80));
    expect(fs.statFn).not.toHaveBeenCalled();
    expect(fs.readFn).not.toHaveBeenCalled();
  });

  it("sectionBadge('logs', …) is empty — the follow dot lives in the LogView header", () => {
    expect(sectionBadge("logs", CHEAP, HEAVY)).toBe("");
    expect(sectionBadge("logs", null, null)).toBe("");
  });
});
