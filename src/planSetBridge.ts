/**
 * Bridge doors for plan sets (spec 2026-08-20, Layer 2): dispatch and
 * sweep-driven maintenance (dashboard/labels/degraded comment — supersede
 * lands in a later task). Trust shape: the model authored a fence, a human
 * approved the comment (temporal check in pollGithubInbox), and THIS code —
 * never model text — builds every byte of child frontmatter via the pure
 * compiler.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config, GithubRepoMapping } from "./types.js";
// NOTE: githubInbox.ts imports dispatchPlanSet/maintainPlanSets from this
// module, so this import creates a module cycle. Runtime-safe: both bindings
// are only dereferenced inside function bodies (dispatchPlanSet /
// maintainPlanSets / pollGithubInbox), never during module evaluation — same
// pattern as runOnce.ts's assessFlow/analyzeFlow cycles.
import { githubTicketId, lifecycleLabels } from "./githubInbox.js";
import { parsePlanSet, compilePlan, hashPlan } from "./planCompiler.js";
import {
  materializePlanSet,
  submitPlanSet,
  listPlanSetRecords,
  writePlanSetRecord,
  resolveSetState,
  renderDashboard,
  type PlanSetRecord,
  type SetState,
} from "./planSets.js";
import { log } from "./logging.js";
import { gh, GitOpError } from "./git.js";
import { tryOrEnqueue, withCommentMarker, type OutboxOp } from "./githubOutbox.js";

const GH_TIMEOUT = 60_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

// ---------------------------------------------------------------------------
// maintainPlanSets — sweep-driven maintenance: dashboard comment, set-level
// label, degraded comment. Called once per pollGithubInbox sweep (bridge
// cadence). Every record is recomputed from queue reality each call
// (resolveSetState) — cascaded children never pass through the reporter, so
// this sweep is the only place set-level GitHub state gets refreshed.
// ---------------------------------------------------------------------------

export interface MaintainPlanSetsDeps {
  ghFn?: typeof gh;
  /** Unused today — reserved for the supersede door (a later task) to stamp
   * a fresh record's createdAt without reaching for `Date.now()` directly. */
  nowIso?: string;
}

/** Outbox-aware guard: on a network-shaped failure, `fn`'s side effect is
 * parked in the durable outbox (`op`) instead of being lost; any other
 * failure keeps the old best-effort contract — warn and swallow, since the
 * next sweep re-derives and retries state from GitHub reality. Local copy of
 * githubReport.ts's/githubInbox.ts's guardOrQueue idiom (never import their
 * internals — this module has no standing context to hang it off of). */
async function guardOrQueue(
  cfg: Config,
  label: string,
  id: string,
  op: OutboxOp,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await tryOrEnqueue(cfg, "bridge", op, fn);
  } catch (e) {
    log.warn(`plan-set maintenance: ${label} failed (issue state on GitHub may be stale)`, {
      id,
      error: errMsg(e),
    });
  }
}

/** Post a single issue comment via `gh issue comment --body-file`, embedding
 * the outbox idempotency marker so a lost-ack replay is deduped on the next
 * flush (#132) — same tempfile + withCommentMarker shape as
 * githubInbox.ts's postIssueComment / githubReport.ts's postComment, kept as
 * its own small local copy per the no-cross-import convention above. */
async function postSetComment(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  body: string,
  ghFn: typeof gh,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "junco-ghc-"));
  const file = join(dir, "comment.md");
  writeFileSync(file, withCommentMarker(nwo, issueNumber, body), "utf8");
  try {
    await ghFn(cfg, ["issue", "comment", String(issueNumber), "--repo", nwo, "--body-file", file], {
      timeoutMs: GH_TIMEOUT,
      retryNetwork: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Create-or-edit the dashboard status comment (the `PLAN_STATUS_MARKER`
 * comment). Best-effort by design: every failure is caught and warned here,
 * never thrown, so a dashboard hiccup can't break label/degraded-comment
 * maintenance for the same record or the sweep for other records — the next
 * sweep repaints. Returns whether `body` is now the comment's live content:
 * `false` on any failure, so the caller does NOT advance
 * `record.lastDashboard` (a failed sync must not read as synced, or the next
 * sweep would wrongly skip retrying it).
 *
 * `gh()` throws (GitOpError) on a nonzero exit rather than returning a
 * nonzero code — verified against src/git.ts's runCmd, which rejects with
 * `new GitOpError(\`${bin} ${args[0]} failed (exit ${code})\`, stderr,
 * code)`. The message never contains the HTTP status (gh writes that to
 * stderr, e.g. "HTTP 404: Not Found (...)"), so PATCH-404 detection must
 * check `e.stderr`, not `e.message`.
 */
async function upsertDashboard(
  cfg: Config,
  record: PlanSetRecord,
  body: string,
  ghFn: typeof gh,
): Promise<boolean> {
  const g = record.github as { nwo: string; issue: number };
  const dir = mkdtempSync(join(tmpdir(), "junco-dash-"));
  const file = join(dir, "body.md");
  writeFileSync(file, body, "utf8");
  try {
    if (record.statusCommentId === null) {
      try {
        const r = await ghFn(
          cfg,
          [
            "api",
            `repos/${g.nwo}/issues/${g.issue}/comments`,
            "-F",
            `body=@${file}`,
            "--jq",
            ".id",
          ],
          { timeoutMs: GH_TIMEOUT },
        );
        const id = parseInt(r.stdout.trim(), 10);
        if (!Number.isFinite(id)) {
          log.warn("plan-set dashboard: create returned no usable id; will retry next sweep", {
            planId: record.planId,
          });
          return false;
        }
        record.statusCommentId = id;
        return true;
      } catch (e) {
        log.warn("plan-set dashboard: create failed; will retry next sweep", {
          planId: record.planId,
          error: errMsg(e),
        });
        return false;
      }
    }
    try {
      await ghFn(
        cfg,
        [
          "api",
          `repos/${g.nwo}/issues/comments/${record.statusCommentId}`,
          "-X",
          "PATCH",
          "-F",
          `body=@${file}`,
        ],
        { timeoutMs: GH_TIMEOUT },
      );
      return true;
    } catch (e) {
      if (e instanceof GitOpError && /404/.test(e.stderr)) {
        record.statusCommentId = null; // comment deleted — recreate next sweep
      } else {
        log.warn("plan-set dashboard: update failed; will retry next sweep", {
          planId: record.planId,
          error: errMsg(e),
        });
      }
      return false;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Degraded-comment body: names the failed task(s) and any dependents still
 * parked (state "waiting") because their declared dependency chain includes
 * a failed task. */
function buildDegradedComment(record: PlanSetRecord, state: SetState): string {
  const failed = state.tasks.filter((t) => t.state === "failed");
  const failedTicketIds = new Set(failed.map((t) => t.ticketId));
  const parked = state.tasks.filter((t) => {
    if (t.state !== "waiting") return false;
    const deps = record.tasks.find((r) => r.id === t.id)?.dependsOn ?? [];
    return deps.some((d) => failedTicketIds.has(d));
  });
  const lines = [
    `**Plan set degraded** — plan \`${record.planId}\``,
    "",
    `Failed: ${failed.map((t) => `\`${t.id}\``).join(", ") || "(none)"}`,
  ];
  if (parked.length > 0) {
    lines.push(`Parked (blocked by the failure): ${parked.map((t) => `\`${t.id}\``).join(", ")}`);
  }
  lines.push("", "_See the dashboard comment above for full status._");
  return lines.join("\n") + "\n";
}

/** Desired set-level lifecycle label from the current set state (priority
 * order: allDone > allTerminal&&anyFailed > anyProcessing > else queued). */
function desiredSetLabel(state: SetState, ll: ReturnType<typeof lifecycleLabels>): string {
  if (state.allDone) return ll.done;
  if (state.allTerminal && state.anyFailed) return ll.failed;
  if (state.anyProcessing) return ll.working;
  return ll.queued;
}

/**
 * One maintenance pass over every open plan-set record: dashboard comment,
 * degraded comment, set-level label, close-on-all-terminal. Called once per
 * pollGithubInbox sweep, after the repo/issue loop. Records with
 * `github === null` (never dispatched to GitHub) or `closed === true`
 * (all-terminal already handled) are skipped — supersede (reopening a closed
 * record) lands in a later task.
 */
export async function maintainPlanSets(
  cfg: Config,
  deps: MaintainPlanSetsDeps = {},
): Promise<void> {
  const ghFn = deps.ghFn ?? gh;
  const ll = lifecycleLabels(cfg.github.triggerLabel);

  for (const record of listPlanSetRecords(cfg)) {
    const g = record.github;
    if (g === null || record.closed) continue;
    let changed = false;

    const state = resolveSetState(cfg, record);
    const desiredLabel = desiredSetLabel(state, ll);

    // 2. Dashboard: skip the gh call entirely when nothing would change.
    const body = renderDashboard(record, state);
    if (body !== record.lastDashboard) {
      const synced = await upsertDashboard(cfg, record, body, ghFn);
      if (synced) record.lastDashboard = body;
      changed = true; // statusCommentId may have changed (created or nulled) either way
    }

    // 3. Degraded: one durable comment, once, the first sweep a failure shows up.
    if (state.anyFailed && !record.degradedPosted) {
      const failId = `${g.nwo}#${g.issue}`;
      const degradedBody = buildDegradedComment(record, state);
      await guardOrQueue(
        cfg,
        "degraded comment",
        failId,
        { kind: "comment", nwo: g.nwo, issue: g.issue, body: degradedBody },
        () => postSetComment(cfg, g.nwo, g.issue, degradedBody, ghFn),
      );
      record.degradedPosted = true;
      changed = true;
    }

    // 4. Labels: swap only when the desired label actually differs.
    if (desiredLabel !== record.lastLabel) {
      const removeLabel = record.lastLabel ?? ll.queued;
      const labelId = `${g.nwo}#${g.issue}`;
      await guardOrQueue(
        cfg,
        "label swap",
        labelId,
        { kind: "labels", nwo: g.nwo, issue: g.issue, add: [desiredLabel], remove: [removeLabel] },
        async () => {
          await ghFn(
            cfg,
            [
              "issue",
              "edit",
              String(g.issue),
              "--repo",
              g.nwo,
              "--add-label",
              desiredLabel,
              "--remove-label",
              removeLabel,
            ],
            { timeoutMs: GH_TIMEOUT, retryNetwork: true },
          );
        },
      );
      record.lastLabel = desiredLabel;
      changed = true;
    }

    // 5. Close: maintenance stops here; a later supersede reopens with a fresh record.
    if (state.allTerminal && !record.closed) {
      record.closed = true;
      changed = true;
    }

    // 6. Persist once per iteration.
    if (changed) writePlanSetRecord(cfg, record);
  }
}
