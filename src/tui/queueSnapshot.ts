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
import { outboxDepth as computeOutboxDepth } from "../githubOutbox.js";

export interface QueueRunning {
  id: string;
  github: TicketGithub | null;
  turns: number | null;
  lastTool: string | null;
  outputTokens: number | null;
  startedAt: string | null;
  /** true when sourced from processing/ because /health was unreachable. */
  stale: boolean;
}

export interface QueueWaiting {
  id: string;
  github: TicketGithub | null;
  kind: "pr" | "ask" | "plan";
  priority: "low" | "normal" | "high";
  retryCount: number;
  /** ISO stamp when deferred (future not_before), else null. */
  notBefore: string | null;
  deferred: boolean;
}

export interface QueueRecent {
  id: string;
  github: TicketGithub | null;
  status: "done" | "failed";
  finishedAt: string; // file mtime, ISO
}

export interface QueueSnapshot {
  daemonUp: boolean;
  maxConcurrent: number;
  running: QueueRunning[];
  waiting: QueueWaiting[]; // claim order
  recent: QueueRecent[]; // newest-first, cap 5
  error: string | null;
  /** Count of ops parked in the GitHub outbox (offline store-and-forward). */
  outboxDepth: number;
}

export interface QueueSnapshotDeps {
  readdirFn?: (dir: string) => string[];
  readFileFn?: (p: string) => string;
  statFn?: (p: string) => { mtimeMs: number };
  fetchFn?: typeof fetch;
  nowFn?: () => Date;
}

const HEALTH_TIMEOUT_MS = 1500;
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
}

export function makeQueueSnapshotFn(
  cfg: Config,
  deps: QueueSnapshotDeps = {},
): () => Promise<QueueSnapshot> {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string): string => readFileSync(p, "utf8"));
  const statFn = deps.statFn ?? statSync;
  const fetchFn = deps.fetchFn ?? fetch;
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const paths = queuePaths(cfg);

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

  return async (): Promise<QueueSnapshot> => {
    const base: QueueSnapshot = {
      daemonUp: false,
      maxConcurrent: cfg.maxConcurrent,
      running: [],
      waiting: [],
      recent: [],
      error: null,
      // Best-effort 0 for the catch path below — outboxDepth itself never
      // throws (it swallows readdir failures internally), but an unrelated
      // failure earlier in the try (e.g. nowFn) must still yield a renderable
      // snapshot rather than an undefined field.
      outboxDepth: 0,
    };
    try {
      const now = nowFn().getTime();

      // -- waiting: mirror claimNextTask ordering exactly ------------------
      const waiting = listMd(paths.inbox)
        .flatMap((p) => {
          const t = parseAt(p);
          return t ? [t] : [];
        })
        .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority])
        .map((t): QueueWaiting => {
          const ts = t.notBefore ? Date.parse(t.notBefore) : NaN;
          const deferred = Number.isFinite(ts) && ts > now; // unparseable = eligible (runOnce parity)
          return {
            id: displayId(t),
            github: t.github,
            kind: t.github?.kind ?? (t.hasRepo ? "pr" : "ask"),
            priority: t.priority,
            retryCount: t.retryCount,
            notBefore: deferred ? t.notBefore : null,
            deferred,
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
      if (cfg.healthEnabled) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
          try {
            const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, {
              signal: ctrl.signal,
            });
            if (resp.ok) {
              const j = (await resp.json()) as {
                metrics?: {
                  currentTickets?: string[];
                  currentProgress?: Record<string, HealthProgress>;
                };
              };
              daemonUp = true;
              const prog = j.metrics?.currentProgress ?? {};
              running = (j.metrics?.currentTickets ?? []).map((id): QueueRunning => {
                const p = prog[id];
                return {
                  id,
                  github: procById.get(id)?.github ?? null,
                  turns: p?.turns ?? null,
                  lastTool: p?.lastTool ?? null,
                  outputTokens: p?.outputTokens ?? null,
                  startedAt: p?.startedAt ?? null,
                  stale: false,
                };
              });
            }
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // unreachable/timeout — fall through to the processing/ fallback
        }
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
            stale: true,
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
          const t = parseAt(e.p);
          return {
            id: t ? displayId(t) : stripStamp(basename(e.p).replace(/\.md$/, "")),
            github: t?.github ?? null,
            status: e.status,
            finishedAt: new Date(e.mtimeMs).toISOString(),
          };
        });

      // Reuse the same readdirFn the rest of this snapshot was built with
      // (test fakes then cover both the queue dirs and the outbox dir).
      const outboxDepth = computeOutboxDepth(cfg, { readdirFn });

      return { ...base, daemonUp, running, waiting, recent, outboxDepth };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
