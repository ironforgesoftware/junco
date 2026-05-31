import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RepoContext {
  repo: string;            // absolute path
  baseBranch: string;
  branchName: string;
  draft: boolean;
  prTitle: string | null;
  labels: string[];
  reviewers: string[];
  amendsPr: number | null;
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
 * Port of worker.py `_derive_branch_name` (lines 342-346).
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
 * Port of worker.py `_as_str_list` (lines 349-356).
 * - string  → split on commas, trim, drop empties
 * - array   → map String() + trim, drop empties
 * - null/undefined → []
 * - anything else  → [String(v)] (mirrors Python `return [str(v)]`)
 */
export function asStrList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    return v
      .filter((x) => x !== null && x !== undefined && String(x).trim() !== "")
      .map((x) => String(x).trim());
  }
  if (typeof v === "string") {
    return v.split(",").map((p) => p.trim()).filter(Boolean);
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
 * Port of worker.py `derive_repo_context` (lines 359-399).
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

  const baseBranch =
    typeof frontmatter.base_branch === "string"
      ? frontmatter.base_branch
      : opts.defaultBaseBranch;

  const branchName =
    frontmatter.branch_name
      ? String(frontmatter.branch_name)
      : deriveBranchName(taskId, opts.branchPrefix);

  const draftRaw = frontmatter.draft;
  const draft =
    typeof draftRaw === "boolean" ? draftRaw : opts.draftByDefault;

  const prTitleRaw = frontmatter.pr_title;
  const prTitle =
    typeof prTitleRaw === "string" && prTitleRaw ? prTitleRaw : null;

  // Mirror Python: `_as_str_list(frontmatter.get("labels")) or list(default_labels)`
  // i.e. use frontmatter labels only if the result is non-empty; else fall back.
  const labelsRaw = "labels" in frontmatter ? asStrList(frontmatter.labels) : null;
  const labels = labelsRaw !== null && labelsRaw.length > 0 ? labelsRaw : [...opts.defaultLabels];

  const reviewers = asStrList(frontmatter.reviewers);

  let amendsPr: number | null = null;
  const amendsRaw = frontmatter.amends_pr;
  if (amendsRaw !== null && amendsRaw !== undefined) {
    try {
      const n = parseInt(String(amendsRaw).replace(/^#/, ""), 10);
      amendsPr = Number.isNaN(n) ? null : n;
    } catch {
      amendsPr = null;
    }
  }

  return {
    repo,
    baseBranch,
    branchName,
    draft,
    prTitle,
    labels,
    reviewers,
    amendsPr,
  };
}
