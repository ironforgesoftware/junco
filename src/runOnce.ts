import { readFileSync } from "node:fs";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { discoverTasks, claim } from "./queue.js";
import { parseTicket } from "./ticket.js";
import { runAgent, makePiSessionFactory, type AgentSessionLike } from "./agent/session.js";
import { finalize } from "./finalize.js";
import { log, withTicket } from "./logging.js";

const PRIORITY_RANK: Record<string, number> = { high: 2, normal: 1, low: 0 };

// A Q&A ticket has no worktree and shouldn't mutate the filesystem; give its
// session a read-only tool subset so a stray write/bash/edit can't corrupt the
// claimed ticket sitting in processing/ (PR-flow tickets in a worktree get the
// full set in a later milestone).
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface RunDeps {
  // Injection seam: returns a session factory for (cfg, cwd). Defaults to the real Pi SDK.
  sessionFactoryFor?: (cfg: Config, cwd: string) => () => Promise<AgentSessionLike>;
}

export async function runOnce(cfg: Config, deps: RunDeps = {}): Promise<boolean> {
  const paths = queuePaths(cfg);
  const candidates = discoverTasks(paths.inbox);
  if (candidates.length === 0) return false;

  // Parse defensively per-ticket: a single unreadable/vanished file (the inbox
  // can change between discover and read) must not throw the whole batch — that
  // would wedge the daemon loop on one bad file. Skip + log, keep the rest.
  const parsed = candidates
    .flatMap((p) => {
      try {
        return [parseTicket(p, readFileSync(p, "utf8"), cfg.defaultTimeoutMinutes)];
      } catch (e) {
        log.warn("skipping unreadable ticket", { path: p, error: e instanceof Error ? e.message : String(e) });
        return [];
      }
    })
    .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
  if (parsed.length === 0) return false;

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
    const cwd = paths.processing; // Q&A has no worktree; cwd hosts only read-only tools
    const qaCfg: Config = { ...cfg, tools: cfg.tools.filter((t) => READ_ONLY_TOOLS.has(t)) };
    // NOTE: if the factory throws (e.g. model unresolved), this rejects and the
    // claimed ticket is left in processing/ — orphan recovery lands in M4.
    const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(qaCfg, cwd);
    const result = await runAgent({ body: next.body, cwd, timeoutMs: next.timeoutSeconds * 1000, createSession: factory });
    const dst = finalize(claimed, result, { done: paths.done, failed: paths.failed });
    log.info("finalized", { dst, status: result.timedOut ? "timeout" : result.errorMessage ? "failed" : "completed" });
    return true;
  });
}
