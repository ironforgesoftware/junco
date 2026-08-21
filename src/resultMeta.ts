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
  };
}
