import { readFileSync, statSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Config, RunResult, Ticket } from "./types.js";
import { PRIORITY_RANK } from "./types.js";
import { queuePaths, expandHome } from "./config.js";
import { discoverTasks, claim } from "./queue.js";
import { parseTicket } from "./ticket.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { GuardManager } from "./agent/guardManager.js";
import { finalize } from "./finalize.js";
import { deriveRepoContext } from "./repoContext.js";
import { runPrFlow } from "./prFlow.js";
// NOTE: assessFlow.ts imports READ_ONLY_TOOLS from this module, so this
// import creates a module cycle. Runtime-safe: both bindings are only
// dereferenced inside function bodies (executeClaimed / runAssessFlow),
// never during module evaluation — see assess-task-7-report.md for the
// full evaluation-order rationale.
import { runAssessFlow } from "./assessFlow.js";
// analyzeFlow.ts imports READ_ONLY_TOOLS from this module — same runtime-safe
// cycle as assessFlow above (both bindings are only dereferenced inside
// function bodies, never during module evaluation).
import { runAnalyzeFlow } from "./analyzeFlow.js";
import { isTransientFailure, requeueTicket, requeueTicketKeepBudget } from "./requeue.js";
import { classifyProviderFailure, GATE_CLASSES } from "./providerFailure.js";
import type { ProviderGate } from "./providerGate.js";
import { transcriptPathFor } from "./slug.js";
import {
  NOOP_REPORTER,
  outcomeFromPrFlow,
  outcomeFromQa,
  type TicketReporter,
} from "./reporter.js";
import { log, withTicket } from "./logging.js";
import { metrics } from "./metrics.js";

// A Q&A ticket has no worktree and shouldn't mutate the filesystem; give its
// session a read-only tool subset so a stray write/bash/edit can't corrupt the
// claimed ticket sitting in processing/ (PR-flow tickets in a worktree get the
// full set in a later milestone).
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Canonicalize a lexically-resolved repo path into a stable per-repo
 * serialization key (issue #113). `resolve()` alone is lexical: a symlink alias
 * or a case-variant spelling on a case-insensitive filesystem (APFS) yields a
 * DIFFERENT string, so two tickets targeting one repo would hash to two busy
 * keys and run concurrent worktrees — defeating the same-repo serialization
 * invariant. `realpathSync.native` resolves symlinks and normalizes the on-disk
 * case so aliased spellings collapse to one key. Falls back to the lexical path
 * when the repo doesn't exist on disk yet (realpath throws ENOENT) — a
 * not-yet-cloned repo still serializes against itself by its lexical spelling.
 */
function canonicalizeRepoKey(resolved: string): string {
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export interface RunDeps {
  // Injection seam: returns a session factory for (cfg, cwd). Defaults to the real Pi SDK.
  sessionFactoryFor?: (cfg: Config, cwd: string) => () => Promise<AgentSessionLike>;
  // Critic session factory, threaded into the PR-flow (tests control its verdict).
  criticSessionFactory?: () => Promise<AgentSessionLike>;
  // Assess-flow factory (peer of criticSessionFactory): tests inject a fake;
  // production defaults to the real runAssessFlow.
  assessFlowFn?: typeof runAssessFlow;
  // Analyze-flow factory (peer of assessFlowFn): tests inject a fake;
  // production defaults to the real runAnalyzeFlow.
  analyzeFlowFn?: typeof runAnalyzeFlow;
  /** Probe before claiming: false → leave the inbox untouched this poll. The
   * daemon wires this to endpointReachable so an endpoint outage queues work
   * instead of burning tickets into failed/. */
  readyFn?: () => Promise<boolean>;
  /** Operator force-stop signal — aborts the in-flight agent session softly
   * (commits are salvaged). The daemon wires this to StopFlag.forceSignal. */
  abortSignal?: AbortSignal;
  /** Lifecycle feedback (GitHub bridge). Defaults to a no-op. */
  reporter?: TicketReporter;
  /** Provider gate — classification-driven claim pausing. Optional: absent
   * (CLI one-shot, tests) preserves pre-gate behavior exactly. */
  gate?: Pick<ProviderGate, "reportFailure" | "reportSuccess" | "notBeforeIso">;
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
    // readyFn wraps BOTH the endpoint reachability probe and the provider
    // gate (daemon.ts) — a latched/backed-off gate blocks claiming exactly
    // like an unreachable endpoint does, so "inference endpoint not ready"
    // is misleading when only the gate is the reason. Stay readiness-neutral.
    log.warn("not ready to claim (endpoint or provider gate); leaving inbox untouched this poll", {
      eligible: eligible.length,
    });
    return null;
  }

  for (const t of eligible) {
    const repoKey =
      t.hasRepo && typeof t.frontmatter.repo === "string"
        ? canonicalizeRepoKey(resolve(expandHome(t.frontmatter.repo)))
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
    const startedAt = Date.now();
    const reporter = deps.reporter ?? NOOP_REPORTER;
    try {
      log.info("claimed", { src: next.path, dst: claimed });
      await reporter.onStart(next).catch(() => undefined);

      // Analyze ticket (frontmatter has `analyze:`): a read-only investigation
      // that parks a comment draft for an issue. Must precede the assess and
      // hasRepo branches below — analyze tickets also carry `repo:` (the
      // investigation target), which would otherwise trigger the PR flow.
      if (next.analyze) {
        const analyzeFlow = deps.analyzeFlowFn ?? runAnalyzeFlow;
        const flow = await analyzeFlow(cfg, next, claimed, {
          sessionFactoryFor: deps.sessionFactoryFor,
          abortSignal: deps.abortSignal,
          onProgress: (p) => metrics.setTaskProgress(next.id, p),
          onGuardDecision: (d) => metrics.recordGuardDecision(d.action),
        });
        if (flow.requeued) await reporter.onRequeue(next).catch(() => undefined);
        else
          // #103: analyze tickets never post. Route the terminal disposition
          // through a hard-coded no-op reporter rather than the injected
          // `reporter` — this makes the guarantee structural instead of
          // resting on the reporter's own `if (!t.github …) return` guard,
          // which a hand-authored ticket carrying BOTH `analyze:` and
          // `github:` would otherwise sail through.
          await NOOP_REPORTER.onFinal(next, outcomeFromQa(flow.status, flow.result)).catch(
            () => undefined,
          );
        log.info("finalized (analyze)", { dst: flow.dst, status: flow.status });
        return;
      }

      // Assessment ticket (frontmatter has `assess:`): audit the repo and file
      // issues per finding. Must precede the hasRepo branch below — assess
      // tickets also carry `repo:` (the audit target), which would otherwise
      // trigger the PR flow.
      if (next.assess) {
        const assessFlow = deps.assessFlowFn ?? runAssessFlow;
        const flow = await assessFlow(cfg, next, claimed, {
          sessionFactoryFor: deps.sessionFactoryFor,
          abortSignal: deps.abortSignal,
          onProgress: (p) => metrics.setTaskProgress(next.id, p),
          onGuardDecision: (d) => metrics.recordGuardDecision(d.action),
        });
        if (flow.requeued) await reporter.onRequeue(next).catch(() => undefined);
        else
          await reporter
            .onFinal(next, outcomeFromQa(flow.status, flow.result))
            .catch(() => undefined);
        log.info("finalized (assess)", { dst: flow.dst, status: flow.status });
        return;
      }

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
            onGuardDecision: (d) => metrics.recordGuardDecision(d.action),
            gate: deps.gate,
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
        onGuardDecision: (d) => metrics.recordGuardDecision(d.action),
        transcriptPath: cfg.transcriptsEnabled
          ? transcriptPathFor(cfg.stateDir, next.id)
          : undefined,
      });
      // Infrastructure failures (bad key, quota, 429, model typo) are not the
      // ticket's fault: report to the gate (pauses claiming) and requeue
      // WITHOUT consuming the retry budget. Only zero-commit runs — Q&A never
      // commits. Transient (outage/unknown) failures keep the budgeted path.
      const cls = classifyProviderFailure(result.errorMessage);
      // Parity with prFlow's `hardError` guard (excludes abortedByGuard AND
      // timedOut): a timeout landing mid-retry-backoff leaves the FIRST
      // attempt's errorMessage captured (no clean auto_retry_end ever fires —
      // the timeout aborts the run before the SDK can decide retry/recover),
      // so that stale error must not be gate-routed as if it were the run's
      // actual outcome. timedOut/abortedByGuard win: existing timeout/guard
      // semantics apply below instead.
      if (deps.gate && !result.timedOut && !result.abortedByGuard && GATE_CLASSES.has(cls)) {
        deps.gate.reportFailure(cls, result.errorMessage ?? cls);
        const rq = requeueTicketKeepBudget(
          cfg,
          claimed,
          deps.gate.notBeforeIso(),
          result.errorMessage ?? cls,
        );
        await reporter.onRequeue(next).catch(() => undefined);
        log.warn("provider-gate requeue", { dst: rq.dst, class: cls });
        return;
      }
      if (deps.gate && cls === "outage") deps.gate.reportFailure(cls, result.errorMessage ?? cls);
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
      if (deps.gate && result.errorMessage === null && !result.timedOut && !result.abortedByGuard) {
        deps.gate.reportSuccess();
      }
      const fin = finalize(claimed, result, { done: paths.done, failed: paths.failed });
      await reporter.onFinal(next, outcomeFromQa(fin.status, result)).catch(() => undefined);
      log.info("finalized", { dst: fin.dst, status: fin.status });
    } catch (e) {
      // Top-level containment: real throw paths exist (a rejecting session
      // factory — runAgent awaits it outside its try/catch; runPrFlow
      // deliberately rethrows non-GitOpError exceptions). Without this catch
      // the claimed ticket is stranded in processing/ (scheduler mode) or the
      // whole daemon dies (serial mode). A crash is infrastructure, not a
      // verdict on the ticket (same stance as orphans.ts): requeue under the
      // transient-retry budget, else finalize to failed/ with the error as
      // the reason — serial and scheduler modes behave identically.
      const reason = e instanceof Error ? e.message : String(e);
      log.error("ticket execution crashed; containing", {
        id: next.id,
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
      // Classify the thrown reason FIRST (same infrastructure-vs-ticket split
      // as the Q&A failure site above) — a rejecting session factory (bad
      // key, catalog-miss model id) throws OUTSIDE runAgent's try/catch, so
      // this is the only place that reason string ever reaches the
      // classifier. UNLIKE the Q&A site, `reason` here is ARBITRARY exception
      // text (a rejecting factory's own message, a git/gh error, even a
      // ticket filename echoed into an error) — never the SDK's structured
      // in-session errorMessage. Bare \b40[13]\b/\b429\b patterns can
      // false-positive against that text (e.g. "processing issue-403.md
      // failed"). auth/quota/rate_limit route through GATE_CLASSES into the
      // gate's LATCHED states (auth_error/quota_exhausted) — a false latch
      // here BLOCKS CLAIMING and only clears on an explicit reportSuccess(),
      // but a latch that never lets a ticket run can never produce that
      // success, freezing the queue forever. So gate-class routing at THIS
      // site is narrowed to model_not_found only — the resolution-failure
      // throw class this crash site was actually built for (a session-build
      // error junco's own resolveModelViaRegistries authors, not
      // attacker/ticket text). auth/quota/rate_limit fall through to the
      // unknown/budgeted path below. `outage` is exempt from this narrowing
      // and keeps reporting unconditionally: it's a non-latching, self-
      // expiring backoff, and its errno/5xx phrases are specific enough that
      // a false match just adds a harmless delay.
      const crashCls = classifyProviderFailure(reason);
      if (deps.gate && crashCls === "outage") deps.gate.reportFailure(crashCls, reason);
      if (deps.gate && crashCls === "model_not_found") {
        deps.gate.reportFailure(crashCls, reason);
        try {
          const rq = requeueTicketKeepBudget(cfg, claimed, deps.gate.notBeforeIso(), reason);
          await reporter.onRequeue(next).catch(() => undefined);
          log.warn("provider-gate requeue (crash containment)", { dst: rq.dst, class: crashCls });
          return;
        } catch (rqErr) {
          log.error("crash gate-requeue failed; falling back to failed/", {
            id: next.id,
            error: rqErr instanceof Error ? rqErr.message : String(rqErr),
          });
        }
      } else {
        try {
          const rq = requeueTicket(cfg, claimed, next, reason);
          if (rq.requeued) {
            await reporter.onRequeue(next).catch(() => undefined);
            return;
          }
        } catch (rqErr) {
          log.error("crash requeue failed; falling back to failed/", {
            id: next.id,
            error: rqErr instanceof Error ? rqErr.message : String(rqErr),
          });
        }
      }
      const crashResult: RunResult = {
        // renderResult only surfaces finalText, so carry the reason there too
        // (errorMessage drives the failed status + the reporter's failureReason).
        finalText: `Execution crashed: ${reason}`,
        toolCalls: [],
        usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
        stopReason: null,
        errorMessage: reason,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        abortedByGuard: false,
      };
      try {
        const fin = finalize(claimed, crashResult, { done: paths.done, failed: paths.failed });
        await reporter.onFinal(next, outcomeFromQa(fin.status, crashResult)).catch(() => undefined);
        log.info("finalized (crash containment)", { dst: fin.dst, status: fin.status });
      } catch (finErr) {
        // Both dispositions failed (e.g. the claimed file vanished). Never
        // rethrow — leave whatever remains in processing/ for the startup
        // orphan recovery rather than crash-looping the daemon.
        log.error("crash containment could not finalize; leaving for orphan recovery", {
          id: next.id,
          error: finErr instanceof Error ? finErr.message : String(finErr),
        });
      }
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
