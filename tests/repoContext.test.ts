import { describe, it, expect } from "vitest";
import { deriveRepoContext, deriveBranchName, asStrList, isAmend } from "../src/repoContext.js";
import { homedir } from "node:os";
import { resolve } from "node:path";

const OPTS = {
  defaultBaseBranch: "main",
  branchPrefix: "junco/",
  draftByDefault: true,
  defaultLabels: [] as string[],
};

// ---------------------------------------------------------------------------
// deriveRepoContext — null for Q&A tickets
// ---------------------------------------------------------------------------
describe("deriveRepoContext — null when no repo", () => {
  it("returns null when repo is absent", () => {
    expect(deriveRepoContext({}, "T01", OPTS)).toBeNull();
  });

  it("returns null when repo is empty string", () => {
    expect(deriveRepoContext({ repo: "" }, "T01", OPTS)).toBeNull();
  });

  it("returns null when repo is null", () => {
    expect(deriveRepoContext({ repo: null }, "T01", OPTS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveRepoContext — full PR ticket
// ---------------------------------------------------------------------------
describe("deriveRepoContext — full PR ticket with defaults", () => {
  it("resolves repo to an absolute path", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/myrepo" }, "T04", OPTS);
    expect(ctx).not.toBeNull();
    expect(ctx!.repo).toBe(resolve("/tmp/myrepo"));
  });

  it("expands ~ in repo path", () => {
    const ctx = deriveRepoContext({ repo: "~/myrepo" }, "T04", OPTS);
    expect(ctx).not.toBeNull();
    expect(ctx!.repo).toBe(resolve(homedir(), "myrepo"));
    expect(ctx!.repo).not.toContain("~");
  });

  it("defaults baseBranch to main", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x" }, "T04", OPTS);
    expect(ctx!.baseBranch).toBe("main");
  });

  it("derives branchName from taskId", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x" }, "T04", OPTS);
    expect(ctx!.branchName).toBe("junco/T04");
  });

  it("draft defaults to true (draftByDefault)", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x" }, "T04", OPTS);
    expect(ctx!.draft).toBe(true);
  });

  it("prTitle is null by default", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x" }, "T04", OPTS);
    expect(ctx!.prTitle).toBeNull();
  });

  it("labels defaults to defaultLabels when absent", () => {
    const opts = { ...OPTS, defaultLabels: ["auto"] };
    const ctx = deriveRepoContext({ repo: "/tmp/x" }, "T04", opts);
    expect(ctx!.labels).toEqual(["auto"]);
  });

  it("reviewers is empty by default", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x" }, "T04", OPTS);
    expect(ctx!.reviewers).toEqual([]);
  });

  it("amendsPr is null by default", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x" }, "T04", OPTS);
    expect(ctx!.amendsPr).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveRepoContext — frontmatter overrides
// ---------------------------------------------------------------------------
describe("deriveRepoContext — overrides honored", () => {
  it("branch_name override", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x", branch_name: "feat/my-branch" }, "T04", OPTS);
    expect(ctx!.branchName).toBe("feat/my-branch");
  });

  it("base_branch override", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x", base_branch: "develop" }, "T04", OPTS);
    expect(ctx!.baseBranch).toBe("develop");
  });

  it("pr_title override", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x", pr_title: "My PR Title" }, "T04", OPTS);
    expect(ctx!.prTitle).toBe("My PR Title");
  });

  it("draft: false override", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x", draft: false }, "T04", OPTS);
    expect(ctx!.draft).toBe(false);
  });

  it("draft: true override when draftByDefault is false", () => {
    const opts = { ...OPTS, draftByDefault: false };
    const ctx = deriveRepoContext({ repo: "/tmp/x", draft: true }, "T04", opts);
    expect(ctx!.draft).toBe(true);
  });

  it("labels from frontmatter (comma string) used instead of defaults", () => {
    const opts = { ...OPTS, defaultLabels: ["default-label"] };
    const ctx = deriveRepoContext({ repo: "/tmp/x", labels: "a, b ,c" }, "T04", opts);
    expect(ctx!.labels).toEqual(["a", "b", "c"]);
  });

  it("labels from frontmatter (array) used instead of defaults", () => {
    const opts = { ...OPTS, defaultLabels: ["default-label"] };
    const ctx = deriveRepoContext({ repo: "/tmp/x", labels: ["x", "y"] }, "T04", opts);
    expect(ctx!.labels).toEqual(["x", "y"]);
  });

  it("falls back to defaultLabels when labels frontmatter yields empty list", () => {
    const opts = { ...OPTS, defaultLabels: ["fallback"] };
    const ctx = deriveRepoContext({ repo: "/tmp/x", labels: "" }, "T04", opts);
    expect(ctx!.labels).toEqual(["fallback"]);
  });

  it("reviewers parsed from comma string", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x", reviewers: "alice, bob" }, "T04", OPTS);
    expect(ctx!.reviewers).toEqual(["alice", "bob"]);
  });
});

// ---------------------------------------------------------------------------
// amends_pr parsing
// ---------------------------------------------------------------------------
describe("deriveRepoContext — amends_pr", () => {
  it("parses amends_pr: #42 (string with hash)", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x", amends_pr: "#42" }, "T04", OPTS);
    expect(ctx!.amendsPr).toBe(42);
  });

  it("parses amends_pr: 42 (integer)", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x", amends_pr: 42 }, "T04", OPTS);
    expect(ctx!.amendsPr).toBe(42);
  });

  it("junk amends_pr → null", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x", amends_pr: "notanumber" }, "T04", OPTS);
    expect(ctx!.amendsPr).toBeNull();
  });

  it("isAmend returns true when amendsPr is set", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x", amends_pr: 7 }, "T04", OPTS);
    expect(isAmend(ctx!)).toBe(true);
  });

  it("isAmend returns false when amendsPr is null", () => {
    const ctx = deriveRepoContext({ repo: "/tmp/x" }, "T04", OPTS);
    expect(isAmend(ctx!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveBranchName
// ---------------------------------------------------------------------------
describe("deriveBranchName", () => {
  it("simple taskId passes through", () => {
    expect(deriveBranchName("T04", "junco/")).toBe("junco/T04");
  });

  it("adds trailing slash to prefix if missing", () => {
    expect(deriveBranchName("T04", "junco")).toBe("junco/T04");
  });

  it("sanitizes weird chars", () => {
    // "feat: x/y!" → special chars replaced with "-", strip leading/trailing -/
    expect(deriveBranchName("feat: x/y!", "junco/")).toBe("junco/feat-x/y");
  });

  it("empty slug fallback → task", () => {
    // All special chars → stripped to nothing → "task"
    expect(deriveBranchName("!!!", "junco/")).toBe("junco/task");
  });

  it("strips leading/trailing dashes and slashes from slug", () => {
    expect(deriveBranchName("-foo-", "junco/")).toBe("junco/foo");
  });
});

// ---------------------------------------------------------------------------
// asStrList
// ---------------------------------------------------------------------------
describe("asStrList", () => {
  it("splits comma-separated string, trims, drops empties", () => {
    expect(asStrList("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("handles an array of values", () => {
    // dynamic require used above; use direct import here
    const result = asStrList(["x", " y "]);
    expect(result).toEqual(["x", "y"]);
  });

  it("returns [] for undefined", () => {
    expect(asStrList(undefined)).toEqual([]);
  });

  it("returns [] for null", () => {
    expect(asStrList(null)).toEqual([]);
  });

  it("empty string returns []", () => {
    expect(asStrList("")).toEqual([]);
  });

  it("array with blank entries drops them", () => {
    expect(asStrList(["a", " ", "b"])).toEqual(["a", "b"]);
  });
});
