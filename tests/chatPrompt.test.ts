import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChatPrompt, CHAT_SKILL_SECTIONS, loadSkillSections } from "../src/chat/chatPrompt.js";
import { FRONTMATTER_ALLOWLIST } from "../src/chat/fenceExtract.js";
import { PACKAGE_ROOT } from "../src/packageRoot.js";

const SKILL_PATH = join(PACKAGE_ROOT, "skills", "junco-dispatch", "SKILL.md");

describe("chat prompt (spec 2026-09-01 §6.5)", () => {
  it("every lifted SKILL.md heading exists in the packaged skill (drift guard)", () => {
    expect(() => loadSkillSections(CHAT_SKILL_SECTIONS)).not.toThrow();
    const text = loadSkillSections(CHAT_SKILL_SECTIONS);
    for (const s of CHAT_SKILL_SECTIONS) expect(text).toContain(`## ${s.h3 ?? s.h2}`);
  });
  it("a renamed heading fails loud", () => {
    expect(() => loadSkillSections([{ h2: "Ticket sets (renamed)" }])).toThrow(/heading/);
  });
  it("a subsection spec returns only that ### block", () => {
    const only = loadSkillSections([
      { h2: "Audit mode (sweep a repo → review → file)", h3: "Inputs to gather" },
    ]);
    expect(only).toContain("### Inputs to gather");
    expect(only).not.toContain("### Preconditions");
  });
  it("carries the template, the fence contract, the allowlist, and the repo rule", () => {
    const p = buildChatPrompt({ cwd: "/repo", nwo: "acme/api", planSetsEnabled: false });
    expect(p).toContain("--- TICKET TEMPLATE");
    expect(p).toContain("```junco-ticket");
    for (const k of FRONTMATTER_ALLOWLIST) expect(p).toContain(`\`${k}\``);
    expect(p).toMatch(/`repo:` is set by junco/);
    expect(p).toContain("acme/api");
    expect(p).not.toContain("```junco-plan");
    expect(p).toMatch(/never claim/i);
  });
  it("tells the model HOW a parked draft is submitted, so it points the operator at the card", () => {
    // Without this the model invents a workflow ("copy the fence into a file
    // and run junco submit") for a draft the dashboard already holds.
    const p = buildChatPrompt({ cwd: "/repo", nwo: "acme/api", planSetsEnabled: false });
    expect(p).toMatch(/draft card[\s\S]*`s` submits/);
    expect(p).toMatch(/never tell them to copy/i);
  });
  it("teaches the junco-plan fence only when plan sets are on; a local session names its path", () => {
    const on = buildChatPrompt({ cwd: "/repo", nwo: null, planSetsEnabled: true });
    expect(on).toContain("```junco-plan");
    expect(on).toContain("/repo");
  });
  it("fails loud, rather than silently no-op-ing, if the Ticket sets section's junco-plan example drifts out from under the strip (plan sets off)", () => {
    const real = readFileSync(SKILL_PATH, "utf8");
    // Sanity: the fixture this test mutates actually has what we're about to
    // break — otherwise the assertion below would pass for the wrong reason.
    expect(real).toContain("```junco-plan\n");
    const drifted = real.replace("```junco-plan\n", "```junco-plan-renamed\n");
    expect(() =>
      buildChatPrompt(
        { cwd: "/repo", nwo: "acme/api", planSetsEnabled: false },
        { readFileFn: () => drifted },
      ),
    ).toThrow(/junco-plan/);
  });
  it("planner prompt pieces are reused, not duplicated", async () => {
    const { planSetRuleText, loadExample } = await import("../src/planPrompt.js");
    expect(planSetRuleText()).toContain("junco-plan");
    expect(typeof loadExample()).toBe("string");
  });
});
