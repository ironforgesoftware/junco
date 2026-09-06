/**
 * The two GitHub-side write idioms every issue-traffic module used to carry
 * its own copy of (githubReport, githubInbox, planSetBridge): post one issue
 * comment through a tempfile with the outbox idempotency marker embedded,
 * and run a best-effort side effect through the durable outbox. One module
 * so the marker, timeout, retry, and warn-and-swallow semantics cannot
 * drift between the reporter, the inbox bridge, and plan-set maintenance.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.js";
import { gh, describeError, GH_TIMEOUT_MS } from "./git.js";
import { tryOrEnqueue, withCommentMarker, type OutboxOp } from "./githubOutbox.js";
import { log } from "./logging.js";

/** Post a single issue comment via `gh issue comment --body-file`, embedding
 * the outbox idempotency marker (withCommentMarker) so a lost-ack replay of
 * the queued comment op is deduped by the next flush and never double-posts
 * (#132). `body` is the RAW (unmarked) text: callers pass the same raw body
 * to the paired outbox `{ kind: "comment" }` op, so tryOrEnqueue/flush
 * compute the identical content-derived marker on both the live path and a
 * queued replay. */
export async function postIssueComment(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  body: string,
  ghFn: typeof gh = gh,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "junco-ghc-"));
  const file = join(dir, "comment.md");
  writeFileSync(file, withCommentMarker(nwo, issueNumber, body), "utf8");
  try {
    await ghFn(cfg, ["issue", "comment", String(issueNumber), "--repo", nwo, "--body-file", file], {
      timeoutMs: GH_TIMEOUT_MS,
      retryNetwork: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Who is writing: the outbox `source` stamped on a queued op and the prefix
 * of the warning logged when the side effect fails for a non-network reason. */
export interface OutboxScope {
  source: Parameters<typeof tryOrEnqueue>[1];
  prefix: string;
}

/** Outbox-aware guard: on a network-shaped failure, `fn`'s side effect is
 * parked in the durable outbox (`op`) instead of being lost; any other
 * failure keeps the best-effort contract — warn and swallow, since the next
 * sweep re-derives and retries state from GitHub reality. */
export async function guardOrQueue(
  cfg: Config,
  scope: OutboxScope,
  label: string,
  id: string,
  op: OutboxOp,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await tryOrEnqueue(cfg, scope.source, op, fn);
  } catch (e) {
    log.warn(`${scope.prefix}: ${label} failed (issue state on GitHub may be stale)`, {
      id,
      error: describeError(e),
    });
  }
}
