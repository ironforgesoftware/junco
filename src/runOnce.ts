import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { discoverTasks, claim } from "./queue.js";
import { parseTicket } from "./ticket.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { GuardManager } from "./agent/guardManager.js";
import { finalize } from "./finalize.js";
import { deriveRepoContext } from "./repoContext.js";
import { runPrFlow } from "./prFlow.js";
import { isTransientFailure, requeueTicket } from "./requeue.js";
import { log, withTicket } from "./logging.js";
import { metrics } from "./metrics.js";

const PRIORITY_RANK: Record<string, number> = { high: 2, normal: 1, low: 0 };

// A Q&A ticket has no worktree and shouldn't mutate the filesystem; give its
// session a read-only tool subset so a stray write/bash/edit can't corrupt the
// claimed ticket sitting in processing/ (PR-flow tickets in a worktree get the
// full set in a later milestone).
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface RunDeps {
  // Injection seam: returns a session factory for (cfg, cwd). Defaults to the real Pi SDK.
  sessionFactoryFor?: (cfg: Config, cwd: string) => () => Promise<AgentSessionLike>;
  // Critic session factory, threaded into the PR-flow (tests control its verdict).
  criticSessionFactory?: () => Promise<AgentSessionLike>;
  /** Probe before claiming: false → leave the inbox untouched this poll. The
   * daemon wires this to endpointReachable so an endpoint outage queues work
   * instead of burning tickets into failed/. */
  readyFn?: () => Promise<boolean>;
  /** Operator force-stop signal — aborts the in-flight agent session softly
   * (commits are salvaged). The daemon wires this to StopFlag.forceSignal. */
  abortSignal?: AbortSignal;
}

export async function runOnce(cfg: Config, deps: RunDeps = {}): Promise<boolean> {
  const paths = queuePaths(cfg);
  const candidates = discoverTasks(paths.inbox);
  if (candidates.length === 0) return false;

  // Parse defensively per-ticket: a single unreadable/vanished file (the inbox
  // can change between discover and read) must not throw the whole batch — that
  // would wedge the daemon loop on one bad file. Skip + log, keep the rest.
  const parsed = candidates
    .flatMap((p) => {
      try {
        return [parseTicket(p, readFileSync(p, "utf8"), cfg.defaultTimeoutMinutes)];
      } catch (e) {
        log.warn("skipping unreadable ticket", {
          path: p,
          error: e instanceof Error ? e.message : String(e),
        });
        return [];
      }
    })
    .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
  if (parsed.length === 0) return false;

  // not_before gate (retry backoff / scheduled tickets). An unparseable stamp
  // counts as eligible — a malformed date must not strand a ticket forever.
  const now = Date.now();
  const eligible = parsed.filter((t) => {
    if (!t.notBefore) return true;
    const ts = Date.parse(t.notBefore);
    return Number.isNaN(ts) || ts <= now;
  });
  if (eligible.length === 0) return false;

  // Readiness gate: when there IS eligible work, don't claim it unless the
  // inference endpoint can actually serve it.
  if (deps.readyFn && !(await deps.readyFn())) {
    log.warn("inference endpoint not ready; leaving inbox untouched this poll", {
      eligible: eligible.length,
    });
    return false;
  }

  const next = eligible[0];

  const claimed = claim(next.path, paths.processing);
  if (!claimed) {
    log.info("source vanished before claim", { id: next.id });
    return false;
  }

  return withTicket(next.id, async (): Promise<boolean> => {
    // Expose the in-flight ticket on the metrics singleton (read by /health);
    // the finally clears it for BOTH the PR-flow and Q&A paths so the daemon
    // reports idle once the task ends, however it ends.
    metrics.setCurrentTicket(next.id);
    try {
      log.info("claimed", { src: next.path, dst: claimed });

      // PR-flow ticket (frontmatter has `repo:`): derive the repo context and hand
      // off to the PR orchestrator. A repo-less ctx (null) falls through to Q&A.
      if (next.hasRepo) {
        const ctx = deriveRepoContext(next.frontmatter, next.id, {
          defaultBaseBranch: cfg.defaultBaseBranch,
          branchPrefix: cfg.branchPrefix,
          draftByDefault: cfg.draftByDefault,
          defaultLabels: cfg.defaultLabels,
        });
        if (ctx) {
          const dst = await runPrFlow(cfg, next, claimed, ctx, {
            sessionFactoryFor: deps.sessionFactoryFor,
            criticSessionFactory: deps.criticSessionFactory,
            abortSignal: deps.abortSignal,
            onProgress: (p) => metrics.setTaskProgress(next.id, p),
          });
          log.info("finalized (pr-flow)", { dst });
          return true;
        }
        // ctx === null means no usable `repo:` — fall through to the Q&A path.
        log.warn("hasRepo ticket produced no repo context; treating as Q&A", { id: next.id });
      }

      const cwd = paths.processing; // Q&A has no worktree; cwd hosts only read-only tools
      // Q&A default is the read-only subset; an explicit ticket `tools:` is an
      // owner-authored opt-in and is used verbatim.
      const qaTools = next.tools ?? cfg.tools.filter((t) => READ_ONLY_TOOLS.has(t));
      const qaCfg: Config = { ...cfg, tools: qaTools };
      // NOTE: if the factory throws (e.g. model unresolved), this rejects and the
      // claimed ticket is left in processing/ — orphan recovery lands in M4.
      const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(qaCfg, cwd);
      // Construct the loop-guard supervisor when enabled (M2). It feeds off the
      // agent event stream inside runAgent: nudge → mid-run steer, kill → abort.
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
      const result = await runAgent({
        body: next.body,
        cwd,
        timeoutMs: next.timeoutSeconds * 1000,
        createSession: factory,
        guardManager,
        abortSignal: deps.abortSignal,
        onProgress: (p) => metrics.setTaskProgress(next.id, p),
        transcriptPath: cfg.transcriptsEnabled
          ? join(cfg.stateDir, "transcripts", `${next.id}.jsonl`)
          : undefined,
      });
      // Transient failure (endpoint hiccup, truncated stream) → requeue with
      // backoff instead of finalizing to failed/ (budget permitting).
      if (isTransientFailure(result, 0)) {
        const rq = requeueTicket(
          cfg,
          claimed,
          next,
          result.errorMessage ?? `stop_reason=${result.stopReason}`,
        );
        if (rq.requeued) return true;
      }
      const dst = finalize(claimed, result, { done: paths.done, failed: paths.failed });
      log.info("finalized", {
        dst,
        status: result.timedOut ? "timeout" : result.errorMessage ? "failed" : "completed",
      });
      return true;
    } finally {
      metrics.setCurrentTicket(null);
      metrics.clearTaskProgress(next.id);
    }
  });
}
