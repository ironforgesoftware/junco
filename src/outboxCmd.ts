/**
 * `junco outbox [flush]` — operator visibility + manual push for the offline
 * GitHub outbox (src/githubOutbox.ts). No args: list what's parked. `flush`:
 * replay it now instead of waiting for the daemon's throttled sweep.
 */

import type { Config } from "./types.js";
import {
  listOps,
  deadCount,
  flushOutbox,
  type FlushDeps,
  type FlushResult,
  type OutboxOp,
  type StoredOp,
} from "./githubOutbox.js";
import { fmtAge } from "./tui/queueFmt.js";

export interface OutboxCmdDeps extends FlushDeps {
  printFn?: (s: string) => void;
}

/** `push`/`pr` ops carry a branch; `labels`/`comment` ops always have an
 * issueKey instead (nwo+issue are required fields on those kinds). */
function branchOf(op: OutboxOp): string | null {
  return "branch" in op ? op.branch : null;
}

/** A hand-edited or version-skewed op file can have `op` missing entirely, or
 * present but not an object (JSON.parse succeeds — `readCache`-style shape
 * validation is what stands between that and a crash on `"branch" in op`). */
function isOutboxOp(op: unknown): op is OutboxOp {
  return typeof op === "object" && op !== null && "kind" in op;
}

/** issue-create ops have no live issue yet (nothing to key by) and no
 * branch, so the generic issueKey/branch fallback would print "?" — show
 * `<nwo> <fingerprint>` instead, the readable target for an op that's still
 * store-and-forward. */
function targetOf(op: OutboxOp, issueKey: string | null): string {
  if (op.kind === "issue-create") return `${op.nwo} ${op.fingerprint}`;
  return issueKey ?? branchOf(op) ?? "?";
}

function opLine(s: StoredOp, now: Date): string {
  const err = s.lastError ? ` lastError=${s.lastError}` : "";
  const target = isOutboxOp(s.op) ? `${s.op.kind} ${targetOf(s.op, s.issueKey)}` : "<malformed>";
  return `${fmtAge(s.createdAt, now)} ${target} attempts=${s.attempts}${err}\n`;
}

export async function runOutboxCommand(
  cfg: Config,
  args: string[],
  deps: OutboxCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));

  if (args[0] === "flush") {
    let result: FlushResult;
    try {
      result = await flushOutbox(cfg, deps);
    } catch (e) {
      // flushOutbox is designed to contain its own failures (mirroring the
      // daemon sweep's guard in githubInbox.pollGithubInbox); if it ever does
      // throw, the operator gets one clean line — not a raw fatal log.
      print(`outbox flush failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    if (result.skipped) {
      // Another live flusher (usually the daemon sweep) holds the flush lock —
      // an expected condition, not a failure; its holder will drain the queue.
      print(`another flush is already in progress — skipped\n`);
      return 0;
    }
    print(`sent ${result.sent} · dead ${result.dead} · remaining ${result.remaining}\n`);
    if (result.offline) print(`offline — will retry when GitHub is reachable\n`);
    return result.dead > 0 ? 1 : 0;
  }

  const now = (deps.nowFn ?? (() => new Date()))();
  const ops = listOps(cfg, deps);
  const dead = deadCount(cfg, deps);
  if (ops.length === 0) {
    print("outbox empty\n");
  } else {
    for (const s of ops) print(opLine(s, now));
  }
  if (dead > 0) print(`dead: ${dead}\n`);
  return 0;
}
