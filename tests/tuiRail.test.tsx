import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Rail } from "../src/tui/components/Rail.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";
import type { QueueStats } from "../src/tui/queueStats.js";
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

function stats(p: Partial<QueueStats> = {}): QueueStats {
  return {
    gate: null,
    lastPollAt: null,
    window24h: {
      done: 0,
      failed: 0,
      successRate: null,
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
      updatedAt: null,
      stale: false,
      repoPath: null,
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
      queuedAt: null,
      repoPath: null,
    },
    {
      id: "w2",
      github: null,
      kind: "pr",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
      queuedAt: null,
      repoPath: null,
    },
  ],
  recent: [],
  error: null,
  stats: null,
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
          updatedAt: null,
          stale: false,
          repoPath: null,
        },
        {
          id: "gh-a-b-47",
          github: { nwo: "a/b", issue: 47, kind: "pr", external: false },
          turns: 3,
          lastTool: "edit",
          outputTokens: 100,
          startedAt: null,
          updatedAt: null,
          stale: false,
          repoPath: null,
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
        counts: { "plan-ready": 2 },
        // #204: the TRUE worst-case indicator is `99d+! 99+⚠` (10 chars) — needs
        // lastSuccessAt > 99 days back (the old 21d fixture only reached 9).
        assess: hist({
          lastSuccessAt: "2026-01-01T00:00:00.000Z",
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
    // The pinned indicator (never truncated) renders at its worst case, incl.
    // the literal failed-state `!`.
    expect(f).toContain("99d+!");
  });
});

describe("Rail queue card — stats parity (#T9)", () => {
  it("gate ≠ ok renders a warn paused line directly under the queue header", () => {
    const paused: QueueSnapshot = {
      ...QUEUE,
      stats: stats({ gate: { state: "rate_limited", reason: "429", until: null } }),
    };
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={paused}
        width={30}
        height={20}
        now={NOW}
        window={{ start: 0, end: repos.length }}
      />,
    ).lastFrame()!;
    const lines = f.split("\n");
    // Strip the round-border pipes before comparing — the box renders
    // `│ queue                      │`, not a bare "queue" line.
    const queueIdx = lines.findIndex((l) => l.replace(/[│]/g, "").trim() === "queue");
    expect(queueIdx).toBeGreaterThanOrEqual(0);
    expect(lines[queueIdx + 1]).toContain("▸ paused — rate limited");
  });

  it("gate ok → no paused line", () => {
    const ok: QueueSnapshot = {
      ...QUEUE,
      stats: stats({ gate: { state: "ok", reason: null, until: null } }),
    };
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={ok}
        width={30}
        height={20}
        now={NOW}
        window={{ start: 0, end: repos.length }}
      />,
    ).lastFrame()!;
    expect(f).not.toContain("▸ paused");
  });

  it("gate null (stats null, e.g. loading) → no paused line", () => {
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
    expect(f).not.toContain("▸ paused");
  });

  it("waiting line gains oldest age when queuedAt data is present", () => {
    const withAges: QueueSnapshot = {
      ...QUEUE,
      waiting: [
        {
          id: "w1",
          github: null,
          kind: "ask",
          priority: "normal",
          retryCount: 0,
          notBefore: null,
          deferred: false,
          queuedAt: "2026-07-16T11:18:00.000Z", // 42m before NOW
          repoPath: null,
        },
        {
          id: "w2",
          github: null,
          kind: "pr",
          priority: "normal",
          retryCount: 0,
          notBefore: null,
          deferred: false,
          queuedAt: "2026-07-16T11:50:00.000Z",
          repoPath: null,
        },
        {
          id: "w3",
          github: null,
          kind: "pr",
          priority: "normal",
          retryCount: 0,
          notBefore: null,
          deferred: false,
          queuedAt: null,
          repoPath: null,
        },
      ],
    };
    const f = render(
      <Rail
        repos={repos}
        selected={0}
        focused={true}
        queue={withAges}
        width={30}
        height={20}
        now={NOW}
        window={{ start: 0, end: repos.length }}
      />,
    ).lastFrame()!;
    expect(f).toContain("3 waiting · oldest 42m");
  });

  it("waiting line has no oldest segment when no queuedAt data (regression)", () => {
    // QUEUE's fixture waiting rows all carry queuedAt: null.
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
    expect(f).toContain("2 waiting");
    expect(f).not.toContain("oldest");
  });
});
