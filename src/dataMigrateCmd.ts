/**
 * `junco data migrate` — explicit, opt-in full unification of the legacy
 * vaultRoot queue + state-tree subdirs + config.json legacy keys into the
 * unified data root (spec 2026-07-16 §7 "Explicit"), extended (2026-08-03
 * single-root plan) to relocate the whole tree to `~/.junco` and restructure
 * it into the v2 shape. Refuses while the daemon appears to be running,
 * judged three ways: ANY /health response (even non-200) means something is
 * listening on that port; a live-held `<config dir>/worker.lock` pidfile (the
 * daemon's single-instance lock, see cli.ts) catches healthEnabled:false
 * daemons the probe can never observe; and a live-held `daemon-tree.lock` /
 * `daemon-queue.lock` claim at any root this run touches (#310) catches a
 * daemon that resolved a DIFFERENT config file, whose worker.lock sits beside
 * a config this process has never heard of. Any signal → back off rather than
 * race the daemon's own in-flight fs mutations. `--force` skips all three
 * (documented escape hatch). A pidfile lock is held at EVERY root this run
 * might read or write (see `lockRoots`, task review Important 3) — for a
 * cross-root run that includes both the legacy root and the target root,
 * since a daemon starting up concurrently derives its OWN migrate.lock from
 * whatever ITS resolved `cfg.dataDir` happens to be at that moment (legacy or
 * target, depending on whether it has reloaded config yet).
 *
 * `targetRoot` is `juncoHome(env)` when `cfg.legacy.dataRoot` (a pre-0.10
 * `~/.local/state/junco` tree adopted via config.ts's probe-based fallback —
 * see resolveDataRoot), else `cfg.dataDir` (an explicit dataDir keeps its own
 * location; only its SHAPE may change, via the same flatToV2Pairs mapping
 * with fromRoot === toRoot, which drops the resulting identity pairs).
 *
 * Resume is FILESYSTEM-driven, not resolution-driven (task review Critical 1):
 * `dataRootHasTree` flips `loadConfig`'s resolution to the target root the
 * moment the FIRST pair of a cross-root move lands (its marker probe only
 * needs one hit), so a naive "only plan pairs when `cfg.legacy.dataRoot`"
 * would see a half-migrated machine as already-done on every re-run and
 * silently orphan the rest forever — exactly the failure mode a `--dry-run`
 * or a crash mid-loop must be recoverable from. `dataRootPairs` therefore
 * probes BOTH `cfg.dataDir` (this run's current resolution — covers a fresh
 * first run and the in-place-restructure case) AND the fixed legacy path
 * (covers a resume once resolution has already flipped away from it),
 * whenever `targetRoot` is the canonical `~/.junco` — see `legacyRoot` below.
 * Every completed data-root/gh pair is journaled to the TARGET root's
 * `migrated.json` in a `finally` (same durable-receipt pattern
 * `migrateStateTree` already uses for its own journal — see
 * `dataMigrate.ts`'s `appendJournal`), so the record of what moved survives a
 * crash or a conflict, and the NEXT run's filesystem probe picks up exactly
 * the stragglers.
 *
 * Order of operations: probe → plan (read-only) → (`--dry-run`: print + stop,
 * exit 0 — BEFORE the lock, whose acquisition mkdirs each lock root as a side
 * effect) → lock (all roots) → stale-daemon-claim sweep (phase 1c: a claim
 * left by a CRASHED daemon is a file in a directory a later phase may treat
 * as a destination, where `isRecursivelyEmptyDir` reads it as a conflict) →
 * queue move → state-tree name-normalize
 * (`migrateStateTree`, still same-directory, still against `cfg.dataDir`) →
 * data-root move/restructure (`flatToV2Pairs`, journaled — see the
 * `migrated.json` self-reference note below) → gh creds move (journaled) →
 * legacy root removal (filesystem-driven — attempted whenever the fixed
 * legacy path still exists, not gated on `cfg.legacy.dataRoot`) →
 * config.json rewrite → config relocation → receipt. Conflicts (state-tree
 * or data-root) and a failed config rewrite are reported via a non-zero exit
 * code AFTER every non-conflicted step has completed — nothing already
 * moved/renamed is ever rolled back, and the receipt stays honest about
 * phases that never ran or were interrupted (see printReceipt).
 *
 * Config relocation (I-2, final review 2026-08-05): the rewrite above edits
 * config.json IN PLACE, at whatever path THIS run loaded it from — on an
 * upgraded machine still resolving to the legacy XDG path
 * (`legacyConfigPath`), that alone never makes the config single-root. The
 * final phase relocates it to the canonical path (`defaultUserConfigPath`)
 * whenever `configPath` IS the legacy path — decoupled from `targetRoot`
 * (a config file can be legacy-located independently of where the DATA
 * lives), and safe to re-run: the moment the canonical file exists,
 * `resolveConfigPath` (config.ts) picks it up and this phase becomes a
 * no-op. A pre-existing canonical file is always a conflict — this phase
 * never overwrites it.
 *
 * A destination a PRIOR PHASE OF THIS SAME RUN already wrote to is never
 * replaceable (task review Critical 2): for a machine that is both
 * `legacy.vaultRoot` and `legacy.dataRoot`, the queue-move phase and
 * `flatToV2Pairs`' identity-named `queue` pair would otherwise both target
 * `<targetRoot>/queue` — the data-root loop tracks `claimedByEarlierPhase`
 * and turns any pair landing on an already-claimed destination into a
 * reported `skipped-conflict` instead of letting `isRecursivelyEmptyDir`'s
 * repair path silently delete what the queue move just did, or a non-empty
 * stray legacy queue silently merge into it.
 *
 * `flatToV2Pairs`' `migrated.json` pair is SELF-REFERENTIAL — its
 * destination (`join(targetRoot, "migrated.json")`) is the exact file this
 * command's OWN journal write (above) lands at, and that write can easily
 * happen BEFORE this pair is reached (a different pair earlier in iteration
 * order, or an entirely earlier interrupted run) — a plain rename-with-
 * conflict would then permanently deadlock every subsequent run against its
 * own receipt (task review round 2, Important). The data-root loop special-
 * cases it: MERGE the legacy journal's steps into the target instead of
 * renaming, then remove the redundant legacy file — order-independent, and
 * correct whether the target journal is fresh or already holds entries from
 * an earlier run.
 *
 * Sunset (#360): this module, and migratePathRewrite.ts with it, serve only
 * pre-0.10 flat-layout / vaultRoot installs and are removed in 1.0 — see
 * docs/configuration.md § `junco data migrate`.
 */
import {
  existsSync,
  renameSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  rmdirSync,
  statSync,
  lstatSync,
  readdirSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { Config, Paths } from "./types.js";
import {
  HEALTH_TIMEOUT_MS,
  queuePaths,
  configDeprecations,
  expandHome,
  juncoHome,
  legacyConfigPath,
  defaultUserConfigPath,
  configPathOverride,
} from "./config.js";
import { updateConfigFile, type ConfigWriteDeps } from "./configWrite.js";
import {
  migrateStateTree,
  pendingStateTreeMigrations,
  migrationTargetRoot,
  fixedLegacyRoot,
  dataRootPairs,
  isRecursivelyEmptyDir,
  pendingConfigRelocation,
  appendJournal,
  readJournal,
  type MigrateResult,
  type MigrationStep,
  type DataRootPair,
} from "./dataMigrate.js";
import {
  buildPrefixMap,
  dedupeSteps,
  rewriteStoredPaths,
  type RewriteReport,
} from "./migratePathRewrite.js";
import { acquirePidfileLock, readPidfileHolder, type PidfileLock } from "./pidfileLock.js";
import { daemonQueueClaimPath, daemonTreeClaimPath, workerLockPath } from "./lock.js";

const QUEUE_DIR_KEYS: (keyof Paths)[] = ["inbox", "processing", "done", "failed"];

/** The default (post-unification) dataDir — matches config.ts's
 * resolveDataRoot/juncoHome default. The config rewrite (`rewriteConfig`)
 * only writes an explicit top-level `dataDir` when the resolved root differs
 * from this — an operator who never customized it gets no new key. */
const DEFAULT_DATA_DIR = "~/.junco";

export interface DataMigrateDeps {
  /** /health probe fetch. Default: global fetch. */
  fetchFn?: typeof fetch;
  /** Existence probe (plan computation + pendingMigrations). Default: fs.existsSync. */
  existsFn?: (p: string) => boolean;
  /** lstat that does NOT follow the link — the only way to identify the
   * `<root>/skills` symlink mount, since `existsFn` follows links and a
   * migrated mount's target is the old package dir (so it reads as absent).
   * Throws ENOENT when the path does not exist, same contract as
   * `fs.lstatSync`. Default: the real lstatSync. */
  lstatFn?: (p: string) => { isSymbolicLink(): boolean };
  /** Rename primitive — used for the queue-dir moves, the data-root/gh-creds
   * moves, and the config.json atomic tmp+rename write. Default: fs.renameSync. */
  renameFn?: (from: string, to: string) => void;
  // NOTE (fix-wave review #283 Minor 2): these two do NOT cover the
  // watchlist. The path-rewrite phase's `rewriteWatchlistFile`
  // (migratePathRewrite.ts) reads/writes it via watchlist.ts's
  // `readWatchlist`/`writeWatchlist`, which hard-code the real `node:fs`
  // rather than accepting an injectable deps object — see `RewriteDeps`'s
  // doc comment in migratePathRewrite.ts for the full reasoning. A test
  // stubbing `readFileFn`/`writeFileFn` here will NOT intercept watchlist
  // I/O; only ticket/JSON-record I/O goes through this seam.
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  printFn?: (s: string) => void;
  /** State-tree (same-directory, old-name → new-name) migration. Default: the
   * real migrateStateTree (real fs). */
  migrateFn?: (cfg: Config) => MigrateResult;
  /** Recursive directory copy for the EXDEV fallback. Default: fs.cpSync. */
  copyDirFn?: (from: string, to: string) => void;
  /** fsync a single path (open+fsync+close) in the EXDEV fallback, so copies
   * are durable before the source is deleted (#196). Default: real fsync. */
  syncPathFn?: (p: string) => void;
  /** Daemon-pidfile liveness probe (the /health-independent "is the daemon
   * up" signal) — read-only, never mutates. Used for BOTH `worker.lock` and
   * the two shared-root claims (#310, see phase 1a). Default: the real
   * readPidfileHolder. */
  pidfileHolderFn?: (lockPath: string) => number | null;
  /** Stale-claim steal — phase 1c's sweep ONLY (#310). Deliberately the
   * ACQUIRE primitive rather than an unlink: it is what decides stale-vs-live,
   * it returns null for any claim a live process still holds (including one
   * taken between phase 1a's read and the sweep), and the `release()` that
   * follows unlinks only while the file still holds our own pid. A bare
   * `unlinkFn` here would race a daemon into existence. Default: the real
   * acquirePidfileLock — the same primitive that WROTE the claim. */
  acquireClaimFn?: (lockPath: string) => PidfileLock | null;
  /** Env driving `juncoHome(env)`/`homeOf(env)` (the single-root move target
   * and the fixed legacy-path probe). Default: process.env — same DI seam as
   * resolveBotGhConfigDir's callers. */
  env?: Record<string, string | undefined>;
  /** Directory listing (filenames only, not recursive) — used solely by the
   * post-move path-rewrite phase (migratePathRewrite.ts) to list a queue
   * dir's `*.md` tickets. No other phase needs directory listing exposed as
   * a seam (moves/copies work on whole dirs via renameFn/copyDirFn). Default:
   * fs.readdirSync. NOT the pair-move seam — see `readdirTypedFn` below. */
  readdirFn?: (p: string) => string[];
  /** Typed readdir (withFileTypes) — name taken verbatim from
   * `dataMigrate.ts`'s `MigrateDeps`/`isRecursivelyEmptyDir`, which this feeds
   * (the repair-vs-conflict verdict for a data-root destination) alongside the
   * EXDEV fallback's recursive file listing. Distinct from `readdirFn` above
   * in both shape and scope, hence the distinct name; `isFile()` widens
   * `MigrateDeps`' version because the copy listing needs to count only real
   * files (a symlink is neither a directory nor a file to copy-verify).
   * Default: readdirSync(d, { withFileTypes: true }).
   *
   * REQUIRED of any stub: it MUST throw an `ENOTDIR`-coded error when `d` is
   * not a directory, exactly as the real `readdirSync` does. That throw is
   * load-bearing, not incidental. `isRecursivelyEmptyDir` (dataMigrate.ts)
   * converts ENOTDIR — and only ENOTDIR — into `false` = "not empty" =
   * conflict, and that conversion is the ONLY thing standing between phase 9
   * (`moveDataRootPair(configPath, canonicalConfigPath, fs)`, which hands
   * this seam a FILE) and repair-DELETING an existing canonical
   * `config.json`. A stub that answers `[]` for every path — the natural
   * shape, and all a directory-only fixture needs — makes that file look
   * recursively empty and turns the receipted "never overwritten" guarantee
   * into a silent delete of the operator's live config. (Throwing some other
   * error is wrong in the opposite direction: any non-ENOTDIR code
   * propagates and aborts the run.) */
  readdirTypedFn?: (
    d: string,
  ) => Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  /** stat for the EXDEV copy verification. Must keep answering BOTH
   * `isDirectory()` — verifyCopyPath/fsyncCopiedPath dispatch a directory pair
   * from a file pair, and phase 9's config relocation passes a FILE — and
   * `size`, the per-file byte-count verify. Default: fs.statSync. */
  statFn?: (p: string) => { isDirectory(): boolean; size: number };
  /** Removal primitive for the destructive rms of the move: the repair of an
   * empty scaffolding destination, the EXDEV fallback's source delete (plus
   * the queue move's own EXDEV source delete), and the data-root loop's
   * removal of a legacy `migrated.json` whose steps it just merged into the
   * target journal. Name taken verbatim from
   * `MigrateDeps.rmFn`. Options come from the CALL SITE and the default
   * forwards them unchanged — `force: true` is NEVER defaulted in, or the
   * ENOENT that today signals a real bug in the repair path would be silently
   * swallowed. Default: fs.rmSync. */
  rmFn?: (p: string, opts: { recursive?: boolean; force?: boolean }) => void;
  /** `mkdir -p` of a moved pair's parent directory (flatToV2Pairs' targets
   * scatter across data/, cache/, logs/). Default: fs.mkdirSync. */
  mkdirFn?: (p: string, opts: { recursive: true }) => void;
  /** Single-entry unlink — phase 7's legacy-root cleanup ONLY: junco's own
   * scaffolded `.gitignore` and the `skills` SYMLINK mount, the two entries
   * `flatToV2Pairs` has no pair for and which would otherwise make the rmdir
   * below fail ENOTEMPTY on every real machine. Deliberately NOT folded into
   * `rmFn`: `rmSync` is a different primitive (it lstats and dispatches), and
   * these two calls must keep `unlinkSync`'s semantics verbatim. Routed for
   * the same reason every other destructive op in this module is (see
   * `MoveFsDeps`): a test that stubs the removal seam and takes the real
   * filesystem to be protected would otherwise unlink the REAL
   * `~/.local/state/junco/.gitignore` and skills mount the moment its fixture
   * makes `fixedLegacyRoot` non-null. Default: fs.unlinkSync. */
  unlinkFn?: (p: string) => void;
  /** Plain, NON-recursive rmdir of the emptied legacy root (phase 7). Also
   * deliberately not `rmFn`: `rmSync(p, {})` throws ERR_FS_EISDIR on a
   * directory (empty or not), and `rmSync(p, {recursive:true})` would delete
   * a legacy root that still holds a conflicted pair — whereas the whole
   * point of this call is that it refuses (ENOTEMPTY) and the receipt lists
   * what stayed. Default: fs.rmdirSync. */
  rmdirFn?: (p: string) => void;
}

/**
 * The filesystem seam the data-root pair move runs on — `moveDataRootPair`
 * and the EXDEV copy/verify/fsync helpers it shares with the queue-move
 * phase. Every member is a destructive or destructive-adjacent op, so all of
 * them are injectable together: a PARTIAL seam is worse than none here (stub
 * `existsFn` alone and the untouched `readdirSync` below it throws ENOENT), and
 * the error paths are unreachable from a test otherwise. Names are copied
 * verbatim from `dataMigrate.ts`'s `MigrateDeps` wherever that interface
 * already spells the same operation (`rmFn`, `readdirTypedFn`) — one
 * vocabulary per operation across both modules, deliberately.
 *
 * Scope note (final review 2026-08-22, F4): this bundle covers the PAIR MOVE.
 * The command's other destructive calls are seamed too, but as their own
 * `DataMigrateDeps` members rather than here — `unlinkFn`/`rmdirFn` for phase
 * 7's legacy-root cleanup, because neither is an `rmSync` and folding them in
 * would change what they do. A test that means "the real filesystem cannot be
 * touched" has to stub those two as well as these.
 */
interface MoveFsDeps {
  existsFn: (p: string) => boolean;
  renameFn: (from: string, to: string) => void;
  copyDirFn: (from: string, to: string) => void;
  syncPathFn: (p: string) => void;
  readdirTypedFn: (d: string) => Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  statFn: (p: string) => { isDirectory(): boolean; size: number };
  rmFn: (p: string, opts: { recursive?: boolean; force?: boolean }) => void;
  mkdirFn: (p: string, opts: { recursive: true }) => void;
}

interface QueueStep {
  key: keyof Paths;
  from: string;
  to: string;
}

/** Single AbortController-timed /health probe — same shape as
 * worktreePruneCmd.ts's fetchCurrentTickets, but the verdict differs: ANY
 * settled response (even non-200) means "up" here, since this probe's only
 * job is "is anything listening", not "what tickets are in flight". Only a
 * network error/timeout/abort means "proceed". */
async function daemonIsUp(cfg: Config, fetchFn: typeof fetch): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every shared-root daemon claim (#310) this run has to care about: the two
 * claims `junco start` takes, spelled for each root this command may read or
 * write.
 *
 * ONE list, TWO uses — phase 1a probes it for a live holder (refuse), phase 1c
 * sweeps the provably-stale ones (repair). A second spelling of "which claims
 * matter" would let the two drift into disagreeing about the same file.
 *
 * The root set mirrors phase 1b's `lockRoots` and for the same reason: on a
 * cross-root move a daemon that has already flipped its own resolution to the
 * target holds its claims THERE, not at this run's `cfg.dataDir`. `queueRoot`
 * is carried separately from the data roots because a legacy `vaultRoot` puts
 * it outside every data root; the per-root `<root>/queue` spelling is the
 * default layout, which is what `targetRoot`/`legacyRoot` are by construction
 * (and exactly the `join(targetRoot, "queue")` destination the queue phase and
 * `flatToV2Pairs` both land on).
 */
function daemonClaimPaths(
  cfg: Pick<Config, "dataDir" | "queueRoot">,
  targetRoot: string,
  legacyRoot: string | null,
): string[] {
  const paths = new Set<string>([
    daemonTreeClaimPath(cfg.dataDir),
    daemonQueueClaimPath(cfg.queueRoot),
  ]);
  for (const root of [targetRoot, legacyRoot]) {
    if (root === null) continue;
    paths.add(daemonTreeClaimPath(root));
    paths.add(daemonQueueClaimPath(join(root, "queue")));
  }
  return [...paths].sort();
}

/**
 * Phase 1c's stale-claim sweep — returns the paths actually cleared.
 *
 * `existsFn` gates every path so this can only ever REMOVE: it never creates a
 * claim file, and never mkdirs a parent, at a root that has none (which
 * `acquirePidfileLock` would do on its own, fabricating `<targetRoot>/queue`
 * on a machine that has never had one).
 *
 * Staleness is not judged here — `acquireClaimFn` is. It returns null for any
 * claim whose recorded owner is still alive, so a running daemon's claim is
 * untouchable even under `--force` (which skips phase 1a's refusal entirely),
 * and it steals only via the atomic rename-aside + post-move verification that
 * cannot destroy a racing winner's fresh lock. The `release()` that follows
 * unlinks only while the file still holds our own pid.
 */
function sweepStaleDaemonClaims(
  claimPaths: string[],
  existsFn: (p: string) => boolean,
  acquireClaimFn: (lockPath: string) => PidfileLock | null,
): string[] {
  const cleared: string[] = [];
  for (const claim of claimPaths) {
    if (!existsFn(claim)) continue;
    const stolen = acquireClaimFn(claim);
    if (stolen === null) continue; // a live process holds it — never touch
    stolen.release();
    cleared.push(claim);
  }
  return cleared;
}

/** The queue-move plan: empty when `legacy.vaultRoot` is unset — the queue
 * already lives at `<targetRoot>/queue` (or will, via `flatToV2Pairs`'
 * identity-named `queue` pair — see `dataRootPairs`). When `vaultRoot` IS
 * set, `cfg.queueRoot` IS the legacy root (`<vaultRoot>/<juncoSubdir>`), so
 * `queuePaths(cfg)` hands back the four legacy source paths directly, and
 * they land at `<targetRoot>/queue` regardless of whether the rest of the
 * tree is also relocating this run. */
function queueSteps(cfg: Config, targetRoot: string): QueueStep[] {
  if (!cfg.legacy.vaultRoot) return [];
  const legacy = queuePaths(cfg);
  const queueRoot = join(targetRoot, "queue");
  return QUEUE_DIR_KEYS.map((key) => ({ key, from: legacy[key], to: join(queueRoot, key) }));
}

/** The bot gh-creds move: only when the resolved `botAccount.configDir` is
 * itself the legacy `~/.config/junco/gh` fallback (config.ts's
 * `resolveBotGhConfigDir` — `cfg.legacy.ghConfigDir`). The target is always
 * `juncoHome(env)/gh` regardless of whether the DATA root is also moving —
 * gh creds have their own independent legacy path, unrelated to dataDir. */
function ghPair(
  cfg: Config,
  env: Record<string, string | undefined>,
  existsFn: (p: string) => boolean,
): DataRootPair | null {
  if (!cfg.legacy.ghConfigDir) return null;
  const from = cfg.botAccount.configDir; // resolved to the legacy dir on this machine
  const to = join(juncoHome(env), "gh");
  return { from, to, pending: existsFn(from) };
}

function listFilesRecursive(root: string, fs: MoveFsDeps): string[] {
  const out: string[] = [];
  for (const e of fs.readdirTypedFn(root)) {
    const full = join(root, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full, fs).map((r) => join(e.name, r)));
    else if (e.isFile()) out.push(e.name);
  }
  return out;
}

/** Per-file size verification after an EXDEV recursive-copy fallback — the
 * source is only deleted once every file lands on the other side with a
 * matching byte count. Throws (never swallows) so the caller's generic
 * error handling reports it and the untouched source stays exactly where
 * it was. Directory-only (queue's four dirs are always directories). */
function verifyCopy(from: string, to: string, fs: MoveFsDeps): void {
  for (const rel of listFilesRecursive(from, fs)) {
    const srcSize = fs.statFn(join(from, rel)).size;
    let dstSize: number;
    try {
      dstSize = fs.statFn(join(to, rel)).size;
    } catch {
      throw new Error(`EXDEV copy verification failed — missing ${join(to, rel)}`);
    }
    if (dstSize !== srcSize) {
      throw new Error(`EXDEV copy verification failed — size mismatch for ${rel}`);
    }
  }
}

/** #196: fsync every copied file and the destination directories after an
 * EXDEV copy+verify, BEFORE the source is deleted. Without this, a power loss
 * in the window between the size verify and the page-cache flush can leave
 * truncated copies after the source is already gone — the one command whose
 * job is moving ticket files. The design spec (§11) calls for
 * copy+fsync+verify+delete; the size verify still runs first (above).
 * Directory-only. */
function fsyncCopied(to: string, fs: MoveFsDeps): void {
  const dirs = new Set<string>([to]);
  for (const rel of listFilesRecursive(to, fs)) {
    const full = join(to, rel);
    fs.syncPathFn(full);
    dirs.add(dirname(full));
  }
  for (const d of dirs) fs.syncPathFn(d);
}

/** `verifyCopy`/`fsyncCopied` assume a directory pair (queue's four dirs are
 * always directories). `flatToV2Pairs`' pairs are a mix — most are
 * directories (outbox, clones, ...) but several are single files
 * (watchlist.json, spend.json, worker.log, ...). These wrappers dispatch on
 * `from`'s type so the same EXDEV fallback machinery (copy → verify → fsync →
 * delete-source, #196) covers both shapes without duplicating it. */
function verifyCopyPath(from: string, to: string, fs: MoveFsDeps): void {
  if (fs.statFn(from).isDirectory()) {
    verifyCopy(from, to, fs);
    return;
  }
  const srcSize = fs.statFn(from).size;
  let dstSize: number;
  try {
    dstSize = fs.statFn(to).size;
  } catch {
    throw new Error(`EXDEV copy verification failed — missing ${to}`);
  }
  if (dstSize !== srcSize) {
    throw new Error(`EXDEV copy verification failed — size mismatch for ${to}`);
  }
}

function fsyncCopiedPath(to: string, fs: MoveFsDeps): void {
  if (fs.statFn(to).isDirectory()) {
    fsyncCopied(to, fs);
    return;
  }
  fs.syncPathFn(to);
  fs.syncPathFn(dirname(to));
}

/**
 * Item 2 (#281) — raised when the EXDEV fallback dies anywhere between the
 * first copied byte and the last fsync. The distinction it carries is the
 * whole point: in THIS window the source has provably not been touched (the
 * only statement that removes it runs after, and only after, a verified and
 * fsynced copy), while the destination may hold anything from nothing to a
 * complete-but-unflushed tree. Both facts are what the caller needs to say
 * something true, so they travel with the error rather than being re-derived.
 *
 * Deliberately NOT raised for a failure of the source delete that follows:
 * there the destination is a COMPLETE, verified copy and the source is the
 * half-removed side, so the operator's correct response is the exact opposite
 * (keep the destination, clear the source remnant). Calling both "a partial
 * copy" would send them to delete the wrong side of a move.
 */
class PartialCopyError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly reason: unknown,
  ) {
    super(
      `cross-device copy ${from} -> ${to} failed partway — a partial copy may ` +
        `remain at ${to}; ${from} was left untouched: ${describeError(reason)}`,
    );
    this.name = "PartialCopyError";
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The receipt line for a pair whose cross-device copy was interrupted —
 * pushed BEFORE the error propagates (the same receipt-then-journal order the
 * data-root loop and phase 9 use), because the catch-path receipt is the
 * operator's record of a run that never reached its end. `hint` is the
 * caller's site-specific next step: the two sides of an interrupted copy are
 * not interchangeable, so what to remove has to be named. */
function partialCopyReceiptLine(e: PartialCopyError, hint: string): string {
  return (
    `${e.from} -> ${e.to}: cross-device copy INTERRUPTED — a partial copy may ` +
    `remain at ${e.to}; the source at ${e.from} was NOT touched. ${hint} ` +
    `(${describeError(e.reason)})`
  );
}

/** Does the durable journal say THIS destination is an earlier run's partial
 * copy rather than genuine pre-existing data (item 2, #281)? The two produce
 * the same `skipped-conflict` from `moveDataRootPair` — it only sees a
 * non-empty destination — but demand opposite responses from the operator, so
 * the difference has to come from the record of what actually happened.
 *
 * A later "renamed" for the same pair SUPERSEDES the partial-copy record: once
 * the pair has genuinely moved (operator cleared the wreckage, re-ran, it
 * landed), any FUTURE conflict at that destination is a new, ordinary one and
 * must not inherit the old story. Repeated `skipped-conflict` steps — which
 * run 2 itself journals — are ignored on purpose, so the hint survives every
 * re-run until the move actually completes. */
function destinationHoldsPartialCopy(steps: MigrationStep[], from: string, to: string): boolean {
  let partial = false;
  for (const s of steps) {
    if (s.from !== from || s.to !== to) continue;
    if (s.action === "partial-copy") partial = true;
    else if (s.action === "renamed") partial = false;
  }
  return partial;
}

/** The conflict line for a destination that exists and is not empty. Says
 * WHICH kind of obstruction it is when the journal knows (item 2, #281): a
 * partial copy means the source is the authoritative side and the destination
 * is junco's own wreckage; the ordinary case means real data sits at both ends
 * and only the operator can decide. */
function conflictLine(from: string, to: string, partial: boolean, journalFile: string): string {
  return partial
    ? `${from} -> ${to}: destination holds a partial copy from an interrupted ` +
        `cross-device move (recorded in ${journalFile}) — the source at ${from} ` +
        `is intact; remove the partial destination, then re-run`
    : `${from} -> ${to}: destination already exists and is not empty`;
}

/** Move one flat→v2 (or gh-creds) pair, reusing the queue move's EXDEV
 * copy+verify+fsync fallback and `migrateStateTree`'s `isRecursivelyEmptyDir`
 * conflict semantics: a destination that doesn't exist is taken outright; one
 * that exists and holds directories only (dataTree.ts scaffolding —
 * `ensureDataTree` may have already materialized empty v2 dirs) is repaired
 * (removed, then taken); one holding any file anywhere (or that is itself a
 * file — the watchlist/spend/etc. pairs) is a conflict, reported and left
 * untouched on both sides. mkdirs `dirname(to)` per pair since, unlike the
 * queue's four same-parent keys, `flatToV2Pairs`' targets scatter across
 * data/, cache/, logs/. Callers must check `claimedByEarlierPhase` BEFORE
 * calling this (Critical 2) — this function has no way to know a destination
 * was legitimately populated by an earlier phase of the SAME run rather than
 * being inert scaffolding, so it would otherwise repair-and-delete it.
 *
 * Every fs primitive comes from `fs` (MoveFsDeps) — nothing here reaches
 * `node:fs` directly. The two `rmFn` calls keep the options they have always
 * had and are deliberately different: the repair below is NOT forced, so an
 * ENOENT there still surfaces as the bug it would be, while the EXDEV source
 * delete keeps the `force` it needs for a source already partly gone. */
function moveDataRootPair(
  from: string,
  to: string,
  fs: MoveFsDeps,
): "moved" | "copied" | "skipped-conflict" {
  if (fs.existsFn(to)) {
    if (isRecursivelyEmptyDir(to, fs.readdirTypedFn)) {
      fs.rmFn(to, { recursive: true });
    } else {
      return "skipped-conflict";
    }
  }
  fs.mkdirFn(dirname(to), { recursive: true });
  try {
    fs.renameFn(from, to);
    return "moved";
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EXDEV") {
      // The partial-copy window (item 2, #281). A throw anywhere in these
      // three statements leaves whatever landed at `to` sitting there, and the
      // caller's generic error handling could only report the raw fs error —
      // so the pair never reached the receipt OR the journal, and every LATER
      // run saw nothing but a populated destination it had no way to explain.
      // Wrapping tells the caller what state it is in; the source delete
      // BELOW is deliberately outside the window (see PartialCopyError).
      try {
        fs.copyDirFn(from, to);
        verifyCopyPath(from, to, fs);
        fsyncCopiedPath(to, fs); // #196: durable before deleting source
      } catch (copyErr) {
        throw new PartialCopyError(from, to, copyErr);
      }
      fs.rmFn(from, { recursive: true, force: true });
      return "copied";
    }
    throw e;
  }
}

/** Read → mutate → validate → atomic tmp+rename write of the RAW config.json
 * (updateConfigFile, configWrite.ts — the same path `junco config set`
 * takes). Deleting `juncoSubdir` always accompanies `vaultRoot` —
 * the pair is meaningless without each other. Deleting
 * `observability.stateDir` deletes an emptied `observability` object too,
 * rather than leaving a stray `"observability": {}` behind. `dataDir` is
 * compared/written against `targetRoot` (NOT `cfg.dataDir`, which is the
 * PRE-migration location) — a legacy-fallback machine's data no longer lives
 * at `cfg.dataDir` once this command returns (it was just relocated, and the
 * now-empty legacy root removed), so writing the old path back would point
 * the next `loadConfig` at nothing. Only written when it differs from the
 * expanded default, so an operator who never customized it gets no new
 * top-level key. Returns the list of human-readable changes made (empty when
 * nothing needed changing). */
function rewriteConfig(configPath: string, targetRoot: string, deps: ConfigWriteDeps): string[] {
  const receipt: string[] = [];
  updateConfigFile(
    configPath,
    (raw) => {
      if ("vaultRoot" in raw || "juncoSubdir" in raw) {
        delete raw.vaultRoot;
        delete raw.juncoSubdir;
        receipt.push("removed vaultRoot/juncoSubdir — queue now lives under dataDir");
      }

      const obs = raw.observability;
      if (obs !== null && typeof obs === "object" && !Array.isArray(obs) && "stateDir" in obs) {
        const obsRec = obs as Record<string, unknown>;
        delete obsRec.stateDir;
        if (Object.keys(obsRec).length === 0) delete raw.observability;
        receipt.push("removed observability.stateDir — use top-level dataDir");
      }

      const defaultDataDir = expandHome(DEFAULT_DATA_DIR);
      if (targetRoot !== defaultDataDir) {
        raw.dataDir = targetRoot;
        receipt.push(`set dataDir = ${targetRoot}`);
      }
    },
    deps,
  );
  return receipt;
}

/** Receipt sections stay honest on the catch path: a state-tree phase that
 * never ran prints "not attempted"; one whose `migrateFn` threw MID-RUN prints
 * "interrupted" and points at `stateTreeJournalFile` — `join(cfg.dataDir,
 * "migrated.json")`, where `migrateStateTree` ACTUALLY writes (task review
 * Important 4: NOT the target root's journal — phase 4 runs before the
 * data-root move ever gets a chance to relocate it, so on a cross-root
 * machine the target's migrated.json may not exist yet at this point); a
 * config rewrite that never completed prints "not rewritten (error)" rather
 * than the false "no changes needed". The `data root:`/`gh config:`/`config:`
 * sections are built incrementally by the caller (pushed as each pair
 * completes), so a throw mid-loop leaves them holding exactly the pairs that
 * landed — no separate "interrupted" sentinel needed (their OWN durable
 * receipt is the journal at the target root, appended in a `finally` — see
 * runDataMigrate). `configMoveReceipt` (I-2) is separate from `configReceipt`
 * — the former is the config FILE's relocation (legacy XDG -> canonical
 * ~/.junco/config.json), the latter is the content rewrite at whatever path
 * it currently lives. `explicitlyNamedLegacyConfigPath` (non-null only when
 * JUNCO_CONFIG names exactly the legacy path — see runDataMigrate) makes the
 * empty-configMoveReceipt case say WHY nothing moved instead of the bare
 * "nothing to relocate", which would otherwise read as though the legacy path
 * it's still sitting at were canonical. `rewriteReport` (task-2, #283) is
 * printed right after gh config — it always holds the ZERO value
 * ({rewritten:0, ...}) on a run that never reached that phase (an earlier
 * throw), so "nothing rewritten" is honest rather than a lie by omission,
 * same discipline every other section here follows. */
function printReceipt(
  print: (s: string) => void,
  queueReceipt: string[],
  state: MigrateResult | "not-run" | "interrupted",
  dataRootReceipt: string[],
  dataRootConflicts: string[],
  ghReceipt: string[],
  ghConflicts: string[],
  rewriteReport: RewriteReport,
  configReceipt: string[] | null,
  configMoveReceipt: string[],
  explicitlyNamedLegacyConfigPath: string | null,
  stateTreeJournalFile: string,
): void {
  print("junco data migrate: receipt\n");
  print(
    queueReceipt.length > 0
      ? `\nqueue:\n${queueReceipt.map((l) => `  ${l}`).join("\n")}\n`
      : "\nqueue: nothing to move\n",
  );
  if (state === "not-run") {
    print("\nstate tree: not attempted\n");
  } else if (state === "interrupted") {
    // "any completed steps": accurate even when the throw came before the
    // first pair completed and the journal holds nothing from this run.
    print(
      `\nstate tree: interrupted — any completed steps are journaled in ${stateTreeJournalFile}\n`,
    );
  } else {
    const acted = state.steps.filter((s) => s.action !== "noop");
    print(
      acted.length > 0
        ? `\nstate tree:\n${acted.map((s) => `  ${s.from} -> ${s.to}: ${s.action}`).join("\n")}\n`
        : "\nstate tree: nothing pending\n",
    );
    if (state.conflicts.length > 0) {
      print(`\nstate-tree conflicts:\n${state.conflicts.map((c) => `  ${c}`).join("\n")}\n`);
    }
  }
  print(
    dataRootReceipt.length > 0
      ? `\ndata root:\n${dataRootReceipt.map((l) => `  ${l}`).join("\n")}\n`
      : "\ndata root: nothing to move\n",
  );
  if (dataRootConflicts.length > 0) {
    print(`\ndata-root conflicts:\n${dataRootConflicts.map((c) => `  ${c}`).join("\n")}\n`);
  }
  print(
    ghReceipt.length > 0
      ? `\ngh config:\n${ghReceipt.map((l) => `  ${l}`).join("\n")}\n`
      : "\ngh config: nothing to move\n",
  );
  if (ghConflicts.length > 0) {
    // Item 1 (#281): its own heading — a gh-creds conflict is a different
    // subsystem from a data-root one, and used to print under
    // "data-root conflicts:" above, which told the operator the wrong thing
    // conflicted.
    print(`\ngh config conflicts:\n${ghConflicts.map((c) => `  ${c}`).join("\n")}\n`);
  }
  print(
    rewriteReport.rewritten > 0
      ? `\npath rewrite:\n  ${rewriteReport.rewritten} path(s) rewritten across ${rewriteReport.files.length} file(s)\n` +
          rewriteReport.files.map((f) => `  ${f}`).join("\n") +
          "\n"
      : "\npath rewrite: nothing to rewrite\n",
  );
  if (rewriteReport.warnings.length > 0) {
    print(`\npath-rewrite warnings:\n${rewriteReport.warnings.map((w) => `  ${w}`).join("\n")}\n`);
  }
  if (configReceipt === null) {
    print("\nconfig.json: not rewritten (error)\n");
  } else {
    print(
      configReceipt.length > 0
        ? `\nconfig.json:\n${configReceipt.map((l) => `  ${l}`).join("\n")}\n`
        : "\nconfig.json: no changes needed\n",
    );
  }
  print(
    configMoveReceipt.length > 0
      ? `\nconfig:\n${configMoveReceipt.map((l) => `  ${l}`).join("\n")}\n`
      : explicitlyNamedLegacyConfigPath !== null
        ? `\nconfig: nothing to relocate — JUNCO_CONFIG explicitly names ` +
          `${explicitlyNamedLegacyConfigPath}, which is never relocated\n`
        : "\nconfig: nothing to relocate\n",
  );
}

export async function runDataMigrate(
  cfg: Config,
  configPath: string,
  opts: { dryRun: boolean; force: boolean },
  deps: DataMigrateDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const fetchFn = deps.fetchFn ?? fetch;
  const existsFn = deps.existsFn ?? existsSync;
  const lstatFn = deps.lstatFn ?? lstatSync;
  const renameFn = deps.renameFn ?? renameSync;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const migrateFn = deps.migrateFn ?? ((c: Config) => migrateStateTree(c));
  const copyDirFn =
    deps.copyDirFn ?? ((from: string, to: string) => cpSync(from, to, { recursive: true }));
  const syncPathFn =
    deps.syncPathFn ??
    ((p: string) => {
      // Directories are fsync'd too (metadata durability); openSync("r")
      // works on both files and dirs on POSIX, the only place EXDEV applies.
      const fd = openSync(p, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });
  const pidfileHolderFn = deps.pidfileHolderFn ?? readPidfileHolder;
  const acquireClaimFn = deps.acquireClaimFn ?? ((p: string) => acquirePidfileLock(p));
  const env = deps.env ?? process.env;
  const readdirFn = deps.readdirFn ?? ((p: string) => readdirSync(p));
  // Bound out here rather than inline in `fs` below because the data-root
  // loop's journal-merge removal is the one `rmFn` call site OUTSIDE
  // `moveDataRootPair` (same operation, same seam key, one binding).
  const rmFn =
    deps.rmFn ?? ((p: string, o: { recursive?: boolean; force?: boolean }) => rmSync(p, o));
  // Phase 7's own removals — not part of the pair move, and not `rmSync`
  // (see their DataMigrateDeps doc comments for why neither can be folded
  // into `rmFn` without changing what it does).
  const unlinkFn = deps.unlinkFn ?? ((p: string) => unlinkSync(p));
  const rmdirFn = deps.rmdirFn ?? ((p: string) => rmdirSync(p));
  // The pair-move filesystem seam (see MoveFsDeps). Each default is the exact
  // call the code made inline before it was injectable — `rmFn` forwards the
  // CALLER's options verbatim rather than defaulting any in, so the repair rm
  // stays unforced.
  const fs: MoveFsDeps = {
    existsFn,
    renameFn,
    copyDirFn,
    syncPathFn,
    readdirTypedFn: deps.readdirTypedFn ?? ((d: string) => readdirSync(d, { withFileTypes: true })),
    statFn: deps.statFn ?? ((p: string) => statSync(p)),
    rmFn,
    mkdirFn: deps.mkdirFn ?? ((p: string, o: { recursive: true }) => mkdirSync(p, o)),
  };

  // The single-root move target (see the module doc comment). Computed once
  // and threaded through every phase below, along with the fixed legacy path
  // this run should ALSO probe/lock/clean up (Critical 1 / Important 3) —
  // null when targetRoot isn't the canonical root at all (an explicit,
  // unrelated dataDir never has `~/.local/state/junco` swept in).
  const targetRoot = migrationTargetRoot(cfg, env);
  const legacyRoot = fixedLegacyRoot(targetRoot, env);
  // I-2: whether THIS run's config lives at the legacy XDG path — decoupled
  // from targetRoot/legacyRoot (data-root state), see the module doc comment.
  //
  // An EXPLICITLY-NAMED config (JUNCO_CONFIG, #275) is never relocated: an
  // operator who named a config does not want it silently moved, and moving
  // it would break every subsequent command in that same environment (ENOENT
  // on the named path; bare `junco` would open the setup wizard instead). The
  // override check is the guard, and it is NOT redundant with the legacy-path
  // equality: JUNCO_CONFIG accepts any value, including exactly the legacy
  // path, so `JUNCO_CONFIG=~/.config/junco/config.json junco data migrate` on
  // a pre-0.10 install would otherwise fire the relocation phase.
  //
  // Both halves now live in ONE place — `pendingConfigRelocation`
  // (dataMigrate.ts) — because `junco doctor` and `junco data` report this
  // same pending relocation (item 11, #281) and a second spelling of the
  // guard in the reporters would drift from the mover's: they would warn
  // about a relocation this phase correctly refuses to perform, forever.
  const configIsExplicitlyNamed = configPathOverride(env) !== undefined;
  const canonicalConfigPath = defaultUserConfigPath(env);
  const configPathIsLegacy = pendingConfigRelocation(configPath, env) !== null;
  // The confusing case the guard above creates: JUNCO_CONFIG names a path
  // that happens to equal the legacy one, so configPathIsLegacy is (correctly)
  // false — but "no relocation needed (already at <legacy path>)" would then
  // read as though the legacy path were canonical, with no hint that
  // JUNCO_CONFIG is why. Both receipt sites (dry-run below, and printReceipt's
  // acting-phase summary) branch on this to say so explicitly.
  const configIsExplicitlyNamedLegacy =
    configIsExplicitlyNamed && configPath === legacyConfigPath(env);

  // The shared-root claims to probe (1a) and later sweep (1c) — see
  // `daemonClaimPaths`. Computed once, after targetRoot/legacyRoot, so both
  // phases ask about exactly the same files.
  const claimPaths = daemonClaimPaths(cfg, targetRoot, legacyRoot);

  // 1a. Daemon-up refusal — every signal skipped entirely by --force.
  if (!opts.force) {
    if (await daemonIsUp(cfg, fetchFn)) {
      print(
        `junco data migrate: refusing — the daemon appears to be running ` +
          `(http://${cfg.healthHost}:${cfg.healthPort}/health responded). ` +
          `Stop it first, or pass --force to skip this check.\n`,
      );
      return 1;
    }
    // A health-disabled daemon never answers the probe — check its
    // single-instance pidfile instead. Same path derivation as `junco start`
    // (cli.ts): the lock lives next to config.json, not under dataDir.
    const workerLock = workerLockPath(configPath);
    const holder = pidfileHolderFn(workerLock);
    if (holder !== null) {
      print(
        `junco data migrate: refusing — the daemon appears to be running ` +
          `(pid ${holder} holds ${workerLock}). ` +
          `Stop it first, or pass --force to skip this check.\n`,
      );
      return 1;
    }
    // The shared-root claims (#310) — a THIRD signal, deliberately ADDITIVE to
    // the worker.lock read above rather than a replacement.
    //
    // `worker.lock` sits beside the config file THIS command resolved, so
    // under a `JUNCO_CONFIG` override (or any two configs naming one tree) the
    // read above probes a file no daemon has ever written and the guard
    // silently misses — while migrate mutates the tree underneath a live,
    // health-disabled daemon, which is precisely the case the pidfile half
    // exists to catch (#310's second symptom). The claims live in the SHARED
    // state instead — the data root and the queue root — the only rendezvous
    // two daemons that disagree about the config path still agree on.
    //
    // Both generations are kept because each sees what the other cannot:
    // during an upgrade window an OLD-binary daemon takes `worker.lock` and no
    // claim at all, so dropping that read would re-open the exact gap this
    // closes; afterwards the claims catch the peer that resolved a different
    // config. Order is oldest-signal-first and short-circuits, so an
    // old-binary daemon still produces today's message verbatim.
    for (const claim of claimPaths) {
      const claimHolder = pidfileHolderFn(claim);
      if (claimHolder !== null) {
        print(
          `junco data migrate: refusing — a junco daemon appears to be running ` +
            `(pid ${claimHolder} holds ${claim}). That claim sits in the shared ` +
            `tree, so that daemon may have resolved a DIFFERENT config file than ` +
            `this command did — its own worker.lock is somewhere this process ` +
            `cannot see. Stop it first, or pass --force to skip this check.\n`,
        );
        return 1;
      }
    }
  }

  // 2. Plan — read-only (existsFn probes only), so it runs BEFORE the lock:
  // a dry-run is not a run, and acquirePidfileLock mkdirs each lock root as a
  // side effect, which would fabricate targetRoot on a machine that has
  // never had one — exactly the command's primary audience.
  const qSteps = queueSteps(cfg, targetRoot).map((s) => ({ ...s, pending: existsFn(s.from) }));
  // The state-tree-only pending list (NOT the broader `pendingMigrations`,
  // which also folds in the layout/root pairs below — those already get
  // their own "data root:" section via `dataRootAll`; reusing the broader
  // helper here would print them twice). Shared with `pendingMigrations`'s
  // own state-tree half via `pendingStateTreeMigrations` (dataMigrate.ts) —
  // one filter, not two copies.
  const pending = pendingStateTreeMigrations(cfg, existsFn);
  const dataRootAll = dataRootPairs(cfg, targetRoot, legacyRoot, existsFn);
  const gh = ghPair(cfg, env, existsFn);
  const defaultDataDir = expandHome(DEFAULT_DATA_DIR);
  const willSetDataDir = targetRoot !== defaultDataDir;
  const deprecations = configDeprecations(cfg);
  // Where the data-root/gh journal lands (Critical 1) — used by dry-run's
  // informational line. `stateTreeJournalFile` (Important 4) is separate and
  // computed further down, once we're past the dry-run early return.
  const migratedFile = join(targetRoot, "migrated.json");
  // The vaultRoot queue move's eventual destination — used both for the
  // dry-run hint and (in the acting run) to detect the Critical 2 collision.
  const vaultQueueTarget = join(targetRoot, "queue");

  if (opts.dryRun) {
    print("junco data migrate: plan (dry-run — no changes made)\n");
    for (const d of deprecations) print(`  ${d}\n`);
    if (qSteps.length === 0) {
      print("\nqueue: already unified — no vaultRoot override\n");
    } else {
      print("\nqueue:\n");
      for (const s of qSteps) {
        print(`  ${s.key}: ${s.from} -> ${s.to}${s.pending ? "" : " (nothing to move)"}\n`);
      }
    }
    if (pending.length === 0) {
      print("\nstate tree: nothing pending\n");
    } else {
      print("\nstate tree:\n");
      // Item 4 (#281) investigation: unlike `flatToV2Pairs` (dataMigrate.ts:127
      // filters `p.from !== p.to`), `stateTreeMigrations` carries no identity
      // filter of its own — but it does not need one. Every one of its six
      // pairs hardcodes a DIFFERENT literal old-name and v2-shaped subpath
      // (e.g. "github-outbox" -> outbox's `L.outbox` ["outbox"|"data/outbox"],
      // "repos" -> clonesWatched's ["clones/watched"|"cache/clones/watched"]),
      // so `from === to` is not just untriggered by today's fixtures, it is
      // structurally unreachable for ANY Config: no combination of
      // `cfg.dataLayout`/`cfg.github`/`cfg.legacy` can make an old flat name
      // collide with its own v2 destination string. Confirmed by exhaustive
      // reading of `stateTreeMigrations` (dataMigrate.ts) and `dataTreePaths`
      // (dataTree.ts) — an `x -> x` identity arrow here is dead code, so none
      // is added to guard against it.
      for (const p of pending) print(`  ${p.from} -> ${p.to}\n`);
    }
    if (!dataRootAll.some((p) => p.pending)) {
      print("\ndata root: already unified — no legacy root or flat layout to move\n");
    } else {
      print(`\ndata root: ${cfg.dataDir} -> ${targetRoot}\n`);
      for (const p of dataRootAll) {
        const isVaultQueueCollision =
          qSteps.some((s) => s.pending) && p.to === vaultQueueTarget && p.pending;
        const suffix = isVaultQueueCollision
          ? " (stray — the vaultRoot queue move owns this destination; will be reported as a conflict, never merged)"
          : // Item 6 (#281): the other data root holds this pair too. Same
            // shape of promise as the vaultRoot collision above — the acting
            // run reports it, it never moves.
            p.contendedBy !== undefined
            ? ` (contended — ${p.contendedBy} holds this pair too and takes the destination; will be reported as a conflict, never merged)`
            : p.pending
              ? ""
              : " (nothing to move)";
        print(`  ${p.from} -> ${p.to}${suffix}\n`);
      }
      // Item 4 (#281): gated on `existsFn`, matching phase 7's own acting-run
      // condition (`legacyRoot !== null && existsFn(legacyRoot)`) below —
      // `legacyRoot !== null` alone only says the TARGET resolves to the
      // canonical `~/.junco` (see `fixedLegacyRoot`), which says nothing about
      // whether anything is actually sitting at the fixed legacy path. Without
      // this gate the dry-run promised a removal the acting run would
      // silently skip.
      if (legacyRoot !== null && existsFn(legacyRoot)) {
        print(`  (legacy root ${legacyRoot} would be removed once empty)\n`);
      }
    }
    if (gh === null) {
      print("\ngh config: already unified — no legacy gh config dir\n");
    } else {
      print(`\ngh config:\n  ${gh.from} -> ${gh.to}${gh.pending ? "" : " (nothing to move)"}\n`);
    }
    print("\nconfig.json:\n");
    print("  would remove: vaultRoot, juncoSubdir, observability.stateDir (if present)\n");
    print(
      willSetDataDir
        ? `  would set: dataDir = ${targetRoot}\n`
        : "  dataDir left unset (matches the default)\n",
    );
    if (configPathIsLegacy) {
      print(
        existsFn(canonicalConfigPath)
          ? `\nconfig: ${configPath} -> ${canonicalConfigPath} ` +
              `(canonical path already exists — would be a skipped-conflict, never overwritten)\n`
          : `\nconfig: ${configPath} -> ${canonicalConfigPath}\n`,
      );
    } else if (configIsExplicitlyNamedLegacy) {
      print(
        `\nconfig: no relocation — JUNCO_CONFIG explicitly names ${configPath}, which is never relocated\n`,
      );
    } else {
      print(`\nconfig: no relocation needed (already at ${configPath})\n`);
    }
    print(`\nstate tree journal: ${migratedFile}\n`);
    return 0;
  }

  // 1b. Migration lock — held at EVERY root this run might touch (Important
  // 3), released in `finally`. `targetRoot` and `cfg.dataDir` cover a fresh
  // cross-root run (they differ); `legacyRoot` additionally covers a RESUME
  // once resolution has already flipped away from it — a daemon starting up
  // concurrently derives its own lock from whichever of these ITS OWN config
  // resolves to. Only locks a candidate that actually exists (or is the
  // target itself, whose acquisition legitimately mkdirs it) — never
  // fabricates an unrelated `~/.local/state/junco` out of thin air.
  const lockRoots = new Set<string>([targetRoot]);
  if (cfg.dataDir !== targetRoot && existsFn(cfg.dataDir)) lockRoots.add(cfg.dataDir);
  if (legacyRoot !== null && existsFn(legacyRoot)) lockRoots.add(legacyRoot);
  // Keyed by root (not a flat array) so the legacy root's OWN lock can be
  // released early, right before phase 7 tries to rmdir it — see there for
  // why: the lock is a real file living INSIDE that directory, so holding it
  // through the rmdir attempt would be self-defeating.
  const locksByRoot = new Map<string, PidfileLock>();
  for (const root of [...lockRoots].sort()) {
    const l = acquirePidfileLock(join(root, "migrate.lock"));
    if (l === null) {
      for (const held of locksByRoot.values()) held.release();
      print("junco data migrate: another migrate is running\n");
      return 1;
    }
    locksByRoot.set(root, l);
  }

  const queueReceipt: string[] = [];
  const dataRootReceipt: string[] = [];
  const dataRootConflicts: string[] = [];
  const ghReceipt: string[] = [];
  // Item 1 (#281): the gh-creds pair's own conflict tracking, kept separate
  // from `dataRootConflicts` — the two subsystems are otherwise unrelated
  // (an operator resolving a data-root conflict gains nothing from a gh-creds
  // one printed under the same heading, and vice versa), so each earns its
  // own receipt heading below rather than sharing one that only names one of
  // the two.
  const ghConflicts: string[] = [];
  // Phase trackers for an honest catch-path receipt: "not-run" = the phase
  // was never reached; "interrupted" = migrateFn threw mid-run (its completed
  // pairs are journaled durably); null configReceipt = rewrite never completed.
  let stateOutcome: MigrateResult | "not-run" | "interrupted" = "not-run";
  // Important 4: the ACTUAL location migrateStateTree writes to, independent
  // of targetRoot — phase 4 runs before the data-root move could ever
  // relocate it, so "interrupted" must point here, not at the target.
  const stateTreeJournalFile = join(cfg.dataDir, "migrated.json");
  // Item 2 (#281): what EARLIER runs recorded at the target root, read ONCE
  // here — before this run appends anything of its own — so a conflict below
  // can be told apart from an earlier interrupted cross-device copy's leftover
  // destination. `readJournal` never throws (missing/corrupt → no steps), so a
  // machine with no journal simply gets today's generic message.
  const priorJournalSteps = readJournal(migratedFile, readFileFn).steps;
  let configReceipt: string[] | null = null;
  // I-2: the config-relocation phase's own receipt/conflict tracking —
  // separate from configReceipt (the content-rewrite phase above it).
  const configMoveReceipt: string[] = [];
  let configMoveConflict = false;
  // task-2 (#283): the path-rewrite phase's receipt — stays the zero value
  // (honest "nothing to rewrite") if an earlier phase throws before this one
  // is ever reached.
  let rewriteReport: RewriteReport = { rewritten: 0, files: [], warnings: [] };

  try {
    // 1c. Stale daemon-claim sweep (#310). A `daemon-tree.lock` /
    // `daemon-queue.lock` left behind by a CRASHED daemon is an ordinary thing
    // to find — that is what a stale pidfile IS — but it is also a FILE sitting
    // in a directory this command may treat as a DESTINATION, and
    // `isRecursivelyEmptyDir` (dataMigrate.ts) counts any non-directory entry as
    // content. `flatToV2Pairs`' `queue -> queue` pair makes `<targetRoot>/queue`
    // a destination on a cross-root move, so one stale claim there flips "empty
    // scaffolding, safe to replace" into a reported `skipped-conflict` and the
    // queue never moves; the same file at a data root makes phase 7's rmdir fail
    // ENOTEMPTY and get reported as a leftover on every subsequent run. Neither
    // is data loss, but both are a conflict the operator cannot act on because
    // nothing explains it.
    //
    // Deliberately NOT fixed by teaching the emptiness check to ignore these
    // basenames: that would make a LIVE claim invisible too, and the repair path
    // would then rm -r a directory a running daemon is claiming. Clearing the
    // provably-ownerless file instead keeps the conflict rule exactly as strict
    // as it was — a destination holding anything real is still a conflict, and a
    // live claim still blocks the whole run at 1a.
    //
    // Runs even under `--force` (which skips 1a): the sweep cannot remove a live
    // claim regardless — see `sweepStaleDaemonClaims`.
    //
    // INSIDE this try, not between 1b and it (final review F3): the sweep
    // mkdirs/writes/unlinks via `acquirePidfileLock`, so it can throw
    // (EACCES/EROFS/ENOSPC) — and from the gap above, a throw escaped past the
    // `finally` at the bottom that releases every `migrate.lock` phase 1b took,
    // leaking them all with no receipt line to say so. Still the FIRST statement
    // of the acting region, so the phase order (sweep before the queue move and
    // before every emptiness check) is unchanged; the catch path below now also
    // turns a sweep failure into a receipt instead of a bare stack.
    for (const cleared of sweepStaleDaemonClaims(claimPaths, existsFn, acquireClaimFn)) {
      print(`junco data migrate: cleared a stale daemon claim (no live holder) — ${cleared}\n`);
    }

    // 3. Queue move (legacy vaultRoot only). Re-probe existence under the
    // lock — the pre-lock plan flags could be stale if a concurrent migrate
    // completed in between. `claimedByEarlierPhase` records what THIS phase
    // actually wrote to, so phase 5 below can never repair-delete or silently
    // merge onto it (Critical 2).
    const claimedByEarlierPhase = new Set<string>();
    const toMove = qSteps.filter((s) => existsFn(s.from));
    // MigrationStep-shaped record of what this phase actually moved — feeds
    // the path-rewrite phase's prefix map (task-2, #283) alongside
    // dataRootJournalSteps below. Always "renamed" regardless of whether the
    // move used a plain rename or the EXDEV copy+delete fallback, same
    // convention dataRootJournalSteps already uses for its own "copied" case.
    const queueJournalSteps: MigrationStep[] = [];
    if (toMove.length > 0) {
      mkdirSync(vaultQueueTarget, { recursive: true });
      claimedByEarlierPhase.add(vaultQueueTarget);
      for (const s of toMove) {
        try {
          renameFn(s.from, s.to);
          queueReceipt.push(`queue/${s.key}: moved ${s.from} -> ${s.to}`);
          queueJournalSteps.push({ from: s.from, to: s.to, action: "renamed" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "EXDEV") {
            copyDirFn(s.from, s.to);
            verifyCopy(s.from, s.to, fs);
            fsyncCopied(s.to, fs); // #196: durable before deleting source
            fs.rmFn(s.from, { recursive: true, force: true });
            queueReceipt.push(`queue/${s.key}: copied (cross-device) ${s.from} -> ${s.to}`);
            queueJournalSteps.push({ from: s.from, to: s.to, action: "renamed" });
          } else {
            throw e;
          }
        }
      }
    }

    // 4. State-tree name-normalization — BEFORE the data-root move so a very
    // old tree's pre-unification names land on their v2-mapped counterparts
    // first (flatToV2Pairs keys off the CURRENT dataTree.ts names). Still
    // same-directory, still against cfg.dataDir (not targetRoot) — its own
    // journal write (migrated.json under cfg.dataDir) rides along as one of
    // the data-root pairs below when the root is actually moving.
    // "interrupted" is set first and only overwritten on a clean return — if
    // migrateFn throws mid-run, the catch-path receipt points at the journal
    // instead of claiming "nothing pending".
    stateOutcome = "interrupted";
    stateOutcome = migrateFn(cfg);

    // 5+6. Data-root move / v2 restructure + gh creds move — journaled
    // together (Critical 1): each completed pair (moved, copied, OR
    // skipped-conflict) is appended to the TARGET root's migrated.json in a
    // `finally`, exactly like migrateStateTree's own journal — so a crash or
    // conflict mid-loop still leaves a durable receipt, and combined with
    // `dataRootPairs` probing the filesystem directly (not `cfg.legacy.
    // dataRoot`), a re-run picks up precisely the stragglers rather than
    // silently reporting "nothing to move".
    const dataRootJournalSteps: MigrationStep[] = [];
    let dataRootLoopCompleted = false;
    try {
      for (const pair of dataRootAll.filter((p) => existsFn(p.from))) {
        if (pair.to === migratedFile) {
          // Important (task review round 2): this pair's destination IS the
          // exact file THIS run's own journal write (below, and any EARLIER
          // run's) lands at — a plain rename-with-conflict would permanently
          // deadlock the instant any pair has ever been journaled to
          // `migratedFile` (which happens in THIS SAME loop's `finally`, or
          // on a prior interrupted run): every subsequent run would see the
          // destination as a non-empty file and report `skipped-conflict`
          // forever, with no path to resolution. MERGE instead — read the
          // legacy journal's own steps and append them into the target
          // journal (same `appendJournal` read-modify-write + dedup every
          // other pair gets), then remove the now-redundant legacy file.
          // Order-independent within this loop, and correctly handles a
          // target journal that ALREADY exists from an earlier interrupted
          // run too — merge, never conflict, either way.
          const legacySteps = readJournal(pair.from, readFileFn).steps;
          if (legacySteps.length > 0) {
            appendJournal(migratedFile, legacySteps, readFileFn, writeFileFn, renameFn);
          }
          rmFn(pair.from, { force: true });
          dataRootReceipt.push(`${pair.from} -> ${pair.to}: merged`);
          continue;
        }
        if (claimedByEarlierPhase.has(pair.to)) {
          // Critical 2: never merge or delete onto a destination this run's
          // queue-move phase already wrote to — report and move on.
          dataRootConflicts.push(
            `${pair.from} -> ${pair.to}: destination already relocated by this run's vaultRoot queue move`,
          );
          dataRootReceipt.push(`${pair.from} -> ${pair.to}: skipped-conflict`);
          dataRootJournalSteps.push({ from: pair.from, to: pair.to, action: "skipped-conflict" });
          continue;
        }
        if (pair.contendedBy !== undefined) {
          // Item 6 (#281): the SAME rule as Critical 2 one branch up, for the
          // other way a destination gets claimed twice in one run — an earlier
          // pending pair from the other data root (`dataRootPairs` marks the
          // loser rather than dropping it). Merging them is not an option:
          // `moveDataRootPair` would repair-delete a recursively-empty winner
          // and rename this source onto it, silently fusing two data roots
          // behind a receipt claiming both "moved". Report, touch nothing.
          // Marked at plan time and honoured even if the winner's source
          // vanished under the lock (a concurrent migrate) — that direction
          // fails safe: a conflict is reported, nothing is destroyed, and the
          // next run finds the pair uncontested.
          dataRootConflicts.push(
            `${pair.from} -> ${pair.to}: both data roots hold this pair — ${pair.contendedBy} took ` +
              `the destination this run and nothing was merged. Reconcile the two sources by hand ` +
              `(move or remove one), then re-run.`,
          );
          dataRootReceipt.push(`${pair.from} -> ${pair.to}: skipped-conflict (contended source)`);
          dataRootJournalSteps.push({ from: pair.from, to: pair.to, action: "skipped-conflict" });
          continue;
        }
        let action: "moved" | "copied" | "skipped-conflict";
        try {
          action = moveDataRootPair(pair.from, pair.to, fs);
        } catch (e) {
          if (e instanceof PartialCopyError) {
            // Item 2 (#281): receipt first, then the record — the `finally`
            // below writes `dataRootJournalSteps` even on this throw, so the
            // partial destination is both named to THIS operator and left
            // self-describing for the next run. Without it, the pair appeared
            // in neither: run 1 said "data root: nothing to move" over a
            // half-copied tree, and run 2 could only call it a generic
            // conflict.
            dataRootReceipt.push(
              partialCopyReceiptLine(e, "Remove the partial destination, then re-run."),
            );
            dataRootJournalSteps.push({ from: pair.from, to: pair.to, action: "partial-copy" });
          }
          throw e;
        }
        if (action === "skipped-conflict") {
          const partial = destinationHoldsPartialCopy(priorJournalSteps, pair.from, pair.to);
          dataRootConflicts.push(conflictLine(pair.from, pair.to, partial, migratedFile));
          dataRootReceipt.push(
            `${pair.from} -> ${pair.to}: skipped-conflict` +
              (partial ? " (partial copy from an interrupted run)" : ""),
          );
          dataRootJournalSteps.push({ from: pair.from, to: pair.to, action: "skipped-conflict" });
        } else {
          dataRootReceipt.push(
            `${pair.from} -> ${pair.to}: ${action === "copied" ? "copied (cross-device)" : "moved"}`,
          );
          dataRootJournalSteps.push({ from: pair.from, to: pair.to, action: "renamed" });
        }
      }

      if (gh !== null && existsFn(gh.from)) {
        // The gh pair runs the SAME mover, so it has the same partial-copy
        // window (item 2, #281) — its own legacy path and target can sit on
        // different filesystems just as easily. Handled identically, onto its
        // own receipt/conflict arrays (item 1).
        let action: "moved" | "copied" | "skipped-conflict";
        try {
          action = moveDataRootPair(gh.from, gh.to, fs);
        } catch (e) {
          if (e instanceof PartialCopyError) {
            ghReceipt.push(
              partialCopyReceiptLine(e, "Remove the partial destination, then re-run."),
            );
            dataRootJournalSteps.push({ from: gh.from, to: gh.to, action: "partial-copy" });
          }
          throw e;
        }
        if (action === "skipped-conflict") {
          // Item 1 (#281): its own array/heading, not `dataRootConflicts` —
          // see the declaration above.
          ghConflicts.push(
            conflictLine(
              gh.from,
              gh.to,
              destinationHoldsPartialCopy(priorJournalSteps, gh.from, gh.to),
              migratedFile,
            ),
          );
          ghReceipt.push(`${gh.from} -> ${gh.to}: skipped-conflict`);
          dataRootJournalSteps.push({ from: gh.from, to: gh.to, action: "skipped-conflict" });
        } else {
          ghReceipt.push(
            `${gh.from} -> ${gh.to}: ${action === "copied" ? "copied (cross-device)" : "moved"}`,
          );
          dataRootJournalSteps.push({ from: gh.from, to: gh.to, action: "renamed" });
        }
      }
      dataRootLoopCompleted = true;
    } finally {
      if (dataRootJournalSteps.length > 0) {
        try {
          appendJournal(migratedFile, dataRootJournalSteps, readFileFn, writeFileFn, renameFn);
        } catch (journalErr) {
          // Same #197.1-style guard migrateStateTree uses: don't let a
          // journal-write failure REPLACE an in-flight migration error.
          if (dataRootLoopCompleted) throw journalErr;
          print(
            `\njunco data migrate: journal write failed after a data-root migration error: ` +
              `${journalErr instanceof Error ? journalErr.message : String(journalErr)}\n`,
          );
        }
      }
    }

    // 6.5. Path rewrite (task-2, #283): the watchlist and any queue tickets
    // still hold absolute paths recorded before this run's renames — the
    // symptom that made `junco doctor` report every watched repo as "not a
    // git clone" after a migrate. Inserted HERE — after every phase above has
    // landed at targetRoot, BEFORE the legacy-root removal below — so the map
    // reflects this run's FINAL destinations. Built from THIS run's own
    // renames (queueJournalSteps + dataRootJournalSteps) UNIONED with the
    // DURABLE on-disk journal's historical "renamed" steps (fix-wave review,
    // #283 Important 2) — buildPrefixMap further filters the union to
    // `action === "renamed"`, dropping any skipped-conflict pair either
    // source contributes: a candidate pair that never moved must never be
    // treated as a rewrite target (design rule 1, migratePathRewrite.ts).
    // The historical union matters because a run that renamed a tree — and
    // journaled it in this SAME `finally` above, or in an earlier run — but
    // died before reaching THIS phase leaves nothing for a resumed run's OWN
    // step arrays to rebuild that prefix from: the tree has already moved,
    // so re-running the mover produces no NEW "renamed" step, and the stale
    // paths inside the watchlist/tickets/records would stay wrong FOREVER
    // without this. Re-applying a historical prefix is provably safe: an
    // already-rewritten value matches no old prefix (`rewritePath` returns
    // `null`) and is left untouched — idempotence rule 4 above, unchanged.
    // `readJournal` never throws (missing/corrupt journal → empty steps);
    // `dedupeSteps` handles the overlap between `dataRootJournalSteps`
    // (already flushed to `migratedFile` above, in this same run) and what
    // `readJournal` reads back here.
    // Does NOT exclude migrateStateTree's own same-directory renames (phase
    // 4) — a prior comment here claimed it did; that was false (fix-wave
    // review #283 Critical 1). The phase-5 merge branch above
    // (`pair.to === migratedFile`) reads the LEGACY state-tree journal and
    // appends ITS "renamed" steps into `migratedFile` — inside this SAME
    // loop, which always runs BEFORE `readJournal(migratedFile, ...)` below.
    // So `historicalRenameSteps` DOES include phase 4's same-directory
    // renames whenever a pre-unification tree's legacy journal was merged
    // in this run, or in an earlier one. That is correct and necessary: a
    // stored value can legitimately match a phase-4 step first (e.g. a
    // watchlist/ticket path under the pre-normalization `<root>/repos`),
    // and `buildPrefixMap` now transitively resolves such a chain to its
    // TRUE final destination — through any later root-level move of the
    // renamed tree's new parent — rather than stopping at that intermediate
    // hop (which a plain single-hop map used to do: the rewritten value
    // landed inside the legacy root this same run then deletes). See
    // `buildPrefixMap`'s own doc comment in migratePathRewrite.ts.
    const rewriteTargetQueue: Paths = {
      inbox: join(vaultQueueTarget, "inbox"),
      processing: join(vaultQueueTarget, "processing"),
      done: join(vaultQueueTarget, "done"),
      failed: join(vaultQueueTarget, "failed"),
    };
    const historicalRenameSteps = readJournal(migratedFile, readFileFn).steps;
    const rewriteMapWarnings: string[] = [];
    const rewriteMap = buildPrefixMap(
      dedupeSteps([...historicalRenameSteps, ...queueJournalSteps, ...dataRootJournalSteps]),
      rewriteMapWarnings,
    );
    rewriteReport = rewriteStoredPaths({ targetRoot, queuePaths: rewriteTargetQueue }, rewriteMap, {
      readFileFn,
      writeFileFn,
      readdirFn,
      existsFn,
      renameFn,
    });
    // Surface a prefix-chain cycle (buildPrefixMap's own guard — a journal
    // that in principle contained `A -> B` and `B -> A`) on the SAME receipt
    // channel every other path-rewrite warning uses, rather than a separate
    // silent-drop path.
    rewriteReport.warnings.push(...rewriteMapWarnings);
    if (rewriteReport.rewritten > 0) {
      // One summary step for the whole phase, not one per rewritten value —
      // "the result" the task brief asks to journal. readJournal/
      // appendJournal both stay fully generic over MigrationStep.action
      // (appendJournal only special-cases "skipped-conflict" for its dedup
      // rule), so no changes were needed there for the new "rewrote" value.
      try {
        appendJournal(
          migratedFile,
          [{ from: targetRoot, to: targetRoot, action: "rewrote" }],
          readFileFn,
          writeFileFn,
          renameFn,
        );
      } catch (journalErr) {
        // Minor 4 (fix-wave review): same #197.1-style guard the data-root
        // journal write above uses — a failure writing this cosmetic
        // "rewrote" receipt must not turn into exit 1. Every store this
        // phase touched was already written successfully on disk
        // (rewriteReport.rewritten > 0 to even reach here); the failure is
        // recorded through this phase's own warning channel instead of
        // aborting the rest of the migration.
        rewriteReport.warnings.push(
          `path-rewrite journal write failed: ` +
            `${journalErr instanceof Error ? journalErr.message : String(journalErr)}`,
        );
      }
    }

    // 7. Legacy root removal — filesystem-driven (Critical 1), attempted
    // whenever the fixed legacy path still exists, not gated on
    // `cfg.legacy.dataRoot` (which flips to false the moment ANY marker
    // lands at the target, well before every pair has necessarily moved).
    // Plain, non-recursive rmdir (`rmdirFn`, default `rmdirSync` — the
    // removals in this phase run on their own seam members, see
    // DataMigrateDeps): refuses silently (ENOTEMPTY) when a
    // conflicted pair (or anything else) is still inside, and the receipt
    // lists what stayed rather than ever forcing it.
    if (legacyRoot !== null && existsFn(legacyRoot)) {
      // Release the legacy root's OWN migrate.lock first — it is a real file
      // living inside the very directory this rmdir needs empty, so holding
      // it through the attempt would make it the one thing always left
      // behind. This narrows the daemon-mutex window by one rmdir's worth of
      // time (no I/O in between); every phase that actually touches
      // legacyRoot's contents already ran under the lock above it.
      const legacyLock = locksByRoot.get(legacyRoot);
      if (legacyLock) {
        legacyLock.release();
        locksByRoot.delete(legacyRoot);
      }
      // I-1 (final review 2026-08-05, empirically confirmed): every root
      // ensureDataTree has ever materialized carries a self-written
      // `.gitignore` (content exactly `*\n`) that flatToV2Pairs has no pair
      // for, so the rmdir below would ALWAYS fail ENOTEMPTY on a real
      // machine — the advertised legacy-root removal never fired. Only
      // junco's own scaffold (exact byte match) is removed here; anything
      // else (an operator-customized `.gitignore`) is left in place and
      // reported below like any other leftover.
      const legacyGitignore = join(legacyRoot, ".gitignore");
      if (existsFn(legacyGitignore)) {
        let content: string | null = null;
        try {
          content = readFileFn(legacyGitignore);
        } catch {
          content = null; // unreadable — leave it, let rmdir report it as usual
        }
        if (content === "*\n") {
          try {
            unlinkFn(legacyGitignore);
          } catch {
            /* best-effort — rmdir below just reports it as a leftover */
          }
        }
      }
      // `<root>/skills` is a symlink mount that skillLinks.ts recreates at
      // every daemon startup, so on any machine the daemon has run it is
      // sitting in the legacy root with no pair to move it — and, exactly
      // like the scaffolded .gitignore above, it makes the rmdir below fail
      // ENOTEMPTY every time. Only a SYMLINK is unlinked here; a real
      // directory or file at that path is left alone and reported as a
      // leftover like anything else. The mount is regenerated at the new
      // root by ensureSkillLinks on the next daemon start.
      const legacySkills = join(legacyRoot, "skills");
      try {
        if (lstatFn(legacySkills).isSymbolicLink()) unlinkFn(legacySkills);
      } catch {
        /* absent or unreadable — rmdir below reports it as a leftover */
      }
      try {
        rmdirFn(legacyRoot);
        dataRootReceipt.push(`removed legacy root ${legacyRoot}`);
      } catch {
        let remaining: string[] = [];
        try {
          remaining = readdirSync(legacyRoot);
        } catch {
          /* already gone (or never existed) — nothing to report */
        }
        if (remaining.length > 0) {
          dataRootReceipt.push(
            `legacy root ${legacyRoot} not removed — still contains: ${remaining.join(", ")}`,
          );
        }
      }
    }

    // 8. Config rewrite. `deps` is passed whole: its readFileFn/writeFileFn/
    // renameFn/unlinkFn members ARE the ConfigWriteDeps seam, and an unset
    // writeFileFn gets configWrite's 0600 default (#343) rather than this
    // module's plain-utf8 one.
    configReceipt = rewriteConfig(configPath, targetRoot, deps);

    // 9. Config relocation (I-2 — see the module doc comment). Only when
    // THIS run's config actually lives at the legacy XDG path; a canonical-
    // already machine (the common case) never reaches moveDataRootPair.
    // Reuses moveDataRootPair verbatim (file-aware since #196's
    // verifyCopyPath/fsyncCopiedPath dispatch on `fs.statFn`) — its own
    // existsFn(to) check is what makes a pre-existing canonical file an
    // unconditional skipped-conflict, never overwritten. Journaled at the
    // target root exactly like every other pair above, so a re-run (config
    // already relocated, resolveConfigPath now finds it) sees nothing left
    // to do here.
    if (configPathIsLegacy) {
      let action: "moved" | "copied" | "skipped-conflict";
      try {
        action = moveDataRootPair(configPath, canonicalConfigPath, fs);
      } catch (e) {
        if (e instanceof PartialCopyError) {
          // Item 2 (#281) at the SECOND call site. Same defect as the
          // data-root loop's — a throw here left `configMoveReceipt` empty, so
          // the receipt printed "config: nothing to relocate" over a partial
          // config file at the canonical path — and the same fix, receipt then
          // record. What differs is the RE-RUN: `resolveConfigPath` (config.ts)
          // prefers the canonical path the moment it EXISTS, so once a partial
          // copy has landed there, the next run resolves to that partial file
          // and `configPathIsLegacy` is false — this phase is never re-entered
          // and there is no later conflict message to improve (a genuine
          // pre-existing canonical config still reaches the branch below,
          // unchanged). That makes this receipt line and the journal entry the
          // operator's entire record, and makes clearing the partial file
          // urgent rather than optional — so the hint says so.
          configMoveReceipt.push(
            partialCopyReceiptLine(
              e,
              `Your config is still whole at ${configPath} — remove the partial ` +
                `${canonicalConfigPath} before running junco again, since config ` +
                `resolution prefers the canonical path the moment it exists.`,
            ),
          );
          try {
            appendJournal(
              migratedFile,
              [{ from: configPath, to: canonicalConfigPath, action: "partial-copy" }],
              readFileFn,
              writeFileFn,
              renameFn,
            );
          } catch (journalErr) {
            // #197.1, in the direction the successful-relocation guard below
            // does NOT take: there the journal failure is the only thing that
            // went wrong, so it propagates. Here a real copy failure is
            // already in flight and is the more important error, so the
            // journal failure is reported on its own line and the ORIGINAL is
            // re-thrown — never masked by a bookkeeping error.
            print(
              `\njunco data migrate: journal write failed after an interrupted ` +
                `config relocation: ${describeError(journalErr)}\n`,
            );
          }
        }
        throw e;
      }
      // Receipt BEFORE the journal (item 9, #281), the same order the
      // data-root loop above uses and the order printReceipt's own doc comment
      // promises ("built incrementally by the caller (pushed as each pair
      // completes), so a throw mid-loop leaves them holding exactly the pairs
      // that landed"). Journaling first inverted that: a throw in the
      // appendJournal below left `configMoveReceipt` empty, so the receipt
      // printed "config: nothing to relocate" for a file that had ALREADY
      // moved — pointing the operator at the old path in the one situation (a
      // partial failure) where the receipt is the only record they have.
      if (action === "skipped-conflict") {
        configMoveConflict = true;
        configMoveReceipt.push(
          `${configPath} -> ${canonicalConfigPath}: skipped-conflict ` +
            `(canonical config already exists — not overwritten; resolve manually)`,
        );
      } else {
        configMoveReceipt.push(
          `moved ${configPath} -> ${canonicalConfigPath}${action === "copied" ? " (cross-device)" : ""}`,
        );
      }
      const step: MigrationStep = {
        from: configPath,
        to: canonicalConfigPath,
        action: action === "skipped-conflict" ? "skipped-conflict" : "renamed",
      };
      try {
        appendJournal(migratedFile, [step], readFileFn, writeFileFn, renameFn);
      } catch (journalErr) {
        // The #197.1 guard both other journal writes carry (:955, :1047),
        // which this phase was missing: a journal-write failure must never
        // become the operator's ONLY account of what happened. The data-root
        // loop keeps an in-flight migration error and prints the journal
        // failure alongside it; the path-rewrite phase routes its own onto
        // that phase's warning channel. Here the relocation above has already
        // happened and — since the reorder — is already on the receipt, so
        // this names the failure as SUBSEQUENT to the move (rather than
        // letting the bare fs error read as though the migration itself
        // failed) and then propagates it: unlike path-rewrite's cosmetic
        // "rewrote" step, a durable record that could not be written is a
        // real filesystem failure and still earns exit 1.
        print(
          `\njunco data migrate: journal write failed after the config relocation: ` +
            `${journalErr instanceof Error ? journalErr.message : String(journalErr)}\n`,
        );
        throw journalErr;
      }
    }

    // 10. Receipt.
    printReceipt(
      print,
      queueReceipt,
      stateOutcome,
      dataRootReceipt,
      dataRootConflicts,
      ghReceipt,
      ghConflicts,
      rewriteReport,
      configReceipt,
      configMoveReceipt,
      configIsExplicitlyNamedLegacy ? configPath : null,
      stateTreeJournalFile,
    );

    const stateConflicts = typeof stateOutcome === "string" ? 0 : stateOutcome.conflicts.length;
    const totalConflicts =
      stateConflicts + dataRootConflicts.length + ghConflicts.length + (configMoveConflict ? 1 : 0);
    if (totalConflicts > 0) {
      print(`\njunco data migrate: ${totalConflicts} conflict(s) — resolve manually and re-run\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    printReceipt(
      print,
      queueReceipt,
      stateOutcome,
      dataRootReceipt,
      dataRootConflicts,
      ghReceipt,
      ghConflicts,
      rewriteReport,
      configReceipt,
      configMoveReceipt,
      configIsExplicitlyNamedLegacy ? configPath : null,
      stateTreeJournalFile,
    );
    print(`\njunco data migrate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    for (const l of locksByRoot.values()) l.release();
  }
}
