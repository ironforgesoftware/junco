import { describe, it, expect } from "vitest";
import {
  derivePrState,
  prStateMeta,
  sortPrs,
  filterPrs,
  reduceChecks,
  ticketSlugFromBranch,
  type DashPr,
  type PrLifecycle,
} from "../src/tui/prState.js";

const ALL_STATES: PrLifecycle[] = [
  "merged",
  "closed",
  "draft",
  "checks-failing",
  "changes-requested",
  "checks-pending",
  "approved",
  "review-pending",
];

/** Baseline "review-pending" PR — open, non-draft, no checks, no review decision. */
function pr(number: number, overrides: Partial<DashPr> = {}): DashPr {
  return {
    number,
    title: `t${number}`,
    url: `https://github.com/a/b/pull/${number}`,
    headRefName: `junco/task-${number}`,
    baseRefName: "main",
    isDraft: false,
    state: "OPEN",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checks: { pass: 0, fail: 0, pending: 0, total: 0 },
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    mergedAt: null,
    author: "alice",
    labels: [],
    nwo: "a/b",
    ...overrides,
  };
}

describe("derivePrState", () => {
  it.each([
    [{ state: "MERGED" }, "merged"],
    [{ state: "CLOSED" }, "closed"],
    [{ isDraft: true }, "draft"],
    [{ checks: { pass: 0, fail: 1, pending: 0, total: 1 } }, "checks-failing"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "changes-requested"],
    [{ checks: { pass: 0, fail: 0, pending: 1, total: 1 } }, "checks-pending"],
    [{ reviewDecision: "APPROVED" }, "approved"],
    [{}, "review-pending"],
  ] as const)("%j → %s", (overrides, expected) => {
    expect(derivePrState(pr(1, overrides as Partial<DashPr>))).toBe(expected);
  });

  it("precedence: merged wins over everything else", () => {
    expect(
      derivePrState(
        pr(1, {
          state: "MERGED",
          isDraft: true,
          checks: { pass: 0, fail: 1, pending: 0, total: 1 },
          reviewDecision: "CHANGES_REQUESTED",
        }),
      ),
    ).toBe("merged");
  });

  it("precedence: closed wins over draft/checks/review (but not merged)", () => {
    expect(
      derivePrState(
        pr(1, {
          state: "CLOSED",
          isDraft: true,
          checks: { pass: 0, fail: 1, pending: 0, total: 1 },
        }),
      ),
    ).toBe("closed");
  });

  it("precedence: draft wins over checks-failing/changes-requested/checks-pending/approved", () => {
    expect(
      derivePrState(
        pr(1, {
          isDraft: true,
          checks: { pass: 0, fail: 1, pending: 0, total: 1 },
          reviewDecision: "APPROVED",
        }),
      ),
    ).toBe("draft");
  });

  it("precedence: checks-failing wins over changes-requested/checks-pending/approved", () => {
    expect(
      derivePrState(
        pr(1, {
          checks: { pass: 0, fail: 1, pending: 1, total: 2 },
          reviewDecision: "CHANGES_REQUESTED",
        }),
      ),
    ).toBe("checks-failing");
  });

  it("precedence: changes-requested wins over checks-pending/approved", () => {
    expect(
      derivePrState(
        pr(1, {
          checks: { pass: 0, fail: 0, pending: 1, total: 1 },
          reviewDecision: "CHANGES_REQUESTED",
        }),
      ),
    ).toBe("changes-requested");
  });

  it("precedence: checks-pending wins over approved", () => {
    expect(
      derivePrState(
        pr(1, {
          checks: { pass: 0, fail: 0, pending: 1, total: 1 },
          reviewDecision: "APPROVED",
        }),
      ),
    ).toBe("checks-pending");
  });

  it("empty-string reviewDecision is treated as no decision (review-pending)", () => {
    expect(derivePrState(pr(1, { reviewDecision: "" }))).toBe("review-pending");
  });
});

describe("prStateMeta", () => {
  it("every lifecycle has a non-empty glyph, color, and badge", () => {
    for (const s of ALL_STATES) {
      const m = prStateMeta(s);
      expect(m.glyph.length).toBeGreaterThan(0);
      expect(m.color.length).toBeGreaterThan(0);
      expect(m.badge.length).toBeGreaterThan(0);
    }
  });

  it("badges are exactly the lifecycle names", () => {
    for (const s of ALL_STATES) {
      expect(prStateMeta(s).badge).toBe(s);
    }
  });

  it.each([
    ["checks-failing", "red"],
    ["changes-requested", "magenta"],
    ["checks-pending", "yellow"],
    ["review-pending", "cyan"],
    ["approved", "blue"],
    ["merged", "green"],
    ["closed", "gray"],
    ["draft", "gray"],
  ] as const)("%s uses semantic color %s", (s, color) => {
    expect(prStateMeta(s).color).toBe(color);
  });

  it("never uses the theme accent hex color", () => {
    for (const s of ALL_STATES) {
      expect(prStateMeta(s).color).not.toMatch(/^#/);
      expect(prStateMeta(s).color).not.toBe("#eb6f92");
    }
  });
});

describe("reduceChecks", () => {
  it.each([
    [undefined, { pass: 0, fail: 0, pending: 0, total: 0 }],
    [null, { pass: 0, fail: 0, pending: 0, total: 0 }],
    ["not-an-array", { pass: 0, fail: 0, pending: 0, total: 0 }],
    [42, { pass: 0, fail: 0, pending: 0, total: 0 }],
    [[], { pass: 0, fail: 0, pending: 0, total: 0 }],
  ])("non-array/null/undefined input %j → zeros", (input, expected) => {
    expect(reduceChecks(input)).toEqual(expected);
  });

  it("CheckRun: status !== COMPLETED → pending", () => {
    expect(reduceChecks([{ status: "IN_PROGRESS", conclusion: "" }])).toEqual({
      pass: 0,
      fail: 0,
      pending: 1,
      total: 1,
    });
    expect(reduceChecks([{ status: "QUEUED", conclusion: "" }])).toEqual({
      pass: 0,
      fail: 0,
      pending: 1,
      total: 1,
    });
  });

  it.each(["SUCCESS", "NEUTRAL", "SKIPPED"])(
    "CheckRun: COMPLETED with conclusion %s → pass",
    (conclusion) => {
      expect(reduceChecks([{ status: "COMPLETED", conclusion }])).toEqual({
        pass: 1,
        fail: 0,
        pending: 0,
        total: 1,
      });
    },
  );

  it("CheckRun: COMPLETED with empty-string conclusion → pending", () => {
    expect(reduceChecks([{ status: "COMPLETED", conclusion: "" }])).toEqual({
      pass: 0,
      fail: 0,
      pending: 1,
      total: 1,
    });
  });

  it.each(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STALE"])(
    "CheckRun: COMPLETED with conclusion %s → fail",
    (conclusion) => {
      expect(reduceChecks([{ status: "COMPLETED", conclusion }])).toEqual({
        pass: 0,
        fail: 1,
        pending: 0,
        total: 1,
      });
    },
  );

  it("StatusContext: state SUCCESS → pass", () => {
    expect(reduceChecks([{ state: "SUCCESS" }])).toEqual({
      pass: 1,
      fail: 0,
      pending: 0,
      total: 1,
    });
  });

  it.each(["PENDING", "EXPECTED"])("StatusContext: state %s → pending", (state) => {
    expect(reduceChecks([{ state }])).toEqual({ pass: 0, fail: 0, pending: 1, total: 1 });
  });

  it.each(["ERROR", "FAILURE"])("StatusContext: state %s → fail", (state) => {
    expect(reduceChecks([{ state }])).toEqual({ pass: 0, fail: 1, pending: 0, total: 1 });
  });

  it("mixed CheckRun + StatusContext elements reduce together", () => {
    expect(
      reduceChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "IN_PROGRESS", conclusion: "" },
        { state: "SUCCESS" },
        { state: "PENDING" },
        { state: "ERROR" },
      ]),
    ).toEqual({ pass: 2, fail: 2, pending: 2, total: 6 });
  });

  it("total is always pass+fail+pending", () => {
    const r = reduceChecks([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { state: "ERROR" },
    ]);
    expect(r.total).toBe(r.pass + r.fail + r.pending);
    expect(r).toEqual({ pass: 2, fail: 1, pending: 0, total: 3 });
  });
});

describe("ticketSlugFromBranch", () => {
  it("extracts the remainder after the prefix (prefix without trailing slash)", () => {
    expect(ticketSlugFromBranch("junco/task-123", "junco")).toBe("task-123");
  });

  it("extracts the remainder after the prefix (prefix with trailing slash already)", () => {
    expect(ticketSlugFromBranch("junco/task-123", "junco/")).toBe("task-123");
  });

  it("non-matching branch returns null", () => {
    expect(ticketSlugFromBranch("feature/hand-authored", "junco")).toBeNull();
  });

  it("empty remainder (branch is exactly the prefix) returns null", () => {
    expect(ticketSlugFromBranch("junco/", "junco")).toBeNull();
    expect(ticketSlugFromBranch("junco", "junco")).toBeNull();
  });

  it("preserves slashes within the remainder (nested slugs)", () => {
    expect(ticketSlugFromBranch("junco/sub/task-1", "junco")).toBe("sub/task-1");
  });
});

describe("sortPrs", () => {
  it("failing/changes-requested first, then pending/review, then approved, then draft, then merged/closed; updatedAt desc within group", () => {
    const failing = pr(1, {
      checks: { pass: 0, fail: 1, pending: 0, total: 1 },
      updatedAt: "2026-07-01T00:00:00Z",
    });
    const changesRequested = pr(2, {
      reviewDecision: "CHANGES_REQUESTED",
      updatedAt: "2026-07-06T00:00:00Z",
    });
    const checksPending = pr(3, {
      checks: { pass: 0, fail: 0, pending: 1, total: 1 },
      updatedAt: "2026-07-05T00:00:00Z",
    });
    const reviewPending = pr(4, { updatedAt: "2026-07-04T00:00:00Z" });
    const approved = pr(5, { reviewDecision: "APPROVED", updatedAt: "2026-07-03T00:00:00Z" });
    const draft = pr(6, { isDraft: true, updatedAt: "2026-07-02T00:00:00Z" });
    const merged = pr(7, { state: "MERGED", updatedAt: "2026-07-06T12:00:00Z" });
    const closed = pr(8, { state: "CLOSED", updatedAt: "2026-07-06T13:00:00Z" });

    const sorted = sortPrs([
      merged,
      approved,
      draft,
      closed,
      reviewPending,
      checksPending,
      changesRequested,
      failing,
    ]);

    expect(sorted.map((p) => p.number)).toEqual([2, 1, 3, 4, 5, 6, 8, 7]);
  });

  it("invalid updatedAt falls back to epoch 0 (sorts as oldest within its group)", () => {
    const good = pr(1, { updatedAt: "2026-07-01T00:00:00Z" });
    const bad = pr(2, { updatedAt: "not-a-date" });
    const sorted = sortPrs([bad, good]);
    expect(sorted.map((p) => p.number)).toEqual([1, 2]);
  });

  it("does not mutate the input array", () => {
    const a = pr(1, { updatedAt: "2026-07-01T00:00:00Z" });
    const b = pr(2, { updatedAt: "2026-07-02T00:00:00Z" });
    const input = [a, b];
    const sorted = sortPrs(input);
    expect(input).toEqual([a, b]);
    expect(sorted).not.toBe(input);
  });
});

describe("filterPrs", () => {
  const prs = [
    pr(101, { title: "Fix the frobnicator", nwo: "acme/widgets" }),
    pr(202, { title: "Add sprocket support", nwo: "acme/gadgets", isDraft: true }),
  ];

  it("blank query returns the input array identity", () => {
    expect(filterPrs(prs, "")).toBe(prs);
    expect(filterPrs(prs, "   ")).toBe(prs);
  });

  it("matches by #number", () => {
    expect(filterPrs(prs, "#101").map((p) => p.number)).toEqual([101]);
  });

  it("matches by title, case-insensitively", () => {
    expect(filterPrs(prs, "SPROCKET").map((p) => p.number)).toEqual([202]);
  });

  it("matches by nwo", () => {
    expect(filterPrs(prs, "widgets").map((p) => p.number)).toEqual([101]);
  });

  it("matches by derived badge", () => {
    expect(filterPrs(prs, "draft").map((p) => p.number)).toEqual([202]);
  });

  it("no match returns empty array", () => {
    expect(filterPrs(prs, "nonexistent")).toEqual([]);
  });
});
