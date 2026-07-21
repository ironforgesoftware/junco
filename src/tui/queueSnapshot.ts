/**
 * Local queue snapshot for the dashboard: the queue dirs + the daemon's
 * /health progress merged into one render-ready structure. The waiting order
 * MUST mirror claimNextTask (runOnce.ts) — lexicographic filename discovery,
 * skip-unreadable, stable priority sort, not_before gate — so a position shown
 * here is the position the daemon will actually claim in.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config, TicketGithub, Ticket } from "../types.js";
import { PRIORITY_RANK } from "../types.js";
import { queuePaths } from "../config.js";
import { parseTicket } from "../ticket.js";
import { parseResultMeta } from "../resultMeta.js";
import { makeTaskHistoryReader } from "../taskHistory.js";
import { outboxDepth as computeOutboxDepth, deadCount } from "../githubOutbox.js";
import { fetchHealthBody, type HealthBody } from "./healthBody.js";
import { buildQueueStats, type QueueStats } from "./queueStats.js";

export interface QueueRunning {
  id: string;
  github: TicketGithub | null;
  turns: number | null;
  lastTool: string | null;
  outputTokens: number | null;
  startedAt: string | null;
  /** ISO of the last progress update (currentProgress[id].updatedAt); null when
   * /health has no progress entry yet or the row is a processing/ fallback. */
  updatedAt: string | null;
  /** true when sourced from processing/ because /health was unreachable. */
  stale: boolean;
  /** Ticket's `repo:` target path (frontmatter, raw); null on Q&A tickets and
   * unparsable rows. Lets the dashboard scope queue activity to a repo. */
  repoPath: string | null;
}

export interface QueueWaiting {
  id: string;
  github: TicketGithub | null;
  kind: "pr" | "ask" | "plan" | "assess";
  priority: "low" | "normal" | "high";
  retryCount: number;
  /** ISO stamp when deferred (future not_before), else null. */
  notBefore: string | null;
  deferred: boolean;
  /** ISO of the inbox file's mtime (when it landed in the queue); null when the
   * stat failed (vanished between discover and stat). */
  queuedAt: string | null;
  /** Ticket's `repo:` target path (frontmatter, raw); null on Q&A tickets. */
  repoPath: string | null;
}

export interface QueueRecent {
  id: string;
  github: TicketGithub | null;
  status: "done" | "failed";
  finishedAt: string; // file mtime, ISO
  /** Terminal status from the junco-result block (parseResultMeta); null on a
   * legacy/blockless file. */
  resultStatus: string | null;
  durationSeconds: number | null;
  prUrl: string | null;
  /** Ticket's `repo:` target path (frontmatter, raw); null when unparsable. */
  repoPath: string | null;
}

export interface QueueSnapshot {
  daemonUp: boolean;
  maxConcurrent: number;
  /** Config default task budget — drives the running-row gauge; null when unknown. */
  taskTimeoutSeconds: number | null;
  running: QueueRunning[];
  waiting: QueueWaiting[]; // claim order
  recent: QueueRecent[]; // newest-first, cap 5
  error: string | null;
  /** Count of ops parked in the GitHub outbox (offline store-and-forward). */
  outboxDepth: number;
  /** Derived queue statistics (ledger windows, ETA, gate/spend/guards). null
   * only on the error-path base object. */
  stats: QueueStats | null;
}

export interface QueueSnapshotDeps {
  readdirFn?: (dir: string) => string[];
  readFileFn?: (p: string) => string;
  statFn?: (p: string) => { mtimeMs: number };
  fetchFn?: typeof fetch;
  nowFn?: () => Date;
}

/** Per-invocation options for the snapshot function a factory returns. */
export interface QueueSnapshotOpts {
  /** Pre-fetched /health, threaded in by makeLocalCheapFn so the queue layer
   * issues no second request (one consistent daemonUp per cheap tick). A
   * PER-INVOCATION value (not a factory dep) so the factory — and the
   * task-history shard memo living in its closure — can be constructed once
   * and held across ticks (#235). Absent (undefined) keeps the self-fetch
   * path; present → a HealthBody means daemon up (use its metrics); null
   * means daemon down → processing/ fallback. */
  healthOverride?: { body: HealthBody | null };
}

const RECENT_CAP = 5;

/** Claimed/finalized basenames carry a `<UTC-stamp>__` prefix (queue.ts
 * utcStamp — YYYY-MM-DDTHHMMZ). Strip exactly that; other `__` are content. */
export function stripStamp(name: string): string {
  return name.replace(/^\d{4}-\d{2}-\d{2}T\d{4}Z__/, "");
}

interface HealthProgress {
  turns?: number;
  lastTool?: string | null;
  outputTokens?: number;
  startedAt?: string;
  updatedAt?: string;
}

export function makeQueueSnapshotFn(
  cfg: Config,
  deps: QueueSnapshotDeps = {},
): (opts?: QueueSnapshotOpts) => Promise<QueueSnapshot> {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string): string => readFileSync(p, "utf8"));
  const statFn = deps.statFn ?? statSync;
  const fetchFn = deps.fetchFn ?? fetch;
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const paths = queuePaths(cfg);

  // Constructed ONCE per factory so its per-shard memo survives across ticks
  // (a caller that holds this factory amortizes ledger parsing over its polling).
  const historyReader = makeTaskHistoryReader(cfg, {
    readFileFn: deps.readFileFn,
    statFn: deps.statFn,
    nowFn: deps.nowFn,
  });

  const listMd = (dir: string): string[] => {
    try {
      return readdirFn(dir)
        .filter((n) => n.endsWith(".md"))
        .map((n) => join(dir, n))
        .sort();
    } catch {
      return []; // missing dir (fresh install) or transient error — render empty
    }
  };

  // Same defensive posture as claimNextTask: the queue can change between
  // discover and read; one vanished/unreadable file must not sink the snapshot.
  const parseAt = (p: string): Ticket | null => {
    try {
      return parseTicket(p, readFileFn(p), cfg.defaultTimeoutMinutes);
    } catch {
      return null;
    }
  };

  const displayId = (t: Ticket): string => stripStamp(t.id);

  /** Raw frontmatter `repo:` — parseTicket keeps only hasRepo, so the path is
   * read back off the retained frontmatter record. */
  const ticketRepoPath = (t: Ticket | null | undefined): string | null => {
    const r = t?.frontmatter["repo"];
    return typeof r === "string" && r !== "" ? r : null;
  };

  return async (opts: QueueSnapshotOpts = {}): Promise<QueueSnapshot> => {
    const base: QueueSnapshot = {
      daemonUp: false,
      maxConcurrent: cfg.maxConcurrent,
      taskTimeoutSeconds: cfg.defaultTimeoutMinutes > 0 ? cfg.defaultTimeoutMinutes * 60 : null,
      running: [],
      waiting: [],
      recent: [],
      error: null,
      // Best-effort 0 for the catch path below — outboxDepth itself never
      // throws (it swallows readdir failures internally), but an unrelated
      // failure earlier in the try (e.g. nowFn) must still yield a renderable
      // snapshot rather than an undefined field.
      outboxDepth: 0,
      // null only here — the try-body always computes real stats; the catch
      // path returns this base unchanged.
      stats: null,
    };
    try {
      const now = nowFn().getTime();

      // -- waiting: mirror claimNextTask ordering exactly ------------------
      // Keep the path alongside the parsed ticket so `queuedAt` can stat the
      // inbox file (mtime = when it landed in the queue).
      const waiting = listMd(paths.inbox)
        .flatMap((p) => {
          const t = parseAt(p);
          return t ? [{ path: p, ticket: t }] : [];
        })
        .sort((a, b) => PRIORITY_RANK[b.ticket.priority] - PRIORITY_RANK[a.ticket.priority])
        .map(({ path, ticket: t }): QueueWaiting => {
          const ts = t.notBefore ? Date.parse(t.notBefore) : NaN;
          const deferred = Number.isFinite(ts) && ts > now; // unparseable = eligible (runOnce parity)
          let queuedAt: string | null = null;
          try {
            queuedAt = new Date(statFn(path).mtimeMs).toISOString();
          } catch {
            queuedAt = null; // vanished between discover and stat
          }
          return {
            id: displayId(t),
            github: t.github,
            // Assess tickets also carry `repo:` (the audit target), which would
            // otherwise trigger the pr branch below — check first, mirroring
            // runOnce's branch ordering (src/runOnce.ts, the `next.assess` guard
            // precedes `next.hasRepo`).
            kind: t.assess ? "assess" : (t.github?.kind ?? (t.hasRepo ? "pr" : "ask")),
            priority: t.priority,
            retryCount: t.retryCount,
            notBefore: deferred ? t.notBefore : null,
            deferred,
            queuedAt,
            repoPath: ticketRepoPath(t),
          };
        });

      // -- processing/: id → ticket map (github enrichment + down-fallback) --
      const proc = listMd(paths.processing).flatMap((p) => {
        const t = parseAt(p);
        return t ? [{ path: p, ticket: t }] : [];
      });
      const procById = new Map(proc.map((e) => [displayId(e.ticket), e.ticket]));

      // -- running: /health when up, processing/ fallback when not ----------
      let daemonUp = false;
      let running: QueueRunning[] = [];
      const mkRunning = (tickets: string[], prog: Record<string, HealthProgress>): QueueRunning[] =>
        tickets.map((id): QueueRunning => {
          const p = prog[id];
          return {
            id,
            github: procById.get(id)?.github ?? null,
            turns: p?.turns ?? null,
            lastTool: p?.lastTool ?? null,
            outputTokens: p?.outputTokens ?? null,
            startedAt: p?.startedAt ?? null,
            updatedAt: p?.updatedAt ?? null,
            stale: false,
            repoPath: ticketRepoPath(procById.get(id)),
          };
        });
      // healthOverride present → use its already-fetched body (makeLocalCheapFn
      // shares ONE /health per tick); absent → self-fetch the FULL body via
      // fetchHealthBody (which owns the timeout/abort and the healthEnabled gate).
      // A null body means the daemon is down → the processing/ fallback below.
      const body =
        opts.healthOverride !== undefined
          ? opts.healthOverride.body
          : await fetchHealthBody(cfg, { fetchFn });
      if (body !== null) {
        daemonUp = true;
        running = mkRunning(
          body.metrics?.currentTickets ?? [],
          body.metrics?.currentProgress ?? {},
        );
      }
      if (!daemonUp) {
        running = proc.map(
          (e): QueueRunning => ({
            id: displayId(e.ticket),
            github: e.ticket.github,
            turns: null,
            lastTool: null,
            outputTokens: null,
            startedAt: null,
            updatedAt: null,
            stale: true,
            repoPath: ticketRepoPath(e.ticket),
          }),
        );
      }

      // -- recent: done/ + failed/ by mtime, newest first, cap --------------
      const recent = [
        ...listMd(paths.done).map((p) => ({ p, status: "done" as const })),
        ...listMd(paths.failed).map((p) => ({ p, status: "failed" as const })),
      ]
        .flatMap((e) => {
          try {
            return [{ ...e, mtimeMs: statFn(e.p).mtimeMs }];
          } catch {
            return []; // vanished between readdir and stat
          }
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, RECENT_CAP)
        .map((e): QueueRecent => {
          // Read the file ONCE — the content feeds both parseTicket (id/github)
          // and parseResultMeta (result block). Same never-throw posture: a
          // vanished/unreadable file falls back to the stamped basename with
          // null result fields.
          let content: string | null = null;
          try {
            content = readFileFn(e.p);
          } catch {
            content = null;
          }
          let t: Ticket | null = null;
          if (content !== null) {
            try {
              t = parseTicket(e.p, content, cfg.defaultTimeoutMinutes);
            } catch {
              t = null;
            }
          }
          const meta =
            content !== null
              ? parseResultMeta(content)
              : { status: null, durationSeconds: null, prUrl: null };
          return {
            id: t ? displayId(t) : stripStamp(basename(e.p).replace(/\.md$/, "")),
            github: t?.github ?? null,
            status: e.status,
            finishedAt: new Date(e.mtimeMs).toISOString(),
            resultStatus: meta.status,
            durationSeconds: meta.durationSeconds,
            prUrl: meta.prUrl,
            repoPath: ticketRepoPath(t),
          };
        });

      // Reuse the same readdirFn the rest of this snapshot was built with
      // (test fakes then cover both the queue dirs and the outbox dir).
      const outboxDepth = computeOutboxDepth(cfg, { readdirFn });
      const outboxDead = deadCount(cfg, { readdirFn });

      const stats = buildQueueStats(
        cfg,
        {
          healthBody: body,
          history: historyReader,
          eligibleWaiting: waiting.filter((w) => !w.deferred).length,
          outbox: { depth: outboxDepth, dead: outboxDead },
        },
        { nowFn: deps.nowFn, readdirFn, statFn },
      );

      return { ...base, daemonUp, running, waiting, recent, outboxDepth, stats };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
