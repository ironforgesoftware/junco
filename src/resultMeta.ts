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
  return (
    content.slice(0, start) + last[0].replace(body, rebuilt) + content.slice(start + last[0].length)
  );
}
