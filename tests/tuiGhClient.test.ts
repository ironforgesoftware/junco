import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { makeGhDashboardClient } from "../src/tui/ghClient.js";
import { cachePathFor } from "../src/githubCachePaths.js";
import { listOps } from "../src/githubOutbox.js";
import type { Config } from "../src/types.js";
import type { CmdResult, gh } from "../src/git.js";
import { GitOpError } from "../src/git.js";
import type { PendingAssess } from "../src/assessReview.js";
import type { FileResult } from "../src/assessFiling.js";
import type { PendingComment } from "../src/commentReview.js";
import type { RepoAccess } from "../src/botAccess.js";
import { GH_AUTH_CTX } from "./helpers/dashFixtures.js";
import { transcriptPathFor } from "../src/slug.js";
import { dataTreePaths } from "../src/dataTree.js";
import { runEnd, runStart, turnEndFull } from "./helpers/transcriptFixtures.js";
import {
  writeChatDraft,
  listChatDrafts,
  draftFilePath,
  type PendingDraft,
} from "../src/chat/draftStore.js";

const cfg = {
  ghBin: "gh",
  gitBin: "git",
  healthEnabled: true,
  healthHost: "127.0.0.1",
  healthPort: 8787,
  dataDir: mkdtempSync(join(tmpdir(), "junco-ghclient-state-")),
  branchPrefix: "junco/",
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
    externalReposRoot: "/tmp/junco-test-external",
  },
  botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
  // fileReview traverses the REAL withFileAsAuth by default — "me" is its
  // side-effect-free short-circuit, so the fixture must carry the field.
  assess: { fileAs: "me" },
  // relintChatDraft runs the shared draft lint, which reads maxTasks for a
  // plan set (src/chat/draftLint.ts).
  planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 },
} as unknown as Config;

/** botAccount.enabled=true — ensureBotAccess's non-short-circuit paths need
 * this; withBotAuthFn is always injected alongside it so the real withBotAuth
 * (which spawns the real `gh` binary) never runs in these tests. */
const enabledCfg = { ...cfg, botAccount: { enabled: true, configDir: "/tmp/junco-gh" } } as Config;
const attachFakeCtx = async (c: Config): Promise<Config> => ({ ...c, ghAuth: GH_AUTH_CTX });

const NET = new GitOpError("gh failed", "connect: network is unreachable", 1);

function fakes(
  opts: {
    issues?: unknown[];
    prs?: unknown[];
    body?: string;
    comments?: { author: string; body: string; created_at: string }[];
    viewer?: string;
    origin?: string;
    failArgs?: string; // any gh argv containing this substring throws
    failErr?: Error; // error to throw on failArgs match (default: plain Error)
    permissions?: Record<string, string>; // nwo -> viewerPermission, for `repo view --json viewerPermission`
  } = {},
) {
  const calls: string[][] = [];
  const ok = (stdout: string): CmdResult => ({ code: 0, stdout, stderr: "" });
  const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(args);
    if (opts.failArgs && args.join(" ").includes(opts.failArgs))
      throw opts.failErr ?? new Error("gh boom");
    if (args[0] === "issue" && args[1] === "list") return ok(JSON.stringify(opts.issues ?? []));
    if (args[0] === "issue" && args[1] === "view" && args.includes("--json"))
      return ok(JSON.stringify({ body: opts.body ?? "" }));
    if (args[0] === "issue" && (args[1] === "edit" || args[1] === "view")) return ok("");
    if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify(opts.prs ?? []));
    if (args[0] === "pr" && args[1] === "view") return ok("");
    if (args[0] === "api" && args[1] === "user") return ok(opts.viewer ?? "junco-bot");
    if (args[0] === "api" && String(args[2] ?? "").includes("/comments"))
      return ok((opts.comments ?? []).map((c) => JSON.stringify(c)).join("\n"));
    if (args[0] === "repo" && args[1] === "clone") return ok("");
    if (args[0] === "repo" && args[1] === "view" && args.includes("viewerPermission"))
      return ok(`${opts.permissions?.[args[2]] ?? "READ"}\n`);
    if (args[0] === "repo" && args[1] === "view") return ok("");
    if (args[0] === "label" && args[1] === "list") return ok("");
    if (args[0] === "label" && args[1] === "create") return ok("");
    throw new Error(`unhandled gh argv: ${args.join(" ")}`);
  };
  const gitFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(["git", ...args]);
    return ok(opts.origin ?? "https://github.com/acme/api.git");
  };
  return { ghFn, gitFn, calls };
}

describe("listIssues", () => {
  it("maps gh json to DashIssue[]", async () => {
    const f = fakes({
      issues: [
        {
          number: 42,
          title: "Add rate limiting",
          labels: [{ name: "junco" }, { name: "junco:plan-ready" }],
          updatedAt: "2026-07-06T10:00:00Z",
          url: "https://github.com/acme/api/issues/42",
        },
      ],
    });
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.listIssues("acme/api");
    expect(r).toEqual({
      ok: true,
      value: {
        issues: [
          {
            number: 42,
            title: "Add rate limiting",
            labels: ["junco", "junco:plan-ready"],
            updatedAt: "2026-07-06T10:00:00Z",
            url: "https://github.com/acme/api/issues/42",
            author: null,
          },
        ],
        staleAt: null,
      },
    });
  });

  it("maps gh json author.login when present", async () => {
    const f = fakes({
      issues: [
        {
          number: 43,
          title: "Add caching",
          labels: [],
          updatedAt: "2026-07-06T10:00:00Z",
          url: "https://github.com/acme/api/issues/43",
          author: { login: "junco-bot" },
        },
      ],
    });
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.listIssues("acme/api");
    expect(r.ok && r.value.issues[0]?.author).toBe("junco-bot");
  });

  it("gh failure → ok:false, never throws", async () => {
    const f = fakes({ failArgs: "issue list" });
    const r = await makeGhDashboardClient(cfg, f).listIssues("acme/api");
    expect(r.ok).toBe(false);
  });

  it("listIssues success writes the cache and returns staleAt null", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-cache-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const issues = [
      { number: 1, title: "T", labels: [], updatedAt: "2026-07-06T10:00:00Z", url: "u" },
    ];
    const r = await makeGhDashboardClient(c2, fakes({ issues })).listIssues("acme/api");
    expect(r.ok && r.value.staleAt).toBe(null);
    const cached = JSON.parse(readFileSync(cachePathFor(c2, "acme/api"), "utf8"));
    expect(cached.issues).toEqual(r.ok ? r.value.issues : []);
  });

  it("listIssues offline serves the cache with staleAt set", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-stale-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const issues = [
      { number: 1, title: "T", labels: [], updatedAt: "2026-07-06T10:00:00Z", url: "u" },
    ];
    const first = await makeGhDashboardClient(c2, fakes({ issues })).listIssues("acme/api");
    const cachedFetchedAt = (
      JSON.parse(readFileSync(cachePathFor(c2, "acme/api"), "utf8")) as {
        fetchedAt: string;
      }
    ).fetchedAt;
    const f = fakes({ failArgs: "issue list", failErr: NET });
    const r = await makeGhDashboardClient(c2, f).listIssues("acme/api");
    expect(first.ok).toBe(true);
    expect(r).toEqual({
      ok: true,
      value: { issues: first.ok ? first.value.issues : [], staleAt: cachedFetchedAt },
    });
  });

  it("listIssues offline with a wrong-shape cache treats it as absent → ok:false, no crash", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-badcache-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const path = cachePathFor(c2, "acme/api");
    mkdirSync(dirname(path), { recursive: true });
    // Valid JSON, wrong shape: `issues` is not an array.
    writeFileSync(
      path,
      JSON.stringify({ fetchedAt: "2026-07-06T10:00:00Z", issues: "nope" }),
      "utf8",
    );
    const f = fakes({ failArgs: "issue list", failErr: NET });
    const r = await makeGhDashboardClient(c2, f).listIssues("acme/api");
    expect(r.ok).toBe(false);
  });

  it("listIssues offline with no cache is an error (today's behavior)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-nocache-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const f = fakes({ failArgs: "issue list", failErr: NET });
    const r = await makeGhDashboardClient(c2, f).listIssues("acme/api");
    expect(r.ok).toBe(false);
  });
});

function rawPr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: "Add retry logic",
    url: "https://github.com/acme/api/pull/12",
    headRefName: "junco/add-retry-logic",
    baseRefName: "main",
    isDraft: false,
    state: "OPEN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-06T10:00:00Z",
    mergedAt: null,
    labels: [{ name: "junco" }],
    author: { login: "junco-bot" },
    ...overrides,
  };
}

describe("listPrs", () => {
  it("maps gh json to DashPr[] incl. author.login, labels→names, and injects nwo", async () => {
    const f = fakes({ prs: [rawPr()] });
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.listPrs("acme/api");
    expect(r).toEqual({
      ok: true,
      value: {
        prs: [
          {
            number: 12,
            title: "Add retry logic",
            url: "https://github.com/acme/api/pull/12",
            headRefName: "junco/add-retry-logic",
            baseRefName: "main",
            isDraft: false,
            state: "OPEN",
            reviewDecision: "APPROVED",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            checks: { pass: 1, fail: 0, pending: 0, total: 1 },
            additions: 10,
            deletions: 2,
            changedFiles: 3,
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-06T10:00:00Z",
            mergedAt: null,
            author: "junco-bot",
            labels: ["junco"],
            nwo: "acme/api",
          },
        ],
        staleAt: null,
      },
    });
  });

  it("calls gh with the exact pr list args", async () => {
    const f = fakes({ prs: [rawPr()] });
    await makeGhDashboardClient(cfg, f).listPrs("acme/api");
    expect(f.calls).toContainEqual([
      "pr",
      "list",
      "--repo",
      "acme/api",
      "--state",
      "all",
      "--limit",
      "50",
      "--json",
      "number,title,url,headRefName,baseRefName,isDraft,state,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,additions,deletions,changedFiles,createdAt,updatedAt,mergedAt,labels,author",
    ]);
  });

  it("drops PRs whose head branch isn't under the configured junco prefix", async () => {
    const junco = rawPr({ number: 12, headRefName: "junco/add-retry-logic" });
    const other = rawPr({ number: 13, headRefName: "feature/other-thing" });
    const f = fakes({ prs: [junco, other] });
    const r = await makeGhDashboardClient(cfg, f).listPrs("acme/api");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.prs.map((p) => p.number)).toEqual([12]);
    }
  });

  it("tolerates a null statusCheckRollup (reduceChecks zeroes it)", async () => {
    const f = fakes({ prs: [rawPr({ statusCheckRollup: null })] });
    const r = await makeGhDashboardClient(cfg, f).listPrs("acme/api");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prs[0].checks).toEqual({ pass: 0, fail: 0, pending: 0, total: 0 });
  });

  it("tolerates a garbage (non-array) statusCheckRollup", async () => {
    const f = fakes({ prs: [rawPr({ statusCheckRollup: "not-an-array" })] });
    const r = await makeGhDashboardClient(cfg, f).listPrs("acme/api");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prs[0].checks).toEqual({ pass: 0, fail: 0, pending: 0, total: 0 });
  });

  it("gh failure → ok:false, never throws", async () => {
    const f = fakes({ failArgs: "pr list" });
    const r = await makeGhDashboardClient(cfg, f).listPrs("acme/api");
    expect(r.ok).toBe(false);
  });

  it("listPrs success writes the prs- cache and returns staleAt null", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-prcache-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const r = await makeGhDashboardClient(c2, fakes({ prs: [rawPr()] })).listPrs("acme/api");
    expect(r.ok && r.value.staleAt).toBe(null);
    const path = join(stateDir, "github-cache", "prs-acme__api.json");
    const cached = JSON.parse(readFileSync(path, "utf8"));
    expect(cached.prs).toEqual(r.ok ? r.value.prs : []);
  });

  it("listPrs offline serves the cache with staleAt set", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-prstale-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const first = await makeGhDashboardClient(c2, fakes({ prs: [rawPr()] })).listPrs("acme/api");
    const path = join(stateDir, "github-cache", "prs-acme__api.json");
    const cachedFetchedAt = (JSON.parse(readFileSync(path, "utf8")) as { fetchedAt: string })
      .fetchedAt;
    const f = fakes({ failArgs: "pr list", failErr: NET });
    const r = await makeGhDashboardClient(c2, f).listPrs("acme/api");
    expect(first.ok).toBe(true);
    expect(r).toEqual({
      ok: true,
      value: { prs: first.ok ? first.value.prs : [], staleAt: cachedFetchedAt },
    });
  });

  it("listPrs offline with no cache is an error (today's behavior)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-prnocache-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const f = fakes({ failArgs: "pr list", failErr: NET });
    const r = await makeGhDashboardClient(c2, f).listPrs("acme/api");
    expect(r.ok).toBe(false);
  });

  it("permanent (non-network) error never reads the cache, even if one exists", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-prpermanent-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    // Seed a valid cache first.
    await makeGhDashboardClient(c2, fakes({ prs: [rawPr()] })).listPrs("acme/api");
    const forbidden = new GitOpError("gh failed", "HTTP 403: Forbidden", 1);
    const f = fakes({ failArgs: "pr list", failErr: forbidden });
    const r = await makeGhDashboardClient(c2, f).listPrs("acme/api");
    expect(r.ok).toBe(false);
  });
});

describe("openPrInBrowser", () => {
  it("calls gh pr view --web with the PR number and repo", async () => {
    const f = fakes();
    const r = await makeGhDashboardClient(cfg, f).openPrInBrowser("acme/api", 12);
    expect(r.ok).toBe(true);
    expect(f.calls).toContainEqual(["pr", "view", "12", "--repo", "acme/api", "--web"]);
  });

  it("gh failure → ok:false, never throws", async () => {
    const f = fakes({ failArgs: "pr view" });
    const r = await makeGhDashboardClient(cfg, f).openPrInBrowser("acme/api", 12);
    expect(r.ok).toBe(false);
  });
});

describe("openRepoInBrowser", () => {
  it("calls gh repo view --web", async () => {
    const f = fakes();
    const r = await makeGhDashboardClient(cfg, f).openRepoInBrowser("acme/api");
    expect(r.ok).toBe(true);
    expect(f.calls).toContainEqual(["repo", "view", "acme/api", "--web"]);
  });
  it("gh failure → ok:false, never throws", async () => {
    const f = fakes({ failArgs: "repo view" });
    const r = await makeGhDashboardClient(cfg, f).openRepoInBrowser("acme/api");
    expect(r.ok).toBe(false);
  });
});

describe("issueDetail", () => {
  it("returns body + latest SELF-authored plan comment", async () => {
    const plan = "<!-- junco:plan -->\n````junco-ticket\n# P\n````\n";
    const f = fakes({
      body: "the issue body",
      viewer: "junco-bot",
      comments: [
        {
          author: "mallory",
          body: "<!-- junco:plan -->forged",
          created_at: "2026-07-06T09:00:00Z",
        },
        { author: "junco-bot", body: plan, created_at: "2026-07-06T10:00:00Z" },
      ],
    });
    const r = await makeGhDashboardClient(cfg, f).issueDetail("acme/api", 42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.body).toBe("the issue body");
      expect(r.value.planComment).toBe(plan);
    }
  });

  it("no plan comment → planComment null", async () => {
    const f = fakes({ body: "b", comments: [] });
    const r = await makeGhDashboardClient(cfg, f).issueDetail("acme/api", 42);
    expect(r.ok && r.value.planComment === null).toBe(true);
  });
});

describe("applyAction label mapping", () => {
  const run = async (action: string, labels: string[]) => {
    const f = fakes();
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.applyAction("acme/api", 42, action as never, labels);
    expect(r.ok).toBe(true);
    return f.calls.find((a) => a[0] === "issue" && a[1] === "edit")!;
  };

  it("dispatch adds the trigger label", async () => {
    expect(await run("dispatch", [])).toEqual(expect.arrayContaining(["--add-label", "junco"]));
  });
  it("dispatchAsk adds trigger + ask in one call", async () => {
    const edit = await run("dispatchAsk", []);
    expect(edit).toEqual(
      expect.arrayContaining(["--add-label", "junco", "--add-label", "junco:ask"]),
    );
  });
  it("approve adds junco:approved", async () => {
    expect(await run("approve", ["junco", "junco:plan-ready"])).toEqual(
      expect.arrayContaining(["--add-label", "junco:approved"]),
    );
  });
  it("replan removes plan-ready and approved when present", async () => {
    const edit = await run("replan", ["junco", "junco:plan-ready", "junco:approved"]);
    expect(edit).toEqual(
      expect.arrayContaining([
        "--remove-label",
        "junco:plan-ready",
        "--remove-label",
        "junco:approved",
      ]),
    );
  });
  it("recycle removes exactly the terminal label present", async () => {
    const edit = await run("recycle", ["junco", "junco:failed"]);
    expect(edit).toEqual(expect.arrayContaining(["--remove-label", "junco:failed"]));
    expect(edit).not.toContain("junco:done");
  });
  it("recycle with no terminal label is a clean no-op (no edit call)", async () => {
    const f = fakes();
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.applyAction("acme/api", 42, "recycle", ["junco"]);
    expect(r).toEqual({ ok: true, value: { queued: false } });
    expect(f.calls.find((a) => a[0] === "issue" && a[1] === "edit")).toBeUndefined();
    expect(listOps(cfg)).toHaveLength(0);
  });

  it("applyAction offline queues a labels op and reports queued:true", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-offline-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const f = fakes({ failArgs: "issue edit", failErr: NET });
    const r = await makeGhDashboardClient(c2, f).applyAction("acme/api", 42, "dispatch", []);
    expect(r).toEqual({ ok: true, value: { queued: true } });
    const ops = listOps(c2);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toMatchObject({ kind: "labels", issue: 42, add: ["junco"], remove: [] });
  });

  it("applyAction permanent failure still returns ok:false and queues nothing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-403-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const forbidden = new GitOpError("gh failed", "HTTP 403: Forbidden", 1);
    const f = fakes({ failArgs: "issue edit", failErr: forbidden });
    const r = await makeGhDashboardClient(c2, f).applyAction("acme/api", 42, "dispatch", []);
    expect(r.ok).toBe(false);
    expect(listOps(c2)).toHaveLength(0);
  });
});

describe("validateAndPrepareRepo", () => {
  it("origin mismatch → ok:false with a clear error", async () => {
    const f = fakes({ origin: "https://github.com/other/thing.git" });
    const r = await makeGhDashboardClient(cfg, f).validateAndPrepareRepo("acme/api", "/c/api");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("origin");
  });

  it("valid repo: checks gh reachability and ensures the trigger label", async () => {
    const f = fakes();
    const r = await makeGhDashboardClient(cfg, f).validateAndPrepareRepo("acme/api", "/c/api");
    expect(r.ok).toBe(true);
    expect(f.calls.find((a) => a[0] === "repo" && a[1] === "view")).toBeDefined();
    expect(
      f.calls.find((a) => a[0] === "label" && a[1] === "create" && a.includes("junco")),
    ).toBeDefined();
  });
});

describe("health", () => {
  it("maps /health json; fetch failure → up:false", async () => {
    const fetchOk = (async () => ({
      ok: true,
      json: async () => ({
        ready: true,
        metrics: {
          uptimeSeconds: 120,
          lastBridgeSweepAt: "2026-07-06T10:00:00Z",
          ticketsBridged: 2,
          tasksProcessed: 9,
          tasksSucceeded: 7,
          tasksFailed: 2,
          lastTaskStatus: "completed",
          lastTaskAt: "2026-07-06T09:55:00Z",
          totalTokensOut: 45000,
          bridgeErrors: 1,
        },
      }),
    })) as unknown as typeof fetch;
    const c1 = makeGhDashboardClient(cfg, { ...fakes(), fetchFn: fetchOk });
    expect(await c1.health()).toEqual({
      up: true,
      uptimeSeconds: 120,
      lastBridgeSweepAt: "2026-07-06T10:00:00Z",
      ticketsBridged: 2,
      tasksProcessed: 9,
      tasksSucceeded: 7,
      tasksFailed: 2,
      lastTaskStatus: "completed",
      lastTaskAt: "2026-07-06T09:55:00Z",
      totalTokensOut: 45000,
      bridgeErrors: 1,
      chats: null,
    });
    const fetchBad = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const c2 = makeGhDashboardClient(cfg, { ...fakes(), fetchFn: fetchBad });
    const down = await c2.health();
    expect(down.up).toBe(false);
    expect(down).toEqual({
      up: false,
      uptimeSeconds: null,
      lastBridgeSweepAt: null,
      ticketsBridged: null,
      tasksProcessed: null,
      tasksSucceeded: null,
      tasksFailed: null,
      lastTaskStatus: null,
      lastTaskAt: null,
      totalTokensOut: null,
      bridgeErrors: null,
      chats: null,
    });
  });

  it("health() passes /health.chats through (spec 2026-09-01 §4)", async () => {
    const chats = {
      enabled: true,
      sessions: [],
      turns: 2,
      costUsd: 0.5,
      tokensIn: 10,
      tokensOut: 20,
    };
    const fetchChats = (async () => ({
      ok: true,
      json: async () => ({ ready: true, metrics: {}, chats }),
    })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn: fetchChats });
    expect((await c.health()).chats).toEqual(chats);
  });
});

describe("cloneRepo", () => {
  it("clones via gh repo clone into the destination", async () => {
    const f = fakes();
    const dest = join(mkdtempSync(join(tmpdir(), "junco-clone-")), "acme", "api");
    const r = await makeGhDashboardClient(cfg, f).cloneRepo("acme/api", dest);
    expect(r.ok).toBe(true);
    expect(f.calls).toContainEqual(["repo", "clone", "acme/api", dest]);
  });

  it("reuses an existing destination without cloning", async () => {
    const f = fakes();
    const dest = mkdtempSync(join(tmpdir(), "junco-clone-exists-"));
    const r = await makeGhDashboardClient(cfg, f).cloneRepo("acme/api", dest);
    expect(r.ok).toBe(true);
    expect(f.calls.find((c) => c[0] === "repo" && c[1] === "clone")).toBeUndefined();
  });

  it("clone failure → ok:false with the error", async () => {
    const f = fakes({ failArgs: "repo clone" });
    const dest = join(mkdtempSync(join(tmpdir(), "junco-clone-fail-")), "x");
    const r = await makeGhDashboardClient(cfg, f).cloneRepo("acme/api", dest);
    expect(r.ok).toBe(false);
  });
});

describe("repoPermission", () => {
  it("repoPermission maps viewerPermission to canPush", async () => {
    const f = fakes({ permissions: { "up/stream": "READ", "own/repo": "WRITE" } });
    const client = makeGhDashboardClient(cfg, f);
    const r = await client.repoPermission("up/stream");
    expect(r).toEqual({ ok: true, value: { canPush: false } });
    expect(await client.repoPermission("own/repo")).toEqual({
      ok: true,
      value: { canPush: true },
    });
    expect(f.calls).toContainEqual([
      "repo",
      "view",
      "up/stream",
      "--json",
      "viewerPermission",
      "--jq",
      ".viewerPermission",
    ]);
  });

  it("gh failure → ok:false, never throws", async () => {
    const f = fakes({ failArgs: "viewerPermission" });
    const r = await makeGhDashboardClient(cfg, f).repoPermission("acme/api");
    expect(r.ok).toBe(false);
  });
});

describe("prepareExternalRepo", () => {
  it("delegates to ensureExternalClone via the injectable seam", async () => {
    const f = fakes();
    const ensureCloneFn = vi.fn(async (_c: unknown, _nwo: string, _d: unknown) => ({
      path: "/x/external/up/stream",
      forkNwo: "me/stream",
    }));
    const r = await makeGhDashboardClient(cfg, { ...f, ensureCloneFn }).prepareExternalRepo(
      "up/stream",
    );
    expect(r).toEqual({
      ok: true,
      value: { path: "/x/external/up/stream", forkNwo: "me/stream" },
    });
    expect(ensureCloneFn).toHaveBeenCalledWith(cfg, "up/stream", expect.anything());
  });

  it("provisioning failure → ok:false, never throws", async () => {
    const ensureCloneFn = vi.fn(async (_c: unknown, _nwo: string, _d: unknown) => {
      throw new Error("fork boom");
    });
    const r = await makeGhDashboardClient(cfg, { ...fakes(), ensureCloneFn }).prepareExternalRepo(
      "up/stream",
    );
    expect(r.ok).toBe(false);
  });

  // --- bot-account provisioning (Task 6): the fork this provisions is the
  // daemon's future push target, so the clone/fork call must run under the
  // bot context even though it is human-triggered (spec boundary exception —
  // same rule as resolveIssueTarget's provisioning branch). ---

  it("provisions under the bot context — ensureCloneFn receives the ghAuth-attached config", async () => {
    const cloneCfgs: Array<Config> = [];
    const ensureCloneFn = vi.fn(async (c: Config, _nwo: string, _d: unknown) => {
      cloneCfgs.push(c);
      return { path: "/x/external/up/stream", forkNwo: "junco-agent/stream" };
    });
    const r = await makeGhDashboardClient(cfg, {
      ...fakes(),
      ensureCloneFn,
      withBotAuthFn: async (c: Config) => ({ ...c, ghAuth: GH_AUTH_CTX }),
    }).prepareExternalRepo("up/stream");
    expect(r).toEqual({
      ok: true,
      value: { path: "/x/external/up/stream", forkNwo: "junco-agent/stream" },
    });
    expect(cloneCfgs).toHaveLength(1);
    expect(cloneCfgs[0].ghAuth?.login).toBe(GH_AUTH_CTX.login);
  });

  it("bot auth failure (enabled but unauthed) → ok:false with the actionable message, never throws", async () => {
    const ensureCloneFn = vi.fn(async (_c: unknown, _nwo: string, _d: unknown) => ({
      path: "/x",
      forkNwo: "y/z",
    }));
    const r = await makeGhDashboardClient(cfg, {
      ...fakes(),
      ensureCloneFn,
      withBotAuthFn: async () => {
        throw new Error("botAccount.enabled is true but no working gh login exists");
      },
    }).prepareExternalRepo("up/stream");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no working gh login");
    expect(ensureCloneFn).not.toHaveBeenCalled();
  });
});

describe("dispatchTicket", () => {
  it("dispatchTicket delegates to the dispatch core with owner/repo#N", async () => {
    const dispatchSpy = vi.fn(async (_c: unknown, _ref: string, _d: unknown) => ({
      id: "gh-up-stream-7",
      destPath: "/tmp/dest",
      external: true,
      clonePath: "/tmp/clone",
      forkNwo: "me/stream",
    }));
    const client = makeGhDashboardClient(cfg, { ...fakes(), dispatchIssueFn: dispatchSpy });
    const r = await client.dispatchTicket("up/stream", 7);
    expect(r.ok).toBe(true);
    expect(r).toEqual({ ok: true, value: { id: "gh-up-stream-7", destPath: "/tmp/dest" } });
    expect(dispatchSpy).toHaveBeenCalledWith(expect.anything(), "up/stream#7", expect.anything());
  });

  it("dispatch failure → ok:false, never throws", async () => {
    const dispatchSpy = vi.fn(async (_c: unknown, _ref: string, _d: unknown) => {
      throw new Error("dispatch boom");
    });
    const r = await makeGhDashboardClient(cfg, {
      ...fakes(),
      dispatchIssueFn: dispatchSpy,
    }).dispatchTicket("up/stream", 7);
    expect(r.ok).toBe(false);
  });
});

describe("listReview", () => {
  it("returns the pending batches", async () => {
    const batches: PendingAssess[] = [
      {
        id: "assess-x-1",
        nwo: "o/r",
        external: true,
        autoPlan: false,
        repoPath: "/x",
        createdAt: "2026-07-09T00:00:00.000Z",
        findings: [],
      },
    ];
    const listPendingFn = vi.fn((_c: Config) => batches);
    const client = makeGhDashboardClient(cfg, { ...fakes(), listPendingFn });
    const r = await client.listReview();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((b) => b.id)).toEqual(["assess-x-1"]);
    expect(listPendingFn).toHaveBeenCalledWith(cfg);
  });

  it("gh-side failure surfaces as ok:false", async () => {
    const listPendingFn = vi.fn((_c: Config) => {
      throw new Error("readdir boom");
    });
    const r = await makeGhDashboardClient(cfg, { ...fakes(), listPendingFn }).listReview();
    expect(r.ok).toBe(false);
  });
});

describe("fileReview", () => {
  const batch: PendingAssess = {
    id: "assess-x-1",
    nwo: "o/r",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "f1",
        kind: "code",
        severity: "high",
        ruleId: "R",
        title: "T",
        description: "",
        references: [],
      },
    ],
  };

  it("reads the batch and files the selected fingerprints", async () => {
    let gotSelected: Set<string> | null = null;
    const readPendingFn = vi.fn((_c: Config, _id: string) => ({ batch, error: null }));
    const fileFindingsFn = vi.fn(
      (_c: Config, _b: PendingAssess, selected: Set<string>): Promise<FileResult> => {
        gotSelected = selected;
        return Promise.resolve({
          created: 1,
          queuedOffline: 0,
          deduped: 0,
          failed: 0,
          urls: [],
          warnings: [],
          batch,
        });
      },
    );
    const client = makeGhDashboardClient(cfg, { ...fakes(), readPendingFn, fileFindingsFn });
    const r = await client.fileReview("assess-x-1", ["f1"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.created).toBe(1);
    if (r.ok) expect(r.value.batch.id).toBe("assess-x-1");
    expect([...(gotSelected ?? new Set())]).toEqual(["f1"]);
    expect(readPendingFn).toHaveBeenCalledWith(cfg, "assess-x-1");
  });

  it("surfaces a missing batch (ENOENT) as an error Result", async () => {
    const readPendingFn = vi.fn((_c: Config, _id: string) => ({ batch: null, error: null }));
    const client = makeGhDashboardClient(cfg, { ...fakes(), readPendingFn });
    const r = await client.fileReview("nope", ["f1"]);
    expect(r.ok).toBe(false);
  });

  it("surfaces a corrupt batch (readPending error) as an error Result", async () => {
    const readPendingFn = vi.fn((_c: Config, _id: string) => ({
      batch: null,
      error: "pending batch is not valid JSON",
    }));
    const client = makeGhDashboardClient(cfg, { ...fakes(), readPendingFn });
    const r = await client.fileReview("assess-x-1", ["f1"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not valid JSON");
  });

  it('fileAs "bot": the filing cfg carries the bot identity (batch read stays ambient)', async () => {
    const botFileCfg = { ...enabledCfg, assess: { fileAs: "bot" } } as unknown as Config;
    const readPendingFn = vi.fn((_c: Config, _id: string) => ({ batch, error: null }));
    const fileFindingsFn = vi.fn(
      (_c: Config): Promise<FileResult> =>
        Promise.resolve({
          created: 1,
          queuedOffline: 0,
          deduped: 0,
          failed: 0,
          urls: [],
          warnings: [],
          batch,
        }),
    );
    const withFileAsAuthFn = vi.fn(attachFakeCtx);
    const client = makeGhDashboardClient(botFileCfg, {
      ...fakes(),
      readPendingFn,
      fileFindingsFn,
      withFileAsAuthFn,
    });
    const r = await client.fileReview("assess-x-1", ["f1"]);
    expect(r.ok).toBe(true);
    expect(fileFindingsFn.mock.calls[0]?.[0].ghAuth).toEqual(GH_AUTH_CTX);
    expect(readPendingFn).toHaveBeenCalledWith(botFileCfg, "assess-x-1");
  });

  it('fileAs "bot" with a broken bot login: error Result, nothing filed', async () => {
    const readPendingFn = vi.fn((_c: Config, _id: string) => ({ batch, error: null }));
    const fileFindingsFn = vi.fn();
    const withFileAsAuthFn = vi.fn(() =>
      Promise.reject(
        new Error("botAccount.enabled is true but no working gh login — run: junco auth login"),
      ),
    );
    const client = makeGhDashboardClient(cfg, {
      ...fakes(),
      readPendingFn,
      fileFindingsFn,
      withFileAsAuthFn,
    });
    const r = await client.fileReview("assess-x-1", ["f1"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("junco auth login");
    expect(fileFindingsFn).not.toHaveBeenCalled();
  });

  it('fileAs "me" (default dep): the filing cfg stays ambient — no ghAuth attached', async () => {
    const readPendingFn = vi.fn((_c: Config, _id: string) => ({ batch, error: null }));
    const fileFindingsFn = vi.fn(
      (_c: Config): Promise<FileResult> =>
        Promise.resolve({
          created: 0,
          queuedOffline: 0,
          deduped: 1,
          failed: 0,
          urls: [],
          warnings: [],
          batch,
        }),
    );
    // No withFileAsAuthFn injected: the REAL withFileAsAuth runs — safe,
    // because fileAs "me" short-circuits before any gh probe.
    const client = makeGhDashboardClient(cfg, { ...fakes(), readPendingFn, fileFindingsFn });
    const r = await client.fileReview("assess-x-1", ["f1"]);
    expect(r.ok).toBe(true);
    expect(fileFindingsFn).toHaveBeenCalledTimes(1);
    expect(fileFindingsFn.mock.calls[0]?.[0].ghAuth).toBeUndefined();
  });
});

describe("discardReview", () => {
  it("discards via discardPendingFn and returns ok(null)", async () => {
    const discardPendingFn = vi.fn((_c: Config, _id: string) => true);
    const client = makeGhDashboardClient(cfg, { ...fakes(), discardPendingFn });
    const r = await client.discardReview("assess-x-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
    expect(discardPendingFn).toHaveBeenCalledWith(cfg, "assess-x-1");
  });

  it("a throwing discard surfaces as ok:false", async () => {
    const discardPendingFn = vi.fn((_c: Config, _id: string): boolean => {
      throw new Error("rename boom");
    });
    const r = await makeGhDashboardClient(cfg, { ...fakes(), discardPendingFn }).discardReview("x");
    expect(r.ok).toBe(false);
  });
});

describe("listCommentDrafts", () => {
  it("maps through the listDraftsFn dep", async () => {
    const drafts: PendingComment[] = [
      {
        id: "analyze-o-r-1",
        nwo: "o/r",
        issue: 1,
        issueTitle: "Something broke",
        external: true,
        repoPath: "/x",
        createdAt: "2026-07-09T00:00:00.000Z",
        draft: "Here's my analysis.",
        footer: true,
      },
    ];
    const listDraftsFn = vi.fn((_c: Config) => drafts);
    const client = makeGhDashboardClient(cfg, { ...fakes(), listDraftsFn });
    const r = await client.listCommentDrafts();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((d) => d.id)).toEqual(["analyze-o-r-1"]);
    expect(listDraftsFn).toHaveBeenCalledWith(cfg);
  });

  it("failure surfaces as ok:false", async () => {
    const listDraftsFn = vi.fn((_c: Config) => {
      throw new Error("readdir boom");
    });
    const r = await makeGhDashboardClient(cfg, { ...fakes(), listDraftsFn }).listCommentDrafts();
    expect(r.ok).toBe(false);
  });
});

describe("postCommentDraft", () => {
  it("threads id + {noFooter:false} through to postDraftFn and returns {outcome,url}", async () => {
    let gotArgs: unknown[] = [];
    const postDraftFn = vi.fn(
      async (_c: Config, id: string, opts: { noFooter: boolean }, _d?: { ghFn?: typeof gh }) => {
        gotArgs = [id, opts];
        return {
          outcome: "sent" as const,
          url: "https://github.com/o/r/issues/1#issuecomment-1",
        };
      },
    );
    const client = makeGhDashboardClient(cfg, { ...fakes(), postDraftFn });
    const r = await client.postCommentDraft("analyze-o-r-1");
    expect(r).toEqual({
      ok: true,
      value: { outcome: "sent", url: "https://github.com/o/r/issues/1#issuecomment-1" },
    });
    expect(gotArgs).toEqual(["analyze-o-r-1", { noFooter: false }]);
  });

  it("a throwing postDraftFn -> ok:false with the message", async () => {
    const postDraftFn = vi.fn(async () => {
      throw new Error("no pending draft 'nope'");
    });
    const r = await makeGhDashboardClient(cfg, { ...fakes(), postDraftFn }).postCommentDraft(
      "nope",
    );
    expect(r).toEqual({ ok: false, error: "no pending draft 'nope'" });
  });
});

describe("discardCommentDraft", () => {
  it('calls the dep with (cfg, id, "discarded")', async () => {
    const discardDraftFn = vi.fn((_c: Config, _id: string, _to: "posted" | "discarded") => {});
    const client = makeGhDashboardClient(cfg, { ...fakes(), discardDraftFn });
    const r = await client.discardCommentDraft("analyze-o-r-1");
    expect(r).toEqual({ ok: true, value: null });
    expect(discardDraftFn).toHaveBeenCalledWith(cfg, "analyze-o-r-1", "discarded");
  });

  it("failure surfaces as ok:false", async () => {
    const discardDraftFn = vi.fn(() => {
      throw new Error("enoent");
    });
    const r = await makeGhDashboardClient(cfg, { ...fakes(), discardDraftFn }).discardCommentDraft(
      "nope",
    );
    expect(r.ok).toBe(false);
  });
});

describe("analyzeIssue", () => {
  it("builds the ref 'o/r#7' and returns the id", async () => {
    const analyzeCoreFn = vi.fn(async (_c: Config, ref: string) => {
      expect(ref).toBe("o/r#7");
      return { id: "analyze-o-r-7", destPath: "/inbox/analyze-o-r-7.md" };
    });
    const client = makeGhDashboardClient(cfg, { ...fakes(), analyzeCoreFn });
    const r = await client.analyzeIssue("o/r", 7);
    expect(r).toEqual({ ok: true, value: { id: "analyze-o-r-7" } });
    expect(analyzeCoreFn).toHaveBeenCalledWith(
      cfg,
      "o/r#7",
      expect.objectContaining({ resolveDeps: expect.anything() }),
    );
  });

  it("threads the client's {ghFn,gitFn} through resolveDeps — not the real-binary defaults", async () => {
    const f = fakes();
    let gotGhFn: unknown;
    let gotGitFn: unknown;
    const analyzeCoreFn = vi.fn(
      async (
        _c: Config,
        _ref: string,
        deps?: { resolveDeps?: { ghFn?: unknown; gitFn?: unknown } },
      ) => {
        gotGhFn = deps?.resolveDeps?.ghFn;
        gotGitFn = deps?.resolveDeps?.gitFn;
        return { id: "analyze-o-r-7", destPath: "/inbox/analyze-o-r-7.md" };
      },
    );
    const client = makeGhDashboardClient(cfg, { ...f, analyzeCoreFn });
    await client.analyzeIssue("o/r", 7);
    // Identity check: the injected fakes reach the core, never falling back
    // to real gh/git defaults inside resolveIssueTarget/ensureExternalClone.
    expect(gotGhFn).toBe(f.ghFn);
    expect(gotGitFn).toBe(f.gitFn);
  });

  it("throwing core -> ok:false", async () => {
    const analyzeCoreFn = vi.fn(async () => {
      throw new Error("resolve boom");
    });
    const r = await makeGhDashboardClient(cfg, { ...fakes(), analyzeCoreFn }).analyzeIssue(
      "o/r",
      7,
    );
    expect(r.ok).toBe(false);
  });
});

describe("ensureBotAccess", () => {
  it("skips when botAccount disabled", async () => {
    const grantFn = vi.fn(async () => ({ login: "junco-agent" }));
    const client = makeGhDashboardClient(cfg, { ...fakes(), grantFn });
    const r = await client.ensureBotAccess("acme/api");
    expect(r).toEqual({ ok: true, value: { skipped: true } });
    expect(grantFn).not.toHaveBeenCalled();
  });

  it("skips when the bot already has push", async () => {
    const classifyFn = vi.fn(async (): Promise<RepoAccess> => ({ mode: "direct" }));
    const grantFn = vi.fn(async () => ({ login: "junco-agent" }));
    const client = makeGhDashboardClient(enabledCfg, {
      ...fakes(),
      withBotAuthFn: attachFakeCtx,
      classifyFn,
      grantFn,
    });
    const r = await client.ensureBotAccess("acme/api");
    expect(r).toEqual({ ok: true, value: { skipped: true } });
    expect(classifyFn).toHaveBeenCalledWith(
      expect.objectContaining({ ghAuth: GH_AUTH_CTX }),
      "acme/api",
      expect.anything(),
    );
    expect(grantFn).not.toHaveBeenCalled();
  });

  it("grants when the bot lacks push", async () => {
    const classifyFn = vi.fn(
      async (): Promise<RepoAccess> => ({ mode: "blocked", reason: "no-access" }),
    );
    const grantFn = vi.fn(async () => ({ login: "junco-agent" }));
    const client = makeGhDashboardClient(enabledCfg, {
      ...fakes(),
      withBotAuthFn: attachFakeCtx,
      classifyFn,
      grantFn,
    });
    const r = await client.ensureBotAccess("acme/api");
    expect(r).toEqual({ ok: true, value: { skipped: false, login: "junco-agent" } });
    expect(grantFn).toHaveBeenCalledWith(enabledCfg, "acme/api", expect.anything());
  });

  it("grant failure → error Result (never throws)", async () => {
    const classifyFn = vi.fn(
      async (): Promise<RepoAccess> => ({ mode: "blocked", reason: "no-access" }),
    );
    const grantFn = vi.fn(async () => {
      throw new Error("granting on acme/api needs admin — ask an org admin");
    });
    const client = makeGhDashboardClient(enabledCfg, {
      ...fakes(),
      withBotAuthFn: attachFakeCtx,
      classifyFn,
      grantFn,
    });
    const r = await client.ensureBotAccess("acme/api");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/needs admin/);
  });
});

describe("botGrantPreflight", () => {
  /** ghFn that answers the ambient repo-meta probe (`gh api repos/<nwo>`)
   * and defers everything else to the shared fakes() handler. */
  const metaFakes = (meta: { private: boolean; ownerType: string } | "fail") => {
    const f = fakes();
    const ghFn = async (c: unknown, args: string[]): Promise<CmdResult> => {
      if (args[0] === "api" && args[1] === "repos/acme/api") {
        if (meta === "fail") return { code: 1, stdout: "", stderr: "HTTP 500" };
        return { code: 0, stdout: JSON.stringify(meta), stderr: "" };
      }
      return f.ghFn(c, args);
    };
    return { ...f, ghFn };
  };
  const blocked = async (): Promise<RepoAccess> => ({ mode: "blocked", reason: "no-access" });

  it("botAccount disabled → needed:false without classifying", async () => {
    const classifyFn = vi.fn(async (): Promise<RepoAccess> => ({ mode: "direct" }));
    const r = await makeGhDashboardClient(cfg, { ...fakes(), classifyFn }).botGrantPreflight(
      "acme/api",
    );
    expect(r).toEqual({ ok: true, value: { needed: false } });
    expect(classifyFn).not.toHaveBeenCalled();
  });

  it("bot already has push → needed:false", async () => {
    const classifyFn = vi.fn(async (): Promise<RepoAccess> => ({ mode: "direct" }));
    const client = makeGhDashboardClient(enabledCfg, {
      ...fakes(),
      withBotAuthFn: attachFakeCtx,
      classifyFn,
    });
    const r = await client.botGrantPreflight("acme/api");
    expect(r).toEqual({ ok: true, value: { needed: false } });
    expect(classifyFn).toHaveBeenCalledWith(
      expect.objectContaining({ ghAuth: GH_AUTH_CTX }),
      "acme/api",
      expect.anything(),
    );
  });

  it("bot lacks push on a private personal repo → confirm gate with the bot login", async () => {
    const client = makeGhDashboardClient(enabledCfg, {
      ...metaFakes({ private: true, ownerType: "User" }),
      withBotAuthFn: attachFakeCtx,
      classifyFn: blocked,
    });
    const r = await client.botGrantPreflight("acme/api");
    expect(r).toEqual({
      ok: true,
      value: { needed: true, login: "junco-agent", privatePersonal: true },
    });
  });

  it("public personal repo → needed but no confirm gate", async () => {
    const client = makeGhDashboardClient(enabledCfg, {
      ...metaFakes({ private: false, ownerType: "User" }),
      withBotAuthFn: attachFakeCtx,
      classifyFn: blocked,
    });
    const r = await client.botGrantPreflight("acme/api");
    expect(r).toEqual({
      ok: true,
      value: { needed: true, login: "junco-agent", privatePersonal: false },
    });
  });

  it("private org-owned repo → needed but no confirm gate", async () => {
    const client = makeGhDashboardClient(enabledCfg, {
      ...metaFakes({ private: true, ownerType: "Organization" }),
      withBotAuthFn: attachFakeCtx,
      classifyFn: blocked,
    });
    const r = await client.botGrantPreflight("acme/api");
    expect(r).toEqual({
      ok: true,
      value: { needed: true, login: "junco-agent", privatePersonal: false },
    });
  });

  it("meta probe failure → needed without the confirm gate (legacy grant path)", async () => {
    const client = makeGhDashboardClient(enabledCfg, {
      ...metaFakes("fail"),
      withBotAuthFn: attachFakeCtx,
      classifyFn: blocked,
    });
    const r = await client.botGrantPreflight("acme/api");
    expect(r).toEqual({
      ok: true,
      value: { needed: true, login: "junco-agent", privatePersonal: false },
    });
  });

  it("withBotAuth throw → error Result (never throws)", async () => {
    const client = makeGhDashboardClient(enabledCfg, {
      ...fakes(),
      withBotAuthFn: async () => {
        throw new Error("bot auth is broken — run: junco auth login");
      },
    });
    const r = await client.botGrantPreflight("acme/api");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/auth login/);
  });
});

describe("readTranscript", () => {
  const path = transcriptPathFor(dataTreePaths(cfg).transcripts, "t-1");
  const enoent = (): Error => Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

  it("missing file → kind missing with the resolved path, no read attempted", async () => {
    const c = makeGhDashboardClient(cfg, {
      statFn: () => {
        throw enoent();
      },
      readFileFn: () => {
        throw new Error("must not read");
      },
    });
    expect(await c.readTranscript("t-1", null)).toEqual({
      ok: true,
      value: { kind: "missing", path },
    });
  });

  it("same size as prevSize → unchanged, without reading", async () => {
    const reads: string[] = [];
    const c = makeGhDashboardClient(cfg, {
      statFn: () => ({ size: 42 }),
      readFileFn: (p) => {
        reads.push(p);
        return "";
      },
    });
    expect(await c.readTranscript("t-1", 42)).toEqual({
      ok: true,
      value: { kind: "unchanged", size: 42 },
    });
    expect(reads).toEqual([]);
  });

  it("changed size → reads and summarizes", async () => {
    const content = [runStart({ flow: "qa" }), turnEndFull({ text: "hi" }), runEnd()].join("\n");
    const c = makeGhDashboardClient(cfg, {
      statFn: () => ({ size: content.length }),
      readFileFn: (p) => {
        expect(p).toBe(path);
        return content;
      },
    });
    const r = await c.readTranscript("t-1", 5);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== "read") throw new Error("expected read");
    expect(r.value.size).toBe(content.length);
    expect(r.value.summary.runs[0].turns[0].text).toBe("hi");
    expect(r.value.summary.live).toBe(false);
  });

  it("a non-ENOENT stat failure is an error Result", async () => {
    const c = makeGhDashboardClient(cfg, {
      statFn: () => {
        throw new Error("EACCES: denied");
      },
    });
    expect(await c.readTranscript("t-1", null)).toEqual({ ok: false, error: "EACCES: denied" });
  });
});

describe("chat", () => {
  const draftBase: PendingDraft = {
    id: "chat-acme-1-1",
    key: "acme/api",
    slug: "chat-acme-1",
    kind: "ticket",
    files: [{ name: "ticket.md", content: "body", lint: [], route: null, droppedKeys: [] }],
    cwd: "/repos/acme/api",
    nwo: "acme/api",
    createdAt: "2026-09-01T00:00:00.000Z",
    lintFailed: false,
    blocked: null,
    routeOverride: "auto",
    commandArgs: null,
  };
  const NOTE_RECORD = {
    type: "junco_chat_draft" as const,
    draftId: "d-1",
    kind: "ticket" as const,
    status: "parked" as const,
    ids: [],
    destination: null,
  };

  it("prContext/issueContext fetch through gh and render a compact block", async () => {
    const f = fakes();
    f.ghFn = (async (_cfg, args) => {
      if (args[0] === "pr")
        return {
          code: 0,
          stdout: JSON.stringify({
            title: "Add cache",
            body: "why",
            reviews: [{ author: { login: "bob" }, state: "CHANGES_REQUESTED", body: "no" }],
            comments: [{ author: { login: "amy" }, body: "hm" }],
          }),
          stderr: "",
        };
      return {
        code: 0,
        stdout: JSON.stringify({
          title: "Bug",
          body: "it breaks",
          comments: [{ author: { login: "amy" }, body: "me too" }],
        }),
        stderr: "",
      };
    }) as typeof f.ghFn;
    const c = makeGhDashboardClient(cfg, f);
    const pr = await c.prContext("acme/api", 42);
    expect(pr.ok && pr.value).toContain("PR #42: Add cache");
    expect(pr.ok && pr.value).toContain("bob (CHANGES_REQUESTED): no");
    const issue = await c.issueContext("acme/api", 7);
    expect(issue.ok && issue.value).toContain("Issue #7: Bug");
    expect(issue.ok && issue.value).toContain("amy: me too");
  });

  it("prContext defaults a missing author/state and skips a bodyless review or comment", async () => {
    const f = fakes();
    f.ghFn = (async () => ({
      code: 0,
      stdout: JSON.stringify({
        title: "Add cache",
        body: "why",
        reviews: [{ body: "" }, { body: "no author or state" }],
        comments: [
          { body: "" },
          { body: "hi, no author" },
          { author: { login: "amy" }, body: "hi" },
        ],
      }),
      stderr: "",
    })) as typeof f.ghFn;
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.prContext("acme/api", 9);
    expect(r).toEqual({
      ok: true,
      value:
        "PR #9: Add cache\n\nwhy\n\n? (COMMENTED): no author or state\n?: hi, no author\namy: hi",
    });
  });

  it("issueContext defaults a missing comment author and skips a bodyless comment", async () => {
    const f = fakes();
    f.ghFn = (async () => ({
      code: 0,
      stdout: JSON.stringify({
        title: "Bug",
        body: "it breaks",
        comments: [
          { body: "" },
          { body: "no author" },
          { author: { login: "amy" }, body: "me too" },
        ],
      }),
      stderr: "",
    })) as typeof f.ghFn;
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.issueContext("acme/api", 9);
    expect(r).toEqual({
      ok: true,
      value: "Issue #9: Bug\n\nit breaks\n\n?: no author\namy: me too",
    });
  });

  it("prContext/issueContext fall back to empty defaults for a minimal gh payload", async () => {
    const f = fakes();
    f.ghFn = (async () => ({ code: 0, stdout: "{}", stderr: "" })) as typeof f.ghFn;
    const c = makeGhDashboardClient(cfg, f);
    expect(await c.prContext("acme/api", 9)).toEqual({ ok: true, value: "PR #9:" });
    expect(await c.issueContext("acme/api", 9)).toEqual({ ok: true, value: "Issue #9:" });
  });

  it("chat draft passthroughs read the draft store", async () => {
    const c = makeGhDashboardClient(cfg, fakes());
    const list = await c.listChatDrafts();
    expect(list).toEqual({ ok: true, value: [] });
  });

  it("readChatDraftFile reads the file at the draft's on-disk path", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-draftfile-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    writeChatDraft(c2, draftBase);
    const c = makeGhDashboardClient(c2, fakes());
    const r = await c.readChatDraftFile(draftBase.id, "ticket.md");
    expect(r).toEqual({ ok: true, value: "body" });
  });

  it("updateChatDraft rewrites the draft JSON via writeChatDraft", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-draftupdate-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const c = makeGhDashboardClient(c2, fakes());
    const r = await c.updateChatDraft(draftBase);
    expect(r).toEqual({ ok: true, value: null });
    expect(listChatDrafts(c2).map((d) => d.id)).toEqual([draftBase.id]);
  });

  it("updateChatDraft re-reads the file bodies from disk, never writing a stale snapshot (R25)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-draftstale-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    writeChatDraft(c2, draftBase);
    const path = draftFilePath(c2, draftBase.id, "ticket.md");
    writeFileSync(path, "edited in $EDITOR\n", "utf8");
    const c = makeGhDashboardClient(c2, fakes());
    // The review list's snapshot still carries the pre-edit body — a route
    // press must not resurrect it.
    const r = await c.updateChatDraft({ ...draftBase, routeOverride: "issue" });
    expect(r).toEqual({ ok: true, value: null });
    expect(readFileSync(path, "utf8")).toBe("edited in $EDITOR\n");
    const stored = listChatDrafts(c2)[0]!;
    expect(stored.files[0]!.content).toBe("edited in $EDITOR\n");
    expect(stored.routeOverride).toBe("issue");
  });

  it("discardChatDraft archives the draft as discarded, removing it from the pending list", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-draftdiscard-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    writeChatDraft(c2, draftBase);
    const c = makeGhDashboardClient(c2, fakes());
    const r = await c.discardChatDraft(draftBase.id);
    expect(r).toEqual({ ok: true, value: null });
    expect(listChatDrafts(c2)).toEqual([]);
  });

  it("archiveSubmittedChatDraft archives the draft as submitted, removing it from the pending list", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-draftsubmit-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    writeChatDraft(c2, draftBase);
    const c = makeGhDashboardClient(c2, fakes());
    const r = await c.archiveSubmittedChatDraft(draftBase.id);
    expect(r).toEqual({ ok: true, value: null });
    expect(listChatDrafts(c2)).toEqual([]);
  });

  it("relintChatDraft re-reads the edited file, re-lints, re-routes and rewrites the JSON", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-draftrelint-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    writeChatDraft(c2, draftBase);
    // The operator's $EDITOR pass: a body the linter rejects.
    writeFileSync(
      draftFilePath(c2, draftBase.id, "ticket.md"),
      "---\nid: t\n---\nStep 1: TBD\n",
      "utf8",
    );
    const routed: unknown[] = [];
    const c = makeGhDashboardClient(c2, {
      ...fakes(),
      decideRouteFn: async (_cfg, fm) => {
        routed.push(fm);
        return {
          destination: "issue" as const,
          reasons: ["repo is bridge-watched"],
          watchedNwo: "acme/api",
          carriedTimeout: null,
          discarded: [],
        };
      },
    });
    const r = await c.relintChatDraft(draftBase.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.files[0]!.content).toContain("Step 1: TBD");
    expect(r.value.files[0]!.lint.map((v) => v.rule)).toContain("no_forbidden_phrases");
    expect(r.value.files[0]!.route?.destination).toBe("issue");
    expect(r.value.lintFailed).toBe(true);
    expect(routed).toHaveLength(1);
    // Rewritten on disk, not just returned.
    expect(listChatDrafts(c2)[0]!.lintFailed).toBe(true);
  });

  it("relintChatDraft clears lintFailed once the edit passes, and never lints a command draft", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-draftrelint2-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    writeChatDraft(c2, { ...draftBase, lintFailed: true });
    writeFileSync(
      draftFilePath(c2, draftBase.id, "ticket.md"),
      "---\nid: t\n---\nA clean body.\n",
      "utf8",
    );
    const c = makeGhDashboardClient(c2, fakes());
    const r = await c.relintChatDraft(draftBase.id);
    expect(r).toMatchObject({ ok: true, value: { lintFailed: false } });

    // audit/investigate/planSet carry no ticket: content is refreshed, lint and
    // route are left exactly as parked (no routeFn call at all).
    const audit: PendingDraft = { ...draftBase, id: "chat-acme-1-2", kind: "audit" };
    writeChatDraft(c2, audit);
    writeFileSync(draftFilePath(c2, audit.id, "ticket.md"), "sweep it\n", "utf8");
    const routed: unknown[] = [];
    const c3 = makeGhDashboardClient(c2, {
      ...fakes(),
      decideRouteFn: async () => {
        routed.push(1);
        throw new Error("unreachable");
      },
    });
    const r2 = await c3.relintChatDraft(audit.id);
    expect(r2).toMatchObject({
      ok: true,
      value: { lintFailed: false, files: [{ content: "sweep it\n", lint: [], route: null }] },
    });
    expect(routed).toEqual([]);
  });

  // A plan set's lint is the compiler's own parse, and relint must re-run it
  // (R26) — otherwise a lint-failed plan is a dead end: `s` refuses, `e` can
  // never clear it, only `D` gets out.
  const GOOD_PLAN = [
    "```junco-plan",
    "version: 1",
    "tasks:",
    "  - id: seed",
    "    title: Seed the changelog",
    "    description: Create the changelog file at the repo root.",
    "    acceptance:",
    "      - CHANGELOG.md exists at the repo root.",
    "```",
    "",
  ].join("\n");
  const BAD_PLAN = "```junco-plan\nversion: 1\ntasks: []\n```\n";

  it("relintChatDraft re-runs the plan-set compiler: a fixed plan clears lintFailed", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-relintplan-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const plan: PendingDraft = {
      ...draftBase,
      id: "chat-plan-1",
      kind: "planSet",
      lintFailed: true,
      files: [
        {
          name: "plan.md",
          content: BAD_PLAN,
          lint: [{ rule: "plan_set", severity: "error", message: "tasks: must be non-empty" }],
          route: null,
          droppedKeys: [],
        },
      ],
    };
    writeChatDraft(c2, plan);
    const c = makeGhDashboardClient(c2, fakes());
    // Still broken on disk → still failing.
    const before = await c.relintChatDraft(plan.id);
    expect(before).toMatchObject({ ok: true, value: { lintFailed: true } });
    // The operator's edit fixes it → the verdict clears and the draft is
    // submittable again.
    writeFileSync(draftFilePath(c2, plan.id, "plan.md"), GOOD_PLAN, "utf8");
    const after = await c.relintChatDraft(plan.id);
    expect(after).toMatchObject({ ok: true, value: { lintFailed: false } });
    if (!after.ok) return;
    expect(after.value.files[0]!.lint).toEqual([]);
    expect(after.value.files[0]!.route).toBeNull(); // a plan set never routes
    expect(listChatDrafts(c2)[0]!.lintFailed).toBe(false);
  });

  it("relintChatDraft fails a plan set whose edit broke it, or deleted the fence", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-relintplan2-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const plan: PendingDraft = {
      ...draftBase,
      id: "chat-plan-2",
      kind: "planSet",
      files: [{ name: "plan.md", content: GOOD_PLAN, lint: [], route: null, droppedKeys: [] }],
    };
    writeChatDraft(c2, plan);
    const c = makeGhDashboardClient(c2, fakes());
    writeFileSync(draftFilePath(c2, plan.id, "plan.md"), BAD_PLAN, "utf8");
    const broken = await c.relintChatDraft(plan.id);
    expect(broken).toMatchObject({ ok: true, value: { lintFailed: true } });
    if (!broken.ok) return;
    expect(broken.value.files[0]!.lint.map((v) => v.rule)).toEqual(["plan_set"]);
    // An edit that dropped the fence is what `junco submit --plan` refuses.
    writeFileSync(draftFilePath(c2, plan.id, "plan.md"), "version: 1\ntasks: []\n", "utf8");
    const noFence = await c.relintChatDraft(plan.id);
    expect(noFence).toMatchObject({ ok: true, value: { lintFailed: true } });
    if (!noFence.ok) return;
    expect(noFence.value.files[0]!.lint[0]!.message).toBe("no junco-plan fence found");
  });

  it("relintChatDraft fails loudly for an unknown or unreadable draft id", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "junco-ghclient-draftrelint3-"));
    const c2 = { ...cfg, dataDir: stateDir } as Config;
    const c = makeGhDashboardClient(c2, fakes());
    expect(await c.relintChatDraft("nope")).toEqual({ ok: false, error: "no chat draft 'nope'" });
    // A truncated/tampered JSON is the store's own error, surfaced verbatim.
    writeChatDraft(c2, draftBase);
    writeFileSync(join(dataTreePaths(c2).chatDrafts, `${draftBase.id}.json`), "{ nope", "utf8");
    const r = await c.relintChatDraft(draftBase.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("not valid JSON");
  });

  it("chat.prompt success returns the daemon's mode", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ mode: "steer" }), { status: 202 })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    expect(await c.chat.prompt("k", "hi")).toEqual({ ok: true, value: { mode: "steer" } });
  });

  it("chat.prompt non-2xx surfaces the daemon's error", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "chat_disabled" }), {
        status: 503,
      })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    const r = await c.chat.prompt("k", "hi");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("chat_disabled");
  });

  it("chat.abort success (202) reports aborted:true", async () => {
    const fetchFn = (async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    expect(await c.chat.abort("k")).toEqual({ ok: true, value: { aborted: true } });
  });

  it("chat.abort no-op (204) reports aborted:false", async () => {
    const fetchFn = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    expect(await c.chat.abort("k")).toEqual({ ok: true, value: { aborted: false } });
  });

  it("chat.abort non-2xx surfaces the daemon's error", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "unknown_key" }), {
        status: 404,
      })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    const r = await c.chat.abort("k");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown_key");
  });

  it("chat.abort with a non-JSON error body falls back to a generic message", async () => {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    const r = await c.chat.abort("k");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("chat request failed (500)");
  });

  it("chat.fresh success returns null", async () => {
    const fetchFn = (async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    expect(await c.chat.fresh("k")).toEqual({ ok: true, value: null });
  });

  it("chat.fresh non-2xx surfaces the daemon's error", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "no_checkout" }), {
        status: 409,
      })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    const r = await c.chat.fresh("k");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no_checkout");
  });

  it("chat.note success returns null", async () => {
    const fetchFn = (async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    expect(await c.chat.note("k", NOTE_RECORD)).toEqual({ ok: true, value: null });
  });

  it("chat.note non-2xx surfaces the daemon's error", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "chat_disabled" }), {
        status: 503,
      })) as unknown as typeof fetch;
    const c = makeGhDashboardClient(cfg, { ...fakes(), fetchFn });
    const r = await c.chat.note("k", NOTE_RECORD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("chat_disabled");
  });

  it("chat.subscribe wires the daemon healthBase through to subscribeChat", () => {
    const c = makeGhDashboardClient(cfg, fakes());
    const stop = c.chat.subscribe("k", null, { record: () => {}, status: () => {}, end: () => {} });
    expect(typeof stop).toBe("function");
    stop();
  });
});
