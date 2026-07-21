// tests/tuiHeaderPulse.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../src/tui/components/Chrome.js";
import type { QueueStats } from "../src/tui/queueStats.js";

const base = {
  crumbs: ["acme/site"],
  health: {
    up: true,
    uptimeSeconds: 60,
    lastBridgeSweepAt: null,
    ticketsBridged: null,
    tasksProcessed: null,
    tasksSucceeded: null,
    tasksFailed: null,
    lastTaskStatus: null,
    lastTaskAt: null,
    totalTokensOut: 999,
    bridgeErrors: null,
  },
  reviewCount: 0,
  now: new Date("2026-07-20T12:00:00Z"),
  mode: "wide" as const,
  queueRunning: 0,
  queueWaiting: 0,
  watchlistError: null,
  outboxDepth: 0,
  prAttention: 0,
  prFailing: false,
  stats: null as QueueStats | null,
  runningIds: [] as string[],
};

const stats: QueueStats = {
  gate: { state: "ok", reason: null, until: null },
  lastPollAt: null,
  window24h: {
    done: 12,
    failed: 1,
    successRate: 0.92,
    avgDurationSeconds: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
  },
  perDay7d: [],
  etaSeconds: 480,
  spend: null,
  guards: null,
  outbox: { depth: 0, dead: 0 },
  pendingRestartFields: [],
};

describe("header pulse", () => {
  it("shows the 24h record chip from stats", () => {
    const { lastFrame } = render(<Header {...base} stats={stats} />);
    expect(lastFrame()).toContain("24h ✓12 ✗1 92%");
  });
  it("hides the 24h chip with an empty ledger window", () => {
    const empty = { ...stats, window24h: { ...stats.window24h, done: 0, failed: 0 } };
    const { lastFrame } = render(<Header {...base} stats={empty} />);
    expect(lastFrame()).not.toContain("24h ");
  });
  it("shows the live run chip and eta when running/waiting", () => {
    const { lastFrame } = render(
      <Header
        {...base}
        stats={stats}
        runningIds={["fix-login", "other"]}
        queueRunning={2}
        queueWaiting={3}
      />,
    );
    expect(lastFrame()).toContain("▸ fix-login +1");
    expect(lastFrame()).toContain("eta 8m");
  });
  it("shows gate and restart-pending warnings", () => {
    const warn = {
      ...stats,
      gate: { state: "rate_limited", reason: "429 from provider", until: null },
      pendingRestartFields: ["maxConcurrent"],
    };
    const { lastFrame } = render(<Header {...base} stats={warn} mode="medium" />);
    expect(lastFrame()).toContain("gate ⚠ 429 from provider");
    expect(lastFrame()).toContain("restart pending");
  });
  it("since-restart ✓/✗ and tok chips are gone", () => {
    const { lastFrame } = render(<Header {...base} />);
    expect(lastFrame()).not.toContain("tok 999");
  });
  it("renders crumbs joined with the trail separator", () => {
    const { lastFrame } = render(<Header {...base} crumbs={["acme/site", "#124"]} />);
    expect(lastFrame()).toContain("acme/site ▸ #124");
  });
});
