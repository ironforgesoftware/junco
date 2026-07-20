import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { LogView } from "../src/tui/components/LogView.js";
import { ROTATED_MARKER } from "../src/tui/useLogTail.js";
import type { LogEntry } from "../src/logReader.js";
import type { LogFilters } from "../src/tui/logFilter.js";

const e = (o: Partial<LogEntry>): LogEntry => ({
  ts: null,
  level: "info",
  ticket: null,
  msg: "",
  fields: {},
  raw: "",
  ...o,
});

const F = (o: Partial<LogFilters> = {}): LogFilters => ({
  minLevel: "debug",
  ticket: null,
  search: "",
  ...o,
});

describe("LogView — section variant", () => {
  it("case 1: renders the last k entries unfiltered, newest at the bottom, with the follow dot + count", () => {
    // 15 lines, a debug one in the tail to prove the section applies NO filter.
    const buf = Array.from({ length: 15 }, (_, i) =>
      e({ level: i === 13 ? "debug" : "info", msg: `line-${String(i).padStart(2, "0")}` }),
    );
    const frame = render(
      <LogView variant="section" entries={buf} height={10} focused={false} hasFile />,
    ).lastFrame()!;

    expect(frame).toContain("line-14"); // newest is present…
    expect(frame.indexOf("line-14")).toBeGreaterThan(frame.indexOf("line-13")); // …at the bottom
    expect(frame).not.toContain("line-00"); // oldest scrolled off the tail (k < 15)
    expect(frame).toContain("line-13"); // a debug line in the tail still shows → unfiltered
    expect(frame).toContain("●"); // follow dot
    expect(frame).toContain("15"); // header count = buffer length
  });

  it("case 2: level labels render in each level's column (warn/error/null), color per the suite's text-only approach", () => {
    // Captured frames strip ANSI (non-TTY), so — like the rest of the TUI suite —
    // colors aren't observable; assert the level LABEL text renders per level.
    const buf = [
      e({ level: "debug", msg: "a-debug" }),
      e({ level: "info", msg: "b-info" }),
      e({ level: "warn", msg: "c-warn" }),
      e({ level: "error", msg: "d-error" }),
      e({ level: null, msg: "e-null" }),
    ];
    const frame = render(
      <LogView variant="section" entries={buf} height={12} focused={false} hasFile />,
    ).lastFrame()!;

    expect(frame).toContain("DEBUG");
    expect(frame).toContain("INFO");
    expect(frame).toContain("WARN");
    expect(frame).toContain("ERROR");
    expect(frame).toContain("·····"); // null level placeholder
    expect(frame).toContain("c-warn");
    expect(frame).toContain("d-error");
  });

  it("case 3: a ROTATED_MARKER entry renders as the rule row", () => {
    const buf = [
      e({ level: "info", msg: "before-rotate" }),
      ROTATED_MARKER,
      e({ level: "info", msg: "after-rotate" }),
    ];
    const frame = render(
      <LogView variant="section" entries={buf} height={12} focused={false} hasFile />,
    ).lastFrame()!;

    expect(frame).toContain("─ log rotated ─");
    expect(frame).toContain("before-rotate");
    expect(frame).toContain("after-rotate");
  });

  it("case 6a: hasFile=false renders the daemon-not-started placeholder (section)", () => {
    const frame = render(
      <LogView variant="section" entries={[]} height={10} focused={false} hasFile={false} />,
    ).lastFrame()!;
    expect(frame).toContain("the daemon writes it once started");
  });
});

describe("LogView — full variant", () => {
  it("case 4: filters minLevel=warn shows only warn+; the `level ≥ warn` chip is present", () => {
    const buf = [
      e({ level: "debug", msg: "x-debug" }),
      e({ level: "info", msg: "x-info" }),
      e({ level: "warn", msg: "x-warn" }),
      e({ level: "error", msg: "x-error" }),
    ];
    const frame = render(
      <LogView
        variant="full"
        entries={buf}
        height={16}
        focused
        hasFile
        filters={F({ minLevel: "warn" })}
        follow
        scroll={0}
      />,
    ).lastFrame()!;

    expect(frame).toContain("x-warn");
    expect(frame).toContain("x-error");
    expect(frame).not.toContain("x-debug");
    expect(frame).not.toContain("x-info");
    expect(frame).toContain("level ≥ warn");
  });

  it("case 5: follow shows the bottom window; paused at scroll=0 shows the top window", () => {
    const buf = Array.from({ length: 40 }, (_, i) =>
      e({ level: "info", msg: `row-${String(i).padStart(2, "0")}` }),
    );
    const common = {
      variant: "full" as const,
      entries: buf,
      height: 12, // visible = height - 4 = 8
      focused: true,
      hasFile: true,
      filters: F(),
    };
    const followFrame = render(<LogView {...common} follow scroll={0} />).lastFrame()!;
    const pausedFrame = render(<LogView {...common} follow={false} scroll={0} />).lastFrame()!;

    // Following tails the bottom of the buffer…
    expect(followFrame).toContain("row-39");
    expect(followFrame).not.toContain("row-00");
    // …paused at the top shows the head instead (first vs last visible line differs).
    expect(pausedFrame).toContain("row-00");
    expect(pausedFrame).not.toContain("row-39");
  });

  it("case 6b: hasFile=false renders the daemon-not-started placeholder (full)", () => {
    const frame = render(
      <LogView
        variant="full"
        entries={[]}
        height={12}
        focused
        hasFile={false}
        filters={F()}
        follow
        scroll={0}
      />,
    ).lastFrame()!;
    expect(frame).toContain("the daemon writes it once started");
  });

  it("hasFile=false wins over a non-empty filtered buffer → the placeholder, never real rows", () => {
    // Defensive/stale wiring state: entries present AND passing the filter, but
    // hasFile is false. The daemon-not-started placeholder must still win.
    const buf = [e({ level: "info", msg: "stale-line" })];
    const frame = render(
      <LogView
        variant="full"
        entries={buf}
        height={12}
        focused
        hasFile={false}
        filters={F()}
        follow
        scroll={0}
      />,
    ).lastFrame()!;
    expect(frame).toContain("the daemon writes it once started");
    expect(frame).not.toContain("stale-line");
    expect(frame).not.toContain("no lines match");
  });

  it("case 7: a filter that matches nothing renders `no lines match` (not the no-file placeholder)", () => {
    const buf = [e({ level: "info", msg: "only-info" })];
    const frame = render(
      <LogView
        variant="full"
        entries={buf}
        height={12}
        focused
        hasFile
        filters={F({ minLevel: "error" })}
        follow
        scroll={0}
      />,
    ).lastFrame()!;
    expect(frame).toContain("no lines match");
    expect(frame).not.toContain("only-info");
    expect(frame).not.toContain("the daemon writes it once started");
  });

  it("reports maxScroll to the owner during render (the Task 7 scroll contract)", () => {
    const buf = Array.from({ length: 40 }, (_, i) => e({ level: "info", msg: `r${i}` }));
    let reported: number | null = null;
    render(
      <LogView
        variant="full"
        entries={buf}
        height={12} // visible = 8 → maxScroll(40, 8) = 32
        focused
        hasFile
        filters={F()}
        follow
        scroll={0}
        onScrollMax={(m) => {
          reported = m;
        }}
      />,
    );
    expect(reported).toBe(32);
  });

  it("searchMode renders a live search prompt in the header, even before a char is typed", () => {
    const emptyFrame = render(
      <LogView
        variant="full"
        entries={[]}
        height={12}
        focused
        hasFile
        filters={F()}
        follow
        scroll={0}
        searchMode
      />,
    ).lastFrame()!;
    expect(emptyFrame).toContain("/▏"); // empty-term prompt (search-entry cue)

    const typedFrame = render(
      <LogView
        variant="full"
        entries={[e({ msg: "x" })]}
        height={12}
        focused
        hasFile
        filters={F({ search: "boot" })}
        follow
        scroll={0}
        searchMode
      />,
    ).lastFrame()!;
    expect(typedFrame).toContain("/boot▏"); // the prompt tracks the term live
    expect(typedFrame).not.toContain('"boot"'); // NOT the committed quoted chip while editing
  });

  it("a committed search (searchMode off) renders the quoted chip, not the live prompt", () => {
    const frame = render(
      <LogView
        variant="full"
        entries={[e({ msg: "x" })]}
        height={12}
        focused
        hasFile
        filters={F({ search: "boot" })}
        follow
        scroll={0}
      />,
    ).lastFrame()!;
    expect(frame).toContain('"boot"');
    expect(frame).not.toContain("/boot▏");
  });
});
