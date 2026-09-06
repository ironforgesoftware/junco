/**
 * `junco investigate` orchestrator — an investigate ticket runs through here. It mirrors
 * the assess path (assessFlow.ts) for containment, nwo resolution, read-only
 * tools, the supervisor/guard wiring, the transcript, the transient requeue,
 * and the finalize — but the analyze-specific work is smaller: extract the
 * agent's investigation comment from a `junco-comment` fence, sanitize it
 * (stripping any spoofed HTML markers), and PARK it in the durable comment
 * review store (commentReview.ts) for a separate, human-confirmed post step
 * (`junco investigate post <id>`). There is no npm audit, no findings parse/dedup,
 * and no GitHub read — analysis is a single read-only agent run plus a park.
 *
 * Design posture (ported from assessFlow.ts / prFlow.ts): expected failures
 * NEVER throw out of runAnalyzeFlow — a fatal phase error finalizes the ticket
 * to failed/ with the phase message carried in the RunResult errorMessage.
 * Nothing is posted here — the draft is PARKED, keyed by ticket id, so a
 * transient rerun simply overwrites the draft and converges.
 */

import type { Config, Ticket, RunResult } from "./types.js";
import { queuePaths } from "./config.js";
import { git } from "./git.js";
import { emptyRunResult } from "./agent/runResult.js";
import { finalize, type TerminalDirs } from "./finalize.js";
import { isTransientFailure, requeueTicket } from "./requeue.js";
import {
  resolveRepoTarget,
  syncIfExternal,
  runReadOnlyRepoAgent,
  type RepoAgentDeps,
} from "./repoTarget.js";
import { sanitizeFindingText } from "./findings.js";
import { extractLastFencedBlock } from "./fences.js";
import { writeDraft, type PendingComment } from "./commentReview.js";
import { log } from "./logging.js";

// The fenced block the agent emits its investigation comment in. Distinct from
// findings.ts's FINDINGS_FENCE — assess parses `junco-findings`, analyze parses
// this. sanitizeFindingText's cap for the parked draft body.
const COMMENT_FENCE = "junco-comment";
const MAX_DRAFT = 60_000;
const MAX_ISSUE_TITLE = 300; // display-only; mirrors assess's title cap

export interface AnalyzeDeps extends RepoAgentDeps {
  gitFn?: typeof git;
  nowFn?: () => Date;
}

export interface AnalyzeFlowResult {
  dst: string; // finalized path (done/ or failed/)
  status: string; // finalize status
  requeued: boolean; // transient agent failure -> ticket went back to inbox
  result: RunResult; // what finalize consumed (finalText = the summary)
  parked: boolean; // a comment draft was written to the review store
}

export async function runAnalyzeFlow(
  cfg: Config,
  ticket: Ticket,
  claimedPath: string,
  deps: AnalyzeDeps = {},
): Promise<AnalyzeFlowResult> {
  const gitFn = deps.gitFn ?? git;
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const paths = queuePaths(cfg);
  const dirs: TerminalDirs = { done: paths.done, failed: paths.failed };

  let parked = false;
  const warnings: string[] = [];

  const buildSummary = (phaseError: string | null): string => {
    const parts: string[] = ["## junco investigate", `_Analyzed ${nowFn().toISOString()}_`];
    if (phaseError) parts.push(`**Failed:** ${phaseError}`);
    if (parked) parts.push(`draft parked — junco investigate review ${ticket.id}`);
    if (warnings.length > 0) {
      parts.push("### Warnings\n\n" + warnings.map((w) => `- ${w}`).join("\n"));
    }
    return parts.join("\n\n");
  };

  /** Finalize + build the AnalyzeFlowResult. `agentResult` is null for phase
   * errors that fired before/without an agent run (a zeroed RunResult is
   * synthesized); `phaseError` (when set) becomes the RunResult errorMessage so
   * finalize routes the ticket to failed/. finalText is always the summary. */
  const finalizeAnalyze = (
    agentResult: RunResult | null,
    phaseError: string | null,
  ): AnalyzeFlowResult => {
    const summary = buildSummary(phaseError);
    const base = agentResult ?? emptyRunResult(phaseError ?? "analyze failed");
    const result: RunResult = {
      ...base,
      finalText: summary,
      errorMessage: phaseError ?? base.errorMessage,
    };
    const fin = finalize(claimedPath, result, dirs);
    log.info("analyze finalized", { dst: fin.dst, status: fin.status, parked });
    return { dst: fin.dst, status: fin.status, requeued: false, result, parked };
  };

  // --- Phase 1–2: Target resolution + containment + nwo (repoTarget.ts,
  // shared with assessFlow). runOnce routes on ticket.analyze, but
  // defense-in-depth: without it there is no issue to draft against. ---
  if (!ticket.analyze) {
    return finalizeAnalyze(null, "analyze: ticket has no analyze block");
  }
  const resolved = await resolveRepoTarget(cfg, ticket.frontmatter.repo, "analyze", gitFn);
  if (!resolved.ok) return finalizeAnalyze(null, resolved.error);
  const { repoPath, nwo, external } = resolved.target;
  await syncIfExternal(cfg, resolved.target, gitFn, warnings);

  // --- Phase 3: Agent run (repoTarget.ts, shared with assessFlow). ---
  const agentResult = await runReadOnlyRepoAgent(cfg, ticket, "analyze", repoPath, deps);

  // --- Phase 4: Transient failure → requeue with backoff (mirror
  // `runAssessFlow`'s transient-requeue phase in assessFlow.ts). Safe because
  // nothing is parked yet: a rerun overwrites the draft and converges. On a
  // successful requeue return early; an exhausted budget falls through to the
  // normal (failed/) finalize. ---
  if (isTransientFailure(agentResult, 0)) {
    const rq = requeueTicket(
      cfg,
      claimedPath,
      ticket,
      agentResult.errorMessage ?? `stop_reason=${agentResult.stopReason}`,
    );
    if (rq.requeued) {
      return {
        dst: rq.dst ?? claimedPath,
        status: "requeued",
        requeued: true,
        result: agentResult,
        parked: false,
      };
    }
  }

  // --- Phase 5: Extract the comment draft. A timeout or guard-abort does NOT
  // short-circuit — we still try to salvage a draft. Extract from the WHOLE
  // run, not just the last message: #36 redefined finalText as the last
  // assistant message only, so a fence banked before a trailing closing
  // message would be dropped and the run would spuriously fail (#67 class —
  // mirror assessFlow.ts's `allText ?? finalText`). No complete fence (or an
  // all-whitespace one) means the agent produced nothing to review: finalize to
  // failed/ with a clear reason, park nothing. When the run also carries a
  // transient errorMessage (endpoint hiccup, truncated stream), fold it in — a
  // truncated stream is exactly why there's no fence, and dropping the original
  // reason makes an exhausted-retry failure look like the agent simply declined
  // to comment. ---
  const phaseError = agentResult.errorMessage
    ? `analyze: no comment draft (${agentResult.errorMessage})`
    : "analyze: agent produced no comment draft";

  const fence = extractLastFencedBlock(agentResult.allText ?? agentResult.finalText, COMMENT_FENCE);
  if (fence === null || fence.trim() === "") {
    return finalizeAnalyze(agentResult, phaseError);
  }

  // --- Phase 6: Sanitize. sanitizeFindingText strips HTML comments (defeats a
  // model that tries to inject a junco marker into the draft) and control
  // chars, then caps length. An empty result after sanitize is the same
  // "nothing to review" failure as an empty fence. ---
  const draft = sanitizeFindingText(fence, MAX_DRAFT);
  if (draft === "") {
    return finalizeAnalyze(agentResult, phaseError);
  }

  // --- Phase 7: Park the draft for human-confirmed posting. Keyed by ticket
  // id, so a requeued rerun overwrites (never duplicates). The footer is
  // composed at post/preview time (commentReview.composeCommentBody). ---
  const pending: PendingComment = {
    id: ticket.id,
    nwo,
    issue: ticket.analyze.issue,
    issueTitle: sanitizeFindingText(ticket.analyze.title, MAX_ISSUE_TITLE),
    external,
    repoPath,
    createdAt: nowFn().toISOString(),
    draft,
    footer: true,
  };
  writeDraft(cfg, pending);
  parked = true;

  // --- Phase 8: Finalize with the agent's usage/duration/stop metadata but the
  // summary as finalText. ---
  return finalizeAnalyze(agentResult, null);
}
