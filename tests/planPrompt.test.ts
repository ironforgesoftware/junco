import { describe, it, expect } from "vitest";
import { loadDispatchTemplate, buildPlannerPrompt, PLAN_FENCE } from "../src/planPrompt.js";

describe("loadDispatchTemplate", () => {
  it("loads the real shipped template (single source with the skill)", () => {
    const t = loadDispatchTemplate();
    expect(t).toContain("# Junco ticket template");
    expect(t).toContain("## Steps");
    expect(t).toContain("## Verification");
  });
});

describe("buildPlannerPrompt", () => {
  const opts = {
    title: "Add rate limiting",
    body: "Uploads hammer the API.",
    nwo: "acme/api",
    parent: null,
  };

  it("contains the fence instruction, the template, and the issue", () => {
    const p = buildPlannerPrompt(opts);
    expect(p).toContain("````" + PLAN_FENCE);
    expect(p).toContain("# Junco ticket template");
    expect(p).toContain("Add rate limiting");
    expect(p).toContain("Uploads hammer the API.");
    expect(p).toContain("acme/api");
    expect(p).toContain("Do NOT include a frontmatter block");
  });

  it("appends parent context when present", () => {
    const p = buildPlannerPrompt({
      ...opts,
      parent: { title: "Perf umbrella", body: "Track all perf work." },
    });
    expect(p).toContain("Parent issue (background only)");
    expect(p).toContain("Perf umbrella");
  });

  it("handles an empty issue body", () => {
    const p = buildPlannerPrompt({ ...opts, body: "" });
    expect(p).toContain("_(the issue has no body — plan from the title and the repo)_");
  });
});
