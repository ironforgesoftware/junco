import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../src/tui/components/Chrome.js";
import { sectionBadge } from "../src/tui/components/sections.js";
import type { LocalCheap } from "../src/tui/localSnapshot.js";

const health = {
  up: true,
  uptimeSeconds: 7980,
  lastBridgeSweepAt: null,
  ticketsBridged: null,
  tasksProcessed: null,
  tasksSucceeded: 3,
  tasksFailed: 0,
  lastTaskStatus: null,
  lastTaskAt: null,
  totalTokensOut: null,
  bridgeErrors: null,
};

const headerProps = {
  crumbs: ["acme/site"],
  health,
  reviewCount: 0,
  now: new Date("2026-07-20T12:00:00Z"),
  mode: "wide" as const,
  queueRunning: 0,
  queueWaiting: 0,
  watchlistError: null,
  outboxDepth: 0,
  prAttention: 0,
  prFailing: false,
  stats: null,
  runningIds: [] as string[],
};

describe("daemon chip (dot removed)", () => {
  it("shows text-only up state", () => {
    const { lastFrame } = render(<Header {...headerProps} />);
    expect(lastFrame()).toContain("daemon up 2h13m");
    expect(lastFrame()).not.toContain("●");
    expect(lastFrame()).not.toContain("○");
  });
  it("shows daemon down when down", () => {
    const { lastFrame } = render(<Header {...headerProps} health={{ ...health, up: false }} />);
    expect(lastFrame()).toContain("daemon down");
  });
});

describe("rail daemon badge (dot removed)", () => {
  const cheap = {
    daemon: { up: true },
    queue: { running: [] },
    outbox: { depth: 0 },
  } as unknown as LocalCheap;
  it("up/down text instead of dots", () => {
    expect(sectionBadge("daemon", cheap, null)).toBe("up");
    expect(
      sectionBadge("daemon", { ...cheap, daemon: { up: false } } as unknown as LocalCheap, null),
    ).toBe("down");
  });
});
