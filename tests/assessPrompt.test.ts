import { describe, it, expect } from "vitest";
import { buildAssessPrompt } from "../src/assessPrompt.js";
import { FINDINGS_FENCE } from "../src/findings.js";

describe("buildAssessPrompt", () => {
  it("mentions the fence tag exactly once (the output contract instruction)", () => {
    const prompt = buildAssessPrompt({ nwo: null, repoPath: "/repo" });
    const occurrences = prompt.split(FINDINGS_FENCE).length - 1;
    expect(occurrences).toBe(1);
  });

  it("enumerates every finding schema field name", () => {
    const prompt = buildAssessPrompt({ nwo: null, repoPath: "/repo" });
    for (const field of [
      "kind",
      "severity",
      "ruleId",
      "title",
      "description",
      "evidence",
      "remediation",
      "references",
      "location",
      "path",
      "line",
    ]) {
      expect(prompt, `missing field '${field}'`).toContain(field);
    }
  });

  it("says the audit is read-only", () => {
    const prompt = buildAssessPrompt({ nwo: null, repoPath: "/repo" });
    expect(prompt).toMatch(/read-only/i);
  });

  it("includes the nwo when given, for context", () => {
    const prompt = buildAssessPrompt({ nwo: "acme/api", repoPath: "/repo" });
    expect(prompt).toContain("acme/api");
  });

  it("omits any nwo mention when null", () => {
    const withNwo = buildAssessPrompt({ nwo: "acme/api", repoPath: "/repo" });
    const withoutNwo = buildAssessPrompt({ nwo: null, repoPath: "/repo" });
    expect(withoutNwo).not.toContain("acme/api");
    expect(withoutNwo.length).toBeGreaterThan(0);
    expect(withNwo).not.toBe(withoutNwo);
  });

  it("is stack-agnostic: no engine/server/model names", () => {
    const prompt = buildAssessPrompt({ nwo: "acme/api", repoPath: "/repo" });
    expect(prompt).not.toMatch(/omp|omlx|\bpi\b|launchd|qwen/i);
  });
});
