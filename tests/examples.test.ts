import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseTicket } from "../src/ticket.js";
import { lintTicket } from "../src/planLint.js";
import { extractPatchBody, extractPlanSetBody } from "../src/githubInbox.js";
import { parsePlanSet, compilePlan } from "../src/planCompiler.js";
import { LEVERS } from "../src/configLevers.js";

// `examples/` ships in the npm package (package.json `files` allowlist) and
// `docs/` is what people copy from. Neither has code coupling, so nothing else
// keeps a shipped example or a documented fence valid against the parser that
// consumes it — these checks do.
const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const maxTasksLever = LEVERS.find((l) => l.path === "planSets.maxTasks");
const maxTasks =
  maxTasksLever !== undefined && typeof maxTasksLever.default === "number"
    ? maxTasksLever.default
    : NaN;

describe("examples/apply-ticket.md", () => {
  const raw = read("examples/apply-ticket.md");
  const ticket = parseTicket("apply-ticket.md", raw);

  it("is a PR-flow ticket whose body carries a junco-patch fence", () => {
    expect(typeof ticket.frontmatter.repo).toBe("string");
    expect(extractPatchBody(ticket.body)).not.toBeNull();
  });

  it("passes plan-lint with no violations at all (warnings included)", () => {
    const res = lintTicket(ticket.body, ticket.frontmatter, { checkLabels: false });
    expect(res.violations).toEqual([]);
  });
});

describe("examples/plan-set.md", () => {
  const raw = read("examples/plan-set.md");

  it("is a plan document, not a ticket: no frontmatter (submit --plan ignores it)", () => {
    expect(parseTicket("plan-set.md", raw).frontmatter).toEqual({});
  });

  it("carries a junco-plan fence the compiler accepts under the default maxTasks", () => {
    expect(Number.isFinite(maxTasks)).toBe(true);
    const fence = extractPlanSetBody(raw);
    expect(fence).not.toBeNull();
    expect(parsePlanSet(fence as string, { maxTasks })).toMatchObject({ ok: true });
  });

  it("compiles into lint-clean child tickets with at least one dependency edge", () => {
    const parsed = parsePlanSet(extractPlanSetBody(raw) as string, { maxTasks });
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const children = compilePlan(parsed.plan, {
      planId: "plan-plan-set",
      repoPath: "/repo",
      hash: "0123456789ab",
      github: null,
    });
    expect(children.length).toBeGreaterThan(1);
    expect(children.some((c) => c.dependsOn.length > 0)).toBe(true);
    for (const child of children) {
      const t = parseTicket(`${child.ticketId}.md`, child.content);
      expect(lintTicket(t.body, t.frontmatter, { checkLabels: false }).violations).toEqual([]);
    }
  });
});

describe("docs", () => {
  it("docs/tickets.md documents the junco-plan fence with an example the compiler accepts", () => {
    const doc = read("docs/tickets.md");
    expect(doc).toMatch(/^## Plan sets/m);
    const fence = extractPlanSetBody(doc);
    expect(fence).not.toBeNull();
    expect(parsePlanSet(fence as string, { maxTasks })).toMatchObject({ ok: true });
  });

  it("docs/configuration.md has a Plan sets section naming every planSets.* lever", () => {
    const doc = read("docs/configuration.md");
    expect(doc).toMatch(/^## Plan sets/m);
    for (const lever of LEVERS.filter((l) => l.path.startsWith("planSets."))) {
      expect(doc).toContain(`\`${lever.path}\``);
    }
    // The "Minimal example" section enumeration lists every sectioned object.
    for (const section of ["`planSets`", "`skills`", "`botAccount`"]) {
      expect(doc).toContain(section);
    }
  });
});
