import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { SectionRail } from "../src/tui/components/LocalDashboard.js";
import type { LocalCheap, LocalHeavy, DaemonDetail } from "../src/tui/localSnapshot.js";
import type { StoredOp } from "../src/githubOutbox.js";

const NOW = new Date("2026-07-09T12:00:00Z");

const DAEMON: DaemonDetail = {
  up: true,
  pid: 4242,
  uptimeSeconds: 8000,
  endpointReachable: true,
  healthHost: "127.0.0.1",
  healthPort: 8787,
  guardNudges: 1,
  guardKills: 0,
  tokensIn: 1000,
  tokensOut: 2000,
  tasksByStatus: { completed: 5, failed: 1 },
  currentTickets: ["gh-acme-api-1"],
  progress: {
    "gh-acme-api-1": {
      turns: 3,
      lastTool: "bash",
      outputTokens: 100,
      startedAt: "2026-07-09T11:58:00Z",
    },
  },
  error: null,
};

const OP: StoredOp = {
  id: "op1",
  path: "/x/github-outbox/op1.json",
  createdAt: "2026-07-09T11:59:00Z",
  origin: "prflow",
  issueKey: "acme/api#7",
  attempts: 2,
  lastError: "connect ETIMEDOUT",
  op: { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" },
};

const CHEAP: LocalCheap = {
  queue: {
    daemonUp: true,
    maxConcurrent: 2,
    running: [
      {
        id: "gh-acme-api-1",
        github: null,
        turns: 3,
        lastTool: "bash",
        outputTokens: 100,
        startedAt: null,
        stale: false,
      },
    ],
    waiting: [],
    recent: [],
    error: null,
    outboxDepth: 2,
  },
  counts: { done: 5, failed: 1 },
  outbox: { depth: 2, dead: 1, ops: [OP], deadOps: [], error: null },
  daemon: DAEMON,
  error: null,
};

const HEAVY: LocalHeavy = {
  repos: [
    {
      nwo: "acme/api",
      path: "/repos/acme-api",
      source: "clone",
      originUrl: "https://github.com/me/api.git",
      forkUrl: null,
      githubUrl: "https://github.com/acme/api",
      branch: "main",
      headSha: "abcdef1234567",
      dirty: true,
      error: null,
    },
  ],
  worktrees: [
    {
      path: "/wt/acme/slug-1",
      repoPath: "/repos/acme-api",
      repoNwo: "acme/api",
      slug: "slug-1",
      kind: "stale",
      headSha: "abcdef1234567",
      ageSeconds: 7200,
      error: null,
    },
  ],
  error: null,
};

describe("SectionRail", () => {
  it("lists all 5 sections with live badges and a position line", () => {
    const f = render(
      <SectionRail
        section="outbox"
        focus="rail"
        cheap={CHEAP}
        heavy={HEAVY}
        width={26}
        height={20}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("sections");
    for (const s of ["queue", "outbox", "repos", "worktrees", "daemon"]) {
      expect(f).toContain(s);
    }
    expect(f).toContain("▸1"); // 1 running
    expect(f).toContain("⇡2"); // outbox depth 2
    expect(f).toContain("⚑1"); // 1 stale worktree
    expect(f).toContain("●"); // daemon up
    expect(f).toContain("2/5"); // outbox is the 2nd section
    // cursor glyph is present on the selected row.
    const outboxLine = f.split("\n").find((l) => l.includes("outbox"))!;
    expect(outboxLine).toContain("▌");
  });

  it("hides zero badges and renders ○ when the daemon is down", () => {
    const down: LocalCheap = {
      ...CHEAP,
      queue: { ...CHEAP.queue, running: [] },
      outbox: { ...CHEAP.outbox, depth: 0 },
      daemon: { ...DAEMON, up: false },
    };
    const f = render(
      <SectionRail
        section="queue"
        focus="rail"
        cheap={down}
        heavy={{ ...HEAVY, worktrees: [] }}
        width={26}
        height={20}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).not.toContain("▸");
    expect(f).not.toContain("⇡");
    expect(f).not.toContain("⚑");
    expect(f).toContain("○");
  });
});
