import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { TERMINAL_DONE_STATUSES, type RunResult } from "./types.js";
import type { PrOutcome } from "./prFlow.js";
import { metrics } from "./metrics.js";

export interface TerminalDirs {
  done: string;
  failed: string;
}

/** Where the ticket landed and the terminal status that routed it there. */
export interface FinalizeResult {
  dst: string;
  status: string;
}

function statusFor(r: RunResult): string {
  if (r.timedOut) return "timeout";
  if (r.errorMessage) return "failed";
  return "completed";
}

function renderResult(original: string, status: string, r: RunResult): string {
  const reply = r.finalText || "_(no assistant text)_";
  const stats = `**Elapsed:** ${Math.round(r.durationMs / 1000)}s · **Tokens:** in=${r.usage.input} out=${r.usage.output}`;
  // Omit stop_reason when absent (Python parity: the key was only written when
  // truthy) so a future parser of this block doesn't see the literal "null".
  const stopLine = r.stopReason ? `\nstop_reason: ${r.stopReason}` : "";
  const meta = `status: ${status}${stopLine}\nduration_seconds: ${Math.round(r.durationMs / 1000)}`;
  return `${original.trimEnd()}\n\n---\n<!-- junco-result\n${meta}\n-->\n\n## Result\n\n${stats}\n\n${reply}\n`;
}

export function finalize(
  ticketPath: string,
  result: RunResult,
  dirs: TerminalDirs,
): FinalizeResult {
  const status = statusFor(result);
  const body = renderResult(readFileSync(ticketPath, "utf8"), status, result);

  // Atomic content update: write a sibling temp then rename into place (so a
  // crash mid-write can't leave a truncated ticket) — the PR #1 pattern.
  const tmp = ticketPath + ".tmp";
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, ticketPath);

  const dstDir = status === "completed" ? dirs.done : dirs.failed;
  mkdirSync(dstDir, { recursive: true });
  const dst = join(dstDir, basename(ticketPath));
  renameSync(ticketPath, dst); // atomic move, same filesystem

  // Single metrics instrumentation point for the Q&A path — after the terminal
  // status is computed and the ticket has been moved into done/ or failed/.
  metrics.recordTask(status, result.usage, result.durationMs);
  return { dst, status };
}

// ---------------------------------------------------------------------------
// PR-aware finalization — port of worker.py finalize_task PR handling
// (status computation lines 2374-2392; PR frontmatter/result fields).
// ---------------------------------------------------------------------------

/**
 * Compute the terminal status for a PR-flow run. Port of the cascade in
 * worker.py finalize_task (lines 2374-2392), extended with timeout salvage:
 *   timeout_partial      → timedOut && pushed (commits salvaged before cutoff)
 *   timeout              → timedOut && !pushed
 *   failed               → phaseError, OR (errorMessage && !abortedByGuard)
 *   aborted_partial      → abortedByGuard && pushed
 *   aborted_no_changes   → abortedByGuard && !pushed
 *   <statusOverride>     → e.g. "completed_no_changes"
 *   completed            → otherwise
 */
export function computePrStatus(
  result: RunResult,
  prOutcome: PrOutcome | null,
  phaseError: string | null,
): string {
  const pushed = Boolean(prOutcome && prOutcome.pushed);
  if (result.timedOut) return pushed ? "timeout_partial" : "timeout";
  if (phaseError) return "failed";
  if (result.errorMessage && !result.abortedByGuard) return "failed";
  if (result.abortedByGuard) return pushed ? "aborted_partial" : "aborted_no_changes";
  if (prOutcome && prOutcome.statusOverride) return prOutcome.statusOverride;
  return "completed";
}

function renderPrResult(
  original: string,
  status: string,
  r: RunResult,
  prOutcome: PrOutcome,
  phaseError: string | null,
): string {
  const reply = r.finalText || "_(no assistant text)_";
  const stats = `**Elapsed:** ${Math.round(r.durationMs / 1000)}s · **Tokens:** in=${r.usage.input} out=${r.usage.output}`;
  const stopLine = r.stopReason ? `\nstop_reason: ${r.stopReason}` : "";

  // PR frontmatter fields, emitted into the junco-result metadata block when a
  // PR outcome is present (parity with worker.py _augment_frontmatter additions,
  // lines 2530-2541). Only non-empty values are written.
  const fm: string[] = [];
  if (prOutcome.prUrl) fm.push(`pr_url: ${prOutcome.prUrl}`);
  if (prOutcome.branch) fm.push(`branch: ${prOutcome.branch}`);
  if (prOutcome.baseBranch) fm.push(`base_branch: ${prOutcome.baseBranch}`);
  if (prOutcome.commits.length > 0) fm.push(`commit_count: ${prOutcome.commits.length}`);
  fm.push(`pushed: ${prOutcome.pushed}`);
  if (prOutcome.amendedPrNumber !== null) fm.push(`amended_pr: ${prOutcome.amendedPrNumber}`);
  const fmBlock = fm.length > 0 ? "\n" + fm.join("\n") : "";

  const meta = `status: ${status}${stopLine}\nduration_seconds: ${Math.round(r.durationMs / 1000)}${fmBlock}`;

  // A human-facing PR section + error banner (mirrors the Python pr_block).
  const lines: string[] = [stats];
  const prLines: string[] = [];
  if (prOutcome.prUrl) {
    const label =
      prOutcome.amendedPrNumber !== null
        ? `**PR (amended #${prOutcome.amendedPrNumber}):**`
        : "**PR:**";
    prLines.push(`${label} ${prOutcome.prUrl}`);
  }
  if (prOutcome.branch) {
    let branchLine = `**Branch:** \`${prOutcome.branch}\``;
    if (prOutcome.baseBranch) branchLine += ` ← \`${prOutcome.baseBranch}\``;
    if (prOutcome.commits.length > 0) {
      const n = prOutcome.commits.length;
      const word = prOutcome.amendedPrNumber !== null ? "new commit" : "commit";
      branchLine += ` (${n} ${word}${n !== 1 ? "s" : ""})`;
    }
    prLines.push(branchLine);
  }
  if (prOutcome.nwo) prLines.push(`**Repo:** \`${prOutcome.nwo}\``);
  if (prOutcome.worktreePreserved && prOutcome.worktreePath) {
    prLines.push(`**Worktree preserved:** \`${prOutcome.worktreePath}\``);
  }
  if (prLines.length > 0) lines.push(prLines.join("\n"));

  const err = phaseError || r.errorMessage;
  if ((status === "failed" || status === "timeout") && err) {
    lines.push(`> **${status === "timeout" ? "Timed out" : "Failed"}.** ${err}`);
  } else if (status === "aborted_partial") {
    lines.push(
      `> **⚠️ Partial run — aborted by the loop guard.** ${err || "Killed mid-session."} Review the diff carefully.`,
    );
  } else if (status === "aborted_no_changes") {
    lines.push(
      `> **Aborted by the loop guard with no committed work.** ${err || "Killed before any commits."}`,
    );
  } else if (status === "timeout_partial") {
    lines.push(
      `> **⚠️ Partial run — hit the ticket timeout mid-session.** Commits made before the cutoff were salvaged and pushed. Review for completeness; consider an amendment ticket to finish.`,
    );
  }

  lines.push(reply);

  return `${original.trimEnd()}\n\n---\n<!-- junco-result\n${meta}\n-->\n\n## Result\n\n${lines.join("\n\n")}\n`;
}

export interface FinalizePrOpts {
  dirs: TerminalDirs;
  phaseError?: string | null;
}

/**
 * Finalize a PR-flow ticket: compute status, render the result block (with PR
 * fields), and atomically move the ticket to done/ or failed/. Port of the
 * PR-side of worker.py finalize_task.
 */
export function finalizePr(
  ticketPath: string,
  result: RunResult,
  prOutcome: PrOutcome,
  opts: FinalizePrOpts,
): FinalizeResult {
  const phaseError = opts.phaseError ?? null;
  const status = computePrStatus(result, prOutcome, phaseError);
  const body = renderPrResult(
    readFileSync(ticketPath, "utf8"),
    status,
    result,
    prOutcome,
    phaseError,
  );

  const tmp = ticketPath + ".tmp";
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, ticketPath);

  const dstDir = TERMINAL_DONE_STATUSES.has(status) ? opts.dirs.done : opts.dirs.failed;
  mkdirSync(dstDir, { recursive: true });
  const dst = join(dstDir, basename(ticketPath));
  renameSync(ticketPath, dst);

  // Single metrics instrumentation point for the PR path — after the terminal
  // status is computed and the ticket has been moved into done/ or failed/.
  metrics.recordTask(status, result.usage, result.durationMs);
  return { dst, status };
}
