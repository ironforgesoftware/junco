import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Config, Ticket } from "./types.js";
import { queuePaths, expandHome } from "./config.js";
import { discoverTasks, claim } from "./queue.js";
import { parseTicket } from "./ticket.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { GuardManager } from "./agent/guardManager.js";
import { finalize } from "./finalize.js";
import { deriveRepoContext } from "./repoContext.js";
import { runPrFlow } from "./prFlow.js";
import { isTransientFailure, requeueTicket } from "./requeue.js";
import {
  NOOP_REPORTER,
  outcomeFromPrFlow,
  outcomeFromQa,
  type TicketReporter,
} from "./reporter.js";
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
  /** Lifecycle feedback (GitHub bridge). Defaults to a no-op. */
  reporter?: TicketReporter;
}

/** One claimed unit of work, ready to execute. */
export interface ClaimedWork {
  ticket: Ticket;
  claimedPath: string;
  /** Resolved repo path for per-repo serialization; null for Q&A tickets. */
  repoKey: string | null;
}

export interface ClaimOpts {
  /** Repo keys currently executing — tickets targeting them stay queued. */
  skipRepoKeys?: Set<string>;
  /** Probe before claiming: false → claim nothing this poll. */
  readyFn?: () => Promise<boolean>;
}

/**
 * Discover, filter (not_before, busy repos), priority-sort, and atomically
 * claim the next eligible ticket. Returns null when nothing is claimable.
 */
export async function claimNextTask(
  cfg: Config,
  opts: ClaimOpts = {},
): Promise<ClaimedWork | null> {
  const paths = queuePaths(cfg);
  const candidates = discoverTasks(paths.inbox);
  if (candidates.length === 0) return null;

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
  if (parsed.length === 0) return null;

  // not_before gate (retry backoff / scheduled tickets). An unparseable stamp
  // counts as eligible — a malformed date must not strand a ticket forever.
  const now = Date.now();
  const eligible = parsed.filter((t) => {
    if (!t.notBefore) return true;
    const ts = Date.parse(t.notBefore);
    return Number.isNaN(ts) || ts <= now;
  });
  if (eligible.length === 0) return null;

  // Readiness gate: when there IS eligible work, don't claim it unless the
  // inference endpoint can actually serve it.
  if (opts.readyFn && !(await opts.readyFn())) {
    log.warn("inference endpoint not ready; leaving inbox untouched this poll", {
      eligible: eligible.length,
    });
    return null;
  }

  for (const t of eligible) {
    const repoKey =
      t.hasRepo && typeof t.frontmatter.repo === "string"
        ? resolve(expandHome(t.frontmatter.repo))
        : null;
    if (repoKey && opts.skipRepoKeys?.has(repoKey)) continue; // repo busy — leave queued
    const claimed = claim(t.path, paths.processing);
    if (!claimed) {
      log.info("source vanished before claim", { id: t.id });
      continue; // lost a race — try the next candidate
    }
    return { ticket: t, claimedPath: claimed, repoKey };
  }
  return null;
}

/** Validate a Q&A ticket's workdir: must exist, be a directory, and (when the
 * allowed_repo_roots rail is configured) sit under one of the roots. Invalid →
 * warn + fall back to the default cwd; never fails the ticket. */
function resolveQaCwd(t: Ticket, cfg: Config, fallback: string): string {
  if (!t.workdir) return fallback;
  const wd = resolve(expandHome(t.workdir));
  let isDir = false;
  try {
    isDir = statSync(wd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    log.warn("workdir missing or not a directory; using default cwd", { id: t.id, workdir: wd });
    return fallback;
  }
  if (cfg.allowedRepoRoots.length > 0) {
    const ok = cfg.allowedRepoRoots.some((root) => {
      const r = resolve(expandHome(root));
      return wd === r || wd.startsWith(r + sep);
    });
    if (!ok) {
      log.warn("workdir outside allowed_repo_roots; using default cwd", {
        id: t.id,
        workdir: wd,
      });
      return fallback;
    }
  }
  return wd;
}

/** Execute one claimed ticket to its terminal state (or a requeue). */
export async function executeClaimed(
  cfg: Config,
  work: ClaimedWork,
  deps: RunDeps = {},
): Promise<void> {
  const next = work.ticket;
  const claimed = work.claimedPath;
  const paths = queuePaths(cfg);
  await withTicket(next.id, async (): Promise<void> => {
    // Expose the in-flight ticket on the metrics singleton (read by /health);
    // the finally clears it for BOTH the PR-flow and Q&A paths so the daemon
    // reports idle once the task ends, however it ends.
    metrics.taskStarted(next.id);
    const reporter = deps.reporter ?? NOOP_REPORTER;
    try {
      log.info("claimed", { src: next.path, dst: claimed });
      await reporter.onStart(next).catch(() => undefined);

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
          const flow = await runPrFlow(cfg, next, claimed, ctx, {
            sessionFactoryFor: deps.sessionFactoryFor,
            criticSessionFactory: deps.criticSessionFactory,
            abortSignal: deps.abortSignal,
            onProgress: (p) => metrics.setTaskProgress(next.id, p),
          });
          if (flow.requeued) await reporter.onRequeue(next).catch(() => undefined);
          else await reporter.onFinal(next, outcomeFromPrFlow(flow)).catch(() => undefined);
          log.info("finalized (pr-flow)", { dst: flow.dst, status: flow.status });
          return;
        }
        // ctx === null means no usable `repo:` — fall through to the Q&A path.
        log.warn("hasRepo ticket produced no repo context; treating as Q&A", { id: next.id });
      }

      // Q&A has no worktree; cwd hosts only read-only tools. A validated ticket
      // workdir (e.g. a bridged repo clone) overrides the processing dir.
      const cwd = resolveQaCwd(next, cfg, paths.processing);
      // Q&A default is the read-only subset; an explicit ticket `tools:` is an
      // owner-authored opt-in and is used verbatim.
      const qaTools = next.tools ?? cfg.tools.filter((t) => READ_ONLY_TOOLS.has(t));
      // Planning tickets may run a stronger model id (same endpoint/key) —
      // plan quality is the biggest lever on execution quality.
      const qaModel =
        next.github?.kind === "plan" && cfg.github.plannerModelId
          ? { ...cfg.model, id: cfg.github.plannerModelId }
          : cfg.model;
      const qaCfg: Config = { ...cfg, tools: qaTools, model: qaModel };
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
        if (rq.requeued) {
          await reporter.onRequeue(next).catch(() => undefined);
          return;
        }
      }
      const fin = finalize(claimed, result, { done: paths.done, failed: paths.failed });
      await reporter.onFinal(next, outcomeFromQa(fin.status, result)).catch(() => undefined);
      log.info("finalized", { dst: fin.dst, status: fin.status });
    } finally {
      metrics.taskEnded(next.id); // also clears this ticket's progress
    }
  });
}

/**
 * Claim and execute ONE ticket (the serial path: the daemon at
 * max_concurrent=1, `junco run-once`, cron pokes). Returns whether a ticket
 * was handled.
 */
export async function runOnce(cfg: Config, deps: RunDeps = {}): Promise<boolean> {
  const work = await claimNextTask(cfg, { readyFn: deps.readyFn });
  if (!work) return false;
  await executeClaimed(cfg, work, deps);
  return true;
}
