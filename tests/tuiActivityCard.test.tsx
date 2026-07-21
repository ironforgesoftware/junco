import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { ActivityCard, ReservedNote } from "../src/tui/components/ActivityCard.js";
import type { QueueStats } from "../src/tui/queueStats.js";
import type { LocalRepo } from "../src/tui/localSnapshot.js";
import { until } from "./helpers/until.js";
import { renderApp, TO_QUEUE_ROW, tap, HEAVY } from "./helpers/localFixtures.js";

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

  it("a local-only repo row reserves the third column with the local note", async () => {
    // A local-only row (buildUnifiedRepos' "unclaimed heavy candidate" path —
    // railModel.ts) enters the rail via localHeavyFn's repos, not the watched
    // configRepos/watchlist union. A prop override on THIS render is enough
    // (no shared fixture/constant edit, so TO_QUEUE_ROW etc. elsewhere are
    // untouched): append one candidate that matches neither watched nwo
    // (acme/api, beta/two) nor path, so it lands as an unwatched "repoDetail"
    // row (bodyKindFor) after the two watched rows.
    const localOnly: LocalRepo = {
      nwo: null,
      path: "/local/only-repo",
      source: "clone",
      originUrl: null,
      forkUrl: null,
      githubUrl: null,
      branch: "main",
      headSha: "abc1111",
      dirty: false,
      error: null,
    };
    const r = renderApp({
      localHeavyFn: async () => ({ ...HEAVY, repos: [...HEAVY.repos, localOnly] }),
    });
    await until(() => (r.lastFrame() ?? "").includes("system"));
    // Wait for the heavy poll's local-only candidate to actually land in the
    // rail before counting steps — it's delivered async, one tick after mount.
    // The rail's narrow column END-truncates the label (Ink wrap="truncate"),
    // so match the surviving PREFIX, not the (truncated-away) path tail.
    await until(() => (r.lastFrame() ?? "").includes("/local/only"));
    await tap(r, "jj"); // acme/api → beta/two → the local-only row
    await until(() => (r.lastFrame() ?? "").includes("local repo — no linked PRs"));
  });
});
