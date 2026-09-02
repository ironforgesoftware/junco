/**
 * Planner prompt assembly — the daemon-side reuse of the junco-dispatch
 * authoring discipline. skills/junco-dispatch/TEMPLATE.md is the SINGLE
 * SOURCE for the plan shape (shared verbatim with the interactive skill);
 * only the preamble below is daemon-specific. EXAMPLE.md is appended as a
 * shape anchor when readable.
 *
 * The planner emits the ticket BODY ONLY inside a ```junco-ticket fence —
 * frontmatter is machine-built by the bridge (security boundary: model
 * output can never set repo:/workdir:/tools:/network:).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./packageRoot.js";

export const PLAN_FENCE = "junco-ticket";

// dist/ and src/ are both direct children of the package root, so one level
// up from this module reaches skills/ in both the built and vitest layouts.
const TEMPLATE_PATH = join(PACKAGE_ROOT, "skills", "junco-dispatch", "TEMPLATE.md");
const EXAMPLE_PATH = join(PACKAGE_ROOT, "skills", "junco-dispatch", "EXAMPLE.md");

let templateCache: string | null = null;

/** Read TEMPLATE.md (cached). Throws when unreadable — planning must fail
 * loud rather than plan without the discipline; `doctor` preflights this. */
export function loadDispatchTemplate(): string {
  if (templateCache === null) {
    templateCache = readFileSync(TEMPLATE_PATH, "utf8");
  }
  return templateCache;
}

/** Read EXAMPLE.md, a worked-shape anchor. Null when unreadable — it never
 * blocks planning. Exported so the dashboard chat (chat/chatPrompt.ts) can
 * append the same anchor to its own prompt without a second copy. */
export function loadExample(): string | null {
  try {
    return readFileSync(EXAMPLE_PATH, "utf8");
  } catch {
    return null; // shape anchor only — never blocks planning
  }
}

/** Rule 6 — the plan-set alternative. Shared by the planner (buildPlannerPrompt)
 * and the dashboard chat (chat/chatPrompt.ts) so the two never drift. */
export function planSetRuleText(): string {
  return `

6. IF AND ONLY IF the issue naturally decomposes into 2–10 tasks with real
   dependency ordering, you may instead emit ONE fenced block tagged
   \`junco-plan\` (INSTEAD of the junco-ticket fence): a YAML document —

\`\`\`junco-plan
version: 1
shared_context: |
  Constraints that apply to every task.
tasks:
  - id: short-slug            # [a-z0-9][a-z0-9-]{0,31}; must not match r?<digits>
    title: Verb-first title
    depends_on: []            # other task ids; the worker orders execution
    description: |
      Self-contained: what to build and why.
    acceptance:
      - Testable assertion
    prohibitions:
      - What must not change
    verification: |
      commands the worker runs to verify (optional)
\`\`\`

   Each task becomes its own ticket and pull request, executed in dependency
   order (a task starts only after its dependencies' PRs are merged). Prefer
   the single junco-ticket fence whenever the work fits one PR.`;
}

export function buildPlannerPrompt(opts: {
  title: string;
  body: string;
  nwo: string;
  parent: { title: string; body: string | null } | null;
  planSets?: boolean;
}): string {
  const template = loadDispatchTemplate();
  const example = loadExample();
  const issueBody = opts.body.trim();

  const planSetRule = opts.planSets ? planSetRuleText() : "";

  const parts: string[] = [
    `You are the PLANNER for the junco worker. A GitHub issue on \`${opts.nwo}\` has been
dispatched, and your ONLY job this session is to author an execution plan for it —
you implement nothing.

Rules:

1. Your working directory is a read-only clone of the repository. EXPLORE IT before
   writing the plan: read the build manifest (package.json / pyproject.toml /
   Cargo.toml), and read the actual files you will cite. Verify every path, symbol,
   and signature you reference — never from memory.
2. Follow the ticket template below EXACTLY. Populate every section; write \`_None._\`
   for a genuinely inapplicable one rather than dropping it.
3. If the issue already contains a complete, template-shaped plan, adopt it with
   minimal corrections instead of rewriting it.
4. Do NOT include a frontmatter block (no \`---\` header) — the worker builds
   frontmatter itself. Start the plan at the \`# <title>\` heading.
5. Your FINAL message must contain the finished plan inside a single fenced block
   tagged \`${PLAN_FENCE}\`, and nothing else of substance. If your plan itself
   contains fenced code blocks, the outer fence must use more backticks than any
   inner fence:

\`\`\`\`${PLAN_FENCE}
# <verb-first title>
...every template section...
\`\`\`\`${planSetRule}

A missing or empty fence fails the ticket.`,
    `--- TICKET TEMPLATE (follow the body sections; ignore its frontmatter guidance) ---\n\n${template}`,
  ];
  if (example) {
    parts.push(`--- WORKED EXAMPLES (shape anchors) ---\n\n${example}`);
  }
  parts.push(
    `--- THE ISSUE TO PLAN ---\n\n# ${opts.title}\n\n${issueBody || "_(the issue has no body — plan from the title and the repo)_"}`,
  );
  if (opts.parent) {
    const pBody = (opts.parent.body ?? "").trim();
    parts.push(
      `--- Parent issue (background only) — the instruction is the issue above ---\n\n**${opts.parent.title}**${pBody ? `\n\n${pBody}` : ""}`,
    );
  }
  return parts.join("\n\n") + "\n";
}
