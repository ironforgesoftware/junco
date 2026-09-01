import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { App } from "../src/tui/App.js";
import { MouseProvider } from "../src/tui/MouseProvider.js";
import { NWO_MAX_WIDTH } from "../src/tui/components/PrList.js";
import { readWatchlist, writeWatchlist } from "../src/watchlist.js";
import { githubTicketId } from "../src/githubInbox.js";
import type { DashboardClient, HealthInfo, Result } from "../src/tui/ghClient.js";
import type { DashIssue } from "../src/tui/state.js";
import type { DashPr } from "../src/tui/prState.js";
import type { CliRunResult } from "../src/tui/cliRunner.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";
import type { LocalCheap } from "../src/tui/localSnapshot.js";
import type { AssessHistory } from "../src/assessHistory.js";
import type { UnwatchPlan } from "../src/unwatchCmd.js";
import { until, fireUntil } from "./helpers/until.js";
import { makeDashPr, makeDashIssue } from "./helpers/dashFixtures.js";
import { summarizeTranscript } from "../src/transcriptSummary.js";
import {
  agentStart,
  runEnd,
  runStart,
  toolStartId,
  turnEndFull,
} from "./helpers/transcriptFixtures.js";

// Every App mount registers a `process.on("exit")` listener via MouseProvider;
// this file's ~57 renders never unmount on their own, which trips Node's
// MaxListenersExceededWarning. Unmount after each test so listeners are freed.
afterEach(cleanup);

const okv = <T,>(value: T): Result<T> => ({ ok: true, value });
const STUB_FILE_BATCH = {
  id: "stub",
  nwo: "o/r",
  external: true,
  autoPlan: false,
  repoPath: "/x",
  createdAt: "2026-07-09T00:00:00.000Z",
  findings: [],
};
const CLONES_DIR = "/x/state/repos";
const ESC = String.fromCharCode(27);

/** Every pulse field populated — the header-pulse wiring tests share this. */
const RICH_HEALTH: HealthInfo = {
  up: true,
  uptimeSeconds: 3600,
  lastBridgeSweepAt: null,
  ticketsBridged: 0,
  tasksProcessed: 10,
  tasksSucceeded: 8,
  tasksFailed: 2,
  lastTaskStatus: "completed",
  lastTaskAt: new Date().toISOString(),
  totalTokensOut: 45_000,
  bridgeErrors: 0,
};

const QUEUE_SNAP: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  taskTimeoutSeconds: null,
  running: [
    {
      id: "gh-acme-api-46",
      github: { nwo: "acme/api", issue: 46, kind: "pr", external: false },
      turns: 3,
      lastTool: "bash",
      outputTokens: 500,
      startedAt: "2026-07-07T10:00:00Z",
      updatedAt: null,
      stale: false,
      repoPath: null,
    },
  ],
  waiting: [
    {
      id: "gh-acme-api-51-plan",
      github: { nwo: "acme/api", issue: 51, kind: "plan", external: false },
      kind: "plan",
      priority: "normal",
      retryCount: 0,
      notBefore: null,
      deferred: false,
      queuedAt: null,
      repoPath: null,
    },
  ],
  recent: [],
  error: null,
  outboxDepth: 4,
  stats: null,
};

// Cheap snapshot for the App tests — feeds the rail's system badges and the
// queue section body (its queue mirrors QUEUE_SNAP so both surfaces agree).
const LOCAL_CHEAP: LocalCheap = {
  queue: QUEUE_SNAP,
  counts: null,
  outbox: { depth: QUEUE_SNAP.outboxDepth, dead: 0, ops: [], deadOps: [], error: null },
  daemon: {
    up: true,
    pid: null,
    uptimeSeconds: null,
    endpointReachable: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    guardNudges: null,
    guardKills: null,
    tokensIn: null,
    tokensOut: null,
    tasksByStatus: {},
    currentTickets: [],
    progress: {},
    gate: null,
    spend: null,
    error: null,
  },
  error: null,
};

const RECENT_DONE = {
  id: "assess-x-1",
  github: null,
  status: "done" as const,
  finishedAt: "2026-07-07T10:05:00Z",
  resultStatus: "completed",
  durationSeconds: 667,
  prUrl: null,
  repoPath: null,
};
const LOCAL_CHEAP_WITH_RECENT: LocalCheap = {
  ...LOCAL_CHEAP,
  queue: { ...QUEUE_SNAP, recent: [RECENT_DONE] },
};
/** Live and tool-less — prose only, the state in which `g` used to be inert
 * (a cursor move over zero anchors is a no-op, so `follow` never paused). */
const LIVE_PROSE = summarizeTranscript([
  runStart({ flow: "pr", modelId: "m" }),
  agentStart(),
  turnEndFull({ text: "working" }),
]);
/** A transcript still being written: one finished turn plus an in-flight call. */
const LIVE_SUMMARY = summarizeTranscript([
  runStart({ flow: "pr", modelId: "m" }),
  agentStart(),
  turnEndFull({
    text: "working",
    calls: [{ id: "c1", name: "read", args: { path: "a" }, result: "r" }],
  }),
  toolStartId("c2", "read", { path: "b" }),
]);
const DONE_SUMMARY = summarizeTranscript([
  runStart({ flow: "assess", modelId: "m" }),
  turnEndFull({
    thinking: "deep thoughts",
    text: "Assessment complete.",
    calls: [{ id: "c1", name: "read", args: { path: "game.js" }, result: "L1\nL2" }],
  }),
  runEnd({ stopReason: "stop", durationMs: 1000 }),
]);

function makeClient(
  issuesByRepo: Record<string, DashIssue[]>,
  opts: { failActions?: boolean; prsByRepo?: Record<string, DashPr[]> } = {},
) {
  const actions: unknown[][] = [];
  const validatePaths: string[] = [];
  const cloned: string[] = [];
  const prCalls: [string, number][] = [];
  const repoOpens: string[] = [];
  const client: DashboardClient = {
    listIssues: async (nwo) => okv({ issues: issuesByRepo[nwo] ?? [], staleAt: null }),
    listPrs: async (nwo) => okv({ prs: opts.prsByRepo?.[nwo] ?? [], staleAt: null }),
    cloneRepo: async (_n, dest) => {
      cloned.push(dest);
      return okv(undefined);
    },
    issueDetail: async () => okv({ body: "the body", planComment: "<!-- junco:plan -->plan!" }),
    applyAction: async (...a) => {
      actions.push(a);
      return opts.failActions ? { ok: false, error: "gh boom" } : okv({ queued: false });
    },
    validateAndPrepareRepo: async (_n, path) => {
      validatePaths.push(path);
      return path === "/bad" ? { ok: false, error: "clone origin is other/thing" } : okv(undefined);
    },
    openInBrowser: async () => okv(undefined),
    openPrInBrowser: async (nwo, num) => {
      prCalls.push([nwo, num]);
      return okv(undefined);
    },
    openRepoInBrowser: async (nwo) => {
      repoOpens.push(nwo);
      return okv(undefined);
    },
    repoPermission: async () => okv({ canPush: true }),
    prepareExternalRepo: async (nwo) => okv({ path: `${CLONES_DIR}/${nwo}`, forkNwo: nwo }),
    ensureBotAccess: async () => okv({ skipped: true }),
    botGrantPreflight: async () => okv({ needed: false as const }),
    dispatchTicket: async (nwo, num) =>
      okv({ id: `gh-${nwo}-${num}`, destPath: `${CLONES_DIR}/${nwo}` }),
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
    analyzeIssue: async () => okv({ id: "x" }),
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
  return { client, actions, validatePaths, cloned, prCalls, repoOpens };
}

/** A client whose listIssues walks a fixed sequence of responses (call N →
 * sequence[min(N, len-1)]) so a test can deliver a re-sorted poll. */
function makeSeqClient(sequence: DashIssue[][]) {
  const actions: unknown[][] = [];
  // Test-controlled latch (see makePrSeqClient): polls return sequence[idx]
  // until the test calls advance(), so a re-sorted delivery can never race
  // the initial render's selection anchor on slow CI runners.
  let idx = 0;
  const advance = () => {
    idx = Math.min(idx + 1, sequence.length - 1);
  };
  const client: DashboardClient = {
    listIssues: async () => okv({ issues: sequence[idx], staleAt: null }),
    listPrs: async () => okv({ prs: [], staleAt: null }),
    cloneRepo: async () => okv(undefined),
    issueDetail: async () => okv({ body: "the body", planComment: null }),
    applyAction: async (...a) => {
      actions.push(a);
      return okv({ queued: false });
    },
    validateAndPrepareRepo: async () => okv(undefined),
    openInBrowser: async () => okv(undefined),
    openPrInBrowser: async () => okv(undefined),
    openRepoInBrowser: async () => okv(undefined),
    repoPermission: async () => okv({ canPush: true }),
    prepareExternalRepo: async (nwo) => okv({ path: `${CLONES_DIR}/${nwo}`, forkNwo: nwo }),
    ensureBotAccess: async () => okv({ skipped: true }),
    botGrantPreflight: async () => okv({ needed: false as const }),
    dispatchTicket: async (nwo, num) =>
      okv({ id: `gh-${nwo}-${num}`, destPath: `${CLONES_DIR}/${nwo}` }),
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
    analyzeIssue: async () => okv({ id: "x" }),
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
  return { client, actions, advance };
}

/** A client whose listPrs serves sequence[idx], where idx only moves when the
 * test calls advance() — so a re-sorted PR poll is delivered exactly when the
 * test is ready for it, never racing the view's mount. Records
 * openPrInBrowser calls so the anchored selection can be asserted. */
function makePrSeqClient(sequence: DashPr[][]) {
  const prCalls: [string, number][] = [];
  // Test-controlled latch: polls keep returning sequence[idx] until the test
  // calls advance(). Poll-count-driven advancement raced the view opening on
  // slow CI runners (the re-sorted list could arrive before the selection
  // anchor existed), which flaked the required quality gate.
  let idx = 0;
  const advance = () => {
    idx = Math.min(idx + 1, sequence.length - 1);
  };
  const client: DashboardClient = {
    listIssues: async () => okv({ issues: [], staleAt: null }),
    listPrs: async () => okv({ prs: sequence[idx], staleAt: null }),
    cloneRepo: async () => okv(undefined),
    issueDetail: async () => okv({ body: "the body", planComment: null }),
    applyAction: async () => okv({ queued: false }),
    validateAndPrepareRepo: async () => okv(undefined),
    openInBrowser: async () => okv(undefined),
    openPrInBrowser: async (nwo, num) => {
      prCalls.push([nwo, num]);
      return okv(undefined);
    },
    openRepoInBrowser: async () => okv(undefined),
    repoPermission: async () => okv({ canPush: true }),
    prepareExternalRepo: async (nwo) => okv({ path: `${CLONES_DIR}/${nwo}`, forkNwo: nwo }),
    ensureBotAccess: async () => okv({ skipped: true }),
    botGrantPreflight: async () => okv({ needed: false as const }),
    dispatchTicket: async (nwo, num) =>
      okv({ id: `gh-${nwo}-${num}`, destPath: `${CLONES_DIR}/${nwo}` }),
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
    analyzeIssue: async () => okv({ id: "x" }),
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
  return { client, prCalls, advance };
}

/** This file's DashPr baseline — an acme/api PR whose junco-branch head
 * survives the branch-prefix filter; override the fields a test cares about. */
const makePr = (over: Partial<DashPr> = {}): DashPr =>
  makeDashPr({
    number: 100,
    title: "Some PR",
    url: "https://github.com/acme/api/pull/100",
    headRefName: "junco/some-slug",
    checks: { pass: 1, fail: 0, pending: 0, total: 1 },
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    createdAt: "2026-07-05T10:00:00Z",
    updatedAt: "2026-07-06T10:00:00Z",
    nwo: "acme/api",
    ...over,
  });

const rawIssue: DashIssue = makeDashIssue({
  number: 7,
  title: "Fix uploads",
  updatedAt: "2026-07-06T10:00:00Z",
  url: "https://github.com/acme/api/issues/7",
});
const readyIssue: DashIssue = { ...rawIssue, number: 9, labels: ["junco", "junco:plan-ready"] };

function renderApp(
  client: DashboardClient,
  watchlistFile: string,
  refreshPollMs = 999999,
  runCliFn?: (name: string, extraArgs: string[]) => Promise<CliRunResult>,
  queueFn: () => Promise<QueueSnapshot> = async () => QUEUE_SNAP,
  onExit: () => void = () => {},
  assessHistoryFn: () => Promise<AssessHistory[]> = async () => [],
  localCheapFn: () => Promise<LocalCheap> = async () => LOCAL_CHEAP,
  transcriptPollMs?: number,
) {
  return render(
    <MouseProvider>
      <App
        client={client}
        trigger="junco"
        branchPrefix="junco/"
        configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
        watchlistFile={watchlistFile}
        configPath="/x/config.json"
        clonesDir={CLONES_DIR}
        logPath="/x/state/worker.log"
        refreshPollMs={refreshPollMs}
        healthPollMs={999999}
        queuePollMs={999999}
        transcriptPollMs={transcriptPollMs}
        queueFn={queueFn}
        assessHistoryFn={assessHistoryFn}
        localCheapFn={localCheapFn}
        localHeavyFn={async () => ({ repos: [], worktrees: [], error: null })}
        localCheapPollMs={999999}
        localHeavyPollMs={999999}
        githubEnabled
        runCliFn={runCliFn}
        // Medium layout: single body pane, so enter still opens the detail view
        // (the legacy flows the App-level tests exercise); wide-mode tests below
        // opt into 130 cols explicitly.
        sizeOverride={{ columns: 100, rows: 30 }}
        onExit={onExit}
      />
    </MouseProvider>,
  );
}
const tick = () => new Promise((r) => setTimeout(r, 30));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake `runCliFn` for the unwatch flow, standing in for `junco unwatch`:
 * the `--plan` call answers with a one-line `PlanOutcome` JSON (override any
 * plan field via `planOver` — `blocked` is the interesting one), the execute
 * call removes the entry from the watchlist file itself (which is what the
 * real CLI does — the dashboard no longer writes the file) and prints the
 * headline. `spawns` records argv so a test can prove exactly which calls the
 * flow made. Every non-unwatch command falls through as a plain success. */
function unwatchCliFake(file: string, nwo: string, planOver: Partial<UnwatchPlan> = {}) {
  const spawns: [string, string[]][] = [];
  const runCliFn = async (name: string, args: string[]): Promise<CliRunResult> => {
    spawns.push([name, args]);
    if (name !== "unwatch") return { code: 0, output: "", timedOut: false };
    if (args.includes("--plan")) {
      const plan: UnwatchPlan = {
        nwo,
        mode: "watched",
        external: false,
        clone: { path: "/c/coral", managed: false },
        items: [],
        kept: ["clone (user-owned): /c/coral"],
        blocked: null,
        ...planOver,
      };
      return { code: 0, output: `${JSON.stringify({ ok: true, plan })}\n`, timedOut: false };
    }
    writeWatchlist(
      file,
      readWatchlist(file).entries.filter((e) => e.nwo.toLowerCase() !== nwo.toLowerCase()),
    );
    return { code: 0, output: `unwatched ${nwo}: deleted 0 item(s)\n`, timedOut: false };
  };
  return { runCliFn, spawns };
}

/** Rail-selection marker: the ▌ cursor sits on the row bearing `nwo`. The rail
 * band is the frame's left 26 cols (same slice as the mouse tests), so a toast
 * or issue row mentioning the nwo can never satisfy it. */
function railSelOn(r: { lastFrame: () => string | undefined }, nwo: string): boolean {
  return (r.lastFrame() ?? "")
    .split("\n")
    .some((l) => l.slice(0, 26).includes("▌") && l.slice(0, 26).includes(nwo));
}

describe("App", () => {
  const wl = () => join(mkdtempSync(join(tmpdir(), "junco-app-")), "wl.json");

  it("loads and renders issues for the selected repo", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue, readyIssue] });
    const r = renderApp(client, wl());
    // Initial listIssues is async — bounded until-loop, never a fixed tick.
    await until(() => (r.lastFrame() ?? "").includes("#7 Fix uploads"));
    expect(r.lastFrame()).toContain("plan-ready"); // sorted: #9 first, but both visible
  });

  it("renders the assess indicator in the rail from assessHistoryFn", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const h: AssessHistory = {
      id: "acme/api", // must match a watched repo in the fixture's config
      lastSuccessAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      lastFound: 4,
      lastParked: 4,
      lastFailureAt: null,
      lastFailureReason: null,
    };
    const r = renderApp(
      client,
      wl(),
      999999,
      undefined,
      async () => QUEUE_SNAP,
      () => {},
      async () => [h],
    );
    // The poll fires on mount and lands via setState. Loop-until-condition with a
    // bounded retry — never one fixed tick: a slow CI runner races React's commit
    // and a fixed timeout flakes (CLAUDE.md Ink gotcha; this flaked a release gate).
    for (let i = 0; i < 50; i++) {
      if ((r.lastFrame() ?? "").includes("4⚠")) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(r.lastFrame()).toContain("4⚠");
  });

  it("renders a clean-audit indicator (0✓) in the rail from assessHistoryFn", async () => {
    // "—" (never-assessed vs. broken wiring) is indistinguishable by design —
    // see fmtAssessIndicator (queueFmt.ts) and Rail's `r.assess ?? null`
    // fallback — so a "—" assertion here can never prove the poll/threading
    // actually works. "0✓" only reaches the frame through a real, non-null
    // AssessHistory record with lastFound: 0, so it discriminates the same
    // way "4⚠" above does. The never-assessed "—" rendering is already
    // covered at the right level: fmtAssessIndicator(null) in
    // tests/tuiQueue.test.tsx (Task 2) and Rail's own "never-assessed renders
    // an em dash" in tests/tuiRail.test.tsx (Task 4).
    const { client } = makeClient({ "acme/api": [] });
    const h: AssessHistory = {
      id: "acme/api",
      lastSuccessAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      lastFound: 0,
      lastParked: 0,
      lastFailureAt: null,
      lastFailureReason: null,
    };
    const r = renderApp(
      client,
      wl(),
      999999,
      undefined,
      async () => QUEUE_SNAP,
      () => {},
      async () => [h],
    );
    for (let i = 0; i < 50; i++) {
      if ((r.lastFrame() ?? "").includes("0✓")) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(r.lastFrame()).toContain("0✓");
  });

  it("o on the rail opens the repository page", async () => {
    const { client, repoOpens } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("b"); // pane 1 (the rail) is focused from mount
    await until(() => repoOpens.length === 1);
    expect(repoOpens).toEqual(["acme/api"]);
  });

  it("o in the detail view opens the snapshotted issue", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const issueOpens: number[] = [];
    client.openInBrowser = async (_nwo, num) => {
      issueOpens.push(num);
      return okv(undefined);
    };
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write(ESC + "[C"); // → pane 2 (issues)
    await until(() => (r.lastFrame() ?? "").includes("import")); // pane 2 focused first
    r.stdin.write("\r"); // medium layout → detail view
    await until(() => (r.lastFrame() ?? "").includes("the body"));
    r.stdin.write("b");
    await until(() => issueOpens.length === 1);
    expect(issueOpens).toEqual([7]);
  });

  it("dispatch on a raw issue applies the action optimistically", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // issue loaded before acting
    r.stdin.write("\t"); // focus issues pane
    await tick();
    r.stdin.write("m");
    // Async applyAction + optimistic commit — bounded until-loop, never a fixed tick.
    await until(() => actions.length === 1);
    expect(actions).toEqual([["acme/api", 7, "dispatch", ["junco"]]]);
    await until(() => (r.lastFrame() ?? "").includes("planning")); // optimistic label applied
  });

  it("n drafts an analysis comment for the selected issue", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const analyzed: [string, number][] = [];
    client.analyzeIssue = async (nwo, num) => {
      analyzed.push([nwo, num]);
      return okv({ id: "gh-acme-api-7-analyze" });
    };
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // issue loaded before acting
    r.stdin.write("\t"); // focus issues pane
    await tick();
    r.stdin.write("n");
    await until(() => analyzed.length === 1);
    expect(analyzed).toEqual([["acme/api", 7]]);
    await until(() =>
      (r.lastFrame() ?? "").includes("investigation queued: gh-acme-api-7-analyze"),
    );
    expect(r.lastFrame()).toContain("v to review when parked");
  });

  it("n on the selected issue toasts an error when the client call fails", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    client.analyzeIssue = async () => ({ ok: false, error: "no unowned clone available" });
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("\t");
    await tick();
    r.stdin.write("n");
    await until(() => (r.lastFrame() ?? "").includes("no unowned clone available"));
  });

  it("approve is refused on a raw issue with a reason toast (no client call)", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // issue loaded before acting
    r.stdin.write("\t");
    await tick();
    r.stdin.write("o");
    // The refusal is now an auto-expiring toast — assert presence, not persistence.
    await until(() => r.lastFrame()!.toLowerCase().includes("not available"));
    expect(actions).toHaveLength(0);
  });

  it("failed action rolls back the optimistic update with a toast", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] }, { failActions: true });
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // issue loaded before acting
    r.stdin.write("\t");
    await tick();
    r.stdin.write("m");
    await until(() => (r.lastFrame() ?? "").includes("gh boom"));
    expect(actions).toHaveLength(1);
    expect(r.lastFrame()).not.toContain("planning"); // rolled back
  });

  it("queued action toasts offline info and keeps the optimistic label (no rollback)", async () => {
    const { client: base } = makeClient({ "acme/api": [rawIssue] });
    const client: DashboardClient = { ...base, applyAction: async () => okv({ queued: true }) };
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // issue loaded before acting
    r.stdin.write("\t"); // focus issues pane
    await tick();
    r.stdin.write("m");
    await until(() => (r.lastFrame() ?? "").includes("offline — action queued"));
    expect(r.lastFrame()).toContain("planning"); // optimistic label NOT rolled back
  });

  it("add-repo flow validates then persists to the watchlist", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const file = wl();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("alx/coral");
    await tick();
    r.stdin.write("\r");
    // Ink flushes TextField's isActive-gated useInput subscription on a
    // microtask after the field advances; without this tick the next write
    // still lands in the nwo field (React commits the discrete setState after
    // the synchronous stack unwinds). Matches the tick-after-every-write pattern.
    await tick();
    r.stdin.write("/c/coral");
    await tick();
    r.stdin.write("\r");
    // The submit kicks an async validate→write→load chain; a fixed tick races
    // React's commit on slow runners (this exact class flaked a release gate).
    await until(() => readWatchlist(file).entries.length > 0);
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
    await until(() => (r.lastFrame() ?? "").includes("alx/coral"));
  });

  it("a handler resolving after unmount is swallowed by the aliveRef guard (no crash)", async () => {
    // Hold applyAction open, fire `d` (runAction → applyAction), unmount, THEN
    // resolve to a FAILURE so the continuation would roll labels back and toast.
    // Post-unmount setState is a silent no-op under React 19, so the observable
    // contract is "no throw / no console.error"; the guard keeps it that way if
    // a future React reinstates the setState-after-unmount warning.
    const { client } = makeClient({ "acme/api": [rawIssue] });
    let releaseAction: (() => void) | undefined;
    client.applyAction = () =>
      new Promise((res) => {
        releaseAction = () => res({ ok: false, error: "late boom" });
      });
    const errors: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const r = renderApp(client, wl());
      await until(() => (r.lastFrame() ?? "").includes("#7"));
      r.stdin.write("\t"); // focus issues pane
      await tick();
      r.stdin.write("m"); // runAction("dispatch") → applyAction (now pending)
      await until(() => releaseAction !== undefined);
      r.unmount(); // unmount cleanup flips aliveRef.current = false synchronously
      releaseAction!(); // resolve AFTER unmount — the guard must swallow the .then
      await new Promise((res) => setTimeout(res, 20)); // drain the continuation
      expect(errors).toEqual([]);
    } finally {
      console.error = origError;
    }
  });

  it("add-repo unmounting mid-validate does not write the watchlist (aliveRef guard)", async () => {
    // Submit the add-repo form, then unmount while validateAndPrepareRepo is
    // still in flight. The await-guard must short-circuit the continuation before
    // its durable writeWatchlist — the file must stay unwritten.
    const { client } = makeClient({ "acme/api": [] });
    const file = wl();
    let validateCalled = false;
    let releaseValidate: (() => void) | undefined;
    client.validateAndPrepareRepo = () => {
      validateCalled = true;
      return new Promise((res) => {
        releaseValidate = () => res(okv(undefined));
      });
    };
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("alx/coral");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("/c/coral");
    await tick();
    r.stdin.write("\r"); // submit → handleAddRepo → validateAndPrepareRepo (pending)
    await until(() => validateCalled);
    r.unmount(); // aliveRef.current = false before the validate resolves
    releaseValidate!(); // resolve AFTER unmount — guard returns before writeWatchlist
    await new Promise((res) => setTimeout(res, 20)); // let the continuation (not) run
    expect(readWatchlist(file).entries).toEqual([]); // never persisted
  });

  // `U` no longer writes the watchlist itself: it spawns `unwatch --plan`,
  // shows the itemized plan in the destructive-confirm modal, and only on `y`
  // spawns the real `unwatch` (which owns the deletion AND the file write).
  it("unwatch plans, confirms, then executes via the CLI — config entries still refused", async () => {
    const { client } = makeClient({ "acme/api": [], "alx/coral": [] });
    const file = wl();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const { runCliFn, spawns } = unwatchCliFake(file, "alx/coral");
    const r = renderApp(client, file, 999999, runCliFn);
    await tick();
    r.stdin.write("U"); // selected = acme/api (config)
    await until(() => (r.lastFrame() ?? "").includes("config.json"));
    expect(spawns).toEqual([]); // the config refusal never reaches the CLI
    r.stdin.write("j"); // select alx/coral
    await until(() => railSelOn(r, "alx/coral"));
    r.stdin.write("U"); // → plan spawn → confirm modal
    await until(() => (r.lastFrame() ?? "").includes("unwatch alx/coral"));
    expect(r.lastFrame()).toContain("Continue?");
    r.stdin.write("y");
    // The CLI (faked) owns the write — bounded until-loop, never a fixed tick.
    await until(() => readWatchlist(file).entries.length === 0);
    expect(spawns).toEqual([
      ["unwatch", ["alx/coral", "--plan"]],
      ["unwatch", ["alx/coral"]],
    ]);
    // reloadWatchlist pin: the success toast commits in the same batch as the
    // reload's state updates, so once it shows, the stale mapping is gone …
    await until(() => (r.lastFrame() ?? "").includes("unwatched alx/coral"));
    // … and U now lands on whatever the clamp selected (the config repo or a
    // system row) and is refused WITHOUT a spawn — a third spawn here would
    // mean the mapping survived the CLI's file write (i.e. reload never ran).
    r.stdin.write("U");
    await until(() => {
      const f = r.lastFrame() ?? "";
      return f.includes("config.json") || f.includes("not in watchlist");
    });
    expect(spawns).toHaveLength(2);
  });

  // A ticket in flight for the repo blocks the whole flow at plan time: one
  // spawn, a toast, and no modal — there is nothing to confirm.
  it("a blocked plan toasts and never opens the confirm modal", async () => {
    const { client } = makeClient({ "acme/api": [], "alx/coral": [] });
    const file = wl();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const { runCliFn, spawns } = unwatchCliFake(file, "alx/coral", {
      blocked: { ticketId: "live-1" },
    });
    const r = renderApp(client, file, 999999, runCliFn);
    await tick();
    r.stdin.write("j"); // select alx/coral
    await until(() => railSelOn(r, "alx/coral"));
    r.stdin.write("U");
    await until(() => (r.lastFrame() ?? "").includes("in flight"));
    expect(r.lastFrame()).not.toContain("Continue?");
    expect(spawns).toEqual([["unwatch", ["alx/coral", "--plan"]]]);
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
  });

  it("n dismisses the unwatch confirm without spawning the execute", async () => {
    const { client } = makeClient({ "acme/api": [], "alx/coral": [] });
    const file = wl();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const { runCliFn, spawns } = unwatchCliFake(file, "alx/coral");
    const r = renderApp(client, file, 999999, runCliFn);
    await tick();
    r.stdin.write("j"); // select alx/coral
    await until(() => railSelOn(r, "alx/coral"));
    r.stdin.write("U");
    await until(() => (r.lastFrame() ?? "").includes("unwatch alx/coral"));
    r.stdin.write("n");
    await until(() => !(r.lastFrame() ?? "").includes("unwatch alx/coral"));
    expect(spawns).toEqual([["unwatch", ["alx/coral", "--plan"]]]); // plan only
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
  });

  // Enter must NOT confirm a danger modal: the unwatch confirm opens from an
  // async continuation (after the --plan spawn resolves), so a stray Enter
  // typed at the wrong moment would otherwise trigger a destructive delete the
  // operator never read. Only the literal `y` executes (covered above); here
  // Enter-then-n must leave everything intact — if Enter had confirmed, the
  // execute would have spawned and emptied the watchlist file.
  it("Enter does not confirm the unwatch danger modal", async () => {
    const { client } = makeClient({ "acme/api": [], "alx/coral": [] });
    const file = wl();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const { runCliFn, spawns } = unwatchCliFake(file, "alx/coral");
    const r = renderApp(client, file, 999999, runCliFn);
    await tick();
    r.stdin.write("j"); // select alx/coral
    await until(() => railSelOn(r, "alx/coral"));
    r.stdin.write("U");
    await until(() => (r.lastFrame() ?? "").includes("unwatch alx/coral"));
    r.stdin.write("\r"); // Enter — swallowed by the danger confirm (no state change) …
    r.stdin.write("n"); // … so this still finds the modal open and cancels it
    await until(() => !(r.lastFrame() ?? "").includes("unwatch alx/coral"));
    expect(spawns).toEqual([["unwatch", ["alx/coral", "--plan"]]]); // no execute
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
  });

  it("? opens the help modal", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const r = renderApp(client, wl());
    await tick();
    r.stdin.write("?");
    // The HelpModal is taller than a 30-row terminal; the Workspace top-aligns
    // it so the title survives even though the bottom clips.
    await until(() => (r.lastFrame() ?? "").includes("junco dashboard — keys"));
    expect(r.lastFrame()).toContain("this view"); // the derived-mnemonics section
  });

  // Ctrl-C quits the dashboard. In production the host renders with
  // exitOnCtrlC:false (so the wizard it also hosts can see Ctrl-C — see
  // INK_RENDER_OPTIONS), which means ink no longer auto-quits; App's own
  // dedicated Ctrl-C handler must. ink-testing-library also uses
  // exitOnCtrlC:false, so this exercises that handler at production parity.
  it("Ctrl-C quits the dashboard via App's dedicated handler", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    let exited = false;
    const r = renderApp(client, wl(), 999999, undefined, undefined, () => {
      exited = true;
    });
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("\x03"); // Ctrl-C
    await until(() => exited);
    expect(exited).toBe(true);
  });

  // Fix 1(a): selection is anchored to the issue NUMBER, so a poll that re-sorts
  // the list must not slide a DIFFERENT issue under the cursor — an action key
  // has to keep hitting the issue the operator actually selected.
  it("keeps selection on the same issue number when a poll re-sorts the list", async () => {
    const a7 = { ...rawIssue, number: 7, title: "Fix uploads", updatedAt: "2026-07-06T12:00:00Z" };
    const b8 = { ...rawIssue, number: 8, title: "Other thing", updatedAt: "2026-07-06T10:00:00Z" };
    // First load: #7 newer → top (selected). Poll flips it: #8 newer → #7 slides down.
    const first = [a7, b8];
    const second = [a7, { ...b8, updatedAt: "2026-07-06T14:00:00Z" }];
    const { client, actions, advance } = makeSeqClient([first, second]);
    const r = renderApp(client, wl(), 60);
    await until(() => (r.lastFrame() ?? "").includes("#7")); // first load anchored
    r.stdin.write("\t"); // focus issues pane; selection anchored to #7
    advance(); // only now may polls deliver the re-sorted `second`
    await until(() => {
      const f = r.lastFrame() ?? "";
      const seven = f.indexOf("Fix uploads");
      const eight = f.indexOf("Other thing");
      return eight !== -1 && seven !== -1 && eight < seven; // re-sort rendered: #8 above #7
    });
    r.stdin.write("m"); // dispatch the SELECTED issue
    await until(() => actions.length === 1);
    expect(actions).toEqual([["acme/api", 7, "dispatch", ["junco"]]]);
  });

  // Fix 1(b): the detail view renders a SNAPSHOT taken at open time, so a poll
  // (even one that closes the issue) can never swap the header mid-read.
  it("detail header stays on the opened issue when a poll removes it", async () => {
    const a7 = { ...rawIssue, number: 7, title: "Fix uploads", updatedAt: "2026-07-06T12:00:00Z" };
    const b8 = { ...rawIssue, number: 8, title: "Other thing", updatedAt: "2026-07-06T10:00:00Z" };
    let live: DashIssue[] = [a7, b8]; // #7 top → selected
    let polls = 0; // counted so the test can wait for a post-mutation delivery
    const client: DashboardClient = {
      listIssues: async () => {
        polls++;
        return okv({ issues: live, staleAt: null });
      },
      listPrs: async () => okv({ prs: [], staleAt: null }),
      cloneRepo: async () => okv(undefined),
      issueDetail: async () => okv({ body: "the body", planComment: null }),
      applyAction: async () => okv({ queued: false }),
      validateAndPrepareRepo: async () => okv(undefined),
      openInBrowser: async () => okv(undefined),
      openPrInBrowser: async () => okv(undefined),
      openRepoInBrowser: async () => okv(undefined),
      repoPermission: async () => okv({ canPush: true }),
      prepareExternalRepo: async (nwo) => okv({ path: `${CLONES_DIR}/${nwo}`, forkNwo: nwo }),
      ensureBotAccess: async () => okv({ skipped: true }),
      botGrantPreflight: async () => okv({ needed: false as const }),
      dispatchTicket: async (nwo, num) =>
        okv({ id: `gh-${nwo}-${num}`, destPath: `${CLONES_DIR}/${nwo}` }),
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
      analyzeIssue: async () => okv({ id: "x" }),
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
    const r = renderApp(client, wl(), 60);
    await until(() => (r.lastFrame() ?? "").includes("#7")); // first load rendered
    r.stdin.write("\t"); // focus issues pane (selection = #7)
    await tick();
    r.stdin.write("\r"); // open detail on #7 (snapshot frozen here)
    await until(() => (r.lastFrame() ?? "").includes("the body")); // detail view is open
    live = [b8]; // #7 closed; the next poll drops it from the live list
    const seen = polls;
    await until(() => polls > seen); // a post-mutation poll definitely delivered
    await tick(); // let React commit whatever that delivery caused
    const f = r.lastFrame()!;
    expect(f).toContain("#7 Fix uploads"); // snapshot header survives
    expect(f).not.toContain("#8 Other thing");
  });

  // Fix 2: a corrupt watchlist surfaces a persistent banner AND blocks writes so
  // the unreadable file is never clobbered.
  it("surfaces a corrupt-watchlist banner and refuses add writes", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const file = wl();
    writeFileSync(file, "{ not valid json", "utf8");
    const before = readFileSync(file, "utf8");
    const r = renderApp(client, file);
    // The persistent corrupt-watchlist signal is now the Header's compact
    // "watchlist!" banner chip (the JSON parse detail no longer shows inline).
    await until(() => (r.lastFrame() ?? "").includes("watchlist!"));
    r.stdin.write("a"); // add flow refused
    await until(() => r.lastFrame()!.toLowerCase().includes("unreadable"));
    expect(readFileSync(file, "utf8")).toBe(before); // bytes untouched
  });

  // Fix 5: a leading ~ in the add-repo path is expanded once, in App, before it
  // reaches both the validator and the watchlist write.
  it("expands ~ in the add-repo path before validating and persisting", async () => {
    const { client, validatePaths } = makeClient({ "acme/api": [] });
    const file = wl();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("alx/coral");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("~/code/coral");
    await tick();
    r.stdin.write("\r");
    // The submit kicks an async validate→write chain; fixed ticks race React's
    // commit on slow runners — bounded until-loop on the observable write.
    await until(() => readWatchlist(file).entries.length > 0);
    const entries = readWatchlist(file).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].path.startsWith(homedir())).toBe(true);
    expect(validatePaths[0].startsWith(homedir())).toBe(true);
  });

  // Header pulse wiring at the DEFAULT 100-col (medium) size: the row must
  // stay on exactly one line (layout.ts budgets CHROME_ROWS), the brand mark
  // must survive width pressure, and the wide-only chips (record/last/tok)
  // must be dropped by design — they live in `junco status` instead.
  it("keeps the header on one line at 100 cols; medium drops the wide-only chips", async () => {
    const { client: base } = makeClient({ "acme/api": [rawIssue, readyIssue] });
    const client: DashboardClient = { ...base, health: async () => RICH_HEALTH };
    const r = renderApp(client, wl());
    await until(
      () =>
        (r.lastFrame() ?? "").includes("●1 review") && (r.lastFrame() ?? "").includes("daemon up"),
    );
    const birdLines = r
      .lastFrame()!
      .split("\n")
      .filter((l) => l.includes("🐦"));
    expect(birdLines).toHaveLength(1); // header did not wrap...
    expect(birdLines[0]).toContain("daemon"); // ...and the row runs brand → daemon intact
    expect(birdLines[0]).toContain("●1 review"); // essential chip present in medium
    expect(birdLines[0]).not.toContain("✓8"); // wide-only chips absent by design
    expect(birdLines[0]).not.toContain("last ");
    expect(birdLines[0]).not.toContain("tok ");
  });

  // Unwatching a repo must clear its cached issues from the pulse — the review
  // chip reflects only currently watched repos, never ghost data.
  it("unwatching a repo clears its contribution to the review chip", async () => {
    const { client } = makeClient({ "acme/api": [], "alx/coral": [readyIssue] });
    const file = wl();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const { runCliFn } = unwatchCliFake(file, "alx/coral");
    const r = renderApp(client, file, 999999, runCliFn);
    await tick();
    r.stdin.write("j"); // select alx/coral (pane 1) — its issues load
    await until(() => (r.lastFrame() ?? "").includes("●1 review"));
    r.stdin.write("U"); // → plan → confirm
    await until(() => (r.lastFrame() ?? "").includes("unwatch alx/coral"));
    r.stdin.write("y"); // execute — the issues/staleAt entries drop in onSuccess
    await until(() => !(r.lastFrame() ?? "").includes("●1 review"));
    expect(readWatchlist(file).entries).toEqual([]);
  });

  // SGR helpers — 1-based wire coords.
  const click = (x1: number, y1: number) => `\u001b[<0;${x1};${y1}M\u001b[<0;${x1};${y1}m`;
  const wheelDown = (x1: number, y1: number) => `\u001b[<65;${x1};${y1}M`;

  describe("mouse", () => {
    // NOTE: these assertions are deliberately independent of sortIssues order —
    // they anchor on row POSITIONS (frame lines), never on which issue number
    // happens to sort first.
    it("first click focuses pane 2 + selects; second click on the same row enters detail", async () => {
      const { client } = makeClient({ "acme/api": [rawIssue] });
      const r = renderApp(client, wl());
      await until(() => (r.lastFrame() ?? "").includes("#7"));
      // Issue rows start at absolute y=5 (1-based): header(1) + border(2) + title(3)
      // + column header strip(4). From pane 1 this click only focuses pane 2 +
      // selects (never opens detail); the pane-2 footer hint ("m import") is
      // the observable that it landed.
      await fireUntil(r.stdin, click(30, 5), () => (r.lastFrame() ?? "").includes("import"));
      expect(r.lastFrame() ?? "").not.toContain("the body"); // still the list
      // Now pane 2 + already selected → a second click on the same row = Enter → detail.
      await fireUntil(r.stdin, click(30, 5), () => (r.lastFrame() ?? "").includes("the body"));
    });

    it("click on a rail row switches repos", async () => {
      const { client } = makeClient({
        "acme/api": [rawIssue],
        "beta/web": [{ ...rawIssue, number: 42, title: "Beta bug" }],
      });
      const file = wl();
      writeWatchlist(file, [{ nwo: "beta/web", path: "/c/web" }]);
      const r = renderApp(client, file);
      await until(() => (r.lastFrame() ?? "").includes("#7"));
      // rail row 2 (y=5 → index 1) → beta/web. Anchor the retry cond on the
      // SELECTION, not the loaded issues: a re-fired click on the now-selected
      // row is click-again = enter (opens RepoDetail, #240), so waiting for
      // issue content here livelocked slow runners. Scope the check to the
      // rail's own column band (0-25) — pane 2's selected-row line can share a
      // frame line with an unrelated rail row (they render side by side), so
      // an unscoped substring check can false-positive off pane 2's content.
      await fireUntil(r.stdin, click(3, 5), () =>
        (r.lastFrame() ?? "")
          .split("\n")
          .some((l) => l.slice(0, 26).includes("▌") && l.slice(0, 26).includes("beta/web")),
      );
      // A click that landed twice before React committed may have opened the
      // RepoDetail view — esc restores main (a no-op if it never opened).
      if ((r.lastFrame() ?? "").includes("recent tickets")) r.stdin.write(ESC);
      await until(() => (r.lastFrame() ?? "").includes("Beta bug"));
    });

    it("wheel over the issue list moves the selection down one row", async () => {
      const { client } = makeClient({ "acme/api": [rawIssue, readyIssue] });
      const r = renderApp(client, wl());
      await until(() => (r.lastFrame() ?? "").includes("#7"));
      // Selection starts on row 0 (frame line 4, after the column header strip);
      // after one wheel-down the issue pane's ▌ bar must be on row 1 (frame
      // line 5) — whatever issue sorts there.
      // (The rail's own ▌ sits left of x=26; slice the line to the issues pane.)
      const issueBarOn = (line: number): boolean =>
        ((r.lastFrame() ?? "").split("\n")[line] ?? "").slice(26).includes("▌");
      await until(() => issueBarOn(4));
      // wheelDown moves the selection down one row; the mover clamps at the last
      // row, so re-sending is idempotent.
      await fireUntil(r.stdin, wheelDown(30, 5), () => issueBarOn(5) && !issueBarOn(4));
    });

    it("prs view: click the selected row opens the PR; ↗ link line opens it too (wide)", async () => {
      const { client, prCalls } = makeClient(
        { "acme/api": [] },
        { prsByRepo: { "acme/api": [makePr()] } },
      );
      const r = render(
        <MouseProvider>
          <App
            client={client}
            trigger="junco"
            branchPrefix="junco/"
            configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
            watchlistFile={wl()}
            configPath="/x/config.json"
            clonesDir={CLONES_DIR}
            logPath="/x/state/worker.log"
            refreshPollMs={999999}
            healthPollMs={999999}
            queuePollMs={999999}
            queueFn={async () => QUEUE_SNAP}
            assessHistoryFn={async () => []}
            localCheapFn={async () => LOCAL_CHEAP}
            localHeavyFn={async () => ({ repos: [], worktrees: [], error: null })}
            localCheapPollMs={999999}
            localHeavyPollMs={999999}
            githubEnabled
            sizeOverride={{ columns: 130, rows: 30 }}
            onExit={() => {}}
          />
        </MouseProvider>,
      );
      // The PR title can only appear once the view actually switches to "prs"
      // (the side PrPreview card), so the readiness wait belongs after the
      // keypress.
      r.stdin.write("p");
      await until(() => (r.lastFrame() ?? "").includes("pull requests"));
      await until(() => (r.lastFrame() ?? "").includes("Some PR"));
      // Click-again = enter: row 0 is selected from mount, so the click opens
      // the fullscreen PR overlay (its footer is the unique marker). PrList's
      // column header strip (Task 9) shifts row 0 down one line vs. the
      // pre-header layout, so row 0 now sits at y=5 (was y=4). Opening the
      // overlay unmounts the row, so the retry self-terminates.
      await fireUntil(r.stdin, click(30, 5), () =>
        (r.lastFrame() ?? "").includes("browser · esc back"),
      );
      r.stdin.write(ESC); // back to the prs view, side card visible again
      await until(() => (r.lastFrame() ?? "").includes("pull requests"));
      // 130 cols wide → preview band starts at x=79 (1-based); the side card's
      // ↗ link line (y=5) opens the browser directly (counted with === 1, so the
      // retry stops after the first landed click).
      await fireUntil(r.stdin, click(85, 5), () => prCalls.length === 1);
      expect(prCalls[0]).toEqual(["acme/api", 100]);
      r.unmount();
    });

    it("mouse drives pane 3's PR monitor: click selects, click-again opens the overlay, wheel moves", async () => {
      const { client } = makeClient(
        { "acme/api": [rawIssue] },
        { prsByRepo: { "acme/api": [makePr(), makePr({ number: 101, title: "Second PR" })] } },
      );
      const r = render(
        <MouseProvider>
          <App
            client={client}
            trigger="junco"
            branchPrefix="junco/"
            configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
            watchlistFile={wl()}
            configPath="/x/config.json"
            clonesDir={CLONES_DIR}
            logPath="/x/state/worker.log"
            refreshPollMs={999999}
            healthPollMs={999999}
            queuePollMs={999999}
            queueFn={async () => QUEUE_SNAP}
            assessHistoryFn={async () => []}
            localCheapFn={async () => LOCAL_CHEAP}
            localHeavyFn={async () => ({ repos: [], worktrees: [], error: null })}
            localCheapPollMs={999999}
            localHeavyPollMs={999999}
            githubEnabled
            sizeOverride={{ columns: 130, rows: 30 }}
            onExit={() => {}}
          />
        </MouseProvider>,
      );
      await until(() => (r.lastFrame() ?? "").includes("PRs"));
      // "Some PR"'s title cell truncates to "Some …" in this narrow band once
      // the checks/state/age columns claim their dataset-stable widths (Task
      // 9) — gate readiness on the PR number instead, which always survives.
      await until(() => (r.lastFrame() ?? "").includes("#100"));
      // Pane-3 band at 130 cols starts at x=78 (0-based); its ▌ selection bar
      // and rows live there. PrList's column header strip (Task 9) shifts
      // every row down one line vs. the pre-header layout: row 0 now sits at
      // frame line 4 (0-based), row 1 at line 5.
      const pane3BarOn = (line: number): boolean =>
        ((r.lastFrame() ?? "").split("\n")[line] ?? "").slice(78).includes("▌");
      await until(() => pane3BarOn(4)); // row 0 selected on load
      // 1-based y=6 → row 1 (line 5): focus pane 3 + select (idempotent to the fixed row).
      await fireUntil(r.stdin, click(85, 6), () => pane3BarOn(5) && !pane3BarOn(4));
      // click-again = enter → fullscreen PR overlay (unmounts the row → self-terminates).
      await fireUntil(r.stdin, click(85, 6), () =>
        (r.lastFrame() ?? "").includes("browser · esc back"),
      );
      r.stdin.write(ESC); // back to main; pane-3 selection intact
      await until(() => (r.lastFrame() ?? "").includes("PRs"));
      await until(() => pane3BarOn(5));
      // wheelUp over the monitor moves the selection up; the mover clamps at row 0.
      await fireUntil(r.stdin, `\u001b[<64;85;6M`, () => pane3BarOn(4) && !pane3BarOn(5));
      r.unmount();
    });

    it("leaked mouse sequences never reach the / filter", async () => {
      const { client } = makeClient({ "acme/api": [rawIssue] });
      const r = renderApp(client, wl());
      await until(() => (r.lastFrame() ?? "").includes("#7"));
      r.stdin.write("/");
      await until(() => (r.lastFrame() ?? "").includes("filter")); // filtering hints active
      // A press on the header (y=1 → hit target "none") travels BOTH paths: a
      // real mouse event (harmless no-op) AND a leaked useInput keypress. Without
      // the guard, ink would hand "[<0;30;1M" to the filter as typed text.
      r.stdin.write("\u001b[<0;30;1M");
      r.stdin.write("up");
      await until(() => (r.lastFrame() ?? "").includes("/up"));
      expect(r.lastFrame() ?? "").not.toContain("/[<"); // no garbage prefix in the filter
    });

    it("clicking the ↗ metadata line in the issue detail opens the browser (snapshot number)", async () => {
      const { client } = makeClient({ "acme/api": [rawIssue] });
      const issueOpens: number[] = [];
      client.openInBrowser = async (_nwo, num) => {
        issueOpens.push(num);
        return okv(undefined);
      };
      const r = renderApp(client, wl());
      await until(() => (r.lastFrame() ?? "").includes("#7"));
      r.stdin.write(ESC + "[C"); // → pane 2 (issues)
      await until(() => (r.lastFrame() ?? "").includes("import"));
      r.stdin.write("\r"); // open the issue detail
      await until(() => (r.lastFrame() ?? "").includes("the body"));
      // ↗ metadata row: 1-based y=5, middle band; counted with === 1 so the retry
      // stops after the first landed click.
      await fireUntil(r.stdin, click(30, 5), () => issueOpens.length === 1);
      expect(issueOpens).toEqual([7]);
    });

    it("clicking the ↗ metadata line in the PR overlay opens the browser", async () => {
      const { client, prCalls } = makeClient(
        { "acme/api": [] },
        { prsByRepo: { "acme/api": [makePr()] } },
      );
      const r = renderApp(client, wl());
      r.stdin.write("p");
      await until(() => (r.lastFrame() ?? "").includes("Some PR"));
      r.stdin.write("\r"); // open the fullscreen PR overlay from the prs view
      await until(() => (r.lastFrame() ?? "").includes("browser · esc back"));
      // ↗ metadata row of the overlay card; counted with === 1 so the retry stops
      // after the first landed click.
      await fireUntil(r.stdin, click(30, 5), () => prCalls.length === 1);
      expect(prCalls[0]).toEqual(["acme/api", 100]);
    });

    // The review view (e) is keyboard-driven (cursor-based, no scroll offset);
    // a leaked click/wheel must never fall through to the main-layout hit-test
    // (which would openDetail() and eject the operator into the issue overlay).
    it("review view ignores mouse events: no eject into issue-detail, no stray scroll", async () => {
      const { client } = makeClient({ "acme/api": [rawIssue] });
      (client as { listReview: () => Promise<unknown> }).listReview = async () =>
        okv([
          {
            id: "assess-x-1",
            nwo: "o/r",
            external: true,
            autoPlan: false,
            repoPath: "/x",
            createdAt: "2026-07-09T00:00:00.000Z",
            findings: [
              {
                fingerprint: "f1",
                kind: "code" as const,
                severity: "high" as const,
                ruleId: "R",
                title: "SQL injection",
                description: "",
                references: [],
              },
            ],
          },
        ]);
      const r = renderApp(client, wl());
      await until(() => (r.lastFrame() ?? "").includes("#7"));
      r.stdin.write("v");
      await until(() => (r.lastFrame() ?? "").includes("o/r")); // batch listed
      // Same coordinates that, in the main view, focus pane 2 and (on a second
      // click) open the issue-detail overlay — see "first click focuses pane 2
      // + selects" above. Here they must be a total no-op.
      r.stdin.write(click(30, 5));
      r.stdin.write(click(30, 5));
      r.stdin.write(wheelDown(30, 5));
      await wait(50);
      expect(r.lastFrame() ?? "").toContain("o/r"); // still the batch list
      expect(r.lastFrame() ?? "").not.toContain("the body"); // never ejected into issue detail
      // The view is still alive and keyboard-driven: Enter still drills in.
      r.stdin.write("\r");
      await until(() => (r.lastFrame() ?? "").includes("SQL injection"));
    });
  });
});

describe("header breadcrumbs", () => {
  const wlc = () => join(mkdtempSync(join(tmpdir(), "junco-crumb-")), "wl.json");

  it("shows the repo alone in the main view, then repo ▸ #N in the issue detail", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wlc());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    expect(r.lastFrame()).toContain("acme/api");
    expect(r.lastFrame()).not.toContain("▸ #7");
    // Enter on pane 1's repo row opens RepoDetail, not the issues body (see
    // App's pane===1 return-key branch) — so focus pane 2 explicitly first,
    // mirroring "o in the detail view opens the snapshotted issue" above.
    r.stdin.write(ESC + "[C"); // → pane 2 (issues)
    await until(() => (r.lastFrame() ?? "").includes("import")); // pane 2 focused
    r.stdin.write("\r"); // open the issue detail
    await until(() => (r.lastFrame() ?? "").includes("acme/api ▸ #7"));
  });

  it("shows system ▸ <section> when a system row's body is open", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wlc());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    // ONE watched repo in this watchlist, so a single `j` lands on the queue row.
    r.stdin.write("j");
    await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
  });

  it("t on a RUNNING queue row toasts instead of spawning retry", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const spawned: string[] = [];
    const r = renderApp(client, wlc(), 999999, async (name) => {
      spawned.push(name);
      return { code: 0, output: "", timedOut: false };
    });
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("j"); // rail → queue row
    await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
    r.stdin.write("l"); // into pane 2 — cursor 0 is the RUNNING row (#46)
    await until(() => {
      const line = (r.lastFrame() ?? "").split("\n").find((l) => l.includes("#46 exec"));
      return line !== undefined && line.includes("▌");
    });
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("enter opens its transcript"));
    expect(spawned).toEqual([]);
  });
});

describe("external-repo routing", () => {
  const wle = () => join(mkdtempSync(join(tmpdir(), "junco-ext-")), "wl.json");
  const upIssue: DashIssue = makeDashIssue({
    number: 7,
    title: "Stream bug",
    updatedAt: "2026-07-06T10:00:00Z",
    url: "https://github.com/up/stream/issues/7",
  });

  it("addRepo routes a no-push repo to external fork provisioning", async () => {
    const { client } = makeClient({ "acme/api": [] });
    client.repoPermission = async () => okv({ canPush: false });
    client.prepareExternalRepo = async (nwo) => okv({ path: `/ext/${nwo}`, forkNwo: "me/stream" });
    const file = wle();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("up/stream");
    await tick();
    r.stdin.write("\r"); // → path field
    await tick();
    r.stdin.write("\r"); // EMPTY path → external fork route
    // Async permission→provision→write chain — bounded until-loop, never fixed ticks.
    await until(() => readWatchlist(file).entries.some((e) => e.external === true));
    expect(readWatchlist(file).entries).toEqual([
      { nwo: "up/stream", path: "/ext/up/stream", external: true },
    ]);
    await until(() => (r.lastFrame() ?? "").includes("watching up/stream"));
  });

  it("addRepo with a no-push repo AND an explicit path errors (managed fork mode owns the path)", async () => {
    const { client } = makeClient({ "acme/api": [] });
    client.repoPermission = async () => okv({ canPush: false });
    const file = wle();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("up/stream");
    await tick();
    r.stdin.write("\r"); // → path field
    await tick();
    r.stdin.write("/my/path");
    await tick();
    r.stdin.write("\r"); // non-empty path → refused
    await until(() => (r.lastFrame() ?? "").toLowerCase().includes("no push access"));
    expect(readWatchlist(file).entries).toEqual([]);
  });

  it("addRepo falls through to the owned flow when the permission probe fails (offline)", async () => {
    const { client, validatePaths } = makeClient({ "acme/api": [] });
    client.repoPermission = async () => ({ ok: false, error: "offline" });
    const file = wle();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("alx/coral");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("/c/coral");
    await tick();
    r.stdin.write("\r");
    // perm-not-ok → the existing owned validate→write path runs unchanged.
    await until(() => readWatchlist(file).entries.length > 0);
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
    expect(validatePaths).toEqual(["/c/coral"]);
  });

  it("m on an external repo imports a ticket instead of labeling", async () => {
    const { client, actions } = makeClient({ "acme/api": [], "up/stream": [upIssue] });
    const dispatched: string[] = [];
    client.dispatchTicket = async (nwo, num) => {
      dispatched.push(`${nwo}#${num}`);
      return okv({ id: "gh-up-stream-7", destPath: "/inbox/x.md" });
    };
    const file = wle();
    writeWatchlist(file, [{ nwo: "up/stream", path: "/ext", external: true }]);
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("j"); // select up/stream (pane 1, index 1)
    await until(() => (r.lastFrame() ?? "").includes("#7")); // its issue loaded
    r.stdin.write(ESC + "[C"); // → focus issues pane
    await tick();
    r.stdin.write("m");
    await until(() => dispatched.length === 1);
    expect(dispatched[0]).toBe("up/stream#7");
    expect(actions).toHaveLength(0); // no label flow
    await until(() => (r.lastFrame() ?? "").includes("ticket queued: gh-up-stream-7"));
  });

  it("m on an external repo resolving after unmount is swallowed by the aliveRef guard (no crash)", async () => {
    // Same shape as the pane-2 "m" aliveRef test above, but for the
    // external-repo dispatchTicket branch — its .then lacked the guard.
    const { client } = makeClient({ "acme/api": [], "up/stream": [upIssue] });
    let releaseDispatch: (() => void) | undefined;
    client.dispatchTicket = () =>
      new Promise((res) => {
        releaseDispatch = () => res(okv({ id: "gh-up-stream-7", destPath: "/inbox/x.md" }));
      });
    const file = wle();
    writeWatchlist(file, [{ nwo: "up/stream", path: "/ext", external: true }]);
    const errors: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const r = renderApp(client, file);
      await tick();
      r.stdin.write("j"); // select up/stream (pane 1, index 1)
      await until(() => (r.lastFrame() ?? "").includes("#7")); // its issue loaded
      r.stdin.write(ESC + "[C"); // → focus issues pane
      await tick();
      r.stdin.write("m"); // dispatchTicket now pending
      await until(() => releaseDispatch !== undefined);
      r.unmount(); // unmount cleanup flips aliveRef.current = false synchronously
      releaseDispatch!(); // resolve AFTER unmount — the guard must swallow the .then
      await new Promise((res) => setTimeout(res, 20)); // drain the continuation
      expect(errors).toEqual([]);
    } finally {
      console.error = origError;
    }
  });

  it("n on an external repo drafts an analysis comment too (no refusal)", async () => {
    const { client, actions } = makeClient({ "acme/api": [], "up/stream": [upIssue] });
    const analyzed: string[] = [];
    client.analyzeIssue = async (nwo, num) => {
      analyzed.push(`${nwo}#${num}`);
      return okv({ id: "gh-up-stream-7-analyze" });
    };
    const file = wle();
    writeWatchlist(file, [{ nwo: "up/stream", path: "/ext", external: true }]);
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("j"); // select up/stream (pane 1, index 1)
    await until(() => (r.lastFrame() ?? "").includes("#7")); // its issue loaded
    r.stdin.write(ESC + "[C"); // → focus issues pane
    await tick();
    r.stdin.write("n");
    await until(() => analyzed.length === 1);
    expect(analyzed[0]).toBe("up/stream#7");
    expect(actions).toHaveLength(0); // no label flow
    await until(() =>
      (r.lastFrame() ?? "").includes("investigation queued: gh-up-stream-7-analyze"),
    );
    expect(r.lastFrame() ?? "").not.toContain("not available for external repos");
  });

  it("I/o/R on an external repo explains instead of acting", async () => {
    const { client, actions } = makeClient({ "acme/api": [], "up/stream": [upIssue] });
    const file = wle();
    writeWatchlist(file, [{ nwo: "up/stream", path: "/ext", external: true }]);
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("j"); // select up/stream
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write(ESC + "[C"); // → focus issues pane
    await tick();
    r.stdin.write("I"); // dispatchAsk (guarded mnemonic — "import as ask")
    await until(() => (r.lastFrame() ?? "").includes("not available for external repos"));
    r.stdin.write("o"); // dismisses the toast, then re-explains
    await until(() => (r.lastFrame() ?? "").includes("not available for external repos"));
    expect(actions).toHaveLength(0);
  });
});

describe("PRs view", () => {
  const wlp = () => join(mkdtempSync(join(tmpdir(), "junco-prs-")), "wl.json");

  it("p opens the PRs view, esc returns; p toggles too", async () => {
    const pr = makePr({ number: 42, title: "My PR" });
    const { client } = makeClient({ "acme/api": [] }, { prsByRepo: { "acme/api": [pr] } });
    const r = renderApp(client, wlp());
    await tick();
    r.stdin.write("p"); // open PRs view
    await until(() => (r.lastFrame() ?? "").includes("pull requests ·"));
    expect(r.lastFrame()).toContain("My PR");
    r.stdin.write(ESC); // back to main
    await until(() => !(r.lastFrame() ?? "").includes("pull requests ·"));
    r.stdin.write("p"); // re-open
    await until(() => (r.lastFrame() ?? "").includes("pull requests ·"));
    r.stdin.write("p"); // p toggles closed too
    await until(() => !(r.lastFrame() ?? "").includes("pull requests ·"));
  });

  it("aggregates junco PRs across every watched repo, attention-first", async () => {
    // acme/api (config) contributes a failing PR; alx/coral (watchlist) a merged
    // one. Both must render, and the failing PR sorts above the merged one.
    const failing = makePr({
      nwo: "acme/api",
      number: 10,
      title: "Failing PR",
      checks: { pass: 0, fail: 1, pending: 0, total: 1 },
      updatedAt: "2026-07-06T10:00:00Z",
    });
    const merged = makePr({
      nwo: "alx/coral",
      number: 20,
      title: "Merged PR",
      url: "https://github.com/alx/coral/pull/20",
      headRefName: "junco/merged-slug",
      state: "MERGED",
      mergedAt: "2026-07-06T09:00:00Z",
      updatedAt: "2026-07-06T09:00:00Z",
    });
    const { client } = makeClient(
      { "acme/api": [], "alx/coral": [] },
      { prsByRepo: { "acme/api": [failing], "alx/coral": [merged] } },
    );
    const file = wlp();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("p");
    await until(() => (r.lastFrame() ?? "").includes("Failing PR"));
    const f = r.lastFrame()!;
    expect(f).toContain("Merged PR"); // both repos aggregated into one flat list
    expect(f.indexOf("Failing PR")).toBeLessThan(f.indexOf("Merged PR")); // attention first
  });

  it("o opens the selected PR in the browser with its {nwo, number}", async () => {
    const pr = makePr({ nwo: "acme/api", number: 42, title: "My PR" });
    const { client, prCalls } = makeClient({ "acme/api": [] }, { prsByRepo: { "acme/api": [pr] } });
    const r = renderApp(client, wlp());
    await tick();
    r.stdin.write("p");
    await until(() => (r.lastFrame() ?? "").includes("My PR"));
    r.stdin.write("b");
    await until(() => prCalls.length > 0);
    expect(prCalls).toEqual([["acme/api", 42]]);
  });

  it("enter opens the prDetail overlay (from prs); esc returns with selection intact; o still opens the browser", async () => {
    const a = makePr({
      nwo: "acme/api",
      number: 10,
      title: "PR ten",
      updatedAt: "2026-07-06T12:00:00Z",
    });
    const b = makePr({
      nwo: "acme/api",
      number: 11,
      title: "PR eleven",
      headRefName: "junco/eleven",
      updatedAt: "2026-07-06T10:00:00Z",
    });
    const { client, prCalls } = makeClient(
      { "acme/api": [] },
      { prsByRepo: { "acme/api": [a, b] } },
    );
    const r = renderApp(client, wlp());
    await tick();
    r.stdin.write("p");
    await until(() => (r.lastFrame() ?? "").includes("PR ten"));
    r.stdin.write("j"); // move to PR eleven
    await tick();
    r.stdin.write("\r"); // enter -> prDetail
    await until(() => (r.lastFrame() ?? "").includes("checks:"));
    expect(r.lastFrame()).toContain("PR eleven");
    r.stdin.write(ESC); // back to the prs view
    await until(() => (r.lastFrame() ?? "").includes("pull requests"));
    expect(r.lastFrame()).toContain("PR eleven"); // selection survived the round trip
    r.stdin.write("b"); // o still opens the browser, unchanged
    await until(() => prCalls.length > 0);
    expect(prCalls).toEqual([["acme/api", 11]]);
  });

  it("keeps selection on the same PR number when a poll re-sorts the list", async () => {
    // Both PRs share a group (checks-pending); #10 is newer → top → anchored.
    const a = makePr({
      nwo: "acme/api",
      number: 10,
      title: "PR ten",
      checks: { pass: 0, fail: 0, pending: 1, total: 1 },
      updatedAt: "2026-07-06T12:00:00Z",
    });
    const b = makePr({
      nwo: "acme/api",
      number: 11,
      title: "PR eleven",
      headRefName: "junco/eleven",
      checks: { pass: 0, fail: 0, pending: 1, total: 1 },
      updatedAt: "2026-07-06T10:00:00Z",
    });
    const first = [a, b];
    const second = [a, { ...b, updatedAt: "2026-07-06T14:00:00Z" }]; // #11 now newest → top
    const { client, prCalls, advance } = makePrSeqClient([first, second]);
    const r = renderApp(client, wlp(), 60); // refreshPollMs=60
    await tick();
    r.stdin.write("p"); // open PRs view; `first` is current → selection anchored to #10
    await until(() => (r.lastFrame() ?? "").includes("PR ten"));
    advance(); // only now may polls deliver the re-sorted `second`
    await until(() => {
      const f = r.lastFrame() ?? "";
      const ten = f.indexOf("PR ten");
      const eleven = f.indexOf("PR eleven");
      return eleven !== -1 && ten !== -1 && eleven < ten; // re-sort rendered: #11 above #10
    });
    r.stdin.write("b"); // open the ANCHORED pr
    await until(() => prCalls.length > 0);
    expect(prCalls).toEqual([["acme/api", 10]]); // anchor held despite the re-sort
  });

  // Unwatching a repo must clear its PRs from the aggregate synchronously —
  // the ⚑ attention chip reflects only currently watched repos, never ghost
  // data lingering until the next poll (the reviewCount rule). Mount
  // legitimately fetches the selected repo twice (scoped cycle + startup
  // sweep) and coral once; every later call — including the sweep unwatch
  // itself triggers — hangs forever, so a passing test still proves the
  // SYNCHRONOUS prune in the unwatch onSuccess, not a refetch.
  it("unwatching a repo clears its contribution to the ⚑ PR attention chip", async () => {
    const failing = makePr({
      nwo: "alx/coral",
      number: 30,
      title: "Coral failing PR",
      url: "https://github.com/alx/coral/pull/30",
      headRefName: "junco/coral-fail",
      checks: { pass: 0, fail: 1, pending: 0, total: 1 },
    });
    const { client: base } = makeClient({ "acme/api": [], "alx/coral": [] });
    const budget: Record<string, number> = { "acme/api": 2, "alx/coral": 1 };
    const client: DashboardClient = {
      ...base,
      listPrs: (nwo: string) => {
        if ((budget[nwo] ?? 0) <= 0) return new Promise<never>(() => {});
        budget[nwo] = (budget[nwo] ?? 0) - 1;
        return Promise.resolve(okv({ prs: nwo === "alx/coral" ? [failing] : [], staleAt: null }));
      },
    };
    const file = wlp();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const { runCliFn } = unwatchCliFake(file, "alx/coral");
    const r = renderApp(client, file, 999999, runCliFn);
    await until(() => (r.lastFrame() ?? "").includes("⚑1 PR"));
    r.stdin.write("j"); // select alx/coral (pane 1)
    await tick();
    r.stdin.write("U"); // → plan → confirm
    await until(() => (r.lastFrame() ?? "").includes("unwatch alx/coral"));
    r.stdin.write("y"); // execute — the prs aggregate prunes with the mapping
    await until(() => !(r.lastFrame() ?? "").includes("⚑1 PR"));
    expect(readWatchlist(file).entries).toEqual([]);
    r.stdin.write("p"); // the PRs view itself must not list the pruned PR either
    await until(() => (r.lastFrame() ?? "").includes("pull requests ·"));
    expect(r.lastFrame()).not.toContain("Coral failing PR");
  });
});

describe("command palette + focus keys", () => {
  const wl2 = () => join(mkdtempSync(join(tmpdir(), "junco-pal-")), "wl.json");

  function makeRunner(result: Partial<CliRunResult> = {}) {
    const runs: [string, string[]][] = [];
    const runCliFn = async (name: string, extraArgs: string[]): Promise<CliRunResult> => {
      runs.push([name, extraArgs]);
      return { code: 0, output: "captured output line", timedOut: false, ...result };
    };
    return { runs, runCliFn };
  }

  it("a opens the add-repo form; capital A is assess-auto-plan, not an alias", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const r = renderApp(client, wl2());
    await tick();
    r.stdin.write("a");
    await until(() => (r.lastFrame() ?? "").includes("Watch a repository"));
    r.stdin.write(ESC);
    // Wait for the form to actually close, or a late React commit could leave
    // "Watch a repository" in the frame when the negative assert below runs.
    await until(() => !(r.lastFrame() ?? "").includes("Watch a repository"));
    r.stdin.write("A");
    await tick(); // "A" must be a no-op — a beat, then assert the absence
    expect(r.lastFrame()).not.toContain("Watch a repository");
  });

  it("i jumps to the issues pane (m then imports/dispatches the selected issue)", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl2());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // issue loaded before acting
    r.stdin.write("i"); // issues pane via direct jump — no tab needed
    await tick();
    r.stdin.write("m");
    await until(() => actions.length === 1);
    expect(actions).toEqual([["acme/api", 7, "dispatch", ["junco"]]]);
  });

  it("':' opens the palette; running a command shows its captured output + exit", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeRunner();
    const r = renderApp(client, wl2(), 999999, runCliFn);
    await tick();
    r.stdin.write(":");
    await until(() => (r.lastFrame() ?? "").includes("run a junco command")); // App-level Modal title
    expect(r.lastFrame()).toContain("Runs the junco CLI against this dashboard's config");
    r.stdin.write("doctor");
    await tick();
    r.stdin.write("\r");
    // Async runCliFn resolution — bounded until-loop, never fixed ticks
    // (this assertion raced React's commit on a slow CI runner).
    await until(() => (r.lastFrame() ?? "").includes("captured output line"));
    expect(runs).toEqual([["doctor", []]]);
    const f = r.lastFrame()!;
    expect(f).toContain("junco doctor");
    expect(f).toContain("exit 0");
  });

  it("args flow: list -> args field -> typed args reach the runner", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeRunner();
    const r = renderApp(client, wl2(), 999999, runCliFn);
    await tick();
    r.stdin.write(":");
    await tick();
    r.stdin.write("list");
    await tick();
    r.stdin.write("\r"); // argsHint present -> args mode
    await until(() => (r.lastFrame() ?? "").includes("args:"));
    r.stdin.write("failed");
    await tick();
    r.stdin.write("\r");
    await until(() => runs.length === 1);
    expect(runs).toEqual([["list", ["failed"]]]);
  });

  it("logs runs with bounded default args when none are typed", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeRunner();
    const r = renderApp(client, wl2(), 999999, runCliFn);
    await tick();
    r.stdin.write(":");
    await tick();
    r.stdin.write("logs");
    await tick();
    r.stdin.write("\r"); // args mode
    await tick();
    r.stdin.write("\r"); // empty -> defaults
    await until(() => runs.length === 1);
    expect(runs).toEqual([["logs", ["-n", "200", "--human"]]]);
  });

  it("excluded commands toast the reason and never run", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeRunner();
    const r = renderApp(client, wl2(), 999999, runCliFn);
    await tick();
    r.stdin.write(":");
    await tick();
    // "dashboard" is excluded ("already running") and, unlike "start" (which
    // "restart" also matches), filters uniquely to its own excluded row.
    r.stdin.write("dashboard");
    await tick();
    r.stdin.write("\r");
    // Exclusion reason is now an auto-expiring toast under the modal.
    await until(() => (r.lastFrame() ?? "").includes("already running"));
    expect(runs).toHaveLength(0);
  });

  it("palette restart does not unmount the dashboard", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeRunner({ output: "restarted: pid 1 -> 2" });
    const r = renderApp(client, wl2(), 999999, runCliFn);
    await tick();
    r.stdin.write(":");
    await tick();
    r.stdin.write("restart");
    await tick();
    r.stdin.write("\r");
    // Async runCliFn resolution — bounded until-loop, never fixed ticks.
    await until(() => (r.lastFrame() ?? "").includes("restarted: pid 1 -> 2"));
    expect(runs).toEqual([["restart", []]]);
    const f = r.lastFrame()!;
    expect(f).toContain("exit 0"); // app alive and rendering post-resolve
  });

  it("esc unwinds output -> palette -> main", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runCliFn } = makeRunner();
    const r = renderApp(client, wl2(), 999999, runCliFn);
    await tick();
    r.stdin.write(":");
    await tick();
    r.stdin.write("status");
    await tick();
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("captured output line")); // output view up
    r.stdin.write(ESC); // -> palette
    await until(() =>
      (r.lastFrame() ?? "").includes("Runs the junco CLI against this dashboard's config"),
    );
    r.stdin.write(ESC); // -> main
    await until(
      () => !(r.lastFrame() ?? "").includes("Runs the junco CLI against this dashboard's config"),
    );
    expect(r.lastFrame()).toContain("issues");
  });
});

describe("audit hotkey (u/A)", () => {
  const wl7 = () => join(mkdtempSync(join(tmpdir(), "junco-assess-")), "wl.json");

  function makeAssessRunner(result: Partial<CliRunResult> = {}) {
    const runs: [string, string[]][] = [];
    const runCliFn = async (name: string, extraArgs: string[]): Promise<CliRunResult> => {
      runs.push([name, extraArgs]);
      return { code: 0, output: "queued: /x/inbox/assess-acme-api.md", timedOut: false, ...result };
    };
    return { runs, runCliFn };
  }

  it("u calls the runner once with (audit, [nwo]); success exit shows a toast with the nwo", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeAssessRunner();
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await tick();
    r.stdin.write("u");
    await until(() => (r.lastFrame() ?? "").includes("acme/api: queued:"));
    expect(runs).toEqual([["audit", ["acme/api"]]]);
  });

  it("A includes --auto-plan in the runner args", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeAssessRunner();
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await tick();
    r.stdin.write("A");
    await until(() => runs.length > 0);
    expect(runs).toEqual([["audit", ["acme/api", "--auto-plan"]]]);
  });

  it("nonzero exit shows an error toast with the first non-empty output line", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runCliFn } = makeAssessRunner({
      code: 1,
      output: "\njunco audit: 'acme/api' is not watched — add it under [[github.repos]]\n",
    });
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await tick();
    r.stdin.write("u");
    await until(() => (r.lastFrame() ?? "").includes("is not watched"));
  });

  it("no watched repos: u shows an error toast and never calls the runner", async () => {
    const { client } = makeClient({});
    const { runs, runCliFn } = makeAssessRunner();
    const file = wl7();
    const r = render(
      <App
        client={client}
        trigger="junco"
        branchPrefix="junco/"
        configRepos={[]}
        watchlistFile={file}
        configPath="/x/config.json"
        clonesDir={CLONES_DIR}
        logPath="/x/state/worker.log"
        refreshPollMs={999999}
        healthPollMs={999999}
        queuePollMs={999999}
        queueFn={async () => QUEUE_SNAP}
        assessHistoryFn={async () => []}
        localCheapFn={async () => LOCAL_CHEAP}
        localHeavyFn={async () => ({ repos: [], worktrees: [], error: null })}
        localCheapPollMs={999999}
        localHeavyPollMs={999999}
        githubEnabled
        runCliFn={runCliFn}
        sizeOverride={{ columns: 100, rows: 30 }}
        onExit={() => {}}
      />,
    );
    await tick();
    r.stdin.write("u");
    await until(() => (r.lastFrame() ?? "").toLowerCase().includes("no repo selected"));
    expect(runs).toHaveLength(0);
  });

  it("double press while in flight: exactly one runner call; the second press toasts already-running", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const runs: [string, string[]][] = [];
    const runCliFn = (name: string, extraArgs: string[]): Promise<CliRunResult> => {
      runs.push([name, extraArgs]);
      return new Promise<CliRunResult>(() => {}); // never resolves — still "in flight"
    };
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await tick();
    r.stdin.write("u");
    await tick();
    r.stdin.write("u");
    await until(() => (r.lastFrame() ?? "").toLowerCase().includes("already running"));
    expect(runs).toEqual([["audit", ["acme/api"]]]);
  });

  it("u while the / filter input is active does not trigger the runner", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const { runs, runCliFn } = makeAssessRunner();
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("/"); // enter filter-typing mode
    await tick();
    r.stdin.write("u"); // captured as filter text, not the audit hotkey
    await until(() => (r.lastFrame() ?? "").includes("/u")); // landed in the filter chip
    expect(runs).toHaveLength(0);
  });

  it("u submits an audit for an external repo (no refusal) and hints the review view", async () => {
    const { client } = makeClient({ "acme/api": [], "up/stream": [] });
    const { runs, runCliFn } = makeAssessRunner({ output: "queued: /x/inbox/assess-up-stream.md" });
    const file = wl7();
    writeWatchlist(file, [{ nwo: "up/stream", path: "/ext", external: true }]);
    const r = renderApp(client, file, 999999, runCliFn);
    await tick();
    r.stdin.write("j"); // select up/stream (pane 1, index 1)
    await tick();
    r.stdin.write("u");
    await until(() => runs.length === 1);
    expect(runs).toEqual([["audit", ["up/stream"]]]);
    await until(() => (r.lastFrame() ?? "").includes("up/stream: queued:"));
    expect(r.lastFrame()).toContain("v to review");
    expect(r.lastFrame() ?? "").not.toContain("not available for external repos");
  });

  it("pane 2 focused with an issue selected: u scopes audit to that issue", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const { runs, runCliFn } = makeAssessRunner();
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write(ESC + "[C"); // → focus issues pane
    await tick();
    r.stdin.write("u");
    await until(() => runs.length > 0);
    expect(runs).toEqual([["audit", ["acme/api#7"]]]);
  });

  it("pane 1 focused: u stays repo-scoped even with issues loaded", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const { runs, runCliFn } = makeAssessRunner();
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("u"); // pane defaults to 1
    await until(() => runs.length > 0);
    expect(runs).toEqual([["audit", ["acme/api"]]]);
  });

  it("pane 2 focused with an issue selected: A scopes auto-plan audit to that issue", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const { runs, runCliFn } = makeAssessRunner();
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write(ESC + "[C"); // → focus issues pane
    await tick();
    r.stdin.write("A");
    await until(() => runs.length > 0);
    expect(runs).toEqual([["audit", ["acme/api#7", "--auto-plan"]]]);
  });
});

describe("review view (v)", () => {
  const wl8 = () => join(mkdtempSync(join(tmpdir(), "junco-review-")), "wl.json");

  const reviewBatch = {
    id: "assess-x-1",
    nwo: "o/r",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "f1",
        kind: "code" as const,
        severity: "high" as const,
        ruleId: "R",
        title: "SQL injection",
        description: "",
        references: [],
      },
    ],
  };

  const commentDraft = {
    id: "analyze-o-r-5",
    nwo: "o/r",
    issue: 5,
    issueTitle: "Broken build",
    external: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    draft: "This is the analysis.\nSecond line.",
    footer: true,
  };

  it("v opens the review view and enter drills into a batch's findings", async () => {
    const { client } = makeClient({ "acme/api": [] });
    (client as { listReview: () => Promise<unknown> }).listReview = async () => okv([reviewBatch]);
    const r = renderApp(client, wl8());
    await until(() => (r.lastFrame() ?? "").includes("acme/api"));
    r.stdin.write("v");
    await until(() => (r.lastFrame() ?? "").includes("o/r")); // batch listed
    r.stdin.write("\r"); // enter → checklist
    await until(() => (r.lastFrame() ?? "").includes("SQL injection"));
    r.stdin.write(ESC); // esc → back to batch list
    await until(
      () =>
        (r.lastFrame() ?? "").includes("o/r") && !(r.lastFrame() ?? "").includes("SQL injection"),
    );
  });

  it("no pending batches: v shows the empty state; esc returns to main", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const r = renderApp(client, wl8());
    await until(() => (r.lastFrame() ?? "").includes("acme/api"));
    r.stdin.write("v");
    await until(() => (r.lastFrame() ?? "").includes("no pending audit reviews"));
    r.stdin.write(ESC);
    await until(() => !(r.lastFrame() ?? "").includes("no pending audit reviews"));
    expect(r.lastFrame()).toContain("acme/api");
  });

  it("f files the selection; the batch row STAYS with filed accounting and unfiled stays checked-out", async () => {
    const batches = [
      {
        id: "assess-x-1",
        nwo: "o/r",
        external: true,
        autoPlan: false,
        repoPath: "/x",
        createdAt: "2026-07-09T00:00:00.000Z",
        findings: [
          {
            fingerprint: "f1",
            kind: "code" as const,
            severity: "high" as const,
            ruleId: "R",
            title: "SQL injection",
            description: "",
            references: [],
          },
          {
            fingerprint: "f2",
            kind: "code" as const,
            severity: "low" as const,
            ruleId: "R",
            title: "stale dep",
            description: "",
            references: [],
          },
        ],
      },
    ];
    const filed: Array<[string, string[]]> = [];
    const { client } = makeClient({ "acme/api": [] });
    (client as { listReview: () => Promise<unknown> }).listReview = async () => okv(batches);
    (client as { fileReview: (id: string, fps: string[]) => Promise<unknown> }).fileReview = async (
      id,
      fps,
    ) => {
      filed.push([id, fps]);
      return okv({
        created: fps.length,
        queuedOffline: 0,
        deduped: 0,
        failed: 0,
        urls: [],
        warnings: [],
        batch: {
          ...batches[0],
          filed: Object.fromEntries(
            fps.map((fp) => [fp, { at: "2026-07-09T01:00:00.000Z", how: "created" as const }]),
          ),
        },
      });
    };
    const r = renderApp(client, wl8());
    await until(() => (r.lastFrame() ?? "").includes("acme/api"));
    r.stdin.write("v");
    await until(() => (r.lastFrame() ?? "").includes("o/r"));
    r.stdin.write("\r"); // open batch (all unfiled → all pre-checked)
    await until(() => (r.lastFrame() ?? "").includes("SQL injection"));
    r.stdin.write("j"); // cursor to f2
    r.stdin.write(" "); // uncheck f2
    await until(() => /\[ \].*stale dep/.test(r.lastFrame() ?? ""));
    r.stdin.write("f"); // file
    await until(() => filed.length === 1);
    expect(filed[0]).toEqual(["assess-x-1", ["f1"]]);
    await until(() => (r.lastFrame() ?? "").includes("filed 1")); // toast
    // The checklist stays open: f1 now shows ✓ accounting, f2 keeps its empty box.
    await until(() => /✓.*SQL injection/.test(r.lastFrame() ?? ""));
    expect(r.lastFrame()).toMatch(/\[ \].*stale dep/);
    // Back in the list, the batch row is still there with a filed chip.
    r.stdin.write(ESC);
    await until(() => (r.lastFrame() ?? "").includes("filed 1/2"));
  });

  it("enter pre-checks only UNFILED findings; f refiles nothing already filed", async () => {
    const batches = [
      {
        id: "assess-x-1",
        nwo: "o/r",
        external: true,
        autoPlan: false,
        repoPath: "/x",
        createdAt: "2026-07-09T00:00:00.000Z",
        findings: [
          {
            fingerprint: "f1",
            kind: "code" as const,
            severity: "high" as const,
            ruleId: "R",
            title: "SQL injection",
            description: "",
            references: [],
          },
          {
            fingerprint: "f2",
            kind: "code" as const,
            severity: "low" as const,
            ruleId: "R",
            title: "stale dep",
            description: "",
            references: [],
          },
        ],
        filed: { f1: { at: "2026-07-09T00:30:00.000Z", how: "created" as const } },
      },
    ];
    const filed: Array<[string, string[]]> = [];
    const { client } = makeClient({ "acme/api": [] });
    (client as { listReview: () => Promise<unknown> }).listReview = async () => okv(batches);
    (client as { fileReview: (id: string, fps: string[]) => Promise<unknown> }).fileReview = async (
      id,
      fps,
    ) => {
      filed.push([id, fps]);
      return okv({
        created: fps.length,
        queuedOffline: 0,
        deduped: 0,
        failed: 0,
        urls: [],
        warnings: [],
        batch: batches[0],
      });
    };
    const r = renderApp(client, wl8());
    await until(() => (r.lastFrame() ?? "").includes("acme/api"));
    r.stdin.write("v");
    await until(() => (r.lastFrame() ?? "").includes("o/r"));
    r.stdin.write("\r");
    // f1 is filed → ✓ (not pre-checked); f2 unfiled → pre-checked [x].
    await until(() => /✓.*SQL injection/.test(r.lastFrame() ?? ""));
    expect(r.lastFrame()).toMatch(/\[x\].*stale dep/);
    r.stdin.write("f");
    await until(() => filed.length === 1);
    expect(filed[0]).toEqual(["assess-x-1", ["f2"]]);
  });

  it("x discards the open batch and drops the row", async () => {
    const discarded: string[] = [];
    const { client } = makeClient({ "acme/api": [] });
    (client as { listReview: () => Promise<unknown> }).listReview = async () => okv([reviewBatch]);
    (client as { discardReview: (id: string) => Promise<unknown> }).discardReview = async (id) => {
      discarded.push(id);
      return okv(null);
    };
    const r = renderApp(client, wl8());
    await until(() => (r.lastFrame() ?? "").includes("acme/api"));
    r.stdin.write("v");
    await until(() => (r.lastFrame() ?? "").includes("o/r"));
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("SQL injection"));
    r.stdin.write("D"); // Discard (guarded mnemonic)
    await until(() => discarded.length === 1);
    expect(discarded[0]).toBe("assess-x-1");
    await until(() => (r.lastFrame() ?? "").includes("no pending audit reviews"));
  });

  it("v lists a comment draft row alongside a batch; enter on it opens the preview", async () => {
    const { client } = makeClient({ "acme/api": [] });
    (client as { listReview: () => Promise<unknown> }).listReview = async () => okv([reviewBatch]);
    (client as { listCommentDrafts: () => Promise<unknown> }).listCommentDrafts = async () =>
      okv([commentDraft]);
    const r = renderApp(client, wl8());
    await until(() => (r.lastFrame() ?? "").includes("acme/api"));
    r.stdin.write("v");
    // Both rows present: the batch (o/r + finding count) and the draft (o/r#5 + comment badge).
    await until(
      () => (r.lastFrame() ?? "").includes("o/r#5") && (r.lastFrame() ?? "").includes("comment"),
    );
    r.stdin.write("j"); // cursor past the batch onto the draft row
    r.stdin.write("\r"); // enter → draft preview
    await until(() => (r.lastFrame() ?? "").includes("Broken build")); // issueTitle: preview-only
    expect(r.lastFrame()).toContain("This is the analysis.");
  });

  it("f posts the open draft, toasts success, and drops the row", async () => {
    const posted: string[] = [];
    const { client } = makeClient({ "acme/api": [] });
    (client as { listCommentDrafts: () => Promise<unknown> }).listCommentDrafts = async () =>
      okv([commentDraft]);
    (client as { postCommentDraft: (id: string) => Promise<unknown> }).postCommentDraft = async (
      id,
    ) => {
      posted.push(id);
      return okv({
        outcome: "sent" as const,
        url: "https://github.com/o/r/issues/5#issuecomment-1",
      });
    };
    const r = renderApp(client, wl8());
    await until(() => (r.lastFrame() ?? "").includes("acme/api"));
    r.stdin.write("v");
    await until(() => (r.lastFrame() ?? "").includes("o/r#5"));
    r.stdin.write("\r"); // no batches → cursor 0 opens the draft preview
    await until(() => (r.lastFrame() ?? "").includes("Broken build"));
    r.stdin.write("f"); // post
    await until(() => posted.length === 1);
    expect(posted[0]).toBe(commentDraft.id);
    await until(() => (r.lastFrame() ?? "").includes("posted")); // success toast
    // Optimistic removal → combined empty state.
    await until(() => (r.lastFrame() ?? "").includes("no pending audit reviews"));
  });

  it("x discards the open draft and drops the row", async () => {
    const discarded: string[] = [];
    const { client } = makeClient({ "acme/api": [] });
    (client as { listCommentDrafts: () => Promise<unknown> }).listCommentDrafts = async () =>
      okv([commentDraft]);
    (client as { discardCommentDraft: (id: string) => Promise<unknown> }).discardCommentDraft =
      async (id) => {
        discarded.push(id);
        return okv(null);
      };
    const r = renderApp(client, wl8());
    await until(() => (r.lastFrame() ?? "").includes("acme/api"));
    r.stdin.write("v");
    await until(() => (r.lastFrame() ?? "").includes("o/r#5"));
    r.stdin.write("\r"); // → draft preview
    await until(() => (r.lastFrame() ?? "").includes("Broken build"));
    r.stdin.write("D"); // Discard (guarded mnemonic)
    await until(() => discarded.length === 1);
    expect(discarded[0]).toBe(commentDraft.id);
    await until(() => (r.lastFrame() ?? "").includes("discarded")); // toast
    await until(() => (r.lastFrame() ?? "").includes("no pending audit reviews"));
  });
});

describe("auto-clone add-repo", () => {
  const wl3 = () => join(mkdtempSync(join(tmpdir(), "junco-ac-")), "wl.json");

  it("empty path clones into the managed dir, validates it, and watches it", async () => {
    const { client, cloned, validatePaths } = makeClient({ "acme/api": [] });
    const file = wl3();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("alx/coral");
    await tick();
    r.stdin.write("\r"); // -> path field
    await tick();
    r.stdin.write("\r"); // EMPTY path -> auto-clone
    // Async clone→validate→write chain — bounded until-loop (fixed ticks
    // raced React's commit on slow CI runners).
    await until(() => readWatchlist(file).entries.length > 0);
    const managed = join(CLONES_DIR, "alx", "coral");
    expect(cloned).toEqual([managed]);
    expect(validatePaths).toEqual([managed]);
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: managed }]);
  });

  it("clone failure surfaces as a form error, nothing written", async () => {
    const { client } = makeClient({ "acme/api": [] });
    client.cloneRepo = async () => ({ ok: false, error: "clone exploded" });
    const file = wl3();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("alx/coral");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("\r");
    // Async validate→clone chain — bounded until-loop, never fixed ticks
    // (flaked on CI: assertion ran before the clone rejection committed).
    await until(() => (r.lastFrame() ?? "").includes("clone exploded"));
    expect(readWatchlist(file).entries).toEqual([]);
  });
});

// Task 5: after an owned-repo add succeeds, handleAddRepo's tail calls
// client.ensureBotAccess so the daemon's own identity gets a push grant too —
// the operator's own permission check earlier says nothing about the bot's.
describe("bot access after adding an owned repo", () => {
  const wl5 = () => join(mkdtempSync(join(tmpdir(), "junco-bot-")), "wl.json");

  const addOwnedRepo = (r: ReturnType<typeof renderApp>) => {
    r.stdin.write("a");
    return tick()
      .then(() => r.stdin.write("alx/coral"))
      .then(tick)
      .then(() => r.stdin.write("\r")) // -> path field
      .then(tick)
      .then(() => r.stdin.write("/c/coral"))
      .then(tick)
      .then(() => r.stdin.write("\r")); // submit
  };

  it("a grant success toasts the bot login, on top of the watching toast", async () => {
    const { client } = makeClient({ "acme/api": [] });
    // Non-gated preflight (public/org repo): the legacy silent grant runs.
    client.botGrantPreflight = async () =>
      okv({ needed: true as const, login: "junco-agent", privatePersonal: false });
    client.ensureBotAccess = async () => okv({ skipped: false, login: "junco-agent" });
    const file = wl5();
    const r = renderApp(client, file);
    await tick();
    await addOwnedRepo(r);
    await until(() => readWatchlist(file).entries.length > 0);
    await until(() => (r.lastFrame() ?? "").includes("junco-agent"));
    expect(r.lastFrame()).toContain("bot");
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
  });

  it("a grant failure surfaces the underlying error instead of a fixed prescription", async () => {
    const { client } = makeClient({ "acme/api": [] });
    client.botGrantPreflight = async () =>
      okv({ needed: true as const, login: "junco-agent", privatePersonal: false });
    client.ensureBotAccess = async () => ({ ok: false, error: "needs admin — ask an org admin" });
    const file = wl5();
    const r = renderApp(client, file);
    await tick();
    await addOwnedRepo(r);
    await until(() => readWatchlist(file).entries.length > 0);
    await until(() => (r.lastFrame() ?? "").includes("needs admin — ask an org admin"));
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
  });

  it("a skipped grant (bot mode off / already has access) shows no extra toast", async () => {
    const { client } = makeClient({ "acme/api": [] });
    client.ensureBotAccess = async () => okv({ skipped: true });
    const file = wl5();
    const r = renderApp(client, file);
    await tick();
    await addOwnedRepo(r);
    await until(() => readWatchlist(file).entries.length > 0);
    await until(() => (r.lastFrame() ?? "").includes("watching alx/coral"));
    expect(r.lastFrame()).not.toContain("bot ");
  });

  // Private personal repo: the invite is confirm-gated through the shared
  // modal — `y` grants, `n` skips with the escape-hatch toast (onCancel).
  const gateClient = () => {
    const { client } = makeClient({ "acme/api": [] });
    const grants: string[] = [];
    client.botGrantPreflight = async () =>
      okv({ needed: true as const, login: "junco-agent", privatePersonal: true });
    client.ensureBotAccess = async (nwo: string) => {
      grants.push(nwo);
      return okv({ skipped: false, login: "junco-agent" });
    };
    return { client, grants };
  };

  it("private personal repo: y on the confirm gate runs the grant", async () => {
    const { client, grants } = gateClient();
    const file = wl5();
    const r = renderApp(client, file);
    await tick();
    await addOwnedRepo(r);
    await until(() => (r.lastFrame() ?? "").includes("invite bot as collaborator?"));
    expect(grants).toEqual([]); // gate open — nothing granted yet
    r.stdin.write("y");
    await until(() => (r.lastFrame() ?? "").includes("bot junco-agent granted write"));
    expect(grants).toEqual(["alx/coral"]);
  });

  it("private personal repo: n on the confirm gate skips and toasts the escape hatch", async () => {
    const { client, grants } = gateClient();
    const file = wl5();
    const r = renderApp(client, file);
    await tick();
    await addOwnedRepo(r);
    await until(() => (r.lastFrame() ?? "").includes("invite bot as collaborator?"));
    r.stdin.write("n");
    await until(() => (r.lastFrame() ?? "").includes("bot access skipped"));
    expect(grants).toEqual([]);
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
  });

  // The gate opens ASYNCHRONOUSLY (after the preflight round-trips), so it
  // can land while a text-owning view has taken over — the two views the
  // input cascade returns on before the confirm layer. Both must still
  // operate the modal, not go keyboard-dead (addRepo) or double-handle
  // (config).
  const deferredGateClient = () => {
    const base = gateClient();
    let release!: () => void;
    const released = new Promise<void>((res) => (release = res));
    const gate = okv({ needed: true as const, login: "junco-agent", privatePersonal: true });
    base.client.botGrantPreflight = async () => {
      await released;
      return gate;
    };
    return { ...base, release: () => release() };
  };

  it("gate arriving while the add-repo form is reopened still takes y", async () => {
    const { client, grants, release } = deferredGateClient();
    const file = wl5();
    const r = renderApp(client, file);
    await tick();
    await addOwnedRepo(r);
    await until(() => readWatchlist(file).entries.length > 0);
    r.stdin.write("a"); // reopen the form while the preflight is in flight
    await until(() => (r.lastFrame() ?? "").includes("add repo to watchlist"));
    release();
    await until(() => (r.lastFrame() ?? "").includes("invite bot as collaborator?"));
    r.stdin.write("y");
    await until(() => grants.length > 0);
    expect(grants).toEqual(["alx/coral"]);
  });

  it("gate arriving over the config editor takes enter without leaking into it", async () => {
    const { client, grants, release } = deferredGateClient();
    const file = wl5();
    const r = renderApp(client, file);
    await tick();
    await addOwnedRepo(r);
    await until(() => readWatchlist(file).entries.length > 0);
    r.stdin.write(","); // open the config editor while the preflight is in flight
    await until(() => (r.lastFrame() ?? "").includes("edit/toggle"));
    release();
    await until(() => (r.lastFrame() ?? "").includes("invite bot as collaborator?"));
    r.stdin.write("\r"); // enter = confirm; must NOT start a lever edit below
    await until(() => grants.length > 0);
    expect(grants).toEqual(["alx/coral"]);
    // Back on the config body, still in browse mode — the footer's enter hint
    // reads "edit/toggle" only while no lever edit is open.
    await until(() => (r.lastFrame() ?? "").includes("edit/toggle"));
  });
});

describe("URL paste in add-repo", () => {
  const wl4 = () => join(mkdtempSync(join(tmpdir(), "junco-url-")), "wl.json");

  it("a pasted github URL normalizes to owner/repo everywhere", async () => {
    const { client, cloned, validatePaths } = makeClient({ "acme/api": [] });
    const file = wl4();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("https://github.com/alxedelweiss/hawaiian-coral");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("\r"); // empty path -> auto-clone
    // Async clone→validate→write chain — bounded until-loop, not fixed ticks.
    await until(() => readWatchlist(file).entries.length > 0);
    const managed = join(CLONES_DIR, "alxedelweiss", "hawaiian-coral");
    expect(cloned).toEqual([managed]);
    expect(validatePaths).toEqual([managed]);
    expect(readWatchlist(file).entries).toEqual([
      { nwo: "alxedelweiss/hawaiian-coral", path: managed },
    ]);
  });

  it("unusable input shows guidance, nothing runs", async () => {
    const { client, cloned } = makeClient({ "acme/api": [] });
    const file = wl4();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("a");
    await tick();
    r.stdin.write("not a repo");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("owner/repo or a github.com URL"));
    expect(cloned).toEqual([]);
    expect(readWatchlist(file).entries).toEqual([]);
  });
});

describe("refresh animation", () => {
  it("r shows a spinner in the issues header until the reload lands", async () => {
    let resolveSecond:
      | ((v: Result<{ issues: DashIssue[]; staleAt: string | null }>) => void)
      | null = null;
    let calls = 0;
    const { client } = makeClient({ "acme/api": [rawIssue] });
    client.listIssues = async () => {
      calls++;
      if (calls === 1) return okv({ issues: [rawIssue], staleAt: null });
      return new Promise((res) => {
        resolveSecond = res;
      });
    };
    const r = renderApp(client, join(mkdtempSync(join(tmpdir(), "junco-rf-")), "wl.json"));
    await tick();
    r.stdin.write("r");
    const { SPINNER_FRAMES } = await import("../src/tui/components/Spinner.js");
    const hasSpinner = () => SPINNER_FRAMES.some((g: string) => r.lastFrame()!.includes(g));
    // Eventually-consistent on both edges — single fixed ticks flaked on slow
    // CI runners (the assertion raced React's commit).
    await until(hasSpinner);
    resolveSecond!(okv({ issues: [rawIssue], staleAt: null }));
    await until(() => !hasSpinner());
  });
});

describe("queue system row", () => {
  it("the rail's queue row badges the running count from the cheap poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    // The queue-card lines are gone; the queue SYSTEM row carries a ▸1 badge
    // (one running ticket in LOCAL_CHEAP.queue) and the header keeps ◐/⏳.
    await until(() =>
      (r.lastFrame() ?? "").split("\n").some((l) => l.includes("queue") && l.includes("▸1")),
    );
    expect(r.lastFrame()).toContain("◐1"); // header chip (QUEUE_SNAP running)
  });

  it("t jumps to the queue row and shows the queue body; k returns to issues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q2-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("repos")); // mounted
    r.stdin.write("e"); // queue mnemonic (surface-legibility Task 2 shifted it off `u`, now `audit`)
    await until(() => (r.lastFrame() ?? "").includes("running (1/1)"));
    expect(r.lastFrame()).toContain("waiting (1)");
    // esc returns focus to the rail; the queue body stays (body follows the
    // cursor, and the cursor is still on the queue row).
    r.stdin.write(ESC);
    await until(() => (r.lastFrame() ?? "").includes("add repo")); // rail hints back
    expect(r.lastFrame()).toContain("running (1/1)");
    // k moves the cursor back onto the repo row — the issues body returns.
    r.stdin.write("k");
    await until(() => !(r.lastFrame() ?? "").includes("running (1/1)"));
  });

  it("G in a tall queue body parks the cursor at the bottom row (window follows)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q3-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    // A queue taller than the pane, fed through the CHEAP snapshot (the queue
    // section body reads localCheap.queue, not the header's queueFn).
    const tall: QueueSnapshot = {
      ...QUEUE_SNAP,
      waiting: Array.from({ length: 30 }, (_, i) => ({
        id: `manual-row-${String(i).padStart(2, "0")}`,
        github: null,
        kind: "pr" as const,
        priority: "normal" as const,
        retryCount: 0,
        notBefore: null,
        deferred: false,
        queuedAt: null,
        repoPath: null,
      })),
    };
    const cheapTall = { ...LOCAL_CHEAP, queue: tall };
    const r = renderApp(
      client,
      join(dir, "wl.json"),
      999999,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => cheapTall,
    );
    await until(() => (r.lastFrame() ?? "").includes("repos"));
    r.stdin.write("e"); // queue mnemonic (surface-legibility Task 2 shifted it off `u`, now `audit`)
    await until(() => (r.lastFrame() ?? "").includes("running (1/1)"));
    // G parks the section cursor on the LAST selectable row — the window
    // follows it to the bottom and the pane never blanks.
    r.stdin.write("G");
    await until(() => (r.lastFrame() ?? "").includes("row-29"));
    // g returns to the top.
    r.stdin.write("g");
    await until(() => (r.lastFrame() ?? "").includes("row-00"));
  });

  it("footer advertises the queue mnemonic on the rail pane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q4-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("repos")); // mounted
    // The chip renders the bare label (mnemonic char colored); scope to the
    // footer row — "queue" is ambient in the rail's system block.
    await until(() => ((r.lastFrame() ?? "").split("\n").at(-1) ?? "").includes("queue"));
  });
});

describe("workspace filter + pane navigation (medium)", () => {
  const wl5 = () => join(mkdtempSync(join(tmpdir(), "junco-ws-")), "wl.json");
  const upl: DashIssue = makeDashIssue({
    number: 7,
    title: "Fix uploads",
    updatedAt: "2026-07-06T10:00:00Z",
    url: "https://github.com/acme/api/issues/7",
  });
  const db: DashIssue = makeDashIssue({
    number: 9,
    title: "Database migration",
    updatedAt: "2026-07-06T09:00:00Z",
    url: "https://github.com/acme/api/issues/9",
  });

  it("/ filters the issue list, then esc clears it", async () => {
    const { client } = makeClient({ "acme/api": [upl, db] });
    const r = renderApp(client, wl5());
    await until(() => (r.lastFrame() ?? "").includes("Database migration"));
    r.stdin.write("/");
    await tick();
    r.stdin.write("upl"); // substring of "Fix uploads" only
    await until(() => !(r.lastFrame() ?? "").includes("Database migration"));
    expect(r.lastFrame()).toContain("Fix uploads");
    expect(r.lastFrame()).toContain("/upl"); // active-filter chip in the pane title
    r.stdin.write(ESC); // clears the filter + leaves typing mode
    await until(() => (r.lastFrame() ?? "").includes("Database migration"));
  });

  it("→ / ← jump panes — the footer follows the focused pane", async () => {
    // Frames strip ANSI, so accent-title focus is asserted via the pane-specific
    // footer (pane 1 → unwatch; pane 2 → import) rather than color.
    const { client } = makeClient({ "acme/api": [upl] });
    const r = renderApp(client, wl5());
    // "unwatch" is guarded — the winning char (U) renders uppercased in place.
    await until(() => (r.lastFrame() ?? "").includes("Unwatch")); // pane 1 footer
    r.stdin.write(ESC + "[C"); // →
    await until(() => (r.lastFrame() ?? "").includes("import")); // pane 2 footer
    expect(r.lastFrame()).not.toContain("Unwatch");
    r.stdin.write(ESC + "[D"); // ←
    await until(() => (r.lastFrame() ?? "").includes("Unwatch"));
  });

  it("g / G jump to the first / last issue", async () => {
    const { client, actions } = makeClient({ "acme/api": [readyIssue, rawIssue] });
    const r = renderApp(client, wl5());
    await until(() => (r.lastFrame() ?? "").includes("Fix uploads"));
    r.stdin.write(ESC + "[C"); // → focus issues; sorted [#9 plan-ready, #7 raw]
    await tick();
    r.stdin.write("G"); // last → #7 (raw)
    await tick();
    r.stdin.write("m"); // dispatch is valid only on the raw issue
    await until(() => actions.length === 1);
    expect(actions).toEqual([["acme/api", 7, "dispatch", ["junco"]]]);
    r.stdin.write("g"); // first → #9 (plan-ready)
    await tick();
    r.stdin.write("m"); // not allowed there → refusal toast, no new action
    await until(() => r.lastFrame()!.toLowerCase().includes("not available"));
    expect(actions).toHaveLength(1);
  });

  // → mirrors `l` at medium width: there is no pane 3 to reach, so it's inert.
  it("→ is inert at medium width (no pane 3 to reach)", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl5());
    await until(() => (r.lastFrame() ?? "").includes("Fix uploads"));
    r.stdin.write(ESC + "[C"); // → focus issues pane
    await until(() => (r.lastFrame() ?? "").includes("import"));
    r.stdin.write(ESC + "[C"); // →
    await tick();
    expect(r.lastFrame()).not.toContain("← issues"); // pane-3's hint never leaked in
    expect(r.lastFrame()).toContain("import"); // still on pane 2
  });
});

describe("workspace wide mode", () => {
  const wl6 = () => join(mkdtempSync(join(tmpdir(), "junco-wide-")), "wl.json");
  function renderWide(client: DashboardClient, watchlistFile: string) {
    return render(
      <App
        client={client}
        trigger="junco"
        branchPrefix="junco/"
        configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
        watchlistFile={watchlistFile}
        configPath="/x/config.json"
        clonesDir={CLONES_DIR}
        logPath="/x/state/worker.log"
        refreshPollMs={999999}
        healthPollMs={999999}
        queuePollMs={999999}
        queueFn={async () => QUEUE_SNAP}
        assessHistoryFn={async () => []}
        localCheapFn={async () => LOCAL_CHEAP}
        localHeavyFn={async () => ({ repos: [], worktrees: [], error: null })}
        localCheapPollMs={999999}
        localHeavyPollMs={999999}
        githubEnabled
        sizeOverride={{ columns: 130, rows: 30 }}
        onExit={() => {}}
      />,
    );
  }

  // Wide terminals get the FULL header pulse (record, last task, tokens) —
  // the same fixture that medium mode drops down to essentials.
  it("wide mode renders the full header pulse (since-restart task counts and tokens are gone)", async () => {
    const { client: base } = makeClient({ "acme/api": [rawIssue, readyIssue] });
    const client: DashboardClient = { ...base, health: async () => RICH_HEALTH };
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("last ✓"));
    const birdLine = r
      .lastFrame()!
      .split("\n")
      .find((l) => l.includes("🐦"))!;
    expect(birdLine).toContain("●1 review");
    expect(birdLine).toContain("last ✓");
    expect(birdLine).toContain("daemon up");
    expect(birdLine).not.toContain("✓8");
    expect(birdLine).not.toContain("tok 45k");
  });

  // Pane 3 is narrow (capped by layout.previewWidth) and its rows carry a
  // badge + checks + age alongside the title, so titles get tight on room —
  // the PR NUMBER cell is fixed-width (flexShrink 0) and never truncates,
  // making it the robust way to identify a row here.
  it("wide main view: pane 3 lists ONLY the selected repo's PRs; switching repos re-filters it", async () => {
    const apiPr = makePr({ nwo: "acme/api", number: 10, title: "PR" });
    const coralPr = makePr({
      nwo: "alx/coral",
      number: 20,
      title: "PR",
      url: "https://github.com/alx/coral/pull/20",
      headRefName: "junco/coral-slug",
    });
    const { client } = makeClient(
      { "acme/api": [], "alx/coral": [] },
      { prsByRepo: { "acme/api": [apiPr], "alx/coral": [coralPr] } },
    );
    const file = wl6();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const r = renderWide(client, file);
    await until(() => (r.lastFrame() ?? "").includes("#10"));
    expect(r.lastFrame()).not.toContain("#20");
    r.stdin.write("j"); // pane 1 defaults focused — select alx/coral
    await until(() => (r.lastFrame() ?? "").includes("#20"));
    expect(r.lastFrame()).not.toContain("#10");
  });

  // Pane 3's title identifies the scoped repo per the approved mockup
  // ("PRs · acme/reef") and must track the rail's selection, same as the
  // row content does above.
  it("pane 3 title identifies the scoped repo; switching repos updates the title", async () => {
    const apiPr = makePr({ nwo: "acme/api", number: 10, title: "PR" });
    const coralPr = makePr({
      nwo: "alx/coral",
      number: 20,
      title: "PR",
      url: "https://github.com/alx/coral/pull/20",
      headRefName: "junco/coral-slug",
    });
    const { client } = makeClient(
      { "acme/api": [], "alx/coral": [] },
      { prsByRepo: { "acme/api": [apiPr], "alx/coral": [coralPr] } },
    );
    const file = wl6();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const r = renderWide(client, file);
    await until(() => (r.lastFrame() ?? "").includes("PRs · acme/api"));
    r.stdin.write("j"); // pane 1 defaults focused — select alx/coral
    await until(() => (r.lastFrame() ?? "").includes("PRs · alx/coral"));
    expect(r.lastFrame()).not.toContain("PRs · acme/api");
  });

  // A nwo too long to fit the narrow wide-mode preview pane must truncate
  // from the START (tail kept — the discriminating repo-name part) rather
  // than wrap the title onto a second line, which would corrupt PrList's
  // height/windowing math (CHROME one-line pane-title discipline).
  it("a very long nwo truncates from the start so the pane-3 title stays on one line", async () => {
    const longNwo = "organization-with-a-long-name/very-long-repository-name-that-keeps-going";
    const pr = makePr({ nwo: longNwo, number: 10, title: "PR" });
    const { client } = makeClient({ [longNwo]: [] }, { prsByRepo: { [longNwo]: [pr] } });
    const r = render(
      <App
        client={client}
        trigger="junco"
        branchPrefix="junco/"
        configRepos={[{ nwo: longNwo, path: "/c/long" }]}
        watchlistFile={wl6()}
        configPath="/x/config.json"
        clonesDir={CLONES_DIR}
        logPath="/x/state/worker.log"
        refreshPollMs={999999}
        healthPollMs={999999}
        queuePollMs={999999}
        queueFn={async () => QUEUE_SNAP}
        assessHistoryFn={async () => []}
        localCheapFn={async () => LOCAL_CHEAP}
        localHeavyFn={async () => ({ repos: [], worktrees: [], error: null })}
        localCheapPollMs={999999}
        localHeavyPollMs={999999}
        githubEnabled
        sizeOverride={{ columns: 130, rows: 30 }}
        onExit={() => {}}
      />,
    );
    await until(() => (r.lastFrame() ?? "").includes("#10"));
    const tail = longNwo.slice(longNwo.length - (NWO_MAX_WIDTH - 1));
    const frame = r.lastFrame() ?? "";
    // Found as one contiguous substring — proves it rendered on a single
    // physical line (a wrap would split it across two "\n"-joined lines).
    expect(frame).toContain(`PRs · …${tail}`);
    // Scoped to pane 3's own title line — the header's bird line legitimately
    // shows the full untruncated nwo elsewhere in the frame.
    const titleLine = frame.split("\n").find((l) => l.includes("PRs ·"))!;
    expect(titleLine).not.toContain(longNwo);
  });

  it("pane-3 PR rows omit the nwo cell", async () => {
    const pr = makePr({ nwo: "acme/api", number: 10, title: "PR" });
    const { client } = makeClient({ "acme/api": [] }, { prsByRepo: { "acme/api": [pr] } });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("#10"));
    const rowLine = r
      .lastFrame()!
      .split("\n")
      .find((l) => l.includes("#10"))!;
    // Slice past the number cell so Rail's OWN "acme/api" text (a different,
    // earlier column on the same terminal row) can't produce a false negative.
    const afterNumber = rowLine.slice(rowLine.indexOf("#10") + "#10".length);
    expect(afterNumber).not.toContain("acme/api"); // showNwo={false} — row omits the repo cell
  });

  it("pane 3 focused: ↑/↓ moves selection; o opens the selected PR in the browser", async () => {
    const a = makePr({
      nwo: "acme/api",
      number: 10,
      title: "PR",
      updatedAt: "2026-07-06T12:00:00Z",
    });
    const b = makePr({
      nwo: "acme/api",
      number: 11,
      title: "PR",
      headRefName: "junco/eleven",
      updatedAt: "2026-07-06T10:00:00Z",
    });
    const { client, prCalls } = makeClient(
      { "acme/api": [] },
      { prsByRepo: { "acme/api": [a, b] } },
    );
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("#10")); // #10 sorts first (newer)
    r.stdin.write(ESC + "[C"); // → pane 2
    r.stdin.write(ESC + "[C"); // → pane 3
    await until(() => (r.lastFrame() ?? "").includes("← issues"));
    r.stdin.write("j"); // move down to #11
    await tick();
    r.stdin.write("b");
    await until(() => prCalls.length > 0);
    expect(prCalls).toEqual([["acme/api", 11]]);
  });

  it("enter in pane 3 opens the prDetail overlay; esc returns with pane 3 still focused", async () => {
    const pr = makePr({
      nwo: "acme/api",
      number: 10,
      title: "PR",
      headRefName: "junco/ten-slug",
    });
    const { client } = makeClient({ "acme/api": [] }, { prsByRepo: { "acme/api": [pr] } });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("#10"));
    r.stdin.write(ESC + "[C"); // → pane 2
    r.stdin.write(ESC + "[C"); // → pane 3
    await until(() => (r.lastFrame() ?? "").includes("← issues"));
    r.stdin.write("\r"); // enter -> prDetail
    await until(() => (r.lastFrame() ?? "").includes("checks:"));
    expect(r.lastFrame()).toContain("branch:");
    expect(r.lastFrame()).toContain("pr · #10");
    r.stdin.write(ESC);
    await until(() => (r.lastFrame() ?? "").includes("← issues")); // back to pane-3 footer
    expect(r.lastFrame()).toContain("#10"); // selection/list intact
  });

  // This used to focus pane 3 (setPane(3)); the assertion below fails against
  // that old behavior — no key.return there ever calls openDetail, so the
  // detail view's distinctive footer never appears.
  it("enter on pane 2 (wide mode) opens the fullscreen issue detail, not pane-3 focus", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("Fix uploads"));
    r.stdin.write(ESC + "[C"); // → focus issues pane
    await until(() => (r.lastFrame() ?? "").includes("import"));
    r.stdin.write("\r");
    // The detail view's exact footer (scroll · browser · esc back) — pane
    // 3's hint set never produces this combo (no "esc back" there).
    await until(() => (r.lastFrame() ?? "").includes("↑/↓ scroll · browser · esc back"));
    expect(r.lastFrame()).toContain("#7 Fix uploads");
    r.stdin.write(ESC);
    await until(() => (r.lastFrame() ?? "").includes("import"));
  });

  // Proves the autoload machinery is gone, not just unused: on the OLD code a
  // 300ms-debounced issueDetail fetch fires on every selection change while
  // wide + main; waiting 400ms here would have let a lingering autoload land.
  it("moving the issue selection in wide main view never calls the issue-detail fetch", async () => {
    const { client: base } = makeClient({ "acme/api": [rawIssue, readyIssue] });
    let detailCalls = 0;
    const client: DashboardClient = {
      ...base,
      issueDetail: async (nwo, num) => {
        detailCalls++;
        return base.issueDetail(nwo, num);
      },
    };
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("Fix uploads"));
    r.stdin.write(ESC + "[C"); // → focus issues pane
    await until(() => (r.lastFrame() ?? "").includes("import"));
    r.stdin.write("j");
    await tick();
    r.stdin.write("k");
    await wait(400); // longer than the old 300ms debounce
    expect(detailCalls).toBe(0);
  });

  // Pane 3's empty state is scoped to the one repo (not the cross-repo copy
  // the standalone `p` view uses) — the mockup titles the pane per-repo, so
  // the empty state must read that way too.
  it("pane 3 shows the scoped empty state when the selected repo has zero junco PRs", async () => {
    const { client } = makeClient({ "acme/api": [] }, { prsByRepo: { "acme/api": [] } });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("no junco PRs for this repo"));
    expect(r.lastFrame()).not.toContain("no junco PRs found across watched repos");
  });

  it("renders the PrPreview card in pane 3 for the selected PR, in the p view", async () => {
    const pr = makePr({ nwo: "acme/api", number: 42, title: "Wide PR" });
    const { client } = makeClient({ "acme/api": [] }, { prsByRepo: { "acme/api": [pr] } });
    const r = renderWide(client, wl6());
    await tick();
    r.stdin.write("p"); // open PRs view
    // `pr · #42` is the PrPreview pane title — unambiguous vs pane 3's own
    // "PRs · <nwo>" title in the main view.
    await until(() => (r.lastFrame() ?? "").includes("pr · #42"));
    expect(r.lastFrame()).toContain("Wide PR");
  });

  // The standalone `p` view's call site passes neither `title` nor
  // `emptyText` — it must keep rendering PrList's stock cross-repo title,
  // completely unaffected by pane 3's repo-scoped override (a distinct call
  // site with its own props).
  it("the standalone p view keeps PrList's stock title, unaffected by pane 3's scoped title", async () => {
    const pr = makePr({ nwo: "acme/api", number: 42, title: "Wide PR" });
    const { client } = makeClient({ "acme/api": [] }, { prsByRepo: { "acme/api": [pr] } });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("PRs · acme/api")); // pane 3, wide main view
    r.stdin.write("p"); // open the standalone PRs view
    await until(() => (r.lastFrame() ?? "").includes("pull requests · 1"));
    expect(r.lastFrame()).not.toContain("PRs · acme/api"); // pane 3's slot is gone in this view
  });

  // Regression: a wide terminal shrinking below 110 cols while pane 3 (the
  // repo-scoped PR monitor) is focused must not strand focus on a pane that
  // no longer renders.
  it("shrinking below wide while pane 3 is focused clamps focus back to pane 2", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const file = wl6();
    const appEl = (size: { columns: number; rows: number }) => (
      <App
        client={client}
        trigger="junco"
        branchPrefix="junco/"
        configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
        watchlistFile={file}
        configPath="/x/config.json"
        clonesDir={CLONES_DIR}
        logPath="/x/state/worker.log"
        refreshPollMs={999999}
        healthPollMs={999999}
        queuePollMs={999999}
        queueFn={async () => QUEUE_SNAP}
        assessHistoryFn={async () => []}
        localCheapFn={async () => LOCAL_CHEAP}
        localHeavyFn={async () => ({ repos: [], worktrees: [], error: null })}
        localCheapPollMs={999999}
        localHeavyPollMs={999999}
        githubEnabled
        sizeOverride={size}
        onExit={() => {}}
      />
    );
    const r = render(appEl({ columns: 130, rows: 30 }));
    await until(() => (r.lastFrame() ?? "").includes("PRs · acme/api")); // pane 3 mounted, wide
    r.stdin.write(ESC + "[C"); // → pane 2
    r.stdin.write(ESC + "[C"); // → pane 3
    await until(() => (r.lastFrame() ?? "").includes("← issues")); // pane-3 footer hints
    r.rerender(appEl({ columns: 100, rows: 30 })); // shrink below the wide breakpoint
    // Pane 2's footer hint set is back — m import is the reliable marker
    // regardless of the enter-key wording.
    await until(() => (r.lastFrame() ?? "").includes("import"));
    expect(r.lastFrame()).not.toContain("← issues"); // pane-3's hint is gone
  });

  // → is the advertised primary pane-movement key (l is now the quiet alias) —
  // from pane 2 in wide mode it must reach pane 3 exactly like l/enter do, and
  // ← must walk it back one pane at a time to pane 1.
  it("→ from pane 2 focuses pane 3; ← twice returns to pane 1", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("PRs · acme/api")); // pane 3 mounted, wide
    r.stdin.write(ESC + "[C"); // → focus issues pane
    await until(() => (r.lastFrame() ?? "").includes("import"));
    r.stdin.write(ESC + "[C"); // → focuses pane 3
    await until(() => (r.lastFrame() ?? "").includes("← issues"));
    expect(r.lastFrame()).toContain("← issues"); // pane 3 footer still carries ←
    r.stdin.write(ESC + "[D"); // ← back to pane 2
    await until(() => (r.lastFrame() ?? "").includes("import"));
    r.stdin.write(ESC + "[D"); // ← back to pane 1
    await until(() => (r.lastFrame() ?? "").includes("Unwatch")); // guarded: U renders uppercase
  });
});

// ---------------------------------------------------------------------------
// Unified view-scoped refresh (r scopes to the selected repo; the PR monitor
// sweeps every watched repo). The header's ↻ stamp UI is gone (declutter
// sweep) — refreshedAt bookkeeping is asserted through the daemon panel's
// `refreshed` StatRow instead.
// ---------------------------------------------------------------------------

describe("unified refresh", () => {
  const twoRepoWl = () => {
    const file = join(mkdtempSync(join(tmpdir(), "junco-uref-")), "wl.json");
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    return file; // watched = acme/api (config) + alx/coral (watchlist)
  };
  /** A client that records every listIssues/listPrs call's nwo. */
  function makeScopeClient() {
    const issueCalls: string[] = [];
    const listPrCalls: string[] = [];
    const base = makeClient({ "acme/api": [rawIssue], "alx/coral": [] }).client;
    const client: DashboardClient = {
      ...base,
      listIssues: async (nwo) => {
        issueCalls.push(nwo);
        return okv({ issues: nwo === "acme/api" ? [rawIssue] : [], staleAt: null });
      },
      listPrs: async (nwo) => {
        listPrCalls.push(nwo);
        return okv({ prs: [makePr({ nwo })], staleAt: null });
      },
    };
    return { client, issueCalls, listPrCalls };
  }

  it("r in the main view refreshes ONLY the selected repo (issues + PRs)", async () => {
    const { client, issueCalls, listPrCalls } = makeScopeClient();
    const r = renderApp(client, twoRepoWl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    const i0 = issueCalls.length;
    const p0 = listPrCalls.length;
    r.stdin.write("r");
    await until(() => issueCalls.length > i0 && listPrCalls.length > p0);
    await tick();
    expect(issueCalls.slice(i0)).toEqual(["acme/api"]);
    expect(listPrCalls.slice(p0)).toEqual(["acme/api"]); // NOT alx/coral
  });

  it("entering the PR monitor sweeps every watched repo", async () => {
    const { client, listPrCalls } = makeScopeClient();
    const r = renderApp(client, twoRepoWl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    const p0 = listPrCalls.length;
    r.stdin.write("p");
    await until(() => listPrCalls.length >= p0 + 2);
    expect(listPrCalls.slice(p0, p0 + 2).sort()).toEqual(["acme/api", "alx/coral"]);
  });

  it("selecting the daemon system row surfaces the refreshed stamp once a cycle lands", async () => {
    // Task 6: refreshedAt is no longer a dead lint-bridge state — the daemon
    // panel's "refreshed" StatRow is its one consumer.
    const { client } = makeScopeClient();
    const r = renderApp(client, twoRepoWl());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // initial mount cycle lands
    for (const k of "jjjjj") {
      // acme/api → alx/coral → queue → outbox → worktrees → daemon
      r.stdin.write(k);
      await tick();
    }
    await until(() => (r.lastFrame() ?? "").includes("refreshed"));
    await until(() => (r.lastFrame() ?? "").includes("↻")); // non-null stamp, not the "—" placeholder
  });

  /** Walk the rail to the daemon system row: acme/api → alx/coral → queue →
   * outbox → worktrees → daemon (the twoRepoWl watchlist's row order). */
  const toDaemonRow = (r: ReturnType<typeof renderApp>): void => {
    for (const k of "jjjjj") r.stdin.write(k);
  };

  it("offline: the daemon panel's stamp shows the OLDEST cache age, not the cycle time", async () => {
    const staleIso = new Date(Date.now() - 5 * 60_000).toISOString();
    const base = makeClient({ "acme/api": [rawIssue] }).client;
    const client: DashboardClient = {
      ...base,
      listIssues: async () => okv({ issues: [rawIssue], staleAt: null }),
      listPrs: async () => okv({ prs: [], staleAt: staleIso }), // cache-served
    };
    const r = renderApp(client, twoRepoWl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    toDaemonRow(r);
    // 5m, not 0s: one source was served from cache, so the cycle is only as
    // fresh as its oldest input.
    await until(() => (r.lastFrame() ?? "").includes("↻ 5m ago"));
  });

  it("a cycle where nothing delivered never advances the stamp", async () => {
    // A stale (5m old) baseline, not "just now": `queueNow` (the daemon
    // panel's relative-time anchor) freezes at mount and never re-polls in
    // this harness (queuePollMs is fixed absurdly high), so a same-instant
    // "0s ago" before AND after a broken guard would clamp to identical text
    // (relTimeShort floors negative deltas at 0). Anchoring the baseline 5
    // minutes in the past makes a wrongly-advanced stamp visibly diverge.
    const staleIso = new Date(Date.now() - 5 * 60_000).toISOString();
    const base = makeClient({ "acme/api": [rawIssue] }).client;
    let fail = false;
    const client: DashboardClient = {
      ...base,
      listIssues: async () =>
        fail
          ? ({ ok: false, error: "net down" } as const)
          : okv({ issues: [rawIssue], staleAt: null }),
      listPrs: async () =>
        fail ? ({ ok: false, error: "net down" } as const) : okv({ prs: [], staleAt: staleIso }), // cache-served, 5m old
    };
    const r = renderApp(client, twoRepoWl());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // initial mount cycle lands: stamp = 5m old
    fail = true;
    // `r` is pressed while STILL on the acme/api issues row — the refresh
    // action only fires the network cycle when a repo is selected
    // (currentNwo set); from the daemon row it would be a local-only no-op.
    r.stdin.write("r");
    await until(() => (r.lastFrame() ?? "").includes("net down")); // failure surfaced
    toDaemonRow(r);
    // Still 5m, not reset to "0s ago": the failed cycle delivered nothing.
    await until(() => (r.lastFrame() ?? "").includes("↻ 5m ago"));
  });
});

describe("transcript view", () => {
  const wlc = () => join(mkdtempSync(join(tmpdir(), "junco-transcript-")), "wl.json");
  // Each keystroke must land (and re-render) before the next is written: Ink
  // dispatches stdin synchronously, so two writes in a row are both handled by
  // the SAME render's closure — `l` then `j` would move the rail, not the
  // section cursor, because `pane` is still 1 in that closure.
  const cursorOn = (r: { lastFrame: () => string | undefined }, text: string) => () => {
    const line = (r.lastFrame() ?? "").split("\n").find((l) => l.includes(text));
    return line !== undefined && line.includes("▌");
  };

  // SGR press/release at 1-based wire coords (the file's mouse helper).
  const click = (x1: number, y1: number) => `\u001b[<0;${x1};${y1}M\u001b[<0;${x1};${y1}m`;

  /** Queue section open, cursor parked on the recent `assess-x-1` row — the
   * shared prefix of the key flow and the footer-chip flow (which must NOT
   * press enter). */
  const selectRecent = async (client: DashboardClient) => {
    (client as { readTranscript: unknown }).readTranscript = async () =>
      okv({ kind: "read" as const, size: 1, summary: DONE_SUMMARY });
    const r = renderApp(
      client,
      wlc(),
      999999,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => LOCAL_CHEAP_WITH_RECENT,
    );
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("j"); // rail → queue row
    await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
    r.stdin.write("l"); // pane 2, cursor 0 = running
    await until(cursorOn(r, "#46 exec"));
    r.stdin.write("j"); // waiting
    await until(cursorOn(r, "#51 plan"));
    r.stdin.write("j"); // recent (assess-x-1)
    await until(cursorOn(r, "assess-x-1"));
    return r;
  };

  const openRecent = async (client: DashboardClient) => {
    const r = await selectRecent(client);
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("transcript ▸ assess-x-1"));
    return r;
  };

  it("enter on a recent row opens it; esc returns with the cursor preserved", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = await openRecent(client);
    expect(r.lastFrame()).toContain("Assessment complete.");
    expect(r.lastFrame()).toContain("▸ read game.js  → 2 lines");
    expect(r.lastFrame()).toContain("expand"); // footer/chips
    r.stdin.write(ESC);
    await until(
      () =>
        (r.lastFrame() ?? "").includes("system ▸ queue") &&
        !(r.lastFrame() ?? "").includes("Assessment complete."),
    );
    r.stdin.write("\r"); // same row still under the cursor → reopens
    await until(() => (r.lastFrame() ?? "").includes("transcript ▸ assess-x-1"));
  });

  it("t toggles thinking; enter expands the anchored tool result", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = await openRecent(client);
    expect(r.lastFrame()).not.toContain("deep thoughts");
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("deep thoughts"));
    expect(r.lastFrame()).not.toContain("L2");
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("L2"));
  });

  it("enter on a waiting row toasts — no transcript yet", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wlc());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("j");
    await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
    r.stdin.write("l");
    await until(cursorOn(r, "#46 exec")); // pane 2, cursor 0 = the running row
    r.stdin.write("j"); // waiting row (#51)
    await until(cursorOn(r, "#51 plan"));
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("not started yet"));
    expect(r.lastFrame()).toContain("system ▸ queue");
  });

  // The RUNNING-row path (the marquee one): a transcript that does not exist
  // yet, fills in live, and finishes while the view is open. `stage` is
  // advanced by the test rather than a free-running sequence — with a 10ms
  // poll an unattended third answer can land before `until` ever observes the
  // live header, which would make the follow assertions pass vacuously.
  it("enter on a RUNNING row opens a live transcript that fills in and finishes", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    let stage = 0;
    (client as { readTranscript: unknown }).readTranscript = async () =>
      stage === 0
        ? okv({ kind: "missing" as const, path: "/x/t.jsonl" })
        : stage === 1
          ? okv({ kind: "read" as const, size: 3, summary: LIVE_PROSE })
          : stage === 2
            ? okv({ kind: "read" as const, size: 5, summary: LIVE_SUMMARY })
            : okv({ kind: "read" as const, size: 9, summary: DONE_SUMMARY });
    const r = renderApp(
      client,
      wlc(),
      999999,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => LOCAL_CHEAP_WITH_RECENT,
      10,
    );
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("j"); // rail → queue row
    await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
    r.stdin.write("l"); // pane 2, cursor 0 = the running row
    await until(cursorOn(r, "#46 exec"));
    r.stdin.write("\r");
    await until(() => (r.lastFrame() ?? "").includes("transcript ▸ gh-acme-api-46"));
    await until(() => (r.lastFrame() ?? "").includes("waiting for the agent to start…"));
    stage = 1;
    // The view's own header line — the footer chips carry a "follow" chip of
    // their own, so a whole-frame match would never see the tail pause.
    const header = () =>
      (r.lastFrame() ?? "").split("\n").find((l) => l.includes("transcript · gh-acme-api-46")) ??
      "";
    await until(() => header().includes("◐ live · follow"));
    // g pauses the tail on a transcript with no tool calls to move between —
    // the cursor move is a no-op there, so `g` used to leave follow pinned.
    r.stdin.write("g");
    await until(() => header().includes("◐ live") && !header().includes("· follow"));
    stage = 2; // the first tool call lands; the pause holds
    await until(() => (r.lastFrame() ?? "").includes("▸ read a"));
    expect(header()).not.toContain("· follow");
    stage = 3;
    await until(() => (r.lastFrame() ?? "").includes("stop · 1s"));
    r.stdin.write(ESC);
    await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
  });

  it("clicking the enter transcript footer chip opens the transcript", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = await selectRecent(client);
    // Footer chips row: the chip's ClickableBox spans its own "enter transcript"
    // segment, so a press on the `e` lands inside it.
    const lines = (r.lastFrame() ?? "").split("\n");
    const yIdx = lines.findIndex((l) => l.includes("enter transcript"));
    expect(yIdx).toBeGreaterThanOrEqual(0);
    const x = (lines[yIdx] ?? "").indexOf("enter") + 1;
    expect(x).toBeGreaterThan(0);
    // fireUntil: a press can race a freshly-mounted ClickableBox's registration,
    // and this click unmounts its own target (self-terminating — see until.ts).
    await fireUntil(r.stdin, click(x, yIdx + 1), () =>
      (r.lastFrame() ?? "").includes("transcript ▸ assess-x-1"),
    );
  });
});

describe("t on an issue opens its ticket transcript (#330)", () => {
  const wl = () => join(mkdtempSync(join(tmpdir(), "junco-t330-")), "wl.json");
  const NWO = "acme/api";
  const ISSUE_NUMBER = 7; // rawIssue's number
  // Bridged ticket ids (`gh-<owner>-<repo>-<hash>-<n>`) carry no leading
  // stamp — unlike local queue rows (`stripStamp`'d elsewhere) — so a direct
  // id compare against githubTicketId's own output is correct.
  const TICKET_ID = githubTicketId(NWO, ISSUE_NUMBER);

  const focusIssues = async (r: {
    stdin: { write: (s: string) => void };
    lastFrame: () => string | undefined;
  }) => {
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("\t"); // focus issues pane
    await tick();
  };

  it("opens the transcript for a running bridged ticket", async () => {
    const { client } = makeClient({ [NWO]: [rawIssue] });
    const snap: QueueSnapshot = {
      ...QUEUE_SNAP,
      running: [
        {
          id: TICKET_ID,
          github: { nwo: NWO, issue: ISSUE_NUMBER, kind: "pr", external: false },
          turns: 1,
          lastTool: null,
          outputTokens: null,
          startedAt: "2026-07-07T10:00:00Z",
          updatedAt: null,
          stale: false,
          repoPath: null,
        },
      ],
      waiting: [],
      recent: [],
    };
    const r = renderApp(client, wl(), 999999, undefined, async () => snap);
    await focusIssues(r);
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("transcript"));
    expect(r.lastFrame()).toContain(TICKET_ID);
  });

  it("toasts instead of opening when no ticket is in flight for the issue", async () => {
    const { client } = makeClient({ [NWO]: [rawIssue] });
    const emptySnap: QueueSnapshot = { ...QUEUE_SNAP, running: [], waiting: [], recent: [] };
    const r = renderApp(client, wl(), 999999, undefined, async () => emptySnap);
    await focusIssues(r);
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("no ticket in flight"));
    expect(r.lastFrame()).not.toContain("transcript");
  });

  it("toasts 'not started yet' for a waiting ticket", async () => {
    const { client } = makeClient({ [NWO]: [rawIssue] });
    const waitingSnap: QueueSnapshot = {
      ...QUEUE_SNAP,
      running: [],
      recent: [],
      waiting: [
        {
          id: TICKET_ID,
          github: { nwo: NWO, issue: ISSUE_NUMBER, kind: "pr", external: false },
          kind: "pr",
          priority: "normal",
          retryCount: 0,
          notBefore: null,
          deferred: false,
          queuedAt: null,
          repoPath: null,
        },
      ],
    };
    const r = renderApp(client, wl(), 999999, undefined, async () => waitingSnap);
    await focusIssues(r);
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("not started yet"));
  });

  it("opens the transcript for the issue from the open issue-detail view, and esc returns to that detail, not main (R4)", async () => {
    const { client } = makeClient({ [NWO]: [rawIssue] });
    const snap: QueueSnapshot = {
      ...QUEUE_SNAP,
      running: [
        {
          id: TICKET_ID,
          github: { nwo: NWO, issue: ISSUE_NUMBER, kind: "pr", external: false },
          turns: 1,
          lastTool: null,
          outputTokens: null,
          startedAt: "2026-07-07T10:00:00Z",
          updatedAt: null,
          stale: false,
          repoPath: null,
        },
      ],
      waiting: [],
      recent: [],
    };
    const r = renderApp(client, wl(), 999999, undefined, async () => snap);
    await focusIssues(r);
    r.stdin.write("\r"); // medium layout → issue detail view
    await until(() => (r.lastFrame() ?? "").includes("the body"));
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("transcript"));
    expect(r.lastFrame()).toContain(TICKET_ID);
    r.stdin.write(ESC);
    // Detail's `from` is the issue-detail overlay, not main — the frozen
    // detail state was never cleared while the transcript was open, so esc
    // lands right back on the body the user came from (prDetail.from's
    // recipe, mirrored for the transcript, #330/R4).
    await until(() => (r.lastFrame() ?? "").includes("the body"));
  });

  it("esc from a LIST-opened transcript still lands on main, not detail (R4)", async () => {
    const { client } = makeClient({ [NWO]: [rawIssue] });
    const snap: QueueSnapshot = {
      ...QUEUE_SNAP,
      running: [
        {
          id: TICKET_ID,
          github: { nwo: NWO, issue: ISSUE_NUMBER, kind: "pr", external: false },
          turns: 1,
          lastTool: null,
          outputTokens: null,
          startedAt: "2026-07-07T10:00:00Z",
          updatedAt: null,
          stale: false,
          repoPath: null,
        },
      ],
      waiting: [],
      recent: [],
    };
    const r = renderApp(client, wl(), 999999, undefined, async () => snap);
    await focusIssues(r);
    r.stdin.write("t"); // opened straight from the issue list, no detail view
    await until(() => (r.lastFrame() ?? "").includes("transcript"));
    r.stdin.write(ESC);
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    expect(r.lastFrame()).not.toContain("the body"); // never opened the detail overlay
  });

  it("opens the -plan-suffixed transcript for a junco:planning issue (R3)", async () => {
    const planningIssue: DashIssue = { ...rawIssue, labels: ["junco", "junco:planning"] };
    const { client } = makeClient({ [NWO]: [planningIssue] });
    const PLAN_TICKET_ID = githubTicketId(NWO, ISSUE_NUMBER, "plan");
    const snap: QueueSnapshot = {
      ...QUEUE_SNAP,
      running: [
        {
          id: PLAN_TICKET_ID,
          github: { nwo: NWO, issue: ISSUE_NUMBER, kind: "plan", external: false },
          turns: 1,
          lastTool: null,
          outputTokens: null,
          startedAt: "2026-07-07T10:00:00Z",
          updatedAt: null,
          stale: false,
          repoPath: null,
        },
      ],
      waiting: [],
      recent: [],
    };
    const r = renderApp(client, wl(), 999999, undefined, async () => snap);
    await focusIssues(r);
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("transcript"));
    expect(r.lastFrame()).toContain(PLAN_TICKET_ID);
  });
});
