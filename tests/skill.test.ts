import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The junco-dispatch skill ships in the npm package (package.json `files`
// allowlist). It is agent-facing prose with no code coupling, so nothing else
// guards it — these checks keep the shipped surface honest.
const SKILL = readFileSync(new URL("../skills/junco-dispatch/SKILL.md", import.meta.url), "utf8");

describe("junco-dispatch SKILL.md", () => {
  it("exposes the assess trigger so a harness can route audit requests", () => {
    // The frontmatter `description` is what the harness matches on for skill
    // selection; the body must carry the mode and its trigger phrases.
    expect(SKILL).toContain("## Assess mode");
    expect(SKILL).toContain("junco assess");
    expect(SKILL).toContain("assess this repo");
    expect(SKILL).toContain("have junco audit this repo");
  });

  it("stays self-contained: no delegation to docs/ (not in the npm package)", () => {
    // `docs/` is excluded from the `files` allowlist, so an installed package
    // has no docs/assess.md — the skill must inline what it needs.
    expect(SKILL).not.toContain("docs/assess");
  });

  it("is stack-agnostic: no engine/server/model names", () => {
    // Word-bounded so prose like "compose"/"prompt"/"decompose" doesn't
    // false-match the bare "omp" the assessPrompt test can rely on being absent.
    expect(SKILL).not.toMatch(/\b(omp|omlx|launchd|vault|pi|qwen|openai|gpt|ollama|llama|mlx)\b/i);
  });
});
