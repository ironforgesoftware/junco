import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { UnifiedRail } from "../src/tui/components/UnifiedRail.js";
import { buildRailRows, buildUnifiedRepos } from "../src/tui/railModel.js";
import type { LocalCheap, LocalHeavy, DaemonDetail } from "../src/tui/localSnapshot.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";
import type { QueueStats } from "../src/tui/queueStats.js";

const rows = buildRailRows(
  buildUnifiedRepos(
    [{ nwo: "acme/api", path: "/w/api", fromConfig: true, external: false }],
    [
      {
        nwo: null,
        path: "/dev/scratch",
        source: "clone",
        originUrl: null,
        forkUrl: null,
        githubUrl: null,
        branch: null,
        headSha: null,
        dirty: null,
        error: null,
      },
    ],
  ),
);
const NOW = new Date("2026-07-20T12:00:00Z");

const EMPTY_QUEUE: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  running: [],
  waiting: [],
  recent: [],
  error: null,
  outboxDepth: 0,
  stats: null,
};
const DAEMON: DaemonDetail = {
  up: true,
  pid: 123,
  uptimeSeconds: 60,
  endpointReachable: true,
  healthHost: "127.0.0.1",
  healthPort: 8787,
  guardNudges: 0,
  guardKills: 0,
  tokensIn: 0,
  tokensOut: 0,
  tasksByStatus: {},
  currentTickets: [],
  progress: {},
  gate: null,
  spend: null,
  error: null,
};
const cheap = (queue: QueueSnapshot, outboxDepth = 0): LocalCheap => ({
  queue,
  counts: null,
  outbox: { depth: outboxDepth, dead: 0, ops: [], deadOps: [], error: null },
  daemon: DAEMON,
  error: null,
});
const HEAVY: LocalHeavy = {
  repos: [],
  worktrees: [
    {
      path: "/wt/a",
      repoPath: "/w/api",
      repoNwo: "acme/api",
      slug: "a",
      kind: "stale",
      headSha: null,
      ageSeconds: 60,
      error: null,
    },
  ],
  error: null,
};

const base = {
  rows,
  selected: 0,
  focused: true,
  cheap: null,
  heavy: null,
  issueCounts: () => ({}),
  assess: () => null,
  width: 40,
  height: 24,
  now: NOW,
  window: { start: 0, end: 2 },
};

describe("UnifiedRail", () => {
  it("renders repo rows, the system header, and all five system rows", () => {
    const f = render(<UnifiedRail {...base} />).lastFrame() ?? "";
    expect(f).toContain("acme/api");
    expect(f).toContain("(cfg)");
    expect(f).toContain("scratch"); // local row = path tail
    expect(f).toContain("(clone)"); // local row source tag
    expect(f).toContain("system");
    for (const s of ["queue", "outbox", "worktrees", "daemon", "logs"]) {
      expect(f).toContain(s);
    }
  });

  it("system badges come from the cheap/heavy snapshots", () => {
    const running: QueueSnapshot = {
      ...EMPTY_QUEUE,
      running: [
        {
          id: "r1",
          github: null,
          turns: 1,
          lastTool: null,
          outputTokens: null,
          startedAt: null,
          updatedAt: null,
          stale: false,
          repoPath: null,
        },
      ],
    };
    const f =
      render(<UnifiedRail {...base} cheap={cheap(running, 2)} heavy={HEAVY} />).lastFrame() ?? "";
    expect(f).toContain("▸1"); // queue running badge
    expect(f).toContain("⇡2"); // outbox depth badge
    expect(f).toContain("⚑1"); // stale worktree badge
    expect(f).toContain("●"); // daemon up badge
  });

  it("gate-paused shows ⚠ on the queue row", () => {
    const stats: QueueStats = {
      gate: { state: "rate_limited", reason: null, until: null },
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
    };
    const gated: QueueSnapshot = { ...EMPTY_QUEUE, stats };
    const f = render(<UnifiedRail {...base} cheap={cheap(gated)} />).lastFrame() ?? "";
    const line = (f.split("\n").find((l) => l.includes("queue")) ?? "").trim();
    expect(line).toContain("⚠");
  });

  it("marks the selected SYSTEM row with the ▌ cursor", () => {
    const queueIdx = rows.findIndex((r) => r.kind === "system");
    const f = render(<UnifiedRail {...base} selected={queueIdx} />).lastFrame() ?? "";
    const line = f.split("\n").find((l) => l.includes("queue"));
    expect(line).toContain("▌");
  });

  it("issue-count badges and assess column render on watched nwo rows", () => {
    const f =
      render(
        <UnifiedRail
          {...base}
          issueCounts={(nwo) => (nwo === "acme/api" ? { "plan-ready": 2 } : {})}
        />,
      ).lastFrame() ?? "";
    const line = f.split("\n").find((l) => l.includes("acme/api")) ?? "";
    expect(line).toContain("2●");
  });
});
