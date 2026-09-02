import { describe, it, expect } from "vitest";
import { extractDrafts, FRONTMATTER_ALLOWLIST } from "../src/chat/fenceExtract.js";

const ctx = { repo: "/repo/acme-api", nwo: "acme/api", planSetsEnabled: true };
const fence = (fm: string, body: string, tag = "junco-ticket") =>
  `\`\`\`${tag}\n---\n${fm}\n---\n${body}\n\`\`\``;

describe("extractDrafts (spec 2026-09-01 §6.1)", () => {
  it("no fence → no drafts", () => {
    expect(extractDrafts("just prose", ctx)).toEqual([]);
  });

  it("one junco-ticket fence → kind ticket; repo: is junco's, and is the checkout PATH", () => {
    const [d] = extractDrafts(
      fence("id: add-cache\npr_title: Add cache", "# Add cache\n\nbody"),
      ctx,
    );
    expect(d!.kind).toBe("ticket");
    expect(d!.files).toHaveLength(1);
    const f = d!.files[0]!;
    expect(f.id).toBe("add-cache");
    expect(f.name).toBe("add-cache.md");
    expect(f.frontmatter).toEqual({
      id: "add-cache",
      pr_title: "Add cache",
      repo: "/repo/acme-api",
    });
    expect(f.content.startsWith("---\n")).toBe(true);
    expect(f.content).toContain("repo: /repo/acme-api");
    expect(f.content.endsWith("# Add cache\n\nbody\n")).toBe(true);
    expect(f.droppedKeys).toEqual([]);
  });

  it("the allowlist drops tools/network/workdir/repo/unknown keys and records them", () => {
    const [d] = extractDrafts(
      fence(
        "id: x\ntools: [bash]\nnetwork: true\nworkdir: /etc\nrepo: /elsewhere\nfoo: 1\nlabels: [a]",
        "# X",
      ),
      ctx,
    );
    const f = d!.files[0]!;
    expect(f.frontmatter).toEqual({ id: "x", labels: ["a"], repo: "/repo/acme-api" });
    expect(f.droppedKeys.sort()).toEqual(["foo", "network", "repo", "tools", "workdir"]);
    for (const k of [
      "tools",
      "network",
      "workdir",
      "repo",
      "push_remote",
      "not_before",
      "retry_count",
      "deps_satisfied",
      "plan",
    ])
      expect(FRONTMATTER_ALLOWLIST.has(k)).toBe(false);
  });

  it("local repo (no nwo): repo is the cwd — same value a watched session gets (R17)", () => {
    const [d] = extractDrafts(fence("id: x", "# X"), { ...ctx, nwo: null });
    expect(d!.files[0]!.frontmatter.repo).toBe("/repo/acme-api");
  });

  it("kinds by frontmatter shape, with precedence audit > investigate > amend > apply > ticket; legacy keys accepted, canonical wins", () => {
    const k = (fm: string, body = "# T") => extractDrafts(fence(fm, body), ctx)[0]!.kind;
    expect(k("id: a\namends_pr: 42")).toBe("amend");
    // The outer junco-ticket fence must use MORE backticks than the nested
    // junco-patch fence (planPrompt.ts's system prompt teaches this) — a
    // same-count nesting is a different, honest-failure case covered below.
    expect(
      extractDrafts(
        "````junco-ticket\n---\nid: a\n---\n# T\n\n```junco-patch\nFrom 0 Mon Sep 17 00:00:00 2001\n```\n````",
        ctx,
      )[0]!.kind,
    ).toBe("apply");
    expect(k("id: a\naudit:\n  auto_plan: true")).toBe("audit");
    expect(k("id: a\ninvestigate:\n  issue: 7")).toBe("investigate");
    expect(k("id: a\naudit: {}\ninvestigate:\n  issue: 7\namends_pr: 1")).toBe("audit");
    expect(k("id: a\nassess:\n  auto_plan: true")).toBe("audit"); // legacy key
    expect(k("id: a\nanalyze:\n  issue: 7")).toBe("investigate"); // legacy key
    const both = extractDrafts(
      fence("id: a\naudit:\n  issue: 3\nassess:\n  issue: 9", "# A"),
      ctx,
    )[0]!;
    expect(both.commandArgs).toEqual(["audit", "acme/api#3"]); // canonical wins
    expect(both.files[0]!.frontmatter.assess).toBeUndefined(); // the losing legacy key is dropped
    expect(both.files[0]!.droppedKeys).toEqual(["assess"]);
  });

  it("a junco-patch fence at the same backtick count as its outer ticket fence is flagged, not silently classified as apply", () => {
    const [d] = extractDrafts(
      fence("id: a", "# T\n\n```junco-patch\nFrom 0 Mon Sep 17 00:00:00 2001\n```"),
      ctx,
    );
    expect(d!.kind).toBe("ticket");
    expect(d!.problems).toEqual([
      "junco-patch fence is not closed — use more backticks for the outer junco-ticket fence",
    ]);
  });

  it("audit/investigate derive commandArgs at extraction; a missing issue is a problem", () => {
    const a = extractDrafts(fence("id: a\naudit:\n  auto_plan: true\n  issue: 12", "# A"), ctx)[0]!;
    expect(a.commandArgs).toEqual(["audit", "acme/api#12", "--auto-plan"]);
    const a2 = extractDrafts(fence("id: a\naudit: {}", "# A"), { ...ctx, nwo: null })[0]!;
    expect(a2.commandArgs).toEqual(["audit", "/repo/acme-api"]);
    const z = extractDrafts(fence("id: z\ninvestigate:\n  issue: 7", "# Z"), ctx)[0]!;
    expect(z.commandArgs).toEqual(["investigate", "acme/api#7"]);
    const bad = extractDrafts(fence("id: z\ninvestigate: {}", "# Z"), ctx)[0]!;
    expect(bad.commandArgs).toBeNull();
    expect(bad.problems).toEqual(["investigate.issue is required"]);
    const local = extractDrafts(fence("id: z\ninvestigate:\n  issue: 7", "# Z"), {
      ...ctx,
      nwo: null,
    })[0]!;
    expect(local.problems).toEqual(["investigate needs a watched owner/repo"]);
  });

  it("two or more junco-ticket fences → one ticketSet; every file needs an id; unknown depends_on is a problem", () => {
    const text = [
      fence("id: api\n", "# API"),
      fence("id: ui\ndepends_on: [api, ghost]", "# UI"),
    ].join("\n\n");
    const [d] = extractDrafts(text, ctx);
    expect(d!.kind).toBe("ticketSet");
    expect(d!.files.map((f) => f.name)).toEqual(["api.md", "ui.md"]);
    expect(d!.problems).toEqual(["ui: depends_on names no sibling: ghost"]);
    const noId = extractDrafts(
      [fence("id: a", "# A"), fence("pr_title: b", "# B")].join("\n"),
      ctx,
    )[0]!;
    expect(noId.problems).toEqual(["every ticket in a set needs an explicit id (file 2 has none)"]);
  });

  it("two fences with the SAME id collapse to the last one, with a problem naming it (R35)", () => {
    // slugifyId maps both onto one file, so a set of two would list two ids
    // in the JSON and submit the same file twice.
    const text = [
      fence("id: add-cache", "# Add cache\n\nfirst attempt"),
      fence("id: add-cache", "# Add cache\n\ncorrected"),
    ].join("\n\n");
    const [d] = extractDrafts(text, ctx);
    expect(d!.kind).toBe("ticket"); // one file left → not a set
    expect(d!.files).toHaveLength(1);
    expect(d!.files[0]!.body).toContain("corrected");
    expect(d!.files[0]!.body).not.toContain("first attempt");
    expect(d!.problems).toEqual(["duplicate id add-cache: kept the last fence"]);
  });

  it("a duplicate inside a genuine set keeps the set and drops only the superseded fence", () => {
    const text = [
      fence("id: api", "# API v1"),
      fence("id: ui\ndepends_on: [api]", "# UI"),
      fence("id: api", "# API v2"),
    ].join("\n\n");
    const [d] = extractDrafts(text, ctx);
    expect(d!.kind).toBe("ticketSet");
    expect(d!.files.map((f) => f.name)).toEqual(["ui.md", "api.md"]);
    expect(d!.files.find((f) => f.id === "api")!.body).toContain("API v2");
    expect(d!.problems).toEqual(["duplicate id api: kept the last fence"]);
  });

  it("a fence without frontmatter gets a generated id from the H1", () => {
    const [d] = extractDrafts("```junco-ticket\n# Fix the flaky test\n\nbody\n```", ctx);
    expect(d!.files[0]!.id).toBe("fix-the-flaky-test");
    expect(d!.files[0]!.frontmatter).toEqual({
      id: "fix-the-flaky-test",
      repo: "/repo/acme-api",
    });
  });

  it("junco-plan → planSet (blocked when plan sets are off); both fence kinds in one message → two drafts", () => {
    const plan = "```junco-plan\nversion: 1\ntasks:\n  - id: a\n    title: A\n```";
    const on = extractDrafts(plan, ctx);
    expect(on).toHaveLength(1);
    expect(on[0]!.kind).toBe("planSet");
    expect(on[0]!.blocked).toBeNull();
    expect(on[0]!.files[0]!.name).toBe("plan.md");
    const off = extractDrafts(plan, { ...ctx, planSetsEnabled: false });
    expect(off[0]!.blocked).toBe("plan_sets_disabled");
    const both = extractDrafts(plan + "\n" + fence("id: t", "# T"), ctx);
    expect(both.map((d) => d.kind).sort()).toEqual(["planSet", "ticket"]);
  });

  it("invalid YAML frontmatter is a problem, not a throw", () => {
    const [d] = extractDrafts("```junco-ticket\n---\nid: [unclosed\n---\n# T\n```", ctx);
    expect(d!.problems[0]).toMatch(/frontmatter/);
  });
});
