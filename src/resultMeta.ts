/**
 * Parser for the `<!-- junco-result ... -->` metadata block that finalize.ts
 * appends to every done/failed ticket (src/finalize.ts renderResult /
 * renderPrResult). The LAST block wins — a retried ticket accumulates one
 * block per attempt (same rule as listCmd's ticketStatusOf, which this
 * replaces as the single parser). Never throws; absent keys are null.
 */

export interface ResultMeta {
  status: string | null;
  durationSeconds: number | null;
  prUrl: string | null;
  dependencyFailed: string | null;
  /** Plan-set supersede marker (planSets.ts's supersedeUnclaimed): the hash of
   * the plan revision that pre-empted this ticket before it ever ran. Null =
   * not a superseded ticket (an ordinary failure, or done/still-queued). */
  superseded: string | null;
  /** Offline PR endgame marker (finalize.ts renderPrResult): the ticket
   * finalized DONE with its push→PR sequence parked in the outbox, so the PR
   * does not exist yet and `prUrl` is null. The dependency sweep must WAIT on
   * such an edge rather than treating "no PR" as "no PR was ever coming"
   * (#298). Cleared when the outbox flush upserts the real pr_url. */
  prQueued: boolean;
}

const BLOCK_RE = /<!-- junco-result\n([\s\S]*?)(?:-->|$)/g;

/** The exact human-facing sentence finalize.ts's `renderPrResult` writes into
 * the `## Result` section when a PR finalizes with its push→PR sequence parked
 * in the outbox. Shared with finalize.ts so the write-back's self-consistency
 * rewrite below can find and replace the exact string that module produces —
 * duplicating it as an inline literal in two files would drift silently. */
export const PR_QUEUED_SENTENCE =
  "PR queued for offline push — junco will open it automatically when GitHub is reachable.";

export function parseResultMeta(content: string): ResultMeta {
  let last: string | null = null;
  for (const m of content.matchAll(BLOCK_RE)) last = m[1];
  if (last === null)
    return {
      status: null,
      durationSeconds: null,
      prUrl: null,
      dependencyFailed: null,
      superseded: null,
      prQueued: false,
    };
  const field = (key: string): string | null => {
    const m = new RegExp(`^${key}: ?(.*)$`, "m").exec(last as string);
    return m ? m[1].trim() : null;
  };
  const durRaw = field("duration_seconds");
  const dur = durRaw !== null && /^\d+$/.test(durRaw) ? parseInt(durRaw, 10) : null;
  return {
    status: field("status"),
    durationSeconds: dur,
    prUrl: field("pr_url"),
    dependencyFailed: field("dependency_failed"),
    superseded: field("superseded"),
    prQueued: field("pr_queued") === "true",
  };
}

/**
 * Set `pr_url` in the LAST `junco-result` block and drop any `pr_queued`
 * marker, returning the rewritten content. Used by the outbox when an offline
 * PR op finally opens its PR (#298): the ticket already finalized to done/
 * with no URL, and the dependency sweep needs the real one to probe. Content
 * with no block is returned unchanged — callers treat that as "nothing to
 * update", never as an error.
 *
 * Also keeps the document self-consistent: the human `## Result` section
 * (rendered by finalize.ts alongside the same machine block) says "PR queued
 * for offline push…" with no link — left untouched, the machine block would
 * carry the real `pr_url` while the prose right above it still claimed the PR
 * didn't exist yet. The replacement is scoped to the tail from the LAST
 * block onward (nothing is ever appended after it, so that tail is exactly
 * this attempt's own Result section) so a retried ticket's earlier, historical
 * attempts are never rewritten. Idempotent: a second call after the sentence
 * is already replaced (or on content that never had it) leaves the tail
 * unchanged — `String.prototype.replace` with no match is a no-op.
 */
export function upsertResultPrUrl(content: string, url: string): string {
  const blocks = [...content.matchAll(BLOCK_RE)];
  const last = blocks[blocks.length - 1];
  if (!last) return content;
  const body = last[1];
  const kept = body
    .split("\n")
    .filter((l) => !/^pr_queued:/.test(l) && !/^pr_url:/.test(l))
    .join("\n")
    .replace(/\n+$/, "");
  const rebuilt = `${kept}\npr_url: ${url}\n`;
  const start = last.index ?? 0;
  const blockText = last[0];
  // Function replacers throughout: `body`/`rebuilt`/`url` are never guaranteed
  // free of `$`-prefixed substrings (a `$&`/`` $` ``/`$'` in a plain string
  // replacement is interpreted as a replace-pattern token, not literal text).
  const newBlockText = blockText.replace(body, () => rebuilt);
  const afterBlock = content
    .slice(start + blockText.length)
    .replace(PR_QUEUED_SENTENCE, () => `**PR:** ${url}`);
  return content.slice(0, start) + newBlockText + afterBlock;
}

/**
 * Remove the `pr_queued` marker line from the LAST `junco-result` block,
 * returning the content unchanged when there is no block or no marker to
 * remove. Used by the outbox when a `pr` op with a linked done ticket
 * dead-letters BEFORE ever creating the PR (#298): a permanent (non-network)
 * `gh pr create` failure — an expired token, a deleted base branch, lost
 * repo write access — means no replay is ever coming to clear the marker via
 * upsertResultPrUrl, so a dependent stamped by sweepDependencies to WAIT on
 * it would wait forever. Stripping the marker restores the pre-#298
 * behaviour: the dependent proceeds and fails loudly on its own PR create,
 * same as it always did before the offline-dependency-window fix.
 *
 * Deliberately narrower than upsertResultPrUrl's rewrite: no `pr_url` was
 * ever produced (the op never got that far), so nothing is added — only the
 * marker is dropped. The `## Result` section's "PR queued for offline
 * push…" sentence is left as-is; it is no longer true, but rewriting it as
 * a failure narrative belongs to whatever surfaces the dead-lettered op,
 * not to this best-effort marker-clear.
 */
export function clearResultPrQueued(content: string): string {
  const blocks = [...content.matchAll(BLOCK_RE)];
  const last = blocks[blocks.length - 1];
  if (!last) return content;
  const body = last[1];
  if (!/^pr_queued:/m.test(body)) return content; // nothing to clear
  const kept = body
    .split("\n")
    .filter((l) => !/^pr_queued:/.test(l))
    .join("\n");
  const start = last.index ?? 0;
  const blockText = last[0];
  const newBlockText = blockText.replace(body, () => kept);
  return content.slice(0, start) + newBlockText + content.slice(start + blockText.length);
}
