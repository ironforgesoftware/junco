/**
 * `junco unwatch <nwo>` — plan/execute deletion of a repo's junco-owned
 * operational state when it leaves the watchlist. Spec:
 * docs/superpowers/specs/2026-08-19-unwatch-cleanup-design.md. Audit state
 * (done/failed, transcripts, history shards, outbox dead/, review archives)
 * is deliberately out of scope — see the spec's non-goals.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";
import { readWatchlist, writeWatchlist, watchlistPath, type WatchlistEntry } from "./watchlist.js";
import { parseTicket } from "./ticket.js";
import { repoDiscriminator, worktreesLockPath } from "./worktree.js";
import { acquirePidfileLock, type PidfileLock } from "./pidfileLock.js";
import { git } from "./git.js";
import { listOps } from "./githubOutbox.js";
import { listPending, purgePending } from "./assessReview.js";
import { listDrafts, removeDraft } from "./commentReview.js";
import { historyFilePath } from "./assessHistory.js";
import { slugifyId } from "./slug.js";

export type UnwatchRefusal = "config-defined" | "watchlist-unreadable";

export type PlanItemKind =
  | "clone"
  | "inbox-ticket"
  | "worktrees"
  | "outbox-op"
  | "assess-review"
  | "comment-review"
  | "assess-history"
  | "mirror"
  | "github-cache";

export interface PlanItem {
  kind: PlanItemKind;
  path: string; // absolute path affected
  detail?: string; // ticket id, op issueKey/kind, review id …
}

export interface UnwatchPlan {
  nwo: string; // watchlist casing when watched; input casing in residue mode
  mode: "watched" | "residue";
  external: boolean; // fork-PR entry (always false in residue mode)
  clone: { path: string; managed: boolean } | null; // managed:false ⇒ kept
  items: PlanItem[]; // everything that WILL be deleted
  kept: string[]; // human lines, e.g. "clone (user-owned): /home/me/api"
  blocked: { ticketId: string } | null;
}

export type PlanOutcome = { ok: false; reason: UnwatchRefusal } | { ok: true; plan: UnwatchPlan };

export interface SummaryRow {
  kind: PlanItemKind | "watchlist-entry";
  path: string;
  outcome: "deleted" | "kept" | "failed";
  detail?: string;
  reason?: string; // failure reason
}

export interface UnwatchResult {
  ok: boolean; // false when refused, blocked, or any row failed
  refused: UnwatchRefusal | "blocked" | null;
  blockedTicketId: string | null;
  watchlistRemoved: boolean;
  summary: SummaryRow[];
}

export interface UnwatchDeps {
  readdirFn?: (d: string) => string[];
  readFileFn?: (p: string) => string;
  existsFn?: (p: string) => boolean;
  /** Single-file removal (tickets, outbox ops, cache files, history file). Default fs.unlinkSync. */
  unlinkFn?: (p: string) => void;
  /** Recursive removal (worktree namespace, managed clone). Default rmSync(p, {recursive:true, force:true}). */
  rmFn?: (p: string) => void;
  /** Review-store archive pass-through. Defaults inside reviewStore. */
  renameFn?: (a: string, b: string) => void;
  mkdirFn?: (d: string) => void;
  /** Non-throwing git runner, worktreePruneCmd shape. Default: git(cfg, args, {cwd, check:false}). */
  gitFn?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
  /** Default: () => acquirePidfileLock(worktreesLockPath(cfg)). */
  acquireLockFn?: () => PidfileLock | null;
}

export function canonPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function isUnder(child: string, root: string): boolean {
  const c = canonPath(child);
  const r = canonPath(root);
  return c !== r && c.startsWith(r + sep);
}

/** Managed ⇔ the path lives under a junco-owned clone root. */
function classifyClone(cfg: Config, path: string): { path: string; managed: boolean } {
  const p = dataTreePaths(cfg);
  const managed = isUnder(path, p.clonesWatched) || isUnder(path, p.clonesExternal);
  return { path, managed };
}

export function planUnwatch(cfg: Config, nwo: string, deps: UnwatchDeps = {}): PlanOutcome {
  const lower = nwo.toLowerCase();
  if (cfg.github.repos.some((r) => r.nwo.toLowerCase() === lower))
    return { ok: false, reason: "config-defined" };
  const { entries, error } = readWatchlist(watchlistPath(cfg));
  if (error) return { ok: false, reason: "watchlist-unreadable" };
  const entry = entries.find((e) => e.nwo.toLowerCase() === lower);
  if (!entry) return { ok: true, plan: residuePlan(cfg, nwo, deps) };
  return { ok: true, plan: watchedPlan(cfg, entry, deps) };
}

/** *.md tickets in `dir` whose frontmatter repo: resolves to `repoPath`. Unparsable → skipped. */
function ticketsTargeting(
  cfg: Config,
  dir: string,
  repoPath: string,
  deps: UnwatchDeps,
): { path: string; id: string }[] {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const target = canonPath(repoPath);
  let names: string[] = [];
  try {
    names = readdirFn(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return []; // no dir yet
  }
  const out: { path: string; id: string }[] = [];
  for (const n of names) {
    const p = join(dir, n);
    try {
      const t = parseTicket(p, readFileFn(p), cfg.defaultTimeoutMinutes);
      const repo = t.frontmatter["repo"];
      if (typeof repo === "string" && canonPath(repo) === target) out.push({ path: p, id: t.id });
    } catch {
      /* unparsable — cannot name this repo; skip */
    }
  }
  return out;
}

/** `<dataDir>/github-cache/{issues,prs}-<owner>__<repo>.json`. Mirrors
 * `tui/ghClient.ts`'s `cachePathFor`/`prCachePathFor` byte-for-byte (pinned by
 * tests/unwatchCmd.test.ts's drift-pin test) — duplicated here rather than
 * imported so `src/unwatchCmd.ts` (the CLI graph) never pulls in the heavy
 * `tui/ghClient.ts` module. */
export function githubCacheFilesFor(cfg: Config, nwo: string): string[] {
  const dir = dataTreePaths(cfg).githubCache;
  const key = nwo.replace(/\//g, "__");
  return [join(dir, `issues-${key}.json`), join(dir, `prs-${key}.json`)];
}

/** The shared nwo-keyed enumerator both watched and residue plans call:
 * outbox ops (by nwo, or by push's repoPath when the op carries no nwo),
 * pending assess/comment reviews, the assess-history file, the mirror dir,
 * and the github-cache files. `repoPathOrNull` is null in residue mode
 * (nothing on disk to match a push op's repoPath against). */
function nwoKeyedItems(
  cfg: Config,
  nwo: string,
  repoPathOrNull: string | null,
  deps: UnwatchDeps,
): PlanItem[] {
  const existsFn = deps.existsFn ?? existsSync;
  const lower = nwo.toLowerCase();
  const canonRepo = repoPathOrNull === null ? null : canonPath(repoPathOrNull);
  const p = dataTreePaths(cfg);
  const items: PlanItem[] = [];
  for (const sop of listOps(cfg, deps)) {
    const matchNwo = "nwo" in sop.op && sop.op.nwo.toLowerCase() === lower;
    const matchPath =
      canonRepo !== null && "repoPath" in sop.op && canonPath(sop.op.repoPath) === canonRepo;
    if (matchNwo || matchPath)
      items.push({ kind: "outbox-op", path: sop.path, detail: sop.issueKey ?? sop.op.kind });
  }
  for (const b of listPending(cfg, deps))
    if (b.nwo.toLowerCase() === lower)
      items.push({
        kind: "assess-review",
        path: join(p.reviewAssess, `${slugifyId(b.id)}.json`),
        detail: b.id,
      });
  for (const d of listDrafts(cfg, deps))
    if (d.nwo.toLowerCase() === lower)
      items.push({
        kind: "comment-review",
        path: join(p.reviewComments, `${slugifyId(d.id)}.json`),
        detail: d.id,
      });
  const hist = historyFilePath(cfg, nwo);
  if (existsFn(hist)) items.push({ kind: "assess-history", path: hist });
  const [owner, repo] = nwo.split("/");
  const mirror = join(p.mirror, owner ?? nwo, repo ?? "repo");
  if (existsFn(mirror)) items.push({ kind: "mirror", path: mirror });
  for (const f of githubCacheFilesFor(cfg, nwo))
    if (existsFn(f)) items.push({ kind: "github-cache", path: f });
  return items;
}

function watchedPlan(cfg: Config, entry: WatchlistEntry, deps: UnwatchDeps): UnwatchPlan {
  const clone = classifyClone(cfg, entry.path);
  const items: PlanItem[] = [];
  const kept: string[] = [];
  if (clone.managed) items.push({ kind: "clone", path: clone.path });
  else kept.push(`clone (user-owned): ${clone.path}`);
  const q = dataTreePaths(cfg).queue;
  for (const t of ticketsTargeting(cfg, q.inbox, entry.path, deps))
    items.push({ kind: "inbox-ticket", path: t.path, detail: t.id });
  const ns = join(cfg.worktreeRoot, repoDiscriminator(entry.path));
  if ((deps.existsFn ?? existsSync)(ns)) items.push({ kind: "worktrees", path: ns });
  const live = ticketsTargeting(cfg, q.processing, entry.path, deps);
  const blocked = live.length > 0 ? { ticketId: live[0].id } : null;
  items.push(...nwoKeyedItems(cfg, entry.nwo, entry.path, deps));
  return {
    nwo: entry.nwo,
    mode: "watched",
    external: entry.external === true,
    clone,
    items,
    kept,
    blocked,
  };
}

/** nwo not in the watchlist — idempotent re-run sweep. Probes the two
 * managed-clone roots for a leftover `<owner>/<repo>` clone (first that
 * exists on disk wins); when found it contributes exactly what
 * `watchedPlan`'s managed-clone arm would, keyed off the probed path rather
 * than a watchlist entry. Always appends `nwoKeyedItems`. */
function residuePlan(cfg: Config, nwo: string, deps: UnwatchDeps): UnwatchPlan {
  const existsFn = deps.existsFn ?? existsSync;
  const p = dataTreePaths(cfg);
  const [owner, repo] = nwo.split("/");
  const clonePath =
    [p.clonesWatched, p.clonesExternal]
      .map((root) => join(root, owner ?? nwo, repo ?? "repo"))
      .find((candidate) => existsFn(candidate)) ?? null;
  const items: PlanItem[] = [];
  let blocked: { ticketId: string } | null = null;
  if (clonePath !== null) {
    items.push({ kind: "clone", path: clonePath });
    const q = p.queue;
    for (const t of ticketsTargeting(cfg, q.inbox, clonePath, deps))
      items.push({ kind: "inbox-ticket", path: t.path, detail: t.id });
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clonePath));
    if (existsFn(ns)) items.push({ kind: "worktrees", path: ns });
    const live = ticketsTargeting(cfg, q.processing, clonePath, deps);
    blocked = live.length > 0 ? { ticketId: live[0].id } : null;
  }
  items.push(...nwoKeyedItems(cfg, nwo, clonePath, deps));
  return {
    nwo,
    mode: "residue",
    external: false,
    clone: clonePath !== null ? { path: clonePath, managed: true } : null,
    items,
    kept: [],
    blocked,
  };
}

/**
 * Execute a fresh `planUnwatch` plan with per-item failure isolation: every
 * deletion is attempted independently, a thrown error demotes that row to
 * "failed" without aborting the rest, and `ok` is true only when every row
 * succeeded. Re-planning here (rather than trusting a caller-supplied plan)
 * closes the confirm→execute race — the CLI shows a plan, the user confirms,
 * and only then does this re-read the world and act on what it actually
 * finds. Deletion order matters: watchlist entry first (so the bridge's next
 * poll sweep stops touching this repo) through to the managed clone last
 * (largest, and the one thing a crash mid-run can leave for a re-run to
 * finish — see the "clone" comment below).
 */
export async function runUnwatch(
  cfg: Config,
  nwo: string,
  deps: UnwatchDeps = {},
): Promise<UnwatchResult> {
  const unlinkFn = deps.unlinkFn ?? unlinkSync;
  const rmFn = deps.rmFn ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const gitFn =
    deps.gitFn ??
    (async (a: string[], cwd: string) => {
      const r = await git(cfg, a, { cwd, check: false });
      return { code: r.code, stdout: r.stdout };
    });
  const acquireLockFn = deps.acquireLockFn ?? (() => acquirePidfileLock(worktreesLockPath(cfg)));

  const outcome = planUnwatch(cfg, nwo, deps); // fresh plan closes the confirm→execute race
  if (!outcome.ok)
    return {
      ok: false,
      refused: outcome.reason,
      blockedTicketId: null,
      watchlistRemoved: false,
      summary: [],
    };
  const plan = outcome.plan;
  if (plan.blocked)
    return {
      ok: false,
      refused: "blocked",
      blockedTicketId: plan.blocked.ticketId,
      watchlistRemoved: false,
      summary: [],
    };

  const summary: SummaryRow[] = [];
  const attempt = (row: Omit<SummaryRow, "outcome">, fn: () => void): void => {
    try {
      fn();
      summary.push({ ...row, outcome: "deleted" });
    } catch (e) {
      summary.push({
        ...row,
        outcome: "failed",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const byKind = (k: PlanItemKind): PlanItem[] => plan.items.filter((i) => i.kind === k);

  // 1. Watchlist entry first — the bridge's next sweep stops polling.
  let watchlistRemoved = false;
  if (plan.mode === "watched") {
    const file = watchlistPath(cfg);
    attempt({ kind: "watchlist-entry", path: file }, () => {
      const { entries, error } = readWatchlist(file);
      if (error) throw new Error(error); // went corrupt since the plan — leave it alone
      writeWatchlist(
        file,
        entries.filter((e) => e.nwo.toLowerCase() !== plan.nwo.toLowerCase()),
      );
      watchlistRemoved = true;
    });
  }
  // 2–4. Tickets, outbox ops, pending reviews.
  for (const i of byKind("inbox-ticket")) attempt(i, () => unlinkFn(i.path));
  for (const i of byKind("outbox-op")) attempt(i, () => unlinkFn(i.path));
  for (const i of byKind("assess-review"))
    attempt(i, () => void purgePending(cfg, i.detail as string, deps));
  for (const i of byKind("comment-review"))
    attempt(i, () => void removeDraft(cfg, i.detail as string, "discarded", deps));
  // 5. Worktree namespace under the advisory lock (one-directional courtesy —
  //    the blocker check above is the liveness guarantee, worktreePruneCmd.ts:104).
  for (const i of byKind("worktrees"))
    attempt(i, () => {
      const lock = acquireLockFn();
      if (lock === null) throw new Error("another worktree operation is in progress — try again");
      try {
        rmFn(i.path);
      } finally {
        lock.release();
      }
    });
  // 6. Kept user clone: clear junco's stale .git/worktrees registrations. Best-effort.
  if (plan.mode === "watched" && plan.clone !== null && !plan.clone.managed) {
    summary.push({ kind: "clone", path: plan.clone.path, outcome: "kept", detail: "user-owned" });
    await gitFn(["worktree", "prune"], plan.clone.path).catch(() => ({ code: 1, stdout: "" }));
  }
  // 7. History, mirror, cache.
  for (const i of byKind("assess-history")) attempt(i, () => unlinkFn(i.path));
  for (const i of byKind("mirror")) attempt(i, () => rmFn(i.path));
  for (const i of byKind("github-cache")) attempt(i, () => unlinkFn(i.path));
  // 8. Managed clone last (largest; a crash mid-run leaves the re-clonable part).
  for (const i of byKind("clone")) attempt(i, () => rmFn(i.path));

  return {
    ok: summary.every((s) => s.outcome !== "failed"),
    refused: null,
    blockedTicketId: null,
    watchlistRemoved,
    summary,
  };
}
