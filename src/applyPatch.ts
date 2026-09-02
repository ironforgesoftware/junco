/**
 * Apply-ticket executor (spec 2026-08-31-apply-tickets-design.md). Substitutes
 * prFlow's Phase 4: instead of an agent session, apply the ticket's
 * `git format-patch` series with `git am --3way`, which applies AND commits —
 * preserving the series' own commit messages and order.
 *
 * Returns a discriminated outcome rather than an errorMessage-bearing
 * RunResult ON PURPOSE: isTransientFailure (requeue.ts) treats any
 * errorMessage + zero commits as transient and would requeue a deterministic
 * patch conflict until the retry budget burned. The caller (prFlow.ts Phase 4)
 * terminates the ticket directly on a `{ok:false}` outcome instead of routing
 * it through Phase 5's transient classifier — UNLESS `worker.applyFallbackToAgent`
 * is on (default), in which case Phase 4 escalates to the agent using
 * `buildApplyFallbackPrompt` (below) instead of terminating (Stage 2a of the
 * escalation ladder).
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Result, RunResult, Ticket, Usage } from "./types.js";
import { git } from "./git.js";
import {
  stripPatchFence,
  unsafePatchPaths,
  hasBinaryHunk,
  type PatchSeries,
} from "./patchTicket.js";
import {
  guardOptionsFromConfig,
  openRunTranscriptSink,
  writeTranscriptRecord,
  writeRunEnd,
  endSink,
  type RunTranscriptDeps,
} from "./agent/runEnvelope.js";
import type { RunStartRecord } from "./agent/transcriptSchema.js";

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 };
const AM_TIMEOUT_MS = 120_000;

/** `refused: true` — the series never reached `git am` (containmentRefusal
 * below); prFlow terminates the ticket regardless of
 * `worker.applyFallbackToAgent`. `refused: false` — `git am` ran and failed,
 * the escalation ladder's case. */
export type ApplyOutcome = Result<RunResult, { refused: boolean }>;

export interface ApplyDeps extends RunTranscriptDeps {
  gitFn?: typeof git;
  nowFn?: () => number;
}

/** Patch-series summary shared by the finalText, the PR body, and (Stage 4a)
 * the transcript's junco_run_start body — one wording, three consumers. */
function patchSummary(series: PatchSeries): string {
  return `${series.count} patch(es) touching ${series.files.length} file(s): ${series.files.join(", ")}.`;
}

/** #338: why a series must not be handed to `git am`, or null when it may.
 * The same checks plan-lint's `patch_paths_sane` rule runs (planLint.ts
 * checkPatchSeries), but that rule only fires while `planLint.enabled` and
 * `planLint.blockOnError` are BOTH on — live-editable levers an operator may
 * plausibly turn off for the style rules. Lint keeps its early, friendlier
 * error; this is the runtime backstop for a ticket that reaches claim with
 * lint disabled or non-blocking — the same role prFlow's `patch_no_amend`
 * and malformed-fence backstops play for the structural apply-mode guards. */
function containmentRefusal(series: PatchSeries): string | null {
  const problems: string[] = [];
  const unsafe = unsafePatchPaths(series.files);
  if (unsafe.length > 0) {
    problems.push(`patch touches paths outside the repo: ${JSON.stringify(unsafe)}`);
  }
  if (hasBinaryHunk(series.raw)) {
    problems.push("patch contains a binary hunk — bytes no reviewer can read in the issue");
  }
  return problems.length === 0 ? null : `refused before git am: ${problems.join("; ")}`;
}

export async function applyPatchSeries(
  cfg: Config,
  wtPath: string,
  ticketId: string,
  series: PatchSeries,
  deps: ApplyDeps = {},
): Promise<ApplyOutcome> {
  // Before ANY side effect — no temp file, no transcript frames, no git call
  // — so a refused series leaves the worktree exactly as it found it. The
  // ticket's failure note (prFlow's phaseError) carries the reason.
  const refusal = containmentRefusal(series);
  if (refusal !== null) return { ok: false, refused: true, error: refusal };
  const gitFn = deps.gitFn ?? git;
  const now = deps.nowFn ?? ((): number => Date.now());
  const startedAt = now();
  const dir = mkdtempSync(join(tmpdir(), "junco-am-"));
  const file = join(dir, "series.patch");
  writeFileSync(file, series.raw.endsWith("\n") ? series.raw : series.raw + "\n", "utf8");
  // Stage 4a observability (apply-tickets-design.md): junco_meta (first write,
  // via openRunTranscriptSink) + junco_run_start BEFORE the `git am` attempt,
  // so the record brackets the attempt honestly regardless of outcome — a
  // failed apply is exactly the case an operator most wants to inspect. No
  // turn/tool frames — nothing but `git am` ran. When a later escalation
  // (Stage 2a apply-failure, or Stage 2b's verification-failure fallback
  // after a successful apply) runs the agent, its OWN runEnveloped call opens
  // this SAME path and appends — one chronological record, no duplicate
  // junco_meta (openRunTranscriptSink's create-vs-append decision is shared,
  // not reimplemented).
  const sink = openRunTranscriptSink(cfg, ticketId, deps);
  writeTranscriptRecord(
    sink,
    JSON.stringify({
      type: "junco_run_start",
      flow: "apply",
      body: `Applying ${patchSummary(series)}`,
      cwd: wtPath,
      modelId: cfg.model.id,
      tools: cfg.tools,
      timeoutMs: AM_TIMEOUT_MS,
      guard: { enabled: false, ...guardOptionsFromConfig(cfg) },
      ts: new Date().toISOString(),
    } satisfies RunStartRecord) + "\n",
  );
  try {
    const r = await gitFn(cfg, ["am", "--3way", file], {
      cwd: wtPath,
      timeoutMs: AM_TIMEOUT_MS,
      check: false,
    });
    if (r.code !== 0) {
      // Leave the worktree in a clean, inspectable state — an interrupted am
      // would otherwise strand .git/rebase-apply and wedge later git calls.
      await gitFn(cfg, ["am", "--abort"], { cwd: wtPath, timeoutMs: 30_000, check: false });
      // final-review follow-up: on a real content conflict, git's substantive
      // lines — "Applying: <subject>", "Using index info…", "Falling back to
      // …3-way merge…", "Auto-merging <file>", "CONFLICT (content): Merge
      // conflict in <file>", "Patch failed at 0001 <subject>" — all land on
      // STDOUT, while stderr carries only a generic "error: Failed to merge
      // in the changes." plus five `hint:` lines telling a human how to drive
      // an interactive `am` (`--show-current-patch`/`--continue`/`--skip`/
      // `--abort`/disabling the advice) that junco never exposes. `stderr ||
      // stdout` picked stderr whenever it was non-empty — which it always is
      // on a content conflict — so the conflicting file was NEVER captured in
      // `reason`, the transcript's errorMessage, the fallback prompt, or the
      // PR disclosure banner. Concatenate both streams (stdout first — that's
      // where the substance is) and drop the hint/advice noise BEFORE the
      // line cap, so the cap isn't spent on boilerplate instead of the cause.
      const combined = [r.stdout, r.stderr].filter((s) => s.length > 0).join("\n");
      const detail = combined
        .split("\n")
        .filter((line) => !/^\s*(hint:|advice\.)/i.test(line))
        .slice(0, 20)
        .join("\n")
        .trim();
      const reason = `git am --3way failed (exit ${r.code})${detail ? `: ${detail}` : ""}`;
      writeRunEnd(sink, {
        errorMessage: reason,
        stopReason: "apply_failed",
        timedOut: false,
        abortedByGuard: false,
        usage: ZERO_USAGE,
        durationMs: now() - startedAt,
      });
      return { ok: false, refused: false, error: reason };
    }
    const durationMs = now() - startedAt;
    writeRunEnd(sink, {
      errorMessage: null,
      stopReason: "apply",
      timedOut: false,
      abortedByGuard: false,
      usage: ZERO_USAGE,
      durationMs,
    });
    return {
      ok: true,
      value: {
        finalText: `Applied ${patchSummary(series)}`,
        toolCalls: [],
        usage: ZERO_USAGE,
        stopReason: "apply",
        errorMessage: null,
        timedOut: false,
        durationMs,
        abortedByGuard: false,
      },
    };
  } finally {
    endSink(sink);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// buildApplyFallbackPrompt — Stage 2a escalation ladder (apply-tickets-design.md).
// ---------------------------------------------------------------------------

/**
 * Prompt for the fallback agent turn dispatched when a ticket's junco-patch
 * series either failed to apply, or applied but the ticket's own
 * `## Verification` block then failed. Mirrors buildCorrectivePrompt's shape
 * (critic.ts) but frames the patch as a SPECIFICATION to implement against
 * current reality, not bytes to replay.
 *
 * final-review R6: what happened to the series differs by rung, and the
 * prompt must say so honestly — on the APPLY rung `git am` really did fail
 * and roll back (git am --abort, applyPatchSeries above), so re-running it
 * would just fail again identically; on the VERIFICATION rung the series
 * applied cleanly and its commits are ALREADY in the worktree — nothing was
 * rolled back, and telling the agent otherwise invites it to redo (and
 * duplicate or conflict with) work that's already there.
 */
export function buildApplyFallbackPrompt(
  task: Ticket,
  series: PatchSeries,
  failure: { kind: "apply" | "verification"; detail: string },
): string {
  const what =
    failure.kind === "apply"
      ? "The ticket carried a patch series, but it did not apply to the current tree."
      : "The ticket's patch series applied cleanly, but the ticket's `## Verification` block failed.";
  const seriesStatus =
    failure.kind === "apply"
      ? "Do NOT run `git am` or `git apply` — the series has already been tried and rolled " +
        "back (`git am --abort` ran; the worktree is clean)."
      : "Do NOT run `git am` or `git apply` again — the series ALREADY applied and its commits " +
        "are already in this worktree. Your job is to fix what the checks below caught, not " +
        "to redo work that's already there.";
  // final-review O5: task.body still carries the fenced mbox (the series is
  // embedded once already, below, as the raw diff bytes an agent must read) —
  // re-embedding it a second time via the raw ticket body would double the
  // prompt for a large series. Strip the fence; the ticket's own prose
  // (Why/Verification) survives untouched.
  const ticketProse = stripPatchFence(task.body);
  return (
    "## Apply-mode fallback — finish this ticket yourself\n\n" +
    what +
    "\n\nThe patch below is the CHANGE THAT WAS INTENDED and reviewed. Treat it as the\n" +
    "specification, not as bytes to replay: the tree has moved, so implement the same\n" +
    `intent against what is actually there. ${seriesStatus}\n\n` +
    `### Why it failed\n\n\`\`\`\n${failure.detail}\n\`\`\`\n\n` +
    `### Intended change (${series.count} patch(es), ${series.files.length} file(s))\n\n` +
    "```\n" +
    series.raw +
    "\n```\n\n" +
    "### The ticket\n\n" +
    ticketProse +
    "\n"
  );
}
