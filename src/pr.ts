/**
 * PR operations — faithful port of worker.py lines 1985-2081.
 *
 * Provides:
 *   - Commit      — {sha, subject} shape
 *   - countNewCommits    — rev-list --count sinceRef..HEAD
 *   - listNewCommits     — git log --format=%h%x09%s sinceRef..HEAD
 *   - commitLeftovers    — git add -A + git commit (gpgsign off, allow-empty-message)
 *   - pushBranch         — git push --set-upstream <remote> <branch> (remote defaults to origin)
 *   - openPullRequest    — gh pr create + URL extraction (--head <fork-owner>:<branch> for forks)
 *   - derivePrTitle      — ctx.prTitle → first H1 → task.id
 */

import { git, gh, GitOpError } from "./git.js";
import type { RepoContext } from "./repoContext.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Commit {
  sha: string;
  subject: string;
}

// ---------------------------------------------------------------------------
// countNewCommits
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `count_new_commits_since` (lines 1985-1990).
 * Returns the number of commits reachable from HEAD but not from sinceRef.
 * Returns 0 on any git error (e.g. bad ref).
 */
export async function countNewCommits(
  cfg: { gitBin: string },
  wtPath: string,
  sinceRef: string,
): Promise<number> {
  const result = await git(cfg, ["rev-list", "--count", `${sinceRef}..HEAD`], {
    cwd: wtPath,
    check: false,
  });
  if (result.code !== 0) return 0;
  return parseInt(result.stdout.trim() || "0", 10);
}

// ---------------------------------------------------------------------------
// listNewCommits
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `list_new_commits_since` (lines 2002-2014).
 * Returns commits between sinceRef (exclusive) and HEAD (inclusive),
 * newest first. Each entry has a short sha and subject line.
 *
 * The format `%h%x09%s` uses a literal tab (\x09) as delimiter between
 * short-sha and subject — split on first tab only.
 */
export async function listNewCommits(
  cfg: { gitBin: string },
  wtPath: string,
  sinceRef: string,
): Promise<Commit[]> {
  const result = await git(cfg, ["log", "--format=%h%x09%s", `${sinceRef}..HEAD`], {
    cwd: wtPath,
    check: false,
  });
  const commits: Commit[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.includes("\t")) {
      const tabIdx = line.indexOf("\t");
      const sha = line.slice(0, tabIdx);
      const subject = line.slice(tabIdx + 1);
      commits.push({ sha, subject });
    }
  }
  return commits;
}

// ---------------------------------------------------------------------------
// commitLeftovers
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `commit_leftovers` (lines 2025-2031).
 * Stages all changes and commits with the given message.
 * Uses `-c commit.gpgsign=false` to avoid GPG prompts.
 * Passes `--allow-empty-message` to allow an empty commit message.
 */
export async function commitLeftovers(
  cfg: { gitBin: string },
  wtPath: string,
  message: string,
): Promise<void> {
  await git(cfg, ["add", "-A"], { cwd: wtPath });
  await git(cfg, ["-c", "commit.gpgsign=false", "commit", "-m", message, "--allow-empty-message"], {
    cwd: wtPath,
  });
}

// ---------------------------------------------------------------------------
// pushBranch
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `push_branch` (lines 2034-2035).
 * Pushes the named branch with --set-upstream to `remote` (default "origin";
 * fork-PR mode threads through the ticket's `push_remote`).
 * Uses network retry and a 3-minute timeout. `retryBaseDelayMs` overrides the
 * retry backoff base (default 1000ms) — tests scripting offline pushes pass ~5ms.
 *
 * `forceWithLeaseSha` (issue #29 resume): when set, the push uses
 * `--force-with-lease=<branch>:<sha>` so a fresh retry can overwrite the stale
 * tip a crashed run left on the remote — but ONLY while the remote ref still
 * points where validation saw it (the lease rejects a push if someone else
 * has since moved the branch).
 */
export async function pushBranch(
  cfg: { gitBin: string },
  wtPath: string,
  branch: string,
  retryBaseDelayMs?: number,
  remote = "origin",
  forceWithLeaseSha?: string,
): Promise<void> {
  const args = ["push"];
  if (forceWithLeaseSha) args.push(`--force-with-lease=${branch}:${forceWithLeaseSha}`);
  args.push("--set-upstream", remote, branch);
  await git(cfg, args, {
    cwd: wtPath,
    timeoutMs: 180_000,
    retryNetwork: true,
    retryBaseDelayMs,
  });
}

// ---------------------------------------------------------------------------
// openPullRequest
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `open_pull_request` (lines 2038-2063).
 *
 * Builds the gh pr create argv faithfully:
 *   gh pr create --repo nwo --base ctx.baseBranch --head [<fork-owner>:]branch
 *                --title title --body-file bodyFile
 *                [--draft]
 *                [--label label …]   (skipped in fork mode — see openPullRequest)
 *                [--reviewer rv …]
 *
 * The PR URL is the LAST line of stdout that starts with "https://".
 * Throws GitOpError if none found (mirrors Python).
 */
export async function openPullRequest(
  cfg: { ghBin: string; worktreeRoot: string },
  ctx: RepoContext,
  nwo: string,
  title: string,
  bodyFile: string,
  retryBaseDelayMs?: number,
): Promise<string> {
  // Fork-PR mode: gh needs the cross-repo head form <fork-owner>:<branch>.
  const head =
    ctx.forkNwo !== null ? `${ctx.forkNwo.split("/")[0]}:${ctx.branchName}` : ctx.branchName;

  const argv: string[] = [
    "pr",
    "create",
    "--repo",
    nwo,
    "--base",
    ctx.baseBranch,
    "--head",
    head,
    "--title",
    title,
    "--body-file",
    bodyFile,
  ];

  if (ctx.draft) {
    argv.push("--draft");
  }

  // Fork PRs are label-free — the upstream label namespace is not ours (spec
  // etiquette invariant); skip the whole loop when in fork mode.
  if (ctx.forkNwo === null) {
    for (const label of ctx.labels) {
      argv.push("--label", label);
    }
  }

  for (const rv of ctx.reviewers) {
    argv.push("--reviewer", rv);
  }

  const result = await gh(cfg, argv, {
    cwd: cfg.worktreeRoot,
    timeoutMs: 120_000,
    retryNetwork: true,
    retryBaseDelayMs,
  });

  // Mirror Python: url = cp.stdout.strip().splitlines()[-1] if cp.stdout.strip() else ""
  const stripped = result.stdout.trim();
  const lines = stripped ? stripped.split("\n") : [];
  const url = lines.length > 0 ? lines[lines.length - 1].trim() : "";

  if (!url.startsWith("https://")) {
    throw new GitOpError(
      `gh pr create did not return a URL (stdout=${JSON.stringify(result.stdout)})`,
      result.stderr,
    );
  }

  return url;
}

// ---------------------------------------------------------------------------
// derivePrTitle
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `derive_pr_title` (lines 2073-2081).
 *
 * Priority:
 *   1. ctx.prTitle if set (non-null)
 *   2. Text after "# " from the first line in task.body that starts with "# "
 *      (trimmed); if that text is empty → task.id
 *   3. task.id
 */
export function derivePrTitle(
  ctx: Pick<RepoContext, "prTitle">,
  task: { id: string; body: string },
): string {
  if (ctx.prTitle) {
    return ctx.prTitle;
  }

  for (const line of task.body.split("\n")) {
    const s = line.trim();
    if (s.startsWith("# ")) {
      return s.slice(2).trim() || task.id;
    }
  }

  return task.id;
}
