// tests/useCmdOutput.test.tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useCmdOutput } from "../src/tui/hooks/useCmdOutput.js";
import type { CliRunResult } from "../src/tui/cliRunner.js";
import type { View } from "../src/tui/App.js";
import { until } from "./helpers/until.js";

function Probe({
  runCliFn,
  setView,
  onReady,
}: {
  runCliFn: (name: string, extraArgs: string[]) => Promise<CliRunResult>;
  setView: (v: View) => void;
  onReady: (api: ReturnType<typeof useCmdOutput>) => void;
}) {
  const api = useCmdOutput(runCliFn, setView);
  onReady(api);
  return <Text>{api.cmd ? `running:${api.cmd.running}` : "no-cmd"}</Text>;
}

describe("useCmdOutput", () => {
  it("starts with cmd null and cmdElapsed 0", () => {
    const runCliFn = vi.fn(async () => ({ code: 0, output: "", timedOut: false }));
    const setView = vi.fn();
    let api!: ReturnType<typeof useCmdOutput>;
    const r = render(<Probe runCliFn={runCliFn} setView={setView} onReady={(a) => (api = a)} />);
    expect(api.cmd).toBeNull();
    expect(api.cmdElapsed).toBe(0);
    expect(r.lastFrame()).toBe("no-cmd");
    r.unmount();
  });

  it("runPaletteCommand sets cmd running:true immediately, switches to cmdOutput, then lands the result", async () => {
    let resolveFn!: (r: CliRunResult) => void;
    const runCliFn = vi.fn(
      () =>
        new Promise<CliRunResult>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const setView = vi.fn();
    let api!: ReturnType<typeof useCmdOutput>;
    const r = render(<Probe runCliFn={runCliFn} setView={setView} onReady={(a) => (api = a)} />);

    api.runPaletteCommand("assess", ["acme/widgets"]);
    await until(() => api.cmd?.running === true);
    expect(api.cmd?.title).toBe("junco assess acme/widgets");
    expect(api.cmd?.exitCode).toBeNull();
    expect(setView).toHaveBeenCalledWith("cmdOutput");
    expect(runCliFn).toHaveBeenCalledWith("assess", ["acme/widgets"]);

    resolveFn({ code: 0, output: "queued", timedOut: false });
    await until(() => api.cmd?.running === false);
    expect(api.cmd?.output).toBe("queued");
    expect(api.cmd?.exitCode).toBe(0);
    expect(api.cmd?.timedOut).toBe(false);
    r.unmount();
  });

  it("showCmdResult lands a completed result in the cmdOutput view with re-run intact", async () => {
    const runCliFn = vi.fn(async () => ({ code: 0, output: "", timedOut: false }));
    const setView = vi.fn();
    let api!: ReturnType<typeof useCmdOutput>;
    const r = render(<Probe runCliFn={runCliFn} setView={setView} onReady={(a) => (api = a)} />);
    api.showCmdResult("submit", ["--as-issue", "/x.md"], {
      code: 1,
      output: "refused\n",
      timedOut: false,
    });
    // Gate on the COMMITTED state, not just the (synchronous) setView call —
    // `api` is re-handed on render, so asserting before the commit reads stale.
    await until(() => api.cmd?.exitCode === 1);
    expect(setView.mock.calls.some((c) => c[0] === "cmdOutput")).toBe(true);
    expect(api.cmd).toMatchObject({
      title: "junco submit --as-issue /x.md",
      running: false,
      exitCode: 1,
      output: "refused\n",
      name: "submit",
      extraArgs: ["--as-issue", "/x.md"],
    });
    expect(runCliFn).not.toHaveBeenCalled();
    r.unmount();
  });

  it("stale-guard: a first run's late resolution does NOT clobber a second (newer) run's state", async () => {
    let resolveFirst!: (r: CliRunResult) => void;
    let resolveSecond!: (r: CliRunResult) => void;
    let call = 0;
    const runCliFn = vi.fn(
      () =>
        new Promise<CliRunResult>((resolve) => {
          call += 1;
          if (call === 1) resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
    );
    const setView = vi.fn();
    let api!: ReturnType<typeof useCmdOutput>;
    const r = render(<Probe runCliFn={runCliFn} setView={setView} onReady={(a) => (api = a)} />);

    // First run.
    api.runPaletteCommand("assess", ["acme/widgets"]);
    await until(() => runCliFn.mock.calls.length === 1);

    // Second (newer) run supersedes the first before it resolves.
    api.runPaletteCommand("assess", ["acme/other"]);
    await until(
      () => runCliFn.mock.calls.length === 2 && api.cmd?.title === "junco assess acme/other",
    );

    // The STALE first resolution lands after the second run has started — it
    // must be dropped by the token guard, not clobber the second run's state.
    resolveFirst({ code: 0, output: "stale output", timedOut: false });
    await new Promise((res) => setTimeout(res, 50));
    expect(api.cmd?.title).toBe("junco assess acme/other");
    expect(api.cmd?.running).toBe(true);
    expect(api.cmd?.output).not.toBe("stale output");

    // The second (current) run's resolution DOES land.
    resolveSecond({ code: 0, output: "fresh output", timedOut: false });
    await until(() => api.cmd?.running === false && api.cmd?.output === "fresh output");
    expect(api.cmd?.title).toBe("junco assess acme/other");
    expect(api.cmd?.exitCode).toBe(0);
    r.unmount();
  });
});
