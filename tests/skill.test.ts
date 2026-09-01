import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The junco-dispatch skill ships in the npm package (package.json `files`
// allowlist). It is agent-facing prose with no code coupling, so nothing else
// guards it — these checks keep the shipped surface honest.
const SKILL = readFileSync(new URL("../skills/junco-dispatch/SKILL.md", import.meta.url), "utf8");

describe("junco-dispatch SKILL.md", () => {
  it("exposes the audit trigger so a harness can route audit requests", () => {
    // The frontmatter `description` is what the harness matches on for skill
    // selection; the body must carry the mode and its trigger phrases. The
    // natural-language phrase "assess this repo" survives on purpose (Task
    // 4: people still ask for this with the old word) but the command run
    // is the renamed verb.
    expect(SKILL).toContain("## Audit mode");
    expect(SKILL).toContain("junco audit");
    expect(SKILL).toContain("assess this repo");
    expect(SKILL).toContain("audit this repo");
    expect(SKILL).toContain("have junco audit this repo");
    // The old verb is retired with no alias (Task 2) — the skill must never
    // tell an agent to run it.
    expect(SKILL).not.toContain("junco assess");
  });

  it("exposes the investigate trigger so a harness can route investigate requests", () => {
    expect(SKILL).toContain("## Investigate mode");
    expect(SKILL).toContain("junco investigate");
    expect(SKILL).toContain("analyze issue #N");
    expect(SKILL).toContain("investigate issue #N");
    expect(SKILL).not.toContain("junco analyze");
  });

  it("states the audit/investigate trigger-vs-command mismatch explicitly, so it reads as deliberate", () => {
    expect(SKILL).toMatch(
      /trigger phrases keep the old words on purpose[^\n]*commands this skill actually runs are the renamed CLI verbs/,
    );
  });

  it("distinguishes audit (repo sweep -> issues) from investigate (one issue -> comment)", () => {
    // Introduced where both modes are first named together, not buried in
    // either mode's own section.
    expect(SKILL).toMatch(/audit sweeps a \*\*repo\*\* and produces findings that become issues/);
    expect(SKILL).toMatch(/investigate reads \*\*one\*\* issue and produces a comment/);
    expect(SKILL).toMatch(/Audit generates backlog; investigate deepens one item/);
  });

  it("distinguishes the skill's own dispatch act from the CLI's separate `junco import` verb", () => {
    // The skill's name and "dispatch to junco"/"send to junco" triggers do
    // NOT change — they name authoring+sending new work, distinct from
    // `junco import` pulling an existing issue into the queue.
    expect(SKILL).toMatch(
      /distinct from `junco import <owner\/repo#N>`, the CLI's separate verb for pulling an \*\*existing\*\* GitHub issue/,
    );
  });

  it("decomposes ticket sets on seams in the work, not on a clock", () => {
    // The four seam triggers from the plan replace the old "180 min ->
    // decompose" clock rule.
    expect(SKILL).toMatch(
      /\*\*Independent reviewability\*\* — a reviewer could accept one part and reject another/,
    );
    expect(SKILL).toMatch(
      /\*\*Ordering dependency\*\* — one part must land before another can be written against it/,
    );
    expect(SKILL).toMatch(
      /\*\*Separate verification\*\* — the parts prove themselves with different commands/,
    );
    expect(SKILL).toMatch(
      /\*\*Mixed certainty\*\* — you know the exact bytes for one part but not another/,
    );
    // Mixed certainty cross-references Apply mode so a reader sees the
    // zero-model-turn payoff of splitting off the known-bytes half.
    expect(SKILL).toMatch(
      /ships as a patch ticket \(zero model turns — see "Apply mode \(patch tickets\)" below\)/,
    );
    // Exactly one clock-based smell test remains in the whole skill — it is
    // a smell, not the decomposition rule.
    const smellHits = SKILL.match(/genuinely needs ~3 hours/g) ?? [];
    expect(smellHits).toHaveLength(1);
    expect(SKILL).toMatch(
      /single ticket that genuinely needs ~3 hours usually means one of the seams above was missed/,
    );
    // The inverse warning: decomposing seamless work is pure overhead.
    expect(SKILL).toMatch(/decomposing work that has none of these seams only multiplies overhead/);
    // timeout_minutes survives as sizing for an already-scoped ticket, not
    // as the decomposition trigger.
    expect(SKILL).toMatch(/`timeout_minutes` \*\*sizes\*\* a ticket that's already scoped/);
    expect(SKILL).toMatch(/This is sizing, not the decomposition trigger/);
    // The old clock-only rule is gone.
    expect(SKILL).not.toMatch(/decompose into a ticket set\*\* instead/);
  });

  it("stays self-contained: no delegation to docs/ (not in the npm package)", () => {
    // `docs/` is excluded from the `files` allowlist, so an installed package
    // has no docs/audit.md or docs/assess.md — the skill must inline what it
    // needs.
    expect(SKILL).not.toContain("docs/audit");
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
    // The instruction to wrap the series in a `junco-patch` fence, together
    // with why the fence must be longer than any backtick run inside it —
    // one assertion so a rewrite can't keep the word "junco-patch" while
    // dropping either the instruction or its reason.
    expect(SKILL).toMatch(
      /Wrap it in a `junco-patch` fence LONGER than any backtick run[^\n]*close your fence early and silently truncate the series/,
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
