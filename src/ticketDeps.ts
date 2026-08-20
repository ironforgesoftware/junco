/**
 * Layer 1 of plan-driven ticket sets (spec 2026-08-20): ticket-state resolver,
 * dependency sweep (merge-gated satisfaction stamping), and failure cascade.
 * Pure queue-directory machinery — no bridge coupling; the only network touch
 * is the injectable PR-state probe.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./types.js";
import { CLAIM_PREFIX_RE } from "./requeue.js";

export type TicketState = "done" | "processing" | "inbox" | "failed" | "absent";

/** Filename stem resolves to `id`: exact, or a worker suffix — `-r<n>`
 * (requeue.ts collision) or `-<n>` (uniqueDest.ts collision). A suffix that is
 * not purely r?\d+ is a DIFFERENT id sharing a prefix, never a match. */
function stemMatches(stem: string, id: string): boolean {
  if (stem === id) return true;
  if (!stem.startsWith(id + "-")) return false;
  return /^r?\d+$/.test(stem.slice(id.length + 1));
}

/** First .md file in `dir` whose name (claim stamp stripped) resolves to `id`. */
export function findTicketFile(dir: string, id: string): string | null {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch (e) {
    // A missing queue dir is normal (not created yet) → no match. Anything else
    // (EACCES, ENOTDIR, …) must surface — silently reading it as "absent" would
    // mask an operator misconfiguration (same stance as queue.ts discoverTasks).
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
  for (const n of names) {
    const stem = n.replace(CLAIM_PREFIX_RE, "").replace(/\.md$/, "");
    if (stemMatches(stem, id)) return join(dir, n);
  }
  return null;
}

/** Resolve a ticket id to its queue state. Precedence done > processing >
 * inbox > failed (spec: satisfaction is monotone — once a task has a done
 * record it stays satisfied, whatever superseded/requeued siblings exist). */
export function ticketState(paths: Paths, id: string): TicketState {
  if (findTicketFile(paths.done, id)) return "done";
  if (findTicketFile(paths.processing, id)) return "processing";
  if (findTicketFile(paths.inbox, id)) return "inbox";
  if (findTicketFile(paths.failed, id)) return "failed";
  return "absent";
}
