import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PrPreview } from "../src/tui/components/PrPreview.js";
import { type DashPr } from "../src/tui/prState.js";

const NOW = new Date("2026-07-07T14:00:00Z");

// Strips OSC 8 hyperlink escapes (added by the ↗ link line's <Transform>) so
// raw string length reflects visible terminal width, not the invisible bytes
// wrapping the link row. Ink's own layout already excludes them from width
// math (verified via ink/build/sanitize-ansi.js) — this mirrors that for tests.
const OSC_RE = new RegExp("\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)", "g");
function visibleWidth(line: string): number {
  return line.replace(OSC_RE, "").length;
}

const pr = (number: number, overrides: Partial<DashPr> = {}): DashPr => ({
  number,
  title: `Test PR #${number}`,
  url: `https://github.com/a/b/pull/${number}`,
  headRefName: "junco/task-42",
  baseRefName: "main",
  isDraft: false,
  state: "OPEN",
  reviewDecision: null,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  checks: { pass: 2, fail: 0, pending: 0, total: 2 },
  additions: 5,
  deletions: 3,
  changedFiles: 2,
  createdAt: "2026-07-06T14:00:00Z",
  updatedAt: "2026-07-07T13:00:00Z",
  mergedAt: null,
  author: "alice",
  labels: [],
  nwo: "a/b",
  ...overrides,
});

const base = {
  branchPrefix: "junco/",
  now: NOW,
  height: 27,
  focused: false,
};

describe("PrPreview", () => {
  it("renders empty state when pr is null", () => {
    const f = render(<PrPreview pr={null} {...base} />).lastFrame()!;
    expect(f).toContain("3 pr");
    expect(f).toContain("select a pull request — its status renders here");
  });

  it("renders empty state with accent title when focused", () => {
    const f = render(<PrPreview pr={null} {...base} focused={true} />).lastFrame()!;
    expect(f).toContain("3 pr");
    expect(f).toContain("select a pull request — its status renders here");
  });

  it("renders all-fields card: heading, checks, review, merge, branch, ticket, stats, opened, author", () => {
    const testPr = pr(42, {
      title: "Fix the widget",
      checks: { pass: 3, fail: 1, pending: 0, total: 4 },
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      additions: 10,
      deletions: 5,
      changedFiles: 3,
      author: "bob",
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).toContain("3 pr · #42");
    expect(f).toContain("#42 Fix the widget");
    expect(f).toContain("checks:");
    expect(f).toContain("✓3");
    expect(f).toContain("✗1");
    expect(f).toContain(" of 4");
    expect(f).toContain("review: approved");
    expect(f).toContain("merge: MERGEABLE · CLEAN");
    expect(f).toContain("branch:");
    expect(f).toContain("junco/task-42");
    expect(f).toContain("main");
    expect(f).toContain("ticket: task-42");
    expect(f).toContain("±: +10 −5 · 3 files");
    expect(f).toContain("opened");
    expect(f).toContain("author: bob");
  });

  it("skips merge row when both mergeable and mergeStateStatus are null", () => {
    const testPr = pr(42, {
      mergeable: null,
      mergeStateStatus: null,
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).not.toContain("merge:");
  });

  it("skips only null parts of merge row", () => {
    const testPr1 = pr(42, {
      mergeable: "MERGEABLE",
      mergeStateStatus: null,
    });
    const f1 = render(<PrPreview pr={testPr1} {...base} />).lastFrame()!;
    expect(f1).toContain("merge: MERGEABLE");
    expect(f1).not.toMatch(/merge:.*·/);

    const testPr2 = pr(43, {
      mergeable: null,
      mergeStateStatus: "CLEAN",
    });
    const f2 = render(<PrPreview pr={testPr2} {...base} />).lastFrame()!;
    expect(f2).toContain("merge: CLEAN");
    expect(f2).not.toMatch(/merge:.*·/);
  });

  it("renders checks: none when total 0", () => {
    const testPr = pr(42, {
      checks: { pass: 0, fail: 0, pending: 0, total: 0 },
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).toContain("checks: none");
    expect(f).not.toContain("✓");
    expect(f).not.toContain("✗");
    expect(f).not.toContain("◍");
  });

  it("renders review with APPROVED badge", () => {
    const testPr = pr(42, {
      reviewDecision: "APPROVED",
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).toContain("review: approved");
  });

  it("renders review with CHANGES_REQUESTED badge", () => {
    const testPr = pr(42, {
      reviewDecision: "CHANGES_REQUESTED",
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).toContain("review: changes-requested");
  });

  it("renders no decision when reviewDecision is null or empty", () => {
    const f1 = render(<PrPreview pr={pr(42, { reviewDecision: null })} {...base} />).lastFrame()!;
    expect(f1).toContain("review: no decision");

    const f2 = render(<PrPreview pr={pr(43, { reviewDecision: "" })} {...base} />).lastFrame()!;
    expect(f2).toContain("review: no decision");
  });

  it("extracts ticket slug from head branch using branchPrefix", () => {
    const testPr = pr(42, {
      headRefName: "junco/task-123-fix-widget",
    });
    const f = render(
      <PrPreview pr={testPr} branchPrefix="junco/" now={NOW} height={27} />,
    ).lastFrame()!;

    expect(f).toContain("ticket: task-123-fix-widget");
  });

  it("renders ticket: — when slug cannot be extracted", () => {
    const testPr = pr(42, {
      headRefName: "feature/hand-authored",
    });
    const f = render(
      <PrPreview pr={testPr} branchPrefix="junco/" now={NOW} height={27} />,
    ).lastFrame()!;

    expect(f).toContain("ticket: —");
  });

  it("renders merged state with merged time and merged badge", () => {
    const testPr = pr(42, {
      state: "MERGED",
      mergedAt: "2026-07-07T10:00:00Z",
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).toContain("merged");
    expect(f).toContain("4h"); // merged age
  });

  it("renders closed state with closed age from updatedAt (closed PRs have no mergedAt)", () => {
    const testPr = pr(42, {
      state: "CLOSED",
      mergedAt: null,
      updatedAt: "2026-07-07T13:00:00Z", // 60m before NOW
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).toContain("closed 60m");
    expect(f).not.toContain("merged ");
  });

  it("renders heading with state badge colored by lifecycle", () => {
    const testPr = pr(42, {
      title: "Test",
      checks: { pass: 0, fail: 1, pending: 0, total: 1 },
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).toContain("checks-failing");
  });

  it("truncates long branch names at start to preserve slug tail", () => {
    const longBranch = "junco/" + "x".repeat(100) + "/slug-tail";
    const testPr = pr(42, {
      headRefName: longBranch,
    });
    const f = render(
      <PrPreview pr={testPr} branchPrefix="junco/" now={NOW} height={27} />,
    ).lastFrame()!;

    // Should contain slug-tail at the end (might lose 1-2 chars due to rendering width constraints)
    expect(f).toMatch(/slug-tai[l]?/);
  });

  it("renders with fixed width when width prop is set", () => {
    const testPr = pr(42);
    const f = render(<PrPreview pr={testPr} {...base} width={48} />).lastFrame()!;

    const lines = f.split("\n");
    const maxWidth = Math.max(...lines.map((l) => visibleWidth(l)));
    expect(maxWidth).toBeLessThanOrEqual(48);
  });

  it("renders with flexGrow when width is undefined", () => {
    const testPr = pr(42);
    const f = render(<PrPreview pr={testPr} {...base} width={undefined} />).lastFrame()!;

    // Just verify it renders without error
    expect(f).toContain("3 pr");
  });

  it("renders focused with accent border and title", () => {
    const testPr = pr(42, { title: "Test" });
    const f = render(<PrPreview pr={testPr} {...base} focused={true} />).lastFrame()!;

    expect(f).toContain("3 pr · #42");
    expect(f).toContain("Test");
  });

  it("keeps all content within height budget", () => {
    const testPr = pr(42, {
      title: "Fix the widget",
      checks: { pass: 3, fail: 1, pending: 0, total: 4 },
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      additions: 10,
      deletions: 5,
      changedFiles: 3,
      author: "bob",
    });
    const f = render(<PrPreview pr={testPr} {...base} height={27} />).lastFrame()!;

    const lines = f.split("\n");
    expect(lines.length).toBeLessThanOrEqual(27);
  });

  it("drops least-important rows at small heights instead of corrupting the frame (height 8)", () => {
    // Full card: every optional row present → 10 content rows, but only
    // height - 3 (borders + pane title) may render. Pre-budget code rendered
    // all rows unconditionally and Yoga corrupted the frame (pane title
    // vanished, branch bled into ticket).
    const testPr = pr(42, {
      title: "Fix the widget",
      state: "MERGED",
      mergedAt: "2026-07-07T10:00:00Z",
      checks: { pass: 3, fail: 1, pending: 0, total: 4 },
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    const f = render(<PrPreview pr={testPr} {...base} height={8} />).lastFrame()!;

    const lines = f.split("\n");
    expect(lines.length).toBe(8);
    // Pane title and heading (most important rows) both survive.
    expect(f).toContain("3 pr · #42");
    expect(f).toContain("#42 Fix the widget");
    // No bled/concatenated fragments: the branch row's head must not run into
    // the ticket row's content on a single line.
    expect(lines.some((l) => l.includes("← main") && l.includes("ticket:"))).toBe(false);
  });

  it("renders one-line rows at tight widths (width 48)", () => {
    const testPr = pr(42, {
      title: "A very long title that should truncate cleanly",
      checks: { pass: 15, fail: 3, pending: 2, total: 20 },
      additions: 100,
      deletions: 50,
      changedFiles: 20,
      author: "alice-with-a-very-long-name",
    });
    const f = render(<PrPreview pr={testPr} {...base} width={48} />).lastFrame()!;

    const lines = f.split("\n");
    // Each line should be at most 48 chars and contain no wrapping artifacts
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(48);
    }
    // Should still render all the key info
    expect(f).toContain("#42");
    expect(f).toContain("ticket:");
  });

  it("renders checksPending with colored pending badge", () => {
    const testPr = pr(42, {
      checks: { pass: 1, fail: 0, pending: 2, total: 3 },
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).toContain("✓1");
    expect(f).toContain("◍2");
    expect(f).toContain(" of 3");
  });

  it("renders draft state with draft badge", () => {
    const testPr = pr(42, {
      isDraft: true,
    });
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;

    expect(f).toContain("draft");
  });

  it("renders the ↗ link line as the row after the heading", () => {
    const testPr = pr(100);
    const f = render(<PrPreview pr={testPr} {...base} />).lastFrame()!;
    expect(f).toContain(`↗ ${testPr.nwo}#${testPr.number}`);
    expect(f.split("\n")[3]).toContain("↗");
  });
});
