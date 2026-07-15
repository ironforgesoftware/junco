import { describe, it, expect } from "vitest";
import { BIRD, GREETINGS, TIPS, NEXT_STEPS, pickGreeting } from "../src/wizard/tips.js";

describe("wizard copy registry", () => {
  it("has a greeting pool and deterministic picker", () => {
    expect(GREETINGS.length).toBeGreaterThanOrEqual(3);
    expect(pickGreeting(0)).toBe(GREETINGS[0]);
    expect(pickGreeting(GREETINGS.length + 1)).toBe(GREETINGS[1]);
  });

  it("has a tip for every chapter key", () => {
    for (const k of [
      "welcome",
      "workspace",
      "model",
      "repoSafety",
      "githubOff",
      "githubOn",
      "githubApproval",
      "account",
      "extras",
      "review",
      "signoff",
    ] as const) {
      expect(TIPS[k].length).toBeGreaterThan(10);
    }
    expect(BIRD).toBe("🐦");
  });

  it("next steps name real subcommands", () => {
    const cmds = NEXT_STEPS.map((s) => s.cmd);
    expect(cmds.some((c) => c.includes("junco start"))).toBe(true);
    expect(cmds.some((c) => c.includes("junco submit"))).toBe(true);
    expect(cmds.some((c) => c.includes("junco config list"))).toBe(true);
  });

  it("all copy is stack-agnostic (packaging rule)", () => {
    const all = [...GREETINGS, ...Object.values(TIPS), ...NEXT_STEPS.map((s) => s.cmd + s.blurb)]
      .join(" ")
      .toLowerCase();
    for (const banned of [
      /\bomp\b/,
      /\bomlx\b/,
      /lm studio/,
      /\bollama\b/,
      /\blaunchd\b/,
      /\bedelweiss\b/,
    ]) {
      expect(all).not.toMatch(banned);
    }
    // the endpoint is always described generically
    expect(Object.values(TIPS).join(" ")).toContain("inference endpoint");
  });
});
