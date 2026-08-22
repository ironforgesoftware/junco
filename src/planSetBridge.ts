/**
 * Bridge doors for plan sets (spec 2026-08-20, Layer 2): dispatch and
 * sweep-driven maintenance (supersede detection, dashboard/labels/degraded
 * comment). Trust shape: the model authored a fence, a human approved the
 * comment (temporal check in pollGithubInbox and, for supersede, trySupersede
 * below), and THIS code — never model text — builds every byte of child
 * frontmatter via the pure compiler.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config, GithubRepoMapping } from "./types.js";
// NOTE: githubInbox.ts imports dispatchPlanSet/maintainPlanSets from this
// module, so this import creates a module cycle. Runtime-safe: both bindings
// are only dereferenced inside function bodies (dispatchPlanSet /
// maintainPlanSets / pollGithubInbox), never during module evaluation — same
// pattern as runOnce.ts's assessFlow/analyzeFlow cycles.
import {
  githubTicketId,
  lifecycleLabels,
  findOwnPlanComment,
  verifyLabelApplier,
  extractPlanSetBody,
} from "./githubInbox.js";
import { parsePlanSet, compilePlan, hashPlan } from "./planCompiler.js";
import { submitTicket } from "./dispatch.js";
import { ticketState } from "./ticketDeps.js";
import { queuePaths } from "./config.js";
import {
  materializePlanSet,
  submitPlanSet,
  supersedeUnclaimed,
  listPlanSetRecords,
  writePlanSetRecord,
  resolveSetState,
  renderDashboard,
  plansDir,
  type PlanSetRecord,
  type SetState,
} from "./planSets.js";
import { log } from "./logging.js";
import { gh, GitOpError } from "./git.js";
import { tryOrEnqueue, withCommentMarker, type OutboxOp } from "./githubOutbox.js";

const GH_TIMEOUT = 60_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How long after close a plan-set record keeps being probed for plan-comment
 * edits. Past this, the sweep skips it entirely — the supersede path is for
 * live work, and an unbounded per-sweep gh call per historical set is the
 * cost #298 flagged. Generous on purpose: the probe is the only way a plan
 * edit is noticed, so this trades a rare very-late supersede for a bounded
 * steady-state cost. */
const PLAN_SET_COLD_MS = 30 * 24 * 60 * 60 * 1000;

export type DispatchResult =
  | { ok: true; submitted: string[]; skipped: string[] }
  | { ok: false; errors: string[] };

/** Injectable side effects (tests only; production callers omit this).
 * `submitFn` is typed against the real `submitTicket`, not `BridgeDeps`'s
 * looser structural signature — see githubInbox.ts's BridgeDeps.submitFn,
 * which pollGithubInbox resolves once and passes down here. */
export interface DispatchPlanSetDeps {
  submitFn?: typeof submitTicket;
}

export function dispatchPlanSet(
  cfg: Config,
  repo: GithubRepoMapping,
  issueNumber: number,
  fenceBody: string,
  nowIso: string,
  deps: DispatchPlanSetDeps = {},
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
  const r = submitPlanSet(cfg, children, { submitFn: deps.submitFn });
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
  /** createdAt stamp for a FRESH record written by a supersede recompile
   * (see trySupersede). Defaults to `new Date().toISOString()` — injectable
   * so tests can pin it instead of reaching for `Date.now()` directly. */
  nowIso?: string;
  /** Used by trySupersede's fan-out loop in place of the hard `submitTicket`
   * import. Defaults to the real `submitTicket`. */
  submitFn?: typeof submitTicket;
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

// ---------------------------------------------------------------------------
// Supersede — an edited, re-approved plan comment recompiles the set in
// place. Runs BEFORE the closed-skip in maintainPlanSets: a closed (all-
// terminal) record is exactly the case a human reopens by editing the plan
// comment and re-approving, so this check must not be gated on `!closed`.
// ---------------------------------------------------------------------------

type SupersedeOutcome =
  | { kind: "unchanged" } // no comment, no fence, hash unchanged, or approval not (yet) satisfied
  | { kind: "deferred" } // children still in flight — retry next sweep
  | { kind: "compile-failed" } // recompile failed; old record left in place
  | { kind: "superseded"; record: PlanSetRecord }; // fresh record fanned out

/** Compile-failure comment posted when a supersede recompile fails — same
 * shape as dispatchPlanSet's compile-failure comment (githubInbox.ts), worded
 * for the recompile case: nothing here is a first dispatch, so the old set
 * keeps running rather than "nothing was dispatched". */
function buildSupersedeFailureComment(errors: string[]): string {
  const errList = errors.map((e) => `- ${e}`).join("\n");
  return (
    `**Junco could not recompile this plan set** — the previous plan set is unchanged.\n\n` +
    `${errList}\n\n_Edit the plan comment and re-apply approval to retry._\n`
  );
}

/** Remove the `approved` label — shared by the success path (step 8: it
 * authorized the supersede that just happened) and the compile-failure path
 * (bounding re-entry in `requireApproval` mode: leaving it standing would
 * re-satisfy the approval gate on every subsequent sweep). */
async function removeApprovedLabel(
  cfg: Config,
  g: { nwo: string; issue: number },
  ll: ReturnType<typeof lifecycleLabels>,
  ghFn: typeof gh,
  label: string,
): Promise<void> {
  await guardOrQueue(
    cfg,
    label,
    `${g.nwo}#${g.issue}`,
    { kind: "labels", nwo: g.nwo, issue: g.issue, add: [], remove: [ll.approved] },
    async () => {
      await ghFn(
        cfg,
        ["issue", "edit", String(g.issue), "--repo", g.nwo, "--remove-label", ll.approved],
        { timeoutMs: GH_TIMEOUT, retryNetwork: true },
      );
    },
  );
}

/**
 * Drain any `pendingFanout` left by a PRIOR sweep's supersede fan-out (a
 * child whose `submitTicket` threw — see the field's doc comment on
 * `PlanSetRecord`). Runs unconditionally ahead of trySupersede's hash gate:
 * a stranded child's ticket never landed, so it has no failed/ file for
 * `junco retry` either, and the fresh record already carries the NEW hash —
 * without this, the gate reads "no edit, nothing to do" forever.
 *
 * The record stores only `{id, ticketId, dependsOn}` — never the compiled
 * body — so recovery means re-reading the materialized plan markdown
 * (`materializePlanSet` writes `plansDir(cfg)/<planId>.md`) and re-running
 * `parsePlanSet` + `compilePlan` with the record's OWN compile context
 * (`hash`/`repoPath`/`github`) — the same context that produced these
 * children originally, not whatever candidate is on GitHub right now.
 *
 * Guarded belt-and-braces against TRAP 1 (skipped ≠ stranded): only ids
 * still `absent` are (re)submitted through the injected `submitFn` seam; an
 * id no longer `absent` (landed some other way since) is just dropped, never
 * resubmitted. A child whose submit throws again stays listed for the next
 * sweep. If the materialized plan can't be read, or no longer compiles,
 * nothing can recover the bodies — warn and clear the list; retrying forever
 * is worse than a logged give-up.
 */
async function drainPendingFanout(
  cfg: Config,
  record: PlanSetRecord,
  g: { nwo: string; issue: number },
  submitFn: typeof submitTicket,
): Promise<void> {
  const pending = record.pendingFanout;
  if (!pending || pending.length === 0) return;

  let planText: string;
  try {
    planText = readFileSync(join(plansDir(cfg), `${record.planId}.md`), "utf8");
  } catch (e) {
    log.warn(
      "plan-set supersede: materialized plan unreadable; giving up on stranded fan-out children",
      { planId: record.planId, ids: pending, error: errMsg(e) },
    );
    record.pendingFanout = [];
    writePlanSetRecord(cfg, record);
    return;
  }
  const parsed = parsePlanSet(planText, { maxTasks: cfg.planSets.maxTasks });
  if (!parsed.ok) {
    log.warn(
      "plan-set supersede: materialized plan no longer compiles; giving up on stranded fan-out children",
      { planId: record.planId, ids: pending, errors: parsed.errors },
    );
    record.pendingFanout = [];
    writePlanSetRecord(cfg, record);
    return;
  }
  const children = compilePlan(parsed.plan, {
    planId: record.planId,
    repoPath: record.repoPath,
    hash: record.hash,
    github: g,
  });

  const paths = queuePaths(cfg);
  const stillPending: string[] = [];
  for (const id of pending) {
    const child = children.find((c) => c.ticketId === id);
    // No longer in the compiled plan, or no longer absent (landed some other
    // way since) — TRAP 1 guard: drop it, never resubmit.
    if (!child || ticketState(paths, id) !== "absent") continue;
    try {
      submitFn(cfg, child.content, { idHint: id });
    } catch (e) {
      log.warn("plan-set supersede: retry of a stranded child's submit failed again", {
        planId: record.planId,
        ticketId: id,
        error: errMsg(e),
      });
      stillPending.push(id);
    }
  }
  record.pendingFanout = stillPending;
  writePlanSetRecord(cfg, record);
}

/**
 * Detect and apply an edited-and-re-approved plan comment for one record
 * (numbered steps below match the design's supersede behavior 1-8):
 *
 * 1. Fetch the bridge's own plan comment. No comment → unchanged.
 * 2. Extract the fence; skip when absent, its hash matches the current
 *    record (no edit), or its hash matches `lastFailedHash` (a compile error
 *    the human hasn't fixed yet — re-attempting it every sweep would re-post
 *    the same failure comment forever; see step 6).
 * 3. `requireApproval` gates the edit behind the SAME temporal check as
 *    dispatch: the `approved` label, applied by a verified writer, strictly
 *    after the comment's last edit. `requireApproval` false: the edit alone
 *    (hash difference) is authorization enough.
 * 4. Quiescence: any child still processing defers the whole sweep for this
 *    record — disposing an unclaimed sibling while another is mid-run would
 *    leave a partially-superseded set with no clean rollback.
 * 5. Dispose every unclaimed (inbox) child (`supersedeUnclaimed`) — frees
 *    their ticketIds, since the SAME planId means an edited-but-same-id task
 *    recompiles to the identical ticketId.
 * 6. Recompile from the fence with the SAME planId. A compile error leaves
 *    the old record in place (already-disposed children stay disposed; the
 *    human edits again) and posts a failure comment — never a partial write —
 *    but is BOUNDED: `lastFailedHash` is stamped so this exact candidate
 *    never re-triggers, and (in `requireApproval` mode) the `approved` label
 *    is removed so re-triggering also requires a fresh approval event, not
 *    just an untouched stale one.
 * 7. Fan out FIRST, THEN materialize a FRESH record (crash-idempotent order —
 *    see the inline comment at the fan-out loop for why the reverse order is
 *    unsafe). Per child: `done` → skip (task id is task identity across plan
 *    versions); `inbox`/`processing` → already landed (a crashed pass of
 *    this same supersede, or — pre-disposal/quiescence — shouldn't happen),
 *    skip; `absent` OR `failed` (our own just-disposed superseded marker, OR
 *    an unrelated PRIOR execution failure) → submit the fresh copy
 *    unconditionally — the ticketState resolver's inbox > failed precedence
 *    means any dependent waits on the fresh copy, never the stale failed
 *    one; a per-child submit failure is caught and logged, never aborting
 *    the rest of the fan-out or the record materialization that follows.
 * 8. Remove the `approved` label — it authorized THIS supersede; leaving it
 *    would immediately re-trigger on the next sweep.
 */
async function trySupersede(
  cfg: Config,
  record: PlanSetRecord,
  g: { nwo: string; issue: number },
  ghFn: typeof gh,
  ll: ReturnType<typeof lifecycleLabels>,
  getLogin: () => Promise<string>,
  nowIso: string,
  submitFn: typeof submitTicket,
): Promise<SupersedeOutcome> {
  let comment: { body: string; createdAtMs: number; updatedAtMs: number } | null;
  try {
    const login = await getLogin();
    comment = await findOwnPlanComment(cfg, g.nwo, g.issue, login, ghFn);
  } catch (e) {
    log.warn("plan-set supersede: could not read the plan comment; skipping this sweep", {
      planId: record.planId,
      error: errMsg(e),
    });
    return { kind: "unchanged" };
  }
  if (comment === null) return { kind: "unchanged" }; // 1. no own-authored comment

  const candidate = extractPlanSetBody(comment.body);
  if (candidate === null) return { kind: "unchanged" }; // 2. no complete fence
  const newHash = hashPlan(candidate);

  // A previous fan-out left children un-submitted (their submit threw). The
  // hash gate below would return "unchanged" and strand them forever, so
  // drain them first. The record stores ids only, so re-read the materialized
  // plan and re-compile to recover their bodies. Orthogonal to the supersede
  // decision below: this runs whether or not the candidate turns out to be
  // an edit at all.
  await drainPendingFanout(cfg, record, g, submitFn);

  if (newHash === record.hash) return { kind: "unchanged" }; // 2. no edit
  if (newHash === record.lastFailedHash) return { kind: "unchanged" }; // 2. already-failed edit, unfixed

  if (cfg.github.requireApproval) {
    // 3. Approval rule — labels fetched lazily, only once an edit is on the
    // table (every other sweep skips this gh call entirely).
    let labels: Set<string>;
    try {
      const r = await ghFn(
        cfg,
        ["issue", "view", String(g.issue), "--repo", g.nwo, "--json", "labels"],
        { timeoutMs: GH_TIMEOUT, retryNetwork: true },
      );
      const parsed = JSON.parse(r.stdout) as { labels?: { name: string }[] };
      labels = new Set((parsed.labels ?? []).map((l) => l.name));
    } catch (e) {
      log.warn("plan-set supersede: could not read issue labels; skipping this sweep", {
        planId: record.planId,
        error: errMsg(e),
      });
      return { kind: "unchanged" };
    }
    if (!labels.has(ll.approved)) return { kind: "unchanged" }; // awaiting review
    const approval = await verifyLabelApplier(cfg, g.nwo, g.issue, ll.approved, ghFn);
    if (approval.verdict !== "ok") {
      log.warn("plan-set supersede: approval not by a verified writer; ignoring", {
        planId: record.planId,
      });
      return { kind: "unchanged" };
    }
    // Fail closed on an unparseable timestamp on either side: an edit after
    // the approval must invalidate it — the fence that recompiles is read
    // fresh above, so a stale approval must not authorize a NEWER edit.
    if (
      !(Number.isFinite(comment.updatedAtMs) && approval.atMs !== null) ||
      approval.atMs <= comment.updatedAtMs
    ) {
      log.warn("plan-set supersede: approval predates the plan comment's latest edit; ignoring", {
        planId: record.planId,
      });
      return { kind: "unchanged" };
    }
  }

  // 4. Quiescence.
  const state = resolveSetState(cfg, record);
  if (state.anyProcessing) {
    log.info("plan set supersede deferred — children in flight", { planId: record.planId });
    return { kind: "deferred" };
  }

  // 5. Dispose unclaimed children BEFORE recompiling — a compile failure must
  // still leave them disposed (recoverable via a further edit), never re-run.
  supersedeUnclaimed(cfg, record, newHash);

  // 6. Recompile with the SAME planId.
  const parsed = parsePlanSet(candidate, { maxTasks: cfg.planSets.maxTasks });
  if (!parsed.ok) {
    const failureBody = buildSupersedeFailureComment(parsed.errors);
    const failId = `${g.nwo}#${g.issue}`;
    await guardOrQueue(
      cfg,
      "supersede compile-failure comment",
      failId,
      { kind: "comment", nwo: g.nwo, issue: g.issue, body: failureBody },
      () => postSetComment(cfg, g.nwo, g.issue, failureBody, ghFn),
    );
    // Bound re-entry: without removing `approved` (in requireApproval mode)
    // and stamping lastFailedHash (in BOTH modes), this exact candidate would
    // re-trigger — and re-post this same comment — on every future sweep
    // until the human happens to edit again.
    if (cfg.github.requireApproval) {
      await removeApprovedLabel(cfg, g, ll, ghFn, "supersede compile-failure label cleanup");
    }
    record.lastFailedHash = newHash;
    writePlanSetRecord(cfg, record);
    return { kind: "compile-failed" };
  }
  const children = compilePlan(parsed.plan, {
    planId: record.planId,
    repoPath: record.repoPath,
    hash: newHash,
    github: g,
  });

  // 7. Fan out FIRST, materialize the FRESH record LAST (#293-critical-4:
  // crash idempotence). The reverse order — materialize then fan out — was
  // NOT crash-safe: a crash between them left a fresh record (new hash) on
  // disk while the old disposed children still read "failed", so the next
  // sweep's hash check at step 2 would see "unchanged" (record.hash already
  // equals the candidate's hash) and never resume the fan-out — a spurious
  // degraded/failed close, with the new plan never actually submitted. With
  // the fan-out running first, a crash mid-loop leaves the OLD record on
  // disk, so the next sweep re-triggers this exact supersede from step 2
  // onward: `supersedeUnclaimed`'s disposal of already-disposed children is a
  // no-op (findTicketFile only looks in inbox/, where they no longer are),
  // and the per-child rule below already treats "inbox"/"processing" as
  // "already landed" and skips it — which is exactly the right call on a
  // crash-reentry pass, not just the pre-existing (single-pass) defensive
  // case it was written for.
  //
  // Per-child fan-out rule (spec: "task id is task identity across plan
  // versions" — only a DONE ticket skips on recompile):
  //   done                → skip (its work already happened)
  //   inbox / processing  → already landed — an earlier, crashed pass of
  //                         THIS SAME supersede resubmitted it (or, on a
  //                         first pass, this shouldn't occur at all, since
  //                         unclaimed siblings were just disposed above and
  //                         quiescence already refused to proceed while
  //                         anything was processing) — skip either way,
  //                         never double-submit.
  //   absent / failed     → submit the fresh copy unconditionally. `failed`
  //                         covers BOTH our own just-disposed superseded
  //                         marker AND an unrelated prior execution failure
  //                         (#293-critical-2: silently skipping the latter
  //                         stranded its dependents, since a stale failed/
  //                         ticket is not "absent"). The old failed/ copy is
  //                         left as audit; ticketState's inbox > failed
  //                         precedence means any dependent's edge resolves
  //                         against the FRESH copy, never the stale one.
  //   submit throws       → (e.g. an inbox-slug collision) contained per
  //                         child so one bad submit never aborts the rest of
  //                         the fan-out or the record materialization below —
  //                         logged and left "absent"; a future sweep's
  //                         supersede (if the plan is edited again) or a
  //                         manual retry is what recovers it.
  const paths = queuePaths(cfg);
  const submitted: string[] = [];
  const skipped: string[] = [];
  // Ids whose submit THREW (as opposed to being legitimately skipped as
  // already-landed) — TRAP 1: `skipped` conflates three causes (already
  // done, already in inbox/processing, submit threw), but ONLY the throw
  // case is stranded and belongs on `pendingFanout` below. Fed exclusively
  // by the catch branch.
  const stranded: string[] = [];
  for (const c of children) {
    const st = ticketState(paths, c.ticketId);
    if (st === "done") {
      skipped.push(c.ticketId);
      continue;
    }
    if (st === "inbox" || st === "processing") {
      log.warn("plan-set supersede: child already landed at fan-out; skipping", {
        planId: record.planId,
        ticketId: c.ticketId,
        state: st,
      });
      skipped.push(c.ticketId);
      continue;
    }
    try {
      submitFn(cfg, c.content, { idHint: c.ticketId });
      submitted.push(c.ticketId);
    } catch (e) {
      log.warn("plan-set supersede: child submit failed at fan-out; skipping", {
        planId: record.planId,
        ticketId: c.ticketId,
        error: errMsg(e),
      });
      skipped.push(c.ticketId);
      stranded.push(c.ticketId);
    }
  }
  log.info("plan set supersede fan-out", { planId: record.planId, submitted, skipped, stranded });

  // New hash, same planId, keep statusCommentId and lastLabel (the
  // dashboard/label steps below re-derive lastLabel from fresh queue
  // reality), reset degradedPosted/closed/lastFailedHash, and drop
  // lastDashboard so the next render is treated as a change (the dashboard
  // repaints). Materialized only now that fan-out has run — see the ordering
  // note above.
  const fresh: PlanSetRecord = {
    v: 1,
    planId: record.planId,
    hash: newHash,
    repoPath: record.repoPath,
    github: g,
    tasks: children.map((c) => ({ id: c.taskId, ticketId: c.ticketId, dependsOn: c.dependsOn })),
    createdAt: nowIso,
    statusCommentId: record.statusCommentId,
    degradedPosted: false,
    lastLabel: record.lastLabel,
    closed: false,
    pendingFanout: stranded.length > 0 ? stranded : undefined,
  };
  materializePlanSet(cfg, fresh, candidate);

  // 8. Remove the approved label — it authorized this supersede.
  await removeApprovedLabel(cfg, g, ll, ghFn, "approved label removal (supersede)");

  log.info("plan set superseded", { planId: record.planId, oldHash: record.hash, hash: newHash });
  return { kind: "superseded", record: fresh };
}

/**
 * One maintenance pass over every open plan-set record: supersede detection,
 * dashboard comment, degraded comment, set-level label, close-on-all-
 * terminal. Called once per pollGithubInbox sweep, after the repo/issue loop.
 * Records with `github === null` (never dispatched to GitHub) are always
 * skipped; `closed === true` records are skipped UNLESS supersede reopens
 * them this sweep (an edited, re-approved plan comment on a finished set) —
 * see trySupersede.
 */
export async function maintainPlanSets(
  cfg: Config,
  deps: MaintainPlanSetsDeps = {},
): Promise<void> {
  const ghFn = deps.ghFn ?? gh;
  const submitFn = deps.submitFn ?? submitTicket;
  const ll = lifecycleLabels(cfg.github.triggerLabel);
  const nowIso = deps.nowIso ?? new Date().toISOString();
  // Memoized across the whole sweep — every candidate record needs the same
  // viewer login (findOwnPlanComment's own-authored filter), and this
  // function has no BridgeState to cache it on the way viewerLogin does.
  let cachedLogin: string | null = null;
  const getLogin = async (): Promise<string> => {
    if (cachedLogin === null) {
      const r = await ghFn(cfg, ["api", "user", "--jq", ".login"], {
        timeoutMs: GH_TIMEOUT,
        retryNetwork: true,
      });
      cachedLogin = r.stdout.trim();
    }
    return cachedLogin;
  };

  for (const storedRecord of listPlanSetRecords(cfg)) {
    const g = storedRecord.github;
    if (g === null) continue;

    // Cold: closed long enough ago that we stop paying a gh probe for it every
    // sweep. `closedAt` absent (older record) counts as warm — never skip on
    // missing data.
    if (storedRecord.closed && storedRecord.closedAt) {
      const age = Date.parse(nowIso) - Date.parse(storedRecord.closedAt);
      if (Number.isFinite(age) && age > PLAN_SET_COLD_MS) continue;
    }

    const outcome = await trySupersede(cfg, storedRecord, g, ghFn, ll, getLogin, nowIso, submitFn);
    // `deferred` (a child is mid-flight) and `compile-failed` (the edit does
    // not compile) skip only the SUPERSEDE — not this record's maintenance.
    // Skipping the whole pass froze the dashboard for the entire duration of
    // a long-running child and suppressed the degraded comment for failures
    // that appeared in that window (#298). The record selection below already
    // falls back to storedRecord for both outcomes.
    const record = outcome.kind === "superseded" ? outcome.record : storedRecord;

    if (record.closed) {
      // A record closed before the cold-window upgrade (or by a build that
      // predates `closedAt` entirely) never acquired the stamp — the
      // warm-on-absent rule above (`storedRecord.closed && storedRecord.closedAt`)
      // means such a record is warm FOREVER, so it keeps paying the paginated
      // `gh api …/comments` probe every sweep, indefinitely: exactly the cost
      // the cold window exists to bound (#298). Stamp it here — the one place
      // that still runs for an already-closed record — so it goes cold after
      // one more window, same as a record closed after the upgrade. No
      // supersede is lost: trySupersede (above) already had its chance this
      // sweep before this branch is reached.
      if (!record.closedAt) {
        record.closedAt = nowIso;
        writePlanSetRecord(cfg, record);
      }
      continue;
    }
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

    // 5. Close: maintenance stops here; a supersede (see trySupersede, above)
    // reopens with a fresh record on a later sweep.
    if (state.allTerminal && !record.closed) {
      record.closed = true;
      record.closedAt = nowIso;
      changed = true;
    }

    // 6. Persist once per iteration.
    if (changed) writePlanSetRecord(cfg, record);
  }
}
