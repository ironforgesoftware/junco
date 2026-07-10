/**
 * `junco status` — one-glance daemon + queue view. Reads GET /health when the
 * daemon is up; falls back to lockfile liveness + queue-dir counts when not.
 */

import { readdirSync } from "node:fs";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { readLockHolder } from "./lock.js";
import { outboxDepth, deadCount } from "./githubOutbox.js";
import { pendingCount } from "./assessReview.js";
import { draftCount } from "./commentReview.js";

export interface StatusDeps {
  fetchFn?: typeof fetch;
  printFn?: (s: string) => void;
  lockHolderFn?: (lockPath: string) => number | null;
  /** Lock path (the CLI passes dirname(configPath)/worker.lock, mirroring `start`). */
  lockPath?: string;
  timeoutMs?: number;
}

export function fmtUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function countMd(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
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
    const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, {
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json()) as {
      ready: boolean;
      metrics: Record<string, unknown> & {
        currentTickets?: string[];
        currentTicket?: string | null;
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
  const obxQueued = outboxDepth(cfg);
  const obxDead = deadCount(cfg);
  if (obxQueued + obxDead > 0) {
    print(`outbox:    ${obxQueued} queued · ${obxDead} dead\n`);
  }
  const reviews = pendingCount(cfg);
  if (reviews > 0) {
    print(`assess review: ${reviews} pending (junco assess review)\n`);
  }
  const drafts = draftCount(cfg);
  if (drafts > 0) {
    print(`analyze review: ${drafts} pending (junco analyze review)\n`);
  }
  return 0;
}
