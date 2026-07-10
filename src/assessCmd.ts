/**
 * `junco assess <path|owner/repo|owner/repo#N> [--auto-plan]` — compose and submit a
 * machine-owned assessment ticket. This command's only job is target
 * resolution + ticket authoring; the daemon's normal claim/execute path
 * (src/assessFlow.ts) runs the actual audit and files issues.
 */

import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Config } from "./types.js";
import { expandHome } from "./config.js";
import { submitTicket } from "./dispatch.js";
import { readWatchlist, watchlistPath } from "./watchlist.js";
import { buildAssessPrompt } from "./assessPrompt.js";
import { listPending, readPending } from "./assessReview.js";
import { fileFindings, type FileFindingsDeps, type FileResult } from "./assessFiling.js";
import {
  parseIssueRef,
  resolveIssueTarget,
  type IssueTarget,
  type ExternalDispatchDeps,
} from "./externalDispatch.js";

const NWO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Same slug rule dispatch.ts's submitTicket applies when choosing a
 * destination filename — mirrored here (not exported there) since this
 * builds the ticket id itself, not just the filename. */
function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC `YYYYMMDD-HHmm`. */
function stampOf(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`
  );
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build a machine-owned assessment ticket for `repoPath` (already resolved
 * by the caller). Frontmatter carries only `id`, `repo`, and `assess` —
 * nothing an agent session could widen; the body is the read-only audit
 * prompt. The nwo is unknown at authoring time for a plain path/nwo target
 * (it's resolved from the repo's origin remote when the ticket actually
 * runs), so the prompt gets `nwo: null` in that case. When `issueContext`
 * is set (an issue-ref target, `junco assess owner/repo#N`), the nwo is
 * already known from the resolved issue, and the `assess:` block also
 * carries `issue`/`issue_title` so the daemon's assessFlow.ts can scope the
 * audit and filed findings can reference the issue.
 */
export function buildAssessTicket(
  repoPath: string,
  opts: {
    autoPlan: boolean;
    issueContext?: { nwo: string; issue: number; title: string; body: string };
  },
  now: Date,
): { id: string; content: string } {
  const id = `assess-${slugify(basename(repoPath))}-${stampOf(now)}`;
  const assessLines: string[] = [];
  if (opts.autoPlan) assessLines.push("  auto_plan: true");
  if (opts.issueContext) {
    assessLines.push(`  issue: ${opts.issueContext.issue}`);
    assessLines.push(`  issue_title: ${JSON.stringify(opts.issueContext.title)}`);
  }
  const assessYaml = assessLines.length > 0 ? `assess:\n${assessLines.join("\n")}` : "assess: {}";
  const body = opts.issueContext
    ? buildAssessPrompt({ nwo: opts.issueContext.nwo, repoPath, issueContext: opts.issueContext })
    : buildAssessPrompt({ nwo: null, repoPath });
  const content =
    `---\n` +
    `id: ${id}\n` +
    `repo: ${JSON.stringify(repoPath)}\n` +
    `${assessYaml}\n` +
    `---\n\n${body}`;
  return { id, content };
}

export interface AssessCmdDeps {
  printFn?: (s: string) => void;
  submitFn?: typeof submitTicket;
  nowFn?: () => Date;
  resolveFn?: typeof resolveIssueTarget;
  resolveDeps?: ExternalDispatchDeps;
}

export async function runAssessCommand(
  cfg: Config,
  target: string | undefined,
  opts: { autoPlan: boolean },
  deps: AssessCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const submitFn = deps.submitFn ?? submitTicket;
  const nowFn = deps.nowFn ?? ((): Date => new Date());

  if (!target) {
    print(`Usage: junco assess <path|owner/repo|owner/repo#N> [--auto-plan]\n`);
    return 2;
  }

  let repoPath: string;
  let issueContext: { nwo: string; issue: number; title: string; body: string } | undefined;

  // Issue-ref target (owner/repo#N or an issue URL) — resolved via the same
  // fail-fast fetch + auto-provisioning as `junco analyze`/dispatch. Checked
  // ahead of the plain NWO/path branches below, which stay untouched: a bare
  // `owner/repo` still requires the repo be already watched (the documented
  // asymmetry — an issue ref is an explicit, single-issue ask; a bare repo
  // audit is a broader operation that shouldn't silently provision a clone).
  const ref = parseIssueRef(target);
  if (ref !== null) {
    const resolveFn = deps.resolveFn ?? resolveIssueTarget;
    let t: IssueTarget;
    try {
      t = await resolveFn(cfg, target, deps.resolveDeps ?? {});
    } catch (e) {
      print(`junco assess: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    repoPath = t.clonePath;
    issueContext = { nwo: t.nwo, issue: t.issue, title: t.title, body: t.body };
  } else if (NWO_RE.test(target) && !isDirectory(target)) {
    // Include EXTERNAL entries: assess now files (via review) on repos the operator
    // does not own, so external clones are valid targets (unlike the bridge poll,
    // which still excludes them via resolveWatchedRepos).
    const fromConfig = cfg.github.repos.find((r) => r.nwo.toLowerCase() === target.toLowerCase());
    const { entries, error: watchErr } = readWatchlist(watchlistPath(cfg));
    if (watchErr) {
      print(`junco assess: watchlist unreadable (${watchErr}); using config repos only\n`);
    }
    const fromWatch = entries.find((e) => e.nwo.toLowerCase() === target.toLowerCase());
    const match = fromConfig ?? fromWatch;
    if (!match) {
      print(
        `junco assess: '${target}' is not watched — add it under [[github.repos]] in config.toml, or watch it from the dashboard, then retry\n`,
      );
      return 2;
    }
    repoPath = expandHome(match.path);
  } else {
    const candidate = resolve(expandHome(target));
    if (!isDirectory(candidate)) {
      print(`junco assess: not a directory: ${candidate}\n`);
      return 2;
    }
    repoPath = candidate;
  }

  const { id, content } = buildAssessTicket(repoPath, { ...opts, issueContext }, nowFn());

  let dst: string;
  try {
    dst = submitFn(cfg, content, { idHint: id });
  } catch (e) {
    print(`junco assess: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  print(`queued: ${dst}\n`);
  print(
    "queued — the worker will audit the repo and park findings for review on its next claim; " +
      "run `junco assess review` then `junco assess file <id>` to file them\n",
  );
  if (opts.autoPlan) {
    print(
      "--auto-plan requested — findings you file will carry the trigger label so the bridge plans them\n",
    );
  }
  return 0;
}

/**
 * `junco assess review [<id>]` — read side of the durable review queue
 * (src/assessReview.ts). No id lists pending batches parked by the audit
 * flow; an id prints each finding's fingerprint/severity/title so the
 * operator can decide what to file (junco assess file — added next).
 */
export async function runAssessReviewCommand(
  cfg: Config,
  id: string | undefined,
  deps: AssessCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));

  if (id === undefined) {
    const pending = listPending(cfg);
    if (pending.length === 0) {
      print("no pending assess reviews\n");
      return 0;
    }
    for (const b of pending) {
      const scope = b.external ? "external" : "owned";
      print(`${b.id}  ${b.nwo} (${scope})  ${b.findings.length} findings  ${b.createdAt}\n`);
    }
    print(`\nreview one: junco assess review <id> · file: junco assess file <id> --all\n`);
    return 0;
  }

  const { batch, error } = readPending(cfg, id);
  if (error) {
    print(`junco assess review: ${error}\n`);
    return 1;
  }
  if (!batch) {
    print(`junco assess review: no pending batch '${id}'\n`);
    return 2;
  }
  print(`${batch.id}  ${batch.nwo} (${batch.external ? "external" : "owned"})\n`);
  for (const f of batch.findings) {
    print(`  ${f.fingerprint}  [${f.severity}]  ${f.title}\n`);
  }
  print(`\nfile all: junco assess file ${batch.id} --all\n`);
  print(
    `file some: junco assess file ${batch.id} --only ${batch.findings
      .map((f) => f.fingerprint)
      .slice(0, 2)
      .join(",")}\n`,
  );
  return 0;
}

export interface AssessFileDeps {
  printFn?: (s: string) => void;
  fileDeps?: FileFindingsDeps;
  fileFindingsFn?: typeof fileFindings;
}

/**
 * `junco assess file <id> --all | --only <fp,...>` — the human confirm step:
 * files a SELECTION of the findings parked by `junco assess` (assessReview.ts)
 * as GitHub issues via assessFiling.ts, then archives the batch. Requires an
 * explicit selection (no bare default) — these writes land on someone else's
 * tracker.
 */
export async function runAssessFileCommand(
  cfg: Config,
  id: string | undefined,
  opts: { all: boolean; only: string | undefined },
  deps: AssessFileDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const fileFn = deps.fileFindingsFn ?? fileFindings;
  if (!id) {
    print("Usage: junco assess file <id> --all | --only <fp,fp,...>\n");
    return 2;
  }
  if (!opts.all && !opts.only) {
    print("junco assess file: choose findings with --all or --only <fp,...>\n");
    return 2;
  }
  const { batch, error } = readPending(cfg, id);
  if (error) {
    print(`junco assess file: ${error}\n`);
    return 1;
  }
  if (!batch) {
    print(`junco assess file: no pending batch '${id}'\n`);
    return 2;
  }
  const known = new Set(batch.findings.map((f) => f.fingerprint));
  const selected = opts.all
    ? known
    : new Set(
        (opts.only ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );

  // All-or-nothing on --only: a single unknown fingerprint (a typo) rejects the
  // whole command WITHOUT filing or archiving anything. Without this guard an
  // unknown fingerprint would build an empty selection, file nothing, and (pre
  // the assessFiling defense-in-depth) silently archive the batch at exit 0.
  if (opts.only) {
    // A whitespace/comma-only --only value is truthy (so the --all/--only guard
    // above passes) but split/trim/filter yields nothing. Reject it as a usage
    // error rather than exit 0 as a silent no-op — a filing command whose
    // selection chose nothing has not succeeded. (#138)
    if (selected.size === 0) {
      print(
        `junco assess file: --only selected no findings — pass one or more fingerprints, e.g. --only <fp,fp,...>\n`,
      );
      return 2;
    }
    const unknown = [...selected].filter((fp) => !known.has(fp));
    if (unknown.length > 0) {
      print(`junco assess file: unknown fingerprint(s): ${unknown.join(", ")}\n`);
      return 2;
    }
  }

  let res: FileResult;
  try {
    res = await fileFn(cfg, batch, selected, deps.fileDeps ?? {});
  } catch (e) {
    // fileFindings rethrows before archiving on the fatal-dedup path, so the
    // batch is preserved — surface the reason cleanly, don't swallow it.
    print(`junco assess file: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  print(
    `filed ${res.created} · queued ${res.queuedOffline} · already-filed ${res.deduped} · failed ${res.failed}\n`,
  );
  for (const u of res.urls) print(`  ${u}\n`);
  for (const w of res.warnings) print(`  ! ${w}\n`);
  return res.failed > 0 ? 1 : 0;
}
