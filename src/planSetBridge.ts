/**
 * Bridge doors for plan sets (spec 2026-08-20, Layer 2): dispatch (this task)
 * and sweep-driven maintenance (dashboard/labels/supersede — later tasks).
 * Trust shape: the model authored a fence, a human approved the comment
 * (temporal check in pollGithubInbox), and THIS code — never model text —
 * builds every byte of child frontmatter via the pure compiler.
 */
import type { Config, GithubRepoMapping } from "./types.js";
// NOTE: githubInbox.ts imports dispatchPlanSet from this module, so this
// import creates a module cycle. Runtime-safe: both bindings are only
// dereferenced inside function bodies (dispatchPlanSet / pollGithubInbox),
// never during module evaluation — same pattern as runOnce.ts's assessFlow/
// analyzeFlow cycles.
import { githubTicketId } from "./githubInbox.js";
import { parsePlanSet, compilePlan, hashPlan } from "./planCompiler.js";
import { materializePlanSet, submitPlanSet, type PlanSetRecord } from "./planSets.js";
import { log } from "./logging.js";

export type DispatchResult =
  | { ok: true; submitted: string[]; skipped: string[] }
  | { ok: false; errors: string[] };

export function dispatchPlanSet(
  cfg: Config,
  repo: GithubRepoMapping,
  issueNumber: number,
  fenceBody: string,
  nowIso: string,
): DispatchResult {
  const parsed = parsePlanSet(fenceBody, { maxTasks: cfg.planSets.maxTasks });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const planId = githubTicketId(repo.nwo, issueNumber);
  const hash = hashPlan(fenceBody);
  const children = compilePlan(parsed.plan, {
    planId,
    repoPath: repo.path,
    hash,
    github: { nwo: repo.nwo, issue: issueNumber },
  });
  const record: PlanSetRecord = {
    v: 1,
    planId,
    hash,
    repoPath: repo.path,
    github: { nwo: repo.nwo, issue: issueNumber },
    tasks: children.map((c) => ({ id: c.taskId, ticketId: c.ticketId, dependsOn: c.dependsOn })),
    createdAt: nowIso,
    statusCommentId: null,
    degradedPosted: false,
    lastLabel: null,
    closed: false,
  };
  // Materialize BEFORE fan-out: the record is what maintenance and crash
  // recovery key on; a record without children self-heals (next dispatch
  // resubmits), children without a record would be an untracked set.
  materializePlanSet(cfg, record, fenceBody);
  const r = submitPlanSet(cfg, children);
  log.info("plan set dispatched", {
    planId,
    submitted: r.submitted.length,
    skipped: r.skipped.length,
  });
  return { ok: true, ...r };
}
