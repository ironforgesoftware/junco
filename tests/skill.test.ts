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

  it("auto-routes to the parked-issue destination when the repo is bridge-watched", () => {
    // The route probe is a CLI contract — pin the exact commands the skill runs.
    expect(SKILL).toContain("junco config get github.enabled");
    expect(SKILL).toContain("junco config get botAccount.enabled");
    expect(SKILL).toContain("junco submit --as-issue");
    // The opt-out trigger and phrase.
    expect(SKILL).toContain("junco-local:");
    expect(SKILL).toContain("to the inbox");
    expect(SKILL).toContain('"junco-local: <brief>"'); // listed as a trigger, not only as a rule
    // The old "only on an explicit phrase" rule is gone.
    expect(SKILL).not.toContain("Otherwise stay on the inbox default without asking");
    // The probe mirrors the CLI's own predicate (origin remote), never gh repo view <path>.
    expect(SKILL).toContain("git -C <repo-path> remote get-url origin");
    expect(SKILL).not.toContain("gh repo view");
    // Amend tickets and hand-authored sets never auto-route: the issue route discards their keys.
    expect(SKILL).toMatch(
      /carries `amends_pr`[^\n]*`depends_on`[^\n]*always goes to the \*\*inbox\*\*/,
    );
  });
});
