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
import type { Config, RunResult, Ticket, Usage } from "./types.js";
import { git } from "./git.js";
import type { PatchSeries } from "./patchTicket.js";

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 };
const AM_TIMEOUT_MS = 120_000;

export type ApplyOutcome = { ok: true; result: RunResult } | { ok: false; reason: string };

export interface ApplyDeps {
  gitFn?: typeof git;
  nowFn?: () => number;
}

export async function applyPatchSeries(
  cfg: Config,
  wtPath: string,
  series: PatchSeries,
  deps: ApplyDeps = {},
): Promise<ApplyOutcome> {
  const gitFn = deps.gitFn ?? git;
  const now = deps.nowFn ?? ((): number => Date.now());
  const startedAt = now();
  const dir = mkdtempSync(join(tmpdir(), "junco-am-"));
  const file = join(dir, "series.patch");
  writeFileSync(file, series.raw.endsWith("\n") ? series.raw : series.raw + "\n", "utf8");
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
      const detail = (r.stderr || r.stdout || "").split("\n").slice(0, 20).join("\n").trim();
      return {
        ok: false,
        reason: `git am --3way failed (exit ${r.code})${detail ? `: ${detail}` : ""}`,
      };
    }
    return {
      ok: true,
      result: {
        finalText: `Applied ${series.count} patch(es) touching ${series.files.length} file(s): ${series.files.join(", ")}.`,
        toolCalls: [],
        usage: ZERO_USAGE,
        stopReason: "apply",
        errorMessage: null,
        timedOut: false,
        durationMs: now() - startedAt,
        abortedByGuard: false,
      },
    };
  } finally {
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
 * current reality, not bytes to replay — the series has already been tried
 * (and rolled back on an apply failure), so re-running `git am`/`git apply`
 * would just fail again identically.
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
  return (
    "## Apply-mode fallback — finish this ticket yourself\n\n" +
    what +
    "\n\nThe patch below is the CHANGE THAT WAS INTENDED and reviewed. Treat it as the\n" +
    "specification, not as bytes to replay: the tree has moved, so implement the same\n" +
    "intent against what is actually there. Do NOT run `git am` or `git apply` — the\n" +
    "series has already been tried and rolled back.\n\n" +
    `### Why it failed\n\n\`\`\`\n${failure.detail}\n\`\`\`\n\n` +
    `### Intended change (${series.count} patch(es), ${series.files.length} file(s))\n\n` +
    "```\n" +
    series.raw +
    "\n```\n\n" +
    "### The ticket\n\n" +
    task.body +
    "\n"
  );
}
