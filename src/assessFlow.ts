/**
 * `junco assess` orchestrator — an assess ticket runs through here. It mirrors
 * the Q&A path (runOnce.ts:120-260) for containment, read-only tools, the
 * supervisor/guard wiring, the transcript, the transient requeue, and the
 * finalize, then layers on the assess-specific work: an `npm audit` dependency
 * scan, parsing the agent's findings, a hallucination filter, severity +
 * fingerprint dedup, GitHub-side dedup, and PARKING the surviving findings in
 * the durable review store (assessReview.ts) for a separate, human-confirmed
 * filing step (`junco assess file <id>` → assessFiling.ts).
 *
 * Design posture (ported from prFlow.ts): expected failures NEVER throw out of
 * runAssessFlow — a fatal phase error finalizes the ticket to failed/ with the
 * phase message carried in the RunResult errorMessage. Nothing is filed here —
 * findings are PARKED, keyed by ticket id, so a transient rerun simply
 * overwrites the batch and converges (filing dedups author-scoped at file time).
 */

import { statSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { Config, Ticket, RunResult } from "./types.js";
import type { SpendLedger } from "./spendLedger.js";
import { queuePaths, expandHome } from "./config.js";
import { gh, git, runCmd, GitOpError, isNetworkError } from "./git.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { GuardManager } from "./agent/guardManager.js";
import { finalize, type TerminalDirs } from "./finalize.js";
import { isTransientFailure, requeueTicket } from "./requeue.js";
import { READ_ONLY_TOOLS } from "./runOnce.js";
import { transcriptPathFor } from "./slug.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { fetchFindingMarkers } from "./githubOutbox.js";
import {
  parseAgentFindings,
  findingsFromNpmAudit,
  SEVERITY_RANK,
  type Finding,
} from "./findings.js";
import { writePending, type PendingAssess } from "./assessReview.js";
import { syncExternalClone } from "./externalRepo.js";
import { log } from "./logging.js";

const NPM_AUDIT_TIMEOUT = 180_000; // npm audit can be slow on a cold registry cache

export interface AssessDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  runCmdFn?: typeof runCmd;
  sessionFactoryFor?: (cfg: Config, cwd: string) => () => Promise<AgentSessionLike>;
  abortSignal?: AbortSignal;
  onProgress?: Parameters<typeof runAgent>[0]["onProgress"] extends infer T ? T : never;
  /** Guard-decision hook (nudge/kill) for the /health guard counters (#37). */
  onGuardDecision?: Parameters<typeof runAgent>[0]["onGuardDecision"];
  nowFn?: () => Date;
  /** Per-day spend ledger (Phase-3 Task 4), peer of prFlow/runOnce's
   * RunDeps.spend: the assess agent run's resolved `usage.costUsd` is
   * recorded here immediately after it completes, mirroring the Q&A/PR-flow
   * pattern. Optional: absent (CLI one-shot, tests) is a no-op. */
  spend?: Pick<SpendLedger, "recordUsd">;
}

export interface AssessFlowResult {
  dst: string; // finalized path (done/ or failed/)
  status: string; // finalize status
  requeued: boolean; // transient agent failure -> ticket went back to inbox
  result: RunResult; // what finalize consumed (finalText = the summary)
  found: number; // findings after merge+filter+within-run dedupe
  deduped: number; // dropped because already filed on GitHub
  dropped: number; // invalid/hallucinated agent findings dropped
  parked: number; // findings written to the review store awaiting human-confirmed filing
}

/** Prefer the actionable stderr on a GitOpError, mirroring githubOutbox's
 * describeError — a bare `.message` is often a generic "<bin> failed (exit N)". */
function describeError(e: unknown): string {
  if (e instanceof GitOpError) return e.stderr || e.message;
  return e instanceof Error ? e.message : String(e);
}

/** A zeroed RunResult for phases that fail before (or instead of) an agent run;
 * errorMessage carries the reason. Port of prFlow.ts emptyRunResult. */
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

export async function runAssessFlow(
  cfg: Config,
  ticket: Ticket,
  claimedPath: string,
  deps: AssessDeps = {},
): Promise<AssessFlowResult> {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const runCmdFn = deps.runCmdFn ?? runCmd;
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const paths = queuePaths(cfg);
  const dirs: TerminalDirs = { done: paths.done, failed: paths.failed };

  const counts = {
    found: 0,
    deduped: 0,
    dropped: 0,
    parked: 0,
  };
  const warnings: string[] = [];

  const buildSummary = (phaseError: string | null): string => {
    const parts: string[] = ["## junco assess", `_Assessed ${nowFn().toISOString()}_`];
    if (phaseError) parts.push(`**Failed:** ${phaseError}`);
    if (counts.parked > 0) {
      parts.push(
        `**${counts.parked} findings awaiting review — run \`junco assess file ${ticket.id}\`**`,
      );
    }
    parts.push(
      [
        `- Findings (after filter + dedupe): ${counts.found}`,
        `- Parked for review: ${counts.parked}`,
        `- Already filed (skipped): ${counts.deduped}`,
        `- Dropped (invalid or hallucinated): ${counts.dropped}`,
      ].join("\n"),
    );
    if (warnings.length > 0) {
      parts.push("### Warnings\n\n" + warnings.map((w) => `- ${w}`).join("\n"));
    }
    return parts.join("\n\n");
  };

  /** Finalize + build the AssessFlowResult. `agentResult` is null for phase
   * errors that fired before/without an agent run (a zeroed RunResult is
   * synthesized); `phaseError` (when set) becomes the RunResult errorMessage so
   * finalize routes the ticket to failed/. finalText is always the summary. */
  const finalizeAssess = (
    agentResult: RunResult | null,
    phaseError: string | null,
  ): AssessFlowResult => {
    const summary = buildSummary(phaseError);
    const base = agentResult ?? emptyRunResult(phaseError ?? "assess failed");
    const result: RunResult = {
      ...base,
      finalText: summary,
      errorMessage: phaseError ?? base.errorMessage,
    };
    const fin = finalize(claimedPath, result, dirs);
    log.info("assess finalized", { dst: fin.dst, status: fin.status, ...counts });
    return {
      dst: fin.dst,
      status: fin.status,
      requeued: false,
      result,
      ...counts,
    };
  };

  // --- Phase 1: Target resolution + containment. Mirror resolveQaCwd's
  // containment semantics (runOnce.ts:128-153) EXACTLY — including the
  // "empty allowedRepoRoots ⇒ anywhere" rule — but a violation is a phase
  // error here rather than a fall-back to the default cwd. ---
  const repoRaw = ticket.frontmatter.repo;
  if (typeof repoRaw !== "string") {
    return finalizeAssess(null, "assess: ticket has no repo path");
  }
  const repoPath = resolve(expandHome(repoRaw));
  let isDir = false;
  try {
    isDir = statSync(repoPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return finalizeAssess(null, `assess: repo path is not a directory: ${repoPath}`);
  }
  if (cfg.allowedRepoRoots.length > 0) {
    const ok = cfg.allowedRepoRoots.some((root) => {
      const r = resolve(expandHome(root));
      return repoPath === r || repoPath.startsWith(r + sep);
    });
    if (!ok) {
      return finalizeAssess(null, `assess: repo path not permitted: ${repoPath}`);
    }
  }

  // --- Phase 2: nwo. Without a parseable GitHub origin the run cannot file
  // issues anywhere, so this is fatal. ---
  let nwo: string;
  try {
    const remote = await gitFn(cfg, ["remote", "get-url", "origin"], { cwd: repoPath });
    const parsed = nwoFromRemoteUrl(remote.stdout.trim());
    if (!parsed) {
      return finalizeAssess(null, "assess: origin remote is not a parseable GitHub repo");
    }
    nwo = parsed;
  } catch (e) {
    return finalizeAssess(null, `assess: could not read origin remote — ${describeError(e)}`);
  }

  // --- Phase 2b: External detection (path-based). A managed clone lives under
  // cfg.github.externalReposRoot; the operator's OWNED checkouts never do. This
  // single boolean gates both the freshness sync below and the parked batch's
  // `external`/`autoPlan` flags. ---
  const externalRoot = resolve(expandHome(cfg.github.externalReposRoot));
  const external = repoPath === externalRoot || repoPath.startsWith(externalRoot + sep);

  // --- Phase 2c: Freshness sync — EXTERNAL clones ONLY. Junco owns these
  // clones, so a fetch + hard-reset to upstream's default branch is safe and
  // makes the audit reflect live upstream, not the provisioned snapshot. NEVER
  // run this on an owned checkout (it would blow away the operator's tree). A
  // failure is a recorded warning, not fatal — we audit the current tree. ---
  if (external) {
    try {
      await syncExternalClone(cfg, repoPath, { gitFn });
    } catch (e) {
      warnings.push(`could not sync external clone to upstream default: ${describeError(e)}`);
    }
  }

  // --- Phase 3: Dependency scan (never fatal). npm audit exits NONZERO when
  // vulns exist, hence check:false; parse stdout regardless of exit code. A
  // spawn/timeout error or a returned warning is recorded and we continue. ---
  let npmFindings: Finding[] = [];
  try {
    const audit = await runCmdFn([cfg.assess.npmBin, "audit", "--json"], {
      cwd: repoPath,
      timeoutMs: NPM_AUDIT_TIMEOUT,
      check: false,
    });
    const scan = findingsFromNpmAudit(audit.stdout);
    npmFindings = scan.findings;
    if (scan.warning) warnings.push(`npm audit: ${scan.warning}`);
  } catch (e) {
    warnings.push(`npm audit did not run: ${describeError(e)}`);
  }

  // --- Phase 4: Agent audit. Mirror the Q&A agent block (runOnce.ts:201-257):
  // read-only tool default, cwd = repoPath, supervisor gated the same way,
  // same transcript convention, timeout from the ticket, abortSignal threaded. ---
  const assessTools = ticket.tools ?? cfg.tools.filter((t) => READ_ONLY_TOOLS.has(t));
  const assessCfg: Config = { ...cfg, tools: assessTools };
  const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(assessCfg, repoPath);
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
    transcriptPath: cfg.transcriptsEnabled ? transcriptPathFor(cfg.dataDir, ticket.id) : undefined,
  });
  // Record spend immediately, BEFORE any requeue/finalize branching below —
  // mirrors runOnce.ts's Q&A wire and prFlow's main-session record: the
  // dollars were spent regardless of what the ticket does next (Phase-3
  // Task 3). No-op when deps.spend is absent or costUsd is 0/non-finite.
  deps.spend?.recordUsd(agentResult.usage.costUsd);

  // Transient failure → requeue with backoff (mirror runOnce.ts:243-254). Safe
  // because nothing has been filed yet: a rerun converges through dedup. On a
  // successful requeue return early with zero counts; an exhausted budget falls
  // through to the normal flow (which finalizes to failed/ exactly as Q&A does).
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
        found: 0,
        deduped: 0,
        dropped: 0,
        parked: 0,
      };
    }
  }

  // A timeout or guard-abort does NOT abort the flow: we proceed and park
  // whatever findings exist. The final status still reflects it via finalize's
  // statusFor (ticket → failed/), and the summary records what was parked.
  // Parse from the WHOLE run, not just the last message: #36 redefined
  // finalText as the last assistant message only, so a findings fence emitted
  // before any trailing message would be dropped and the audit would silently
  // report all-clear (#67). allText is the whole-run concatenation.
  const parsed = parseAgentFindings(agentResult.allText ?? agentResult.finalText);
  counts.dropped += parsed.dropped;

  // Hallucination filter: drop any CODE finding whose location.path resolves
  // outside repoPath or does not exist on disk (a model can invent citations).
  const agentFindings = parsed.findings.filter((f) => {
    if (f.kind !== "code" || !f.location) return true;
    const abs = resolve(repoPath, f.location.path);
    const contained = abs === repoPath || abs.startsWith(repoPath + sep);
    if (!contained || !existsSync(abs)) {
      counts.dropped++;
      return false;
    }
    return true;
  });

  // --- Phase 5: Merge (npm ∪ agent) + severity filter + within-run dedupe by
  // fingerprint (first wins). `found` is this post-filter, pre-GitHub-dedup count. ---
  const minRank = SEVERITY_RANK[cfg.assess.minSeverity];
  const seen = new Set<string>();
  const merged: Finding[] = [];
  for (const f of [...npmFindings, ...agentFindings]) {
    if (SEVERITY_RANK[f.severity] < minRank) continue;
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    merged.push(f);
  }
  counts.found = merged.length;

  // --- Phase 6: GitHub-side dedup. A NETWORK failure degrades to an empty set
  // (the outbox flush-time re-check converges); any OTHER error is fatal — we
  // cannot risk mass-refiling against an unknown upstream state. ---
  let filedMarkers: Set<string>;
  try {
    filedMarkers = await fetchFindingMarkers(cfg, nwo, ghFn);
  } catch (e) {
    if (e instanceof GitOpError && isNetworkError(e.stderr)) {
      warnings.push(`GitHub dedup unavailable (offline): ${describeError(e)}`);
      filedMarkers = new Set();
    } else {
      return finalizeAssess(agentResult, `assess: GitHub dedup failed — ${describeError(e)}`);
    }
  }
  const afterDedup = merged.filter((f) => {
    if (filedMarkers.has(f.fingerprint)) {
      counts.deduped++;
      return false;
    }
    return true;
  });

  // --- Phase 7: Park all surviving findings for human review. There is NO cap
  // here — the per-finding confirm at file time (`junco assess file <id>`) is
  // the volume gate, not this audit. The batch is keyed by ticket id, so a
  // requeued rerun overwrites (never duplicates) the pending batch. External
  // batches force autoPlan false: junco does not queue PR work against a repo
  // it does not own. Empty sets are not written (nothing to review). ---
  const parked: PendingAssess = {
    id: ticket.id,
    nwo,
    external,
    autoPlan: external ? false : (ticket.assess?.autoPlan ?? false),
    repoPath,
    createdAt: nowFn().toISOString(),
    findings: afterDedup,
    ...(ticket.assess?.issue !== undefined ? { issue: ticket.assess.issue } : {}),
  };
  if (afterDedup.length > 0) writePending(cfg, parked);
  counts.parked = afterDedup.length;

  // --- Phase 8: Finalize with the agent's usage/duration/stop metadata but
  // the summary as finalText. ---
  return finalizeAssess(agentResult, null);
}
