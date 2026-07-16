import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Rail } from "../src/tui/components/Rail.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";
import { windowSlice } from "../src/tui/window.js";
import { railListHeight } from "../src/tui/geometry.js";
import { fmtAssessIndicator } from "../src/tui/queueFmt.js";
import type { AssessHistory } from "../src/assessHistory.js";

const NOW = new Date("2026-07-16T12:00:00.000Z");
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

const QUEUE: QueueSnapshot = {
  daemonUp: true,
  outboxDepth: 0,
  maxConcurrent: 1,
  running: [
    {
      id: "gh-a-b-46",
      github: { nwo: "a/b", issue: 46, kind: "pr", external: false },
      turns: 14,
      lastTool: "bash",
      outputTokens: 900,
      startedAt: null,
      stale: false,
    },
  ],
  waiting: [
    {
      id: "w1",
      github: null,
      kind: "ask",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
    {
      id: "w2",
      github: null,
      kind: "pr",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
    },
  ],
  recent: [],
  error: null,
};

const repos = [
  { nwo: "acme/api", fromConfig: false, counts: { "plan-ready": 2 }, assess: null },
  { nwo: "acme/web", fromConfig: true, counts: {}, assess: null },
];

describe("Rail", () => {
  it("numbered title, selection bar, config marker, badges, queue card", () => {
    // width 30: the pinned assess column (ASSESS_COL=8) now claims part of the
    // 22-column content box a 26-wide pane leaves, so "acme/web (cfg)" (14
    // chars) no longer fits the ~13 columns left for nwo+badges at RAIL_WIDTH.
    // Widen the pane here (this test is about feature presence, not the
    // width-26 truncation boundary — that is covered by the dedicated
    // "no row exceeds the pane width" test below).
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={QUEUE}
        width={30}
        height={20}
        now={NOW}
        window={{ start: 0, end: repos.length }}
      />,
    ).lastFrame()!;
    expect(f).toContain("1 repos");
    expect(f).toContain("▌");
    expect(f).toContain("acme/api");
    expect(f).toContain("2●");
    expect(f).toContain("(cfg)");
    expect(f).toContain("queue");
    expect(f).toContain("#46 exec");
    expect(f).toContain("turn 14");
    expect(f).toContain("2 waiting");
  });
  it("empty repos state and daemon-down warning", () => {
    const down: QueueSnapshot = { ...QUEUE, daemonUp: false, running: [] };
    const f = render(
      <Rail
        repos={[]}
        selected={0}
        focused={false}
        queue={down}
        width={26}
        height={20}
        now={NOW}
        window={{ start: 0, end: 0 }}
      />,
    ).lastFrame()!;
    expect(f).toContain("none — press w to add");
    expect(f).toContain("daemon ○ down");
  });
  it("worst-case queue card (2 running, waiting, daemon down) never overflows the pane", () => {
    // Full repo window: with the list windowed to its complete height budget
    // there is no flexGrow slack to absorb a card under-budget — Yoga would
    // squeeze out the selected repo row and corrupt the position line.
    const many = Array.from({ length: 30 }, (_, i) => ({
      nwo: `o/r${i}`,
      fromConfig: false,
      counts: {},
    }));
    const busy: QueueSnapshot = {
      ...QUEUE,
      daemonUp: false,
      running: [
        {
          id: "gh-a-b-46",
          github: { nwo: "a/b", issue: 46, kind: "pr", external: false },
          turns: 14,
          lastTool: "bash",
          outputTokens: 900,
          startedAt: null,
          stale: false,
        },
        {
          id: "gh-a-b-47",
          github: { nwo: "a/b", issue: 47, kind: "pr", external: false },
          turns: 3,
          lastTool: "edit",
          outputTokens: 100,
          startedAt: null,
          stale: false,
        },
      ],
    };
    const f = render(
      <Rail
        repos={many}
        selected={29}
        focused={true}
        queue={busy}
        width={26}
        height={16}
        now={NOW}
        window={windowSlice(many.length, railListHeight(16), 29, 0)}
      />,
    ).lastFrame()!;
    expect(f.split("\n").length).toBeLessThanOrEqual(16);
    expect(f).toContain("▌o/r29"); // the selected row must survive the squeeze
    expect(f).toContain("+1 more running");
    expect(f).toContain("2 waiting");
    expect(f).toContain("daemon ○ down");
  });
  it("error variant renders the unavailable line", () => {
    const errored: QueueSnapshot = { ...QUEUE, error: "clock boom" };
    // width 30: "unavailable: clock boom" (23 chars) needs more than the
    // 22-char content width a 26-wide pane leaves after borders + padding.
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={errored}
        width={30}
        height={20}
        now={NOW}
        window={{ start: 0, end: repos.length }}
      />,
    ).lastFrame()!;
    expect(f).toContain("unavailable: clock boom");
  });
  it("windows long repo lists to the height budget with a position line", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      nwo: `o/r${i}`,
      fromConfig: false,
      counts: {},
    }));
    const f = render(
      <Rail
        repos={many}
        selected={29}
        focused={true}
        queue={null}
        width={26}
        height={16}
        now={NOW}
        window={windowSlice(many.length, railListHeight(16), 29, 0)}
      />,
    ).lastFrame()!;
    expect(f).toContain("o/r29"); // cursor stays visible
    expect(f).not.toContain("o/r0"); // top scrolled out
    expect(f).toContain("30/30");
  });
});

describe("Rail assess indicator", () => {
  // REGRESSION (#193): before the row was restructured, a 23-char nwo
  // flex-shrank the ▌ sibling to zero — the NO_COLOR selection fallback
  // (theme.ts:4) vanished exactly on the maintainer's own repos. The old test
  // missed it because its fixture was the 8-char "acme/api".
  it("keeps the selection bar visible for a long nwo at the real RAIL_WIDTH", () => {
    const repos = [{ nwo: "ironforgesoftware/junco", fromConfig: true, counts: {}, assess: null }];
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={QUEUE}
        width={26}
        height={14}
        now={NOW}
        window={{ start: 0, end: 1 }}
      />,
    ).lastFrame()!;
    expect(f).toContain("▌");
  });

  it("shows the indicator for long nwos — it is pinned, never truncated away", () => {
    const repos = [
      {
        nwo: "ironforgesoftware/junco",
        fromConfig: true,
        counts: {},
        assess: hist({ lastSuccessAt: "2026-07-16T10:00:00.000Z", lastFound: 0, lastParked: 0 }),
      },
      {
        nwo: "ironforgesoftware/junco-site",
        fromConfig: true,
        counts: {},
        assess: hist({ lastSuccessAt: "2026-06-25T12:00:00.000Z", lastFound: 4, lastParked: 4 }),
      },
    ];
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={QUEUE}
        width={26}
        height={14}
        now={NOW}
        window={{ start: 0, end: 2 }}
      />,
    ).lastFrame()!;
    expect(f).toContain(fmtAssessIndicator(repos[0].assess, NOW)); // "2h 0✓"
    expect(f).toContain(fmtAssessIndicator(repos[1].assess, NOW)); // "21d 4⚠"
  });

  it("never-assessed renders an em dash", () => {
    const repos = [{ nwo: "acme/api", fromConfig: false, counts: {}, assess: null }];
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={QUEUE}
        width={26}
        height={14}
        now={NOW}
        window={{ start: 0, end: 1 }}
      />,
    ).lastFrame()!;
    expect(f).toContain("—");
  });

  it("no row exceeds the pane width (fixed column must not overflow)", () => {
    const repos = [
      {
        nwo: "ironforgesoftware/junco",
        fromConfig: true,
        counts: { "plan-ready": 2 as number },
        assess: hist({
          lastSuccessAt: "2026-06-25T12:00:00.000Z",
          lastFound: 250,
          lastParked: 250,
          lastFailureAt: "2026-07-16T11:00:00.000Z",
          lastFailureReason: "boom",
        }),
      },
    ];
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={QUEUE}
        width={26}
        height={14}
        now={NOW}
        window={{ start: 0, end: 1 }}
      />,
    ).lastFrame()!;
    for (const line of f.split("\n")) expect(line.length).toBeLessThanOrEqual(26);
  });
});
