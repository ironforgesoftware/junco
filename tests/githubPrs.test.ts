import { describe, it, expect } from "vitest";
import { fetchJuncoPrs } from "../src/githubPrs.js";
import type { Config } from "../src/types.js";
import type { CmdResult, gh } from "../src/git.js";

function cfg(): Config {
  return { ghBin: "gh", branchPrefix: "junco/" } as unknown as Config;
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

function fakeGh(prs: unknown[]): typeof gh {
  return (async (): Promise<CmdResult> => ({
    code: 0,
    stdout: JSON.stringify(prs),
    stderr: "",
  })) as unknown as typeof gh;
}

describe("fetchJuncoPrs", () => {
  it("maps and filters to junco-authored PRs, tagging the nwo", async () => {
    const prs = await fetchJuncoPrs(cfg(), "acme/api", { ghFn: fakeGh([rawPr()]) });
    expect(prs).toHaveLength(1);
    expect(prs[0].author).toBe("junco-bot");
    expect(prs[0].nwo).toBe("acme/api");
  });

  it("drops non-junco branches (foreign head prefix)", async () => {
    const foreign = rawPr({ headRefName: "feature/manual" });
    const prs = await fetchJuncoPrs(cfg(), "acme/api", { ghFn: fakeGh([foreign]) });
    expect(prs).toHaveLength(0);
  });

  it("skips a null-author PR (deleted account) instead of blanking the repo (#135)", async () => {
    const good = rawPr({ number: 7, headRefName: "junco/keep-me" });
    const deleted = rawPr({ number: 8, headRefName: "junco/ghost", author: null });
    // Before the guard, p.author.login throws inside .map() and drops the WHOLE
    // repo. The null-author PR must be skipped and the rest still returned.
    const prs = await fetchJuncoPrs(cfg(), "acme/api", { ghFn: fakeGh([deleted, good]) });
    expect(prs.map((p) => p.number)).toEqual([7]);
  });
});
