import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPrsCommand, formatPrLine } from "../src/prsCmd.js";
import { writeWatchlist, watchlistPath } from "../src/watchlist.js";
import type { Config, GithubRepoMapping } from "../src/types.js";
import type { CmdResult, gh } from "../src/git.js";
import type { DashPr } from "../src/tui/prState.js";
import { makeDashPr } from "./helpers/dashFixtures.js";

function cfg(repos: GithubRepoMapping[] = []): Config {
  return {
    ghBin: "gh",
    dataDir: mkdtempSync(join(tmpdir(), "junco-prscmd-state-")),
    branchPrefix: "junco/",
    github: {
      enabled: false,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos,
      requireApproval: true,
      plannerModelId: null,
      externalReposRoot: "/tmp/junco-test-external",
    },
  } as unknown as Config;
}

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

/** Fake `gh` router keyed off `--repo <nwo>`: returns `prsByRepo[nwo]` (default
 * `[]`) for `pr list`, or throws `failFor[nwo]` when set — mirrors
 * tests/tuiGhClient.test.ts's `fakes()` pattern, scoped to multi-repo prsCmd
 * scenarios. */
function fakeGh(
  opts: {
    prsByRepo?: Record<string, unknown[]>;
    failFor?: Record<string, Error>;
  } = {},
): typeof gh {
  const ok = (stdout: string): CmdResult => ({ code: 0, stdout, stderr: "" });
  return (async (_c: unknown, args: string[]): Promise<CmdResult> => {
    const repoIdx = args.indexOf("--repo");
    const nwo = repoIdx >= 0 ? args[repoIdx + 1] : "";
    if (opts.failFor?.[nwo]) throw opts.failFor[nwo];
    return ok(JSON.stringify(opts.prsByRepo?.[nwo] ?? []));
  }) as unknown as typeof gh;
}

describe("runPrsCommand", () => {
  it("no watched repositories → guidance message, exit 0", async () => {
    const c = cfg([]);
    const out: string[] = [];
    const code = await runPrsCommand(c, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("")).toBe(
      "no watched repositories — add github.repos to config.json or watch one from the dashboard\n",
    );
  });

  it("aggregates junco PRs across repos, sorted attention-first", async () => {
    const c = cfg([
      { nwo: "acme/api", path: "/x/api" },
      { nwo: "acme/web", path: "/x/web" },
    ]);
    const approved = rawPr({
      number: 5,
      title: "Approved thing",
      headRefName: "junco/approved-thing",
      url: "https://github.com/acme/api/pull/5",
      updatedAt: "2026-07-04T00:00:00Z",
    });
    const failing = rawPr({
      number: 9,
      title: "Failing thing",
      headRefName: "junco/failing-thing",
      url: "https://github.com/acme/web/pull/9",
      reviewDecision: null,
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
      updatedAt: "2026-07-05T00:00:00Z",
    });
    const ghFn = fakeGh({ prsByRepo: { "acme/api": [approved], "acme/web": [failing] } });
    const out: string[] = [];
    const code = await runPrsCommand(c, { printFn: (s) => out.push(s), ghFn });
    expect(code).toBe(0);
    const lines = out.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    // Failing checks (worse news) sort ahead of an approved PR.
    expect(lines[0]).toContain("#   9");
    expect(lines[0]).toContain("checks-failing");
    expect(lines[1]).toContain("#   5");
    expect(lines[1]).toContain("approved");
  });

  it("a failing repo prints one warn line (first line of the error) and continues", async () => {
    const c = cfg([
      { nwo: "acme/api", path: "/x/api" },
      { nwo: "acme/web", path: "/x/web" },
    ]);
    const ok = rawPr({
      number: 5,
      headRefName: "junco/ok-thing",
      url: "https://github.com/acme/web/pull/5",
    });
    const err = new Error("connect ECONNREFUSED\nsome extra detail that should be dropped");
    const ghFn = fakeGh({ prsByRepo: { "acme/web": [ok] }, failFor: { "acme/api": err } });
    const out: string[] = [];
    const code = await runPrsCommand(c, { printFn: (s) => out.push(s), ghFn });
    expect(code).toBe(0);
    const joined = out.join("");
    expect(joined).toContain("acme/api: connect ECONNREFUSED\n");
    expect(joined).not.toContain("extra detail");
    expect(joined).toContain("#   5");
  });

  it("every repo failing → exit 1, one warn line per repo", async () => {
    const c = cfg([
      { nwo: "acme/api", path: "/x/api" },
      { nwo: "acme/web", path: "/x/web" },
    ]);
    const ghFn = fakeGh({
      failFor: { "acme/api": new Error("boom1"), "acme/web": new Error("boom2") },
    });
    const out: string[] = [];
    const code = await runPrsCommand(c, { printFn: (s) => out.push(s), ghFn });
    expect(code).toBe(1);
    expect(out.join("")).toBe("acme/api: boom1\nacme/web: boom2\n");
  });

  it("repos configured but zero junco PRs → 'no junco PRs found', exit 0", async () => {
    const c = cfg([{ nwo: "acme/api", path: "/x/api" }]);
    const ghFn = fakeGh({ prsByRepo: { "acme/api": [] } });
    const out: string[] = [];
    const code = await runPrsCommand(c, { printFn: (s) => out.push(s), ghFn });
    expect(code).toBe(0);
    expect(out.join("")).toBe("no junco PRs found\n");
  });

  it("includes external (fork-PR) repos' junco PRs — matching the dashboard (#131)", async () => {
    // No config repos: the only watched repo is an external:true watchlist entry.
    // The bridge never polls it (resolveWatchedRepos excludes it), but `junco prs`
    // must still list its junco-authored draft PRs — the fork-PR review surface.
    const c = cfg([]);
    writeWatchlist(watchlistPath(c), [{ nwo: "up/stream", path: "/c/up", external: true }]);
    const pr = rawPr({
      number: 7,
      headRefName: "junco/fork-fix",
      url: "https://github.com/up/stream/pull/7",
    });
    const ghFn = fakeGh({ prsByRepo: { "up/stream": [pr] } });
    const out: string[] = [];
    const code = await runPrsCommand(c, { printFn: (s) => out.push(s), ghFn });
    expect(code).toBe(0);
    expect(out.join("")).toContain("#   7");
  });

  it("one repo failing among successes still exits 0 (not every repo failed)", async () => {
    const c = cfg([
      { nwo: "acme/api", path: "/x/api" },
      { nwo: "acme/web", path: "/x/web" },
    ]);
    const ghFn = fakeGh({ prsByRepo: { "acme/web": [] }, failFor: { "acme/api": new Error("x") } });
    const out: string[] = [];
    const code = await runPrsCommand(c, { printFn: (s) => out.push(s), ghFn });
    expect(code).toBe(0);
  });
});

describe("formatPrLine", () => {
  const basePr: DashPr = makeDashPr({
    number: 42,
    title: "Short title",
    url: "https://github.com/acme/api/pull/42",
    headRefName: "junco/short-title",
    checks: { pass: 2, fail: 1, pending: 0, total: 3 },
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-06T00:00:00Z",
    nwo: "acme/api",
  });

  it("formats #num, badge, checks, title, and url, in that order, url last", () => {
    const line = formatPrLine(basePr);
    expect(line).toContain("#  42");
    expect(line).toContain("checks-failing");
    expect(line).toContain("✓2 ✗1 ◍0");
    expect(line).toContain("Short title");
    expect(line.endsWith(basePr.url)).toBe(true);
    // Column order: num, badge, checks, title, url.
    expect(line.indexOf("#")).toBeLessThan(line.indexOf("checks-failing"));
    expect(line.indexOf("checks-failing")).toBeLessThan(line.indexOf("✓2"));
    expect(line.indexOf("✓2")).toBeLessThan(line.indexOf("Short title"));
    expect(line.indexOf("Short title")).toBeLessThan(line.indexOf(basePr.url));
  });

  it("truncates a long title to ~50 chars with an ellipsis", () => {
    const longTitle = "x".repeat(80);
    const pr: DashPr = { ...basePr, title: longTitle };
    const line = formatPrLine(pr);
    expect(line).toContain("x".repeat(49) + "…");
    expect(line).not.toContain("x".repeat(51));
  });

  it("shows — when a PR has zero checks", () => {
    const pr: DashPr = { ...basePr, checks: { pass: 0, fail: 0, pending: 0, total: 0 } };
    expect(formatPrLine(pr)).toMatch(/ — /);
  });
});
