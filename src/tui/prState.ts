/**
 * Pure lifecycle derivation for junco-authored pull requests. A PR's dashboard
 * state is a function of its GitHub-reported fields ONLY (state, draft flag,
 * reduced checks, review decision) — the dashboard holds no queue state of its
 * own. Precedence: terminal states (merged/closed) shadow everything else;
 * draft shadows checks/review (a draft is never "ready" regardless of CI);
 * failing checks outrank a requested-changes review, which outranks pending
 * checks, which outranks an approval (the operator should see the worst news
 * first).
 */

export type PrLifecycle =
  | "merged"
  | "closed"
  | "draft"
  | "checks-failing"
  | "changes-requested"
  | "checks-pending"
  | "approved"
  | "review-pending";

export interface DashPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  state: string; // OPEN | CLOSED | MERGED (gh pr list --json state)
  reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null/""
  mergeable: string | null; // MERGEABLE | CONFLICTING | UNKNOWN
  mergeStateStatus: string | null;
  checks: { pass: number; fail: number; pending: number; total: number };
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  author: string;
  labels: string[];
  nwo: string; // injected by the caller — not part of the gh JSON payload
}

export function derivePrState(pr: DashPr): PrLifecycle {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  if (pr.checks.fail > 0) return "checks-failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (pr.checks.pending > 0) return "checks-pending";
  if (pr.reviewDecision === "APPROVED") return "approved";
  return "review-pending";
}

// Semantic palette only (mirrors state.ts's stateMeta conventions) — NEVER theme.accent.
const META: Record<PrLifecycle, { glyph: string; color: string; badge: string }> = {
  "checks-failing": { glyph: "✗", color: "red", badge: "checks-failing" },
  "changes-requested": { glyph: "●", color: "magenta", badge: "changes-requested" },
  "checks-pending": { glyph: "◐", color: "yellow", badge: "checks-pending" },
  "review-pending": { glyph: "◔", color: "cyan", badge: "review-pending" },
  approved: { glyph: "●", color: "blue", badge: "approved" },
  merged: { glyph: "✓", color: "green", badge: "merged" },
  closed: { glyph: "⊘", color: "gray", badge: "closed" },
  draft: { glyph: "○", color: "gray", badge: "draft" },
};

export function prStateMeta(s: PrLifecycle): { glyph: string; color: string; badge: string } {
  return META[s];
}

/** Longest lifecycle badge — the pill column's shared inner width. */
export const MAX_PR_BADGE_LEN = Math.max(...Object.values(META).map((m) => m.badge.length));

/** Reduce a `statusCheckRollup` array (gh pr list --json statusCheckRollup) to
 * pass/fail/pending counts. Elements are either CheckRun-shaped
 * (`status`/`conclusion`) or legacy StatusContext-shaped (`state`). Anything
 * that isn't an array (null, undefined, a scalar) reduces to all-zero. */
export function reduceChecks(rollup: unknown): {
  pass: number;
  fail: number;
  pending: number;
  total: number;
} {
  if (!Array.isArray(rollup)) return { pass: 0, fail: 0, pending: 0, total: 0 };

  let pass = 0;
  let fail = 0;
  let pending = 0;

  for (const item of rollup) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;

    if (typeof rec.status === "string") {
      // CheckRun-shaped.
      if (rec.status !== "COMPLETED") {
        pending++;
        continue;
      }
      const conclusion = typeof rec.conclusion === "string" ? rec.conclusion : "";
      if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
        pass++;
      } else if (conclusion === "") {
        pending++;
      } else {
        fail++;
      }
    } else if (typeof rec.state === "string") {
      // StatusContext-shaped.
      if (rec.state === "SUCCESS") {
        pass++;
      } else if (rec.state === "PENDING" || rec.state === "EXPECTED") {
        pending++;
      } else {
        fail++;
      }
    }
    // Unrecognized shape: neither counted nor totaled.
  }

  return { pass, fail, pending, total: pass + fail + pending };
}

/**
 * Port-adjacent to `deriveBranchName` (src/repoContext.ts): a branch is
 * `<prefix ending in "/"><slug>`. Given the branch and the configured prefix,
 * recover the slug — the free ticket linkage a junco-authored PR carries in
 * its own branch name. Returns null when the branch doesn't start with the
 * (normalized) prefix, or when the remainder after the prefix is empty.
 */
export function ticketSlugFromBranch(headRefName: string, branchPrefix: string): string | null {
  const prefix = branchPrefix.endsWith("/") ? branchPrefix : branchPrefix + "/";
  if (!headRefName.startsWith(prefix)) return null;
  const slug = headRefName.slice(prefix.length);
  return slug === "" ? null : slug;
}

// Sort groups: failing/changes-requested (worst news) → pending/review → approved
// (ready to merge) → draft (not actionable yet) → terminal (merged/closed).
const GROUP: Record<PrLifecycle, number> = {
  "checks-failing": 0,
  "changes-requested": 0,
  "review-pending": 1,
  "checks-pending": 1,
  approved: 2,
  draft: 3,
  merged: 4,
  closed: 4,
};

export function sortPrs(prs: DashPr[]): DashPr[] {
  return [...prs].sort((a, b) => {
    const ga = GROUP[derivePrState(a)];
    const gb = GROUP[derivePrState(b)];
    if (ga !== gb) return ga - gb;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });
}

/** Live `/` filter: case-insensitive substring across #number, title, nwo, and
 * the derived lifecycle badge. Blank query returns the input array identity
 * (cheap no-op). */
export function filterPrs(prs: DashPr[], q: string): DashPr[] {
  const s = q.trim().toLowerCase();
  if (s === "") return prs;
  return prs.filter((p) => {
    const badge = prStateMeta(derivePrState(p)).badge;
    return (
      `#${p.number}`.includes(s) ||
      p.title.toLowerCase().includes(s) ||
      p.nwo.toLowerCase().includes(s) ||
      badge.includes(s)
    );
  });
}
