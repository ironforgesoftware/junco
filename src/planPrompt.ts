/**
 * Planner prompt assembly — the daemon-side reuse of the junco-dispatch
 * authoring discipline. skills/junco-dispatch/TEMPLATE.md is the SINGLE
 * SOURCE for the plan shape (shared verbatim with the interactive skill);
 * only the preamble below is daemon-specific. EXAMPLE.md is appended as a
 * shape anchor when readable.
 *
 * The planner emits the ticket BODY ONLY inside a ```junco-ticket fence —
 * frontmatter is machine-built by the bridge (security boundary: model
 * output can never set repo:/workdir:/tools:).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLAN_FENCE = "junco-ticket";

// dist/ and src/ are both direct children of the package root, so one level
// up from this module reaches skills/ in both the built and vitest layouts.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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

function loadExample(): string | null {
  try {
    return readFileSync(EXAMPLE_PATH, "utf8");
  } catch {
    return null; // shape anchor only — never blocks planning
  }
}

export function buildPlannerPrompt(opts: {
  title: string;
  body: string;
  nwo: string;
  parent: { title: string; body: string | null } | null;
}): string {
  const template = loadDispatchTemplate();
  const example = loadExample();
  const issueBody = opts.body.trim();

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
\`\`\`\`

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
