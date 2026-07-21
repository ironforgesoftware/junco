import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { CommandPalette } from "../src/tui/components/CommandPalette.js";
import { CommandOutput } from "../src/tui/components/CommandOutput.js";
import { PALETTE_COMMANDS } from "../src/tui/cliRunner.js";
import { renderApp } from "./helpers/localFixtures.js";
import { until, fireUntil } from "./helpers/until.js";

const noop = (): void => {};

afterEach(cleanup);

// SGR mouse press at 0-based cell (x,y) — mirrors tuiMouseApp.test.tsx's
// press() (b=0 press; a JS \u escape, not a raw ESC byte, so edits never drop it).
const press = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;

describe("CommandPalette", () => {
  const base = {
    commands: PALETTE_COMMANDS,
    filter: "",
    selected: 0,
    argsMode: false,
    argsValue: "",
    onFilter: noop,
    onArgs: noop,
    onCancel: noop,
  };

  it("lists runnable commands with descriptions and greys excluded ones with reasons", () => {
    const { lastFrame } = render(<CommandPalette {...base} />);
    const f = lastFrame()!;
    expect(f).toContain("status");
    expect(f).toContain("queue health");
    // "setup" is a runnable in-process row (Root swaps to the wizard).
    expect(f).toContain("setup");
    expect(f).toContain("Guided setup walkthrough");
    // "dashboard" stays excluded-with-reason ("already running").
    expect(f).toContain("already running");
  });

  it("filter narrows the visible rows", () => {
    const { lastFrame } = render(<CommandPalette {...base} filter="doc" />);
    const f = lastFrame()!;
    expect(f).toContain("doctor");
    expect(f).not.toContain("restart");
  });

  it("args step renders the hint as placeholder", () => {
    const { lastFrame } = render(
      <CommandPalette {...base} filter="retry" argsMode={true} argsValue="" />,
    );
    const f = lastFrame()!;
    expect(f).toContain("args:");
    expect(f).toContain("<name…|--all>");
  });
});

describe("CommandPalette mouse (App integration)", () => {
  it("clicking a row moves selection; clicking it again runs the command", async () => {
    const runCliFn = vi.fn(async (_name: string, _extraArgs: string[]) => ({
      code: 0,
      output: "ok",
      timedOut: false,
    }));
    const r = renderApp({ runCliFn });
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    r.stdin.write(":");
    await until(() => (r.lastFrame() ?? "").includes("run a junco command"));
    // "doctor" has no argsHint, so entering on it runs immediately (unlike
    // "list"/"retry", which would stop in the args step) — and it is not the
    // default selection (index 0 = "status"), so the first click has to move
    // the cursor before the second click can run it.
    const frameBefore = r.lastFrame() ?? "";
    const rowsBefore = frameBefore.split("\n");
    const y = rowsBefore.findIndex((l) => l.includes("doctor"));
    expect(y).toBeGreaterThan(-1);
    const x = rowsBefore[y].indexOf("doctor");
    // First click selects "doctor" (the ▸ marker moves onto its row).
    await fireUntil(r.stdin, press(x, y), () =>
      ((r.lastFrame() ?? "").split("\n")[y] ?? "").includes("▸"),
    );
    expect(runCliFn).not.toHaveBeenCalled();
    // Second click on the now-selected row runs it exactly once — the palette
    // unmounts into the cmdOutput view, so a retried click lands nowhere.
    await fireUntil(r.stdin, press(x, y), () => runCliFn.mock.calls.length > 0);
    expect(runCliFn).toHaveBeenCalledTimes(1);
    expect(runCliFn).toHaveBeenCalledWith("doctor", []);
  });
});

describe("CommandOutput", () => {
  it("shows a running spinner state with elapsed seconds", () => {
    const { lastFrame } = render(
      <CommandOutput
        title="junco doctor"
        running={true}
        elapsedS={3}
        output=""
        scroll={0}
        exitCode={null}
        timedOut={false}
        height={24}
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("junco doctor");
    expect(f).toContain("running… 3s");
  });

  it("shows exit code and the captured output", () => {
    const { lastFrame } = render(
      <CommandOutput
        title="junco status"
        running={false}
        elapsedS={1}
        output={"line1\nline2"}
        scroll={0}
        exitCode={0}
        timedOut={false}
        height={24}
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("exit 0");
    expect(f).toContain("line1");
    expect(f).toContain("line2");
  });

  it("reports a timeout kill distinctly", () => {
    const { lastFrame } = render(
      <CommandOutput
        title="junco run-once"
        running={false}
        elapsedS={120}
        output="partial"
        scroll={0}
        exitCode={null}
        timedOut={true}
        height={24}
      />,
    );
    expect(lastFrame()).toContain("timed out");
  });
});
