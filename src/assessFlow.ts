/**
 * `junco assess` orchestrator — an assess ticket runs through here. It mirrors
 * the Q&A path (runOnce.ts:120-260) for containment, read-only tools, the
 * supervisor/guard wiring, the transcript, the transient requeue, and the
 * finalize, then layers on the assess-specific work: an `npm audit` dependency
 * scan, parsing the agent's findings, a hallucination filter, severity +
 * fingerprint dedup, GitHub-side dedup, capping, and idempotent issue filing
 * through the outbox seam (githubOutbox.ts).
 *
 * Design posture (ported from prFlow.ts): expected failures NEVER throw out of
 * runAssessFlow — a fatal phase error finalizes the ticket to failed/ with the
 * phase message carried in the RunResult errorMessage. Issues are only filed
 * AFTER all analysis, so a transient rerun converges through fingerprint dedup.
 */

import { mkdtempSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import type { Config, Ticket, RunResult } from "./types.js";
import { queuePaths, expandHome } from "./config.js";
import { gh, git, runCmd, GitOpError, isNetworkError } from "./git.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { GuardManager } from "./agent/guardManager.js";
import { finalize, type TerminalDirs } from "./finalize.js";
import { isTransientFailure, requeueTicket } from "./requeue.js";
import { READ_ONLY_TOOLS } from "./runOnce.js";
import { slugifyId } from "./slug.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import {
  tryOrEnqueue,
  ensureFindingLabels,
  fetchFindingMarkers,
  type OutboxOp,
} from "./githubOutbox.js";
import {
  parseAgentFindings,
  findingsFromNpmAudit,
  buildIssueTitle,
  buildIssueBody,
  findingLabels,
  SEVERITY_RANK,
  type Finding,
} from "./findings.js";
import { log } from "./logging.js";

const GH_TIMEOUT = 60_000;
const NPM_AUDIT_TIMEOUT = 180_000; // npm audit can be slow on a cold registry cache

export interface AssessDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  runCmdFn?: typeof runCmd;
  sessionFactoryFor?: (cfg: Config, cwd: string) => () => Promise<AgentSessionLike>;
  abortSignal?: AbortSignal;
  onProgress?: Parameters<typeof runAgent>[0]["onProgress"] extends infer T ? T : never;
  nowFn?: () => Date;
}

export interface AssessFlowResult {
  dst: string; // finalized path (done/ or failed/)
  status: string; // finalize status
  requeued: boolean; // transient agent failure -> ticket went back to inbox
  result: RunResult; // what finalize consumed (finalText = the summary)
  found: number; // findings after merge+filter+within-run dedupe
  deduped: number; // dropped because already filed on GitHub
  created: number; // issues created live
  queuedOffline: number; // issue-create ops enqueued to the outbox
  dropped: number; // invalid/hallucinated agent findings dropped
  capped: number; // findings beyond maxIssuesPerRun
  failed: number; // per-finding non-network create failures
  urls: string[]; // URLs of issues created live
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
    usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
    stopReason: null,
    errorMessage,
    timedOut: false,
    durationMs: 0,
    abortedByGuard: false,
  };
}

/** Create ONE finding issue live and return the URL gh prints, or null. Mirrors
 * the outbox executor's issue-create live path (githubOutbox.ts:499-520): the
 * body goes to a temp file, labels flatten into repeated --label flags. */
async function createIssueLive(
  cfg: Config,
  nwo: string,
  title: string,
  bodyText: string,
  labels: string[],
  ghFn: typeof gh,
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "junco-assess-"));
  const file = join(dir, "issue.md");
  writeFileSync(file, bodyText, "utf8");
  try {
    const out = await ghFn(
      cfg,
      [
        "issue",
        "create",
        "--repo",
        nwo,
        "--title",
        title,
        "--body-file",
        file,
        ...labels.flatMap((l) => ["--label", l]),
      ],
      { timeoutMs: GH_TIMEOUT },
    );
    return (
      out.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("https://")) ?? null
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    created: 0,
    queuedOffline: 0,
    dropped: 0,
    capped: 0,
    failed: 0,
  };
  const urls: string[] = [];
  const cappedTitles: string[] = [];
  const warnings: string[] = [];

  const buildSummary = (phaseError: string | null): string => {
    const parts: string[] = ["## junco assess", `_Assessed ${nowFn().toISOString()}_`];
    if (phaseError) parts.push(`**Failed:** ${phaseError}`);
    parts.push(
      [
        `- Findings (after filter + dedupe): ${counts.found}`,
        `- Filed live: ${counts.created}`,
        `- Queued offline: ${counts.queuedOffline}`,
        `- Already filed (skipped): ${counts.deduped}`,
        `- Dropped (invalid or hallucinated): ${counts.dropped}`,
        `- Capped (beyond maxIssuesPerRun): ${counts.capped}`,
        `- Failed to file: ${counts.failed}`,
      ].join("\n"),
    );
    if (urls.length > 0) {
      parts.push("### Issues created\n\n" + urls.map((u) => `- ${u}`).join("\n"));
    }
    if (cappedTitles.length > 0) {
      parts.push("### Capped — re-run to file\n\n" + cappedTitles.map((t) => `- ${t}`).join("\n"));
    }
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
      urls,
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
    transcriptPath: cfg.transcriptsEnabled
      ? join(cfg.stateDir, "transcripts", `${slugifyId(ticket.id)}.jsonl`)
      : undefined,
  });

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
        created: 0,
        queuedOffline: 0,
        dropped: 0,
        capped: 0,
        failed: 0,
        urls: [],
      };
    }
  }

  // A timeout or guard-abort does NOT abort the flow: we proceed and file
  // whatever findings exist. The final status still reflects it via finalize's
  // statusFor (ticket → failed/), and the summary records what was filed.
  const parsed = parseAgentFindings(agentResult.finalText);
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

  // --- Phase 7: Cap. Keep the first maxIssuesPerRun; record the rest (with
  // titles) so the operator can re-run to file them. ---
  const toFile = afterDedup.slice(0, cfg.assess.maxIssuesPerRun);
  const overflow = afterDedup.slice(cfg.assess.maxIssuesPerRun);
  counts.capped = overflow.length;
  for (const f of overflow) cappedTitles.push(buildIssueTitle(f));

  const autoPlan = ticket.assess?.autoPlan ?? false;

  // --- Phase 8: Labels, best effort. The outbox executor re-ensures labels on
  // replay, and a live create against a missing label fails per-finding below
  // and is counted — so a failure here is only a recorded warning. ---
  if (toFile.length > 0) {
    const labelUnion = new Set<string>();
    for (const f of toFile) {
      for (const l of findingLabels(f, { autoPlan, triggerLabel: cfg.github.triggerLabel })) {
        labelUnion.add(l);
      }
    }
    try {
      await ensureFindingLabels(cfg, nwo, [...labelUnion], ghFn);
    } catch (e) {
      warnings.push(`could not ensure finding labels (best effort): ${describeError(e)}`);
    }
  }

  // --- Phase 9: File issues. Each finding goes through tryOrEnqueue: a live
  // create when GitHub is reachable, else a durable outbox op. A non-network
  // create failure counts the finding as failed and CONTINUES with the rest. ---
  for (const f of toFile) {
    const title = buildIssueTitle(f);
    const bodyText = buildIssueBody(f);
    const labels = findingLabels(f, { autoPlan, triggerLabel: cfg.github.triggerLabel });
    const op: OutboxOp = {
      kind: "issue-create",
      nwo,
      title,
      bodyText,
      labels,
      fingerprint: f.fingerprint,
    };
    let createdUrl: string | null = null;
    try {
      const outcome = await tryOrEnqueue(cfg, "assess", op, async () => {
        createdUrl = await createIssueLive(cfg, nwo, title, bodyText, labels, ghFn);
      });
      if (outcome === "sent") {
        counts.created++;
        if (createdUrl) urls.push(createdUrl);
      } else {
        counts.queuedOffline++;
      }
    } catch (e) {
      counts.failed++;
      warnings.push(`could not file "${title}": ${describeError(e)}`);
    }
  }

  // --- Phase 10: Finalize with the agent's usage/duration/stop metadata but
  // the summary as finalText. ---
  return finalizeAssess(agentResult, null);
}
