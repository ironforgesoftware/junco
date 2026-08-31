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
    // The route probe is a CLI contract — pin the exact command the skill runs
    // (Task 3/4: the CLI decides the destination itself; no more config-get
    // pair plus a raw git probe reimplemented in prose).
    expect(SKILL).toContain("junco submit --dry-run <tempfile>");
    expect(SKILL).toContain("destination: issue");
    expect(SKILL).toContain("destination: inbox");
    expect(SKILL).toContain("junco submit --as-issue");
    // The opt-out trigger and phrase.
    expect(SKILL).toContain("junco-local:");
    expect(SKILL).toContain("to the inbox");
    expect(SKILL).toContain('"junco-local: <brief>"'); // listed as a trigger, not only as a rule
    // Overrides, in priority order: junco-local forces the inbox regardless of
    // the verdict; an as-issue phrase forces the issue destination.
    expect(SKILL).toMatch(
      /a `junco-local:` trigger[^\n]*forces the inbox regardless of the verdict/,
    );
    expect(SKILL).toMatch(/"park it on github"[^\n]*forces the issue destination/);
    // Step 2b: the plan-lint gate runs before the preview, independent of the probe.
    expect(SKILL).toContain("junco lint <tempfile>");
    expect(SKILL).toMatch(/Fix every `\[error\]`[^\n]*before showing the preview/);
    // The old "two config gets + a raw git probe" contract is gone.
    expect(SKILL).not.toContain("junco config get github.enabled");
    expect(SKILL).not.toContain("junco config get botAccount.enabled");
    expect(SKILL).not.toContain("gh repo view");
    // The old "only on an explicit phrase" rule is gone.
    expect(SKILL).not.toContain("Otherwise stay on the inbox default without asking");
  });
});
