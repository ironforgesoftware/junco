import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Preview } from "../src/tui/components/Preview.js";
import type { DashIssue } from "../src/tui/state.js";

const ISSUE: DashIssue = {
  number: 52,
  title: "Fix reef colors",
  labels: ["junco", "junco:plan-ready"],
  updatedAt: "2026-07-07T13:00:00Z",
  url: "https://github.com/a/b/issues/52",
};
const base = {
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
  it("empty state explains itself", () => {
    const f = render(<Preview {...base} issue={null} paneNumber />).lastFrame()!;
    expect(f).toContain("3 preview");
    expect(f).toContain("select an issue");
  });
  it("renders title, badge, body, and plan divider", () => {
    const f = render(
      <Preview
        {...base}
        issue={ISSUE}
        body={"line one\nline two"}
        planComment={"<!-- junco:plan -->\nthe plan"}
        paneNumber
      />,
    ).lastFrame()!;
    expect(f).toContain("#52 Fix reef colors");
    expect(f).toContain("plan-ready");
    expect(f).toContain("line one");
    expect(f).toContain("── plan ──");
    expect(f).toContain("the plan");
  });
  it("loading and error states", () => {
    expect(render(<Preview {...base} issue={ISSUE} loading paneNumber />).lastFrame()).toContain(
      "loading",
    );
    expect(
      render(<Preview {...base} issue={ISSUE} error="gh exploded" paneNumber />).lastFrame(),
    ).toContain("gh exploded");
  });
  it("windows long bodies by scroll with a position footer", () => {
    const body = Array.from({ length: 60 }, (_, i) => `L${i + 1}`).join("\n");
    const top = render(<Preview {...base} issue={ISSUE} body={body} paneNumber />).lastFrame()!;
    const scrolled = render(
      <Preview {...base} issue={ISSUE} body={body} scroll={30} paneNumber />,
    ).lastFrame()!;
    expect(top).toContain("L1");
    expect(scrolled).not.toContain("L1\n");
    expect(scrolled).toContain("L31");
    expect(top).toContain("[ / ] scroll");
    expect(top).toContain("3 preview");
    expect(scrolled).toContain("3 preview");
  });
});
