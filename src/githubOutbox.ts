/**
 * GitHub outbox — durable store-and-forward for GitHub side effects when the
 * network is down. One JSON file per op under <state_dir>/github-outbox/
 * (atomic tmp+rename, watchlist pattern); filename
 * <epoch-ms>-<seq>-<rand>-<kind> makes lexicographic order the FIFO (and
 * per-issue) replay order — the random suffix only guards against two
 * processes (daemon + dashboard) enqueueing in the same millisecond; it
 * doesn't affect ordering, since epoch-ms then seq already dominate the sort
 * within a single process. Poisoned ops dead-letter into github-outbox/dead/
 * — same philosophy as failed/.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { TERMINAL_DONE_STATUSES, type Config } from "./types.js";
import { log } from "./logging.js";
import { gh, git, GitOpError, isNetworkError } from "./git.js";
import { lifecycleLabels } from "./githubInbox.js";

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
  const rand = Math.random().toString(36).slice(2, 6);
  const id = `${now.getTime()}-${String(seq++).padStart(4, "0")}-${rand}-${op.kind}`;
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

// ---------------------------------------------------------------------------
// tryOrEnqueue — the seam every integration layer calls through: try the live
// GitHub call, and only fall back to the durable outbox when the failure is
// classified as offline (network-shaped GitOpError). Any other error is the
// caller's problem — it propagates unqueued.
// ---------------------------------------------------------------------------

export const OUTBOX_MARKER_PREFIX = "<!-- junco:outbox:";
export const MAX_OP_ATTEMPTS = 3;
const GH_TIMEOUT = 60_000;
const PUSH_TIMEOUT = 180_000; // mirrors pushBranch (src/pr.ts:111)

/** GitOpError whose stderr matches the network-failure patterns (src/git.ts
 * isNetworkError) — i.e. "GitHub is unreachable", not "GitHub said no". */
export function isOffline(e: unknown): boolean {
  return e instanceof GitOpError && isNetworkError(e.stderr);
}

/** GitOpError's `.message` is often a generic "<bin> <sub> failed (exit N)"
 * (see runCmd in git.ts) — the actionable reason lives in `.stderr`. Prefer
 * it wherever an error gets surfaced as a single string (dead-letter
 * `lastError`, a rethrown permanent failure) so it's actually diagnosable. */
function describeError(e: unknown): string {
  if (e instanceof GitOpError) return e.stderr || e.message;
  return e instanceof Error ? e.message : String(e);
}

export async function tryOrEnqueue(
  cfg: Config,
  origin: StoredOp["origin"],
  op: OutboxOp,
  live: () => Promise<void>,
): Promise<"sent" | "queued"> {
  try {
    await live();
    return "sent";
  } catch (e) {
    if (!isOffline(e)) {
      // Permanent failure: not ours to queue — rethrow (as a fresh object,
      // never mutating the caller's error) with the diagnosable message.
      throw e instanceof GitOpError ? new GitOpError(describeError(e), e.stderr, e.returncode) : e;
    }
    const id = enqueueOp(cfg, origin, op);
    log.info("github unreachable — queued to outbox", { id, kind: op.kind });
    return "queued";
  }
}

// ---------------------------------------------------------------------------
// flushOutbox — the replay executor. Runs queued ops in FIFO order; the
// first offline failure halts the whole flush (no point burning through the
// rest while the network is down) and everything from that point on is
// counted as `remaining` without being touched. Non-network failures are the
// op's fault: bump attempts/lastError and dead-letter at MAX_OP_ATTEMPTS.
// ---------------------------------------------------------------------------

export interface FlushDeps extends OutboxDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
}
export interface FlushResult {
  sent: number;
  dead: number;
  remaining: number;
  offline: boolean;
}

function marker(id: string): string {
  return `${OUTBOX_MARKER_PREFIX}${id} -->`;
}

/** Word-boundary excerpt for the flushed finalize comment (same policy as
 * githubReport.excerpt, kept local to avoid an import cycle). */
function cap(text: string, limit = 700): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  const slice = t.slice(0, limit);
  const atWord = slice.lastIndexOf(" ");
  return slice.slice(0, atWord > 0 ? atWord : limit).trimEnd() + " …";
}

/** `Opened <prUrl>` + capped finalize text + the outbox idempotency marker,
 * appended by the caller via postCommentIdempotent — mirrors the shape of
 * githubReport.buildFinalComment's PR branch, but buildFinalComment itself
 * takes a Ticket (not available here), so this is a local equivalent. */
function prFlushComment(finalize: { finalText: string }, prUrl: string): string {
  return `Opened ${prUrl}\n\n${cap(finalize.finalText)}`;
}

export async function flushOutbox(cfg: Config, deps: FlushDeps = {}): Promise<FlushResult> {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const rmFn = deps.rmFn ?? ((p: string) => rmSync(p, { force: true }));
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const { dead } = outboxPaths(cfg);
  const result: FlushResult = { sent: 0, dead: 0, remaining: 0, offline: false };
  const ops = listOps(cfg, deps);

  const rewrite = (s: StoredOp): void => {
    const { path, ...rest } = s;
    const tmp = `${path}.tmp`;
    writeFileFn(tmp, JSON.stringify(rest, null, 2));
    renameFn(tmp, path);
  };

  const postCommentIdempotent = async (
    nwo: string,
    issue: number,
    body: string,
    id: string,
  ): Promise<void> => {
    const existing = await ghFn(
      cfg,
      ["api", "--paginate", `repos/${nwo}/issues/${issue}/comments`, "--jq", ".[].body"],
      { timeoutMs: GH_TIMEOUT },
    );
    if (existing.stdout.includes(marker(id))) return; // crash-replay: already delivered
    const dir = mkdtempSync(join(tmpdir(), "junco-obxc-"));
    const file = join(dir, "comment.md");
    writeFileSync(file, `${body.trimEnd()}\n\n${marker(id)}\n`, "utf8");
    try {
      await ghFn(cfg, ["issue", "comment", String(issue), "--repo", nwo, "--body-file", file], {
        timeoutMs: GH_TIMEOUT,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const execute = async (s: StoredOp): Promise<void> => {
    const op = s.op;
    switch (op.kind) {
      case "labels": {
        if (op.add.length + op.remove.length === 0) return;
        const args = ["issue", "edit", String(op.issue), "--repo", op.nwo];
        for (const l of op.add) args.push("--add-label", l);
        for (const l of op.remove) args.push("--remove-label", l);
        await ghFn(cfg, args, { timeoutMs: GH_TIMEOUT });
        return;
      }
      case "comment":
        await postCommentIdempotent(op.nwo, op.issue, op.body, s.id);
        return;
      case "push":
        await gitFn(cfg, ["-C", op.repoPath, "push", "--set-upstream", "origin", op.branch], {
          timeoutMs: PUSH_TIMEOUT,
        });
        return;
      case "pr": {
        if (!op.pushed) {
          await gitFn(cfg, ["-C", op.repoPath, "push", "--set-upstream", "origin", op.branch], {
            timeoutMs: PUSH_TIMEOUT,
          });
          op.pushed = true;
          rewrite(s);
        }
        if (op.prUrl === null) {
          const dir = mkdtempSync(join(tmpdir(), "junco-obxb-"));
          const bodyFile = join(dir, "body.md");
          writeFileSync(bodyFile, op.bodyText, "utf8");
          try {
            const argv = [
              "pr",
              "create",
              "--repo",
              op.nwo,
              "--base",
              op.base,
              "--head",
              op.branch,
              "--title",
              op.title,
              "--body-file",
              bodyFile,
            ];
            if (op.draft) argv.push("--draft");
            for (const l of op.labels) argv.push("--label", l);
            for (const r of op.reviewers) argv.push("--reviewer", r);
            const out = await ghFn(cfg, argv, { timeoutMs: GH_TIMEOUT });
            const url = out.stdout
              .trim()
              .split("\n")
              .reverse()
              .find((l: string) => l.startsWith("https://"));
            if (!url) throw new GitOpError("gh pr create returned no URL", out.stderr, 1);
            op.prUrl = url;
          } catch (e) {
            if (e instanceof GitOpError && /already exists/i.test(e.stderr)) {
              const v = await ghFn(
                cfg,
                ["pr", "view", op.branch, "--repo", op.nwo, "--json", "url", "--jq", ".url"],
                { timeoutMs: GH_TIMEOUT },
              );
              op.prUrl = v.stdout.trim();
            } else {
              throw e;
            }
          } finally {
            rmSync(dirname(bodyFile), { recursive: true, force: true });
          }
          rewrite(s);
        }
        if (op.finalize !== null && op.issue !== null) {
          const body = prFlushComment(op.finalize, op.prUrl!);
          await postCommentIdempotent(op.nwo, op.issue, body, s.id);
          const ll = lifecycleLabels(cfg.github.triggerLabel);
          const doneLabel = TERMINAL_DONE_STATUSES.has(op.finalize.status) ? ll.done : ll.failed;
          await ghFn(
            cfg,
            [
              "issue",
              "edit",
              String(op.issue),
              "--repo",
              op.nwo,
              "--add-label",
              doneLabel,
              "--remove-label",
              ll.working,
            ],
            { timeoutMs: GH_TIMEOUT },
          );
        }
        return;
      }
    }
  };

  for (let i = 0; i < ops.length; i++) {
    const s = ops[i];
    if (result.offline) {
      result.remaining++;
      continue;
    }
    try {
      await execute(s);
      rmFn(s.path);
      result.sent++;
    } catch (e) {
      if (isOffline(e)) {
        result.offline = true;
        result.remaining++;
        continue;
      }
      s.attempts += 1;
      s.lastError = describeError(e);
      if (s.attempts >= MAX_OP_ATTEMPTS) {
        mkdirFn(dead);
        renameFn(s.path, join(dead, basename(s.path)));
        result.dead++;
        log.warn("outbox op dead-lettered", { id: s.id, error: s.lastError });
      } else {
        rewrite(s);
        result.remaining++;
      }
    }
  }
  return result;
}
