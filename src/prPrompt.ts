/**
 * PR-flow agent preamble builder — faithful port of worker.py:
 *   - build_prompt_with_repo_context  (lines 2084-2126)
 *   - _build_amend_preamble           (lines 2129-2154)
 *
 * 2026-08-31: the "Working discipline" blocks absorbed the ticket-side
 * "Notes for the agent (strict)" rules (trust-the-ticket, no-scope-expansion,
 * graceful-stop-on-mismatch, final-summary) so the worker — not each
 * dispatched ticket — owns this discipline. `todo_write` was removed from
 * both preambles: it is not a tool that exists in the agent layer.
 */

import type { RepoContext } from "./repoContext.js";
import type { AmendTarget } from "./repo.js";

export interface PrPromptTask {
  id: string;
  body: string;
}

export interface PrPromptOpts {
  /** When provided (non-null), triggers the amend preamble path. */
  amendTarget?: AmendTarget | null;
  /**
   * Rule 3 wording toggle.
   *   true  — legacy/omp: "Junco will sweep any uncommitted work…"
   *   false — Pi-strict (the TS default): "You must commit your work yourself."
   */
  commitLeftoversEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Port of worker.py `build_prompt_with_repo_context` (lines 2084-2126) and
 * `_build_amend_preamble` (lines 2129-2154).
 *
 * Builds the full prompt sent to the PR-flow agent: a repo-context preamble
 * followed by the ticket body.
 *
 * - Fresh ticket (!amendTarget): "## Repo context (worker-provided)" preamble
 *   with commit rules + working-discipline rules, then `---\n\n` + task.body.
 * - Amend ticket (amendTarget provided): amend-mode preamble, then task.body.
 *
 * Default for `commitLeftoversEnabled` is `false` (Pi-strict).
 */
export function buildPromptWithRepoContext(
  task: PrPromptTask,
  ctx: RepoContext,
  wtPath: string,
  nwo: string,
  opts: PrPromptOpts,
): string {
  const { amendTarget = null, commitLeftoversEnabled = false } = opts;

  if (amendTarget !== null) {
    return _buildAmendPreamble(ctx, wtPath, nwo, amendTarget) + task.body;
  }

  return _buildFreshPreamble(ctx, wtPath, nwo, commitLeftoversEnabled) + task.body;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Port of the fresh-ticket preamble in `build_prompt_with_repo_context`
 * (worker.py lines 2094-2125).
 */
function _buildFreshPreamble(
  ctx: RepoContext,
  wtPath: string,
  nwo: string,
  commitLeftoversEnabled: boolean,
): string {
  // Rule #3 text differs by mode (mirror worker.py lines 2094-2103).
  let ruleThree: string;
  if (commitLeftoversEnabled) {
    ruleThree =
      "3. **Do not** `git push`, open a PR, or otherwise touch the remote — the worker handles that after you're done. " +
      "Junco will sweep any uncommitted work into a final commit if you forget, but it's better if you commit cleanly yourself with real messages.\n";
  } else {
    ruleThree =
      "3. **Do not** `git push`, open a PR, or otherwise touch the remote — the worker handles that after you're done. " +
      "**You must commit your work yourself.** Junco will NOT sweep leftovers in this mode — if you exit with uncommitted changes, the ticket fails loud (no PR opens). Commit before you stop.\n";
  }

  return (
    "## Repo context (worker-provided)\n\n" +
    "You are running inside a fresh git worktree:\n\n" +
    `- Worktree path:   ${wtPath}\n` +
    `- Branch:          ${ctx.branchName}\n` +
    `- Base branch:     ${ctx.baseBranch}   (do not modify; it's the merge target)\n` +
    `- Repo:            ${nwo}\n\n` +
    "## Commit rules\n\n" +
    "1. Make changes and **commit them** with descriptive messages. Prefer multiple small commits over one giant commit when the work has logically separate parts.\n" +
    "2. Commit on this worktree (your cwd is already set here).\n" +
    ruleThree +
    `4. **Do not** switch branches. Stay on ${ctx.branchName}.\n\n` +
    "## Working discipline (strict — loops waste 20+ minutes of wall clock)\n\n" +
    "5. **Trust the ticket body below.** File paths, line numbers, and commands in it were verified by the dispatcher. Do not re-explore the repo to double-check them.\n" +
    "6. When the plan numbers its steps, commit exactly once per step. Suggested commit messages are suggestions — a better one is fine.\n" +
    "7. **Do not expand scope.** An issue not in the plan goes in your final summary, not in the diff.\n" +
    "8. The `write` and `edit` tools return `unchanged` when the file already matches the content you tried to write. That's your strong signal that it's already correct — move on. Do not retry, do not re-read; the tool layer is authoritative.\n" +
    "9. After you run `git commit` via the `bash` tool and it exits 0, the commit is real. **Do not** run `git log`, `git status`, or `git diff` to 'verify' — these verification calls have never changed the outcome and add latency. Trust the tool's exit code.\n" +
    "10. **Do not run the ticket's `## Verification` block.** Junco runs it automatically after your session — running it yourself wastes turns and tokens. When a step is done, move to the next; do not re-inspect completed work.\n" +
    "11. **Graceful stop on spec mismatch.** If the ticket doesn't match reality (a file already exists with content the plan doesn't anticipate, a precondition has changed, the work is already done, or you cannot complete it as specified), output a single sentence explaining the mismatch and stop. Do NOT loop trying to reconcile — junco's supervisor will kill the session and the ticket lands in failed/ with no useful information; your sentence becomes the failure note that lets the dispatcher fix and re-dispatch.\n" +
    "12. **Final summary** (2–3 sentences at session end): what you did and any surprises. Junco's loop guards (text-rep, tool-call literal-rep, tool-error rep) abort stuck sessions — just make progress and they won't fire.\n\n" +
    "---\n\n"
  );
}

/**
 * Port of worker.py `_build_amend_preamble` (lines 2129-2154).
 */
function _buildAmendPreamble(
  ctx: RepoContext,
  wtPath: string,
  nwo: string,
  target: AmendTarget,
): string {
  return (
    "## Repo context (worker-provided) — AMEND MODE\n\n" +
    `You are **amending an existing open PR**, not starting fresh. Previous commits are already present on this branch.\n\n` +
    `- Worktree path:   ${wtPath}\n` +
    `- Branch:          ${ctx.branchName}   (already on origin; do NOT rename or recreate)\n` +
    `- Base branch:     ${ctx.baseBranch}   (do not modify)\n` +
    `- Repo:            ${nwo}\n` +
    `- PR being amended: #${target.prNumber}   ${target.prUrl}\n\n` +
    "## Amendment rules\n\n" +
    "1. Read the ticket body below — it describes what needs changing on the existing PR. The existing PR's prior commits are your starting point; do not try to re-do their work.\n" +
    "2. Add **new commits** on top of what's already there. Do NOT amend, squash, rebase, or force-change prior commits — that would require a force-push and the worker won't do one.\n" +
    "3. Commit messages should describe the amendment (e.g. `fix: address review feedback on X`, `refactor: extract Y per review`) — not re-describe the original work.\n" +
    "4. **Do not** `git push` or touch the remote yourself. The worker pushes your new commits to the same branch when you're done, which auto-updates the existing PR.\n" +
    `5. **Do not** switch branches. Stay on ${ctx.branchName}.\n\n` +
    "## Working discipline (strict — loops waste 20+ minutes of wall clock)\n\n" +
    "6. The `write` and `edit` tools return `unchanged` when the file already matches your intended content — that's the strong signal that it's already correct. Don't retry, don't re-read.\n" +
    "7. After `git commit` exits 0, the commit is real. **Do not** run `git log`, `git status`, or `git diff` to verify.\n" +
    "8. **Do not run the ticket's `## Verification` block.** Junco runs it automatically.\n" +
    "9. **Do not re-inspect prior commits** on this branch (the ones from the original PR). Trust that they're present; focus on the amendments.\n" +
    "10. Junco's loop guards (text-rep, tool-call literal-rep, tool-error rep) will abort the session if you get stuck. Just make progress.\n" +
    "11. **Graceful stop on spec mismatch.** If the ticket doesn't match reality (a file already exists with content the plan doesn't anticipate, a precondition has changed, the work is already done, or you cannot complete it as specified), output a single sentence explaining the mismatch and stop. Do NOT loop trying to reconcile — junco's supervisor will kill the session and the ticket lands in failed/ with no useful information; your sentence becomes the failure note that lets the dispatcher fix and re-dispatch.\n" +
    "12. **Final summary** (2–3 sentences at session end): what you amended and any surprises.\n\n" +
    "---\n\n"
  );
}
