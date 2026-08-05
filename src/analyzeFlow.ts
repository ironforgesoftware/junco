/**
 * `junco analyze` orchestrator — an analyze ticket runs through here. It mirrors
 * the assess path (assessFlow.ts) for containment, nwo resolution, read-only
 * tools, the supervisor/guard wiring, the transcript, the transient requeue,
 * and the finalize — but the analyze-specific work is smaller: extract the
 * agent's investigation comment from a `junco-comment` fence, sanitize it
 * (stripping any spoofed HTML markers), and PARK it in the durable comment
 * review store (commentReview.ts) for a separate, human-confirmed post step
 * (`junco analyze post <id>`). There is no npm audit, no findings parse/dedup,
 * and no GitHub read — analysis is a single read-only agent run plus a park.
 *
 * Design posture (ported from assessFlow.ts / prFlow.ts): expected failures
 * NEVER throw out of runAnalyzeFlow — a fatal phase error finalizes the ticket
 * to failed/ with the phase message carried in the RunResult errorMessage.
 * Nothing is posted here — the draft is PARKED, keyed by ticket id, so a
 * transient rerun simply overwrites the draft and converges.
 */

import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { Config, Ticket, RunResult } from "./types.js";
import type { SpendLedger } from "./spendLedger.js";
import { queuePaths, expandHome } from "./config.js";
import { git, GitOpError } from "./git.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { GuardManager } from "./agent/guardManager.js";
import { finalize, type TerminalDirs } from "./finalize.js";
import { isTransientFailure, requeueTicket } from "./requeue.js";
import { READ_ONLY_TOOLS } from "./runOnce.js";
import { transcriptPathFor } from "./slug.js";
import { dataTreePaths } from "./dataTree.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { extractLastFencedBlock, sanitizeFindingText } from "./findings.js";
import { writeDraft, type PendingComment } from "./commentReview.js";
import { syncExternalClone } from "./externalRepo.js";
import { log } from "./logging.js";

// The fenced block the agent emits its investigation comment in. Distinct from
// findings.ts's FINDINGS_FENCE — assess parses `junco-findings`, analyze parses
// this. sanitizeFindingText's cap for the parked draft body.
const COMMENT_FENCE = "junco-comment";
const MAX_DRAFT = 60_000;
const MAX_ISSUE_TITLE = 300; // display-only; mirrors assess's title cap

export interface AnalyzeDeps {
  gitFn?: typeof git;
  sessionFactoryFor?: (cfg: Config, cwd: string) => () => Promise<AgentSessionLike>;
  abortSignal?: AbortSignal;
  onProgress?: Parameters<typeof runAgent>[0]["onProgress"] extends infer T ? T : never;
  /** Guard-decision hook (nudge/kill) for the /health guard counters (#37). */
  onGuardDecision?: Parameters<typeof runAgent>[0]["onGuardDecision"];
  nowFn?: () => Date;
  /** Per-day spend ledger (Phase-3 Task 4), peer of prFlow/runOnce's
   * RunDeps.spend: the analyze agent run's resolved `usage.costUsd` is
   * recorded here immediately after it completes, mirroring the Q&A/PR-flow
   * pattern. Optional: absent (CLI one-shot, tests) is a no-op. */
  spend?: Pick<SpendLedger, "recordUsd">;
}

export interface AnalyzeFlowResult {
  dst: string; // finalized path (done/ or failed/)
  status: string; // finalize status
  requeued: boolean; // transient agent failure -> ticket went back to inbox
  result: RunResult; // what finalize consumed (finalText = the summary)
  parked: boolean; // a comment draft was written to the review store
}

/** Prefer the actionable stderr on a GitOpError, mirroring assessFlow's
 * describeError — a bare `.message` is often a generic "<bin> failed (exit N)". */
function describeError(e: unknown): string {
  if (e instanceof GitOpError) return e.stderr || e.message;
  return e instanceof Error ? e.message : String(e);
}

/** A zeroed RunResult for phases that fail before (or instead of) an agent run;
 * errorMessage carries the reason. Port of assessFlow.ts emptyRunResult. */
function emptyRunResult(errorMessage: string): RunResult {
  return {
    finalText: "",
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 },
    stopReason: null,
    errorMessage,
    timedOut: false,
    durationMs: 0,
    abortedByGuard: false,
  };
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
    const parts: string[] = ["## junco analyze", `_Analyzed ${nowFn().toISOString()}_`];
    if (phaseError) parts.push(`**Failed:** ${phaseError}`);
    if (parked) parts.push(`draft parked — junco analyze review ${ticket.id}`);
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

  // --- Phase 1: Target resolution + containment. Mirror assessFlow Phase 1
  // (and resolveQaCwd's containment semantics) EXACTLY — including the empty
  // allowedRepoRoots ⇒ anywhere rule — but a violation is a phase error here. ---
  const repoRaw = ticket.frontmatter.repo;
  if (typeof repoRaw !== "string") {
    return finalizeAnalyze(null, "analyze: ticket has no repo path");
  }
  const repoPath = resolve(expandHome(repoRaw));
  let isDir = false;
  try {
    isDir = statSync(repoPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return finalizeAnalyze(null, `analyze: repo path is not a directory: ${repoPath}`);
  }
  if (cfg.allowedRepoRoots.length > 0) {
    const ok = cfg.allowedRepoRoots.some((root) => {
      const r = resolve(expandHome(root));
      return repoPath === r || repoPath.startsWith(r + sep);
    });
    if (!ok) {
      return finalizeAnalyze(null, `analyze: repo path not permitted: ${repoPath}`);
    }
  }

  // --- Phase 2: analyze block + nwo. runOnce routes on ticket.analyze, but
  // defense-in-depth: without it there is no issue to draft against. Without a
  // parseable GitHub origin the draft has no target repo, so both are fatal. ---
  if (!ticket.analyze) {
    return finalizeAnalyze(null, "analyze: ticket has no analyze block");
  }
  let nwo: string;
  try {
    const remote = await gitFn(cfg, ["remote", "get-url", "origin"], { cwd: repoPath });
    const parsed = nwoFromRemoteUrl(remote.stdout.trim());
    if (!parsed) {
      return finalizeAnalyze(null, "analyze: origin remote is not a parseable GitHub repo");
    }
    nwo = parsed;
  } catch (e) {
    return finalizeAnalyze(null, `analyze: could not read origin remote — ${describeError(e)}`);
  }

  // --- Phase 2b: External detection (path-based). A managed clone lives under
  // cfg.github.externalReposRoot; the operator's OWNED checkouts never do. This
  // gates both the freshness sync below and the parked draft's `external` flag. ---
  const externalRoot = resolve(expandHome(cfg.github.externalReposRoot));
  const external = repoPath === externalRoot || repoPath.startsWith(externalRoot + sep);

  // --- Phase 2c: Freshness sync — EXTERNAL clones ONLY. Junco owns these
  // clones, so a fetch + hard-reset to upstream's default branch is safe and
  // makes the analysis reflect live upstream, not the provisioned snapshot.
  // NEVER run this on an owned checkout (it would blow away the operator's
  // tree). A failure is a recorded warning, not fatal. ---
  if (external) {
    try {
      await syncExternalClone(cfg, repoPath, { gitFn });
    } catch (e) {
      warnings.push(`could not sync external clone to upstream default: ${describeError(e)}`);
    }
  }

  // --- Phase 3: Agent run. Mirror assessFlow's agent block: read-only tool
  // default, cwd = repoPath, supervisor gated the same way, same transcript
  // convention, timeout from the ticket, abortSignal/onProgress threaded. ---
  const analyzeTools = ticket.tools ?? cfg.tools.filter((t) => READ_ONLY_TOOLS.has(t));
  const analyzeCfg: Config = { ...cfg, tools: analyzeTools };
  const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(analyzeCfg, repoPath);
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
  const agentResult = await runAgent({
    body: ticket.body,
    cwd: repoPath,
    timeoutMs: ticket.timeoutSeconds * 1000,
    createSession: factory,
    guardManager,
    abortSignal: deps.abortSignal,
    onProgress: deps.onProgress,
    onGuardDecision: deps.onGuardDecision,
    transcriptPath: cfg.transcriptsEnabled
      ? transcriptPathFor(dataTreePaths(cfg).transcripts, ticket.id)
      : undefined,
  });
  // Record spend immediately, BEFORE any requeue/finalize branching below —
  // mirrors runOnce.ts's Q&A wire, prFlow's main-session record, and
  // assessFlow's Phase-3 Task 4 wire: the dollars were spent regardless of
  // what the ticket does next. No-op when deps.spend is absent or costUsd is
  // 0/non-finite.
  deps.spend?.recordUsd(agentResult.usage.costUsd);

  // --- Phase 4: Transient failure → requeue with backoff (mirror
  // assessFlow.ts:271-290). Safe because nothing is parked yet: a rerun
  // overwrites the draft and converges. On a successful requeue return early;
  // an exhausted budget falls through to the normal (failed/) finalize. ---
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
  // mirror assessFlow.ts:299's allText ?? finalText). No complete fence (or an
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
