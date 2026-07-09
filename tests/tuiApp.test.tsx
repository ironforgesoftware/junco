import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { App } from "../src/tui/App.js";
import { NWO_MAX_WIDTH } from "../src/tui/components/PrList.js";
import { readWatchlist, writeWatchlist } from "../src/watchlist.js";
import type { DashboardClient, HealthInfo, Result } from "../src/tui/ghClient.js";
import type { DashIssue } from "../src/tui/state.js";
import type { DashPr } from "../src/tui/prState.js";
import type { CliRunResult } from "../src/tui/cliRunner.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

// Every App mount registers a `process.on("exit")` listener via useMouse; this
// file's ~57 renders never unmount on their own, which trips Node's
// MaxListenersExceededWarning. Unmount after each test so listeners are freed.
afterEach(cleanup);

const okv = <T,>(value: T): Result<T> => ({ ok: true, value });
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
  running: [
    {
      id: "gh-acme-api-46",
      github: { nwo: "acme/api", issue: 46, kind: "pr", external: false },
      turns: 3,
      lastTool: "bash",
      outputTokens: 500,
      startedAt: "2026-07-07T10:00:00Z",
      stale: false,
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
    },
  ],
  recent: [],
  error: null,
  outboxDepth: 4,
};

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
    dispatchTicket: async (nwo, num) =>
      okv({ id: `gh-${nwo}-${num}`, destPath: `${CLONES_DIR}/${nwo}` }),
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
    dispatchTicket: async (nwo, num) =>
      okv({ id: `gh-${nwo}-${num}`, destPath: `${CLONES_DIR}/${nwo}` }),
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
    dispatchTicket: async (nwo, num) =>
      okv({ id: `gh-${nwo}-${num}`, destPath: `${CLONES_DIR}/${nwo}` }),
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

/** DashPr fixture — junco-branch head so it survives the branch-prefix filter;
 * override the fields a test cares about. */
const makePr = (over: Partial<DashPr> = {}): DashPr => ({
  number: 100,
  title: "Some PR",
  url: "https://github.com/acme/api/pull/100",
  headRefName: "junco/some-slug",
  baseRefName: "main",
  isDraft: false,
  state: "OPEN",
  reviewDecision: null,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  checks: { pass: 1, fail: 0, pending: 0, total: 1 },
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  createdAt: "2026-07-05T10:00:00Z",
  updatedAt: "2026-07-06T10:00:00Z",
  mergedAt: null,
  author: "junco-bot",
  labels: [],
  nwo: "acme/api",
  ...over,
});

const rawIssue: DashIssue = {
  number: 7,
  title: "Fix uploads",
  labels: ["junco"],
  updatedAt: "2026-07-06T10:00:00Z",
  url: "https://github.com/acme/api/issues/7",
};
const readyIssue: DashIssue = { ...rawIssue, number: 9, labels: ["junco", "junco:plan-ready"] };

function renderApp(
  client: DashboardClient,
  watchlistFile: string,
  issuePollMs = 999999,
  runCliFn?: (name: string, extraArgs: string[]) => Promise<CliRunResult>,
  queueFn: () => Promise<QueueSnapshot> = async () => QUEUE_SNAP,
  prPollMs = 999999,
) {
  return render(
    <App
      client={client}
      trigger="junco"
      branchPrefix="junco/"
      configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
      watchlistFile={watchlistFile}
      configPath="/x/config.toml"
      clonesDir={CLONES_DIR}
      issuePollMs={issuePollMs}
      healthPollMs={999999}
      queuePollMs={999999}
      prPollMs={prPollMs}
      queueFn={queueFn}
      runCliFn={runCliFn}
      // Medium layout: single body pane, so enter still opens the detail view
      // (the legacy flows the App-level tests exercise); wide-mode tests below
      // opt into 130 cols explicitly.
      sizeOverride={{ columns: 100, rows: 30 }}
      onExit={() => {}}
    />,
  );
}
const tick = () => new Promise((r) => setTimeout(r, 30));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(cond()).toBe(true); // final assert with a real failure message
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

  it("o on the rail opens the repository page", async () => {
    const { client, repoOpens } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("1"); // focus the rail
    r.stdin.write("o");
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
    r.stdin.write("2");
    await until(() => (r.lastFrame() ?? "").includes("d dispatch")); // pane 2 focused first
    r.stdin.write("\r"); // medium layout → detail view
    await until(() => (r.lastFrame() ?? "").includes("the body"));
    r.stdin.write("o");
    await until(() => issueOpens.length === 1);
    expect(issueOpens).toEqual([7]);
  });

  it("shows the freshness stamp after issues load, and in the PRs view", async () => {
    const { client } = makeClient(
      { "acme/api": [rawIssue] },
      { prsByRepo: { "acme/api": [makePr()] } },
    );
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    await until(() => (r.lastFrame() ?? "").includes("↻ 0s")); // fetched moments ago
    r.stdin.write("p");
    await until(() => (r.lastFrame() ?? "").includes("pull requests"));
    await until(() => (r.lastFrame() ?? "").includes("↻ 0s"));
  });

  it("all-repos-down PR poll does not advance the freshness stamp", async () => {
    const { client: base } = makeClient({ "acme/api": [rawIssue] });
    const client: DashboardClient = {
      ...base,
      listPrs: async () => ({ ok: false, error: "network down" }),
    };
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("p");
    await until(() => (r.lastFrame() ?? "").includes("pull requests"));
    // Every watched repo's listPrs failed — the aggregate stamp must not
    // claim freshness. If the guard in loadPrs were removed/inverted,
    // prsFetchedAt would be set at mount and "↻ 0s" would render here.
    expect(r.lastFrame() ?? "").not.toContain("↻");
  });

  it("cache-served (offline) PR poll does not advance the freshness stamp either", async () => {
    const { client: base } = makeClient({ "acme/api": [rawIssue] });
    const staleIso = new Date(Date.now() - 5 * 60_000).toISOString();
    let call = 0;
    const client: DashboardClient = {
      ...base,
      listPrs: async () => {
        const res =
          call === 0
            ? okv({ prs: [makePr()], staleAt: staleIso })
            : ({ ok: false, error: "network down" } as const);
        call++;
        return res;
      },
    };
    const r = renderApp(client, wl(), 999999, undefined, undefined, 150); // prPollMs=150
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("p");
    await until(() => (r.lastFrame() ?? "").includes("pull requests"));
    // Poll 1 is cache-served (staleAt set on an ok:true result) — the offline
    // marker renders while it's the freshest data we have.
    await until(() => (r.lastFrame() ?? "").includes("offline"));
    // Poll 2 (all repos down) clears prStaleAt to null — wait for it to land
    // before asserting, so this can't race the interval.
    await until(() => !(r.lastFrame() ?? "").includes("offline"));
    // Cache-served poll 1 must NOT have stamped prsFetchedAt — if it had (the
    // pre-fix guard only checked `res.ok`), the title would fall back to it
    // once staleAt clears and render "↻ 0s" here.
    expect(r.lastFrame() ?? "").not.toContain("↻");
  });

  it("dispatch on a raw issue applies the action optimistically", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // issue loaded before acting
    r.stdin.write("\t"); // focus issues pane
    await tick();
    r.stdin.write("d");
    await tick();
    expect(actions).toEqual([["acme/api", 7, "dispatch", ["junco"]]]);
    expect(r.lastFrame()).toContain("planning"); // optimistic label applied
  });

  it("approve is refused on a raw issue with a reason toast (no client call)", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // issue loaded before acting
    r.stdin.write("\t");
    await tick();
    r.stdin.write("a");
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
    r.stdin.write("d");
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
    r.stdin.write("d");
    await until(() => (r.lastFrame() ?? "").includes("offline — action queued"));
    expect(r.lastFrame()).toContain("planning"); // optimistic label NOT rolled back
  });

  it("add-repo flow validates then persists to the watchlist", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const file = wl();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("w");
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

  it("unwatch removes watchlist entries but refuses config entries", async () => {
    const { client } = makeClient({ "acme/api": [], "alx/coral": [] });
    const file = wl();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("x"); // selected = acme/api (config)
    await until(() => (r.lastFrame() ?? "").includes("config.toml"));
    r.stdin.write("j"); // select alx/coral
    await tick();
    r.stdin.write("x");
    await tick();
    expect(readWatchlist(file).entries).toEqual([]);
  });

  it("? opens the help modal", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const r = renderApp(client, wl());
    await tick();
    r.stdin.write("?");
    // The HelpModal is taller than a 30-row terminal; the Workspace top-aligns
    // it so the title survives even though the bottom clips.
    await until(() => (r.lastFrame() ?? "").includes("junco dashboard — keys"));
    expect(r.lastFrame()).toContain("act on issue");
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
    r.stdin.write("d"); // dispatch the SELECTED issue
    await tick();
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
      dispatchTicket: async (nwo, num) =>
        okv({ id: `gh-${nwo}-${num}`, destPath: `${CLONES_DIR}/${nwo}` }),
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
    await tick();
    r.stdin.write("\t"); // focus issues pane (selection = #7)
    await tick();
    r.stdin.write("\r"); // open detail on #7 (snapshot frozen here)
    await tick();
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
    r.stdin.write("w"); // add flow refused
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
    r.stdin.write("w");
    await tick();
    r.stdin.write("alx/coral");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("~/code/coral");
    await tick();
    r.stdin.write("\r");
    await tick();
    await tick();
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
        (r.lastFrame() ?? "").includes("●1 review") && (r.lastFrame() ?? "").includes("daemon ●"),
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
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("j"); // select alx/coral (pane 1) — its issues load
    await until(() => (r.lastFrame() ?? "").includes("●1 review"));
    r.stdin.write("x"); // unwatch — the issues/staleAt entries drop with the mapping
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
      // Issue rows start at absolute y=4 (1-based): header(1) + border(2) + title(3).
      r.stdin.write(click(30, 4)); // pane was 1 → this click only focuses + selects
      await wait(50); // openDetail would flip the view synchronously — a beat is plenty
      expect(r.lastFrame() ?? "").not.toContain("the body"); // still the list
      r.stdin.write(click(30, 4)); // now pane 2 + already selected → Enter → detail (medium)
      await until(() => (r.lastFrame() ?? "").includes("the body"));
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
      r.stdin.write(click(3, 5)); // rail row 2 (y=5 → index 1) → beta/web
      await until(() => (r.lastFrame() ?? "").includes("Beta bug"));
    });

    it("wheel over the issue list moves the selection down one row", async () => {
      const { client } = makeClient({ "acme/api": [rawIssue, readyIssue] });
      const r = renderApp(client, wl());
      await until(() => (r.lastFrame() ?? "").includes("#7"));
      // Selection starts on row 0 (frame line 3); after one wheel-down the issue
      // pane's ▌ bar must be on row 1 (frame line 4) — whatever issue sorts there.
      // (The rail's own ▌ sits left of x=26; slice the line to the issues pane.)
      const issueBarOn = (line: number): boolean =>
        ((r.lastFrame() ?? "").split("\n")[line] ?? "").slice(26).includes("▌");
      await until(() => issueBarOn(3));
      r.stdin.write(wheelDown(30, 5));
      await until(() => issueBarOn(4) && !issueBarOn(3));
    });

    it("prs view: click the selected row opens the PR; ↗ link line opens it too (wide)", async () => {
      const { client, prCalls } = makeClient(
        { "acme/api": [] },
        { prsByRepo: { "acme/api": [makePr()] } },
      );
      const r = render(
        <App
          client={client}
          trigger="junco"
          branchPrefix="junco/"
          configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
          watchlistFile={wl()}
          configPath="/x/config.toml"
          clonesDir={CLONES_DIR}
          issuePollMs={999999}
          healthPollMs={999999}
          queuePollMs={999999}
          prPollMs={999999}
          queueFn={async () => QUEUE_SNAP}
          sizeOverride={{ columns: 130, rows: 30 }}
          onExit={() => {}}
        />,
      );
      // The PR title can only appear once the view actually switches to "prs"
      // (the side PrPreview card), so the readiness wait belongs after the
      // keypress.
      r.stdin.write("p");
      await until(() => (r.lastFrame() ?? "").includes("pull requests"));
      await until(() => (r.lastFrame() ?? "").includes("Some PR"));
      // Click-again = enter: row 0 is selected from mount, so the click opens
      // the fullscreen PR overlay (its footer is the unique marker).
      r.stdin.write(click(30, 4));
      await until(() => (r.lastFrame() ?? "").includes("esc back · o browser"));
      r.stdin.write(ESC); // back to the prs view, side card visible again
      await until(() => (r.lastFrame() ?? "").includes("pull requests"));
      // 130 cols wide → preview band starts at x=79 (1-based); the side card's
      // ↗ link line (y=5) opens the browser directly.
      r.stdin.write(click(85, 5));
      await until(() => prCalls.length === 1);
      expect(prCalls[0]).toEqual(["acme/api", 100]);
      r.unmount();
    });

    it("mouse drives pane 3's PR monitor: click selects, click-again opens the overlay, wheel moves", async () => {
      const { client } = makeClient(
        { "acme/api": [rawIssue] },
        { prsByRepo: { "acme/api": [makePr(), makePr({ number: 101, title: "Second PR" })] } },
      );
      const r = render(
        <App
          client={client}
          trigger="junco"
          branchPrefix="junco/"
          configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
          watchlistFile={wl()}
          configPath="/x/config.toml"
          clonesDir={CLONES_DIR}
          issuePollMs={999999}
          healthPollMs={999999}
          queuePollMs={999999}
          prPollMs={999999}
          queueFn={async () => QUEUE_SNAP}
          sizeOverride={{ columns: 130, rows: 30 }}
          onExit={() => {}}
        />,
      );
      await until(() => (r.lastFrame() ?? "").includes("3 PRs"));
      await until(() => (r.lastFrame() ?? "").includes("Some PR"));
      // Pane-3 band at 130 cols starts at x=78 (0-based); its ▌ selection bar
      // and rows live there. Rows start at frame line 3 (0-based), like every list.
      const pane3BarOn = (line: number): boolean =>
        ((r.lastFrame() ?? "").split("\n")[line] ?? "").slice(78).includes("▌");
      await until(() => pane3BarOn(3)); // row 0 selected on load
      r.stdin.write(click(85, 5)); // 1-based y=5 → row 1: focus pane 3 + select
      await until(() => pane3BarOn(4) && !pane3BarOn(3));
      r.stdin.write(click(85, 5)); // click-again = enter → fullscreen PR overlay
      await until(() => (r.lastFrame() ?? "").includes("esc back · o browser"));
      r.stdin.write(ESC); // back to main; pane-3 selection intact
      await until(() => (r.lastFrame() ?? "").includes("3 PRs"));
      await until(() => pane3BarOn(4));
      r.stdin.write(`\u001b[<64;85;5M`); // wheelUp over the monitor moves the selection up
      await until(() => pane3BarOn(3) && !pane3BarOn(4));
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
      r.stdin.write("2");
      await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
      r.stdin.write("\r"); // open the issue detail
      await until(() => (r.lastFrame() ?? "").includes("the body"));
      r.stdin.write(click(30, 5)); // ↗ metadata row: 1-based y=5, middle band
      await until(() => issueOpens.length === 1);
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
      await until(() => (r.lastFrame() ?? "").includes("esc back · o browser"));
      r.stdin.write(click(30, 5)); // ↗ metadata row of the overlay card
      await until(() => prCalls.length === 1);
      expect(prCalls[0]).toEqual(["acme/api", 100]);
    });
  });
});

describe("external-repo routing", () => {
  const wle = () => join(mkdtempSync(join(tmpdir(), "junco-ext-")), "wl.json");
  const upIssue: DashIssue = {
    number: 7,
    title: "Stream bug",
    labels: ["junco"],
    updatedAt: "2026-07-06T10:00:00Z",
    url: "https://github.com/up/stream/issues/7",
  };

  it("addRepo routes a no-push repo to external fork provisioning", async () => {
    const { client } = makeClient({ "acme/api": [] });
    client.repoPermission = async () => okv({ canPush: false });
    client.prepareExternalRepo = async (nwo) => okv({ path: `/ext/${nwo}`, forkNwo: "me/stream" });
    const file = wle();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("w");
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
    r.stdin.write("w");
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
    r.stdin.write("w");
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

  it("d on an external repo dispatches a ticket instead of labeling", async () => {
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
    r.stdin.write("2"); // focus issues pane
    await tick();
    r.stdin.write("d");
    await until(() => dispatched.length === 1);
    expect(dispatched[0]).toBe("up/stream#7");
    expect(actions).toHaveLength(0); // no label flow
    await until(() => (r.lastFrame() ?? "").includes("ticket queued: gh-up-stream-7"));
  });

  it("D/a/R on an external repo explains instead of acting", async () => {
    const { client, actions } = makeClient({ "acme/api": [], "up/stream": [upIssue] });
    const file = wle();
    writeWatchlist(file, [{ nwo: "up/stream", path: "/ext", external: true }]);
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("j"); // select up/stream
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("2"); // focus issues pane
    await tick();
    r.stdin.write("D");
    await until(() => (r.lastFrame() ?? "").includes("not available for external repos"));
    r.stdin.write("a"); // dismisses the toast, then re-explains
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
    await until(() => (r.lastFrame() ?? "").includes("p pull requests ·"));
    expect(r.lastFrame()).toContain("My PR");
    r.stdin.write(ESC); // back to main
    await until(() => !(r.lastFrame() ?? "").includes("p pull requests ·"));
    r.stdin.write("p"); // re-open
    await until(() => (r.lastFrame() ?? "").includes("p pull requests ·"));
    r.stdin.write("p"); // p toggles closed too
    await until(() => !(r.lastFrame() ?? "").includes("p pull requests ·"));
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
    r.stdin.write("o");
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
    expect(r.lastFrame()).not.toContain("3 pr"); // no pane-3 numbering in the fullscreen overlay
    r.stdin.write(ESC); // back to the prs view
    await until(() => (r.lastFrame() ?? "").includes("p pull requests"));
    expect(r.lastFrame()).toContain("PR eleven"); // selection survived the round trip
    r.stdin.write("o"); // o still opens the browser, unchanged
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
    const r = renderApp(client, wlp(), 999999, undefined, undefined, 60); // prPollMs=60
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
    r.stdin.write("o"); // open the ANCHORED pr
    await until(() => prCalls.length > 0);
    expect(prCalls).toEqual([["acme/api", 10]]); // anchor held despite the re-sort
  });

  // Unwatching a repo must clear its PRs from the aggregate synchronously —
  // the ⚑ attention chip reflects only currently watched repos, never ghost
  // data lingering until the next poll (the reviewCount rule). listPrs here
  // never resolves a second time, so a passing test proves the synchronous
  // prune in unwatch(), not a refetch.
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
    const served = new Set<string>();
    const client: DashboardClient = {
      ...base,
      // Serve each repo's PR list exactly once; every later call hangs forever.
      listPrs: (nwo: string) => {
        if (served.has(nwo)) return new Promise<never>(() => {});
        served.add(nwo);
        return Promise.resolve(okv({ prs: nwo === "alx/coral" ? [failing] : [], staleAt: null }));
      },
    };
    const file = wlp();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const r = renderApp(client, file);
    await until(() => (r.lastFrame() ?? "").includes("⚑1 PR"));
    r.stdin.write("j"); // select alx/coral (pane 1)
    await tick();
    r.stdin.write("x"); // unwatch — the prs aggregate prunes with the mapping
    await until(() => !(r.lastFrame() ?? "").includes("⚑1 PR"));
    expect(readWatchlist(file).entries).toEqual([]);
    r.stdin.write("p"); // the PRs view itself must not list the pruned PR either
    await until(() => (r.lastFrame() ?? "").includes("p pull requests ·"));
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

  it("w opens the add-repo form; A is NOT an alias anymore", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const r = renderApp(client, wl2());
    await tick();
    r.stdin.write("w");
    await tick();
    expect(r.lastFrame()).toContain("Watch a repository");
    r.stdin.write(ESC);
    await tick();
    r.stdin.write("A");
    await tick();
    expect(r.lastFrame()).not.toContain("Watch a repository");
  });

  it("i jumps to the issues pane (d then dispatches the selected issue)", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl2());
    await until(() => (r.lastFrame() ?? "").includes("#7")); // issue loaded before acting
    r.stdin.write("i"); // issues pane via direct jump — no tab needed
    await tick();
    r.stdin.write("d");
    await tick();
    expect(actions).toEqual([["acme/api", 7, "dispatch", ["junco"]]]);
  });

  it("':' opens the palette; running a command shows its captured output + exit", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeRunner();
    const r = renderApp(client, wl2(), 999999, runCliFn);
    await tick();
    r.stdin.write(":");
    await tick();
    expect(r.lastFrame()).toContain("run a junco command"); // App-level Modal title
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
    await tick();
    expect(r.lastFrame()).toContain("args:");
    r.stdin.write("failed");
    await tick();
    r.stdin.write("\r");
    await tick();
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
    await tick();
    expect(runs).toEqual([["logs", ["-n", "200", "--human"]]]);
  });

  it("excluded commands toast the reason and never run", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeRunner();
    const r = renderApp(client, wl2(), 999999, runCliFn);
    await tick();
    r.stdin.write(":");
    await tick();
    r.stdin.write("init");
    await tick();
    r.stdin.write("\r");
    // Exclusion reason is now an auto-expiring toast under the modal.
    await until(() => (r.lastFrame() ?? "").includes("can't nest inside the dashboard"));
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
    await tick();
    expect(r.lastFrame()).toContain("Runs the junco CLI against this dashboard's config");
    r.stdin.write(ESC); // -> main
    await tick();
    expect(r.lastFrame()).toContain("issues");
    expect(r.lastFrame()).not.toContain("Runs the junco CLI against this dashboard's config");
  });
});

describe("assess hotkey (s/S)", () => {
  const wl7 = () => join(mkdtempSync(join(tmpdir(), "junco-assess-")), "wl.json");

  function makeAssessRunner(result: Partial<CliRunResult> = {}) {
    const runs: [string, string[]][] = [];
    const runCliFn = async (name: string, extraArgs: string[]): Promise<CliRunResult> => {
      runs.push([name, extraArgs]);
      return { code: 0, output: "queued: /x/inbox/assess-acme-api.md", timedOut: false, ...result };
    };
    return { runs, runCliFn };
  }

  it("s calls the runner once with (assess, [nwo]); success exit shows a toast with the nwo", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeAssessRunner();
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await tick();
    r.stdin.write("s");
    await until(() => (r.lastFrame() ?? "").includes("acme/api: queued:"));
    expect(runs).toEqual([["assess", ["acme/api"]]]);
  });

  it("S includes --auto-plan in the runner args", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runs, runCliFn } = makeAssessRunner();
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await tick();
    r.stdin.write("S");
    await until(() => runs.length > 0);
    expect(runs).toEqual([["assess", ["acme/api", "--auto-plan"]]]);
  });

  it("nonzero exit shows an error toast with the first non-empty output line", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const { runCliFn } = makeAssessRunner({
      code: 1,
      output: "\njunco assess: 'acme/api' is not watched — add it under [[github.repos]]\n",
    });
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await tick();
    r.stdin.write("s");
    await until(() => (r.lastFrame() ?? "").includes("is not watched"));
  });

  it("no watched repos: s shows an error toast and never calls the runner", async () => {
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
        configPath="/x/config.toml"
        clonesDir={CLONES_DIR}
        issuePollMs={999999}
        healthPollMs={999999}
        queuePollMs={999999}
        queueFn={async () => QUEUE_SNAP}
        runCliFn={runCliFn}
        sizeOverride={{ columns: 100, rows: 30 }}
        onExit={() => {}}
      />,
    );
    await tick();
    r.stdin.write("s");
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
    r.stdin.write("s");
    await tick();
    r.stdin.write("s");
    await until(() => (r.lastFrame() ?? "").toLowerCase().includes("already running"));
    expect(runs).toEqual([["assess", ["acme/api"]]]);
  });

  it("s while the / filter input is active does not trigger the runner", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const { runs, runCliFn } = makeAssessRunner();
    const r = renderApp(client, wl7(), 999999, runCliFn);
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    r.stdin.write("/"); // enter filter-typing mode
    await tick();
    r.stdin.write("s"); // captured as filter text, not the assess hotkey
    await tick();
    expect(r.lastFrame()).toContain("/s"); // landed in the filter chip
    expect(runs).toHaveLength(0);
  });
});

describe("auto-clone add-repo", () => {
  const wl3 = () => join(mkdtempSync(join(tmpdir(), "junco-ac-")), "wl.json");

  it("empty path clones into the managed dir, validates it, and watches it", async () => {
    const { client, cloned, validatePaths } = makeClient({ "acme/api": [] });
    const file = wl3();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("w");
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
    r.stdin.write("w");
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

describe("URL paste in add-repo", () => {
  const wl4 = () => join(mkdtempSync(join(tmpdir(), "junco-url-")), "wl.json");

  it("a pasted github URL normalizes to owner/repo everywhere", async () => {
    const { client, cloned, validatePaths } = makeClient({ "acme/api": [] });
    const file = wl4();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("w");
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
    r.stdin.write("w");
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
    for (let i = 0; i < 30 && !hasSpinner(); i++) await tick();
    expect(hasSpinner()).toBe(true);
    resolveSecond!(okv({ issues: [rawIssue], staleAt: null }));
    for (let i = 0; i < 30 && hasSpinner(); i++) await tick();
    expect(hasSpinner()).toBe(false);
  });
});

describe("queue rail + queue view", () => {
  it("renders the queue card in the rail from the initial poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    // The old QueueStrip counts line is gone; the rail's compact queue card
    // carries the running label + waiting count instead.
    await until(() => (r.lastFrame() ?? "").includes("#46 exec"));
    expect(r.lastFrame()).toContain("1 waiting"); // QUEUE_SNAP has one waiting ticket
  });

  it("t opens the queue view, esc returns; t toggles too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q2-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("#46 exec")); // queue snapshot loaded
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    expect(r.lastFrame()).toContain("WAITING (1)");
    r.stdin.write(ESC);
    await until(() => !(r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    r.stdin.write("t"); // t closes as well
    await until(() => !(r.lastFrame() ?? "").includes("RUNNING (1/1)"));
  });

  it("queue view scrolls with ] and [", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q3-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("#46 exec"));
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    // QueueView renders a "queue" title row above RUNNING, so two ] presses are
    // needed to slice the RUNNING header out of the (unclamped) scroll window.
    r.stdin.write("]");
    r.stdin.write("]");
    await until(() => !(r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    r.stdin.write("[");
    r.stdin.write("[");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
  });

  it("footer advertises t queue when the issues pane is focused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q4-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("1 repos")); // mounted
    r.stdin.write("2"); // focus the issues pane — its footer carries the t hint
    await until(() => (r.lastFrame() ?? "").includes("t queue"));
  });
});

describe("workspace filter + pane navigation (medium)", () => {
  const wl5 = () => join(mkdtempSync(join(tmpdir(), "junco-ws-")), "wl.json");
  const upl: DashIssue = {
    number: 7,
    title: "Fix uploads",
    labels: ["junco"],
    updatedAt: "2026-07-06T10:00:00Z",
    url: "https://github.com/acme/api/issues/7",
  };
  const db: DashIssue = {
    number: 9,
    title: "Database migration",
    labels: ["junco"],
    updatedAt: "2026-07-06T09:00:00Z",
    url: "https://github.com/acme/api/issues/9",
  };

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

  it("1 / 2 jump panes — the footer follows the focused pane", async () => {
    // Frames strip ANSI, so accent-title focus is asserted via the pane-specific
    // footer (pane 1 → unwatch; pane 2 → dispatch) rather than color.
    const { client } = makeClient({ "acme/api": [upl] });
    const r = renderApp(client, wl5());
    await until(() => (r.lastFrame() ?? "").includes("x unwatch")); // pane 1 footer
    r.stdin.write("2");
    await until(() => (r.lastFrame() ?? "").includes("d dispatch")); // pane 2 footer
    expect(r.lastFrame()).not.toContain("x unwatch");
    r.stdin.write("1");
    await until(() => (r.lastFrame() ?? "").includes("x unwatch"));
  });

  it("g / G jump to the first / last issue", async () => {
    const { client, actions } = makeClient({ "acme/api": [readyIssue, rawIssue] });
    const r = renderApp(client, wl5());
    await until(() => (r.lastFrame() ?? "").includes("Fix uploads"));
    r.stdin.write("2"); // focus issues; sorted [#9 plan-ready, #7 raw]
    await tick();
    r.stdin.write("G"); // last → #7 (raw)
    await tick();
    r.stdin.write("d"); // dispatch is valid only on the raw issue
    await until(() => actions.length === 1);
    expect(actions).toEqual([["acme/api", 7, "dispatch", ["junco"]]]);
    r.stdin.write("g"); // first → #9 (plan-ready)
    await tick();
    r.stdin.write("d"); // not allowed there → refusal toast, no new action
    await until(() => r.lastFrame()!.toLowerCase().includes("not available"));
    expect(actions).toHaveLength(1);
  });

  it("3 is inert at medium width (there is no pane 3 to reach)", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl5());
    await until(() => (r.lastFrame() ?? "").includes("Fix uploads"));
    r.stdin.write("2");
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write("3");
    await tick();
    expect(r.lastFrame()).not.toContain("← issues"); // pane-3's hint never leaked in
    expect(r.lastFrame()).toContain("d dispatch"); // still on pane 2
  });

  // → mirrors `3`/`l` at medium width: there is no pane 3 to reach, so it's inert.
  it("→ is inert at medium width, same as 3 (no pane 3 to reach)", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl5());
    await until(() => (r.lastFrame() ?? "").includes("Fix uploads"));
    r.stdin.write("2");
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write(ESC + "[C"); // →
    await tick();
    expect(r.lastFrame()).not.toContain("← issues"); // pane-3's hint never leaked in
    expect(r.lastFrame()).toContain("d dispatch"); // still on pane 2
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
        configPath="/x/config.toml"
        clonesDir={CLONES_DIR}
        issuePollMs={999999}
        healthPollMs={999999}
        queuePollMs={999999}
        queueFn={async () => QUEUE_SNAP}
        sizeOverride={{ columns: 130, rows: 30 }}
        onExit={() => {}}
      />,
    );
  }

  // Wide terminals get the FULL header pulse (record, last task, tokens) —
  // the same fixture that medium mode drops down to essentials.
  it("wide mode renders the full header pulse", async () => {
    const { client: base } = makeClient({ "acme/api": [rawIssue, readyIssue] });
    const client: DashboardClient = { ...base, health: async () => RICH_HEALTH };
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("✓8"));
    const birdLine = r
      .lastFrame()!
      .split("\n")
      .find((l) => l.includes("🐦"))!;
    expect(birdLine).toContain("●1 review");
    expect(birdLine).toContain("✓8");
    expect(birdLine).toContain("✗2");
    expect(birdLine).toContain("last ✓");
    expect(birdLine).toContain("tok 45k");
    expect(birdLine).toContain("daemon ●");
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
  // ("3 PRs · acme/reef") and must track the rail's selection, same as the
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
    await until(() => (r.lastFrame() ?? "").includes("3 PRs · acme/api"));
    r.stdin.write("j"); // pane 1 defaults focused — select alx/coral
    await until(() => (r.lastFrame() ?? "").includes("3 PRs · alx/coral"));
    expect(r.lastFrame()).not.toContain("3 PRs · acme/api");
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
        configPath="/x/config.toml"
        clonesDir={CLONES_DIR}
        issuePollMs={999999}
        healthPollMs={999999}
        queuePollMs={999999}
        queueFn={async () => QUEUE_SNAP}
        sizeOverride={{ columns: 130, rows: 30 }}
        onExit={() => {}}
      />,
    );
    await until(() => (r.lastFrame() ?? "").includes("#10"));
    const tail = longNwo.slice(longNwo.length - (NWO_MAX_WIDTH - 1));
    const frame = r.lastFrame() ?? "";
    // Found as one contiguous substring — proves it rendered on a single
    // physical line (a wrap would split it across two "\n"-joined lines).
    expect(frame).toContain(`3 PRs · …${tail}`);
    // Scoped to pane 3's own title line — the header's bird line legitimately
    // shows the full untruncated nwo elsewhere in the frame.
    const titleLine = frame.split("\n").find((l) => l.includes("3 PRs ·"))!;
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
    r.stdin.write("3"); // focus pane 3
    await until(() => (r.lastFrame() ?? "").includes("← issues"));
    r.stdin.write("j"); // move down to #11
    await tick();
    r.stdin.write("o");
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
    r.stdin.write("3");
    await until(() => (r.lastFrame() ?? "").includes("← issues"));
    r.stdin.write("\r"); // enter -> prDetail
    await until(() => (r.lastFrame() ?? "").includes("checks:"));
    expect(r.lastFrame()).toContain("branch:");
    // The fullscreen overlay reuses PrPreview, but "3" names a pane that
    // doesn't exist here — the pane-3-flavored title must not leak in.
    expect(r.lastFrame()).not.toContain("3 pr");
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
    r.stdin.write("2"); // focus issues pane
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write("\r");
    // The detail view's exact footer (scroll · o browser · esc back) — pane
    // 3's hint set never produces this combo (no "esc back" there).
    await until(() => (r.lastFrame() ?? "").includes("↑/↓ scroll · o browser · esc back"));
    expect(r.lastFrame()).toContain("#7 Fix uploads");
    r.stdin.write(ESC);
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
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
    r.stdin.write("2");
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
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
    // `3 pr · #42` is the PrPreview pane title — unambiguous vs pane 3's own
    // "3 PRs · <nwo>" title in the main view.
    await until(() => (r.lastFrame() ?? "").includes("3 pr · #42"));
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
    await until(() => (r.lastFrame() ?? "").includes("3 PRs · acme/api")); // pane 3, wide main view
    r.stdin.write("p"); // open the standalone PRs view
    await until(() => (r.lastFrame() ?? "").includes("p pull requests · 1"));
    expect(r.lastFrame()).not.toContain("3 PRs · acme/api"); // pane 3's slot is gone in this view
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
        configPath="/x/config.toml"
        clonesDir={CLONES_DIR}
        issuePollMs={999999}
        healthPollMs={999999}
        queuePollMs={999999}
        queueFn={async () => QUEUE_SNAP}
        sizeOverride={size}
        onExit={() => {}}
      />
    );
    const r = render(appEl({ columns: 130, rows: 30 }));
    await until(() => (r.lastFrame() ?? "").includes("3 PRs · acme/api")); // pane 3 mounted, wide
    r.stdin.write("3"); // focus pane 3 directly
    await until(() => (r.lastFrame() ?? "").includes("← issues")); // pane-3 footer hints
    r.rerender(appEl({ columns: 100, rows: 30 })); // shrink below the wide breakpoint
    // Pane 2's footer hint set is back — d dispatch is the reliable marker
    // regardless of the enter-key wording.
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    expect(r.lastFrame()).not.toContain("← issues"); // pane-3's hint is gone
  });

  // → is the advertised primary pane-movement key (l is now the quiet alias) —
  // from pane 2 in wide mode it must reach pane 3 exactly like l/enter do, and
  // ← must walk it back one pane at a time to pane 1.
  it("→ from pane 2 focuses pane 3; ← twice returns to pane 1", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("3 PRs · acme/api")); // pane 3 mounted, wide
    r.stdin.write("2"); // focus issues pane
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write(ESC + "[C"); // → focuses pane 3
    await until(() => (r.lastFrame() ?? "").includes("← issues"));
    expect(r.lastFrame()).toContain("← issues"); // pane 3 footer still carries ←
    r.stdin.write(ESC + "[D"); // ← back to pane 2
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write(ESC + "[D"); // ← back to pane 1
    await until(() => (r.lastFrame() ?? "").includes("x unwatch"));
  });
});
