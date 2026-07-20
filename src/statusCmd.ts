/**
 * `junco status` — one-glance daemon + queue view. Reads GET /health when the
 * daemon is up; falls back to lockfile liveness + queue-dir counts when not.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { TERMINAL_DONE_STATUSES } from "./types.js";
import { queuePaths } from "./config.js";
import { readLockHolder } from "./lock.js";
import { outboxDepth, deadCount } from "./githubOutbox.js";
import { pendingCount } from "./assessReview.js";
import { draftCount } from "./commentReview.js";
import { listHistory } from "./assessHistory.js";
import { checkForUpdate, type UpdateInfo } from "./updateCheck.js";
import { readTaskHistory } from "./taskHistory.js";

export interface StatusDeps {
  fetchFn?: typeof fetch;
  printFn?: (s: string) => void;
  lockHolderFn?: (lockPath: string) => number | null;
  /** Lock path (the CLI passes dirname(configPath)/worker.lock, mirroring `start`). */
  lockPath?: string;
  timeoutMs?: number;
  checkUpdateFn?: (cfg: Config) => Promise<UpdateInfo | null>;
  /** Task-history ledger reader for the `stats:` line (Task 3's readTaskHistory). */
  readTaskHistoryFn?: typeof readTaskHistory;
  nowFn?: () => Date;
  /** Stat seam for the `stats:` line's dir-mtime fallback + oldest-wait calc. */
  statFn?: (p: string) => { mtimeMs: number };
}

export function fmtUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Bracket an IPv6 literal for use in a URL authority (`::1` → `[::1]`); pass others through. */
function bracketHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function countMd(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** mtimes (ms) of the .md files in a dir; unreadable dir/file → skipped.
 * Mirrors src/tui/queueStats.ts's mdMtimes — duplicated rather than imported:
 * statusCmd is CLI-side and must not import from src/tui/. */
function mdMtimes(dir: string, statFn: (p: string) => { mtimeMs: number }): number[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .flatMap((n) => {
        try {
          return [statFn(join(dir, n)).mtimeMs];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function runStatusCommand(cfg: Config, deps: StatusDeps = {}): Promise<number> {
  const fetchFn = deps.fetchFn ?? fetch;
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const lockHolderFn = deps.lockHolderFn ?? readLockHolder;
  const paths = queuePaths(cfg);

  let daemonLine: string;
  let detailLines: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 1500);
  try {
    const resp = await fetchFn(`http://${bracketHost(cfg.healthHost)}:${cfg.healthPort}/health`, {
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json()) as {
      ready: boolean;
      gate?: { state: string; reason: string | null } | null;
      metrics: Record<string, unknown> & {
        currentTickets?: string[];
        currentTicket?: string | null;
        pendingRestartFields?: string[];
      };
    };
    const m = body.metrics;
    daemonLine = `running (pid ${m.pid}, up ${fmtUptime(Number(m.uptimeSeconds ?? 0))})`;
    const current = (m.currentTickets ?? (m.currentTicket ? [m.currentTicket] : [])) as string[];
    detailLines = [
      `endpoint:  ${body.ready ? "ready" : "UNREACHABLE"}`,
      `current:   ${current.length > 0 ? current.join(", ") : "idle"}`,
      `processed: ${m.tasksProcessed} (${m.tasksSucceeded} ok / ${m.tasksFailed} failed) · tokens in=${m.totalTokensIn} out=${m.totalTokensOut}`,
      `last task: ${m.lastTaskStatus ?? "—"}${m.lastTaskAt ? ` @ ${m.lastTaskAt}` : ""}`,
    ];
    // Gate line — the daemon's provider-gate state (rate limits, cost cap, …);
    // silent when healthy, same "only when non-ok" rule QueueView uses (#T9).
    if (body.gate != null && body.gate.state !== "ok") {
      detailLines.push(
        `gate:      ${body.gate.state}${body.gate.reason ? ` — ${body.gate.reason}` : ""}`,
      );
    }
    // GitHub bridge line — only when it has actually done (or failed) something.
    if (Number(m.bridgeSweeps ?? 0) > 0 || Number(m.bridgeErrors ?? 0) > 0) {
      detailLines.push(
        `bridge:    ${m.bridgeSweeps} sweeps · ${m.ticketsBridged} bridged · ${m.bridgeErrors} errors`,
      );
    }
    // Guard/requeue line (#37) — daemon interventions; shown only when any fired.
    const nudges = Number(m.guardNudges ?? 0);
    const kills = Number(m.guardKills ?? 0);
    const requeues = Number(m.requeues ?? 0);
    if (nudges + kills + requeues > 0) {
      detailLines.push(`guards:    ${nudges} nudges · ${kills} kills · ${requeues} requeues`);
    }
    // Hot-reload restart-warn: config levers changed live but not yet applied.
    const pendingRestartFields = m.pendingRestartFields ?? [];
    if (pendingRestartFields.length > 0) {
      detailLines.push(`⚠ config changed — restart to apply: ${pendingRestartFields.join(", ")}`);
    }
  } catch {
    const holder = deps.lockPath ? lockHolderFn(deps.lockPath) : null;
    daemonLine = holder
      ? `not responding (lock held by pid ${holder} but /health unreachable)`
      : "not running";
  } finally {
    clearTimeout(timer);
  }

  print(`daemon:    ${daemonLine}\n`);
  for (const l of detailLines) print(l + "\n");
  print(
    `queue:     inbox ${countMd(paths.inbox)} · processing ${countMd(paths.processing)} · done ${countMd(paths.done)} · failed ${countMd(paths.failed)}\n`,
  );

  // Stats line: 24h done/failed + avg duration from the task-history ledger
  // (Task 3); fresh-install fallback to done/failed dir mtimes when the ledger
  // has no records yet in the window (mirrors queueStats.ts's mdMtimes
  // fallback, duplicated locally per the CLI→tui import boundary above).
  // Oldest wait is always computed straight off inbox mtimes, independent of
  // the ledger. The whole line is silent unless something is non-empty.
  {
    const nowFn = deps.nowFn ?? ((): Date => new Date());
    const statFn = deps.statFn ?? statSync;
    const readTaskHistoryFn = deps.readTaskHistoryFn ?? readTaskHistory;
    const now = nowFn();
    const since24Ms = now.getTime() - 86_400_000;
    const recs = readTaskHistoryFn(cfg, { since: new Date(since24Ms) });
    let doneN: number;
    let failedN: number;
    let avgSeconds: number | null;
    if (recs.length > 0) {
      doneN = recs.filter((r) => TERMINAL_DONE_STATUSES.has(r.status)).length;
      failedN = recs.length - doneN;
      avgSeconds = Math.round(recs.reduce((a, r) => a + r.durationSeconds, 0) / recs.length);
    } else {
      doneN = mdMtimes(paths.done, statFn).filter((t) => t >= since24Ms).length;
      failedN = mdMtimes(paths.failed, statFn).filter((t) => t >= since24Ms).length;
      avgSeconds = null;
    }
    // Deliberately includes deferred tickets — this is a stat-only mtime scan
    // of every .md in inbox/, no frontmatter parse — unlike the TUI's
    // eligible-only oldestQueuedAt (queueFmt.ts), which skips deferred rows.
    const inboxMtimes = mdMtimes(paths.inbox, statFn);
    const oldestWaitSeconds =
      inboxMtimes.length > 0 ? (now.getTime() - Math.min(...inboxMtimes)) / 1000 : null;

    if (doneN + failedN > 0 || oldestWaitSeconds !== null) {
      let line = `stats:     24h ${doneN} ok / ${failedN} failed`;
      if (avgSeconds !== null) line += ` · avg ${fmtUptime(avgSeconds)}`;
      if (oldestWaitSeconds !== null) line += ` · oldest wait ${fmtUptime(oldestWaitSeconds)}`;
      print(line + "\n");
    }
  }

  const obxQueued = outboxDepth(cfg);
  const obxDead = deadCount(cfg);
  if (obxQueued + obxDead > 0) {
    print(`outbox:    ${obxQueued} queued · ${obxDead} dead\n`);
  }
  const reviews = pendingCount(cfg);
  if (reviews > 0) {
    print(`assess review: ${reviews} pending (junco assess review)\n`);
  }
  // Per-repo assess history (#193): age + outcome for every repo ever audited.
  // Silent when nothing has been assessed — same "only when non-empty" rule as
  // the review backlog above.
  for (const h of listHistory(cfg)) {
    const when = h.lastSuccessAt ? `assessed ${h.lastSuccessAt.slice(0, 10)}` : "never assessed";
    const counts =
      h.lastSuccessAt !== null ? ` · ${h.lastFound ?? 0} found · ${h.lastParked ?? 0} parked` : "";
    const failed = h.lastFailureAt ? ` · last attempt failed ${h.lastFailureAt.slice(0, 10)}` : "";
    print(`assess:    ${h.id} ${when}${counts}${failed}\n`);
  }
  const drafts = draftCount(cfg);
  if (drafts > 0) {
    print(`analyze review: ${drafts} pending (junco analyze review)\n`);
  }
  // npm update nudge (spec 2026-07-16) — best-effort; silent unless newer.
  const update = await (deps.checkUpdateFn ?? ((c: Config) => checkForUpdate(c)))(cfg);
  if (update !== null && update.available) {
    print(`update:    v${update.latest} available (run: junco update)\n`);
  }
  return 0;
}
