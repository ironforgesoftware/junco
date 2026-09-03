/**
 * The chat system prompt (spec 2026-09-01 §6.5). One source of truth: the
 * planner's TEMPLATE.md-backed authoring contract (planPrompt.ts), the
 * dispatch skill's authoring sections lifted by heading at build time (a test
 * guards every heading — a rename is a contract change), and the chat's own
 * fence + frontmatter-allowlist rules.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../packageRoot.js";
import { PLAN_FENCE, loadDispatchTemplate, loadExample, planSetRuleText } from "../planPrompt.js";
import { PLAN_SET_FENCE } from "../githubInbox.js";
import { FRONTMATTER_ALLOWLIST } from "./fenceExtract.js";

const SKILL_PATH = join(PACKAGE_ROOT, "skills", "junco-dispatch", "SKILL.md");

export interface SkillSectionSpec {
  /** Exact `## ` heading text. */
  h2: string;
  /** Exact `### ` heading text inside it; absent → the whole ## section (subsections included). */
  h3?: string;
}

/** The authoring sections the chat needs and the planner never did. */
export const CHAT_SKILL_SECTIONS: readonly SkillSectionSpec[] = [
  { h2: "Metadata rules" },
  { h2: "Authoring discipline (what makes the plan NOT loop)" },
  { h2: "Things to NEVER put in a plan" },
  { h2: "Ticket sets" },
  { h2: "Wrapping an existing plan file" },
  { h2: "Amend mode (follow-up tickets on existing PRs)" },
  { h2: "Apply mode (patch tickets)" },
  { h2: "Audit mode (sweep a repo → review → file)", h3: "Inputs to gather" },
  { h2: "Investigate mode (deep-read an issue → reviewed comment)", h3: "Inputs to gather" },
];

function sliceSection(lines: string[], start: number, level: "##" | "###"): string[] {
  const stop = level === "##" ? /^##\s/ : /^##\s|^###\s/;
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    if (stop.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out;
}

export function loadSkillSections(
  specs: readonly SkillSectionSpec[],
  deps: { readFileFn?: (p: string) => string } = {},
): string {
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const lines = readFileFn(SKILL_PATH).replace(/\r\n?/g, "\n").split("\n");
  const parts: string[] = [];
  for (const s of specs) {
    const h2 = lines.findIndex((l) => l === `## ${s.h2}`);
    if (h2 === -1) throw new Error(`junco-dispatch SKILL.md: heading not found: "## ${s.h2}"`);
    const section = sliceSection(lines, h2, "##");
    if (s.h3 === undefined) {
      parts.push(section.join("\n").trimEnd());
      continue;
    }
    const h3 = section.findIndex((l) => l === `### ${s.h3}`);
    if (h3 === -1)
      throw new Error(
        `junco-dispatch SKILL.md: heading not found: "### ${s.h3}" under "## ${s.h2}"`,
      );
    parts.push(sliceSection(section, h3, "###").join("\n").trimEnd());
  }
  return parts.join("\n\n");
}

/**
 * "Ticket sets"'s own "Compiler-backed alternative" paragraph teaches the
 * `junco-plan` fence unconditionally (SKILL.md serves `junco submit --plan`
 * too, regardless of THIS daemon's planSets.enabled) — strip the literal
 * example fence when plan sets are off so a disabled daemon's chat prompt
 * never shows the model a fence it must not emit. Fails loud, like
 * loadSkillSections' own heading guard, rather than silently no-op-ing: if
 * SKILL.md's wording ever moves the fence out from under this regex, a
 * plan-sets-disabled prompt would otherwise teach the fence anyway with no
 * signal that the guard stopped working.
 */
function withoutPlanSetExample(skillSections: string): string {
  const stripped = skillSections.replace(/```junco-plan\n[\s\S]*?\n```\n?/, "");
  if (stripped === skillSections) {
    throw new Error(
      'chat prompt: expected a ```junco-plan fence in the "Ticket sets" section of ' +
        "skills/junco-dispatch/SKILL.md (heading drift?)",
    );
  }
  return stripped;
}

export function buildChatPrompt(
  opts: { cwd: string; nwo: string | null; planSetsEnabled: boolean },
  deps: { readFileFn?: (p: string) => string } = {},
): string {
  const repo = opts.nwo ?? opts.cwd;
  const allow = [...FRONTMATTER_ALLOWLIST].map((k) => `\`${k}\``).join(", ");
  const framing = `You are the coding agent behind junco, a task-queue worker, chatting with its operator
about the repository \`${repo}\` (your working directory: ${opts.cwd}). This session is
READ-ONLY: explore with your tools, answer questions, and — when the operator asks for work
to be done — DRAFT it as a junco ticket. You never run, submit, or dispatch anything; junco
parks every draft for the operator to review and submit. Never claim that a ticket was
submitted, that a PR exists, or that work has started.

How a parked draft gets submitted: the dashboard shows it as a draft card under your
message — \`s\` submits, \`e\` edits, \`r\` cycles the route, \`D\` discards — and the review
view (\`v\`) lists every parked draft. When the operator asks you to submit, dispatch, or
send a draft, point them at that card; never tell them to copy the fence into a file or
to run \`junco submit\` by hand — the draft is already in junco's hands.`;
  const fenceContract = `--- DRAFTING CONTRACT ---

When asked to draft work, emit the finished ticket inside ONE fenced block tagged
\`${PLAN_FENCE}\`, with a YAML frontmatter block at the top followed by the template body.
If the ticket itself contains fenced code, the outer fence must use more backticks than any
inner fence:

\`\`\`${PLAN_FENCE}
---
id: <slug>
<other frontmatter keys as needed>
---
# <Verb-first title>
<the template body sections above, filled in>
\`\`\`

Frontmatter you may set: ${allow}. \`repo:\` is set by junco from this session — never
write it — and every other key (\`tools\`, \`network\`, \`workdir\`, …) is dropped. Kinds
are expressed by frontmatter: \`amends_pr: <n>\` for a follow-up on an open PR; an
\`audit:\` block (\`auto_plan\`, optional \`issue\`) to request a repo audit; an
\`investigate:\` block (\`issue\`) to request an issue investigation (the legacy spellings
\`assess:\`/\`analyze:\` are accepted but never preferred); a \`junco-patch\` fence in
the body for an apply ticket (only when you know the exact bytes). A ticket SET is two or
more \`${PLAN_FENCE}\` fences in one message, each with an explicit \`id\` and
\`depends_on\` naming sibling ids. When wrapping an existing plan file the operator points
you at, copy its body verbatim — do not rewrite it.${
    opts.planSetsEnabled
      ? planSetRuleText().replace(
          "INSTEAD of the junco-ticket fence",
          `INSTEAD of the ${PLAN_FENCE} fence`,
        )
      : ""
  }`;
  const template = loadDispatchTemplate();
  const example = loadExample();
  const parts = [
    framing,
    `--- TICKET TEMPLATE (follow the body sections; the frontmatter rules above override its frontmatter guidance) ---\n\n${template}`,
  ];
  if (example) parts.push(`--- WORKED EXAMPLES (shape anchors) ---\n\n${example}`);
  const skillSections = loadSkillSections(CHAT_SKILL_SECTIONS, deps);
  parts.push(
    `--- AUTHORING RULES (from the junco-dispatch skill) ---\n\n${
      opts.planSetsEnabled ? skillSections : withoutPlanSetExample(skillSections)
    }`,
  );
  parts.push(fenceContract);
  if (!opts.planSetsEnabled)
    parts.push(`Plan sets are disabled on this daemon: never emit a \`${PLAN_SET_FENCE}\` fence.`);
  return parts.join("\n\n") + "\n";
}
