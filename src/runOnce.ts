import { readFileSync } from "node:fs";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { discoverTasks, claim } from "./queue.js";
import { parseTicket } from "./ticket.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { finalize } from "./finalize.js";
import { log, withTicket } from "./logging.js";

const PRIORITY_RANK: Record<string, number> = { high: 2, normal: 1, low: 0 };

export interface RunDeps {
  // Injection seam: returns a session factory for (cfg, cwd). Defaults to the real Pi SDK.
  sessionFactoryFor?: (cfg: Config, cwd: string) => () => Promise<AgentSessionLike>;
}

export async function runOnce(cfg: Config, deps: RunDeps = {}): Promise<boolean> {
  const paths = queuePaths(cfg);
  const candidates = discoverTasks(paths.inbox);
  if (candidates.length === 0) return false;

  const parsed = candidates
    .map((p) => parseTicket(p, readFileSync(p, "utf8"), cfg.defaultTimeoutMinutes))
    .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);

  const next = parsed[0];
  if (next.hasRepo) {
    log.info("skipping PR-flow ticket (M1 = Q&A only)", { id: next.id });
    return false;
  }

  const claimed = claim(next.path, paths.processing);
  if (!claimed) {
    log.info("source vanished before claim", { id: next.id });
    return false;
  }

  return withTicket(next.id, async (): Promise<boolean> => {
    log.info("claimed", { src: next.path, dst: claimed });
    const cwd = paths.processing; // Q&A has no worktree; cwd is incidental
    const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(cfg, cwd);
    const result = await runAgent({ body: next.body, cwd, timeoutMs: next.timeoutSeconds * 1000, createSession: factory });
    const dst = finalize(claimed, result, { done: paths.done, failed: paths.failed });
    log.info("finalized", { dst, status: result.timedOut ? "timeout" : result.errorMessage ? "failed" : "completed" });
    return true;
  });
}
