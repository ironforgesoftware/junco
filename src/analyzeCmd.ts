/**
 * `junco investigate <owner/repo#N|url>` — compose and submit a machine-owned
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
  removeDraft,
  composeCommentBody,
  commentReviewPaths,
} from "./commentReview.js";
import { sanitizeFindingText } from "./findings.js";
import { slugifyId } from "./slug.js";
import { gh, describeError, GH_TIMEOUT_MS } from "./git.js";
import { tryOrEnqueue, withCommentMarker, type OutboxOp } from "./githubOutbox.js";

/** Same slug rule buildExternalTicket applies to compose its ticket id
 * (externalDispatch.ts) — mirrored here since this builds a distinct
 * `analyze-` id, not a `gh-` one. */
function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Build a machine-owned analysis ticket for a resolved issue target.
 * Frontmatter carries only `id`, `repo`, and the canonical `investigate:` key
 * — deliberately NO `github:` block: the reporter's comment/label lifecycle
 * keys off that block, and an investigate ticket must produce no un-gated
 * outward write (the only outward write is the human-confirmed `junco
 * investigate post`). The id carries no timestamp, so a queued duplicate
 * fails loud and a re-run overwrites the parked draft (the review store is
 * keyed by id).
 */
export function buildAnalyzeTicket(t: IssueTarget): { id: string; content: string } {
  const [owner, name] = t.nwo.split("/");
  const id = `analyze-${slugify(owner)}-${slugify(name)}-${t.issue}`;

  const body = buildAnalyzePrompt({ nwo: t.nwo, issue: t.issue, title: t.title, body: t.body });
  const content =
    `---\n` +
    `id: ${id}\n` +
    `repo: ${JSON.stringify(t.clonePath)}\n` +
    `investigate:\n` +
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

/**
 * Shared core of `junco investigate <ref>`: resolve → build ticket → submit.
 * Throws on any failure. The CLI shell (`runAnalyzeCommand`) wraps this in a
 * single try/catch that prints the message and exits 1; the dashboard's
 * `analyzeIssue` client method wraps it in `attempt` instead.
 */
export async function analyzeIssueCore(
  cfg: Config,
  ref: string,
  deps: AnalyzeCmdDeps = {},
): Promise<{ id: string; destPath: string }> {
  const submitFn = deps.submitFn ?? submitTicket;
  const resolveFn = deps.resolveFn ?? resolveIssueTarget;

  const target: IssueTarget = await resolveFn(cfg, ref, deps.resolveDeps ?? {});
  const { id, content } = buildAnalyzeTicket(target);
  const destPath = submitFn(cfg, content, { idHint: id });
  return { id, destPath };
}

export async function runAnalyzeCommand(
  cfg: Config,
  ref: string | undefined,
  deps: AnalyzeCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));

  if (!ref) {
    print(`Usage: junco investigate <owner/repo#N|url>\n`);
    return 2;
  }

  let destPath: string;
  try {
    ({ destPath } = await analyzeIssueCore(cfg, ref, deps));
  } catch (e) {
    print(`junco investigate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  print(`queued: ${destPath}\n`);
  print(
    "queued — the worker will investigate and park a comment draft; " +
      "run `junco investigate review` when it lands\n",
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
 * `junco investigate review [<id>]` — read side of the durable comment-review
 * queue (src/commentReview.ts). No id lists pending drafts parked by the
 * analysis flow; an id previews exactly what `junco investigate post` would
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
      "\nreview one: junco investigate review <id> · edit: junco investigate edit <id> · " +
        "post: junco investigate post <id>\n",
    );
    return 0;
  }

  const { draft, error } = readDraft(cfg, id);
  if (error) {
    print(`junco investigate review: ${error}\n`);
    return 1;
  }
  if (!draft) {
    print(`junco investigate review: no pending draft '${id}'\n`);
    return 2;
  }

  const scope = draft.external ? "external" : "owned";
  print(`${draft.id}  ${draft.nwo}#${draft.issue} (${scope})  ${draft.issueTitle}\n`);
  print(`\n${composeCommentBody(draft)}\n`);
  print(`\npost: junco investigate post ${draft.id}\n`);
  return 0;
}

export interface AnalyzeEditDeps {
  printFn?: (s: string) => void;
  spawnFn?: (cmd: string, args: string[]) => { status: number | null };
  env?: NodeJS.ProcessEnv;
  tmpDirFn?: () => string;
}

/**
 * `junco investigate edit <id>` — open a parked draft in $EDITOR/$VISUAL, then
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
    print(`junco investigate edit: ${error}\n`);
    return 1;
  }
  if (!draft) {
    print(`junco investigate edit: no pending draft '${id}'\n`);
    return 2;
  }

  const editor = env.VISUAL ?? env.EDITOR;
  if (!editor) {
    // The store slugifies the id into a single filename component
    // (reviewStore.ts entryFileName) — reuse that same slug rule rather than
    // reimplementing it, so this path always names the real file on disk.
    const path = join(commentReviewPaths(cfg).dir, `${slugifyId(id)}.json`);
    print(`junco investigate edit: no $EDITOR (or $VISUAL) set — draft file: ${path}\n`);
    print("set $EDITOR (or $VISUAL) to edit interactively\n");
    return 2;
  }

  const tmpDir = tmpDirFn();
  const file = join(tmpDir, "draft.md");
  try {
    writeFileSync(file, draft.draft, "utf8");

    const result = spawnFn(editor, [file]);
    if (result.status !== 0) {
      print("junco investigate edit: editor exited nonzero — draft unchanged\n");
      return 1;
    }

    const text = readFileSync(file, "utf8");
    const sanitized = sanitizeFindingText(text, 60_000);
    if (sanitized.length === 0) {
      print("junco investigate edit: draft is empty after sanitize — unchanged\n");
      return 1;
    }

    writeDraft(cfg, { ...draft, draft: sanitized });
    print(`draft updated — junco investigate review ${id} to preview\n`);
    return 0;
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup — the OS temp dir gets swept regardless */
    }
  }
}

/** Post ONE comment live; return the URL gh prints, or null (a comment post
 * can legitimately produce no scrapeable URL). Mirrors createIssueLive's
 * tmpdir + --body-file + reverse-scan shape (assessFiling.ts). The body carries
 * the outbox idempotency marker (withCommentMarker) so a lost-ack replay is
 * deduped by the next flush's scan and never double-posted (#132). */
async function postCommentLive(
  cfg: Config,
  nwo: string,
  issue: number,
  body: string,
  ghFn: typeof gh,
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "junco-analyze-post-"));
  const file = join(dir, "comment.md");
  writeFileSync(file, withCommentMarker(nwo, issue, body), "utf8");
  try {
    const out = await ghFn(
      cfg,
      ["issue", "comment", String(issue), "--repo", nwo, "--body-file", file],
      { timeoutMs: GH_TIMEOUT_MS },
    );
    return (
      out.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("https://")) ?? null
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface AnalyzePostDeps {
  printFn?: (s: string) => void;
  ghFn?: typeof gh;
}

/**
 * Shared core of `junco investigate post`: read → compose → post/enqueue →
 * archive-on-success. Throws on read-error/missing/permanent-failure — a
 * plain `Error` carrying the CLI's own message text (`error`'s string, or
 * `no pending draft '<id>'`) for the first two, and the outbox's
 * describeError-friendly error for the last. The CLI shell
 * (`runAnalyzePostCommand`) keeps its OWN readDraft pre-check ahead of this
 * call so it can tell exit 2 (missing/unknown id) apart from exit 1 (read
 * error/permanent failure) — this core has no such distinction to offer,
 * since the dashboard's `postCommentDraft` client method just wraps it in
 * `attempt` and reports one flat `Result`.
 */
export async function postDraftCore(
  cfg: Config,
  id: string,
  opts: { noFooter: boolean },
  deps: { ghFn?: typeof gh } = {},
): Promise<{ outcome: "sent" | "queued"; url: string | null }> {
  const ghFn = deps.ghFn ?? gh;

  const { draft, error } = readDraft(cfg, id);
  if (error) throw new Error(error);
  if (!draft) throw new Error(`no pending draft '${id}'`);

  if (opts.noFooter) draft.footer = false;
  const body = composeCommentBody(draft);
  const op: OutboxOp = { kind: "comment", nwo: draft.nwo, issue: draft.issue, body };

  let url: string | null = null;
  const outcome = await tryOrEnqueue(cfg, "analyze", op, async () => {
    url = await postCommentLive(cfg, draft.nwo, draft.issue, body, ghFn);
  });
  removeDraft(cfg, id, "posted");
  return { outcome, url };
}

/**
 * `junco investigate post <id> [--no-footer]` — the human-confirmed step: posts a
 * parked draft (commentReview.ts) as a comment on its issue, through the
 * outbox seam (githubOutbox.ts) so an offline run converges on the next
 * flush. Archives the draft to posted/ on EITHER outcome (sent or queued) —
 * a queued op is durable, so the draft's job is done; a genuine (non-network)
 * failure leaves the draft pending so the operator can retry.
 */
export async function runAnalyzePostCommand(
  cfg: Config,
  id: string | undefined,
  opts: { noFooter: boolean },
  deps: AnalyzePostDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));

  if (!id) {
    print(`Usage: junco investigate post <id> [--no-footer]\n`);
    return 2;
  }

  // Kept as the shell's own pre-check (rather than inspecting what
  // postDraftCore throws) so exit 2 (missing/unknown id) stays distinct from
  // exit 1 (read error/permanent failure) without a typed-error seam.
  const { draft, error } = readDraft(cfg, id);
  if (error) {
    print(`junco investigate post: ${error}\n`);
    return 1;
  }
  if (!draft) {
    print(`junco investigate post: no pending draft '${id}'\n`);
    return 2;
  }

  try {
    const { outcome, url } = await postDraftCore(cfg, id, opts, deps);
    if (outcome === "sent") {
      print(url ? `posted: ${url}\n` : "posted\n");
    } else {
      print("offline — queued to the outbox; it will post on the next flush\n");
    }
    return 0;
  } catch (e) {
    print(`junco investigate post: ${describeError(e)}\n`);
    return 1;
  }
}
