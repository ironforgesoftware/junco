/**
 * The single source of truth for the unified data tree's shape (spec
 * 2026-07-16 §4). Subdir constants are imported by the stores
 * (assessReview/commentReview/assessHistory/githubOutbox/watchlist/dashboard)
 * so the tree and its writers can never drift; ensureDataTree materializes everything
 * eagerly at daemon startup so no directory is invisible-until-first-use.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config, Paths } from "./types.js";
import { queuePaths, defaultUserConfigPath, legacyConfigPath } from "./config.js";

export const REVIEW_ASSESS_SUBDIR = "review/assess";
export const REVIEW_COMMENTS_SUBDIR = "review/comments";
export const OUTBOX_SUBDIR = "outbox";
export const MIRROR_SUBDIR = "mirror";
export const CLONES_WATCHED_SUBDIR = "clones/watched";
export const CLONES_EXTERNAL_SUBDIR = "clones/external";
export const ASSESS_HISTORY_SUBDIR = "assess-history";
export const HISTORY_SUBDIR = "history";
export const WATCHLIST_FILENAME = "watchlist.json";
export const UPDATE_CHECK_FILENAME = "update-check.json";

/**
 * Poison roots for `queue`/`clonesExternal` when cfg.queueRoot/cfg.github are
 * absent (the repo's own `ghBin: "/nonexistent/gh"` idiom — see config.ts).
 * NOT dead code: see the long comment on `queue` in dataTreePaths() for why
 * that fallback exists at all. `""` was rejected as the sentinel — `join("",
 * x)` silently resolves to a CWD-relative path, so a future consumer
 * exercised only by one of those narrow fixtures could end up writing into
 * the process CWD and stay green. These paths fail loudly at the fs layer
 * (ENOENT/EACCES) instead, the instant anything real ever touches them.
 */
const POISON_QUEUE_ROOT = "/nonexistent/junco-queue";
const POISON_CLONES_EXTERNAL = "/nonexistent/junco-clones-external";

/** Per-layout subpaths. "flat" is the 0.9 shape, byte-identical forever —
 * an unmigrated tree must never see a moved path. "v2" is the single-root
 * shape: data/ (unrecoverable), cache/ (rm -rf-safe), logs/. `cfg.dataLayout`
 * defaults to "flat" here (not "v2") when absent: several unit tests build a
 * narrow `{ dataDir } as unknown as Config` fixture (see the long comment on
 * `queue` below) that never sets it, and those fixtures predate the layout
 * flip — they must keep resolving the pre-flip (flat) shape byte-for-byte. A
 * fully-assembled Config (the only kind config.ts ever produces) always sets
 * dataLayout explicitly, so this default is never observed in production. */
const LAYOUTS = {
  flat: {
    outbox: OUTBOX_SUBDIR,
    mirror: MIRROR_SUBDIR,
    clonesWatched: CLONES_WATCHED_SUBDIR,
    assessHistory: ASSESS_HISTORY_SUBDIR,
    history: HISTORY_SUBDIR,
    transcripts: "transcripts",
    githubCache: "github-cache",
    updateCheck: UPDATE_CHECK_FILENAME,
    spend: "spend.json",
    metrics: "metrics.json",
    logs: ".",
  },
  v2: {
    outbox: "data/outbox",
    mirror: "cache/mirror",
    clonesWatched: "cache/clones/watched",
    assessHistory: "data/assess-history",
    history: "data/history",
    transcripts: "data/transcripts",
    githubCache: "cache/github-cache",
    updateCheck: "cache/update-check.json",
    spend: "data/spend.json",
    metrics: "data/metrics.json",
    logs: "logs",
  },
} as const;

export interface DataTreePaths {
  root: string;
  queue: Paths; // from queuePaths(cfg)
  reviewAssess: string; // + "/filed" archive
  reviewComments: string; // + "/posted", "/discarded" archives
  outbox: string; // + "/dead"
  mirror: string;
  clonesWatched: string;
  clonesExternal: string; // NOTE: cfg.github.externalReposRoot (legacy-overridable)
  worktrees: string; // NOTE: cfg.worktreeRoot (legacy-overridable)
  assessHistory: string; // per-repo `junco assess` history (one file per repo)
  history: string; // per-task finalize records (tasks-YYYY-MM.jsonl shards)
  transcripts: string;
  watchlistFile: string;
  updateCheckFile: string; // npm update-check cache (spec 2026-07-16)
  spendFile: string;
  metricsFile: string; // PR 3 writes it; listed now
  logFile: string;
  migratedFile: string; // dataMigrate journal (Task 4)
  // startup-migration mutex (#197.2) — daemon.ts holds THIS field; dataMigrateCmd.ts computes the
  // equivalent join(targetRoot, "migrate.lock") itself (P2.T5), not read from here, since its lock
  // must follow a cross-root `junco data migrate` to targetRoot rather than the frozen cfg.dataDir.
  migrateLockFile: string;
  githubCache: string; // legacy TUI issue/PR cache (tui/ghClient.ts)
  logsDir: string; // dirname(logFile): root in the flat layout, <root>/logs in v2
}

export function dataTreePaths(cfg: Config): DataTreePaths {
  const r = cfg.dataDir;
  // See the LAYOUTS comment above for why the fallback is "flat", not "v2".
  const L = LAYOUTS[cfg.dataLayout ?? "flat"];
  return {
    root: r,
    // `queue`/`clonesExternal` degrade to an inert placeholder instead of
    // throwing when cfg.queueRoot/cfg.github are absent. This is NOT a
    // defensive habit — it is load-bearing for >12 existing unit-test call
    // sites across tests/watchlist.test.ts, tests/taskHistory.test.ts,
    // tests/githubOutbox.test.ts, tests/updateCheck.test.ts,
    // tests/logsCmd.test.ts, tests/tuiGhClient.test.ts,
    // tests/localSnapshotRepos.test.ts, tests/assessReview.test.ts,
    // tests/commentReview.test.ts, tests/assessHistory.test.ts, and
    // tests/assessFiling.test.ts, all of which unit-test a SINGLE narrow
    // field's module (e.g. historyDir, watchlistPath, cachePathFor,
    // assessReviewPaths) against a minimal `{ dataDir } as unknown as Config`
    // fixture that deliberately never sets queueRoot/github — those modules
    // used to read cfg.dataDir directly and never needed those fields. Now
    // that they call dataTreePaths(cfg) for the one field they DO need
    // (.history, .watchlistFile, .githubCache, .reviewAssess, ...), a strict
    // dataTreePaths would crash every one of those call sites at
    // queuePaths(cfg) (join(undefined, ...) when cfg.queueRoot is unset) or
    // at cfg.github.externalReposRoot (reading a property of an absent
    // cfg.github). Upgrading all of those fixtures to a full Config via
    // tests/helpers/config.ts's makeConfig was tried and rejected: it is
    // >12 call sites, and it would force every single-field module's test to
    // additionally state 10 unrelated ConfigSeams fields it doesn't exercise
    // — exactly what those fixtures are deliberately narrow to avoid. A
    // fully-resolved Config (the only kind that ever reaches this function in
    // production — config.ts always sets both queueRoot and github) always
    // takes the real branch, so this changes nothing observable for any real
    // caller, and nothing in tests/dataTree.test.ts, tests/daemon.test.ts, or
    // tests/cli.test.ts (all full-Config fixtures) exercises the fallback.
    // The fallback values themselves are POISON paths (see POISON_QUEUE_ROOT/
    // POISON_CLONES_EXTERNAL above), not "" — an empty string would let
    // join("", x) silently resolve relative to the process CWD.
    queue: cfg.queueRoot
      ? queuePaths(cfg)
      : {
          inbox: join(POISON_QUEUE_ROOT, "inbox"),
          processing: join(POISON_QUEUE_ROOT, "processing"),
          done: join(POISON_QUEUE_ROOT, "done"),
          failed: join(POISON_QUEUE_ROOT, "failed"),
        },
    reviewAssess: join(r, REVIEW_ASSESS_SUBDIR),
    reviewComments: join(r, REVIEW_COMMENTS_SUBDIR),
    outbox: join(r, L.outbox),
    mirror: join(r, L.mirror),
    clonesWatched: join(r, L.clonesWatched),
    // cfg.github is typed as GithubConfig — non-optional, never undefined —
    // so `cfg.github?.` would misstate the type (optional chaining implies a
    // legitimately-absent field). Several unit tests build a Config via
    // `{ dataDir } as unknown as Config`, which lies about that type at
    // runtime; this explicit truthiness check (not `?.`) exists ONLY to
    // survive that lie, same rationale as the `cfg.queueRoot` check above.
    clonesExternal: cfg.github ? cfg.github.externalReposRoot : POISON_CLONES_EXTERNAL,
    worktrees: cfg.worktreeRoot,
    assessHistory: join(r, L.assessHistory),
    history: join(r, L.history),
    transcripts: join(r, L.transcripts),
    watchlistFile: join(r, WATCHLIST_FILENAME),
    updateCheckFile: join(r, L.updateCheck),
    spendFile: join(r, L.spend),
    metricsFile: join(r, L.metrics),
    logFile: join(r, L.logs, "worker.log"),
    migratedFile: join(r, "migrated.json"),
    migrateLockFile: join(r, "migrate.lock"),
    githubCache: join(r, L.githubCache),
    logsDir: join(r, L.logs),
  };
}

/**
 * The data-tree paths the agent sandbox must not read (threaded into
 * `buildPolicy` by `agent/session.ts`): daemon-owned state — tickets, review
 * queues, outbox ops, transcripts, the GitHub mirror/cache, logs, the
 * canonical config file, and the root receipt files. Split dirs/files
 * because the backends enforce them differently (Seatbelt subpath vs
 * literal; bwrap tmpfs vs /dev/null bind). `queueRoot` is used as-is so a
 * legacy vaultRoot queue is denied wherever it lives.
 *
 * CRITICAL invariant: never deny an ancestor of the agent's writable roots.
 * Deliberately NOT the dataDir root, and (v2 layout) NOT `cache/` itself:
 * the default layout puts `worktrees/`/`cache/worktrees` (the agent's own
 * cwd) and `clones/`/`cache/clones` (gitdirs the agent's git reads) under
 * them, so a root- or cache-level deny would wall the agent out of its own
 * working tree — only cache/'s named subtrees (mirror, github-cache) are
 * denied, never cache/ itself.
 *
 * `env` resolves the canonical config file location (`defaultUserConfigPath`)
 * — it may hold `model.apiKey`; before the single-root move the config lived
 * outside the data root and escaped this deny list entirely, so folding it
 * in here closes that gap. `legacyConfigPath(env)` is denied too (I-3, final
 * review 2026-08-05): on an un-migrated machine the daemon actually reads
 * the legacy XDG path, not the canonical one — denying only the canonical
 * path would leave the ACTIVE config (and its possible `model.apiKey`)
 * agent-readable until `junco data migrate` runs. A nonexistent deny file is
 * already the norm in this list (`metricsFile` is writer-less today), so
 * both sandbox backends tolerate a legacy path that doesn't exist.
 */
export function sandboxDenyPaths(
  cfg: Config,
  env: Record<string, string | undefined> = process.env,
): { dirs: string[]; files: string[] } {
  const p = dataTreePaths(cfg);
  return {
    dirs: [
      cfg.queueRoot,
      dirname(p.reviewAssess), // <dataDir>/review (assess + comments)
      p.assessHistory, // daemon-owned audit history; agent has no reason to read it
      p.history, // daemon-owned task-history ledger
      p.outbox,
      p.mirror,
      p.transcripts,
      // Legacy TUI cache (tui/ghClient.ts still owns it; mirror/ replaces it
      // in PR 2).
      p.githubCache,
      // logsDir is a genuine subtree only under v2 (<root>/logs); under flat
      // it EQUALS the root itself (dataTreePaths: join(root, ".")) — denying
      // it there would violate the CRITICAL invariant above, so it's only
      // ever added when it's a proper subtree.
      ...(p.logsDir !== p.root ? [p.logsDir] : []),
    ],
    files: [
      p.watchlistFile,
      p.updateCheckFile,
      p.spendFile,
      p.metricsFile,
      p.logFile,
      p.migratedFile,
      defaultUserConfigPath(env), // may hold model.apiKey — see doc comment above
      legacyConfigPath(env), // I-3: the ACTIVE config on an un-migrated machine
    ],
  };
}

export interface EnsureDataTreeDeps {
  mkdirFn?: (d: string) => void;
  existsFn?: (p: string) => boolean;
  writeFn?: (p: string, s: string) => void;
}

/**
 * Materializes the tree eagerly (daemon startup) so no directory is
 * invisible-until-first-use, and drops a self-gitignoring `*` at the root
 * (respecting an operator-customized file: only written when absent).
 *
 * Does NOT mkdir `clonesExternal`/`worktrees` — externalRepo.ts/worktree.ts
 * create those on demand, and they may be legacy-overridden outside the
 * root. When `legacy.vaultRoot` is set, the queue dirs created are the
 * legacy ones via `queuePaths` — exactly what the daemon needs, without a
 * phantom default queue under dataDir.
 */
export function ensureDataTree(cfg: Config, deps: EnsureDataTreeDeps = {}): void {
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const existsFn = deps.existsFn ?? existsSync;
  const writeFn = deps.writeFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const p = dataTreePaths(cfg);
  const dirs = [
    p.queue.inbox,
    p.queue.processing,
    p.queue.done,
    p.queue.failed,
    join(p.reviewAssess, "filed"),
    join(p.reviewComments, "posted"),
    join(p.reviewComments, "discarded"),
    join(p.outbox, "dead"),
    p.mirror,
    p.clonesWatched,
    p.assessHistory,
    p.history,
    p.transcripts,
    p.logsDir, // v2: <root>/logs — flat: join(root, ".") normalizes to root, a mkdir no-op
  ];
  for (const d of dirs) mkdirFn(d);
  const gi = join(p.root, ".gitignore");
  if (!existsFn(gi)) writeFn(gi, "*\n"); // self-ignoring root; an operator-customized file is respected
}
