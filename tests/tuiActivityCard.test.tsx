import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { ActivityCard, ReservedNote } from "../src/tui/components/ActivityCard.js";
import type { QueueStats } from "../src/tui/queueStats.js";
import { until } from "./helpers/until.js";
import { renderApp, TO_QUEUE_ROW, tap } from "./helpers/localFixtures.js";

afterEach(cleanup);

const stats: QueueStats = {
  gate: null,
  lastPollAt: null,
  window24h: {
    done: 12,
    failed: 1,
    successRate: 0.92,
    avgDurationSeconds: 360,
    tokensIn: 900_000,
    tokensOut: 1_200_000,
    costUsd: 3.2,
  },
  perDay7d: [
    { done: 2, failed: 0 },
    { done: 4, failed: 1 },
    { done: 8, failed: 0 },
    { done: 0, failed: 0 },
    { done: 3, failed: 0 },
    { done: 5, failed: 1 },
    { done: 2, failed: 0 },
  ],
  etaSeconds: null,
  spend: null,
  guards: null,
  outbox: { depth: 0, dead: 0 },
  pendingRestartFields: [],
};

describe("ActivityCard", () => {
  it("renders 7d bars, totals, 24h record, avg, cost", () => {
    const { lastFrame } = render(<ActivityCard stats={stats} width={40} height={16} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("activity");
    expect(f).toContain("✓24 ✗2"); // 7d totals
    expect(f).toContain("✓12 ✗1 · 92%");
    expect(f).toContain("avg   6m"); // StatRow pads the 3-char label to LW=6
    expect(f).toContain("tok 1.2M");
    expect(f).toContain("$3.20");
  });
  it("null stats → no history note", () => {
    const { lastFrame } = render(<ActivityCard stats={null} width={40} height={16} />);
    expect(lastFrame()).toContain("no history yet");
  });
  it("ReservedNote renders the dim note", () => {
    const { lastFrame } = render(
      <ReservedNote text="local repo — no linked PRs" width={40} height={16} />,
    );
    expect(lastFrame()).toContain("local repo — no linked PRs");
  });
});

describe("reserved third slot (App integration)", () => {
  it("selecting a system row shows the ActivityCard in wide mode", async () => {
    const r = renderApp(); // fixture mounts at 120 cols (wide breakpoint)
    await until(() => (r.lastFrame() ?? "").includes("system"));
    await tap(r, TO_QUEUE_ROW); // acme/api → beta/two → queue
    await until(() => (r.lastFrame() ?? "").includes("activity"));
    expect(r.lastFrame()).toContain("activity");
  });
});
