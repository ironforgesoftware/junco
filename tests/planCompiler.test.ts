import { describe, it, expect } from "vitest";
import { parsePlanSet, hashPlan } from "../src/planCompiler.js";

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
