/**
 * `junco unwatch <nwo>` — plan/execute deletion of a repo's junco-owned
 * operational state when it leaves the watchlist. Spec:
 * docs/superpowers/specs/2026-08-19-unwatch-cleanup-design.md. Audit state
 * (done/failed, transcripts, history shards, outbox dead/, review archives)
 * is deliberately out of scope — see the spec's non-goals.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";
import { readWatchlist, watchlistPath, type WatchlistEntry } from "./watchlist.js";
import { parseTicket } from "./ticket.js";
import { repoDiscriminator } from "./worktree.js";
import type { PidfileLock } from "./pidfileLock.js";
import { listOps } from "./githubOutbox.js";
import { listPending } from "./assessReview.js";
import { listDrafts } from "./commentReview.js";
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
  if (!entry) return { ok: true, plan: residuePlan(cfg, nwo, deps) }; // Task 4
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

// Task 4 replaces this stub with the real residue enumeration.
function residuePlan(_cfg: Config, nwo: string, _deps: UnwatchDeps): UnwatchPlan {
  return { nwo, mode: "residue", external: false, clone: null, items: [], kept: [], blocked: null };
}
