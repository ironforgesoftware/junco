import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { CommandOutput } from "../src/tui/components/CommandOutput.js";
import { until } from "./helpers/until.js";

// The workspace switch deleted RepoList, IssueTable, StatusBar, ShortcutBar,
// IssueDetail, HelpOverlay, and QueueStrip. Their coverage now lives in the
// re-skinned component suites: tuiRail, tuiIssueList, tuiChrome, tuiPreview,
// tuiWorkspace. What remains here targets still-living components (CommandOutput,
// Spinner, TextField).

describe("cursor + spinner polish", () => {
  it("Spinner animates through the braille frames", async () => {
    const { Spinner, SPINNER_FRAMES } = await import("../src/tui/components/Spinner.js");
    const r = render(<Spinner />);
    const first = r.lastFrame()!;
    expect(SPINNER_FRAMES.some((f: string) => first.includes(f))).toBe(true);
    // Frame advance is interval-driven — bounded until-loop, never a fixed
    // wait (a loaded CI runner can starve the timer past any fixed delay).
    await until(() => r.lastFrame() !== first);
    r.unmount();
  });

  it("two Spinners stay in lockstep on Ink's shared animation timer", async () => {
    const { Spinner, SPINNER_FRAMES } = await import("../src/tui/components/Spinner.js");
    const { Text } = await import("ink");
    const r = render(
      <Text>
        <Spinner />|<Spinner />
      </Text>,
    );
    const glyphs = (f: string): string[] => f.split("|").map((s) => s.trim());
    const idx = (g: string): number => SPINNER_FRAMES.indexOf(g);
    const first = r.lastFrame()!;
    await until(() => r.lastFrame() !== first);
    // useAnimation drives every spinner from ONE timer (ink 7.1), but each
    // subscriber derives `frame` from ITS OWN start time
    // (ink/build/hooks/use-animation.js: Math.floor(elapsed / interval)), so
    // two spinners mounted a few ms apart may legitimately sit one frame
    // apart near an interval boundary — CI reproduced exactly that skew.
    // What the shared timer guarantees is lockstep within one frame and
    // both advancing; that is what we pin, not glyph identity.
    for (let i = 0; i < 5; i++) {
      const [a, b] = glyphs(r.lastFrame()!);
      expect(SPINNER_FRAMES).toContain(a);
      expect(SPINNER_FRAMES).toContain(b);
      const skew = (idx(a) - idx(b) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
      expect(skew === 0 || skew === 1 || skew === SPINNER_FRAMES.length - 1).toBe(true);
      const cur = r.lastFrame();
      await until(() => r.lastFrame() !== cur);
    }
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

describe("CommandOutput scroll clamp", () => {
  const OUT = Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n");

  it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
    const f = render(
      <CommandOutput
        title="junco doctor"
        running={false}
        elapsedS={1}
        output={OUT}
        scroll={999}
        exitCode={0}
        timedOut={false}
        height={10}
      />,
    ).lastFrame()!;
    expect(f).toContain("line-19");
    expect(f).not.toContain("line-00");
  });

  it("the footer counter never runs past the total", () => {
    const f = render(
      <CommandOutput
        title="junco doctor"
        running={false}
        elapsedS={1}
        output={OUT}
        scroll={999}
        exitCode={0}
        timedOut={false}
        height={10}
      />,
    ).lastFrame()!;
    // height 10 → visibleLines 5 → max 15 → the window is rows 16-20 of 20.
    expect(f).toContain("16-20/20");
  });

  it("reports its max scroll to the owner", () => {
    let reported: number | null = null;
    render(
      <CommandOutput
        title="junco doctor"
        running={false}
        elapsedS={1}
        output={OUT}
        scroll={0}
        exitCode={0}
        timedOut={false}
        height={10}
        onScrollMax={(m) => {
          reported = m;
        }}
      />,
    );
    expect(reported).toBe(15); // 20 lines − 5 visible
  });
});
