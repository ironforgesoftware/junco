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
} from "../src/tui/queueFmt.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const NOW = new Date("2026-07-07T10:05:00Z");

const IDLE: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  running: [],
  waiting: [],
  recent: [],
  error: null,
  outboxDepth: 0,
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
      stale: false,
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
    },
    {
      id: "manual-tide-fix",
      github: null,
      kind: "pr",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
    {
      id: "gh-acme-api-52-plan",
      github: { nwo: "acme/api", issue: 52, kind: "plan", external: false },
      kind: "plan",
      priority: "normal",
      retryCount: 1,
      notBefore: "2026-07-07T11:00:00Z",
      deferred: true,
    },
    {
      id: "gh-acme-api-53-plan",
      github: { nwo: "acme/api", issue: 53, kind: "plan", external: false },
      kind: "plan",
      priority: "low",
      retryCount: 0,
      notBefore: null,
      deferred: false,
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
      },
      {
        id: "gh-acme-api-40",
        github: { nwo: "acme/api", issue: 40, kind: "pr", external: false },
        status: "failed",
        finishedAt: "2026-07-07T09:05:00Z",
      },
    ],
  };

  it("renders all three sections with detail", () => {
    const frame = render(
      <QueueView snap={FULL} scroll={0} now={NOW} height={20} focused={false} />,
    ).lastFrame()!;
    expect(frame).toContain("RUNNING (1/1)");
    expect(frame).toContain("#46 exec");
    expect(frame).toContain("gh-acme-api-46"); // dim id next to the label
    expect(frame).toContain("turn 14 · bash · 12.3k tok · 4m32s");
    expect(frame).toContain("WAITING (4)");
    expect(frame).toContain("1. #51 plan");
    expect(frame).toContain("2. manual-tide-fix");
    expect(frame).toContain("retry 1");
    expect(frame).toContain("not before");
    expect(frame).toContain("⏲ deferred");
    expect(frame).toContain("low"); // non-normal priority shown
    expect(frame).toContain("RECENT");
    expect(frame).toContain("✓ #44 exec");
    expect(frame).toContain("12m ago");
    expect(frame).toContain("✗ #40 exec");
  });

  it("renders dim placeholders for empty sections", () => {
    const frame = render(
      <QueueView snap={IDLE} scroll={0} now={NOW} height={20} focused={false} />,
    ).lastFrame()!;
    expect(frame).toContain("RUNNING (0/1)");
    expect(frame).toContain("WAITING (0)");
    // Empty sections show an em-dash placeholder.
    expect(frame.split("—").length).toBeGreaterThanOrEqual(3);
  });

  it("scroll slices rendered rows", () => {
    const top = render(
      <QueueView snap={FULL} scroll={0} now={NOW} height={20} focused={false} />,
    ).lastFrame()!;
    const scrolled = render(
      <QueueView snap={FULL} scroll={6} now={NOW} height={20} focused={false} />,
    ).lastFrame()!;
    expect(top).toContain("RUNNING");
    expect(scrolled).not.toContain("RUNNING (1/1)");
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
});
