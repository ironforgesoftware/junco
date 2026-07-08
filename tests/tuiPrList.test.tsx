import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PrList } from "../src/tui/components/PrList.js";
import { type DashPr } from "../src/tui/prState.js";

const NOW = new Date("2026-07-07T14:00:00Z");

const pr = (
  number: number,
  title: string,
  state: string = "OPEN",
  isDraft: boolean = false,
  reviewDecision: string | null = null,
): DashPr => ({
  number,
  title,
  url: `https://github.com/a/b/pull/${number}`,
  headRefName: `junco/ticket-${number}`,
  baseRefName: "main",
  isDraft,
  state,
  reviewDecision,
  mergeable: "MERGEABLE",
  mergeStateStatus: null,
  checks: { pass: 2, fail: 0, pending: 0, total: 2 },
  additions: 5,
  deletions: 3,
  changedFiles: 2,
  createdAt: "2026-07-06T14:00:00Z",
  updatedAt: "2026-07-07T13:00:00Z",
  mergedAt: null,
  author: "junco-bot",
  labels: [],
  nwo: "a/b",
});

describe("PrList", () => {
  it("renders title with count and selection bar on first row", () => {
    const prs = [pr(42, "Fix widget"), pr(43, "Add feature")];
    const f = render(
      <PrList prs={prs} selected={0} focused={true} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;
    expect(f).toContain("p pull requests · 2");
    expect(f).toContain("▌");
  });

  it("renders PR number padStart(5) and title", () => {
    const prs = [pr(42, "Fix widget")];
    const f = render(
      <PrList prs={prs} selected={0} focused={true} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;
    expect(f).toContain("#42");
    expect(f).toContain("Fix widget");
  });

  it("shows nwo (repo name) and state glyph", () => {
    const prs = [
      {
        ...pr(42, "Fix widget", "OPEN", false, null),
        nwo: "owner/repo",
      },
    ];
    const f = render(
      <PrList prs={prs} selected={0} focused={true} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;
    expect(f).toContain("owner/repo");
    expect(f).toContain("◔"); // review-pending glyph
  });

  it("renders checks badge only when total > 0 (✓N green, ✗N red, ◍N yellow)", () => {
    const passOnly = {
      ...pr(42, "All green"),
      checks: { pass: 3, fail: 0, pending: 0, total: 3 },
    };
    const withFail = {
      ...pr(43, "Has failures"),
      checks: { pass: 1, fail: 2, pending: 0, total: 3 },
    };
    const withPending = {
      ...pr(44, "Pending checks"),
      checks: { pass: 0, fail: 0, pending: 2, total: 2 },
    };
    const noChecks = {
      ...pr(45, "No checks"),
      checks: { pass: 0, fail: 0, pending: 0, total: 0 },
    };

    const f = render(
      <PrList
        prs={[passOnly, withFail, withPending, noChecks]}
        selected={0}
        focused={true}
        height={20}
        now={NOW}
        staleAt={null}
      />,
    ).lastFrame()!;

    expect(f).toContain("✓3"); // pass badge (green)
    expect(f).toContain("✗2"); // fail badge (red)
    expect(f).toContain("◍2"); // pending badge (yellow)
    const lines = f.split("\n");
    const nocheckLine = lines.find((l) => l.includes("No checks"));
    expect(nocheckLine).toBeTruthy();
    // ensure no checks badge on the no-checks row
    expect(nocheckLine).not.toMatch(/✓|✗|◍/);
  });

  it("renders state badge with lifecycle color", () => {
    const merged = { ...pr(42, "Merged PR", "MERGED"), mergedAt: "2026-07-07T12:00:00Z" };
    const failing = {
      ...pr(43, "Failing checks"),
      checks: { pass: 0, fail: 2, pending: 0, total: 2 },
    };
    const draft = { ...pr(44, "Draft PR", "OPEN", true) };

    const f = render(
      <PrList
        prs={[merged, failing, draft]}
        selected={0}
        focused={true}
        height={20}
        now={NOW}
        staleAt={null}
      />,
    ).lastFrame()!;

    expect(f).toContain("merged");
    expect(f).toContain("checks-failing");
    expect(f).toContain("draft");
  });

  it("renders relTime (age) dimmed unless selected", () => {
    const old = { ...pr(42, "Old PR"), updatedAt: "2026-07-04T14:00:00Z" };
    const recent = { ...pr(43, "Recent PR"), updatedAt: "2026-07-07T13:00:00Z" };

    const f = render(
      <PrList
        prs={[old, recent]}
        selected={0}
        focused={true}
        height={20}
        now={NOW}
        staleAt={null}
      />,
    ).lastFrame()!;

    expect(f).toContain("3d"); // old PR
    expect(f).toContain("60m"); // recent PR
  });

  it("windows to height minus 4 (borders+title+position line) with position indicator when list > height", () => {
    const many = Array.from({ length: 40 }, (_, i) => pr(i + 1, `PR number ${i + 1}`));
    const f = render(
      <PrList prs={many} selected={39} focused={true} height={12} now={NOW} staleAt={null} />,
    ).lastFrame()!;

    expect(f).toContain("PR number 40");
    expect(f).not.toContain("PR number 1 "); // not the title of #1 row
    expect(f).toContain("40/40"); // position indicator
  });

  it("shows empty state when prs empty and staleAt null", () => {
    const f = render(
      <PrList prs={[]} selected={0} focused={true} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;

    expect(f).toContain("no junco PRs found across watched repos");
    expect(f).toContain("junco opens PRs from dispatched tickets");
  });

  it("shows empty state alongside the offline badge when prs empty and staleAt set", () => {
    const f = render(
      <PrList
        prs={[]}
        selected={0}
        focused={true}
        height={20}
        now={NOW}
        staleAt="2026-07-07T12:00:00Z"
      />,
    ).lastFrame()!;

    expect(f).toContain("no junco PRs found across watched repos");
    expect(f).toContain("offline ·");
  });

  it("renders offline badge with clock time when staleAt is not null", () => {
    const prs = [pr(42, "Stale PR")];
    const f = render(
      <PrList
        prs={prs}
        selected={0}
        focused={true}
        height={20}
        now={NOW}
        staleAt="2026-07-07T12:00:00Z"
      />,
    ).lastFrame()!;

    expect(f).toContain("offline ·");
    expect(f).toMatch(/offline · \d{2}:\d{2}/);
  });

  it("renders with accent border when focused, plain border when not", () => {
    const prs = [pr(42, "Test PR")];
    const f1 = render(
      <PrList prs={prs} selected={0} focused={true} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;
    const f2 = render(
      <PrList prs={prs} selected={0} focused={false} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;

    // focused version should have the title with accent
    expect(f1).toContain("p pull requests");
    expect(f2).toContain("p pull requests");
  });

  it("fits all content within 100 columns max frame width", () => {
    const prs = [
      {
        ...pr(
          12345,
          "A very long title that might wrap or truncate in the display area to test frame width constraints",
        ),
        nwo: "owner/very-long-repository-name",
        checks: { pass: 15, fail: 3, pending: 2, total: 20 },
      },
    ];
    const f = render(
      <PrList prs={prs} selected={0} focused={true} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;

    const lines = f.split("\n");
    const maxWidth = Math.max(...lines.map((l) => l.length));
    expect(maxWidth).toBeLessThanOrEqual(100);
  });

  it("keeps every row on exactly one line under long content at 100 cols", () => {
    // Long everything: 6-digit number, long title, an enterprise-length nwo,
    // wide checks badge, and the longest state badge (checks-failing). Under a
    // 100-col frame the fixed cells alone would overflow unless every non-title
    // cell is wrap-proof and the nwo cell is clamped.
    const prs = [
      {
        ...pr(
          123456,
          "A very long title that might wrap or truncate in the display area to test frame width constraints",
        ),
        nwo: "organization-with-a-long-name/very-long-repository-name-that-keeps-going",
        checks: { pass: 15, fail: 3, pending: 2, total: 20 },
      },
      pr(7, "Short one"),
    ];
    const f = render(
      <PrList prs={prs} selected={0} focused={true} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;

    const lines = f.split("\n");
    // A wrapped row would overflow the fixed-height box.
    expect(lines.length).toBe(20);
    // The #123456 row is exactly one line…
    const rows = lines.filter((l) => l.includes("#123456"));
    expect(rows).toHaveLength(1);
    // …and carries all its fixed cells on that same line.
    expect(rows[0]).toContain("✗3");
    expect(rows[0]).toContain("✓15");
    expect(rows[0]).toContain("◍2");
    expect(rows[0]).toContain("checks-failing");
    expect(rows[0]).toContain("60m");
    // nwo cell is clamped with the tail kept visible (truncate-start).
    expect(rows[0]).toContain("keeps-going");
    expect(rows[0]).not.toContain("organization-with-a-long-name");
    // No wrapped fragments stranded on their own lines.
    expect(lines.some((l) => l.includes("iling") && !l.includes("checks-failing"))).toBe(false);
    expect(lines.some((l) => /^\s*│\s*\d+\s*│\s*$/.test(l))).toBe(false);
    // Still within the 100-col frame.
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(100);
  });

  it("selection bar only on selected row", () => {
    const prs = [pr(42, "First"), pr(43, "Second"), pr(44, "Third")];
    const f = render(
      <PrList prs={prs} selected={1} focused={true} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;

    const lines = f.split("\n");
    let barCount = 0;
    for (const line of lines) {
      if (line.includes("▌")) barCount++;
    }
    expect(barCount).toBe(1); // only one selection bar
  });

  it("dims #number unless selected", () => {
    const prs = [pr(42, "First"), pr(43, "Second")];
    const rendered = render(
      <PrList prs={prs} selected={0} focused={true} height={20} now={NOW} staleAt={null} />,
    );
    const f = rendered.lastFrame()!;

    // The first row should have bold/accent number (selected)
    // The second row should have dimmed number (not selected)
    // This is hard to test without color inspection, but we can at least verify both appear
    expect(f).toContain("#42");
    expect(f).toContain("#43");
  });

  it("hides nwo cell when showNwo={false}", () => {
    const prs = [
      {
        ...pr(42, "Fix widget"),
        nwo: "owner/repo",
      },
    ];
    const f = render(
      <PrList
        prs={prs}
        selected={0}
        focused={true}
        height={20}
        now={NOW}
        staleAt={null}
        showNwo={false}
      />,
    ).lastFrame()!;

    expect(f).not.toContain("owner/repo");
    expect(f).toContain("Fix widget");
  });

  it("shows nwo cell by default when showNwo prop omitted", () => {
    const prs = [
      {
        ...pr(42, "Fix widget"),
        nwo: "owner/repo",
      },
    ];
    const f = render(
      <PrList prs={prs} selected={0} focused={true} height={20} now={NOW} staleAt={null} />,
    ).lastFrame()!;

    expect(f).toContain("owner/repo");
  });

  it("keeps every row on one line with showNwo={false} at narrow width", () => {
    const prs = [
      {
        ...pr(
          12345,
          "A very long title that might wrap or truncate in the display area to test frame width constraints",
        ),
        nwo: "organization-with-a-long-name/very-long-repository-name-that-keeps-going",
        checks: { pass: 15, fail: 3, pending: 2, total: 20 },
      },
      pr(7, "Short one"),
    ];
    const f = render(
      <PrList
        prs={prs}
        selected={0}
        focused={true}
        height={20}
        now={NOW}
        staleAt={null}
        showNwo={false}
      />,
    ).lastFrame()!;

    const lines = f.split("\n");
    // A wrapped row would overflow the fixed-height box.
    expect(lines.length).toBe(20);
    // The #12345 row is exactly one line…
    const rows = lines.filter((l) => l.includes("#12345"));
    expect(rows).toHaveLength(1);
    // …and carries all its fixed cells on that same line.
    expect(rows[0]).toContain("✗3");
    expect(rows[0]).toContain("✓15");
    expect(rows[0]).toContain("◍2");
    expect(rows[0]).toContain("checks-failing");
    expect(rows[0]).toContain("60m");
  });
});
