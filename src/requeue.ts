/**
 * Transparent requeue for transient failures — instead of routing a ticket to
 * failed/ when the inference side hiccuped, move it back to inbox/ with a
 * bumped retry_count and a not_before backoff stamp. The budget
 * (cfg.maxTransientRetries) caps total attempts; an exhausted budget returns
 * {requeued:false} and the caller finalizes to failed/ exactly as before.
 *
 * Classification is deliberately conservative: anything that produced commits,
 * timed out, or was guard-killed is NOT transient (retrying would discard or
 * repeat real work).
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config, RunResult, Ticket } from "./types.js";
import { queuePaths } from "./config.js";
import { log } from "./logging.js";
import { metrics } from "./metrics.js";

/** Matches the UTC claim stamp queue.claim() prefixes onto processing/ names. */
export const CLAIM_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{4}Z__/;

export function isTransientFailure(result: RunResult, newCommits: number): boolean {
  if (newCommits > 0) return false; // never discard committed work
  if (result.timedOut) return false; // slow is not transient
  if (result.abortedByGuard) return false; // behavioral, not infrastructural
  if (result.errorMessage !== null) return true; // session/network/SDK error
  return result.stopReason === "error" || result.stopReason === "length";
}

/**
 * Textually upsert a `key: value` line inside the YAML frontmatter block,
 * preserving the user's formatting everywhere else. Creates a frontmatter
 * block when the content has none.
 */
export function upsertFrontmatterKey(content: string, key: string, value: string | number): string {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return `---\n${key}: ${value}\n---\n\n${content}`;
  const block = m[1];
  const lineRe = new RegExp(`^${key}:.*$`, "m");
  const newBlock = lineRe.test(block)
    ? block.replace(lineRe, `${key}: ${value}`)
    : `${block}\n${key}: ${value}`;
  return content.slice(0, m.index) + `---\n${newBlock}\n---` + content.slice(m.index + m[0].length);
}

export interface RequeueOutcome {
  requeued: boolean;
  dst?: string;
  attempt?: number;
}

/**
 * Move a claimed ticket back to inbox/ for another attempt. Returns
 * {requeued:false} (file untouched) when the retry budget is exhausted.
 * The move is atomic: content is updated in place (tmp+rename inside
 * processing/), then renamed into inbox/ — no duplicate-visible window.
 */
export function requeueTicket(
  cfg: Config,
  claimedPath: string,
  ticket: Ticket,
  reason: string,
): RequeueOutcome {
  if (ticket.retryCount >= cfg.maxTransientRetries) return { requeued: false };
  const attempt = ticket.retryCount + 1;
  const notBefore = new Date(Date.now() + cfg.retryBackoffSeconds * attempt * 1000).toISOString();

  let content = readFileSync(claimedPath, "utf8");
  content = upsertFrontmatterKey(content, "retry_count", attempt);
  content = upsertFrontmatterKey(content, "not_before", JSON.stringify(notBefore));

  const tmp = claimedPath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, claimedPath);

  const inbox = queuePaths(cfg).inbox;
  mkdirSync(inbox, { recursive: true }); // defensive — survives a deleted inbox
  let name = basename(claimedPath).replace(CLAIM_PREFIX_RE, "");
  if (existsSync(join(inbox, name))) name = name.replace(/\.md$/, `-r${attempt}.md`);
  const dst = join(inbox, name);
  renameSync(claimedPath, dst);
  // The single chokepoint every requeue path funnels through (Q&A/PR/assess
  // transient, #64 crash containment, orphan recovery) — count it here so a
  // fails-and-retries ticket is visible in /health and `junco status` (#37).
  metrics.recordRequeue();
  log.warn("transient failure — requeued for retry", {
    dst,
    attempt,
    max: cfg.maxTransientRetries,
    reason,
    notBefore,
  });
  return { requeued: true, dst, attempt };
}
