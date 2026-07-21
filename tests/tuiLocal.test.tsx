import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { OutboxSection, WorktreesSection, DaemonSection } from "../src/tui/components/sections.js";
import type { LocalCheap, LocalHeavy, DaemonDetail } from "../src/tui/localSnapshot.js";
import type { StoredOp } from "../src/githubOutbox.js";

const NOW = new Date("2026-07-09T12:00:00Z");

const FULL_WIN = { start: 0, end: 10 };

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
  gate: null,
  spend: null,
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
    taskTimeoutSeconds: null,
    running: [
      {
        id: "gh-acme-api-1",
        github: null,
        turns: 3,
        lastTool: "bash",
        outputTokens: 100,
        startedAt: null,
        updatedAt: null,
        stale: false,
        repoPath: null,
      },
    ],
    waiting: [],
    recent: [],
    error: null,
    outboxDepth: 2,
    stats: null,
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

describe("OutboxSection", () => {
  it("header counts, op line, and cursor on the selected op", () => {
    const f = render(
      <OutboxSection
        outbox={CHEAP.outbox}
        cursor={0}
        window={FULL_WIN}
        height={20}
        focused
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("⇡2 live");
    expect(f).toContain("✗1 dead");
    expect(f).toContain("comment acme/api#7");
    expect(f).toContain("attempts=2");
    expect(f).toContain("connect ETIMEDOUT"); // selected op expands its lastError
    const opLine = f.split("\n").find((l) => l.includes("comment"))!;
    expect(opLine).toContain("▌");
  });

  it("null → loading", () => {
    const f = render(
      <OutboxSection
        outbox={null}
        cursor={0}
        window={FULL_WIN}
        height={20}
        focused={false}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("loading…");
  });

  it("pr op with a null issue renders the precomputed issueKey, never #null", () => {
    const prOp: StoredOp = {
      id: "op-pr-null",
      path: "/x/github-outbox/op-pr-null.json",
      createdAt: "2026-07-09T11:59:00Z",
      origin: "prflow",
      issueKey: null, // matches issueKeyOf's real output for a pr op with issue: null
      attempts: 0,
      lastError: null,
      op: {
        kind: "pr",
        repoPath: "/repos/acme-api",
        branch: "feat/x",
        nwo: "acme/api",
        issue: null,
        base: "main",
        title: "t",
        bodyText: "b",
        draft: false,
        labels: [],
        reviewers: [],
        finalize: null,
        pushed: false,
        prUrl: null,
      },
    };
    const f = render(
      <OutboxSection
        outbox={{ depth: 1, dead: 0, ops: [prOp], deadOps: [], error: null }}
        cursor={0}
        window={FULL_WIN}
        height={20}
        focused
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("pr ?");
    expect(f).not.toContain("#null");
  });

  it("shows cursor+1/total when the live-ops window doesn't cover the whole list", () => {
    const manyOps: StoredOp[] = Array.from({ length: 5 }, (_, i) => ({
      ...OP,
      id: `op-${i}`,
      path: `/x/github-outbox/op-${i}.json`,
    }));
    const f = render(
      <OutboxSection
        outbox={{ depth: 5, dead: 0, ops: manyOps, deadOps: [], error: null }}
        cursor={1}
        window={{ start: 0, end: 3 }}
        height={20}
        focused
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("2/5");
  });
});

describe("WorktreesSection", () => {
  it("renders mapped nwo, slug, class, sha7, age, cursor", () => {
    const f = render(
      <WorktreesSection
        worktrees={HEAVY.worktrees}
        error={null}
        cursor={0}
        window={FULL_WIN}
        height={20}
        focused
      />,
    ).lastFrame()!;
    expect(f).toContain("acme/api");
    expect(f).toContain("slug-1");
    expect(f).toContain("stale");
    expect(f).toContain("abcdef1");
    expect(f).toContain("2h"); // 7200s
    const line = f.split("\n").find((l) => l.includes("slug-1"))!;
    expect(line).toContain("▌");
  });

  it("unmapped worktree shows ⟨unmapped⟩", () => {
    const f = render(
      <WorktreesSection
        worktrees={[{ ...HEAVY.worktrees[0], repoNwo: null }]}
        error={null}
        cursor={0}
        window={FULL_WIN}
        height={20}
        focused={false}
      />,
    ).lastFrame()!;
    expect(f).toContain("⟨unmapped⟩");
  });
});

describe("DaemonSection", () => {
  it("renders pid, uptime, endpoint, guards, tokens, per-ticket progress", () => {
    const f = render(
      <DaemonSection daemon={DAEMON} scroll={0} height={20} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    expect(f).toContain("pid 4242");
    expect(f).toContain("up 2h13m"); // 8000s
    expect(f).toContain("endpoint");
    expect(f).toContain("reachable");
    expect(f).toContain("127.0.0.1:8787");
    expect(f).toContain("1 nudges");
    expect(f).toContain("0 kills");
    expect(f).toContain("turn 3");
  });

  it("up but pid unknown (null) → hint still shows 'pid ?', never dropped", () => {
    const f = render(
      <DaemonSection
        daemon={{ ...DAEMON, pid: null }}
        scroll={0}
        height={20}
        focused
        refreshedAt={null}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("pid ?");
  });

  it("daemon down → state row shows down, no dot glyphs anywhere", () => {
    const f = render(
      <DaemonSection
        daemon={{ ...DAEMON, up: false }}
        scroll={0}
        height={20}
        focused={false}
        refreshedAt={null}
        now={NOW}
      />,
    ).lastFrame()!;
    expect(f).toContain("down");
    expect(f).not.toContain("○");
    expect(f).not.toContain("●");
  });

  it("gate null (plain ok case) → reachable value, no dot glyphs, no reason line", () => {
    const f = render(
      <DaemonSection daemon={DAEMON} scroll={0} height={20} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    expect(f).toContain("reachable");
    expect(f).not.toContain("○");
    expect(f).not.toContain("●");
    expect(f).not.toContain("auth_error");
    expect(f).not.toContain("rate_limited");
  });

  it("auth_error gate → red badge + reason line", () => {
    const daemon = {
      ...DAEMON,
      gate: { state: "auth_error", reason: "invalid api key" },
    };
    const f = render(
      <DaemonSection daemon={daemon} scroll={0} height={20} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    expect(f).toContain("auth error"); // Badge label: underscores → spaces
    expect(f).toContain("invalid api key");
  });

  it("rate_limited gate with no reason → badge only, no dangling reason line", () => {
    const daemon = {
      ...DAEMON,
      gate: { state: "rate_limited", reason: null },
    };
    const f = render(
      <DaemonSection daemon={daemon} scroll={0} height={20} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    expect(f).toContain("rate limited");
    // No reason → nothing is inserted between the endpoint row and the next
    // stat row (health). A dangling reason row would land exactly there, so
    // pin the row that follows the endpoint row rather than the endpoint
    // row's own content.
    const lines = f.split("\n").map((l) => l.replace(/[│─]/g, "").trim());
    const iEndpoint = lines.findIndex((l) => l.includes("rate limited"));
    expect(iEndpoint).toBeGreaterThanOrEqual(0);
    expect(lines[iEndpoint]).toMatch(/^endpoint\s+rate limited$/);
    expect(lines[iEndpoint + 1]).toContain("health");
  });

  it("gate ok/null but endpoint unreachable → unreachable value, no reason line", () => {
    const daemon = { ...DAEMON, endpointReachable: false, gate: null };
    const f = render(
      <DaemonSection daemon={daemon} scroll={0} height={20} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    expect(f).toContain("unreachable");
    expect(f).not.toContain("auth_error");
  });

  it("budget_exhausted gate → badge case (not the reachable/unreachable fallback) + reason line", () => {
    const daemon = {
      ...DAEMON,
      gate: { state: "budget_exhausted", reason: "daily budget $3.00 reached ($5.00 spent)" },
    };
    const f = render(
      <DaemonSection daemon={daemon} scroll={0} height={20} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    // The color isn't observable in a captured frame (non-TTY strips ANSI,
    // same convention as tuiChrome.test.tsx) — this proves the GATE_YELLOW
    // badge branch fired instead of the reachable/unreachable fallback text.
    expect(f).toContain("budget exhausted");
    expect(f).not.toContain("reachable");
    expect(f).toContain("daily budget $3.00 reached ($5.00 spent)");
  });

  it("no spend on the daemon detail (older daemon / no ledger wired) → no spend ticker line", () => {
    const f = render(
      <DaemonSection daemon={DAEMON} scroll={0} height={20} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    expect(f).not.toContain("spend");
  });

  it("spend present, no budget configured (dailyBudgetUsd 0) → ticker shows today's spend only", () => {
    const daemon = { ...DAEMON, spend: { todayUsd: 1.5, dailyBudgetUsd: 0 } };
    const f = render(
      <DaemonSection daemon={daemon} scroll={0} height={20} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    expect(f).toContain("$1.50 today");
    expect(f).not.toContain("budget");
    expect(f).not.toContain("▰");
  });

  it("spend present with a budget configured → ticker shows today's spend / budget + gauge", () => {
    const daemon = { ...DAEMON, spend: { todayUsd: 2.345, dailyBudgetUsd: 10 } };
    const f = render(
      <DaemonSection daemon={daemon} scroll={0} height={20} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    expect(f).toContain("$2.35 today");
    expect(f).toContain("of $10.00 budget");
    expect(f).toContain("▰"); // spend gauge (2.345/10 budget)
  });

  it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
    // A daemon with many progress rows — taller than a short pane.
    const busy = {
      ...DAEMON,
      progress: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `manual-row-${String(i).padStart(2, "0")}`,
          {
            turns: i,
            lastTool: "bash",
            outputTokens: 100 + i,
            startedAt: "2026-07-09T11:58:00Z",
          },
        ]),
      ),
    };
    const f = render(
      <DaemonSection daemon={busy} scroll={999} height={8} focused refreshedAt={null} now={NOW} />,
    ).lastFrame()!;
    expect(f).toContain("row-11");
    expect(f).not.toContain("row-00");
  });

  it("reports its max scroll to the owner", () => {
    let reported: number | null = null;
    render(
      <DaemonSection
        daemon={DAEMON}
        scroll={0}
        height={40}
        focused
        refreshedAt={null}
        now={NOW}
        onScrollMax={(m) => {
          reported = m;
        }}
      />,
    );
    expect(reported).toBe(0); // a tall pane fits the whole panel
  });

  it("renders stat rows, refreshed stamp, and spend gauge", () => {
    const daemon: DaemonDetail = {
      up: true,
      pid: 42,
      uptimeSeconds: 7980,
      endpointReachable: true,
      healthHost: "127.0.0.1",
      healthPort: 8787,
      guardNudges: 1,
      guardKills: 0,
      tokensIn: 10,
      tokensOut: 20,
      tasksByStatus: { done: 3 },
      currentTickets: [],
      progress: {},
      gate: { state: "ok", reason: null },
      spend: { todayUsd: 1.5, dailyBudgetUsd: 5 },
      error: null,
    };
    const { lastFrame } = render(
      <DaemonSection
        daemon={daemon}
        refreshedAt="2026-07-20T11:59:28Z"
        now={new Date("2026-07-20T12:00:00Z")}
        scroll={0}
        height={24}
        focused
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("state");
    expect(f).toContain("up 2h13m");
    expect(f).toContain("pid 42");
    expect(f).toContain("refreshed");
    expect(f).toContain("↻ 32s ago");
    expect(f).toContain("▰"); // spend gauge (1.5/5 budget)
    expect(f).toContain("── activity");
  });

  it("renders — for a never-refreshed stamp", () => {
    const { lastFrame } = render(
      <DaemonSection
        daemon={DAEMON}
        refreshedAt={null}
        now={new Date()}
        scroll={0}
        height={24}
        focused
      />,
    );
    expect(lastFrame()).toContain("refreshed  —");
  });
});
