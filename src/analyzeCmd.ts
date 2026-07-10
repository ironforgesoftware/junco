/**
 * `junco analyze <owner/repo#N|url>` — compose and submit a machine-owned
 * investigation ticket. This command's only job is target resolution +
 * ticket authoring; the daemon's normal claim/execute path
 * (src/analyzeFlow.ts) runs the read-only investigation and parks a comment
 * draft for review.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.js";
import { submitTicket } from "./dispatch.js";
import {
  resolveIssueTarget,
  type IssueTarget,
  type ExternalDispatchDeps,
} from "./externalDispatch.js";
import { buildAnalyzePrompt } from "./analyzePrompt.js";
import {
  listDrafts,
  readDraft,
  writeDraft,
  composeCommentBody,
  commentReviewPaths,
} from "./commentReview.js";
import { sanitizeFindingText } from "./findings.js";
import { slugifyId } from "./slug.js";

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

// Longest ~60 chars of the first non-empty line of a draft — the list view's
// preview column. Mirrors sanitizeFindingText's "…" truncation marker.
const LIST_PREVIEW_MAX = 60;

function firstDraftLine(draft: string): string {
  const line = draft.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > LIST_PREVIEW_MAX ? line.slice(0, LIST_PREVIEW_MAX) + "…" : line;
}

/**
 * `junco analyze review [<id>]` — read side of the durable comment-review
 * queue (src/commentReview.ts). No id lists pending drafts parked by the
 * analysis flow; an id previews exactly what `junco analyze post` would
 * post (composeCommentBody folds in the footer when the draft carries one).
 */
export async function runAnalyzeReviewCommand(
  cfg: Config,
  id: string | undefined,
  deps: AnalyzeCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));

  if (id === undefined) {
    const drafts = listDrafts(cfg);
    if (drafts.length === 0) {
      print("no pending comment drafts\n");
      return 0;
    }
    for (const d of drafts) {
      const scope = d.external ? "external" : "owned";
      print(
        `${d.id}  ${d.nwo}#${d.issue} (${scope})  ${d.createdAt}  ${firstDraftLine(d.draft)}\n`,
      );
    }
    print(
      "\nreview one: junco analyze review <id> · edit: junco analyze edit <id> · " +
        "post: junco analyze post <id>\n",
    );
    return 0;
  }

  const { draft, error } = readDraft(cfg, id);
  if (error) {
    print(`junco analyze review: ${error}\n`);
    return 1;
  }
  if (!draft) {
    print(`junco analyze review: no pending draft '${id}'\n`);
    return 2;
  }

  const scope = draft.external ? "external" : "owned";
  print(`${draft.id}  ${draft.nwo}#${draft.issue} (${scope})  ${draft.issueTitle}\n`);
  print(`\n${composeCommentBody(draft)}\n`);
  print(`\npost: junco analyze post ${draft.id}\n`);
  return 0;
}

export interface AnalyzeEditDeps {
  printFn?: (s: string) => void;
  spawnFn?: (cmd: string, args: string[]) => { status: number | null };
  env?: NodeJS.ProcessEnv;
  tmpDirFn?: () => string;
}

/**
 * `junco analyze edit <id>` — open a parked draft in $EDITOR/$VISUAL, then
 * re-sanitize and store the edited text. The one interactive spawn in this
 * command: everything else in the CLI is deps-injectable without a real
 * child process, but an editor session has no meaningful fake — the real
 * `spawnSync(..., { stdio: "inherit" })` sits behind `spawnFn` so tests can
 * substitute a scripted rewrite instead of a live editor.
 */
export async function runAnalyzeEditCommand(
  cfg: Config,
  id: string,
  deps: AnalyzeEditDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const spawnFn =
    deps.spawnFn ?? ((cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "inherit" }));
  const env = deps.env ?? process.env;
  const tmpDirFn =
    deps.tmpDirFn ?? ((): string => mkdtempSync(join(tmpdir(), "junco-analyze-edit-")));

  const { draft, error } = readDraft(cfg, id);
  if (error) {
    print(`junco analyze edit: ${error}\n`);
    return 1;
  }
  if (!draft) {
    print(`junco analyze edit: no pending draft '${id}'\n`);
    return 2;
  }

  const editor = env.VISUAL ?? env.EDITOR;
  if (!editor) {
    // The store slugifies the id into a single filename component
    // (reviewStore.ts entryFileName) — reuse that same slug rule rather than
    // reimplementing it, so this path always names the real file on disk.
    const path = join(commentReviewPaths(cfg).dir, `${slugifyId(id)}.json`);
    print(`junco analyze edit: no $EDITOR (or $VISUAL) set — draft file: ${path}\n`);
    print("set $EDITOR (or $VISUAL) to edit interactively\n");
    return 2;
  }

  const tmpDir = tmpDirFn();
  const file = join(tmpDir, "draft.md");
  try {
    writeFileSync(file, draft.draft, "utf8");

    const result = spawnFn(editor, [file]);
    if (result.status !== 0) {
      print("junco analyze edit: editor exited nonzero — draft unchanged\n");
      return 1;
    }

    const text = readFileSync(file, "utf8");
    const sanitized = sanitizeFindingText(text, 60_000);
    if (sanitized.length === 0) {
      print("junco analyze edit: draft is empty after sanitize — unchanged\n");
      return 1;
    }

    writeDraft(cfg, { ...draft, draft: sanitized });
    print(`draft updated — junco analyze review ${id} to preview\n`);
    return 0;
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup — the OS temp dir gets swept regardless */
    }
  }
}
