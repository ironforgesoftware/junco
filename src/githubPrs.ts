/**
 * Pure fetch+map+filter core for junco-authored pull requests — a daemon/CLI-
 * safe location (unlike `tui/`) so both `junco prs` (src/prsCmd.ts) and the
 * dashboard's PRs view (src/tui/ghClient.ts `listPrs`) share ONE gh argv +
 * mapping and can't drift. `ghClient.listPrs` delegates here and layers its
 * own disk-cache/offline-serve wrapper on top; this module has no cache and
 * always throws on failure (the caller decides what "offline" means).
 */

import type { Config } from "./types.js";
import { gh } from "./git.js";
import { reduceChecks, ticketSlugFromBranch, type DashPr } from "./tui/prState.js";

/** `gh pr list --json` field list — the exact fields `DashPr` (+ `reduceChecks`)
 * are derived from. Exported so ghClient's tests (and any future caller) can
 * assert against the same constant instead of a hand-copied string. */
const PR_LIST_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "headRefName",
  "baseRefName",
  "isDraft",
  "state",
  "reviewDecision",
  "statusCheckRollup",
  "mergeable",
  "mergeStateStatus",
  "additions",
  "deletions",
  "changedFiles",
  "createdAt",
  "updatedAt",
  "mergedAt",
  "labels",
  "author",
].join(",");

interface RawPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  state: string;
  reviewDecision: string | null;
  statusCheckRollup: unknown;
  mergeable: string | null;
  mergeStateStatus: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  labels: { name: string }[];
  // Nullable: GitHub's GraphQL author is null for a deleted account. Guarded
  // before deref so one such PR can't throw and blank the whole repo (#135).
  author: { login: string } | null;
}

export interface GithubPrsDeps {
  ghFn?: typeof gh;
}

const GH_TIMEOUT = 30_000;

/**
 * `gh pr list --repo <nwo> --state all --limit 50`, mapped to `DashPr[]` and
 * filtered to junco-authored PRs only (head branch under `cfg.branchPrefix` —
 * the filter that recovers the free ticket linkage, see `ticketSlugFromBranch`).
 * Throws on any gh/parse failure — callers that want offline/cache behavior
 * (ghClient.listPrs) wrap this call themselves.
 */
export async function fetchJuncoPrs(
  cfg: Config,
  nwo: string,
  deps: GithubPrsDeps = {},
): Promise<DashPr[]> {
  const ghFn = deps.ghFn ?? gh;
  const r = await ghFn(
    cfg,
    ["pr", "list", "--repo", nwo, "--state", "all", "--limit", "50", "--json", PR_LIST_JSON_FIELDS],
    { timeoutMs: GH_TIMEOUT, retryNetwork: true },
  );
  const raw = JSON.parse(r.stdout) as RawPr[];
  return (
    raw
      // A deleted-account PR (null author) is treated as non-junco and skipped
      // BEFORE the branch filter — the deref below would otherwise throw and drop
      // every PR in this repo from `junco prs` and the dashboard (#135).
      .filter((p): p is RawPr & { author: { login: string } } => p.author?.login != null)
      .map(
        (p): DashPr => ({
          number: p.number,
          title: p.title,
          url: p.url,
          headRefName: p.headRefName,
          baseRefName: p.baseRefName,
          isDraft: p.isDraft,
          state: p.state,
          reviewDecision: p.reviewDecision,
          mergeable: p.mergeable,
          mergeStateStatus: p.mergeStateStatus,
          checks: reduceChecks(p.statusCheckRollup),
          additions: p.additions,
          deletions: p.deletions,
          changedFiles: p.changedFiles,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          mergedAt: p.mergedAt,
          author: p.author.login,
          labels: p.labels.map((l) => l.name),
          nwo,
        }),
      )
      .filter((p) => ticketSlugFromBranch(p.headRefName, cfg.branchPrefix) !== null)
  );
}
