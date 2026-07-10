/**
 * `junco analyze <owner/repo#N|url>` — compose and submit a machine-owned
 * investigation ticket. This command's only job is target resolution +
 * ticket authoring; the daemon's normal claim/execute path
 * (src/analyzeFlow.ts) runs the read-only investigation and parks a comment
 * draft for review.
 */

import type { Config } from "./types.js";
import { submitTicket } from "./dispatch.js";
import {
  resolveIssueTarget,
  type IssueTarget,
  type ExternalDispatchDeps,
} from "./externalDispatch.js";
import { buildAnalyzePrompt } from "./analyzePrompt.js";

/** Same slug rule buildExternalTicket applies to compose its ticket id
 * (externalDispatch.ts) — mirrored here since this builds a distinct
 * `analyze-` id, not a `gh-` one. */
function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Build a machine-owned analysis ticket for a resolved issue target.
 * Frontmatter carries only `id`, `repo`, and `analyze` — deliberately NO
 * `github:` block: the reporter's comment/label lifecycle keys off that
 * block, and an analyze ticket must produce no un-gated outward write (the
 * only outward write is the human-confirmed `junco analyze post`). The id
 * carries no timestamp, so a queued duplicate fails loud and a re-run
 * overwrites the parked draft (the review store is keyed by id).
 */
export function buildAnalyzeTicket(t: IssueTarget): { id: string; content: string } {
  const [owner, name] = t.nwo.split("/");
  const id = `analyze-${slugify(owner)}-${slugify(name)}-${t.issue}`;

  const body = buildAnalyzePrompt({ nwo: t.nwo, issue: t.issue, title: t.title, body: t.body });
  const content =
    `---\n` +
    `id: ${id}\n` +
    `repo: ${JSON.stringify(t.clonePath)}\n` +
    `analyze:\n` +
    `  issue: ${t.issue}\n` +
    `  title: ${JSON.stringify(t.title)}\n` +
    `---\n\n${body}`;
  return { id, content };
}

export interface AnalyzeCmdDeps {
  printFn?: (s: string) => void;
  submitFn?: typeof submitTicket;
  resolveFn?: typeof resolveIssueTarget;
  resolveDeps?: ExternalDispatchDeps;
}

export async function runAnalyzeCommand(
  cfg: Config,
  ref: string | undefined,
  deps: AnalyzeCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const submitFn = deps.submitFn ?? submitTicket;
  const resolveFn = deps.resolveFn ?? resolveIssueTarget;

  if (!ref) {
    print(`Usage: junco analyze <owner/repo#N|url>\n`);
    return 2;
  }

  let target: IssueTarget;
  try {
    target = await resolveFn(cfg, ref, deps.resolveDeps ?? {});
  } catch (e) {
    print(`junco analyze: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const { id, content } = buildAnalyzeTicket(target);

  let dst: string;
  try {
    dst = submitFn(cfg, content, { idHint: id });
  } catch (e) {
    print(`junco analyze: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  print(`queued: ${dst}\n`);
  print(
    "queued — the worker will investigate and park a comment draft; " +
      "run `junco analyze review` when it lands\n",
  );
  return 0;
}
