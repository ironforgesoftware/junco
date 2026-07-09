// Shared fixtures + renderApp for the App-level LOCAL-mode suites
// (tuiLocalApp / tuiLocalActions / tuiMouse). The LOCAL surface renders the
// mode tabs bracketed only at the wide breakpoint (WIDE_COLS=110), so these
// suites mount at 120 cols — that is what makes `[GITHUB]`/`[LOCAL]` (and the
// spelled-out inactive labels) appear in the frame.
import React from "react";
import { render } from "ink-testing-library";
import { App, type AppProps } from "../../src/tui/App.js";
import type { LocalCheap, LocalHeavy } from "../../src/tui/localSnapshot.js";
import type { DashboardClient, Result } from "../../src/tui/ghClient.js";
import type { QueueSnapshot } from "../../src/tui/queueSnapshot.js";

export const okv = <T,>(v: T): Result<T> => ({ ok: true, value: v });
export const ESC = String.fromCharCode(27);
export const ENTER = "\r";
/** Wide layout so the bracketed tabs (`[GITHUB]`/`[LOCAL]`) render. */
export const WIDE_COLS_TEST = 120;

export const EMPTY_QUEUE: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  running: [],
  waiting: [],
  recent: [],
  error: null,
  outboxDepth: 0,
};

export const CHEAP: LocalCheap = {
  queue: {
    ...EMPTY_QUEUE,
    running: [
      {
        id: "gh-acme-api-1",
        github: { nwo: "acme/api", issue: 1, kind: "pr", external: false },
        turns: 2,
        lastTool: "bash",
        outputTokens: 10,
        startedAt: "2026-07-07T10:00:00Z",
        stale: false,
      },
    ],
    waiting: [
      {
        id: "sub-fix-typos",
        github: null,
        kind: "plan",
        priority: "normal",
        retryCount: 0,
        notBefore: null,
        deferred: false,
      },
    ],
    recent: [
      {
        id: "gh-acme-api-9",
        github: { nwo: "acme/api", issue: 9, kind: "pr", external: false },
        status: "failed",
        finishedAt: "2026-07-07T10:05:00Z",
      },
    ],
  },
  counts: { done: 12, failed: 3 },
  outbox: { depth: 2, dead: 1, ops: [], deadOps: [], error: null },
  daemon: {
    up: true,
    pid: 4242,
    uptimeSeconds: 7980,
    endpointReachable: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    guardNudges: 1,
    guardKills: 0,
    tokensIn: 1000,
    tokensOut: 2000,
    tasksByStatus: { done: 12, failed: 3 },
    currentTickets: ["gh-acme-api-1"],
    progress: {},
    error: null,
  },
  error: null,
};

export const HEAVY: LocalHeavy = {
  repos: [
    {
      nwo: "acme/api",
      path: "/c/api",
      source: "config",
      originUrl: "https://github.com/acme/api",
      forkUrl: null,
      githubUrl: "https://github.com/acme/api",
      branch: "main",
      headSha: "abc1234",
      dirty: false,
      error: null,
    },
  ],
  worktrees: [
    {
      path: "/w/acme-api/fix-typos",
      repoPath: "/c/api",
      repoNwo: "acme/api",
      slug: "fix-typos",
      kind: "stale",
      headSha: "def5678",
      ageSeconds: 3600,
      error: null,
    },
  ],
  error: null,
};

export const stubClient: DashboardClient = {
  listIssues: async () => okv({ issues: [], staleAt: null }),
  listPrs: async () => okv({ prs: [], staleAt: null }),
  cloneRepo: async () => okv(undefined),
  issueDetail: async () => okv({ body: "", planComment: null }),
  applyAction: async () => okv({ queued: false }),
  validateAndPrepareRepo: async () => okv(undefined),
  openInBrowser: async () => okv(undefined),
  openPrInBrowser: async () => okv(undefined),
  openRepoInBrowser: async () => okv(undefined),
  repoPermission: async () => okv({ canPush: true }),
  prepareExternalRepo: async (nwo) => okv({ path: `/r/${nwo}`, forkNwo: nwo }),
  dispatchTicket: async (nwo, num) => okv({ id: `gh-${nwo}-${num}`, destPath: "/x" }),
  health: async () => ({
    up: true,
    uptimeSeconds: 60,
    lastBridgeSweepAt: null,
    ticketsBridged: 0,
    tasksProcessed: null,
    tasksSucceeded: null,
    tasksFailed: null,
    lastTaskStatus: null,
    lastTaskAt: null,
    totalTokensOut: null,
    bridgeErrors: null,
  }),
};

export function renderApp(over: Partial<AppProps> = {}): ReturnType<typeof render> {
  const runCli: AppProps["runCliFn"] =
    over.runCliFn ?? (async () => ({ code: 0, output: "ok", timedOut: false }));
  return render(
    <App
      client={stubClient}
      trigger="junco"
      branchPrefix="junco/"
      configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
      watchlistFile="/tmp/wl.json"
      configPath="/x/config.toml"
      clonesDir="/x/state/repos"
      refreshPollMs={999999}
      healthPollMs={999999}
      queuePollMs={999999}
      queueFn={async () => EMPTY_QUEUE}
      localCheapFn={async () => CHEAP}
      localHeavyFn={async () => HEAVY}
      localCheapPollMs={999999}
      localHeavyPollMs={999999}
      initialUiMode="github"
      githubEnabled
      runCliFn={runCli}
      sizeOverride={{ columns: WIDE_COLS_TEST, rows: 30 }}
      onExit={() => {}}
      {...over}
    />,
  );
}
