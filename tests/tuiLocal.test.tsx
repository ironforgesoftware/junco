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
    const f = render(<DaemonSection daemon={DAEMON} scroll={0} height={20} focused />).lastFrame()!;
    expect(f).toContain("pid 4242");
    expect(f).toContain("up 2h13m"); // 8000s
    expect(f).toContain("inference endpoint");
    expect(f).toContain("127.0.0.1:8787");
    expect(f).toContain("nudges 1");
    expect(f).toContain("kills 0");
    expect(f).toContain("turn 3");
  });

  it("daemon down → ○ not running", () => {
    const f = render(
      <DaemonSection daemon={{ ...DAEMON, up: false }} scroll={0} height={20} focused={false} />,
    ).lastFrame()!;
    expect(f).toContain("○ not running");
  });

  it("gate null (plain ok case) → filled dot, no reason line", () => {
    const f = render(<DaemonSection daemon={DAEMON} scroll={0} height={20} focused />).lastFrame()!;
    expect(f).toContain("● inference endpoint");
    expect(f).not.toContain("auth_error");
    expect(f).not.toContain("rate_limited");
  });

  it("auth_error gate → hollow dot + `state — reason` line (red-dot case)", () => {
    const daemon = {
      ...DAEMON,
      gate: { state: "auth_error", reason: "invalid api key" },
    };
    const f = render(<DaemonSection daemon={daemon} scroll={0} height={20} focused />).lastFrame()!;
    expect(f).toContain("○ inference endpoint");
    expect(f).toContain("auth_error — invalid api key");
  });

  it("rate_limited gate with no reason → state-only line, no dangling dash", () => {
    const daemon = {
      ...DAEMON,
      gate: { state: "rate_limited", reason: null },
    };
    const f = render(<DaemonSection daemon={daemon} scroll={0} height={20} focused />).lastFrame()!;
    expect(f).toContain("rate_limited");
    expect(f).not.toContain("rate_limited —");
  });

  it("gate ok/null but endpoint unreachable → hollow dot, no reason line", () => {
    const daemon = { ...DAEMON, endpointReachable: false, gate: null };
    const f = render(<DaemonSection daemon={daemon} scroll={0} height={20} focused />).lastFrame()!;
    expect(f).toContain("○ inference endpoint");
    expect(f).not.toContain("auth_error");
  });

  it("budget_exhausted gate → YELLOW (warn) dot, not a filled green dot, + reason line", () => {
    const daemon = {
      ...DAEMON,
      gate: { state: "budget_exhausted", reason: "daily budget $3.00 reached ($5.00 spent)" },
    };
    const f = render(<DaemonSection daemon={daemon} scroll={0} height={20} focused />).lastFrame()!;
    // The hollow dot proves it took the warn/error branch, not the
    // endpointReachable-driven green "●" fallback a missing GATE_YELLOW entry
    // would fall through to.
    expect(f).toContain("○ inference endpoint");
    expect(f).not.toContain("● inference endpoint");
    expect(f).toContain("budget_exhausted — daily budget $3.00 reached ($5.00 spent)");
  });

  it("no spend on the daemon detail (older daemon / no ledger wired) → no spend ticker line", () => {
    const f = render(<DaemonSection daemon={DAEMON} scroll={0} height={20} focused />).lastFrame()!;
    expect(f).not.toContain("spend $");
  });

  it("spend present, no budget configured (dailyBudgetUsd 0) → ticker shows today's spend only", () => {
    const daemon = { ...DAEMON, spend: { todayUsd: 1.5, dailyBudgetUsd: 0 } };
    const f = render(<DaemonSection daemon={daemon} scroll={0} height={20} focused />).lastFrame()!;
    expect(f).toContain("spend $1.50 today");
    expect(f).not.toContain("budget");
  });

  it("spend present with a budget configured → ticker shows today's spend / budget", () => {
    const daemon = { ...DAEMON, spend: { todayUsd: 2.345, dailyBudgetUsd: 10 } };
    const f = render(<DaemonSection daemon={daemon} scroll={0} height={20} focused />).lastFrame()!;
    expect(f).toContain("spend $2.35 today / $10.00 budget");
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
    const f = render(<DaemonSection daemon={busy} scroll={999} height={8} focused />).lastFrame()!;
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
        onScrollMax={(m) => {
          reported = m;
        }}
      />,
    );
    expect(reported).toBe(0); // a tall pane fits the whole panel
  });
});
