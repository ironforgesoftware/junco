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
    // Step 2b: a clean dry-run already includes the lint results (Task 3
    // dispatch-slimming) — lint is a separate call only to re-validate after
    // a dry-run/preview surfaces an [error].
    expect(SKILL).toContain("junco lint <tempfile>");
    expect(SKILL).toMatch(/do not run lint separately after a clean dry-run/);
    // The old "two config gets + a raw git probe" contract is gone.
    expect(SKILL).not.toContain("junco config get github.enabled");
    expect(SKILL).not.toContain("junco config get botAccount.enabled");
    expect(SKILL).not.toContain("gh repo view");
    // The old "only on an explicit phrase" rule is gone.
    expect(SKILL).not.toContain("Otherwise stay on the inbox default without asking");
  });

  it("teaches apply mode: emit a patch when the exact bytes are already known", () => {
    // The mode question — pinned in both the drafting-procedure callout and
    // the Apply mode section itself (Task 6).
    expect(SKILL).toContain("## Apply mode (patch tickets)");
    expect(SKILL).toMatch(/did I resolve every unknown — do I know the exact bytes\?/);
    expect(SKILL).toMatch(/Forcing certainty you do not have is the failure mode to avoid/);
    // How to produce the series: the exact command, and the fence-length rule
    // with its reason (not just the word "fence").
    expect(SKILL).toContain("git format-patch <base>..HEAD --stdout");
    expect(SKILL).toContain("junco-patch");
    expect(SKILL).toMatch(
      /fence LONGER than any backtick run[^\n]*close your fence early and silently truncate the series/,
    );
    // The ergonomic door from Task 5, described as an alternative to
    // hand-authoring the fence — not the only way in.
    expect(SKILL).toContain(
      "junco submit --patch <file> --repo <path> [--title T] [--why W] [--verify CMD]",
    );
    // When NOT to use apply mode — the specific exclusions, not just the
    // heading (guards meaning: a rewrite that drops one of these still fails).
    expect(SKILL).toMatch(/test-fix loop or judgment calls at execute time/);
    expect(SKILL).toMatch(/change depends on files you have not read/);
    expect(SKILL).toMatch(/issue may sit parked long enough for the tree to move/);
    expect(SKILL).toMatch(
      /Amend tickets \(`amends_pr`\), plan-set children, and Q&A tickets \(no `repo:`\) are unsupported combinations/,
    );
    // The fallback changes the byte-identical guarantee — this is the reason
    // apply mode isn't a free lunch.
    expect(SKILL).toContain("worker.applyFallbackToAgent");
    expect(SKILL).toMatch(/no longer byte-identical to the patch/);
    // What the reviewer sees.
    expect(SKILL).toMatch(/parked issue or ticket shows the exact diff before anything runs/);

    // TEMPLATE.md gains the matching minimal apply-ticket shape.
    const TEMPLATE = readFileSync(
      new URL("../skills/junco-dispatch/TEMPLATE.md", import.meta.url),
      "utf8",
    );
    expect(TEMPLATE).toContain("## Apply mode (patch tickets)");
    expect(TEMPLATE).toContain("```junco-patch");
    expect(TEMPLATE).toMatch(/Do not combine with `amends_pr`, plan-set membership/);
  });

  it("drops the authored boilerplate the CLI and worker now own (Task 3 dispatch-slimming)", () => {
    // No more per-ticket timestamp ritual — nothing reads `created:`.
    expect(SKILL).not.toContain("created:");
    // A clean dry-run already carries the lint verdict.
    expect(SKILL).toContain("A clean dry-run IS the lint gate");
    // Plans no longer author their own anti-loop Notes section — the worker's
    // prompt preamble injects the discipline for every run.
    expect(SKILL).toContain('Do NOT author a "Notes for the agent" section');
    // The preview and the monitor ask are folded into one AskUserQuestion call.
    expect(SKILL).toContain("Monitor the ticket?");

    // TEMPLATE.md ships the same cuts — mirror the SKILL loading pattern.
    const TEMPLATE = readFileSync(
      new URL("../skills/junco-dispatch/TEMPLATE.md", import.meta.url),
      "utf8",
    );
    expect(TEMPLATE).not.toContain("copy this section verbatim");
    expect(TEMPLATE).not.toContain("created:");
  });
});
