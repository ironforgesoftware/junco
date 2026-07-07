import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { CommandPalette } from "../src/tui/components/CommandPalette.js";
import { CommandOutput } from "../src/tui/components/CommandOutput.js";
import { PALETTE_COMMANDS } from "../src/tui/cliRunner.js";

const noop = (): void => {};

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
    expect(f).toContain("init");
    expect(f).toContain("can't nest inside the dashboard");
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
