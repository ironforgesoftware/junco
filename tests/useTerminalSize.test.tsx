import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { Text, useWindowSize } from "ink";
import { useTerminalSize, type TerminalSize } from "../src/tui/useTerminalSize.js";

// useTerminalSize wraps ink's useWindowSize with a non-TTY fallback (columns||100
// / rows||30) and an override short-circuit. ink's own getWindowSize already
// substitutes 80×24 for a dead stdout, so the fallback branch never fires
// through a real render — mock useWindowSize to drive it (and the override path)
// directly, which the App tests can't do since they always inject sizeOverride.
vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ink")>();
  return { ...actual, useWindowSize: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.mocked(useWindowSize).mockReset();
});

// A one-line probe: render the resolved size so lastFrame() reports it. No state
// changes downstream of the mocked hook, so the first frame is authoritative —
// nothing to loop-until.
function Probe({ override }: { override?: TerminalSize }): React.JSX.Element {
  const s = useTerminalSize(override);
  return <Text>{`${s.columns}x${s.rows}`}</Text>;
}

describe("useTerminalSize", () => {
  it("falls back to 100×30 when the stream reports nothing (non-TTY)", () => {
    vi.mocked(useWindowSize).mockReturnValue({ columns: 0, rows: 0 });
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toBe("100x30");
  });

  it("falls back per-axis (a live column count, a dead row count)", () => {
    vi.mocked(useWindowSize).mockReturnValue({ columns: 137, rows: 0 });
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toBe("137x30");
  });

  it("passes a real terminal size through untouched", () => {
    vi.mocked(useWindowSize).mockReturnValue({ columns: 137, rows: 52 });
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toBe("137x52");
  });

  it("returns the override verbatim, ignoring the live window size", () => {
    vi.mocked(useWindowSize).mockReturnValue({ columns: 137, rows: 52 });
    const { lastFrame } = render(<Probe override={{ columns: 42, rows: 7 }} />);
    expect(lastFrame()).toBe("42x7");
  });

  it("override short-circuits even the non-TTY fallback", () => {
    vi.mocked(useWindowSize).mockReturnValue({ columns: 0, rows: 0 });
    const { lastFrame } = render(<Probe override={{ columns: 200, rows: 60 }} />);
    expect(lastFrame()).toBe("200x60");
  });
});
