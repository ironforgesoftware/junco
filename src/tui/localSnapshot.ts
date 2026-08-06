/**
 * Local runtime snapshot for the dashboard LOCAL mode: the repos/clones/forks
 * junco knows about (and where they live on disk), the per-ticket worktrees,
 * the GitHub outbox op-log, and daemon/health detail. Split cheap vs heavy so
 * the 2s GitHub-path QueueSnapshot never pays for per-repo/per-worktree git.
 *
 * Every enumerator git call passes `--no-optional-locks` (lock-free observation
 * of a live daemon-owned base repo) and goes through the injectable `gitFn`
 * seam. Never-throws: a top-level try/catch sets `error`; per-item `error`
 * fields carry individual failures (posture of makeQueueSnapshotFn).
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../types.js";
import { git } from "../git.js";
import { readWatchlist, watchlistPath } from "../watchlist.js";
import { nwoFromRemoteUrl } from "../githubInbox.js";
import { repoDiscriminator } from "../worktree.js";
import { endpointReachable, makeCachedProbe } from "../health.js";
import { queuePaths } from "../config.js";
import { makeQueueSnapshotFn, type QueueSnapshot } from "./queueSnapshot.js";
import { listOpsFrom, outboxPaths, type StoredOp } from "../githubOutbox.js";
import { dataTreePaths } from "../dataTree.js";
import { fetchHealthBody, type HealthBody } from "./healthBody.js";

export { fetchHealthBody, type HealthBody } from "./healthBody.js";

export interface LocalSnapshotDeps {
  readdirFn?: (dir: string) => string[];
  readFileFn?: (p: string) => string;
  statFn?: (p: string) => { mtimeMs: number };
  fetchFn?: typeof fetch;
  nowFn?: () => Date;
  gitFn?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
  /** buildDaemonDetail's endpoint-reachability probe. Absent → a direct
   * uncached `endpointReachable(cfg, { fetchFn })` per call (fresh per-call
   * semantics for tests); makeLocalCheapFn injects its per-factory
   * makeCachedProbe wrapper here so dashboard polling shares one cache. */
  reachableFn?: () => Promise<boolean>;
}

type GitFn = NonNullable<LocalSnapshotDeps["gitFn"]>;

export interface LocalRepo {
  nwo: string | null;
  path: string;
  source: "config" | "watchlist" | "external" | "clone";
  originUrl: string | null;
  forkUrl: string | null;
  githubUrl: string | null;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  error: string | null;
}

export interface RepoCandidate {
  path: string;
  source: LocalRepo["source"];
  nwoHint: string | null;
}

const REPO_POOL = 4;

/** Default gitFn: cwd-scoped, check:false (a non-zero exit is data, not a
 * throw — the caller reads `code`). */
function defaultGitFn(cfg: Config): GitFn {
  return async (args, cwd) => {
    const r = await git(cfg, args, { cwd, check: false });
    return { code: r.code, stdout: r.stdout };
  };
}

/** Bounded-concurrency map: at most `limit` `fn` calls in flight. Order of
 * `results` matches `items`. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 0 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One-level-of-owner walk: `<root>/<owner>/<name>` — matches both
 * externalClonePath (externalRepo.ts) and the dashboard clone target
 * (App.tsx clonesDir join owner/repo). Missing/undreadable dir → []. */
function walkOwnerName(
  root: string,
  source: LocalRepo["source"],
  readdirFn: (d: string) => string[],
): RepoCandidate[] {
  const out: RepoCandidate[] = [];
  let owners: string[];
  try {
    owners = readdirFn(root);
  } catch {
    return out;
  }
  for (const owner of owners) {
    const ownerPath = join(root, owner);
    let names: string[];
    try {
      names = readdirFn(ownerPath);
    } catch {
      continue;
    }
    for (const name of names) {
      out.push({ path: join(ownerPath, name), source, nwoHint: `${owner}/${name}` });
    }
  }
  return out;
}

/**
 * Union of the repos junco knows about, deduped by resolve(path) (first source
 * wins): (1) cfg.github.repos; (2) the RAW watchlist — readWatchlist, NOT
 * resolveWatchedRepos, so external:true forks survive (watchlist.ts:92);
 * (3) externalReposRoot walk; (4) <dataDir>/repos walk. Pure fs (no git), so
 * enumerateWorktrees can reuse it for the discriminator reverse-map.
 */
export function collectRepoCandidates(cfg: Config, deps: LocalSnapshotDeps = {}): RepoCandidate[] {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const out: RepoCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: RepoCandidate): void => {
    const key = resolve(c.path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const r of cfg.github.repos) add({ path: r.path, source: "config", nwoHint: r.nwo });
  for (const e of readWatchlist(watchlistPath(cfg)).entries) {
    add({ path: e.path, source: "watchlist", nwoHint: e.nwo });
  }
  for (const c of walkOwnerName(cfg.github.externalReposRoot, "external", readdirFn)) add(c);
  for (const c of walkOwnerName(dataTreePaths(cfg).clonesWatched, "clone", readdirFn)) add(c);
  return out;
}

/** Per-repo git enrichment, individually wrapped (never-throws → null fields +
 * `error`). nwo from origin's URL (nwoFromRemoteUrl), falling back to the
 * candidate's nwoHint; forkUrl from the `fork` remote (external/clone repos)
 * else null. Dirty = non-empty `status --porcelain`. */
async function buildRepo(c: RepoCandidate, gitFn: GitFn): Promise<LocalRepo> {
  const base: LocalRepo = {
    nwo: c.nwoHint,
    path: c.path,
    source: c.source,
    originUrl: null,
    forkUrl: null,
    githubUrl: null,
    branch: null,
    headSha: null,
    dirty: null,
    error: null,
  };
  try {
    const q = (args: string[]): Promise<{ code: number; stdout: string }> =>
      gitFn(["--no-optional-locks", "-C", c.path, ...args], c.path);

    const originR = await q(["remote", "get-url", "origin"]);
    const originUrl = originR.code === 0 ? originR.stdout.trim() : null;
    const forkR = await q(["remote", "get-url", "fork"]);
    const forkUrl = forkR.code === 0 ? forkR.stdout.trim() : null;
    const nwo = (originUrl ? nwoFromRemoteUrl(originUrl) : null) ?? c.nwoHint;

    const branchR = await q(["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchR.code === 0 ? branchR.stdout.trim() : null;
    const headR = await q(["rev-parse", "HEAD"]);
    const headSha = headR.code === 0 ? headR.stdout.trim() : null;
    const statusR = await q(["status", "--porcelain"]);
    const dirty = statusR.code === 0 ? statusR.stdout.trim() !== "" : null;

    return {
      ...base,
      nwo,
      originUrl,
      forkUrl,
      githubUrl: nwo ? `https://github.com/${nwo}` : null,
      branch,
      headSha,
      dirty,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function enumerateRepos(
  cfg: Config,
  deps: LocalSnapshotDeps = {},
): Promise<LocalRepo[]> {
  const gitFn = deps.gitFn ?? defaultGitFn(cfg);
  const candidates = collectRepoCandidates(cfg, deps);
  return mapPool(candidates, REPO_POOL, (c) => buildRepo(c, gitFn));
}

export interface LocalWorktree {
  path: string;
  repoPath: string | null;
  repoNwo: string | null;
  slug: string;
  kind: "live" | "stale" | "backup";
  headSha: string | null;
  ageSeconds: number | null;
  error: string | null;
}

const OLD_TS_RE = /\.old-(\d+)$/;

/**
 * Walk cfg.worktreeRoot (layout worktreeRoot/<repoDiscriminator>/<slug> +
 * `.old-<ts>` backups, worktree.ts:148-162). Display class only: a `.old-<ts>`
 * dir → backup; a dir whose listing contains `.git` → live; else → stale (the
 * FS class is display-only, NOT the prune safety signal). Reverse-maps the
 * discriminator by precomputing repoDiscriminator() over the same candidate
 * union enumerateRepos uses — no git needed for the map; unmatched → repoNwo
 * null (⟨unmapped⟩). HEAD via a lock-free rev-parse through gitFn (mirrors
 * currentHeadSha, worktree.ts:71, but seam-injectable + --no-optional-locks).
 */
export async function enumerateWorktrees(
  cfg: Config,
  deps: LocalSnapshotDeps = {},
): Promise<LocalWorktree[]> {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const gitFn = deps.gitFn ?? defaultGitFn(cfg);

  const discMap = new Map<string, { path: string; nwo: string | null }>();
  for (const c of collectRepoCandidates(cfg, deps)) {
    discMap.set(repoDiscriminator(c.path), { path: c.path, nwo: c.nwoHint });
  }

  const nowSeconds = Math.floor(nowFn().getTime() / 1000);
  const hasDotGit = (dir: string): boolean => {
    try {
      return readdirFn(dir).includes(".git");
    } catch {
      return false;
    }
  };

  let discDirs: string[];
  try {
    discDirs = readdirFn(cfg.worktreeRoot);
  } catch {
    return []; // worktreeRoot missing (fresh install) — empty, never error
  }

  const out: LocalWorktree[] = [];
  for (const disc of discDirs) {
    const discPath = join(cfg.worktreeRoot, disc);
    // Legacy flat backup directly under worktreeRoot (pre-issue-#33 layout).
    const flat = OLD_TS_RE.exec(disc);
    if (flat) {
      out.push({
        path: discPath,
        repoPath: null,
        repoNwo: null,
        slug: disc.slice(0, flat.index),
        kind: "backup",
        headSha: null,
        ageSeconds: nowSeconds - parseInt(flat[1], 10),
        error: null,
      });
      continue;
    }
    const mapped = discMap.get(disc) ?? null;
    let children: string[];
    try {
      children = readdirFn(discPath);
    } catch {
      continue; // vanished between the two listings
    }
    for (const name of children) {
      const wtPath = join(discPath, name);
      const backup = OLD_TS_RE.exec(name);
      const slug = backup ? name.slice(0, backup.index) : name;
      let kind: LocalWorktree["kind"];
      let ageSeconds: number | null = null;
      if (backup) {
        kind = "backup";
        ageSeconds = nowSeconds - parseInt(backup[1], 10);
      } else {
        kind = hasDotGit(wtPath) ? "live" : "stale";
      }
      let headSha: string | null = null;
      let error: string | null = null;
      if (kind !== "backup") {
        try {
          const r = await gitFn(["--no-optional-locks", "-C", wtPath, "rev-parse", "HEAD"], wtPath);
          headSha = r.code === 0 ? r.stdout.trim() : null;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      out.push({
        path: wtPath,
        repoPath: mapped?.path ?? null,
        repoNwo: mapped?.nwo ?? null,
        slug,
        kind,
        headSha,
        ageSeconds,
        error,
      });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Trimmed projection of GateStatus for the dashboard: state + reason only —
 * rendered fields (sections.tsx reads `daemon.gate.state`/`.reason`
 * exclusively). Drops `since` and `until` (neither is rendered) and loses the
 * branded GateStateKind (the dashboard only switches on a handful of known
 * strings, see sections.tsx's gate-color sets). */
export interface DaemonGateInfo {
  state: string;
  reason: string | null;
}

/** Trimmed projection of SpendStatus for the dashboard — currently identical
 * to the source shape (both fields are rendered), kept as its own type so
 * DaemonDetail doesn't couple directly to the healthServer transport type. */
export interface DaemonSpendInfo {
  todayUsd: number;
  dailyBudgetUsd: number;
}

export interface DaemonDetail {
  up: boolean;
  pid: number | null;
  uptimeSeconds: number | null;
  endpointReachable: boolean;
  healthHost: string;
  healthPort: number;
  guardNudges: number | null;
  guardKills: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tasksByStatus: Record<string, number>;
  currentTickets: string[];
  progress: Record<
    string,
    { turns: number; lastTool: string | null; outputTokens: number; startedAt: string }
  >;
  /** null when no gate is configured/reported, or on an older daemon whose
   * /health payload never had the field. */
  gate: DaemonGateInfo | null;
  /** null when no spendStatus is configured/reported, or on an older daemon
   * whose /health payload never had the field. */
  spend: DaemonSpendInfo | null;
  error: string | null;
}

function emptyDaemon(cfg: Config): DaemonDetail {
  return {
    up: false,
    pid: null,
    uptimeSeconds: null,
    endpointReachable: false,
    healthHost: cfg.healthHost,
    healthPort: cfg.healthPort,
    guardNudges: null,
    guardKills: null,
    tokensIn: null,
    tokensOut: null,
    tasksByStatus: {},
    currentTickets: [],
    progress: {},
    gate: null,
    spend: null,
    error: null,
  };
}

/** Compose DaemonDetail from an ALREADY-fetched /health body (no second
 * request) plus an independent inference-endpoint probe (endpointReachable
 * hits /models, health.ts:40 — reachability is independent of the daemon).
 * The probe goes through `deps.reachableFn` when injected (makeLocalCheapFn
 * passes its per-factory cached probe); otherwise a direct uncached call —
 * per-call `fetchFn` injection stays honored, never a warm result from a
 * previous call's different deps. */
export async function buildDaemonDetail(
  cfg: Config,
  healthBody: HealthBody | null,
  deps: LocalSnapshotDeps = {},
): Promise<DaemonDetail> {
  const base = emptyDaemon(cfg);
  try {
    const reachable =
      deps.reachableFn ??
      ((): Promise<boolean> => endpointReachable(cfg, { fetchFn: deps.fetchFn }));
    base.endpointReachable = await reachable();
    if (healthBody === null) return base; // daemon down
    const m = healthBody.metrics;
    const gate: DaemonGateInfo | null =
      healthBody.gate == null
        ? null
        : {
            state: healthBody.gate.state,
            reason: healthBody.gate.reason,
          };
    const spend: DaemonSpendInfo | null =
      healthBody.spend == null
        ? null
        : {
            todayUsd: healthBody.spend.todayUsd,
            dailyBudgetUsd: healthBody.spend.dailyBudgetUsd,
          };
    const progress: DaemonDetail["progress"] = {};
    for (const [id, v] of Object.entries(m.currentProgress ?? {})) {
      progress[id] = {
        turns: v.turns,
        lastTool: v.lastTool,
        outputTokens: v.outputTokens,
        startedAt: v.startedAt,
      };
    }
    return {
      ...base,
      up: true,
      pid: m.pid ?? null,
      uptimeSeconds: m.uptimeSeconds ?? null,
      guardNudges: m.guardNudges ?? null,
      guardKills: m.guardKills ?? null,
      tokensIn: m.totalTokensIn ?? null,
      tokensOut: m.totalTokensOut ?? null,
      tasksByStatus: { ...(m.tasksByStatus ?? {}) },
      currentTickets: [...(m.currentTickets ?? [])],
      progress,
      gate,
      spend,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface LocalHeavy {
  repos: LocalRepo[];
  worktrees: LocalWorktree[];
  error: string | null;
}

/**
 * Heavy tick: repos + worktrees, run concurrently (each enumerator bounds its
 * own git fan-out via mapPool). `signal` gives late-result drop — when a
 * mode-switch/unmount aborts before or during the run, the resolved results are
 * discarded (empty LocalHeavy) so a stale poll never clobbers fresh state.
 * Never-throws.
 */
export function makeLocalHeavyFn(
  cfg: Config,
  deps: LocalSnapshotDeps = {},
): (signal?: AbortSignal) => Promise<LocalHeavy> {
  return async (signal?: AbortSignal): Promise<LocalHeavy> => {
    const dropped: LocalHeavy = { repos: [], worktrees: [], error: null };
    if (signal?.aborted) return dropped;
    try {
      const [repos, worktrees] = await Promise.all([
        enumerateRepos(cfg, deps),
        enumerateWorktrees(cfg, deps),
      ]);
      if (signal?.aborted) return dropped; // late-result drop
      return { repos, worktrees, error: null };
    } catch (e) {
      if (signal?.aborted) return dropped;
      return { repos: [], worktrees: [], error: e instanceof Error ? e.message : String(e) };
    }
  };
}

export type LocalSection = "queue" | "outbox" | "repos" | "worktrees" | "daemon" | "logs";

export interface LocalCheap {
  queue: QueueSnapshot;
  counts: { done: number; failed: number } | null;
  outbox: {
    depth: number;
    dead: number;
    ops: StoredOp[];
    deadOps: StoredOp[];
    error: string | null;
  };
  daemon: DaemonDetail;
  error: string | null;
}

function emptyQueue(cfg: Config): QueueSnapshot {
  return {
    daemonUp: false,
    maxConcurrent: cfg.maxConcurrent,
    taskTimeoutSeconds: cfg.defaultTimeoutMinutes > 0 ? cfg.defaultTimeoutMinutes * 60 : null,
    running: [],
    waiting: [],
    recent: [],
    error: null,
    outboxDepth: 0,
    stats: null,
  };
}

/** Deps-injectable `.md` count (mirrors statusCmd.ts:28 countMd). */
function countMd(dir: string, deps: LocalSnapshotDeps): number {
  const readdirFn = deps.readdirFn ?? readdirSync;
  try {
    return readdirFn(dir).filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/**
 * Cheap tick: queue (via makeQueueSnapshotFn), gated done/failed counts,
 * outbox live/dead split, daemon detail. ONE /health fetch total — fetched
 * here and threaded into both the queue layer (healthOverride) and
 * buildDaemonDetail. Never-throws (top-level try/catch + per-section fields).
 */
export function makeLocalCheapFn(
  cfg: Config,
  deps: LocalSnapshotDeps = {},
): (opts?: { section?: LocalSection }) => Promise<LocalCheap> {
  // One TTL-cached endpoint probe per FACTORY (dashboardCmd constructs this
  // once per process), so cheap-tick polling can't multiply upstream /models
  // probes — mirrors the daemon's own shared cache (daemon.ts:471, health.ts
  // makeCachedProbe). Closure-scoped, NOT module-level: cfg/fetchFn are fixed
  // at construction, so per-call deps injection elsewhere stays isolated.
  const cachedReachable =
    deps.reachableFn ?? makeCachedProbe(() => endpointReachable(cfg, { fetchFn: deps.fetchFn }));
  // Constructed ONCE per factory, like cachedReachable above: the queue-
  // snapshot factory carries the task-history per-shard memo in its closure
  // (queueSnapshot.ts historyReader) — rebuilding it per tick re-parses the
  // current shard every ~3s for the life of the dashboard (#235). The
  // per-tick /health body is threaded per-INVOCATION via QueueSnapshotOpts,
  // so hoisting costs no second fetch and daemonUp stays consistent.
  const queueSnapshotFn = makeQueueSnapshotFn(cfg, {
    readdirFn: deps.readdirFn,
    readFileFn: deps.readFileFn,
    statFn: deps.statFn,
    nowFn: deps.nowFn,
  });
  return async (opts: { section?: LocalSection } = {}): Promise<LocalCheap> => {
    const base: LocalCheap = {
      queue: emptyQueue(cfg),
      counts: null,
      outbox: { depth: 0, dead: 0, ops: [], deadOps: [], error: null },
      daemon: emptyDaemon(cfg),
      error: null,
    };
    try {
      const healthBody = await fetchHealthBody(cfg, deps);

      const queue = await queueSnapshotFn({ healthOverride: { body: healthBody } });

      let counts: LocalCheap["counts"] = null;
      if (opts.section === "queue") {
        const paths = queuePaths(cfg);
        counts = { done: countMd(paths.done, deps), failed: countMd(paths.failed, deps) };
      }

      let outbox = base.outbox;
      try {
        const outDeps = { readdirFn: deps.readdirFn, readFileFn: deps.readFileFn };
        const ops = listOpsFrom(outboxPaths(cfg).dir, outDeps);
        const deadOps = listOpsFrom(outboxPaths(cfg).dead, outDeps);
        outbox = { depth: ops.length, dead: deadOps.length, ops, deadOps, error: null };
      } catch (e) {
        outbox = {
          depth: 0,
          dead: 0,
          ops: [],
          deadOps: [],
          error: e instanceof Error ? e.message : String(e),
        };
      }

      const daemon = await buildDaemonDetail(cfg, healthBody, {
        ...deps,
        reachableFn: cachedReachable,
      });

      return { queue, counts, outbox, daemon, error: null };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
