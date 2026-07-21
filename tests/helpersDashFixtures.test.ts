import { describe, it, expect } from "vitest";
import { makeDashPr, makeDashIssue, GH_AUTH_CTX } from "./helpers/dashFixtures.js";

describe("makeDashPr", () => {
  it("fills every DashPr field with a usable default", () => {
    const pr = makeDashPr();
    expect(Object.keys(pr).sort()).toEqual(
      [
        "additions",
        "author",
        "baseRefName",
        "changedFiles",
        "checks",
        "createdAt",
        "deletions",
        "headRefName",
        "isDraft",
        "labels",
        "mergeStateStatus",
        "mergeable",
        "mergedAt",
        "nwo",
        "number",
        "reviewDecision",
        "state",
        "title",
        "updatedAt",
        "url",
      ].sort(),
    );
    // Defaults derive an OPEN, non-draft, all-green PR — the "review-pending"
    // baseline every call site started from.
    expect(pr.state).toBe("OPEN");
    expect(pr.isDraft).toBe(false);
    expect(pr.reviewDecision).toBeNull();
    expect(pr.mergedAt).toBeNull();
    expect(pr.checks.fail).toBe(0);
    expect(pr.checks.pending).toBe(0);
    expect(pr.labels).toEqual([]);
  });

  it("derives url and headRefName from the number so the branch survives the junco/ prefix filter", () => {
    const pr = makeDashPr({ number: 77 });
    expect(pr.url).toBe("https://github.com/a/b/pull/77");
    expect(pr.headRefName).toBe("junco/task-77");
    expect(pr.title).toContain("77");
  });

  it("overrides win over both defaults and derived fields", () => {
    const pr = makeDashPr({
      number: 3,
      url: "u",
      headRefName: "feat/x",
      state: "MERGED",
      mergedAt: "2026-07-07T00:00:00Z",
      checks: { pass: 0, fail: 1, pending: 0, total: 1 },
      labels: ["junco"],
      author: "alice",
    });
    expect(pr.number).toBe(3);
    expect(pr.url).toBe("u");
    expect(pr.headRefName).toBe("feat/x");
    expect(pr.state).toBe("MERGED");
    expect(pr.mergedAt).toBe("2026-07-07T00:00:00Z");
    expect(pr.checks).toEqual({ pass: 0, fail: 1, pending: 0, total: 1 });
    expect(pr.labels).toEqual(["junco"]);
    expect(pr.author).toBe("alice");
  });

  it("returns a fresh object each call (no shared mutable checks/labels)", () => {
    const a = makeDashPr();
    const b = makeDashPr();
    expect(a).not.toBe(b);
    expect(a.checks).not.toBe(b.checks);
    expect(a.labels).not.toBe(b.labels);
  });
});

describe("makeDashIssue", () => {
  it("fills every DashIssue field with a usable default", () => {
    const iss = makeDashIssue();
    expect(Object.keys(iss).sort()).toEqual(
      ["author", "labels", "number", "title", "updatedAt", "url"].sort(),
    );
    expect(iss.author).toBeNull();
    expect(iss.labels).toEqual(["junco"]);
    expect(Date.parse(iss.updatedAt)).not.toBeNaN();
  });

  it("derives url from the number", () => {
    expect(makeDashIssue({ number: 52 }).url).toBe("https://github.com/a/b/issues/52");
  });

  it("overrides win over both defaults and derived fields", () => {
    const iss = makeDashIssue({
      number: 9,
      title: "Fix reef colors",
      labels: ["junco", "junco:plan-ready"],
      url: "u",
      author: "junco-agent",
    });
    expect(iss).toEqual({
      number: 9,
      title: "Fix reef colors",
      labels: ["junco", "junco:plan-ready"],
      updatedAt: iss.updatedAt,
      url: "u",
      author: "junco-agent",
    });
  });

  it("returns a fresh object each call (no shared mutable labels)", () => {
    const a = makeDashIssue();
    const b = makeDashIssue();
    expect(a).not.toBe(b);
    expect(a.labels).not.toBe(b.labels);
  });
});

describe("GH_AUTH_CTX", () => {
  it("is the shared bot auth context literal", () => {
    expect(GH_AUTH_CTX).toEqual({
      configDir: "/sbx/junco-gh",
      login: "junco-agent",
      email: "1234+junco-agent@users.noreply.github.com",
      credentialHelper: "!gh auth git-credential",
    });
  });
});
