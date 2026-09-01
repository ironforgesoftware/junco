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

import type { Config, Ticket, RunResult, Usage } from "./types.js";
import type { RepoContext } from "./repoContext.js";
import { isAmend } from "./repoContext.js";
import { GitOpError, git, gh, isNetworkError, ghAuthEnv } from "./git.js";
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
import { parsePatchSeries, summarizePatchFenceForPr } from "./patchTicket.js";
import { applyPatchSeries, buildApplyFallbackPrompt } from "./applyPatch.js";
import { extractPatchBody } from "./githubInbox.js";
import { isTransientFailure, requeueTicket, requeueTicketKeepBudget } from "./requeue.js";
import { classifyProviderFailure, GATE_CLASSES, isRoutableFailure } from "./providerFailure.js";
import type { ProviderGate } from "./providerGate.js";
import type { SpendLedger } from "./spendLedger.js";
import { runSpecVerification, type VerificationResult } from "./verify.js";
import { runCriticPass, buildCorrectivePrompt, type CriticResult } from "./critic.js";
import { buildPromptWithRepoContext } from "./prPrompt.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { runEnveloped } from "./agent/runEnvelope.js";
import { finalizePr, computePrStatus, type TerminalDirs } from "./finalize.js";
import { enqueueOp, isOffline } from "./githubOutbox.js";
import { queuePaths } from "./config.js";
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
  /** Stage 2a escalation ladder (apply-tickets-design.md): set when a
   * junco-patch ticket's apply (or, later, its own Verification block)
   * failed and `worker.applyFallbackToAgent` sent the ticket to the agent
   * instead of failing it terminally. null on every other path, including a
   * clean apply. buildPrBody renders this as a disclosure banner — the PR is
   * no longer byte-identical to what a human approved on the GitHub route. */
  applyFallback: { kind: "apply" | "verification"; reason: string } | null;
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
    applyFallback: null,
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
  /** Token usage of the underlying run — threaded so runOnce can write the
   * task-history record without re-plumbing RunResult (additive; absent on
   * requeuedResult, which never produces a record). */
  usage?: Usage;
  durationMs?: number;
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
    usage: result.usage,
    durationMs: result.durationMs,
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

/** Sum Usage fields across every session a ticket ran (main worker turn +
 * critic pass(es) + an optional corrective re-dispatch) — the ticket's
 * recorded cost/tokens should reflect the whole ticket, not just the main
 * worker turn (Phase-3 cost accounting). `extras` is empty when post-session
 * review was skipped (guard-abort/timeout), in which case this is a no-op
 * copy of `base`. */
function sumUsage(base: Usage, extras: Usage[]): Usage {
  return extras.reduce(
    (acc, u) => ({
      input: acc.input + u.input,
      output: acc.output + u.output,
      cacheRead: acc.cacheRead + u.cacheRead,
      total: acc.total + u.total,
      costUsd: acc.costUsd + u.costUsd,
    }),
    base,
  );
}

/** Port of worker.py `_empty_run_result`: a synthetic RunResult for phases that
 * fail before (or instead of) an agent run. errorMessage carries the reason. */
function emptyRunResult(phaseError: string): RunResult {
  return {
    finalText: "",
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
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

/**
 * Format a failed VerificationResult for the Stage-2b escalation ladder
 * (apply-tickets-design.md): both `buildApplyFallbackPrompt`'s `detail` (what
 * the escalated agent sees as "why it failed") and `PrOutcome.applyFallback.
 * reason` (what the PR-body disclosure banner's first line names). Same
 * shape as buildPrBody's own verification banner below (first 5 failures,
 * 300-char snippet) so the escalated agent sees the same signal a human
 * reviewer would.
 */
function formatVerificationFailureDetail(verification: VerificationResult): string {
  const lines = verification.failedOutputs
    .slice(0, 5)
    .map(
      ({ preview, exitCode, output }) =>
        `- \`${preview}\` → exit ${exitCode}\n  ${output.trim().slice(0, 300)}`,
    );
  return (
    `${verification.blocksPassed}/${verification.blocksRun} verification checks passed. ` +
    `Failures:\n${lines.join("\n")}`
  );
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

  // Apply-fallback disclosure (Stage 2a, apply-tickets-design.md). Approval
  // semantics: on the GitHub route, a human applied the trigger label to a
  // specific reviewed DIFF. When that diff didn't apply and the agent
  // finished the ticket instead, the PR is no longer byte-identical to what
  // was approved — a silent fallback would be a real gap in the approval
  // model, so this banner is never optional when applyFallback is set.
  if (prOutcome.applyFallback) {
    const { kind, reason } = prOutcome.applyFallback;
    const reasonFirstLine = reason.split("\n")[0];
    const what =
      kind === "apply"
        ? "The reviewed patch did not apply cleanly"
        : "The reviewed patch applied, but its Verification block failed";
    parts.push(
      `> **Apply-mode fallback.** ${what} (${reasonFirstLine}), so an agent completed ` +
        "this ticket from the patch as specification. The diff below is NOT byte-identical " +
        "to the patch that was approved — review it as ordinary agent work.",
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
  if (body) {
    // Apply tickets: the ticket's own body IS the mbox series — re-embedding
    // it here duplicates the diff the PR already shows and can exceed
    // GitHub's 65,536-char PR-body cap (gh pr create then fails
    // deterministically AFTER the commits are already pushed). Swap the
    // fenced patch block for a one-line summary; the rest of the ticket's
    // prose (Why/Verification) is untouched.
    const patchSeries = parsePatchSeries(task.body);
    const ticketSection = patchSeries ? summarizePatchFenceForPr(body, patchSeries) : body;
    parts.push("## Ticket\n\n" + ticketSection);
  }

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
  /** Provider gate — classification-driven claim pausing (peer of RunDeps.gate
   * in runOnce.ts). Optional: absent (CLI one-shot, tests) preserves pre-gate
   * behavior exactly. */
  gate?: Pick<ProviderGate, "reportFailure" | "reportSuccess" | "notBeforeIso">;
  /** Per-day spend ledger (Phase-3 Task 4), peer of RunDeps.spend in
   * runOnce.ts: EVERY session this ticket runs — main worker turn, each
   * critic pass, the optional corrective re-dispatch — records its OWN
   * `usage.costUsd` here immediately as that session completes, independent
   * of the ticket's eventual disposition (a requeue exit still counts the
   * main run's spend). Optional: absent preserves pre-ledger behavior
   * exactly (recordUsd is never called). */
  spend?: Pick<SpendLedger, "recordUsd">;
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
      ghEnv: cfg.ghAuth ? ghAuthEnv(cfg.ghAuth) : undefined,
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

  // --- Phase 4: Apply a patch series, or run the agent in the worktree. ---
  // An apply ticket (body carries a junco-patch fence) has no uncertainty left
  // to resolve: `git am` applies AND commits, and Phases 5-14 continue on the
  // resulting commits exactly as they would after an agent session.
  //
  // flowCfg is hoisted above the branch: it is read again in Phase 9's
  // corrective-dispatch block, which runs only on the agent path but needs to
  // type-check regardless of which branch of this `if` executed.
  const flowCfg: Config = task.tools ? { ...cfg, tools: task.tools } : cfg;
  // Shared with the plain-agent branch below AND the apply-fallback branch
  // (Stage 2a) — a ticket-level `tools:` override and the network opt-in
  // apply identically regardless of which path dispatched the session.
  const makeAgentSessionFactory = (): (() => Promise<AgentSessionLike>) =>
    (deps.sessionFactoryFor ?? makePiSessionFactory)(flowCfg, wtPath, {
      network: task.network ?? undefined,
    });
  const patchSeries = parsePatchSeries(task.body);
  let result: RunResult;
  if (patchSeries !== null) {
    log.info("apply mode: applying junco-patch series", {
      patches: patchSeries.count,
      files: patchSeries.files.length,
    });
    const outcome = await applyPatchSeries(cfg, wtPath, patchSeries);
    if (outcome.ok) {
      result = outcome.result;
    } else if (!cfg.applyFallbackToAgent) {
      // Terminal by design — see applyPatch.ts's header: a conflict is
      // deterministic, so Phase 5's transient classifier must never see it.
      const phaseError = `apply failed: ${outcome.reason}`;
      prOutcome.worktreePreserved = true;
      log.warn(phaseError);
      const r = emptyRunResult(phaseError);
      return flowResult(
        finalizePr(claimedPath, r, prOutcome, { dirs, phaseError }),
        prOutcome,
        r,
        phaseError,
      );
    } else {
      // Stage 2a escalation ladder: the reviewed diff didn't apply, but the
      // toggle says to finish the ticket anyway rather than fail it. The
      // agent gets the patch as SPEC (buildApplyFallbackPrompt), not bytes to
      // replay — re-running `git am`/`git apply` would just fail again.
      // prOutcome.applyFallback drives both the critic-skip narrowing below
      // (Phase 9) and buildPrBody's disclosure banner (the PR is no longer
      // byte-identical to what a human approved on the GitHub route).
      log.warn(
        `apply failed: ${outcome.reason} — falling back to the agent ` +
          "(worker.applyFallbackToAgent)",
      );
      prOutcome.applyFallback = { kind: "apply", reason: outcome.reason };
      const fallbackPrompt = buildApplyFallbackPrompt(task, patchSeries, {
        kind: "apply",
        detail: outcome.reason,
      });
      result = await runEnveloped(
        flowCfg,
        {
          ticketId: task.id,
          flow: "pr_apply_fallback",
          body: fallbackPrompt,
          cwd: wtPath,
          timeoutMs: task.timeoutSeconds * 1000,
        },
        {
          createSession: makeAgentSessionFactory(),
          abortSignal: deps.abortSignal,
          onProgress: deps.onProgress,
          onGuardDecision: deps.onGuardDecision,
          spend: deps.spend,
        },
      );
    }
  } else if (extractPatchBody(task.body) !== null) {
    // The fence is present but parsePatchSeries rejected it (no mbox header,
    // no diff --git hunk, or oversize) — mode-detection asymmetry guard:
    // plan-lint's own apply-mode gate treats fence-PRESENT as apply
    // (extractPatchBody !== null), so with lint disabled or non-blocking a
    // malformed series must never silently fall through to the agent branch
    // below with the giant raw mbox as its prompt. Terminal, same shape as an
    // apply failure (worktree preserved, no requeue).
    const phaseError = "apply failed: junco-patch fence present but not a well-formed series";
    prOutcome.worktreePreserved = true;
    log.warn(phaseError);
    const r = emptyRunResult(phaseError);
    return flowResult(
      finalizePr(claimedPath, r, prOutcome, { dirs, phaseError }),
      prOutcome,
      r,
      phaseError,
    );
  } else {
    const prompt = buildPromptWithRepoContext(task, ctx, wtPath, nwo, {
      amendTarget,
      commitLeftoversEnabled: cfg.commitLeftoversEnabled,
    });
    // A ticket-level `tools:` overrides the configured allowlist for THIS
    // ticket's sessions (worker + corrective). Everything else keeps cfg.
    // flowCfg (not cfg) also goes to runEnveloped so junco_run_start records
    // the enforced tool subset (narrowed-cfg ruling, matching the qaCfg/
    // assessCfg/analyzeCfg precedent). The envelope derives the per-ticket
    // transcript path from task.id, records spend, and builds the guard
    // manager — spend is recorded immediately, BEFORE any requeue/fail
    // branching below: this session's dollars were spent regardless of what
    // the ticket does next (Phase-3 Task 4 — the ledger is the honest record,
    // unlike the ticket's own footer accounting which never sees a requeued
    // attempt again).
    result = await runEnveloped(
      flowCfg,
      {
        ticketId: task.id,
        flow: "pr",
        body: prompt,
        cwd: wtPath,
        timeoutMs: task.timeoutSeconds * 1000,
      },
      {
        createSession: makeAgentSessionFactory(),
        abortSignal: deps.abortSignal,
        onProgress: deps.onProgress,
        onGuardDecision: deps.onGuardDecision,
        spend: deps.spend,
      },
    );
  }

  // True only for a clean `git am` apply with no Stage-2a/2b escalation — the
  // diff IS the spec, so both the no-sweep rule below (Phase 6) and the
  // critic skip (Phase 9) apply. A fallback ran the agent, so from here on
  // this ticket is treated exactly like a plain agent ticket. `let` (not
  // `const`): Stage 2b's verification escalation (Phase 9, below) flips this
  // to false the moment it fires, so the critic gate right after it sees an
  // agent-improvised ticket exactly as Stage 2a's Phase-4 fallback already
  // does — Phase 6 (which runs first) still reads the original clean-apply
  // value.
  let appliedCleanly = patchSeries !== null && prOutcome.applyFallback === null;

  // Since-ref for commit counting (amend: pre-run HEAD; fresh: origin/<base>).
  // Hoisted above Phase 5 — the transient-requeue check needs a commit count.
  const sinceRef = isAmend(ctx) ? preRunHead : `origin/${ctx.baseBranch}`;

  // --- Phase 5: Hard-exit check (non-guard error). ---
  // A guard abort is a SOFT abort, and so is a TIMEOUT: both continue through
  // post-processing so commits made before the cutoff are salvaged into a PR.
  // #180.3: isRoutableFailure (providerFailure.ts) is the shared timedOut/
  // abortedByGuard exclusion — same rule runOnce.ts's gate routing uses.
  const hardError = result.errorMessage !== null && isRoutableFailure(result);
  if (hardError) {
    // A TRANSIENT error with zero commits is requeued (budget permitting)
    // rather than failed — the inference side hiccuped, not the ticket.
    let commitsSoFar = 0;
    try {
      commitsSoFar = await countNewCommits(cfg, wtPath, sinceRef);
    } catch {
      /* unreadable worktree → treat as 0; requeue is still the safe path */
    }
    // Infrastructure failures (bad key, quota, 429, model typo) are not the
    // ticket's fault: report to the gate (pauses claiming) and requeue
    // WITHOUT consuming the retry budget — but ONLY when nothing has been
    // committed yet. Committed work is NEVER discarded (same invariant as
    // isTransientFailure just below): a 401 after real commits keeps today's
    // salvage behavior (preserve worktree + fail) untouched — the gate is not
    // consulted at all in that case.
    if (commitsSoFar === 0) {
      const cls = classifyProviderFailure(result.errorMessage);
      if (deps.gate && GATE_CLASSES.has(cls)) {
        deps.gate.reportFailure(cls, result.errorMessage ?? cls);
        const rq = requeueTicketKeepBudget(
          cfg,
          claimedPath,
          deps.gate.notBeforeIso(),
          result.errorMessage ?? cls,
        );
        await cleanupWorktree(cfg, ctx, wtPath);
        log.warn("provider-gate requeue", { dst: rq.dst, class: cls });
        return requeuedResult(rq.dst, result);
      }
      if (deps.gate && cls === "outage") deps.gate.reportFailure(cls, result.errorMessage ?? cls);
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
    const bodyText = buildPrBody(task, ctx, prOutcome, finalResult);
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
      // replay when connectivity returns (etiquette invariant). Plan-set
      // children (task.plan set) are likewise excluded: their comment/label
      // traffic on the shared parent issue is owned exclusively by the sweep
      // (maintainPlanSets in planSetBridge.ts) — replaying a per-child
      // finalize here would post a duplicate comment and thrash the set-level
      // label, bypassing the reporter's own onFinal suppression for these
      // tickets (githubReport.ts). The PR create/push replay itself is
      // unaffected — only this finalize (comment + label) tail is suppressed.
      finalize:
        task.github && !task.github.external && !task.plan
          ? { ticketId: task.id, status, finalText: result.finalText }
          : null,
      // Always populated (unlike finalize.ticketId, deliberately null for
      // external tickets and plan-set children) — drives the pr_url
      // write-back onto this ticket's done file when the outbox flush
      // finally opens the PR (#298).
      ticketId: task.id,
      pushed,
      prUrl: null,
    });
  };

  // Aggregated usage across every session this ticket ran (main + critic pass
  // 1 + corrective + critic pass 2, whichever executed) — computed in Phase 9
  // below and read by every finalizePr call from Phase 10 onward (catch
  // blocks included, hence hoisted above the try). Defaults to the main run
  // alone; reassigned once Phase 9 knows what else ran. Requeue exits
  // (requeuedResult, above and below) are untouched — they never read
  // result.usage, and aggregating THEIR usage is Task 4's ledger's job.
  let finalResult: RunResult = result;

  // --- Phases 6-13: commits, push, PR. Any GitOpError → preserve + failed. ---
  try {
    // Phase 6: count commits since the ref.
    let newCommits = await countNewCommits(cfg, wtPath, sinceRef);
    const dirty = await worktreeIsDirty(cfg, wtPath);
    if (newCommits === 0 && dirty) {
      if (appliedCleanly) {
        // `git am` applies AND commits — a dirty-but-uncommitted worktree
        // after an apply means the am step left something behind (it should
        // not, since a failed am is aborted before Phase 4 returns). Never
        // silently sweep an apply ticket's leftovers into a commit the
        // series itself did not author (spec open question 3). A Stage-2a
        // fallback is excluded from this rule (appliedCleanly is false): the
        // agent ran, so it is an ordinary agent ticket from here on.
        log.warn("apply mode: worktree dirty with no commits — failing loud, not sweeping");
      } else if (cfg.commitLeftoversEnabled) {
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
        // Zero-commit by construction (inside the newCommits===0 gate above).
        // Classify result.errorMessage ONLY — it is structurally null here (a
        // non-null errorMessage was already intercepted by Phase 5's hardError
        // check), so this branch is defensive-only and normally classifies
        // "unknown", falling through to the budgeted requeue below exactly as
        // before the gate existed. It MUST NOT read finalText: stop_reason=
        // 'length' is truncated AGENT PROSE, and prose like "add rate limit
        // handling" or "fix the 403 handling" would classify as a gate class —
        // a count-free requeue loop plus a queue-wide latch only an operator
        // can clear (a latched queue never emits the reportSuccess that would
        // clear it). See the Task-6 review.
        const cls = classifyProviderFailure(result.errorMessage);
        if (deps.gate && GATE_CLASSES.has(cls)) {
          const reason = result.errorMessage ?? cls;
          deps.gate.reportFailure(cls, reason);
          const rq = requeueTicketKeepBudget(cfg, claimedPath, deps.gate.notBeforeIso(), reason);
          await cleanupWorktree(cfg, ctx, wtPath);
          log.warn("provider-gate requeue", { dst: rq.dst, class: cls });
          return requeuedResult(rq.dst, result);
        }
        if (deps.gate && cls === "outage") deps.gate.reportFailure(cls, result.errorMessage ?? cls);
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
      // A clean no-changes finish is a genuine inference-side success (reached
      // only past every gate/outage/stop_reason failure branch above) —
      // report it so the gate's failure streak heals. Guarded on
      // !abortedByGuard alone: timedOut was already excluded earlier in this
      // block, and having gotten this far without hitting Phase 5's hardError
      // return means errorMessage is null whenever abortedByGuard is false too.
      if (deps.gate && !result.abortedByGuard) deps.gate.reportSuccess();
      return flowResult(finalizePr(claimedPath, result, prOutcome, { dirs }), prOutcome, result);
    }

    // Phase 9: post-session review (skip on a guard-aborted or timed-out
    // session — the work is by definition incomplete; review would mis-flag).
    // extraUsages collects every session run in this phase (critic pass 1,
    // corrective, critic pass 2 — whichever executed) so their usage can be
    // summed into the main run's for the ticket's recorded cost/tokens.
    const skipPostSessionReview = result.abortedByGuard || result.timedOut;
    // Apply mode skips the CRITIC specifically (not verification): the diff
    // IS the spec the ticket carried, so an LLM comparing the diff against
    // itself is tautological. Spec verification is a separate, independent
    // check (the ticket's own `## Verification` blocks) and still runs.
    //
    // NARROWED for Stage 2a: that tautology only holds while the patch itself
    // is what landed. The moment an apply-fallback session ran (the agent
    // improvised against the patch as spec, not the patch's own bytes), diff-
    // vs-spec review is meaningful again — skip on "patch applied AND no
    // fallback ran", not merely "this ticket carried a patch" (appliedCleanly,
    // computed right after Phase 4).
    const skipCritic = skipPostSessionReview || appliedCleanly;
    const extraUsages: Usage[] = [];
    if (skipCritic) {
      // Record the skip as metadata (parity with worker.py PrOutcome.critic =
      // CriticResult(status="skipped", ...)). The buildPrBody banner only fires
      // on pass/missing, so this never surfaces in the PR body — metadata only.
      prOutcome.critic = {
        status: "skipped",
        findings: appliedCleanly
          ? "apply mode — the patch series is the spec"
          : result.timedOut
            ? "timed-out session"
            : "aborted-by-repetition session",
        rawOutput: "",
        usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
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

      // Stage 2b escalation ladder (apply-tickets-design.md): the patch
      // applied cleanly, but the ticket's own `## Verification` block then
      // failed. Same shape as Stage 2a's apply-failure fallback (Phase 4)
      // above — the agent gets the patch as SPEC plus the verification
      // failure as context, not bytes to replay — but triggered by a failed
      // check instead of a failed `git am`. Trigger, ALL required:
      //   - the ticket applied a series (patchSeries !== null),
      //   - no fallback has run yet (never escalate twice — this block sets
      //     prOutcome.applyFallback below, which also excludes a ticket that
      //     already fell back in Phase 4 for an apply failure),
      //   - verification actually reported failures, and
      //   - the toggle is on.
      // ONE attempt, never a loop (ruling R3): after the re-verify below,
      // whatever it says stands — Phase 10 gates on it exactly as usual.
      if (
        patchSeries !== null &&
        prOutcome.applyFallback === null &&
        prOutcome.verification.failedOutputs.length > 0 &&
        cfg.applyFallbackToAgent
      ) {
        const detail = formatVerificationFailureDetail(prOutcome.verification);
        log.warn(
          "spec verification failed on a clean apply — falling back to the agent " +
            "(worker.applyFallbackToAgent)",
        );
        prOutcome.applyFallback = { kind: "verification", reason: detail };
        // Flips the critic-skip narrowing right below: the diff is no longer
        // the whole story once the agent has improvised against it, so the
        // critic pass treats this ticket like an ordinary agent ticket —
        // mirrors Phase 4's Stage-2a `appliedCleanly = false`. Phase 6 (the
        // no-sweep rule) already ran on the original clean-apply value above
        // and is unaffected by this reassignment.
        appliedCleanly = false;
        const fallbackPrompt = buildApplyFallbackPrompt(task, patchSeries, {
          kind: "verification",
          detail,
        });
        const fallback = await runEnveloped(
          flowCfg,
          {
            ticketId: task.id,
            flow: "pr_apply_fallback",
            body: fallbackPrompt,
            cwd: wtPath,
            timeoutMs: task.timeoutSeconds * 1000,
          },
          {
            createSession: makeAgentSessionFactory(),
            abortSignal: deps.abortSignal,
            onProgress: deps.onProgress,
            onGuardDecision: deps.onGuardDecision,
            spend: deps.spend,
          },
        );
        extraUsages.push(fallback.usage);
        log.info(`apply fallback (verification): agent abortedByGuard=${fallback.abortedByGuard}`);
        // Re-count/list commits (mirrors the critic corrective-retry
        // re-evaluation below) and re-run verification exactly once.
        newCommits = await countNewCommits(cfg, wtPath, sinceRef);
        prOutcome.commits = await listNewCommits(cfg, wtPath, sinceRef);
        prOutcome.verification = await runSpecVerification(cfg, task, wtPath);
        log.info(
          `spec verification (post-fallback): ${prOutcome.verification.blocksPassed}/${prOutcome.verification.blocksRun} checks passed`,
        );
      }

      if (!appliedCleanly) {
        const critic = await runCriticPass(cfg, task, wtPath, sinceRef, {
          criticSessionFactory: deps.criticSessionFactory,
        });
        prOutcome.critic = critic;
        extraUsages.push(critic.usage);
        deps.spend?.recordUsd(critic.usage.costUsd);
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
          // Same ticketId → the envelope derives the same transcript path as
          // the main run, so this turn appends to the same chronological
          // record (second open finds the file exists → no second junco_meta).
          const corrective = await runEnveloped(
            flowCfg,
            {
              ticketId: task.id,
              flow: "pr_corrective",
              body: buildCorrectivePrompt(task, critic.findings),
              cwd: wtPath,
              timeoutMs: task.timeoutSeconds * 1000,
            },
            {
              createSession: correctiveFactory,
              abortSignal: deps.abortSignal,
              onProgress: deps.onProgress,
              onGuardDecision: deps.onGuardDecision,
              spend: deps.spend,
            },
          );
          extraUsages.push(corrective.usage);
          prOutcome.criticRetriesUsed = 1;
          log.info(`critic retry: agent abortedByGuard=${corrective.abortedByGuard}`);
          // Re-evaluate commits + critic + verification after the retry.
          newCommits = await countNewCommits(cfg, wtPath, sinceRef);
          prOutcome.commits = await listNewCommits(cfg, wtPath, sinceRef);
          const criticAfter = await runCriticPass(cfg, task, wtPath, sinceRef, {
            criticSessionFactory: deps.criticSessionFactory,
          });
          prOutcome.critic = criticAfter;
          extraUsages.push(criticAfter.usage);
          deps.spend?.recordUsd(criticAfter.usage.costUsd);
          log.info(
            `critic (post-retry): ${criticAfter.status}${criticAfter.findings ? ` (${criticAfter.findings.slice(0, 120)})` : ""}`,
          );
          prOutcome.verification = await runSpecVerification(cfg, task, wtPath);
        }
      }
    }

    // extraUsages is empty when post-session review was skipped (guard-abort
    // / timeout), in which case this is a no-op copy of `result`.
    finalResult = { ...result, usage: sumUsage(result.usage, extraUsages) };

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
        finalizePr(claimedPath, finalResult, prOutcome, { dirs, phaseError }),
        prOutcome,
        finalResult,
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
      return flowResult(
        finalizePr(claimedPath, finalResult, prOutcome, { dirs }),
        prOutcome,
        finalResult,
      );
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
      return flowResult(
        finalizePr(claimedPath, finalResult, prOutcome, { dirs }),
        prOutcome,
        finalResult,
      );
    }
    const phaseError = `push/commit failed: ${e.message}`;
    prOutcome.worktreePreserved = true;
    log.error(phaseError);
    return flowResult(
      finalizePr(claimedPath, finalResult, prOutcome, { dirs, phaseError }),
      prOutcome,
      finalResult,
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
      const bodyText = buildPrBody(task, ctx, prOutcome, finalResult);
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
        return flowResult(
          finalizePr(claimedPath, finalResult, prOutcome, { dirs }),
          prOutcome,
          finalResult,
        );
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
          finalizePr(claimedPath, finalResult, prOutcome, { dirs, phaseError }),
          prOutcome,
          finalResult,
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
  // A guard-kill or timeout can reach this same return with commits salvaged
  // (aborted_partial/timeout_partial) — that's not a clean inference-side
  // success (mirrors the Q&A gate wiring in runOnce.ts, which excludes both).
  if (deps.gate && !result.abortedByGuard && !result.timedOut) deps.gate.reportSuccess();
  return flowResult(
    finalizePr(claimedPath, finalResult, prOutcome, { dirs }),
    prOutcome,
    finalResult,
  );
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
