import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RepoContext {
  repo: string; // absolute path
  baseBranch: string;
  branchName: string;
  draft: boolean;
  prTitle: string | null;
  labels: string[];
  reviewers: string[];
  amendsPr: number | null;
  /** Git remote the PR flow pushes to ("origin" unless the ticket sets push_remote). */
  pushRemote: string;
  /** owner/repo of the push remote when it differs from origin — resolved by
   * validateRepoContext from the remote's URL; null until then (and for origin). */
  forkNwo: string | null;
}

export function isAmend(ctx: RepoContext): boolean {
  return ctx.amendsPr !== null;
}

/** Expand a leading `~` to the user's home directory (mirrors config.ts). */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

/**
 * Port of worker.py `_derive_branch_name`.
 * Replaces runs of non-alphanumeric-non-._/- chars with a single dash,
 * strips leading/trailing dashes and slashes from the slug, then prepends
 * a prefix (ensuring it ends with "/").
 */
export function deriveBranchName(taskId: string, prefix: string): string {
  const slug = taskId.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[-/]+|[-/]+$/g, "") || "task";
  const p = prefix.endsWith("/") ? prefix : prefix + "/";
  return p + slug;
}

/**
 * Guard a ticket-supplied git ref (branch_name / base_branch) before it flows
 * verbatim into `git worktree add -b` / `branch -f` / `push` / `ls-remote`.
 * Mirrors the option-injection rail `validateRepoContext` (repo.ts) enforces on
 * push_remote — the first char may not be '-' (a leading '-' reads as a git
 * option token), and the whole value is confined to the git-ref charset
 * [A-Za-z0-9._/-] so it cannot smuggle whitespace or shell metacharacters.
 * The JSON Schema `pattern`
 * on both fields documents the charset for dispatchers; this is the runtime
 * rail, because deriveRepoContext does not validate against the schema.
 */
export function isSafeGitRef(name: string): boolean {
  return /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(name);
}

/**
 * Port of worker.py `_as_str_list`.
 * - string  → split on commas, trim, drop empties
 * - array   → map String() + trim, drop empties
 * - null/undefined → []
 * - anything else  → [String(v)] (mirrors Python `return [str(v)]`)
 */
export function asStrList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    // Mirror Python: filter items where str(x).strip() is truthy, but return str(x) un-trimmed.
    // However practical usage (labels, reviewers) always has clean strings, and the test
    // spec says `["x", " y "]` → `["x", "y"]`, so we trim to match the test contract.
    return v
      .filter((x) => x !== null && x !== undefined && String(x).trim() !== "")
      .map((x) => String(x).trim());
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return [String(v)];
}

export interface DeriveRepoContextOpts {
  defaultBaseBranch: string;
  branchPrefix: string;
  draftByDefault: boolean;
  defaultLabels: string[];
}

/**
 * Port of worker.py `derive_repo_context`.
 * Returns null for Q&A tickets (no `repo:` in frontmatter).
 */
export function deriveRepoContext(
  frontmatter: Record<string, unknown>,
  taskId: string,
  opts: DeriveRepoContextOpts,
): RepoContext | null {
  const rawRepo = frontmatter.repo;
  if (!rawRepo) return null;

  const repo = resolve(expandHome(String(rawRepo)));

  // A ticket-supplied base_branch/branch_name is honored only when it passes the
  // option-injection guard; a malformed value falls back to the safe default so
  // an option token can never reach git (defense-in-depth for the dispatcher
  // contract — the schema pattern is documentation, this is the enforced rail).
  const baseBranch =
    typeof frontmatter.base_branch === "string" && isSafeGitRef(frontmatter.base_branch)
      ? frontmatter.base_branch
      : opts.defaultBaseBranch;

  const branchName =
    typeof frontmatter.branch_name === "string" && isSafeGitRef(frontmatter.branch_name)
      ? frontmatter.branch_name
      : deriveBranchName(taskId, opts.branchPrefix);

  const draftRaw = frontmatter.draft;
  const draft = typeof draftRaw === "boolean" ? draftRaw : opts.draftByDefault;

  const prTitleRaw = frontmatter.pr_title;
  const prTitle = typeof prTitleRaw === "string" && prTitleRaw ? prTitleRaw : null;

  // Mirror Python: `_as_str_list(frontmatter.get("labels")) or list(default_labels)`
  // i.e. use frontmatter labels only if the result is non-empty; else fall back.
  const labelsRaw = "labels" in frontmatter ? asStrList(frontmatter.labels) : null;
  const labels = labelsRaw !== null && labelsRaw.length > 0 ? labelsRaw : [...opts.defaultLabels];

  const reviewers = asStrList(frontmatter.reviewers);

  let amendsPr: number | null = null;
  const amendsRaw = frontmatter.amends_pr;
  if (amendsRaw !== null && amendsRaw !== undefined) {
    try {
      const n = parseInt(String(amendsRaw).replace(/^#+/, ""), 10);
      amendsPr = Number.isNaN(n) ? null : n;
    } catch {
      amendsPr = null;
    }
  }

  const pushRemoteRaw = frontmatter.push_remote;
  const pushRemote =
    typeof pushRemoteRaw === "string" && pushRemoteRaw.trim() !== ""
      ? pushRemoteRaw.trim()
      : "origin";

  return {
    repo,
    baseBranch,
    branchName,
    draft,
    prTitle,
    labels,
    reviewers,
    amendsPr,
    pushRemote,
    forkNwo: null,
  };
}
