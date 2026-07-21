import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { QueueView } from "../src/tui/components/QueueView.js";
import {
  queueLabel,
  fmtElapsed,
  fmtAge,
  fmtTokens,
  fmtClock,
  fmtCompact,
  fmtAgeShort,
  fmtAssessIndicator,
  fmtDurShort,
  fmtSpark,
  oldestQueuedAt,
} from "../src/tui/queueFmt.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";
import type { QueueStats } from "../src/tui/queueStats.js";
import type { AssessHistory } from "../src/assessHistory.js";

const NOW = new Date("2026-07-07T10:05:00Z");

const IDLE: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  taskTimeoutSeconds: null,
  running: [],
  waiting: [],
  recent: [],
  error: null,
  outboxDepth: 0,
  stats: null,
};

const BUSY: QueueSnapshot = {
  ...IDLE,
  running: [
    {
      id: "gh-acme-api-46",
      github: { nwo: "acme/api", issue: 46, kind: "pr", external: false },
      turns: 14,
      lastTool: "bash",
      outputTokens: 12345,
      startedAt: "2026-07-07T10:00:28Z",
      updatedAt: null,
      stale: false,
      repoPath: null,
    },
  ],
  waiting: [
    {
      id: "gh-acme-api-51-plan",
      github: { nwo: "acme/api", issue: 51, kind: "plan", external: false },
      kind: "plan",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
      queuedAt: null,
      repoPath: null,
    },
    {
      id: "manual-tide-fix",
      github: null,
      kind: "pr",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
      queuedAt: null,
      repoPath: null,
    },
    {
      id: "gh-acme-api-52-plan",
      github: { nwo: "acme/api", issue: 52, kind: "plan", external: false },
      kind: "plan",
      priority: "normal",
      retryCount: 1,
      notBefore: "2026-07-07T11:00:00Z",
      deferred: true,
      queuedAt: null,
      repoPath: null,
    },
    {
      id: "gh-acme-api-53-plan",
      github: { nwo: "acme/api", issue: 53, kind: "plan", external: false },
      kind: "plan",
      priority: "low",
      retryCount: 0,
      notBefore: null,
      deferred: false,
      queuedAt: null,
      repoPath: null,
    },
  ],
};

describe("queueFmt", () => {
  it("queueLabel: bridged → #N word (pr→exec); manual → truncated id", () => {
    expect(queueLabel({ nwo: "a/b", issue: 46, kind: "pr", external: false }, "x")).toBe(
      "#46 exec",
    );
    expect(queueLabel({ nwo: "a/b", issue: 9, kind: "plan", external: false }, "x")).toBe(
      "#9 plan",
    );
    expect(queueLabel({ nwo: "a/b", issue: 3, kind: "ask", external: false }, "x")).toBe("#3 ask");
    expect(queueLabel(null, "manual-tide-fix")).toBe("manual-tide-fix");
    expect(queueLabel(null, "a".repeat(30))).toBe("a".repeat(23) + "…");
  });

  it("fmtElapsed buckets and guards", () => {
    expect(fmtElapsed("2026-07-07T10:04:15Z", NOW)).toBe("45s");
    expect(fmtElapsed("2026-07-07T10:00:28Z", NOW)).toBe("4m32s");
    expect(fmtElapsed("2026-07-07T08:53:00Z", NOW)).toBe("1h12m");
    expect(fmtElapsed(null, NOW)).toBeNull();
    expect(fmtElapsed("garbage", NOW)).toBeNull();
    expect(fmtElapsed("2026-07-07T11:00:00Z", NOW)).toBeNull(); // future
  });

  it("fmtAge / fmtTokens / fmtClock", () => {
    expect(fmtAge("2026-07-07T09:53:00Z", NOW)).toBe("12m ago");
    expect(fmtAge("2026-07-05T10:05:00Z", NOW)).toBe("2d ago");
    expect(fmtTokens(740)).toBe("740 tok");
    expect(fmtTokens(12345)).toBe("12.3k tok");
    expect(fmtTokens(null)).toBeNull();
    expect(fmtClock("2026-07-07T11:00:00Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("fmtCompact: one decimal, trailing .0 stripped", () => {
    expect(fmtCompact(0)).toBe("0");
    expect(fmtCompact(740)).toBe("740");
    expect(fmtCompact(999)).toBe("999");
    expect(fmtCompact(1200)).toBe("1.2k");
    expect(fmtCompact(1000)).toBe("1k"); // trailing .0 stripped
    expect(fmtCompact(3_400_000)).toBe("3.4M");
    expect(fmtCompact(1_000_000)).toBe("1M");
  });

  it("fmtCompact boundary: values that would round to 1000k roll into the M bucket", () => {
    expect(fmtCompact(999_949)).toBe("999.9k"); // still rounds below 1000k
    expect(fmtCompact(999_950)).toBe("1M"); // would render "1000.0k" — rolled
    expect(fmtCompact(999_999)).toBe("1M"); // never "1000k"
  });

  it("fmtDurShort: s / m / h+m buckets, floors, clamps negatives", () => {
    expect(fmtDurShort(0)).toBe("0s");
    expect(fmtDurShort(45)).toBe("45s");
    expect(fmtDurShort(59)).toBe("59s");
    expect(fmtDurShort(60)).toBe("1m");
    expect(fmtDurShort(720)).toBe("12m"); // avg/ETA column form
    expect(fmtDurShort(3599)).toBe("59m");
    expect(fmtDurShort(3600)).toBe("1h0m");
    expect(fmtDurShort(7980)).toBe("2h13m");
    expect(fmtDurShort(-5)).toBe("0s"); // negative clamps rather than going odd
  });

  it("fmtSpark: one glyph per value scaled to the series max (0 pins to ▁)", () => {
    expect(fmtSpark([0, 0])).toBe("▁▁"); // all-zero → all floor, no divide-by-zero
    expect(fmtSpark([1, 8])).toBe("▂█"); // scaled to max 8: full bar + a low bar
    expect(fmtSpark([5])).toBe("█"); // a lone value is its own max → full bar
    expect(fmtSpark([0, 4, 8]).length).toBe(3); // one glyph per value
    for (const g of fmtSpark([3, 1, 9, 0, 7])) expect("▁▂▃▄▅▆▇█").toContain(g);
  });

  it("oldestQueuedAt: earliest eligible queuedAt, skipping deferred + nulls", () => {
    expect(
      oldestQueuedAt([
        { queuedAt: "2026-07-07T09:50:00Z", deferred: false },
        { queuedAt: "2026-07-07T09:23:00Z", deferred: false }, // earliest eligible
        { queuedAt: "2026-07-07T08:00:00Z", deferred: true }, // older but deferred → skip
        { queuedAt: null, deferred: false }, // null → skip
      ]),
    ).toBe("2026-07-07T09:23:00Z");
    expect(oldestQueuedAt([])).toBeNull();
    expect(oldestQueuedAt([{ queuedAt: null, deferred: false }])).toBeNull();
    expect(oldestQueuedAt([{ queuedAt: "2026-07-07T09:00:00Z", deferred: true }])).toBeNull();
  });
});

const NOW2 = new Date("2026-07-16T12:00:00.000Z");
function hist(p: Partial<AssessHistory>): AssessHistory {
  return {
    id: "o/r",
    lastSuccessAt: null,
    lastFound: null,
    lastParked: null,
    lastFailureAt: null,
    lastFailureReason: null,
    ...p,
  };
}

describe("fmtAgeShort", () => {
  it("compact buckets with no ' ago' suffix", () => {
    expect(fmtAgeShort("2026-07-16T11:59:30.000Z", NOW2)).toBe("30s");
    expect(fmtAgeShort("2026-07-16T11:30:00.000Z", NOW2)).toBe("30m");
    expect(fmtAgeShort("2026-07-16T10:00:00.000Z", NOW2)).toBe("2h");
    expect(fmtAgeShort("2026-06-25T12:00:00.000Z", NOW2)).toBe("21d");
  });
  it("caps at 99d+ so the fixed indicator column cannot be blown out", () => {
    expect(fmtAgeShort("2020-01-01T00:00:00.000Z", NOW2)).toBe("99d+");
  });
  it("clamps a future timestamp to 0s rather than going negative", () => {
    expect(fmtAgeShort("2027-01-01T00:00:00.000Z", NOW2)).toBe("0s");
  });
  // #204: pin the exact bucket edges (s = 60 / 3600 / 86400) so a `<`→`<=` slip
  // would be caught; times expressed as offsets from NOW2 to be precise.
  it("bucket edges are exact (59s→1m, 59m→1h, 23h→1d)", () => {
    const at = (ms: number) => new Date(NOW2.getTime() - ms).toISOString();
    expect(fmtAgeShort(at(59_000), NOW2)).toBe("59s");
    expect(fmtAgeShort(at(60_000), NOW2)).toBe("1m");
    expect(fmtAgeShort(at(3_599_000), NOW2)).toBe("59m");
    expect(fmtAgeShort(at(3_600_000), NOW2)).toBe("1h");
    expect(fmtAgeShort(at(86_399_000), NOW2)).toBe("23h");
    expect(fmtAgeShort(at(86_400_000), NOW2)).toBe("1d");
  });
  it("day cap edge: 99d shows, 100d caps to 99d+", () => {
    const at = (ms: number) => new Date(NOW2.getTime() - ms).toISOString();
    expect(fmtAgeShort(at(99 * 86_400_000), NOW2)).toBe("99d");
    expect(fmtAgeShort(at(100 * 86_400_000), NOW2)).toBe("99d+");
  });
});

describe("fmtAssessIndicator", () => {
  it("never assessed", () => {
    expect(fmtAssessIndicator(null, NOW2)).toBe("—");
  });
  it("clean audit", () => {
    const h = hist({ lastSuccessAt: "2026-07-16T10:00:00.000Z", lastFound: 0, lastParked: 0 });
    expect(fmtAssessIndicator(h, NOW2)).toBe("2h 0✓");
  });
  it("audit with findings", () => {
    const h = hist({ lastSuccessAt: "2026-06-25T12:00:00.000Z", lastFound: 4, lastParked: 3 });
    expect(fmtAssessIndicator(h, NOW2)).toBe("21d 4⚠");
  });
  it("failed last attempt marks the age but does not move it", () => {
    const h = hist({
      lastSuccessAt: "2026-06-25T12:00:00.000Z",
      lastFound: 4,
      lastParked: 3,
      lastFailureAt: "2026-07-16T11:00:00.000Z",
      lastFailureReason: "boom",
    });
    expect(fmtAssessIndicator(h, NOW2)).toBe("21d! 4⚠");
  });
  it("failed with no prior success", () => {
    const h = hist({ lastFailureAt: "2026-07-16T11:00:00.000Z", lastFailureReason: "boom" });
    expect(fmtAssessIndicator(h, NOW2)).toBe("— !");
  });
  it("caps the count at 99+ to bound the column", () => {
    const h = hist({ lastSuccessAt: "2026-07-16T10:00:00.000Z", lastFound: 250, lastParked: 250 });
    expect(fmtAssessIndicator(h, NOW2)).toBe("2h 99+⚠");
  });
  // #204: exact count-cap edge (99 shows, 100 caps) + the failed-with-0-findings
  // combo (failed marker on the age AND the 0✓ clean-count branch).
  it("count-cap edge: 99 shows, 100 caps to 99+", () => {
    const base = { lastSuccessAt: "2026-07-16T10:00:00.000Z", lastParked: 0 };
    expect(fmtAssessIndicator(hist({ ...base, lastFound: 99 }), NOW2)).toBe("2h 99⚠");
    expect(fmtAssessIndicator(hist({ ...base, lastFound: 100 }), NOW2)).toBe("2h 99+⚠");
  });
  it("failed last attempt with zero findings marks the age and keeps 0✓", () => {
    const h = hist({
      lastSuccessAt: "2026-07-16T10:00:00.000Z",
      lastFound: 0,
      lastParked: 0,
      lastFailureAt: "2026-07-16T11:00:00.000Z",
      lastFailureReason: "boom",
    });
    expect(fmtAssessIndicator(h, NOW2)).toBe("2h! 0✓");
  });
});

// QueueStrip was deleted in the workspace switch; the rail's compact queue card
// (tests/tuiRail.test.tsx) covers its role now.

describe("QueueView", () => {
  const FULL: QueueSnapshot = {
    ...BUSY,
    recent: [
      {
        id: "gh-acme-api-44",
        github: { nwo: "acme/api", issue: 44, kind: "pr", external: false },
        status: "done",
        finishedAt: "2026-07-07T09:53:00Z",
        resultStatus: null,
        durationSeconds: null,
        prUrl: null,
        repoPath: null,
      },
      {
        id: "gh-acme-api-40",
        github: { nwo: "acme/api", issue: 40, kind: "pr", external: false },
        status: "failed",
        finishedAt: "2026-07-07T09:05:00Z",
        resultStatus: null,
        durationSeconds: null,
        prUrl: null,
        repoPath: null,
      },
    ],
  };

  // Full derived stats (ledger populated): every segment present.
  const STATS_FULL: QueueStats = {
    gate: null,
    lastPollAt: "2026-07-07T10:04:58Z", // 2s before NOW
    window24h: {
      done: 14,
      failed: 2,
      successRate: 0.88,
      avgDurationSeconds: 720, // 12m
      tokensIn: 1_200_000,
      tokensOut: 340_000,
      costUsd: 4.2,
    },
    perDay7d: [
      { done: 10, failed: 1 },
      { done: 12, failed: 2 },
      { done: 8, failed: 0 },
      { done: 15, failed: 3 },
      { done: 11, failed: 1 },
      { done: 14, failed: 2 },
      { done: 14, failed: 0 },
    ], // Σ done 84, Σ failed 9
    etaSeconds: 2160, // 36m
    spend: { todayUsd: 4.2, dailyBudgetUsd: 10 },
    guards: { nudges: 1, kills: 0, requeues: 3 },
    outbox: { depth: 2, dead: 0 },
    pendingRestartFields: ["max_concurrent"],
  };

  // Fresh-upgrade fallback (empty ledger): avg/ETA/7d/tokens/spend/guards null.
  const STATS_FALLBACK: QueueStats = {
    gate: null,
    lastPollAt: null,
    window24h: {
      done: 3,
      failed: 1,
      successRate: 0.75,
      avgDurationSeconds: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
    },
    perDay7d: [],
    etaSeconds: null,
    spend: null,
    guards: null,
    outbox: { depth: 0, dead: 0 },
    pendingRestartFields: [],
  };

  const mkStats = (over: Partial<QueueStats>): QueueStats => ({ ...STATS_FALLBACK, ...over });

  const frameOf = (snap: QueueSnapshot): string =>
    render(<QueueView snap={snap} scroll={0} now={NOW} height={40} focused={false} />).lastFrame()!;

  const runRow = (
    over: Partial<QueueSnapshot["running"][number]>,
  ): QueueSnapshot["running"][number] => ({
    id: "run-1",
    github: null,
    turns: 3,
    lastTool: "bash",
    outputTokens: 100,
    startedAt: "2026-07-07T10:00:00Z",
    updatedAt: null,
    stale: false,
    repoPath: null,
    ...over,
  });

  const wRow = (
    over: Partial<QueueSnapshot["waiting"][number]>,
  ): QueueSnapshot["waiting"][number] => ({
    id: "w",
    github: null,
    kind: "pr",
    priority: "normal",
    retryCount: 0,
    notBefore: null,
    deferred: false,
    queuedAt: null,
    repoPath: null,
    ...over,
  });

  it("renders all three sections with detail", () => {
    const frame = render(
      <QueueView snap={FULL} scroll={0} now={NOW} height={20} focused={false} />,
    ).lastFrame()!;
    expect(frame).toContain("running (1/1)");
    expect(frame).toContain("#46 exec");
    expect(frame).toContain("gh-acme-api-46"); // dim id next to the label
    expect(frame).toContain("turn 14 · bash · 12.3k tok · 4m32s");
    // BUSY's 4th waiting row is deferred, so the header surfaces the count.
    expect(frame).toContain("waiting (4 · 1 deferred)");
    expect(frame).toContain("1. #51 plan");
    expect(frame).toContain("2. manual-tide-fix");
    expect(frame).toContain("retry 1");
    expect(frame).toContain("not before");
    expect(frame).toContain("⏲ deferred");
    expect(frame).toContain("low"); // non-normal priority shown
    expect(frame).toContain("recent");
    expect(frame).toContain("✓ #44 exec");
    expect(frame).toContain("12m ago");
    expect(frame).toContain("✗ #40 exec");
  });

  it("renders dim placeholders for empty sections", () => {
    const frame = render(
      <QueueView snap={IDLE} scroll={0} now={NOW} height={20} focused={false} />,
    ).lastFrame()!;
    expect(frame).toContain("running (0/1)");
    expect(frame).toContain("waiting (0)");
    // Empty sections show an em-dash placeholder.
    expect(frame.split("—").length).toBeGreaterThanOrEqual(3);
  });

  it("scroll slices rendered rows", () => {
    // FULL is 14 rows; height must keep the pane shorter than that so scroll=6
    // is within maxScroll and actually slices (rather than clamping to 0).
    const top = render(
      <QueueView snap={FULL} scroll={0} now={NOW} height={11} focused={false} />,
    ).lastFrame()!;
    const scrolled = render(
      <QueueView snap={FULL} scroll={6} now={NOW} height={11} focused={false} />,
    ).lastFrame()!;
    expect(top).toContain("running");
    expect(scrolled).not.toContain("running (1/1)");
  });

  it("loading state", () => {
    expect(
      render(
        <QueueView snap={null} scroll={0} now={NOW} height={20} focused={false} />,
      ).lastFrame(),
    ).toContain("loading…");
  });

  it("default-absent props render byte-identical (no cursor glyph)", () => {
    const base = render(
      <QueueView snap={FULL} scroll={0} now={NOW} height={20} focused={false} />,
    ).lastFrame()!;
    const withFalse = render(
      <QueueView snap={FULL} scroll={0} now={NOW} height={20} focused={false} selectable={false} />,
    ).lastFrame()!;
    expect(withFalse).toBe(base);
    expect(base).not.toContain("▌");
  });

  it("selectable path: cursor marks the first WAITING row, never RUNNING", () => {
    const frame = render(
      <QueueView
        snap={FULL}
        scroll={0}
        now={NOW}
        height={30}
        focused={false}
        selectable
        selectedRow={0}
      />,
    ).lastFrame()!;
    expect(frame).toContain("▌"); // cursor present
    expect(frame).toContain("1. #51 plan"); // still the first waiting row
    // RUNNING row (◐ + label) carries no cursor glyph on its line.
    const runLine = frame.split("\n").find((l) => l.includes("#46 exec"))!;
    expect(runLine).not.toContain("▌");
  });

  it("selectable path: selectedRow past WAITING lands on a RECENT row", () => {
    // waiting.length === 4, so index 4 is the first RECENT row (#44).
    const frame = render(
      <QueueView
        snap={FULL}
        scroll={0}
        now={NOW}
        height={30}
        focused={false}
        selectable
        selectedRow={4}
      />,
    ).lastFrame()!;
    const recLine = frame.split("\n").find((l) => l.includes("#44 exec"))!;
    expect(recLine).toContain("▌");
  });

  it("counts render the full done/failed totals (LOCAL only; absent = no line)", () => {
    const withCounts = render(
      <QueueView
        snap={FULL}
        scroll={0}
        now={NOW}
        height={30}
        focused={false}
        selectable
        selectedRow={0}
        counts={{ done: 12, failed: 3 }}
      />,
    ).lastFrame()!;
    expect(withCounts).toContain("DONE 12");
    expect(withCounts).toContain("FAILED 3");
    // Absent (GitHub `t`) → no totals line.
    const noCounts = render(
      <QueueView snap={FULL} scroll={0} now={NOW} height={30} focused={false} />,
    ).lastFrame()!;
    expect(noCounts).not.toContain("DONE 12");
  });

  it("cursor-following window keeps a selected row past the fold visible", () => {
    // A WAITING list far larger than fits: with no scroll-follow the cursor
    // would drop below the fold and highlight an off-screen row.
    const many: QueueSnapshot = {
      ...IDLE,
      waiting: Array.from({ length: 20 }, (_, i) => ({
        id: `wait-${i}`,
        github: null,
        kind: "pr" as const,
        priority: "normal" as const,
        retryCount: 0,
        notBefore: null,
        deferred: false,
        queuedAt: null,
        repoPath: null,
      })),
    };
    const frame = render(
      <QueueView
        snap={many}
        scroll={0}
        now={NOW}
        height={10} // ~7 visible rows — the last waiting row is well past the fold
        focused={false}
        selectable
        selectedRow={19} // last waiting row
      />,
    ).lastFrame()!;
    // The highlighted row is inside the rendered window, carrying the cursor…
    const selLine = frame.split("\n").find((l) => l.includes("wait-19"));
    expect(selLine).toBeDefined();
    expect(selLine!).toContain("▌");
    // …and the window actually moved (a top row scrolled off).
    expect(frame).not.toContain("wait-0 ");
  });

  it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
    const many: QueueSnapshot = {
      ...IDLE,
      waiting: Array.from({ length: 12 }, (_, i) => ({
        id: `manual-row-${String(i).padStart(2, "0")}`,
        github: null,
        kind: "pr" as const,
        priority: "normal" as const,
        retryCount: 0,
        notBefore: null,
        deferred: false,
        queuedAt: null,
        repoPath: null,
      })),
    };
    const f = render(
      <QueueView snap={many} scroll={999} now={NOW} height={8} focused />,
    ).lastFrame()!;
    expect(f).toContain("row-11"); // the last row is on screen…
    expect(f).not.toContain("row-00"); // …and the window really did stop at the bottom
  });

  it("reports its max scroll to the owner", () => {
    let reported: number | null = null;
    render(
      <QueueView
        snap={IDLE}
        scroll={0}
        now={NOW}
        // IDLE still renders 9 fixed rows (title/headers/blank spacers/dashes
        // for each empty section), so height must clear that floor for the
        // queue to genuinely "fit" — height=15 gives visible=12.
        height={15}
        focused
        onScrollMax={(m) => {
          reported = m;
        }}
      />,
    );
    expect(reported).toBe(0); // an idle queue fits — nothing to scroll
  });

  // ── Task 8: monitoring surface ──────────────────────────────────────────

  it("gate ≠ ok renders a paused banner under the title (retry when until set)", () => {
    const f = frameOf({
      ...IDLE,
      stats: mkStats({
        gate: { state: "rate_limited", reason: "429 from provider", until: "2026-07-07T11:00:00Z" },
      }),
    });
    expect(f).toContain("▸ paused — rate limited"); // underscores → spaces
    expect(f).toMatch(/▸ paused — rate limited \(retry \d{2}:\d{2}\)/);
  });

  it("paused banner: no until falls back to ` — reason`", () => {
    const f = frameOf({
      ...IDLE,
      stats: mkStats({ gate: { state: "auth_error", reason: "invalid key", until: null } }),
    });
    expect(f).toContain("▸ paused — auth error — invalid key");
  });

  it("gate ok/null renders no paused banner", () => {
    expect(
      frameOf({ ...IDLE, stats: mkStats({ gate: { state: "ok", reason: null, until: null } }) }),
    ).not.toContain("paused");
    expect(frameOf({ ...IDLE, stats: mkStats({ gate: null }) })).not.toContain("paused");
  });

  it("daemon up + lastPollAt → RUNNING header shows the poll heartbeat", () => {
    const f = frameOf({
      ...IDLE,
      daemonUp: true,
      stats: mkStats({ lastPollAt: "2026-07-07T10:04:58Z" }),
    });
    expect(f).toContain("· ↻ poll 2s ago");
  });

  it("daemon down → RUNNING header carries no heartbeat", () => {
    const f = frameOf({
      ...IDLE,
      daemonUp: false,
      stats: mkStats({ lastPollAt: "2026-07-07T10:04:58Z" }),
    });
    expect(f).not.toContain("↻ poll");
    expect(f).toContain("running (0/1)");
  });

  it("running row idle past STALL_MS → a `no activity` line", () => {
    const f = frameOf({ ...IDLE, running: [runRow({ updatedAt: "2026-07-07T09:59:00Z" })] });
    expect(f).toContain("⚠ no activity 6m");
  });

  it("fresh running row → no stall line", () => {
    const f = frameOf({ ...IDLE, running: [runRow({ updatedAt: "2026-07-07T10:04:00Z" })] });
    expect(f).not.toContain("no activity");
  });

  it("stale (daemon-down) running row → no stall line even with an old updatedAt", () => {
    const f = frameOf({
      ...IDLE,
      running: [runRow({ updatedAt: "2026-07-07T09:59:00Z", stale: true })],
    });
    expect(f).not.toContain("no activity");
  });

  it("WAITING header surfaces deferred count + oldest-eligible age", () => {
    const f = frameOf({
      ...IDLE,
      waiting: [
        wRow({ id: "w1", queuedAt: "2026-07-07T09:23:00Z" }), // 42m — earliest eligible
        wRow({ id: "w2", queuedAt: "2026-07-07T09:50:00Z" }),
        wRow({
          id: "w3",
          queuedAt: "2026-07-07T08:00:00Z", // older, but deferred → excluded from oldest
          deferred: true,
          notBefore: "2026-07-07T11:00:00Z",
        }),
      ],
    });
    expect(f).toContain("waiting (3 · 1 deferred · oldest 42m)");
  });

  it("WAITING header stays plain with no deferred + no queuedAt", () => {
    const f = frameOf({
      ...IDLE,
      waiting: [wRow({ id: "a" }), wRow({ id: "b" }), wRow({ id: "c" })],
    });
    expect(f).toContain("waiting (3)");
    expect(f).not.toContain("deferred");
    expect(f).not.toContain("oldest");
  });

  it("waiting row with queuedAt → trailing dim `queued` age (· after a note)", () => {
    const f = frameOf({
      ...IDLE,
      waiting: [wRow({ id: "w-hi", priority: "high", queuedAt: "2026-07-07T09:23:00Z" })],
    });
    expect(f).toContain("· queued 42m");
  });

  it("recent row with result meta → status + duration + `·` age", () => {
    const f = frameOf({
      ...IDLE,
      recent: [
        {
          id: "gh-acme-api-45",
          github: { nwo: "acme/api", issue: 45, kind: "pr", external: false },
          status: "done",
          finishedAt: "2026-07-07T08:05:00Z", // 2h ago
          resultStatus: "completed",
          durationSeconds: 660, // 11m
          prUrl: null,
          repoPath: null,
        },
      ],
    });
    expect(f).toContain("✓ #45 exec completed 11m · 2h ago");
  });

  it("recent row without result meta → today's exact rendering (no status, no `·`)", () => {
    const f = frameOf({
      ...IDLE,
      recent: [
        {
          id: "gh-acme-api-45",
          github: { nwo: "acme/api", issue: 45, kind: "pr", external: false },
          status: "done",
          finishedAt: "2026-07-07T09:53:00Z", // 12m ago
          resultStatus: null,
          durationSeconds: null,
          prUrl: null,
          repoPath: null,
        },
      ],
    });
    const line = f.split("\n").find((l) => l.includes("#45"))!;
    expect(line).toContain("✓ #45 exec 12m ago");
    expect(line).not.toContain("·");
  });

  it("STATS section renders all four content lines + restart notice", () => {
    const f = frameOf({ ...IDLE, stats: STATS_FULL });
    expect(f).toContain("stats");
    expect(f).toContain("24h 14✓ 2✗ (88%) · avg 12m · ETA ~36m");
    const sevenD = f.split("\n").find((l) => l.includes("7d 84✓ 9✗"));
    expect(sevenD).toBeDefined();
    // The spark run trailing the counts — one glyph per day, all from the ramp.
    const spark = sevenD!.match(/7d 84✓ 9✗ ([▁▂▃▄▅▆▇█]+)/);
    expect(spark).not.toBeNull();
    expect(spark![1].length).toBe(7);
    expect(f).toContain("spend $4.20/$10.00 · tok 1.2M in 340k out");
    expect(f).toContain("guards 1 nudge · 3 requeues · outbox 2 queued");
    expect(f).toContain("⚠ restart to apply: max_concurrent");
  });

  it("STATS section omits null-derived segments (fallback stats)", () => {
    const f = frameOf({ ...IDLE, stats: STATS_FALLBACK });
    expect(f).toContain("stats");
    expect(f).toContain("24h 3✓ 1✗ (75%)"); // counts + rate survive
    expect(f).not.toContain("avg "); // avgDurationSeconds null
    expect(f).not.toContain("ETA"); // etaSeconds null
    expect(f).not.toContain("7d "); // perDay7d empty → line absent
    expect(f).not.toContain("tok"); // spend+tok line omitted entirely
    expect(f).not.toContain("spend");
    expect(f).not.toContain("guards"); // guards null + outbox empty → line absent
  });

  it("guards+outbox line: outbox-only (guards null) renders with no `guards ` label prefix", () => {
    const f = frameOf({
      ...IDLE,
      stats: mkStats({ guards: null, outbox: { depth: 2, dead: 0 } }),
    });
    const line = f.split("\n").find((l) => l.includes("outbox"))!;
    expect(line).toContain("outbox 2 queued");
    expect(line).not.toContain("guards");
  });

  it("guards+outbox line: all-zero guards (present but 0/0/0) also drops the `guards ` label", () => {
    const f = frameOf({
      ...IDLE,
      stats: mkStats({
        guards: { nudges: 0, kills: 0, requeues: 0 },
        outbox: { depth: 2, dead: 0 },
      }),
    });
    const line = f.split("\n").find((l) => l.includes("outbox"))!;
    expect(line).toContain("outbox 2 queued");
    expect(line).not.toContain("guards");
  });

  it("guards+outbox line: singular at 1, plural otherwise, for nudges/kills/requeues", () => {
    const f = frameOf({
      ...IDLE,
      stats: mkStats({
        guards: { nudges: 1, kills: 1, requeues: 2 },
        outbox: { depth: 0, dead: 0 },
      }),
    });
    expect(f).toContain("guards 1 nudge · 1 kill · 2 requeues");
  });

  it("stats: null → no STATS section at all", () => {
    expect(frameOf(FULL)).not.toContain("stats"); // FULL.stats is null
  });

  it("selectable index is stable when STATS renders — cursor stays on the same RECENT ticket", () => {
    const props = {
      scroll: 0,
      now: NOW,
      height: 40,
      focused: false,
      selectable: true,
      selectedRow: 4, // waiting.length (4) + 0 → first RECENT row (#44)
      onRowPress: (): void => {},
    };
    const noStats = render(<QueueView snap={FULL} {...props} />).lastFrame()!;
    const withStats = render(
      <QueueView snap={{ ...FULL, stats: STATS_FULL }} {...props} />,
    ).lastFrame()!;
    // Without stats: cursor sits on #44, no STATS section.
    expect(noStats.split("\n").find((l) => l.includes("#44 exec"))!).toContain("▌");
    expect(noStats).not.toContain("stats");
    // With full stats: STATS renders, yet the appended (non-pressable) rows
    // never shift the selectable index — the cursor is still on #44.
    expect(withStats).toContain("stats");
    expect(withStats.split("\n").find((l) => l.includes("#44 exec"))!).toContain("▌");
  });
});
