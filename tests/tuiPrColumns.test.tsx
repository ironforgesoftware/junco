import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { PrList, prListColumns } from "../src/tui/components/PrList.js";
import { MAX_PR_BADGE_LEN } from "../src/tui/prState.js";
import type { DashPr } from "../src/tui/prState.js";

const pr = (n: number, title: string): DashPr =>
  ({
    number: n,
    title,
    url: "u",
    headRefName: "junco/x",
    baseRefName: "main",
    isDraft: false,
    state: "OPEN",
    reviewDecision: null,
    mergeable: null,
    mergeStateStatus: null,
    checks: { pass: 2, fail: 0, pending: 0, total: 2 },
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T11:00:00Z",
    mergedAt: null,
    author: "junco-bot",
    labels: [],
    nwo: "acme/site",
  }) as DashPr;

const props = {
  prs: [pr(1, "one"), pr(22, "two")],
  selected: 0,
  focused: true,
  height: 20,
  now: new Date("2026-07-20T12:00:00Z"),
  staleAt: null,
  window: { start: 0, end: 2 },
};

describe("columnar PrList", () => {
  it("renders header labels incl. repo and checks (showNwo)", () => {
    const { lastFrame } = render(<PrList {...props} />);
    const f = lastFrame() ?? "";
    for (const label of ["#", "title", "repo", "checks", "state", "age"]) {
      expect(f).toContain(label);
    }
  });
  it("omits the repo column when showNwo is false", () => {
    const { lastFrame } = render(<PrList {...props} showNwo={false} />);
    expect(lastFrame()).not.toContain("repo");
  });
  it("badge width covers the longest pr badge", () => {
    expect(MAX_PR_BADGE_LEN).toBeGreaterThanOrEqual("checks-failing".length);
  });
  it("truncates 5+-digit PR numbers to preserve row height", () => {
    const largeNumPrs = [pr(123456, "large id")];
    const { lastFrame: smallFrame } = render(
      <PrList {...props} prs={[pr(1, "one")]} window={{ start: 0, end: 1 }} />,
    );
    const { lastFrame: largeFrame } = render(
      <PrList {...props} prs={largeNumPrs} window={{ start: 0, end: 1 }} />,
    );
    const smallLines = (smallFrame() ?? "").split("\n").length;
    const largeLines = (largeFrame() ?? "").split("\n").length;
    expect(largeLines).toBe(smallLines);
    expect(largeFrame()).toMatch(/…3456/);
  });
});

describe("PrList narrow-pane overflow clamp (pane-3 @ 110-col geometry)", () => {
  // App.tsx's pane-3 wrapper at a 110-col terminal: previewWidth = min(60,
  // floor(110*0.4)) = 44 (src/tui/layout.ts). Interior available to the row
  // content is 44 − 2 (round border) − 2 (paddingX) = 40 columns.
  const HEIGHT = 10;

  function renderPane(prs: DashPr[]): string {
    return (
      render(
        <Box width={44} height={HEIGHT}>
          <PrList
            prs={prs}
            selected={0}
            focused={true}
            height={HEIGHT}
            now={new Date("2026-07-20T12:00:00Z")}
            staleAt={null}
            window={{ start: 0, end: prs.length }}
            showNwo={false}
          />
        </Box>,
      ).lastFrame() ?? ""
    );
  }

  // Worst case: one row hits the widest lifecycle badge ("changes-requested",
  // 17 chars — same as MAX_PR_BADGE_LEN), another carries a double-digit
  // checks string (✓15). Together their fixed cells structurally exceed the
  // 40-col interior even after the dataset-derived pill-width fix — the
  // overflow="hidden" belts are what keep this from painting past the border.
  const worstPrs: DashPr[] = [
    { ...pr(1, "PR one"), checks: { pass: 15, fail: 3, pending: 2, total: 20 } } as DashPr,
    { ...pr(2, "PR two"), reviewDecision: "CHANGES_REQUESTED" } as DashPr,
    pr(3, "PR three"),
  ];

  // Benign case: same row count, single-digit checks, no changes-requested
  // row — the everyday dataset the pill-width fix is meant to help.
  const benignPrs: DashPr[] = [
    { ...pr(1, "PR one"), checks: { pass: 1, fail: 0, pending: 0, total: 1 } } as DashPr,
    pr(2, "PR two"),
    pr(3, "PR three"),
  ];

  it("keeps every row on one line and within the pane's outer width, worst case or benign", () => {
    const worstLines = renderPane(worstPrs).split("\n");
    const benignLines = renderPane(benignPrs).split("\n");

    // No wrapped lines: both renders occupy exactly the same fixed height.
    expect(worstLines.length).toBe(benignLines.length);

    for (const line of worstLines) {
      expect(line.length).toBeLessThanOrEqual(44);
    }
    for (const line of benignLines) {
      expect(line.length).toBeLessThanOrEqual(44);
    }
  });

  function renderPaneBudgeted(prs: DashPr[], paneWidth: number): string {
    return (
      render(
        <Box width={paneWidth} height={HEIGHT}>
          <PrList
            prs={prs}
            selected={0}
            focused={true}
            height={HEIGHT}
            now={new Date("2026-07-20T12:00:00Z")}
            staleAt={null}
            window={{ start: 0, end: prs.length }}
            showNwo={false}
            paneWidth={paneWidth}
          />
        </Box>,
      ).lastFrame() ?? ""
    );
  }

  it("drops the checks column rather than the age column when the pane is tight", () => {
    const f = renderPaneBudgeted(worstPrs, 44);
    expect(f).toContain("age"); // the header cell survives…
    // worstPrs' updatedAt is exactly 60 minutes before `now`, and relTime's
    // `m <= 60` branch renders that as "60m" (not "1h") — see IssueList.tsx.
    expect(f).toContain("60m"); // …and so do the row values
    // Check the HEADER row specifically, not the whole frame: worstPrs' first
    // row has checks.fail > 0, so its lifecycle is "checks-failing" — a state
    // pill whose badge text literally contains the substring "checks". A
    // whole-frame assertion would false-fail on that pill text even though the
    // checks *column* is correctly gone.
    const headerLine = f.split("\n").find((l) => l.includes("title")) ?? "";
    expect(headerLine).not.toContain("checks");
  });

  it("keeps the checks column when the pane is wide enough", () => {
    // previewWidth caps at 60 (layout.ts PREVIEW_CAP) — the widest pane 3 gets.
    const f = renderPaneBudgeted(worstPrs, 60);
    expect(f).toContain("checks");
    expect(f).toContain("age");
  });

  it("budgets nothing when paneWidth is absent (the full-width PRs view)", () => {
    const spec = prListColumns({ prs: worstPrs, showNwo: true });
    expect(spec.showChecks).toBe(true);
  });
});

describe("prListColumns (dataset-derived widths)", () => {
  const widthOf = (cols: ReturnType<typeof prListColumns>["columns"], label: string): number => {
    const c = cols.find((x) => x.label === label);
    if (c === undefined || c.width === "flex") throw new Error(`no fixed column "${label}"`);
    return c.width;
  };

  it("sizes the state column to the widest badge PRESENT, not the global max", () => {
    // Every fixture row is plain OPEN → "review-pending" (14), so the pill must
    // be 16 — NOT 19, which the global MAX_PR_BADGE_LEN ("changes-requested",
    // 17) would reserve.
    const benign = prListColumns({ prs: [pr(1, "one"), pr(2, "two")], showNwo: false });
    expect(benign.pillInner).toBe("review-pending".length);
    expect(widthOf(benign.columns, "state")).toBe("review-pending".length + 2);
  });

  it("grows the state column when a wider badge enters the dataset", () => {
    const withWide = prListColumns({
      prs: [pr(1, "one"), { ...pr(2, "two"), reviewDecision: "CHANGES_REQUESTED" } as DashPr],
      showNwo: false,
    });
    expect(withWide.pillInner).toBe("changes-requested".length);
    expect(widthOf(withWide.columns, "state")).toBe("changes-requested".length + 2);
  });

  it("never falls below the header labels' own widths", () => {
    const empty = prListColumns({ prs: [], showNwo: true });
    expect(empty.pillInner).toBe("state".length);
    expect(empty.repoW).toBe("repo".length);
    expect(empty.checksW).toBe("checks".length);
  });

  it("omits the repo column when showNwo is false", () => {
    const cols = prListColumns({ prs: [pr(1, "one")], showNwo: false }).columns;
    expect(cols.some((c) => c.label === "repo")).toBe(false);
  });
});
