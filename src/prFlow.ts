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
import { GitOpError, git, gh, isNetworkError } from "./git.js";
import { validateRepoContext, resolveAmendTarget, type AmendTarget } from "./repo.js";
import { prepareWorktree, cleanupWorktree, currentHeadSha } from "./worktree.js";
import {
  countNewCommits,
  listNewCommits,
  commitLeftovers,
  pushBranch,
  openPullRequest,
  derivePrTitle,
  type Commit,
} from "./pr.js";
import { lintTicket, LabelCache } from "./planLint.js";
import { isTransientFailure, requeueTicket } from "./requeue.js";
import { runSpecVerification, type VerificationResult } from "./verify.js";
import { runCriticPass, buildCorrectivePrompt, type CriticResult } from "./critic.js";
import { buildPromptWithRepoContext } from "./prPrompt.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { GuardManager } from "./agent/guardManager.js";
import { finalizePr, computePrStatus, type TerminalDirs } from "./finalize.js";
import { enqueueOp, isOffline } from "./githubOutbox.js";
import { queuePaths } from "./config.js";
import { transcriptPathFor } from "./slug.js";
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
  /** PR endgame (push/create-PR/finalize comment+label) was parked in the
   * outbox because GitHub was unreachable — set in Task 4. */
  prQueued: boolean;
  /** Offline AMEND (issue #50): the PR URL is already known so the reporter
   * still comments (prQueued stays false), but the push carrying the new
   * commits was parked in the outbox. The result block flags this so the run
   * does not read as unqualified success while the commits are still queued.
   * Optional — older/other PrOutcome builders omit it (treated as false). */
  pushQueued?: boolean;
  /** The base branch could not be fetched (offline) so the worktree was cut
   * from a possibly-stale local `origin/<base>` — buildPrBody flags it. */
  staleBase: boolean;
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
    prQueued: false,
    pushQueued: false,
    staleBase: false,
  };
}

// ---------------------------------------------------------------------------
// PrFlowResult — structured return of runPrFlow (feeds the reporter seam).
// ---------------------------------------------------------------------------

export interface PrFlowResult {
  dst: string;
  status: string; // terminal status, or "requeued"
  requeued: boolean;
  prUrl: string | null;
  commitCount: number;
  finalText: string; // agent's final message ("" when none)
  /** Whole-run assistant text (all messages), vs finalText's LAST-message-only
   * (#36). Optional/additive; threaded from the underlying RunResult so the
   * reporter seam can recover a fence banked before the closing message (#86). */
  allText?: string;
  phaseError: string | null; // phase error or agent errorMessage, when failed
  /** Mirrors PrOutcome.prQueued — the reporter uses this to skip the
   * finalize comment + label flip when the composite outbox op owns them. */
  prQueued: boolean;
}

function flowResult(
  fin: { dst: string; status: string },
  prOutcome: PrOutcome,
  result: RunResult,
  phaseError: string | null = null,
): PrFlowResult {
  return {
    dst: fin.dst,
    status: fin.status,
    requeued: false,
    prUrl: prOutcome.prUrl,
    commitCount: prOutcome.commits.length,
    finalText: result.finalText,
    allText: result.allText,
    phaseError: phaseError ?? result.errorMessage,
    prQueued: prOutcome.prQueued,
  };
}

function requeuedResult(dst: string, result: RunResult): PrFlowResult {
  return {
    dst,
    status: "requeued",
    requeued: true,
    prUrl: null,
    commitCount: 0,
    finalText: result.finalText,
    allText: result.allText,
    phaseError: null,
    prQueued: false,
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

  if (result.timedOut) {
    parts.push(
      "> ⚠️ **Partial run.** This PR was opened from a session that hit its " +
        "ticket timeout — commits made before the cutoff were salvaged. Review " +
        "for completeness; consider an amendment ticket to finish.",
    );
  }

  if (prOutcome.staleBase) {
    parts.push("> ⚠️ Built offline from a possibly stale base — rebase check recommended.");
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
      failedLines.push(
        `  - \`${preview}\` → exit ${exitCode}\n    \`\`\`\n    ${snip}\n    \`\`\``,
      );
    }
    parts.push(
      `> ⚠️ **Spec verification: ${verification.blocksPassed}/${verification.blocksRun} checks passed.** Failures:\n` +
        failedLines.join("\n"),
    );
  } else if (verification && verification.blocksRun > 0) {
    parts.push(
      `> ✅ **Spec verification:** ${verification.blocksPassed}/${verification.blocksRun} checks passed.`,
    );
  }

  const body = task.body.trim();
  if (body) parts.push("## Ticket\n\n" + body);

  const summary = result.finalText ? result.finalText.trim() : "";
  if (summary) parts.push("## Agent summary\n\n" + summary);

  if (prOutcome.commits.length > 0) {
    parts.push(
      "## Commits\n\n" + prOutcome.commits.map((c) => `- \`${c.sha}\` ${c.subject}`).join("\n"),
    );
  }

  // Bridged tickets: deterministic issue link so merging auto-closes the issue
  // (never delegated to the prompt).
  if (task.github && task.github.kind === "pr") {
    parts.push(`Closes ${task.github.nwo}#${task.github.issue}`);
  }

  const metadataLines = [
    `- Elapsed: ${fmtDuration(Math.round(result.durationMs / 1000))}`,
    `- Tool calls: ${result.toolCalls.length}`,
    `- Tokens: in=${result.usage.input.toLocaleString("en-US")} · out=${result.usage.output.toLocaleString("en-US")} · total=${result.usage.total.toLocaleString("en-US")}`,
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
  sessionFactoryFor?: (
    cfg: Config,
    cwd: string,
    overrides?: { network?: boolean },
  ) => () => Promise<AgentSessionLike>;
  /** Inject the critic session factory (tests control the PASS/MISSING verdict). */
  criticSessionFactory?: () => Promise<AgentSessionLike>;
  /** Terminal dirs override (tests). Defaults to queuePaths(cfg). */
  dirs?: TerminalDirs;
  /** Operator force-stop signal — soft-aborts the worker + corrective sessions
   * (guard-kill semantics: committed work is salvaged). The critic session is
   * NOT threaded: it is tool-less and bounded, and a force-stopped worker
   * session never reaches it anyway (guard-abort skips post-session review). */
  abortSignal?: AbortSignal;
  /** Live progress hook (turns, last tool, output tokens) for /health. */
  onProgress?: (p: { turns: number; lastTool: string | null; outputTokens: number }) => void;
  /** Guard-decision hook (nudge/kill) for the /health guard counters (#37). */
  onGuardDecision?: Parameters<typeof runAgent>[0]["onGuardDecision"];
  /** Network-retry backoff base for fetch/push/PR-create (default 1000ms) —
   * tests that script offline failures pass ~5ms so the suite stays fast. */
  retryBaseDelayMs?: number;
}

export async function runPrFlow(
  cfg: Config,
  task: Ticket,
  claimedPath: string,
  ctx: RepoContext,
  deps: PrFlowDeps = {},
): Promise<PrFlowResult> {
  const dirs: TerminalDirs = deps.dirs ?? defaultDirs(cfg);
  const prOutcome = emptyPrOutcome(ctx);
  let amendTarget: AmendTarget | null = null;
  // Issue #29: set when the branch is already on the push remote with no open
  // PR of ours — the push must force-with-lease against this sha to overwrite
  // the crashed run's stale tip.
  let resumeRemoteSha: string | null = null;

  // --- Phase 1: Validate (no worktree yet — lint can reject before setup). ---
  let nwo: string;
  try {
    const valSignals = { resumeRemoteSha: null as string | null };
    // Thread the ticket's retry counter so validate only arms the fresh-mode
    // resume (force-push over a PR-less colliding branch) when this ticket was
    // requeued after a crash (retry_count > 0) — never for a fresh ticket (#70).
    nwo = await validateRepoContext(cfg, ctx, {
      signals: valSignals,
      retryCount: task.retryCount,
    }); // mutates ctx in amend mode
    resumeRemoteSha = valSignals.resumeRemoteSha;
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
    const r = emptyRunResult(msg);
    return flowResult(
      finalizePr(claimedPath, r, prOutcome, { dirs, phaseError: msg }),
      prOutcome,
      r,
      msg,
    );
  }

  // --- Phase 2: Plan-lint gate. ---
  if (cfg.planLintEnabled) {
    const lint = lintTicket(task.body, task.frontmatter, {
      repoNwo: nwo,
      repoPath: ctx.repo,
      checkLabels: cfg.planLintCheckLabels,
      labelCache: LABEL_CACHE,
      ghBin: cfg.ghBin,
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
      const r = emptyRunResult(phaseError);
      return flowResult(
        finalizePr(claimedPath, r, prOutcome, { dirs, phaseError }),
        prOutcome,
        r,
        phaseError,
      );
    }
  }

  // --- Phase 3: Worktree setup (only after lint clears). ---
  let wtPath: string;
  let preRunHead: string;
  try {
    const wtSignals = { staleBase: false };
    wtPath = await prepareWorktree(cfg, ctx, task.id, {
      signals: wtSignals,
      retryBaseDelayMs: deps.retryBaseDelayMs,
    });
    prOutcome.worktreePath = wtPath;
    prOutcome.staleBase = wtSignals.staleBase;
    preRunHead = await currentHeadSha(cfg, wtPath);
  } catch (e) {
    if (!(e instanceof GitOpError)) throw e;
    const msg = e.message;
    log.error(`pr-flow pre-check failed for ${claimedPath}: ${msg}`);
    const r = emptyRunResult(msg);
    return flowResult(
      finalizePr(claimedPath, r, prOutcome, { dirs, phaseError: msg }),
      prOutcome,
      r,
      msg,
    );
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
  // Per-ticket event transcript (worker + corrective append to one file).
  const transcriptPath = cfg.transcriptsEnabled
    ? transcriptPathFor(cfg.stateDir, task.id)
    : undefined;
  // A ticket-level `tools:` overrides the configured allowlist for THIS
  // ticket's sessions (worker + corrective). Everything else keeps cfg.
  const flowCfg: Config = task.tools ? { ...cfg, tools: task.tools } : cfg;
  const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(flowCfg, wtPath, {
    network: task.network ?? undefined,
  });
  const result = await runAgent({
    body: prompt,
    cwd: wtPath,
    timeoutMs: task.timeoutSeconds * 1000,
    createSession: factory,
    guardManager,
    abortSignal: deps.abortSignal,
    onProgress: deps.onProgress,
    onGuardDecision: deps.onGuardDecision,
    transcriptPath,
  });

  // Since-ref for commit counting (amend: pre-run HEAD; fresh: origin/<base>).
  // Hoisted above Phase 5 — the transient-requeue check needs a commit count.
  const sinceRef = isAmend(ctx) ? preRunHead : `origin/${ctx.baseBranch}`;

  // --- Phase 5: Hard-exit check (non-guard error). ---
  // A guard abort is a SOFT abort, and so is a TIMEOUT: both continue through
  // post-processing so commits made before the cutoff are salvaged into a PR.
  const hardError = result.errorMessage !== null && !result.abortedByGuard && !result.timedOut;
  if (hardError) {
    // A TRANSIENT error with zero commits is requeued (budget permitting)
    // rather than failed — the inference side hiccuped, not the ticket.
    let commitsSoFar = 0;
    try {
      commitsSoFar = await countNewCommits(cfg, wtPath, sinceRef);
    } catch {
      /* unreadable worktree → treat as 0; requeue is still the safe path */
    }
    if (isTransientFailure(result, commitsSoFar)) {
      const rq = requeueTicket(
        cfg,
        claimedPath,
        task,
        result.errorMessage ?? "agent session error",
      );
      if (rq.requeued) {
        await cleanupWorktree(cfg, ctx, wtPath);
        return requeuedResult(rq.dst!, result);
      }
    }
    prOutcome.worktreePreserved = true;
    return flowResult(finalizePr(claimedPath, result, prOutcome, { dirs }), prOutcome, result);
  }

  // Park the whole push → PR → comment → labels sequence in the outbox when
  // GitHub is unreachable — the ticket's work is already committed locally, so
  // it finalizes DONE and the durable op replays the network side effects when
  // connectivity returns. `pushed` records whether the branch already landed.
  const queueOfflinePr = (pushed: boolean): string => {
    const title = derivePrTitle(ctx, task);
    const bodyText = buildPrBody(task, ctx, prOutcome, result);
    const status = computePrStatus(result, prOutcome, null);
    return enqueueOp(cfg, "prflow", {
      kind: "pr",
      repoPath: ctx.repo,
      branch: ctx.branchName,
      remote: ctx.pushRemote,
      head:
        ctx.forkNwo !== null ? `${ctx.forkNwo.split("/")[0]}:${ctx.branchName}` : ctx.branchName,
      nwo,
      issue: task.github?.issue ?? null,
      base: ctx.baseBranch,
      title,
      bodyText,
      draft: ctx.draft,
      // Fork PRs are label-free — the upstream label namespace is not ours.
      labels: ctx.forkNwo !== null ? [] : ctx.labels,
      reviewers: ctx.reviewers,
      // External tickets stay silent on the upstream issue — no comment/label
      // replay when connectivity returns (etiquette invariant).
      finalize:
        task.github && !task.github.external
          ? { ticketId: task.id, status, finalText: result.finalText }
          : null,
      pushed,
      prUrl: null,
    });
  };

  // --- Phases 6-13: commits, push, PR. Any GitOpError → preserve + failed. ---
  try {
    // Phase 6: count commits since the ref.
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
      // A timed-out session with nothing committed has nothing to salvage —
      // preserve the worktree and fail (a timeout is NOT transient: retrying
      // the same ticket would most likely time out again).
      if (result.timedOut) {
        const phaseError = `agent hit the ${Math.round(task.timeoutSeconds / 60)}-minute ticket timeout with no commits`;
        prOutcome.worktreePreserved = true;
        log.warn(`${phaseError} — preserving worktree, routing to failed`);
        return flowResult(
          finalizePr(claimedPath, result, prOutcome, { dirs, phaseError }),
          prOutcome,
          result,
          phaseError,
        );
      }
      // stop_reason error/length with nothing committed is the transient
      // class — requeue with backoff before falling through to terminal fail.
      if (result.stopReason === "error" || result.stopReason === "length") {
        const rq = requeueTicket(cfg, claimedPath, task, `stop_reason=${result.stopReason}`);
        if (rq.requeued) {
          await cleanupWorktree(cfg, ctx, wtPath);
          return requeuedResult(rq.dst!, result);
        }
        // budget exhausted → fall through to the existing terminal handling
      }
      if (result.stopReason === "error") {
        const phaseError =
          "agent errored mid-session (stop_reason='error', " +
          `${result.usage.output} output tokens) — likely transient inference-side ` +
          "failure, not a successful no-changes outcome";
        prOutcome.worktreePreserved = true;
        log.warn(`${phaseError} — preserving worktree, routing to failed`);
        return flowResult(
          finalizePr(claimedPath, result, prOutcome, { dirs, phaseError }),
          prOutcome,
          result,
          phaseError,
        );
      }
      if (result.stopReason === "length") {
        const phaseError =
          "agent truncated by inference engine (stop_reason='length', " +
          `${result.usage.output} output tokens) — model was generating runaway ` +
          "thinking or output without converging on a tool call; likely a stall";
        prOutcome.worktreePreserved = true;
        log.warn(`${phaseError} — preserving worktree, routing to failed`);
        return flowResult(
          finalizePr(claimedPath, result, prOutcome, { dirs, phaseError }),
          prOutcome,
          result,
          phaseError,
        );
      }
      prOutcome.statusOverride = "completed_no_changes";
      log.info(
        `no-changes outcome for ${claimedPath}; skipping ${isAmend(ctx) ? "PR-update" : "PR"}`,
      );
      if (cfg.removeWorktreeOnSuccess) await cleanupWorktree(cfg, ctx, wtPath);
      return flowResult(finalizePr(claimedPath, result, prOutcome, { dirs }), prOutcome, result);
    }

    // Phase 9: post-session review (skip on a guard-aborted or timed-out
    // session — the work is by definition incomplete; review would mis-flag).
    const skipPostSessionReview = result.abortedByGuard || result.timedOut;
    if (skipPostSessionReview) {
      // Record the skip as metadata (parity with worker.py PrOutcome.critic =
      // CriticResult(status="skipped", ...)). The buildPrBody banner only fires
      // on pass/missing, so this never surfaces in the PR body — metadata only.
      prOutcome.critic = {
        status: "skipped",
        findings: result.timedOut ? "timed-out session" : "aborted-by-repetition session",
        rawOutput: "",
      };
    }
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
      log.info(
        `critic: ${critic.status}${critic.findings ? ` (${critic.findings.slice(0, 120)})` : ""}`,
      );

      if (critic.status === "missing" && cfg.criticMaxRetries > 0 && !isAmend(ctx)) {
        log.info(
          `critic: MISSING ${critic.findings.slice(0, 120)} — re-dispatching one corrective worker turn`,
        );
        const correctiveFactory = (deps.sessionFactoryFor ?? makePiSessionFactory)(
          flowCfg,
          wtPath,
          {
            network: task.network ?? undefined,
          },
        );
        const corrective = await runAgent({
          body: buildCorrectivePrompt(task, critic.findings),
          cwd: wtPath,
          timeoutMs: task.timeoutSeconds * 1000,
          createSession: correctiveFactory,
          abortSignal: deps.abortSignal,
          onProgress: deps.onProgress,
          onGuardDecision: deps.onGuardDecision,
          transcriptPath, // corrective turn appends to the same chronological record
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
      return flowResult(
        finalizePr(claimedPath, result, prOutcome, { dirs, phaseError }),
        prOutcome,
        result,
        phaseError,
      );
    }

    // Phase 11: push (to ctx.pushRemote — the ticket's fork in fork-PR mode).
    // In resume mode (issue #29) force-with-lease over the crashed run's tip.
    await pushBranch(
      cfg,
      wtPath,
      ctx.branchName,
      deps.retryBaseDelayMs,
      ctx.pushRemote,
      resumeRemoteSha ?? undefined,
    );
    prOutcome.pushed = true;
    log.info(`pushed ${ctx.branchName} (${newCommits} new commit${newCommits === 1 ? "" : "s"})`);
  } catch (e) {
    if (!(e instanceof GitOpError)) throw e;
    if (isOffline(e) && !isAmend(ctx)) {
      // Offline fresh-PR endgame: the branch never pushed — park the whole
      // push → PR → comment → labels sequence in one composite op. The work is
      // DONE locally, so the ticket finalizes as it earned (no phaseError).
      // Mark the op queued BEFORE deriving its finalize status so a soft-abort
      // (timeout / guard-kill) salvage stamps the queued op with its done-routing
      // status (timeout_partial / aborted_partial) — matching the in-line finalize
      // below, so the outbox replay routes to done/ too rather than failed/ (#123).
      prOutcome.prQueued = true;
      prOutcome.worktreePreserved = true;
      const opId = queueOfflinePr(false /* pushed */);
      log.info(`github unreachable — PR queued to outbox (${opId})`);
      return flowResult(finalizePr(claimedPath, result, prOutcome, { dirs }), prOutcome, result);
    }
    if (isOffline(e) && isAmend(ctx)) {
      // Offline amend: only the push is unknown; the PR URL is already known, so
      // the reporter posts its normal finalize comment (which itself queues if
      // still offline). Just park the push.
      enqueueOp(cfg, "prflow", {
        kind: "push",
        repoPath: ctx.repo,
        branch: ctx.branchName,
        remote: ctx.pushRemote,
      });
      prOutcome.prQueued = false; // URL known; reporter comment proceeds normally
      // Issue #50: the commits are only QUEUED, not on the PR yet — surface
      // that in the result block so the run is not reported as done-and-pushed.
      prOutcome.pushQueued = true;
      prOutcome.pushed = false;
      prOutcome.worktreePreserved = true;
      prOutcome.prUrl = amendTarget?.prUrl ?? null;
      log.info("github unreachable — amend push queued to outbox");
      return flowResult(finalizePr(claimedPath, result, prOutcome, { dirs }), prOutcome, result);
    }
    const phaseError = `push/commit failed: ${e.message}`;
    prOutcome.worktreePreserved = true;
    log.error(phaseError);
    return flowResult(
      finalizePr(claimedPath, result, prOutcome, { dirs, phaseError }),
      prOutcome,
      result,
      phaseError,
    );
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
        prOutcome.prUrl = await openPullRequest(
          cfg,
          ctx,
          nwo,
          title,
          bodyFile,
          deps.retryBaseDelayMs,
        );
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
      if (isOffline(e)) {
        // Push already succeeded; only the PR-create (+ comment + labels) is
        // unreachable — checkpoint pushed:true so replay skips straight to the
        // create. Worktree is preserved (skip cleanup on every offline branch).
        const opId = queueOfflinePr(true /* pushed */);
        prOutcome.prQueued = true;
        prOutcome.worktreePreserved = true;
        log.info(`github unreachable — PR queued to outbox (${opId})`);
        return flowResult(finalizePr(claimedPath, result, prOutcome, { dirs }), prOutcome, result);
      }
      // Idempotent create (issue #29): the branch is already pushed, so a PR may
      // already exist for this head (a prior attempt opened it, or a race).
      // Recover the URL instead of failing — mirrors the outbox create→view
      // recovery in githubOutbox.ts. Only then does control fall through to the
      // success finalize below.
      if (/already exists/i.test(e.stderr)) {
        const recovered = await recoverExistingPrUrl(cfg, ctx, nwo, deps.retryBaseDelayMs).catch(
          () => null,
        );
        if (recovered !== null) {
          prOutcome.prUrl = recovered;
          log.info(`gh pr create: PR already exists — recovered ${recovered} for ${claimedPath}`);
        }
      }
      if (prOutcome.prUrl === null) {
        // Only a NETWORK/transient create failure is worth requeuing: the branch
        // is already pushed, so a retry re-runs the fresh flow, which resumes the
        // pushed-but-PR-less branch and re-creates the PR. A DETERMINISTIC
        // failure — "No commits between base and head", a title-too-long
        // validation error, a permission denial — fails identically on every
        // retry while re-running the whole expensive agent session, so it keeps
        // the terminal "branch pushed, open manually" path (issue #73). Network
        // create failures are normally caught by the offline branch above; this
        // classifier is the belt-and-suspenders guard for a network error whose
        // text landed only in e.message.
        if (isNetworkError(e.stderr || e.message)) {
          const rq = requeueTicket(cfg, claimedPath, task, `gh pr create failed: ${e.message}`);
          if (rq.requeued) {
            await cleanupWorktree(cfg, ctx, wtPath);
            return requeuedResult(rq.dst!, result);
          }
        }
        const phaseError = `gh pr create failed (branch pushed, open manually): ${e.message}`;
        log.error(phaseError);
        if (cfg.removeWorktreeOnSuccess) await cleanupWorktree(cfg, ctx, wtPath);
        return flowResult(
          finalizePr(claimedPath, result, prOutcome, { dirs, phaseError }),
          prOutcome,
          result,
          phaseError,
        );
      }
    }
  }

  // --- Phase 13: cleanup. ---
  if (cfg.removeWorktreeOnSuccess) {
    await cleanupWorktree(cfg, ctx, wtPath);
  } else {
    prOutcome.worktreePreserved = true;
  }

  // --- Phase 14: finalize success. ---
  return flowResult(finalizePr(claimedPath, result, prOutcome, { dirs }), prOutcome, result);
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** Recover the URL of an already-open PR for this ticket's head branch
 * (issue #29 idempotent create). The head form matches openPullRequest /
 * the outbox: `<fork-owner>:<branch>` in fork mode, else the bare branch.
 *
 * Uses `gh pr list --head <head> --state open` rather than `gh pr view <head>`:
 * `gh pr view`'s positional selector resolves branch names WITHIN the repo and
 * does not accept the cross-repo `<owner>:<branch>` form, so for a fork PR it
 * returns "no pull requests found" and the recovery never recovers (issue #75).
 * `gh pr list --head` supports the `<owner>:<branch>` head qualifier. */
async function recoverExistingPrUrl(
  cfg: Config,
  ctx: RepoContext,
  nwo: string,
  retryBaseDelayMs?: number,
): Promise<string> {
  const head =
    ctx.forkNwo !== null ? `${ctx.forkNwo.split("/")[0]}:${ctx.branchName}` : ctx.branchName;
  const r = await gh(
    cfg,
    ["pr", "list", "--repo", nwo, "--head", head, "--state", "open", "--json", "url,number"],
    { cwd: ctx.repo, retryNetwork: true, retryBaseDelayMs },
  );
  let arr: Array<{ url?: unknown }>;
  try {
    arr = JSON.parse(r.stdout || "[]") as Array<{ url?: unknown }>;
  } catch {
    throw new GitOpError(
      `gh pr list returned non-JSON for head ${JSON.stringify(head)}: ${r.stdout.slice(0, 200)}`,
    );
  }
  const url = arr.map((p) => String(p.url ?? "")).find((u) => u.startsWith("https://"));
  if (!url) {
    throw new GitOpError(`gh pr list returned no open PR for head ${JSON.stringify(head)}`);
  }
  return url;
}

function writePrBodyTempfile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-pr-"));
  const file = join(dir, "pr-body.md");
  writeFileSync(file, body, "utf8");
  return file;
}

/** Terminal dirs for the PR flow — derived from the SAME queuePaths the Q&A flow
 * uses, so both paths route done/failed to identical directories. */
function defaultDirs(cfg: Config): TerminalDirs {
  const p = queuePaths(cfg);
  return { done: p.done, failed: p.failed };
}
