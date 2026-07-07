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
};

function makeClient(
  issuesByRepo: Record<string, DashIssue[]>,
  opts: { failActions?: boolean } = {},
) {
  const actions: unknown[][] = [];
  const validatePaths: string[] = [];
  const cloned: string[] = [];
  const client: DashboardClient = {
    listIssues: async (nwo) => okv(issuesByRepo[nwo] ?? []),
    cloneRepo: async (_n, dest) => {
      cloned.push(dest);
      return okv(undefined);
    },
    issueDetail: async () => okv({ body: "the body", planComment: "<!-- junco:plan -->plan!" }),
    applyAction: async (...a) => {
      actions.push(a);
      return opts.failActions ? { ok: false, error: "gh boom" } : okv(undefined);
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
      const r = okv(sequence[Math.min(call, sequence.length - 1)]);
      call++;
      return r;
    },
    cloneRepo: async () => okv(undefined),
    issueDetail: async () => okv({ body: "the body", planComment: null }),
    applyAction: async (...a) => {
      actions.push(a);
      return okv(undefined);
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
    await tick();
    expect(actions).toHaveLength(0);
    expect(r.lastFrame()!.toLowerCase()).toContain("not available");
  });

  it("failed action rolls back the optimistic update with a toast", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] }, { failActions: true });
    const r = renderApp(client, wl());
    await tick();
    r.stdin.write("\t");
    await tick();
    r.stdin.write("d");
    await tick();
    await tick();
    expect(actions).toHaveLength(1);
    const f = r.lastFrame()!;
    expect(f).toContain("gh boom");
    expect(f).not.toContain("planning"); // rolled back
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
    await tick();
    expect(r.lastFrame()).toContain("config.toml");
    r.stdin.write("j"); // select alx/coral
    await tick();
    r.stdin.write("x");
    await tick();
    expect(readWatchlist(file).entries).toEqual([]);
  });

  it("? toggles the help overlay", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const r = renderApp(client, wl());
    await tick();
    r.stdin.write("?");
    await tick();
    expect(r.lastFrame()).toContain("junco dashboard — keys");
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
      listIssues: async () => okv(live),
      issueDetail: async () => okv({ body: "the body", planComment: null }),
      applyAction: async () => okv(undefined),
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
    await tick();
    expect(r.lastFrame()).toContain("watchlist:");
    expect(r.lastFrame()!.toLowerCase()).toContain("json");
    r.stdin.write("w"); // add flow refused
    await tick();
    expect(r.lastFrame()!.toLowerCase()).toContain("unreadable");
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
  const ESC = String.fromCharCode(27);

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
    await tick();
    expect(runs).toHaveLength(0);
    expect(r.lastFrame()).toContain("can't nest inside the dashboard");
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
    let resolveSecond: ((v: Result<DashIssue[]>) => void) | null = null;
    let calls = 0;
    const { client } = makeClient({ "acme/api": [rawIssue] });
    client.listIssues = async () => {
      calls++;
      if (calls === 1) return okv([rawIssue]);
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
    resolveSecond!(okv([rawIssue]));
    for (let i = 0; i < 30 && hasSpinner(); i++) await tick();
    expect(hasSpinner()).toBe(false);
  });
});

describe("queue strip + queue view", () => {
  it("renders the strip from the initial queue poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("queue — 1 running · 1 waiting"));
    expect(r.lastFrame()).toContain("#46 exec");
  });

  it("t opens the queue view, esc returns; t toggles too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q2-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("queue —"));
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    expect(r.lastFrame()).toContain("WAITING (1)");
    r.stdin.write(String.fromCharCode(27)); // esc — reuse the file's ESC const if in scope
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
    await until(() => (r.lastFrame() ?? "").includes("queue —"));
    r.stdin.write("t");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    // The re-skinned QueueView puts a "queue" title row above RUNNING, so it
    // takes two steps to scroll the header off (Task 8 migrates this test).
    r.stdin.write("]");
    r.stdin.write("]");
    await until(() => !(r.lastFrame() ?? "").includes("RUNNING (1/1)"));
    r.stdin.write("[");
    r.stdin.write("[");
    await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
  });

  it("shortcut bar advertises t in main view", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-tui-q4-"));
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, join(dir, "wl.json"));
    await until(() => (r.lastFrame() ?? "").includes("t queue"));
  });
});
