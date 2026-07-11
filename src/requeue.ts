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
import { parseTicket } from "./ticket.js";
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
  /**
   * Set when the requeue was declined because the ticket's frontmatter is
   * malformed (see #108): the retry mutation could not be made to persist, so
   * the ticket can never advance its budget and must be finalized to failed/
   * rather than requeued into a backoff-free hot loop. Additive/optional — the
   * `requeued:false` contract is unchanged, existing callers still route it to
   * failed/ as they do for an exhausted budget.
   */
  malformed?: boolean;
}

/**
 * Atomically move a claimed ticket back to inbox/: `content` (already
 * frontmatter-mutated by the caller) is written in place inside processing/
 * (tmp+rename), then renamed into inbox/ — no duplicate-visible window. If
 * the inbox already holds a same-named ticket, a `-r{n}` suffix is appended,
 * starting at `suffixSeed` and incrementing past any already-queued retry
 * (#112) so a collision never clobbers a pending ticket. Shared by both
 * requeueTicket (seeds with the bumped attempt number) and
 * requeueTicketKeepBudget (seeds with 1 — this path has no attempt counter).
 */
function moveBackToInbox(
  cfg: Config,
  claimedPath: string,
  content: string,
  suffixSeed: number,
): string {
  const tmp = claimedPath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, claimedPath);

  const inbox = queuePaths(cfg).inbox;
  mkdirSync(inbox, { recursive: true }); // defensive — survives a deleted inbox
  let name = basename(claimedPath).replace(CLAIM_PREFIX_RE, "");
  if (existsSync(join(inbox, name))) {
    // #112: the -r{n} suffix must not clobber an already-queued retry (e.g. an
    // existing t1-r1.md). Loop until a free name is found; the first candidate
    // stays -r{suffixSeed} so single-collision behavior is unchanged.
    let n = suffixSeed;
    let candidate = name.replace(/\.md$/, `-r${n}.md`);
    while (existsSync(join(inbox, candidate))) {
      n += 1;
      candidate = name.replace(/\.md$/, `-r${n}.md`);
    }
    name = candidate;
  }
  const dst = join(inbox, name);
  renameSync(claimedPath, dst);
  return dst;
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

  // #108: a malformed frontmatter block accepts the textual upsert but still
  // fails to re-parse, so parseTicket reads retry_count=0 / not_before=null on
  // every cycle — the budget check above never trips and the ticket becomes a
  // backoff-free hot loop of back-to-back agent sessions. Re-parse the mutated
  // content and confirm the retry state actually persisted; if it did not, the
  // ticket is unexecutable, so decline (leaving it in processing/) and let the
  // caller finalize it to failed/ exactly as it does for an exhausted budget.
  const verify = parseTicket(claimedPath, content);
  if (verify.retryCount !== attempt || verify.notBefore === null) {
    log.warn("malformed frontmatter — retry state cannot persist; routing to failed/", {
      path: claimedPath,
      reason,
    });
    return { requeued: false, malformed: true };
  }

  const dst = moveBackToInbox(cfg, claimedPath, content, attempt);
  // The single chokepoint every requeue path funnels through (Q&A/PR/assess
  // transient, #64 crash containment, orphan recovery, and the count-free
  // requeueTicketKeepBudget below) — count it here so a fails-and-retries
  // ticket is visible in /health and `junco status` (#37).
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

/**
 * Move a claimed ticket back to inbox/ for a gate-class infrastructure
 * failure (e.g. a latched provider outage, see ProviderGate) — unlike
 * requeueTicket, this NEVER touches retry_count (absent stays absent, a
 * present value is preserved verbatim) and has no budget check: it always
 * requeues, even at an exhausted count. That's safe here because the caller
 * is gated (claiming stays blocked until the gate clears), so there is no
 * budget-burning hot loop to guard against the way there is on the
 * transient-failure path — see the #108 comment on requeueTicket above.
 */
export function requeueTicketKeepBudget(
  cfg: Config,
  claimedPath: string,
  notBeforeIso: string,
  reason: string,
): { requeued: true; dst: string } {
  let content = readFileSync(claimedPath, "utf8");
  content = upsertFrontmatterKey(content, "not_before", JSON.stringify(notBeforeIso));

  // Best-effort verification only (contrast with requeueTicket's #108 decline
  // above): if the frontmatter is malformed and not_before can't be made to
  // persist, log a warning but requeue anyway — the gate, not the budget,
  // prevents a hot loop on this path, so declining here would just strand the
  // ticket in processing/ for no safety benefit.
  const verify = parseTicket(claimedPath, content);
  if (verify.notBefore === null) {
    log.warn(
      "malformed frontmatter — not_before may not persist; requeuing anyway (gate-protected)",
      {
        path: claimedPath,
        reason,
      },
    );
  }

  const dst = moveBackToInbox(cfg, claimedPath, content, 1);
  metrics.recordRequeue();
  log.warn("infrastructure failure — requeued without consuming retry budget", {
    dst,
    reason,
    notBefore: notBeforeIso,
  });
  return { requeued: true, dst };
}
