import { join } from "node:path";
import { knownQueueRoots } from "./config.js";
import { discoverTasks } from "./queue.js";
import type { Config } from "./types.js";

export interface SplitQueueFinding {
  resolvedRoot: string;
  /** Other roots that hold pending tickets, with counts. */
  others: { root: string; label: string; pending: number }[];
}

export interface SplitQueueDeps {
  /** Lists a directory's entries; ENOENT-tolerant (a missing dir counts as
   * empty, never a throw). Defaults to `discoverTasks` (`src/queue.ts`) — the
   * same `.md`-filtering, ENOENT-tolerant lister the worker itself uses to
   * find claimable tickets, so "pending" here means exactly what the worker
   * would claim next. */
  listInbox?: (dir: string) => string[];
}

/**
 * Detects a split queue: the resolved queue root has NO pending tickets while
 * at least one other known root (per `knownQueueRoots`) does. Returns `null`
 * in every other case — including "everything is empty" (a fresh install)
 * and "the resolved queue has work" — so a healthy or brand-new install stays
 * silent.
 *
 * **Counts `inbox/` only — never `done/` or `failed/`, and never
 * `processing/`.** A machine that has correctly completed `junco data
 * migrate` keeps a permanently non-empty legacy `done/`; counting terminal
 * boxes would fire this warning on every start, forever, on precisely the
 * well-maintained installs that did the right thing. `processing/` is
 * excluded too, deliberately: a stale `processing/` entry on the RESOLVED
 * root gets swept by `recoverOrphans` at every daemon startup, but nothing
 * ever sweeps a stale `processing/` entry left on an *abandoned* other root
 * (e.g. before a migrate) — that residue would persist forever and become
 * exactly the same permanent false positive the done/failed ruling above
 * exists to avoid. `inbox/` is the one signal that is unambiguous: it is the
 * actionable backlog a worker would claim from right now, on either side.
 *
 * Pure aside from the injected `listInbox` seam: no direct fs access, no cwd,
 * no argv.
 */
export function detectSplitQueue(
  cfg: Pick<Config, "queueRoot">,
  env: Record<string, string | undefined> = process.env,
  deps: SplitQueueDeps = {},
): SplitQueueFinding | null {
  const listInbox = deps.listInbox ?? discoverTasks;
  const roots = knownQueueRoots(cfg, env);
  const resolved = roots.find((r) => r.resolved);
  // knownQueueRoots always flags exactly one entry resolved; this guard is
  // defensive only (never expected to trip against the real implementation).
  if (!resolved) return null;

  const resolvedPending = listInbox(join(resolved.root, "inbox")).length;
  if (resolvedPending > 0) return null;

  const others = roots
    .filter((r) => !r.resolved)
    .map((r) => ({
      root: r.root,
      label: r.label,
      pending: listInbox(join(r.root, "inbox")).length,
    }))
    .filter((o) => o.pending > 0);

  if (others.length === 0) return null;

  return { resolvedRoot: resolved.root, others };
}
