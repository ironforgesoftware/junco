/**
 * postSessionReview — prFlow's Phase 9, lifted out of `runPrFlow` (#353).
 *
 * Runs after the worker session has produced commits and before the
 * verification gate: spec verification, the Stage-2b escalation rung (a clean
 * apply whose `## Verification` block failed), the critic pass, and the one
 * corrective re-dispatch a MISSING verdict buys. Everything Phases 10-14 read
 * comes back in `ReviewOutcome` — the phase reads its inputs from `ReviewCtx`
 * and mutates nothing the caller owns, so both escalation rungs are reachable
 * without driving all 14 phases.
 *
 * Phase numbers in the comments below are `runPrFlow`'s, not this module's.
 */

import type { Config, RunResult, Ticket, Usage } from "./types.js";
import { countNewCommits, listNewCommits, type Commit } from "./pr.js";
import { runSpecVerification, type VerificationResult, type VerifyDeps } from "./verify.js";
import { runCriticPass, buildCorrectivePrompt, type CriticResult } from "./critic.js";
import { buildApplyFallbackPrompt } from "./applyPatch.js";
import type { PatchSeries } from "./patchTicket.js";
import { runEnveloped } from "./agent/runEnvelope.js";
import type { AgentSessionLike, runAgent } from "./agent/session.js";
import type { SpendLedger } from "./spendLedger.js";
import { log } from "./logging.js";

/** HOW a ticket executed (Stage 4a) — mirrors `PrOutcome.mode`. */
export type PrMode = "agent" | "apply" | "apply_fallback";

/** The escalation ladder's record of which rung fired — mirrors
 * `PrOutcome.applyFallback`; `kind` names the rung ("apply" = Phase 4). */
export type ApplyFallback = { kind: "apply" | "verification"; reason: string };

/** The `PrFlowDeps` subset this phase needs; `runPrFlow` passes its own deps. */
export interface ReviewDeps {
  /** Inject the critic session factory (tests control the PASS/MISSING verdict). */
  criticSessionFactory?: () => Promise<AgentSessionLike>;
  /** Operator force-stop signal, threaded into the fallback/corrective turns
   * (the critic session is deliberately NOT threaded — see PrFlowDeps). */
  abortSignal?: AbortSignal;
  onProgress?: (p: { turns: number; lastTool: string | null; outputTokens: number }) => void;
  onGuardDecision?: Parameters<typeof runAgent>[0]["onGuardDecision"];
  spend?: Pick<SpendLedger, "recordUsd">;
}

export interface ReviewCtx {
  cfg: Config;
  /** `cfg` narrowed by the ticket's `tools:` override — the config every
   * session dispatched here runs under (Phase 4 hoists it for exactly this). */
  flowCfg: Config;
  task: Ticket;
  wtPath: string;
  /** Commit-counting base: amend → pre-run HEAD, fresh → `origin/<base>`. */
  sinceRef: string;
  /** Amend mode — disables the critic's corrective re-dispatch. */
  amend: boolean;
  patchSeries: PatchSeries | null;
  /** The worker session's RunResult (or apply mode's synthesized one). */
  result: RunResult;
  /** Phase 6/7's commit count and list — returned unchanged unless a session
   * re-runs here, in which case both are re-derived from the worktree. */
  newCommits: number;
  commits: Commit[];
  /** `runPrFlow`'s `appliedCleanly`: a clean `git am` with no Phase-4 rung. */
  appliedCleanly: boolean;
  applyFallback: ApplyFallback | null;
  mode: PrMode | undefined;
  verifyDeps: VerifyDeps;
  /** Builds a fresh worker session factory (network opt-in already applied). */
  makeAgentSessionFactory: () => () => Promise<AgentSessionLike>;
  deps: ReviewDeps;
}

export interface ReviewOutcome {
  /** null when the phase was skipped (guard abort / timeout). */
  verification: VerificationResult | null;
  /** The critic's verdict, or a "skipped" record naming why. */
  criticResult: CriticResult | null;
  /** Usage of every session run here (critic pass 1, corrective, critic pass
   * 2 — whichever executed), for the ticket's aggregate cost/tokens. Empty
   * when the phase was skipped. */
  extraUsages: Usage[];
  /** `appliedCleanly` after the phase — false once the Stage-2b rung fires. */
  applyClean: boolean;
  mode: PrMode | undefined;
  applyFallback: ApplyFallback | null;
  /** The RunResult Phases 10-14 report on — REPLACED by the Stage-2b fallback
   * session's own when that rung fires, unchanged otherwise. */
  result: RunResult;
  newCommits: number;
  commits: Commit[];
  criticRetriesUsed: number;
}

/**
 * Format a failed VerificationResult for the Stage-2b escalation ladder
 * (apply-tickets-design.md): both `buildApplyFallbackPrompt`'s `detail` (what
 * the escalated agent sees as "why it failed") and `PrOutcome.applyFallback.
 * reason` (what the PR-body disclosure banner's first line names). Same
 * shape as buildPrBody's own verification banner (first 5 failures, 300-char
 * snippet) so the escalated agent sees the same signal a human reviewer would.
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

/**
 * Phase 9: post-session review (skip on a guard-aborted or timed-out session —
 * the work is by definition incomplete; review would mis-flag).
 */
export async function runPostSessionReview(ctx: ReviewCtx): Promise<ReviewOutcome> {
  const { cfg, flowCfg, task, wtPath, sinceRef, patchSeries, verifyDeps, deps } = ctx;
  let result = ctx.result;
  let appliedCleanly = ctx.appliedCleanly;
  let applyFallback = ctx.applyFallback;
  let mode = ctx.mode;
  let newCommits = ctx.newCommits;
  let commits = ctx.commits;
  let verification: VerificationResult | null = null;
  let criticResult: CriticResult | null = null;
  let criticRetriesUsed = 0;

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
    criticResult = {
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
    verification = await runSpecVerification(cfg, task, wtPath, verifyDeps);
    if (verification.skippedReason) {
      log.info(`spec verification: skipped (${verification.skippedReason})`);
    } else {
      log.info(
        `spec verification: ${verification.blocksPassed}/${verification.blocksRun} checks passed`,
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
    //     applyFallback below, which also excludes a ticket that already
    //     fell back in Phase 4 for an apply failure),
    //   - verification actually reported failures, and
    //   - the toggle is on.
    // ONE attempt, never a loop (ruling R3): after the re-verify below,
    // whatever it says stands — Phase 10 gates on it exactly as usual.
    if (
      patchSeries !== null &&
      applyFallback === null &&
      verification.failedOutputs.length > 0 &&
      cfg.applyFallbackToAgent
    ) {
      const detail = formatVerificationFailureDetail(verification);
      log.warn(
        "spec verification failed on a clean apply — falling back to the agent " +
          "(worker.applyFallbackToAgent)",
      );
      applyFallback = { kind: "verification", reason: detail };
      mode = "apply_fallback";
      // Flips the critic-skip narrowing right below: the diff is no longer
      // the whole story once the agent has improvised against it, so the
      // critic pass treats this ticket like an ordinary agent ticket —
      // mirrors Phase 4's Stage-2a `appliedCleanly = false`. Phase 6 (the
      // no-sweep rule) already ran on the original clean-apply value and is
      // unaffected by this reassignment.
      appliedCleanly = false;
      const fallbackPrompt = buildApplyFallbackPrompt(task, patchSeries, {
        kind: "verification",
        detail,
      });
      // Full fidelity (final-review R5): REPLACE `result` with the fallback
      // session's own RunResult, mirroring Stage 2a's Phase-4 fallback
      // (which assigns straight into `result` too) rather than discarding
      // everything but its usage. Downstream — computePrStatus (finalize.ts),
      // buildPrBody's guard/timeout banners and Agent-summary/metadata
      // section, and Phase 14's gate.reportSuccess() — all read
      // `result`/`finalResult`, not a separately-tracked fallback value; a
      // guard-killed or timed-out fallback must read as a partial run, and
      // the PR body must show what the agent actually did, not the
      // synthesized apply result's "Applied N patch(es)" / zero tool calls.
      // extraUsages stays untouched here: `result.usage` (now the fallback's)
      // is already the base sumUsage(...) adds onto — pushing it again
      // would double-count.
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
          createSession: ctx.makeAgentSessionFactory(),
          abortSignal: deps.abortSignal,
          onProgress: deps.onProgress,
          onGuardDecision: deps.onGuardDecision,
          spend: deps.spend,
        },
      );
      log.info(`apply fallback (verification): agent abortedByGuard=${result.abortedByGuard}`);
      // Re-count/list commits (mirrors the critic corrective-retry
      // re-evaluation below) and re-run verification exactly once.
      newCommits = await countNewCommits(cfg, wtPath, sinceRef);
      commits = await listNewCommits(cfg, wtPath, sinceRef);
      verification = await runSpecVerification(cfg, task, wtPath, verifyDeps);
      log.info(
        `spec verification (post-fallback): ${verification.blocksPassed}/${verification.blocksRun} checks passed`,
      );
    }

    if (!appliedCleanly) {
      const critic = await runCriticPass(cfg, task, wtPath, sinceRef, {
        criticSessionFactory: deps.criticSessionFactory,
      });
      criticResult = critic;
      extraUsages.push(critic.usage);
      deps.spend?.recordUsd(critic.usage.costUsd);
      log.info(
        `critic: ${critic.status}${critic.findings ? ` (${critic.findings.slice(0, 120)})` : ""}`,
      );

      if (critic.status === "missing" && cfg.criticMaxRetries > 0 && !ctx.amend) {
        log.info(
          `critic: MISSING ${critic.findings.slice(0, 120)} — re-dispatching one corrective worker turn`,
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
            createSession: ctx.makeAgentSessionFactory(),
            abortSignal: deps.abortSignal,
            onProgress: deps.onProgress,
            onGuardDecision: deps.onGuardDecision,
            spend: deps.spend,
          },
        );
        extraUsages.push(corrective.usage);
        criticRetriesUsed = 1;
        log.info(`critic retry: agent abortedByGuard=${corrective.abortedByGuard}`);
        // Re-evaluate commits + critic + verification after the retry.
        newCommits = await countNewCommits(cfg, wtPath, sinceRef);
        commits = await listNewCommits(cfg, wtPath, sinceRef);
        const criticAfter = await runCriticPass(cfg, task, wtPath, sinceRef, {
          criticSessionFactory: deps.criticSessionFactory,
        });
        criticResult = criticAfter;
        extraUsages.push(criticAfter.usage);
        deps.spend?.recordUsd(criticAfter.usage.costUsd);
        log.info(
          `critic (post-retry): ${criticAfter.status}${criticAfter.findings ? ` (${criticAfter.findings.slice(0, 120)})` : ""}`,
        );
        verification = await runSpecVerification(cfg, task, wtPath, verifyDeps);
      }
    }
  }

  return {
    verification,
    criticResult,
    extraUsages,
    applyClean: appliedCleanly,
    mode,
    applyFallback,
    result,
    newCommits,
    commits,
    criticRetriesUsed,
  };
}
