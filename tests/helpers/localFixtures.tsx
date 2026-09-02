// Shared fixtures + renderApp for the App-level unified-view suites
// (tuiLocalApp / tuiLocalActions / tuiMouse). Mounted at 120 cols (wide
// breakpoint, WIDE_COLS=110) so the three-pane layout renders.
//
// Rail geometry under these fixtures: HEAVY's one candidate (acme/api at
// /c/api) collapses into the watched acme/api row by path, so the rows are
// [acme/api, beta/two] + the five system rows (queue/outbox/worktrees/
// daemon/logs) = 7.
import React from "react";
import { render } from "ink-testing-library";
import { App, type AppProps } from "../../src/tui/App.js";
import { MouseProvider } from "../../src/tui/MouseProvider.js";
import type { LocalCheap, LocalHeavy } from "../../src/tui/localSnapshot.js";
import type { DashboardClient } from "../../src/tui/ghClient.js";
import type { Result } from "../../src/types.js";
import type { DashIssue } from "../../src/tui/state.js";
import type { QueueSnapshot } from "../../src/tui/queueSnapshot.js";

export const okv = <T,>(v: T): Result<T> => ({ ok: true, value: v });
export const ESC = String.fromCharCode(27);
export const ENTER = "\r";
/** Wide layout (three-pane breakpoint). */
export const WIDE_COLS_TEST = 120;
/** Key sequence that parks the rail cursor on a system row from the top of
 * the rail (two config repos precede the system block in these fixtures).
 * Feed through `tap` — a multi-char stdin.write lands as ONE input string. */
export const TO_QUEUE_ROW = "jj"; // acme/api → beta/two → queue
export const TO_OUTBOX_ROW = "jjj";
export const TO_WORKTREES_ROW = "jjjj";
export const TO_DAEMON_ROW = "jjjjj";
export const TO_LOGS_ROW = "jjjjjj";

/** Write each key as its own stdin chunk with a tick between — ink delivers a
 * multi-char chunk as a single `input` string, which matches no key branch. */
export async function tap(
  r: { stdin: { write: (s: string) => void } },
  keys: string,
): Promise<void> {
  for (const k of keys) {
    r.stdin.write(k);
    await new Promise((res) => setTimeout(res, 5));
  }
}

export const EMPTY_QUEUE: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  taskTimeoutSeconds: null,
  running: [],
  waiting: [],
  recent: [],
  error: null,
  outboxDepth: 0,
  stats: null,
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
        updatedAt: null,
        stale: false,
        repoPath: null,
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
        queuedAt: null,
        repoPath: null,
      },
    ],
    recent: [
      {
        id: "gh-acme-api-9",
        github: { nwo: "acme/api", issue: 9, kind: "pr", external: false },
        status: "failed",
        finishedAt: "2026-07-07T10:05:00Z",
        resultStatus: null,
        durationSeconds: null,
        prUrl: null,
        repoPath: null,
      },
    ],
  },
  counts: { done: 12, failed: 3 },
  outbox: {
    depth: 2,
    dead: 1,
    // ≥2 ops with locatable issueKeys — the mouse row-click specs locate the
    // second row by its "acme/api#2" target text.
    ops: [
      {
        id: "op-acme-api-1",
        path: "/x/github-outbox/op-acme-api-1.json",
        createdAt: "2026-07-07T09:59:00Z",
        origin: "dashboard",
        issueKey: "acme/api#1",
        attempts: 1,
        lastError: null,
        op: { kind: "labels", nwo: "acme/api", issue: 1, add: [], remove: [] },
      },
      {
        id: "op-acme-api-2",
        path: "/x/github-outbox/op-acme-api-2.json",
        createdAt: "2026-07-07T09:58:00Z",
        origin: "dashboard",
        issueKey: "acme/api#2",
        attempts: 1,
        lastError: null,
        op: { kind: "labels", nwo: "acme/api", issue: 2, add: [], remove: [] },
      },
    ],
    deadOps: [],
    error: null,
  },
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
    gate: null,
    spend: null,
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

/** Two GitHub issues for the selected repo — the mouse row-click specs need
 * ≥2 rows (and one numbered #2). Returned for every repo since the stub ignores
 * nwo; LOCAL-mode suites never render this list. */
export const ISSUES: DashIssue[] = [
  {
    number: 1,
    title: "First issue",
    labels: ["junco"],
    updatedAt: "2026-07-06T10:00:00Z",
    url: "https://github.com/acme/api/issues/1",
    author: null,
  },
  {
    number: 2,
    title: "Second issue",
    labels: ["junco"],
    updatedAt: "2026-07-06T09:00:00Z",
    url: "https://github.com/acme/api/issues/2",
    author: null,
  },
];

const STUB_FILE_BATCH = {
  id: "stub",
  nwo: "o/r",
  external: true,
  autoPlan: false,
  repoPath: "/x",
  createdAt: "2026-07-09T00:00:00.000Z",
  findings: [],
};

export const stubClient: DashboardClient = {
  listIssues: async () => okv({ issues: ISSUES, staleAt: null }),
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
  ensureBotAccess: async () => okv({ skipped: true }),
  botGrantPreflight: async () => okv({ needed: false as const }),
  dispatchTicket: async (nwo, num) => okv({ id: `gh-${nwo}-${num}`, destPath: "/x" }),
  listReview: async () => okv([]),
  fileReview: async () =>
    okv({
      created: 0,
      queuedOffline: 0,
      deduped: 0,
      failed: 0,
      urls: [],
      warnings: [],
      batch: STUB_FILE_BATCH,
    }),
  listCommentDrafts: async () => okv([]),
  postCommentDraft: async () => okv({ outcome: "sent" as const, url: null }),
  discardCommentDraft: async () => okv(null),
  discardReview: async () => okv(null),
  analyzeIssue: async () => okv({ id: "analyze-x-y-1" }),
  readTranscript: async () => okv({ kind: "missing" as const, path: "/x/transcripts/t.jsonl" }),
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

/** The full fake AppProps set `renderApp` mounts, as a plain object. Exported
 * so callers that host `App` themselves (e.g. the Root FTUE switcher tests,
 * which feed this as `buildAppProps`) get the identical prop set without the
 * MouseProvider wrapper. */
export function makeAppProps(over: Partial<AppProps> = {}): AppProps {
  const runCli: AppProps["runCliFn"] =
    over.runCliFn ?? (async () => ({ code: 0, output: "ok", timedOut: false }));
  return {
    client: stubClient,
    trigger: "junco",
    branchPrefix: "junco/",
    configRepos: [
      { nwo: "acme/api", path: "/c/api" },
      { nwo: "beta/two", path: "/c/two" },
    ],
    watchlistFile: "/tmp/wl.json",
    configPath: "/x/config.json",
    clonesDir: "/x/state/repos",
    logPath: "/x/state/worker.log",
    refreshPollMs: 999999,
    healthPollMs: 999999,
    queuePollMs: 999999,
    clockMs: 999_999,
    queueFn: async () => EMPTY_QUEUE,
    assessHistoryFn: async () => [],
    localCheapFn: async () => CHEAP,
    localHeavyFn: async () => HEAVY,
    localCheapPollMs: 999999,
    localHeavyPollMs: 999999,
    githubEnabled: true,
    runCliFn: runCli,
    sizeOverride: { columns: WIDE_COLS_TEST, rows: 30 },
    onExit: () => {},
    ...over,
  };
}

export function renderApp(over: Partial<AppProps> = {}): ReturnType<typeof render> {
  return render(
    <MouseProvider>
      <App {...makeAppProps(over)} />
    </MouseProvider>,
  );
}
