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
import {
  queuePaths,
  defaultUserConfigPath,
  legacyConfigPath,
  configPathOverride,
} from "./config.js";

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
    plans: "plans",
    chats: "chats",
    chatDrafts: "chat-drafts",
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
    plans: "data/plans",
    chats: "data/chats",
    chatDrafts: "data/chat-drafts",
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
  assessHistory: string; // per-repo `junco audit` history (one file per repo)
  history: string; // per-task finalize records (tasks-YYYY-MM.jsonl shards)
  transcripts: string;
  plans: string;
  chats: string; // per-repo chat sessions: <slug>/{meta.json,transcript.jsonl,<sdk session>} (spec 2026-09-01)
  chatDrafts: string; // parked chat drafts (makeReviewStore) + submitted/ discarded/ archives
  skills: string; // <root>/skills symlink mount -> packaged skills/ (skillLinks.ts owns it)
  watchlistFile: string;
  updateCheckFile: string; // npm update-check cache (spec 2026-07-16)
  spendFile: string;
  metricsFile: string; // written by metricsWriter.ts (daemon startup/tick/shutdown)
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
    plans: join(r, L.plans),
    chats: join(r, L.chats),
    chatDrafts: join(r, L.chatDrafts),
    skills: join(r, "skills"),
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
 * What the agent sandbox may and may not read inside the data tree (threaded
 * into `buildPolicy` by `agent/session.ts`, which passes `dirs`/`files` as the
 * deny lists and `allowDirs` as `dataAllowPaths`). Split dirs/files because the
 * backends enforce them differently (Seatbelt subpath vs literal; bwrap tmpfs
 * vs /dev/null bind).
 *
 * #277: this is DENY-BY-DEFAULT, in two layers that do NOT subsume each other.
 * Precedence is longest-prefix-wins over the composed rule set
 * (`agent/sandbox/precedence.ts`), never list order, so a deny, an allow-back
 * inside it, and a re-deny inside THAT all coexist:
 *
 *   v2:    deny <root>  >  allow cache/clones/ and cache/worktrees/
 *   flat:  deny <root>  >  allow clones/ and worktrees/
 *
 * The allow-backs stop at the clones/worktrees depth in BOTH layouts. A deny
 * nested inside an allow-back still works and is still supported (that is the
 * precedence design) — for DIRECTORIES. For a deny FILE it is unenforceable on
 * bwrap, and `buildPolicy` refuses such a policy outright (#311); the `cache/`
 * tier held `cache/update-check.json`, so v2's allow-back moved down to
 * `cache/clones` and mirror/github-cache/update-check.json are now covered by
 * the wholesale root deny alone.
 *
 * 1. CONTAINMENT — the whole data root is denied wholesale, so anything
 *    daemon-owned is denied the day it JOINS the tree rather than the day
 *    someone remembers to list it here. That is what killed the old drift mode
 *    (`plans` joined the tree with the plan-sets work and stayed agent-readable
 *    until 2026-08-21).
 * 2. EXPLICIT SUBTREE DENIES at each subtree's own natural depth — every
 *    daemon-owned subtree is ALSO named below. Redundant while the allow-backs
 *    sit where the layout puts them; NOT redundant when one moves. `allowDirs`
 *    re-allows two legacy-overridable roots by name, and an operator who points
 *    one of them at a whole tier (`git.worktreeRoot = <root>/data` on v2)
 *    out-specifies a deny that exists only at the root — transcripts, plan-set
 *    records, the outbox and history would be agent-readable again, which is
 *    exactly what the pre-#277 enumeration prevented (final review 2026-08-22,
 *    reproduced by execution). A deny at the subtree's own depth cannot be
 *    out-specified by a shallower allow-back, and an exact-path tie resolves to
 *    deny (precedence.ts's `effect` tiebreak).
 *
 * Containment covers what nobody listed; the explicit denies cover what an
 * allow-back uncovered. Neither is a fallback for the other, and the drift
 * guard in tests/dataTree.test.ts asserts the RESOLVED effect of every
 * `DataTreePaths` field so a new entry still has to be classified either way.
 *
 * Denying an ancestor of the agent's writable roots is safe BECAUSE the writable
 * roots are themselves allow rules at their own depth (`policy.readRules`) — the
 * session's cwd out-specifies the root deny. The old "never deny an ancestor of
 * a writable root" convention is gone with the enumeration it protected.
 *
 * `queueRoot` stays denied explicitly even though it normally sits inside the
 * root: a legacy vaultRoot queue lives outside it, and tickets are sensitive
 * wherever they are. `worktrees`/`clonesExternal` are allowed back explicitly in
 * both layouts for the mirror-image reason — both are legacy-overridable and an
 * operator can park them anywhere, including inside the root but outside the
 * tier that would otherwise cover them.
 *
 * `skills` is DENIED by containment (it is `<root>/skills`) and is deliberately
 * NOT named here: it is a SYMLINK to the installed package's `skills/` dir
 * (skillLinks.ts), a distribution mount for external harnesses that the
 * sandboxed agent never reads, so a deny ON it would be resolved onto the junco
 * INSTALLATION by `canonicalize()` — protecting public packaged content instead
 * of the data tree.
 *
 * What the three layers actually do with it, corrected at final review
 * 2026-08-22 and re-verified here by running real `sandbox-exec` against a real
 * tree on macOS (the note that stood here before had it exactly backwards,
 * over-confident about the OS layer — the error class this branch exists to
 * police):
 *   - Seatbelt DENIES `cat <root>/skills/SKILL.md` while permitting the same
 *     read against the symlink's real target. The `skills` entry itself lies
 *     inside the denied subpath, so the traversal never reaches that target.
 *   - bwrap denies it too — its tmpfs over the root replaces the directory the
 *     symlink lives in. (Reasoned, not executed: no bwrap on this host.)
 *   - Only the JS path-jail PERMITS it, because `canonicalize()` resolves the
 *     symlink OUT of the denied root before `resolveRead` ever sees the path.
 * Accepted: what the path-jail reaches is the installed package's public
 * `skills/` dir, no data-tree content is reachable that way, and canonicalizing
 * first is exactly what closes the direction that WOULD matter — a symlink
 * planted in the worktree aiming at `config.json` came back denied on both the
 * path-jail and Seatbelt in that same run. Note the drift guard's
 * `resolveRead(paths.skills) === "deny"` is the raw-path answer: what the OS
 * backends enforce, and what the path-jail never asks.
 * Every entry's resolved effect is asserted in tests/dataTree.test.ts
 * ("classifies every data-tree entry as denied or deliberately readable").
 *
 * The root receipt files stay enumerated in `files`. They are redundant under the
 * root deny for as long as no allow-back sits above one — and since #311 that is
 * no longer a convention but a checked invariant: `buildPolicy` REFUSES a policy
 * whose allow (an allow-back or a writable root) is a strict ancestor of one of
 * these, because bwrap must skip a deny mount whose target does not exist and
 * every one of them is written lazily. That is why v2's allow-back is
 * `cache/clones`, not `cache/` — the latter is an ancestor of
 * `cache/update-check.json`. Pre-creating the receipts instead was rejected: a
 * placeholder `update-check.json` is a FILE at a destination `data migrate` must
 * MOVE into (`isRecursivelyEmptyDir` treats that as a conflict) and would block
 * the real cache permanently, and an empty `spend.json`/`metrics.json` hands
 * their readers "" to `JSON.parse`. `ensureDataTree` still materializes every
 * deny DIRECTORY eagerly, which is what keeps the directory half enforceable
 * inside an allow-back (tests/dataTree.test.ts pins both halves).
 *
 * `env` resolves the canonical config file location (`defaultUserConfigPath`)
 * — it may hold `model.apiKey`; the config can live outside the data root
 * (legacy stateDir, or an explicitly-named path), so all three config
 * locations are denied BY NAME rather than by the root's containment.
 * `legacyConfigPath(env)` is denied too (I-3, final review 2026-08-05): on an
 * un-migrated machine the daemon actually reads the legacy XDG path, not the
 * canonical one — denying only the canonical path would leave the ACTIVE config
 * (and its possible `model.apiKey`) agent-readable until `junco data migrate`
 * runs. `configPathOverride(env)` is the same gap at a third location (#275):
 * under `JUNCO_CONFIG` the ACTIVE config is neither of the two fixed paths, and
 * Seatbelt is broadly `(allow file-read*)` with named denies, so an un-denied
 * override is an outright readable API key. It is resolved through config.ts's
 * own helper — never re-spelled here — so this list cannot drift from
 * `resolveConfigPath`.
 *
 * A nonexistent deny file is already the norm in this list — every receipt
 * file here is absent until its first write — and both backends tolerate that
 * by construction: Seatbelt denies by name whether or not the path exists, and
 * `bwrapArgs` emits deny mounts only for paths that pass its `existsFn` guard.
 * So a legacy (or not-yet-created override) path that doesn't exist costs
 * nothing.
 */
export function sandboxDenyPaths(
  cfg: Config,
  env: Record<string, string | undefined> = process.env,
): { dirs: string[]; files: string[]; allowDirs: string[] } {
  const p = dataTreePaths(cfg);
  // #275: the explicitly-named config, when one is in effect. Same helper
  // resolveConfigPath uses — see the doc comment above.
  const overriddenConfigPath = configPathOverride(env);
  return {
    // Deduped: `logsDir` IS the root under the flat layout (join(r, ".")), and
    // a duplicated deny would emit a redundant mount/profile line per backend.
    dirs: [
      ...new Set([
        // --- Layer 1: containment (see the doc comment above). The whole tree,
        // wholesale (#277). Everything daemon-owned is denied by belonging to
        // the root, so nothing can be forgotten here again.
        p.root,
        // Kept as-is: a legacy vaultRoot queue lives OUTSIDE the root.
        cfg.queueRoot,
        // --- Layer 2: every daemon-owned subtree at its own natural depth, so
        // a mis-set allow-back (`git.worktreeRoot`/`github.externalReposRoot`
        // pointed at a whole tier) can never out-specify the deny that protects
        // it. Ordered as the tree reads, not by sensitivity — all of it is
        // daemon-owned. `clonesWatched`/`worktrees`/`clonesExternal` are the
        // agent's execution roots and are deliberately absent (they are
        // allow-backs below); `skills` is deliberately absent too (see the doc
        // comment). Every one of these is materialized by ensureDataTree, which
        // matters on bwrap: a deny whose target does not exist is skipped
        // (agent/sandbox/backend.ts), so an unmaterialized subtree inside an
        // allow-back would be a real hole.
        ...Object.values(p.queue),
        p.reviewAssess,
        p.reviewComments,
        p.outbox,
        p.transcripts,
        p.plans,
        p.history,
        p.assessHistory,
        // Chat session store (SDK session files hold the whole conversation)
        // and parked drafts — never agent-readable (spec 2026-09-01 §1.1).
        p.chats,
        p.chatDrafts,
        p.logsDir,
        // Re-denied inside the cache/ allow-back (v2). Under flat both sit
        // directly at the root with no allow-back over them, so these two are
        // Layer-2 entries there — listing them unconditionally keeps one code
        // path and one obvious reading: never agent-readable in any layout.
        p.mirror,
        p.githubCache, // legacy TUI cache (tui/ghClient.ts still owns it)
      ]),
    ],
    allowDirs: [
      // The clones tier the agent's git actually reads. Allowed back at the
      // clones root in BOTH layouts, never at a tier above it: v2's tier above
      // is `cache/`, which HOLDS `cache/update-check.json` — a deny FILE, and a
      // deny file inside an allow-back is unenforceable on bwrap, which skips a
      // deny mount whose target does not exist (#311). buildPolicy refuses such
      // a policy outright now, so this must stay at clones depth; the rest of
      // `cache/` (mirror, github-cache, update-check.json) needs no allow-back
      // and is covered by the wholesale root deny on every backend.
      dirname(p.clonesWatched),
      // Both are legacy-overridable (git.worktreeRoot / github.externalReposRoot)
      // and can be relocated inside the denied root but outside the tier above,
      // which the wholesale deny would silently wall the agent out of. Allowing
      // them by name in BOTH layouts is a no-op when they sit where the layout
      // puts them, and the fix when they don't.
      p.worktrees,
      p.clonesExternal,
    ],
    files: [
      p.watchlistFile,
      p.updateCheckFile,
      p.spendFile,
      p.metricsFile,
      p.logFile,
      p.migratedFile,
      p.migrateLockFile, // daemon-owned, sibling of migrated.json above
      defaultUserConfigPath(env), // may hold model.apiKey — see doc comment above
      legacyConfigPath(env), // I-3: the ACTIVE config on an un-migrated machine
      // #275: the ACTIVE config under a JUNCO_CONFIG override — neither of the
      // two fixed paths above. Spread so an unset variable adds nothing.
      ...(overriddenConfigPath !== undefined ? [overriddenConfigPath] : []),
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
 *
 * Every directory is created owner-only (0700, #343): the tree holds
 * transcripts (verbatim private-repo file contents) and, by default, the
 * config with its apiKey. mkdir never re-modes a dir that already exists —
 * `junco doctor` is what surfaces a loose pre-existing tree.
 */
export function ensureDataTree(cfg: Config, deps: EnsureDataTreeDeps = {}): void {
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true, mode: 0o700 }));
  const existsFn = deps.existsFn ?? existsSync;
  const writeFn = deps.writeFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const p = dataTreePaths(cfg);
  // p.skills is deliberately NOT mkdir'd here: it is a symlink mount owned by
  // skillLinks.ts's ensureSkillLinks(), not a plain directory. A real dir
  // materialized at that path by this loop would permanently occupy the
  // mount name ("occupied by a non-symlink") and block the symlink forever.
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
    // Sibling of p.mirror and denied alongside it, so it must be materialized
    // alongside it too. It used to be created lazily on the TUI's first cache
    // write (tui/ghClient.ts) — a violation of this module's own eager-tree
    // invariant with a security edge on bwrap: `bwrapArgs` skips a deny whose
    // target is absent, and under v2 this one sat INSIDE the then-`cache/`
    // allow-back, so on a tree where the TUI had never cached anything the
    // deny was dropped, `cache/` was ro-bound wholesale, and an operator
    // opening the TUI mid-run put their token-fetched GitHub issue/PR data
    // inside the agent's readable view (final review 2026-08-22, I-1).
    // Seatbelt and the path-jail deny it by name unconditionally, so the
    // window was bwrap/Linux-only. #311 moved that allow-back down to
    // `cache/clones`, so this path is back under the root deny's cover — the
    // eager mkdir stays regardless: it is what keeps ANY deny dir enforceable
    // if an operator's legacy override ever allows its tier back by name.
    p.githubCache,
    p.clonesWatched,
    p.assessHistory,
    p.history,
    p.transcripts,
    p.plans,
    // Chat (spec 2026-09-01 §1.1): both are deny targets, so both are eager —
    // the same bwrap "absent deny is skipped" reason githubCache is above.
    p.chats,
    join(p.chatDrafts, "submitted"),
    join(p.chatDrafts, "discarded"),
    p.logsDir, // v2: <root>/logs — flat: join(root, ".") normalizes to root, a mkdir no-op
  ];
  for (const d of dirs) mkdirFn(d);
  const gi = join(p.root, ".gitignore");
  if (!existsFn(gi)) writeFn(gi, "*\n"); // self-ignoring root; an operator-customized file is respected
}
