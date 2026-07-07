/**
 * GitHub outbox — durable store-and-forward for GitHub side effects when the
 * network is down. One JSON file per op under <state_dir>/github-outbox/
 * (atomic tmp+rename, watchlist pattern); filename <epoch-ms>-<seq>-<kind>
 * makes lexicographic order the FIFO (and per-issue) replay order. Poisoned
 * ops dead-letter into github-outbox/dead/ — same philosophy as failed/.
 */

import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config } from "./types.js";
import { log } from "./logging.js";

export type OutboxOp =
  | { kind: "labels"; nwo: string; issue: number; add: string[]; remove: string[] }
  | { kind: "comment"; nwo: string; issue: number; body: string }
  | { kind: "push"; repoPath: string; branch: string }
  | {
      kind: "pr";
      repoPath: string;
      branch: string;
      nwo: string;
      issue: number | null;
      base: string;
      title: string;
      bodyText: string;
      draft: boolean;
      labels: string[];
      reviewers: string[];
      finalize: { ticketId: string; status: string; finalText: string } | null;
      pushed: boolean;
      prUrl: string | null;
    };

export interface StoredOp {
  id: string; // filename stem
  path: string;
  createdAt: string; // ISO
  origin: "dashboard" | "reporter" | "prflow";
  issueKey: string | null; // "<nwo>#<n>"
  attempts: number;
  lastError: string | null;
  op: OutboxOp;
}

export interface OutboxDeps {
  readdirFn?: (d: string) => string[];
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (a: string, b: string) => void;
  mkdirFn?: (d: string) => void;
  rmFn?: (p: string) => void;
  nowFn?: () => Date;
}

let seq = 0; // same-ms tiebreaker; module-lifetime monotonic

export function outboxPaths(cfg: Config): { dir: string; dead: string } {
  const dir = join(cfg.stateDir, "github-outbox");
  return { dir, dead: join(dir, "dead") };
}

function issueKeyOf(op: OutboxOp): string | null {
  return "nwo" in op && "issue" in op && typeof op.issue === "number"
    ? `${op.nwo}#${op.issue}`
    : null;
}

export function enqueueOp(
  cfg: Config,
  origin: StoredOp["origin"],
  op: OutboxOp,
  deps: OutboxDeps = {},
): string {
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const { dir } = outboxPaths(cfg);
  mkdirFn(dir);
  const now = nowFn();
  const id = `${now.getTime()}-${String(seq++).padStart(4, "0")}-${op.kind}`;
  const stored: Omit<StoredOp, "path"> = {
    id,
    createdAt: now.toISOString(),
    origin,
    issueKey: issueKeyOf(op),
    attempts: 0,
    lastError: null,
    op,
  };
  const dst = join(dir, `${id}.json`);
  const tmp = `${dst}.tmp`;
  writeFileFn(tmp, JSON.stringify(stored, null, 2));
  renameFn(tmp, dst);
  return id;
}

export function listOps(cfg: Config, deps: OutboxDeps = {}): StoredOp[] {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const { dir } = outboxPaths(cfg);
  let names: string[];
  try {
    names = readdirFn(dir);
  } catch {
    return []; // no outbox yet
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .flatMap((n) => {
      const path = join(dir, n);
      try {
        const parsed = JSON.parse(readFileFn(path)) as Omit<StoredOp, "path">;
        return [{ ...parsed, id: basename(n, ".json"), path }];
      } catch (e) {
        log.warn("skipping unparseable outbox op", { path, error: String(e) });
        return [];
      }
    });
}

export function outboxDepth(cfg: Config, deps: OutboxDeps = {}): number {
  const readdirFn = deps.readdirFn ?? readdirSync;
  try {
    return readdirFn(outboxPaths(cfg).dir).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
