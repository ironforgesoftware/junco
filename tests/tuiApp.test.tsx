import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { App } from "../src/tui/App.js";
import { readWatchlist, writeWatchlist } from "../src/watchlist.js";
import type { DashboardClient, Result } from "../src/tui/ghClient.js";
import type { DashIssue } from "../src/tui/state.js";
import type { CliRunResult } from "../src/tui/cliRunner.js";
import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";

const okv = <T,>(value: T): Result<T> => ({ ok: true, value });
const CLONES_DIR = "/x/state/repos";
const ESC = String.fromCharCode(27);

const QUEUE_SNAP: QueueSnapshot = {
  daemonUp: true,
  maxConcurrent: 1,
  running: [
    {
      id: "gh-acme-api-46",
      github: { nwo: "acme/api", issue: 46, kind: "pr" },
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
      github: { nwo: "acme/api", issue: 51, kind: "plan" },
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
  opts: { failActions?: boolean } = {},
) {
  const actions: unknown[][] = [];
  const validatePaths: string[] = [];
  const cloned: string[] = [];
  const client: DashboardClient = {
    listIssues: async (nwo) => okv({ issues: issuesByRepo[nwo] ?? [], staleAt: null }),
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
    health: async () => ({
      up: true,
      uptimeSeconds: 60,
      lastBridgeSweepAt: null,
      ticketsBridged: 0,
    }),
  };
  return { client, actions, validatePaths, cloned };
}

/** A client whose listIssues walks a fixed sequence of responses (call N →
 * sequence[min(N, len-1)]) so a test can deliver a re-sorted poll. */
function makeSeqClient(sequence: DashIssue[][]) {
  const actions: unknown[][] = [];
  let call = 0;
  const client: DashboardClient = {
    listIssues: async () => {
      const r = okv({ issues: sequence[Math.min(call, sequence.length - 1)], staleAt: null });
      call++;
      return r;
    },
    cloneRepo: async () => okv(undefined),
    issueDetail: async () => okv({ body: "the body", planComment: null }),
    applyAction: async (...a) => {
      actions.push(a);
      return okv({ queued: false });
    },
    validateAndPrepareRepo: async () => okv(undefined),
    openInBrowser: async () => okv(undefined),
    health: async () => ({
      up: true,
      uptimeSeconds: 60,
      lastBridgeSweepAt: null,
      ticketsBridged: 0,
    }),
  };
  return { client, actions };
}

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
) {
  return render(
    <App
      client={client}
      trigger="junco"
      configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
      watchlistFile={watchlistFile}
      configPath="/x/config.toml"
      clonesDir={CLONES_DIR}
      issuePollMs={issuePollMs}
      healthPollMs={999999}
      queuePollMs={999999}
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
    await tick();
    expect(r.lastFrame()).toContain("#7 Fix uploads");
    expect(r.lastFrame()).toContain("plan-ready"); // sorted: #9 first, but both visible
  });

  it("dispatch on a raw issue applies the action optimistically", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl());
    await tick();
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
    await tick();
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
    await tick();
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
    await tick();
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
    await tick();
    await tick();
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
    expect(r.lastFrame()).toContain("alx/coral");
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
    const { client, actions } = makeSeqClient([first, second]);
    const r = renderApp(client, wl(), 60);
    await tick();
    r.stdin.write("\t"); // focus issues pane; selection anchored to #7
    await wait(140); // let the interval poll deliver the re-sorted `second`
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
    const client: DashboardClient = {
      listIssues: async () => okv({ issues: live, staleAt: null }),
      cloneRepo: async () => okv(undefined),
      issueDetail: async () => okv({ body: "the body", planComment: null }),
      applyAction: async () => okv({ queued: false }),
      validateAndPrepareRepo: async () => okv(undefined),
      openInBrowser: async () => okv(undefined),
      health: async () => ({
        up: true,
        uptimeSeconds: 60,
        lastBridgeSweepAt: null,
        ticketsBridged: 0,
      }),
    };
    const r = renderApp(client, wl(), 60);
    await tick();
    r.stdin.write("\t"); // focus issues pane (selection = #7)
    await tick();
    r.stdin.write("\r"); // open detail on #7 (snapshot frozen here)
    await tick();
    live = [b8]; // #7 closed; the next poll drops it from the live list
    await wait(140);
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
    await tick();
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
    await tick();
    await tick();
    expect(runs).toEqual([["doctor", []]]);
    const f = r.lastFrame()!;
    expect(f).toContain("junco doctor");
    expect(f).toContain("captured output line");
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
    await tick();
    await tick();
    expect(runs).toEqual([["restart", []]]);
    const f = r.lastFrame()!;
    expect(f).toContain("restarted: pid 1 -> 2");
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
    await tick();
    await tick();
    r.stdin.write(ESC); // -> palette
    await tick();
    expect(r.lastFrame()).toContain("Runs the junco CLI against this dashboard's config");
    r.stdin.write(ESC); // -> main
    await tick();
    expect(r.lastFrame()).toContain("issues");
    expect(r.lastFrame()).not.toContain("Runs the junco CLI against this dashboard's config");
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
    await tick();
    await tick();
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
    await tick();
    await tick();
    expect(r.lastFrame()).toContain("clone exploded");
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
    await tick();
    await tick();
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
    await tick();
    expect(r.lastFrame()).toContain("owner/repo or a github.com URL");
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

  it("3 is inert at medium width (there is no preview pane)", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl5());
    await until(() => (r.lastFrame() ?? "").includes("Fix uploads"));
    r.stdin.write("2");
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write("3");
    await tick();
    expect(r.lastFrame()).not.toContain("browser"); // no pane 3 to focus onto
    expect(r.lastFrame()).toContain("d dispatch"); // still on pane 2
  });

  // → mirrors `3`/`l` at medium width: there is no pane 3 to reach, so it's inert.
  it("→ is inert at medium width, same as 3 (no preview pane to reach)", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl5());
    await until(() => (r.lastFrame() ?? "").includes("Fix uploads"));
    r.stdin.write("2");
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write(ESC + "[C"); // →
    await tick();
    expect(r.lastFrame()).not.toContain("browser"); // no pane 3 to focus onto
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

  it("preview pane autoloads the selected issue's body", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("3 preview"));
    await until(() => (r.lastFrame() ?? "").includes("the body")); // debounce 300ms < until budget
  });

  it("enter focuses the preview pane (footer shows scroll + browser hints)", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("3 preview"));
    r.stdin.write("2"); // focus issues pane
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write("\r"); // enter → focus pane 3 (preview), NOT the detail view
    await until(() => (r.lastFrame() ?? "").includes("o browser"));
    expect(r.lastFrame()).toContain("scroll");
  });

  // Regression: `scroll` is shared across views — a queue-view offset must not
  // bleed into the pane-3 preview on the way back (it rendered from "line N",
  // blanking short bodies entirely).
  it("returning from the queue view does not bleed its scroll into the preview", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("the body")); // preview autoloaded
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    r.stdin.write("]");
    r.stdin.write("]");
    r.stdin.write("]");
    await until(() => !(r.lastFrame() ?? "").includes("RUNNING (1/1)")); // queue scrolled
    r.stdin.write(ESC); // back to main — the offset must reset with it
    // The preview shows the body's FIRST line again (fake body is one line, so
    // any residual offset would leave the pane without it).
    await until(() => (r.lastFrame() ?? "").includes("the body"));
    // Pane-3 scrolling itself still works: focus it, then [ / ] move the window.
    r.stdin.write("2");
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write("\r"); // focus pane 3
    await until(() => (r.lastFrame() ?? "").includes("o browser"));
    r.stdin.write("]"); // scroll 1 → the single-line body slides off
    await until(() => !(r.lastFrame() ?? "").includes("the body"));
    expect(r.lastFrame()).toContain("── plan ──"); // pane not blank — just scrolled
    r.stdin.write("[");
    await until(() => (r.lastFrame() ?? "").includes("the body")); // back to the top
  });

  // Regression: a wide terminal shrinking below 110 cols while pane 3 (preview)
  // is focused must not strand focus on a pane that no longer renders.
  it("shrinking below wide while pane 3 is focused clamps focus back to pane 2", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const file = wl6();
    const appEl = (size: { columns: number; rows: number }) => (
      <App
        client={client}
        trigger="junco"
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
    await until(() => (r.lastFrame() ?? "").includes("3 preview"));
    r.stdin.write("3"); // focus pane 3 directly
    await until(() => (r.lastFrame() ?? "").includes("o browser")); // pane-3 footer hints
    r.rerender(appEl({ columns: 100, rows: 30 })); // shrink below the wide breakpoint
    // Pane 2's footer hint set is back: enter→detail (medium mode) and d dispatch.
    await until(() => (r.lastFrame() ?? "").includes("enter detail"));
    expect(r.lastFrame()).toContain("d dispatch");
  });

  // → is the advertised primary pane-movement key (l is now the quiet alias) —
  // from pane 2 in wide mode it must reach pane 3 exactly like l/enter do, and
  // ← must walk it back one pane at a time to pane 1.
  it("→ from pane 2 focuses the preview; ← twice returns to pane 1", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderWide(client, wl6());
    await until(() => (r.lastFrame() ?? "").includes("3 preview"));
    r.stdin.write("2"); // focus issues pane
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write(ESC + "[C"); // → focuses pane 3 (preview)
    await until(() => (r.lastFrame() ?? "").includes("o browser"));
    expect(r.lastFrame()).toContain("← issues"); // pane 3 footer now leads with ←
    r.stdin.write(ESC + "[D"); // ← back to pane 2
    await until(() => (r.lastFrame() ?? "").includes("d dispatch"));
    r.stdin.write(ESC + "[D"); // ← back to pane 1
    await until(() => (r.lastFrame() ?? "").includes("x unwatch"));
  });
});
