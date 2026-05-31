/**
 * PR-flow orchestration — faithful port of worker.py `_run_pr_flow`
 * (lines 3032-3311), `_build_pr_body` (2770-2827), and `PrOutcome` (2320-2338).
 *
 * Phase sequence: validate → plan-lint → worktree → agent → (hard-exit check)
 * → commits/since-ref → no-commits gate → post-session review (verify + critic
 * + optional corrective re-dispatch) → verification gate → push → open/amend PR
 * → cleanup → finalize.
 *
 * Every error path routes to `finalizePr(... failed)` with a `phaseError`.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Config, Ticket, RunResult } from "./types.js";
import type { RepoContext } from "./repoContext.js";
import { isAmend } from "./repoContext.js";
import { GitOpError, git } from "./git.js";
import { validateRepoContext, resolveAmendTarget, type AmendTarget } from "./repo.js";
import {
  prepareWorktree,
  cleanupWorktree,
  currentHeadSha,
} from "./worktree.js";
import {
  countNewCommits,
  listNewCommits,
  commitLeftovers,
  pushBranch,
  openPullRequest,
  derivePrTitle,
  type Commit,
} from "./pr.js";
import { lintTicket, LabelCache, formatViolations } from "./planLint.js";
import { runSpecVerification, type VerificationResult } from "./verify.js";
import { runCriticPass, buildCorrectivePrompt, type CriticResult } from "./critic.js";
import { buildPromptWithRepoContext } from "./prPrompt.js";
import {
  runAgent,
  makePiSessionFactory,
  type AgentSessionLike,
} from "./agent/session.js";
import { GuardManager } from "./agent/guardManager.js";
import { finalizePr, type TerminalDirs } from "./finalize.js";
import { log } from "./logging.js";

// ---------------------------------------------------------------------------
// PrOutcome — PR-flow side metadata (port of worker.py PrOutcome, 2320-2338).
// ---------------------------------------------------------------------------

export interface PrOutcome {
  statusOverride: string | null;
  nwo: string | null;
  branch: string | null;
  baseBranch: string | null;
  prUrl: string | null;
  commits: Commit[];
  pushed: boolean;
  worktreePath: string | null;
  worktreePreserved: boolean;
  amendedPrNumber: number | null;
  verification: VerificationResult | null;
  critic: CriticResult | null;
  criticRetriesUsed: number;
}

function emptyPrOutcome(ctx: RepoContext): PrOutcome {
  return {
    statusOverride: null,
    nwo: null,
    branch: ctx.branchName,
    baseBranch: ctx.baseBranch,
    prUrl: null,
    commits: [],
    pushed: false,
    worktreePath: null,
    worktreePreserved: false,
    amendedPrNumber: null,
    verification: null,
    critic: null,
    criticRetriesUsed: 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Module-level label cache (parity with worker.py `_LABEL_CACHE`) — keeps
// back-to-back tickets to the same repo from repeating the `gh label list` call.
const LABEL_CACHE = new LabelCache();

/** Port of worker.py `_empty_run_result`: a synthetic RunResult for phases that
 * fail before (or instead of) an agent run. errorMessage carries the reason. */
function emptyRunResult(phaseError: string): RunResult {
  return {
    finalText: "",
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
    stopReason: null,
    errorMessage: phaseError,
    timedOut: false,
    durationMs: 0,
    abortedByGuard: false,
  };
}

/** Port of worker.py `_format_plan_lint_phase_error`. */
function formatPlanLintPhaseError(errors: { rule: string; message: string }[]): string {
  const parts = errors.map((v) => `${v.rule}: ${v.message.split(".")[0]}`);
  return "plan-lint: " + parts.join("; ");
}

/** Port of worker.py `worktree_is_dirty`: `git status --porcelain` non-empty. */
async function worktreeIsDirty(cfg: Config, wtPath: string): Promise<boolean> {
  const cp = await git(cfg, ["status", "--porcelain"], { cwd: wtPath, check: false });
  return cp.stdout.trim().length > 0;
}

/** Format an elapsed seconds count (parity with worker.py `_fmt_duration`). */
function fmtDuration(seconds: number): string {
  if (seconds < 0) return "?";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

// ---------------------------------------------------------------------------
// buildPrBody — port of worker.py `_build_pr_body` (2770-2827).
// ---------------------------------------------------------------------------

export function buildPrBody(
  task: Ticket,
  _ctx: RepoContext,
  prOutcome: PrOutcome,
  result: RunResult,
): string {
  const parts: string[] = [];

  if (result.abortedByGuard) {
    parts.push(
      "> ⚠️ **Partial run.** This PR was opened from a run that the junco " +
        "repetition guard aborted mid-session — the agent had made real commits " +
        "before the loop, so the branch was salvaged. Review the diff carefully; " +
        "the work may be incomplete. Consider an amendment ticket to finish.",
    );
  }

  // Critic banner (pass / missing).
  const critic = prOutcome.critic;
  if (critic && critic.status === "missing") {
    const retryNote =
      prOutcome.criticRetriesUsed > 0
        ? " (one corrective re-dispatch attempted; result: still missing)"
        : "";
    parts.push(
      `> ⚠️ **Critic flagged missing items${retryNote}:** ` +
        `${critic.findings || "(no detail)"}\n` +
        "> The diff may not fully implement the spec. Review carefully.",
    );
  } else if (critic && critic.status === "pass") {
    parts.push("> ✅ **Critic pass:** diff aligns with the in-scope items of the spec.");
  }

  // Verification banner (pass / fail counts + failed snippets).
  const verification = prOutcome.verification;
  if (verification && verification.blocksRun > 0 && verification.failedOutputs.length > 0) {
    const failedLines: string[] = [];
    for (const { preview, exitCode, output } of verification.failedOutputs.slice(0, 5)) {
      const snip = output.trim().slice(0, 300);
      failedLines.push(`  - \`${preview}\` → exit ${exitCode}\n    \`\`\`\n    ${snip}\n    \`\`\``);
    }
    parts.push(
      `> ⚠️ **Spec verification: ${verification.blocksPassed}/${verification.blocksRun} checks passed.** Failures:\n` +
        failedLines.join("\n"),
    );
  } else if (verification && verification.blocksRun > 0) {
    parts.push(`> ✅ **Spec verification:** ${verification.blocksPassed}/${verification.blocksRun} checks passed.`);
  }

  const body = task.body.trim();
  if (body) parts.push("## Ticket\n\n" + body);

  const summary = result.finalText ? result.finalText.trim() : "";
  if (summary) parts.push("## Agent summary\n\n" + summary);

  if (prOutcome.commits.length > 0) {
    parts.push(
      "## Commits\n\n" +
        prOutcome.commits.map((c) => `- \`${c.sha}\` ${c.subject}`).join("\n"),
    );
  }

  const metadataLines = [
    `- Elapsed: ${fmtDuration(Math.round(result.durationMs / 1000))}`,
    `- Tool calls: ${result.toolCalls.length}`,
    `- Tokens: in=${result.usage.input} · out=${result.usage.output} · total=${result.usage.total}`,
    `- Stop reason: \`${result.stopReason}\``,
  ];
  if (result.abortedByGuard) metadataLines.push("- **Aborted by repetition guard:** yes");
  metadataLines.push(`- Generated by junco ticket \`${task.id}\``);
  parts.push("## Run metadata\n\n" + metadataLines.join("\n"));

  return parts.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// runPrFlow — port of worker.py `_run_pr_flow` (3032-3311).
// ---------------------------------------------------------------------------

export interface PrFlowDeps {
  /** Inject the worker agent session factory (tests pass a fake that commits). */
  sessionFactoryFor?: (cfg: Config, cwd: string) => () => Promise<AgentSessionLike>;
  /** Inject the critic session factory (tests control the PASS/MISSING verdict). */
  criticSessionFactory?: () => Promise<AgentSessionLike>;
  /** Terminal dirs override (tests). Defaults to queuePaths(cfg). */
  dirs?: TerminalDirs;
}

export async function runPrFlow(
  cfg: Config,
  task: Ticket,
  claimedPath: string,
  ctx: RepoContext,
  deps: PrFlowDeps = {},
): Promise<string> {
  const dirs: TerminalDirs = deps.dirs ?? defaultDirs(cfg);
  const prOutcome = emptyPrOutcome(ctx);
  let amendTarget: AmendTarget | null = null;

  // --- Phase 1: Validate (no worktree yet — lint can reject before setup). ---
  let nwo: string;
  try {
    nwo = await validateRepoContext(cfg, ctx); // mutates ctx in amend mode
    prOutcome.nwo = nwo;
    if (isAmend(ctx)) {
      amendTarget = await resolveAmendTarget(cfg, ctx, nwo);
      prOutcome.amendedPrNumber = amendTarget.prNumber;
      prOutcome.prUrl = amendTarget.prUrl; // prelim; refreshed after push
      prOutcome.branch = ctx.branchName;
      prOutcome.baseBranch = ctx.baseBranch;
    }
  } catch (e) {
    if (!(e instanceof GitOpError)) throw e;
    const msg = e.message;
    log.error(`pr-flow pre-check failed for ${claimedPath}: ${msg}`);
    return finalizePr(claimedPath, emptyRunResult(msg), prOutcome, { dirs, phaseError: msg });
  }

  // --- Phase 2: Plan-lint gate. ---
  if (cfg.planLintEnabled) {
    const lint = lintTicket(task.body, task.frontmatter, {
      repoNwo: nwo,
      repoPath: ctx.repo,
      checkLabels: cfg.planLintCheckLabels,
      labelCache: LABEL_CACHE,
    });
    for (const w of lint.warnings) {
      log.warn(`plan-lint warning [${w.rule}] for ${task.id}: ${w.message}`);
    }
    if (!lint.ok && cfg.planLintBlockOnError) {
      for (const v of lint.errors) {
        log.warn(`plan-lint error [${v.rule}] for ${task.id}: ${v.message}`);
      }
      const phaseError = formatPlanLintPhaseError(lint.errors);
      log.warn(`plan-lint blocked ${task.id}; not setting up worktree`);
      return finalizePr(claimedPath, emptyRunResult(phaseError), prOutcome, { dirs, phaseError });
    }
  }

  // --- Phase 3: Worktree setup (only after lint clears). ---
  let wtPath: string;
  let preRunHead: string;
  try {
    wtPath = await prepareWorktree(cfg, ctx, task.id);
    prOutcome.worktreePath = wtPath;
    preRunHead = await currentHeadSha(cfg, wtPath);
  } catch (e) {
    if (!(e instanceof GitOpError)) throw e;
    const msg = e.message;
    log.error(`pr-flow pre-check failed for ${claimedPath}: ${msg}`);
    return finalizePr(claimedPath, emptyRunResult(msg), prOutcome, { dirs, phaseError: msg });
  }

  // --- Phase 4: Run the agent in the worktree. ---
  const prompt = buildPromptWithRepoContext(task, ctx, wtPath, nwo, {
    amendTarget,
    commitLeftoversEnabled: cfg.commitLeftoversEnabled,
  });
  const guardManager = cfg.supervisorEnabled
    ? new GuardManager({
        supervisorConfig: {
          budgetPerKind: cfg.supervisorBudgetPerKind,
          escalationWindowTurns: cfg.supervisorEscalationWindow,
        },
        outputBudgetPerTurn: cfg.supervisorOutputBudgetPerTurn,
        outputBudgetPostCommit: cfg.supervisorOutputBudgetPostCommit,
      })
    : undefined;
  const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(cfg, wtPath);
  let result = await runAgent({
    body: prompt,
    cwd: wtPath,
    timeoutMs: task.timeoutSeconds * 1000,
    createSession: factory,
    guardManager,
  });

  // --- Phase 5: Hard-exit check (timeout or non-guard error). ---
  // A guard abort is a SOFT abort — continue through post-processing.
  const hardExit = result.timedOut || (result.errorMessage !== null && !result.abortedByGuard);
  if (hardExit) {
    prOutcome.worktreePreserved = true;
    return finalizePr(claimedPath, result, prOutcome, { dirs });
  }

  // --- Phases 6-13: commits, push, PR. Any GitOpError → preserve + failed. ---
  try {
    // Phase 6: since-ref (amend: pre-run HEAD; fresh: origin/<base>).
    const sinceRef = isAmend(ctx) ? preRunHead : `origin/${ctx.baseBranch}`;
    let newCommits = await countNewCommits(cfg, wtPath, sinceRef);
    const dirty = await worktreeIsDirty(cfg, wtPath);
    if (newCommits === 0 && dirty) {
      if (cfg.commitLeftoversEnabled) {
        log.warn("no commits but wt dirty; committing leftovers");
        await commitLeftovers(cfg, wtPath, `junco: ${task.id} (leftovers)`);
        newCommits = await countNewCommits(cfg, wtPath, sinceRef);
      } else {
        log.warn("no commits but wt dirty; commit_leftovers disabled — failing loud");
      }
    }

    // Phase 7: list commits.
    prOutcome.commits = await listNewCommits(cfg, wtPath, sinceRef);

    // Phase 8: no-commits gate.
    if (newCommits === 0) {
      if (result.stopReason === "error") {
        const phaseError =
          "agent errored mid-session (stop_reason='error', " +
          `${result.usage.output} output tokens) — likely transient inference-side ` +
          "failure, not a successful no-changes outcome";
        prOutcome.worktreePreserved = true;
        log.warn(`${phaseError} — preserving worktree, routing to failed`);
        return finalizePr(claimedPath, result, prOutcome, { dirs, phaseError });
      }
      if (result.stopReason === "length") {
        const phaseError =
          "agent truncated by inference engine (stop_reason='length', " +
          `${result.usage.output} output tokens) — model was generating runaway ` +
          "thinking or output without converging on a tool call; likely a stall";
        prOutcome.worktreePreserved = true;
        log.warn(`${phaseError} — preserving worktree, routing to failed`);
        return finalizePr(claimedPath, result, prOutcome, { dirs, phaseError });
      }
      prOutcome.statusOverride = "completed_no_changes";
      log.info(`no-changes outcome for ${claimedPath}; skipping ${isAmend(ctx) ? "PR-update" : "PR"}`);
      if (cfg.removeWorktreeOnSuccess) await cleanupWorktree(cfg, ctx, wtPath);
      return finalizePr(claimedPath, result, prOutcome, { dirs });
    }

    // Phase 9: post-session review (skip on a guard-aborted session).
    const skipPostSessionReview = result.abortedByGuard;
    if (!skipPostSessionReview) {
      prOutcome.verification = await runSpecVerification(cfg, task, wtPath);
      if (prOutcome.verification.skippedReason) {
        log.info(`spec verification: skipped (${prOutcome.verification.skippedReason})`);
      } else {
        log.info(
          `spec verification: ${prOutcome.verification.blocksPassed}/${prOutcome.verification.blocksRun} checks passed`,
        );
      }

      const critic = await runCriticPass(cfg, task, wtPath, sinceRef, {
        criticSessionFactory: deps.criticSessionFactory,
      });
      prOutcome.critic = critic;
      log.info(`critic: ${critic.status}${critic.findings ? ` (${critic.findings.slice(0, 120)})` : ""}`);

      if (critic.status === "missing" && cfg.criticMaxRetries > 0 && !isAmend(ctx)) {
        log.info(`critic: MISSING ${critic.findings.slice(0, 120)} — re-dispatching one corrective worker turn`);
        const correctiveFactory = (deps.sessionFactoryFor ?? makePiSessionFactory)(cfg, wtPath);
        const corrective = await runAgent({
          body: buildCorrectivePrompt(task, critic.findings),
          cwd: wtPath,
          timeoutMs: task.timeoutSeconds * 1000,
          createSession: correctiveFactory,
          guardManager: cfg.supervisorEnabled
            ? new GuardManager({
                supervisorConfig: {
                  budgetPerKind: cfg.supervisorBudgetPerKind,
                  escalationWindowTurns: cfg.supervisorEscalationWindow,
                },
                outputBudgetPerTurn: cfg.supervisorOutputBudgetPerTurn,
                outputBudgetPostCommit: cfg.supervisorOutputBudgetPostCommit,
              })
            : undefined,
        });
        prOutcome.criticRetriesUsed = 1;
        log.info(`critic retry: agent abortedByGuard=${corrective.abortedByGuard}`);
        // Re-evaluate commits + critic + verification after the retry.
        newCommits = await countNewCommits(cfg, wtPath, sinceRef);
        prOutcome.commits = await listNewCommits(cfg, wtPath, sinceRef);
        const criticAfter = await runCriticPass(cfg, task, wtPath, sinceRef, {
          criticSessionFactory: deps.criticSessionFactory,
        });
        prOutcome.critic = criticAfter;
        log.info(
          `critic (post-retry): ${criticAfter.status}${criticAfter.findings ? ` (${criticAfter.findings.slice(0, 120)})` : ""}`,
        );
        prOutcome.verification = await runSpecVerification(cfg, task, wtPath);
      }
    }

    // Phase 10: verification gate.
    const verification = prOutcome.verification;
    if (cfg.verifyBlockOnFail && verification !== null && verification.failedOutputs.length > 0) {
      const failedCount = verification.failedOutputs.length;
      const phaseError =
        `verification gate blocked push: ${verification.blocksPassed}/${verification.blocksRun} ` +
        `checks passed; ${failedCount} failure(s)`;
      log.warn(`${phaseError} — preserving worktree, skipping push/PR`);
      prOutcome.worktreePreserved = true;
      return finalizePr(claimedPath, result, prOutcome, { dirs, phaseError });
    }

    // Phase 11: push.
    await pushBranch(cfg, wtPath, ctx.branchName);
    prOutcome.pushed = true;
    log.info(`pushed ${ctx.branchName} (${newCommits} new commit${newCommits === 1 ? "" : "s"})`);
  } catch (e) {
    if (!(e instanceof GitOpError)) throw e;
    const phaseError = `push/commit failed: ${e.message}`;
    prOutcome.worktreePreserved = true;
    log.error(phaseError);
    return finalizePr(claimedPath, result, prOutcome, { dirs, phaseError });
  }

  // --- Phase 12: open PR (fresh) OR refresh URL (amend). ---
  if (isAmend(ctx) && amendTarget !== null) {
    log.info(
      `amended PR #${amendTarget.prNumber} on ${ctx.branchName} (${prOutcome.commits.length} new commits)`,
    );
    prOutcome.prUrl = amendTarget.prUrl; // GitHub URL unchanged across amendments
  } else {
    try {
      const title = derivePrTitle(ctx, task);
      const bodyText = buildPrBody(task, ctx, prOutcome, result);
      const bodyFile = writePrBodyTempfile(bodyText);
      try {
        prOutcome.prUrl = await openPullRequest(cfg, ctx, nwo, title, bodyFile);
      } finally {
        try {
          rmSync(bodyFile, { force: true });
        } catch {
          /* best-effort */
        }
      }
      log.info(`opened PR ${prOutcome.prUrl} for ${claimedPath}`);
    } catch (e) {
      if (!(e instanceof GitOpError)) throw e;
      const phaseError = `gh pr create failed (branch pushed, open manually): ${e.message}`;
      log.error(phaseError);
      if (cfg.removeWorktreeOnSuccess) await cleanupWorktree(cfg, ctx, wtPath);
      return finalizePr(claimedPath, result, prOutcome, { dirs, phaseError });
    }
  }

  // --- Phase 13: cleanup. ---
  if (cfg.removeWorktreeOnSuccess) {
    await cleanupWorktree(cfg, ctx, wtPath);
  } else {
    prOutcome.worktreePreserved = true;
  }

  // --- Phase 14: finalize success. ---
  return finalizePr(claimedPath, result, prOutcome, { dirs });
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function writePrBodyTempfile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-pr-"));
  const file = join(dir, "pr-body.md");
  writeFileSync(file, body, "utf8");
  return file;
}

/** Derive the terminal dirs from cfg (mirrors queuePaths) without importing the
 * full config module's queuePaths to keep prFlow self-contained for tests. */
function defaultDirs(cfg: Config): TerminalDirs {
  const root = join(cfg.vaultRoot, cfg.juncoSubdir);
  return { done: join(root, "done"), failed: join(root, "failed") };
}
