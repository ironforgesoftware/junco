import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { HelpOverlay } from "../src/tui/components/HelpOverlay.js";
import { CommandOutput } from "../src/tui/components/CommandOutput.js";

// The workspace switch deleted RepoList, IssueTable, StatusBar, ShortcutBar,
// IssueDetail, and QueueStrip. Their coverage now lives in the re-skinned
// component suites: tuiRail, tuiIssueList, tuiChrome, tuiPreview, tuiWorkspace.
// What remains here targets still-living components (HelpOverlay, CommandOutput,
// Spinner, TextField).

describe("HelpOverlay", () => {
  it("documents every key with the configured trigger", () => {
    const { lastFrame } = render(<HelpOverlay trigger="junco" />);
    const f = lastFrame()!;
    for (const k of [
      "dispatch",
      "approve",
      "re-plan",
      "re-cycle",
      "add repo",
      "browser",
      "refresh",
      "quit",
    ]) {
      expect(f.toLowerCase()).toContain(k);
    }
  });
});

describe("cursor + spinner polish", () => {
  it("Spinner animates through the braille frames", async () => {
    const { Spinner, SPINNER_FRAMES } = await import("../src/tui/components/Spinner.js");
    const r = render(<Spinner />);
    const first = r.lastFrame()!;
    expect(SPINNER_FRAMES.some((f: string) => first.includes(f))).toBe(true);
    await new Promise((res) => setTimeout(res, 250));
    expect(r.lastFrame()).not.toBe(first); // frame advanced
    r.unmount();
  });

  it("TextField shows a block cursor on the focused field — even when empty", async () => {
    const { TextField } = await import("../src/tui/components/TextField.js");
    const focusedEmpty = render(
      <TextField
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        focus={true}
        placeholder="hint"
      />,
    ).lastFrame()!;
    expect(focusedEmpty).toContain("█");
    expect(focusedEmpty).toContain("hint");
    const blurredEmpty = render(
      <TextField
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        focus={false}
        placeholder="hint"
      />,
    ).lastFrame()!;
    expect(blurredEmpty).not.toContain("█");
    const focusedFilled = render(
      <TextField
        value="acme"
        onChange={() => {}}
        onSubmit={() => {}}
        focus={true}
        placeholder="hint"
      />,
    ).lastFrame()!;
    expect(focusedFilled).toContain("acme█");
  });

  it("CommandOutput shows a spinner glyph while running", async () => {
    const { SPINNER_FRAMES } = await import("../src/tui/components/Spinner.js");
    const f = render(
      <CommandOutput
        title="junco doctor"
        running={true}
        elapsedS={1}
        output=""
        scroll={0}
        exitCode={null}
        timedOut={false}
        height={24}
      />,
    ).lastFrame()!;
    expect(SPINNER_FRAMES.some((g: string) => f.includes(g))).toBe(true);
  });
});
