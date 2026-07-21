import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Preview } from "../src/tui/components/Preview.js";
import type { DashIssue } from "../src/tui/state.js";
import { makeDashIssue } from "./helpers/dashFixtures.js";

const ISSUE: DashIssue = makeDashIssue({
  number: 52,
  title: "Fix reef colors",
  labels: ["junco", "junco:plan-ready"],
});
const base = {
  issue: ISSUE,
  trigger: "junco",
  body: null as string | null,
  planComment: null as string | null,
  loading: false,
  error: null as string | null,
  scroll: 0,
  focused: false,
  height: 20,
};

describe("Preview", () => {
  it("renders title, badge, body, and plan divider", () => {
    const f = render(
      <Preview
        {...base}
        body={"line one\nline two"}
        planComment={"<!-- junco:plan -->\nthe plan"}
      />,
    ).lastFrame()!;
    expect(f).toContain("preview · #52");
    expect(f).toContain("#52 Fix reef colors");
    expect(f).toContain("plan-ready");
    expect(f).toContain("line one");
    expect(f).toContain("── plan ──");
    expect(f).toContain("the plan");
  });
  it("loading and error states", () => {
    expect(render(<Preview {...base} loading />).lastFrame()).toContain("loading");
    expect(render(<Preview {...base} error="gh exploded" />).lastFrame()).toContain("gh exploded");
  });
  it("windows long bodies by scroll with a position footer", () => {
    const body = Array.from({ length: 60 }, (_, i) => `L${i + 1}`).join("\n");
    const top = render(<Preview {...base} body={body} />).lastFrame()!;
    const scrolled = render(<Preview {...base} body={body} scroll={30} />).lastFrame()!;
    expect(top).toContain("L1");
    expect(scrolled).not.toContain("L1\n");
    expect(scrolled).toContain("L31");
    expect(top).toContain("↑/↓ scroll");
    expect(top).toContain("preview · #52");
    expect(scrolled).toContain("preview · #52");
  });
  it("renders the ↗ link line directly under the heading", () => {
    const f = render(<Preview {...base} />).lastFrame()!;
    expect(f).toContain("↗ a/b#52");
    // Fixed geometry row: border(0), title(1), heading(2), link(3) = LINK_LINE_ROW.
    const rows = f.split("\n");
    expect(rows[3]).toContain("↗");
  });
  it("keeps the ↗ link line pinned to row 3 while loading (body not yet fetched)", () => {
    const f = render(<Preview {...base} loading />).lastFrame()!;
    const rows = f.split("\n");
    expect(rows[3]).toContain("↗");
  });
});

describe("Preview scroll clamp", () => {
  const BODY = Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join(
    "\n",
  );

  it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
    const f = render(
      <Preview
        issue={ISSUE}
        trigger="junco"
        body={BODY}
        planComment={null}
        loading={false}
        error={null}
        scroll={999}
        focused
        height={14}
      />,
    ).lastFrame()!;
    expect(f).toContain("(no plan posted yet)"); // the last built line
    expect(f).not.toContain("line-00");
  });

  it("reports its max scroll to the owner", () => {
    let reported: number | null = null;
    render(
      <Preview
        issue={ISSUE}
        trigger="junco"
        body={"only one line"}
        planComment={null}
        loading={false}
        error={null}
        scroll={0}
        focused
        height={14}
        onScrollMax={(m) => {
          reported = m;
        }}
      />,
    );
    expect(reported).toBe(0); // 3 built lines in an 8-row viewport — nothing to scroll
  });
});
