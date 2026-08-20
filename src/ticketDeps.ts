/**
 * Layer 1 of plan-driven ticket sets (spec 2026-08-20): ticket-state resolver,
 * dependency sweep (merge-gated satisfaction stamping), and failure cascade.
 * Pure queue-directory machinery — no bridge coupling; the only network touch
 * is the injectable PR-state probe.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config, Paths, Ticket } from "./types.js";
import { CLAIM_PREFIX_RE, upsertFrontmatterKey } from "./requeue.js";
import { queuePaths } from "./config.js";
import { parseTicket } from "./ticket.js";
import { parseResultMeta } from "./resultMeta.js";
import { uniqueDestPath } from "./uniqueDest.js";
import { metrics } from "./metrics.js";
import { gh } from "./git.js";
import { log } from "./logging.js";

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

export type PrState = "merged" | "open" | "closed" | "unknown";

export interface DepSweepDeps {
  /** PR-state probe (default: `gh pr view <url> --json state` via cfg.ghBin). */
  prStateFn?: (cfg: Config, prUrl: string) => Promise<PrState>;
}

export interface DepSweepReport {
  stamped: number;
  cascaded: number;
}

async function defaultPrState(cfg: Config, prUrl: string): Promise<PrState> {
  try {
    const r = await gh(cfg, ["pr", "view", prUrl, "--json", "state"]);
    if (r.code !== 0) return "unknown";
    const state = (JSON.parse(r.stdout) as { state?: string }).state;
    if (state === "MERGED") return "merged";
    if (state === "OPEN") return "open";
    if (state === "CLOSED") return "closed";
    return "unknown";
  } catch {
    return "unknown"; // unreachable gh / bad JSON — wait, never cascade (spec)
  }
}

/** Inbox tickets with at least one unconfirmed edge. Per-ticket defensive
 * parse, same stance as claimNextTask: one bad file never wedges the sweep. */
function readWaiting(paths: Paths, defaultTimeoutMinutes: number): Ticket[] {
  let names: string[] = [];
  try {
    names = readdirSync(paths.inbox).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Ticket[] = [];
  for (const n of names) {
    const p = join(paths.inbox, n);
    try {
      const t = parseTicket(p, readFileSync(p, "utf8"), defaultTimeoutMinutes);
      if (t.dependsOn.some((d) => !t.depsSatisfied.includes(d))) out.push(t);
    } catch {
      /* unreadable/vanished — the claim path logs these */
    }
  }
  return out;
}

/**
 * Confirm one edge in the child's frontmatter (worker-managed key), atomic
 * tmp+rename in place — the .tmp name is invisible to the daemon's .md glob.
 *
 * Two guards, both required when a ticket has 2+ edges resolved in the same
 * sweep pass:
 *   - `next` is derived from a FRESH parse of the just-read file content, not
 *     `t.depsSatisfied` (a snapshot taken once by readWaiting at the top of
 *     the sweep). Basing it on the stale snapshot means a second stamp in the
 *     same pass overwrites the first instead of adding to it.
 *   - After building the candidate content, re-parse it and confirm `depId`
 *     actually round-trips into `depsSatisfied` before writing — same #108
 *     stance as requeueTicket's post-upsert verify (src/requeue.ts): a
 *     dependency id containing YAML-flow-breaking characters (e.g. a comma)
 *     can upsert textually as an unquoted flow item and then re-split into
 *     multiple entries on reparse, silently failing to confirm the edge.
 * Returns whether the edge was actually confirmed; the caller must only
 * count/report a stamp when this returns true.
 */
function stampSatisfied(t: Ticket, depId: string): boolean {
  const content = readFileSync(t.path, "utf8");
  const fresh = parseTicket(t.path, content);
  const next = [...new Set([...fresh.depsSatisfied, depId])];
  const updated = upsertFrontmatterKey(content, "deps_satisfied", `[${next.join(", ")}]`);
  const verify = parseTicket(t.path, updated);
  if (!verify.depsSatisfied.includes(depId)) {
    log.warn("deps_satisfied stamp did not persist; leaving edge unconfirmed", {
      id: t.id,
      dep: depId,
    });
    return false;
  }
  const tmp = t.path + ".tmp";
  writeFileSync(tmp, updated, "utf8");
  renameSync(tmp, t.path);
  log.info("dependency satisfied", { id: t.id, dep: depId });
  return true;
}

/** Park a waiting dependent in failed/ with a machine-readable marker (spec:
 * dependency_failed cascade). Mirrors finalize.ts's tmp+rename + uniqueDest
 * move; zero usage — no session ever ran. */
function cascadeFail(paths: Paths, t: Ticket, failedDepId: string): void {
  const content = readFileSync(t.path, "utf8");
  const body =
    `${content.trimEnd()}\n\n---\n<!-- junco-result\n` +
    `status: failed\ndependency_failed: ${failedDepId}\n-->\n\n## Result\n\n` +
    `> **Failed.** Dependency \`${failedDepId}\` failed terminally; this ticket was parked by ` +
    `the dependency cascade before it ran. \`junco retry ${failedDepId}\` re-releases it with ` +
    `that parent (or retry this ticket directly once the dependency is resolved).\n`;
  const tmp = t.path + ".tmp";
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, t.path);
  mkdirSync(paths.failed, { recursive: true });
  const dst = uniqueDestPath(paths.failed, basename(t.path));
  renameSync(t.path, dst);
  metrics.recordTask("failed", { input: 0, output: 0, costUsd: 0 }, 0);
  log.warn("dependency failed — cascading dependent to failed/", {
    id: t.id,
    dep: failedDepId,
    dst,
  });
}

export interface WaitingInfo {
  id: string;
  /** Unconfirmed depends_on edges. */
  pending: string[];
  /** Pending edges that resolve to no ticket anywhere — likely typos or a
   * half-submitted set (spec: dangling edges wait; the CLI surfaces them). */
  missing: string[];
}

/** CLI-facing view of dependency-waiting inbox tickets (list/status/submit). */
export function listWaiting(cfg: Config): WaitingInfo[] {
  const paths = queuePaths(cfg);
  return readWaiting(paths, cfg.defaultTimeoutMinutes).map((t) => {
    const pending = t.dependsOn.filter((d) => !t.depsSatisfied.includes(d));
    return {
      id: t.id,
      pending,
      missing: pending.filter((d) => ticketState(paths, d) === "absent"),
    };
  });
}

/**
 * The dependency sweep (spec 2026-08-20): for every inbox ticket with an
 * unconfirmed depends_on edge, resolve the dep —
 *   absent | inbox | processing → wait
 *   failed                      → cascade (cascadeFail)
 *   done, no PR recorded        → stamp deps_satisfied
 *   done, PR recorded           → merged → stamp · open/unknown → wait ·
 *                                 closed-unmerged → cascade (cascadeFail)
 * Runs in the daemon loop ahead of the claim pass (single process, serial —
 * the in-place frontmatter stamp cannot race a claim). Lazy: a queue with no
 * edges costs one readdir.
 */
export async function sweepDependencies(
  cfg: Config,
  deps: DepSweepDeps = {},
): Promise<DepSweepReport> {
  const paths = queuePaths(cfg);
  const prStateFn = deps.prStateFn ?? defaultPrState;
  const prCache = new Map<string, PrState>(); // one probe per PR per sweep
  const report: DepSweepReport = { stamped: 0, cascaded: 0 };
  for (;;) {
    const waiting = readWaiting(paths, cfg.defaultTimeoutMinutes);
    let changed = false;
    for (const t of waiting) {
      for (const d of t.dependsOn.filter((x) => !t.depsSatisfied.includes(x))) {
        const state = ticketState(paths, d);
        if (state === "absent" || state === "inbox" || state === "processing") continue;
        if (state === "failed") {
          cascadeFail(paths, t, d);
          report.cascaded++;
          changed = true;
          break; // this ticket is gone from inbox — stop iterating its edges
        }
        const doneFile = findTicketFile(paths.done, d);
        if (!doneFile) continue; // raced away between state check and read
        const prUrl = parseResultMeta(readFileSync(doneFile, "utf8")).prUrl;
        if (prUrl === null) {
          if (stampSatisfied(t, d)) {
            report.stamped++;
            changed = true;
          }
          continue;
        }
        const pr = prCache.get(prUrl) ?? (await prStateFn(cfg, prUrl));
        prCache.set(prUrl, pr);
        if (pr === "merged") {
          if (stampSatisfied(t, d)) {
            report.stamped++;
            changed = true;
          }
        } else if (pr === "closed") {
          cascadeFail(paths, t, d);
          report.cascaded++;
          changed = true;
          break;
        }
        // open/unknown → wait.
      }
    }
    if (!changed) return report;
  }
}
