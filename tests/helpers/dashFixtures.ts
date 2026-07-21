/**
 * Shared dashboard/domain fixtures.
 *
 * Replaces three families of hand-copied literals that differed only in dummy
 * values:
 *   - six `DashPr` builders (tuiApp, tuiPrPreview, tuiPrList, tuiPrColumns,
 *     tuiPrState, prsCmd),
 *   - six `DashIssue` builders (tuiApp, tuiIssueList, tuiState, tuiPreview,
 *     tuiPrimitives, tuiIssueColumns),
 *   - five copies of the same `GhAuthContext` literal (botAccess, git, cli,
 *     externalDispatch, tuiGhClient — the last three even carried a comment
 *     pointing at each other).
 *
 * Types come from `src/` so a contract change breaks the fixtures at compile
 * time instead of drifting. Call sites keep thin wrappers where they need
 * site-specific dummies (repo nwo, timestamps, author); everything a test does
 * not care about now has exactly one definition.
 */
import type { DashPr } from "../../src/tui/prState.js";
import type { DashIssue } from "../../src/tui/state.js";
import type { GhAuthContext } from "../../src/types.js";

/**
 * Baseline dashboard PR: OPEN, non-draft, mergeable, all checks green, no
 * review decision — i.e. `derivePrState` → "review-pending". `url`,
 * `headRefName` and `title` derive from `number`, and the head branch carries
 * the `junco/` prefix so it survives the dashboard's branch-prefix filter.
 */
export function makeDashPr(overrides: Partial<DashPr> = {}): DashPr {
  const number = overrides.number ?? 1;
  return {
    number,
    title: `Test PR #${number}`,
    url: `https://github.com/a/b/pull/${number}`,
    headRefName: `junco/task-${number}`,
    baseRefName: "main",
    isDraft: false,
    state: "OPEN",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checks: { pass: 2, fail: 0, pending: 0, total: 2 },
    additions: 5,
    deletions: 3,
    changedFiles: 2,
    createdAt: "2026-07-06T14:00:00Z",
    updatedAt: "2026-07-07T13:00:00Z",
    mergedAt: null,
    author: "junco-bot",
    labels: [],
    nwo: "a/b",
    ...overrides,
  };
}

/**
 * Baseline dashboard issue: trigger-labelled only — i.e. `deriveState` → "raw".
 * `url` and `title` derive from `number`; `author` is null (non-bot).
 */
export function makeDashIssue(overrides: Partial<DashIssue> = {}): DashIssue {
  const number = overrides.number ?? 1;
  return {
    number,
    title: `Issue #${number}`,
    labels: ["junco"],
    updatedAt: "2026-07-07T13:00:00Z",
    url: `https://github.com/a/b/issues/${number}`,
    author: null,
    ...overrides,
  };
}

/** The bot-auth context every gh/git identity test injects. */
export const GH_AUTH_CTX: GhAuthContext = {
  configDir: "/sbx/junco-gh",
  login: "junco-agent",
  email: "1234+junco-agent@users.noreply.github.com",
  credentialHelper: "!gh auth git-credential",
};
