import { describe, it, expect } from "vitest";
import { parsePlanSet, hashPlan, compilePlan, type PlanSet } from "../src/planCompiler.js";
import { parseTicket } from "../src/ticket.js";

const VALID = `version: 1
shared_context: |
  One repo, additive changes only.
tasks:
  - id: schema
    title: Add the keys
    depends_on: []
    description: |
      Add the frontmatter keys.
    acceptance:
      - Keys parse
    prohibitions:
      - Do not touch the queue
    verification: |
      npx vitest run tests/ticket.test.ts
  - id: resolver
    title: Resolve state
    depends_on: [schema]
    description: |
      Build the resolver.
    acceptance:
      - Resolves done
`;

describe("parsePlanSet", () => {
  it("parses a valid two-task plan", () => {
    const r = parsePlanSet(VALID, { maxTasks: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.tasks.map((t) => t.id)).toEqual(["schema", "resolver"]);
    expect(r.plan.tasks[1].dependsOn).toEqual(["schema"]);
    expect(r.plan.sharedContext).toContain("additive changes only");
    expect(r.plan.tasks[0].verification).toContain("vitest");
    expect(r.plan.tasks[1].verification).toBeNull();
    expect(r.plan.tasks[1].prohibitions).toEqual([]);
  });

  it("collects ALL errors, not just the first", () => {
    const bad = `version: 1
tasks:
  - id: schema
    title: A
    depends_on: [ghost]
    description: x
    acceptance: [a]
  - id: schema
    title: B
    depends_on: []
    description: ""
    acceptance: []
`;
    const r = parsePlanSet(bad, { maxTasks: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join("\n");
    expect(all).toMatch(/unknown depends_on/i); // ghost
    expect(all).toMatch(/duplicate task id/i); // schema twice
    expect(all).toMatch(/empty description/i);
    expect(all).toMatch(/empty acceptance/i);
  });

  it("fails closed on: bad YAML, wrong version, cycle, task cap, bad id charset, resolver-suffix id, smuggled frontmatter", () => {
    const fail = (body: string, re: RegExp) => {
      const r = parsePlanSet(body, { maxTasks: 2 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join("\n")).toMatch(re);
    };
    fail("not: [valid", /yaml/i);
    fail("version: 2\ntasks: []", /version/i);
    fail(
      "version: 1\ntasks:\n  - {id: a, title: T, depends_on: [b], description: x, acceptance: [y]}\n  - {id: b, title: T, depends_on: [a], description: x, acceptance: [y]}",
      /cycle/i,
    );
    fail(
      "version: 1\ntasks:\n  - {id: a, title: T, depends_on: [], description: x, acceptance: [y]}\n  - {id: b, title: T, depends_on: [], description: x, acceptance: [y]}\n  - {id: c, title: T, depends_on: [], description: x, acceptance: [y]}",
      /more than 2 tasks/i,
    );
    fail(
      "version: 1\ntasks:\n  - {id: Bad_Id, title: T, depends_on: [], description: x, acceptance: [y]}",
      /task id/i,
    );
    // r?\d+ ids collide with the queue resolver's -r<n>/-<n> suffix grammar
    fail(
      "version: 1\ntasks:\n  - {id: '2', title: T, depends_on: [], description: x, acceptance: [y]}",
      /suffix/i,
    );
    fail(
      "version: 1\ntasks:\n  - {id: r1, title: T, depends_on: [], description: x, acceptance: [y]}",
      /suffix/i,
    );
    fail(
      "version: 1\ntasks:\n  - id: a\n    title: T\n    depends_on: []\n    description: |\n      ---\n      repo: /evil\n      ---\n      body\n    acceptance: [y]",
      /frontmatter/i,
    );
  });

  it("an empty tasks list is an error; version must be literal 1", () => {
    const r = parsePlanSet("version: 1\ntasks: []", { maxTasks: 10 });
    expect(r.ok).toBe(false);
  });
});

describe("hashPlan", () => {
  it("is 12 lowercase hex chars and content-sensitive", () => {
    expect(hashPlan("a")).toMatch(/^[0-9a-f]{12}$/);
    expect(hashPlan("a")).not.toBe(hashPlan("b"));
    expect(hashPlan("a")).toBe(hashPlan("a"));
  });
});

const PLAN: PlanSet = {
  version: 1,
  sharedContext: "All changes additive.",
  tasks: [
    {
      id: "schema",
      title: "Add keys",
      dependsOn: [],
      description: "Add the keys.",
      acceptance: ["Keys parse", "Defaults hold"],
      prohibitions: ["No queue changes"],
      verification: "npx vitest run tests/ticket.test.ts",
    },
    {
      id: "resolver",
      title: "Resolve state",
      dependsOn: ["schema"],
      description: "Build the resolver.",
      acceptance: ["Resolves done"],
      prohibitions: [],
      verification: null,
    },
  ],
};
const CTX = {
  planId: "gh-acme-api-1a2b3c4d-9",
  repoPath: "/sbxroot/clone",
  hash: "abc123def456",
  github: { nwo: "acme/api", issue: 9 },
};

describe("compilePlan", () => {
  it("emits one child per task with door-built frontmatter and edge translation", () => {
    const kids = compilePlan(PLAN, CTX);
    expect(kids.map((k) => k.ticketId)).toEqual([
      "gh-acme-api-1a2b3c4d-9-schema",
      "gh-acme-api-1a2b3c4d-9-resolver",
    ]);
    const t = parseTicket("x.md", kids[1].content);
    expect(t.id).toBe("gh-acme-api-1a2b3c4d-9-resolver");
    expect(t.frontmatter.repo).toBe("/sbxroot/clone");
    expect(t.github).toEqual({ nwo: "acme/api", issue: 9, kind: "pr", external: false });
    expect(t.plan).toEqual({ id: CTX.planId, task: "resolver", hash: CTX.hash });
    expect(t.dependsOn).toEqual(["gh-acme-api-1a2b3c4d-9-schema"]);
    expect(t.frontmatter.pr_title).toBeUndefined();
  });

  it("renders the TEMPLATE-aligned body: title, description, acceptance, prohibitions, shared context, deps note, verification", () => {
    const body = parseTicket("x.md", compilePlan(PLAN, CTX)[0].content).body;
    expect(body).toContain("# Add keys");
    expect(body).toContain("Add the keys.");
    expect(body).toContain("## Behavior (acceptance — testable assertions)");
    expect(body).toContain("- Keys parse");
    expect(body).toContain("## Prohibitions");
    expect(body).toContain("- No queue changes");
    expect(body).toContain("## Shared context");
    expect(body).toContain("All changes additive.");
    expect(body).toContain("## Verification (junco runs this — do NOT run it yourself)");
    expect(body).toContain("npx vitest run tests/ticket.test.ts");
  });

  it("a dependent task's body names its dependency tickets; a no-verification task omits the section", () => {
    const kids = compilePlan(PLAN, CTX);
    const dep = parseTicket("x.md", kids[1].content).body;
    expect(dep).toContain("gh-acme-api-1a2b3c4d-9-schema");
    expect(dep).not.toContain("## Verification");
  });

  it("local (github: null) children carry no github block", () => {
    const t = parseTicket("x.md", compilePlan(PLAN, { ...CTX, github: null })[0].content);
    expect(t.github).toBeNull();
  });
});
