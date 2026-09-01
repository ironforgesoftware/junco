import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTicket } from "../src/ticket.js";
import { lintTicket } from "../src/planLint.js";
import { extractPatchBody, extractPlanSetBody } from "../src/githubInbox.js";
import { parsePlanSet, compilePlan } from "../src/planCompiler.js";
import { LEVERS, getAtPath } from "../src/configLevers.js";
import { assembleConfig, configDeprecations, parseConfigFile } from "../src/config.js";

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

// Keys a config template sets to show a shape rather than to restate a default:
// the endpoint identity and a hosted-endpoint spend cap. Every other key it
// states must equal the schema default, so the template can't drift from the
// code again (#377). `dataDir`/`baseUrl`/`apiKey` need no entry — their lever
// default is `undefined`, which the drift check already skips.
const ILLUSTRATIVE = ["model.id", "model.compat", "worker.dailyBudgetUsd"];

function leaves(obj: unknown, prefix = ""): Array<[string, unknown]> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return [[prefix, obj]];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix === "" ? k : `${prefix}.${k}`),
  );
}

describe.each(["examples/config.json", "examples/config.hosted.json"])("%s", (rel) => {
  const raw = JSON.parse(read(rel)) as Record<string, unknown>;

  it("leads with dataDir and sets no deprecated queue-root key", () => {
    expect(Object.keys(raw)[0]).toBe("dataDir");
    expect(raw).not.toHaveProperty("vaultRoot");
    expect(raw).not.toHaveProperty("juncoSubdir");
  });

  it("loads through the config loader and resolves with no deprecation warning", () => {
    const parsed = parseConfigFile(fileURLToPath(new URL(`../${rel}`, import.meta.url)));
    const cfg = assembleConfig(parsed, { HOME: "/h" }, { existsFn: () => false });
    expect(configDeprecations(cfg)).toEqual([]);
    expect(cfg.queueRoot).toBe(join(cfg.dataDir, "queue"));
  });

  it("names every post-0.9 section", () => {
    const sections = [
      "updateCheck",
      "worker.applyFallbackToAgent",
      "github",
      "botAccount",
      "planSets",
      "skills",
    ];
    for (const path of sections) expect(getAtPath(raw, path), path).toBeDefined();
  });

  it("states only known levers, each at its schema default (illustrative values aside)", () => {
    for (const [path, value] of leaves(raw)) {
      const lever = LEVERS.find((l) => l.path === path || path.startsWith(`${l.path}.`));
      expect(lever, `${path} is not a config lever`).toBeDefined();
      if (lever === undefined || ILLUSTRATIVE.includes(lever.path)) continue;
      if (lever.default === undefined) continue;
      expect(value, path).toEqual(lever.default);
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
