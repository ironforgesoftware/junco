/**
 * `junco data migrate` — explicit, opt-in full unification of the legacy
 * vaultRoot queue + state-tree subdirs + config.json legacy keys into the
 * unified data root (spec 2026-07-16 §7 "Explicit"), extended (2026-08-03
 * single-root plan) to relocate the whole tree to `~/.junco` and restructure
 * it into the v2 shape. Refuses while the daemon appears to be running,
 * judged two ways: ANY /health response (even non-200) means something is
 * listening on that port, and a live-held `<config dir>/worker.lock` pidfile
 * (the daemon's single-instance lock, see cli.ts) catches healthEnabled:false
 * daemons the probe can never observe. Either signal → back off rather than
 * race the daemon's own in-flight fs mutations. `--force` skips both checks
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
 * effect) → lock (all roots) → queue move → state-tree name-normalize
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
import { join, dirname, resolve } from "node:path";
import type { Config, Paths } from "./types.js";
import {
  HEALTH_TIMEOUT_MS,
  queuePaths,
  configDeprecations,
  validateConfigObject,
  expandHome,
  juncoHome,
  legacyConfigPath,
  defaultUserConfigPath,
} from "./config.js";
import {
  migrateStateTree,
  pendingStateTreeMigrations,
  migrationTargetRoot,
  fixedLegacyRoot,
  dataRootPairs,
  isRecursivelyEmptyDir,
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
   * up" signal). Default: the real readPidfileHolder. */
  pidfileHolderFn?: (lockPath: string) => number | null;
  /** Env driving `juncoHome(env)`/`homeOf(env)` (the single-root move target
   * and the fixed legacy-path probe). Default: process.env — same DI seam as
   * resolveBotGhConfigDir's callers. */
  env?: Record<string, string | undefined>;
  /** Directory listing (filenames only, not recursive) — used solely by the
   * post-move path-rewrite phase (migratePathRewrite.ts) to list a queue
   * dir's `*.md` tickets. No other phase needs directory listing exposed as
   * a seam (moves/copies work on whole dirs via renameFn/copyDirFn). Default:
   * fs.readdirSync. */
  readdirFn?: (p: string) => string[];
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

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full).map((r) => join(e.name, r)));
    else if (e.isFile()) out.push(e.name);
  }
  return out;
}

/** Per-file size verification after an EXDEV recursive-copy fallback — the
 * source is only deleted once every file lands on the other side with a
 * matching byte count. Throws (never swallows) so the caller's generic
 * error handling reports it and the untouched source stays exactly where
 * it was. Directory-only (queue's four dirs are always directories). */
function verifyCopy(from: string, to: string): void {
  for (const rel of listFilesRecursive(from)) {
    const srcSize = statSync(join(from, rel)).size;
    let dstSize: number;
    try {
      dstSize = statSync(join(to, rel)).size;
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
function fsyncCopied(to: string, syncPathFn: (p: string) => void): void {
  const dirs = new Set<string>([to]);
  for (const rel of listFilesRecursive(to)) {
    const full = join(to, rel);
    syncPathFn(full);
    dirs.add(dirname(full));
  }
  for (const d of dirs) syncPathFn(d);
}

/** `verifyCopy`/`fsyncCopied` assume a directory pair (queue's four dirs are
 * always directories). `flatToV2Pairs`' pairs are a mix — most are
 * directories (outbox, clones, ...) but several are single files
 * (watchlist.json, spend.json, worker.log, ...). These wrappers dispatch on
 * `from`'s type so the same EXDEV fallback machinery (copy → verify → fsync →
 * delete-source, #196) covers both shapes without duplicating it. */
function verifyCopyPath(from: string, to: string): void {
  if (statSync(from).isDirectory()) {
    verifyCopy(from, to);
    return;
  }
  const srcSize = statSync(from).size;
  let dstSize: number;
  try {
    dstSize = statSync(to).size;
  } catch {
    throw new Error(`EXDEV copy verification failed — missing ${to}`);
  }
  if (dstSize !== srcSize) {
    throw new Error(`EXDEV copy verification failed — size mismatch for ${to}`);
  }
}

function fsyncCopiedPath(to: string, syncPathFn: (p: string) => void): void {
  if (statSync(to).isDirectory()) {
    fsyncCopied(to, syncPathFn);
    return;
  }
  syncPathFn(to);
  syncPathFn(dirname(to));
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
 * being inert scaffolding, so it would otherwise repair-and-delete it. */
function moveDataRootPair(
  from: string,
  to: string,
  existsFn: (p: string) => boolean,
  renameFn: (from: string, to: string) => void,
  copyDirFn: (from: string, to: string) => void,
  syncPathFn: (p: string) => void,
): "moved" | "copied" | "skipped-conflict" {
  if (existsFn(to)) {
    if (isRecursivelyEmptyDir(to, (d) => readdirSync(d, { withFileTypes: true }))) {
      rmSync(to, { recursive: true });
    } else {
      return "skipped-conflict";
    }
  }
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameFn(from, to);
    return "moved";
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EXDEV") {
      copyDirFn(from, to);
      verifyCopyPath(from, to);
      fsyncCopiedPath(to, syncPathFn); // #196: durable before deleting source
      rmSync(from, { recursive: true, force: true });
      return "copied";
    }
    throw e;
  }
}

/** Read → mutate → validate → atomic tmp+rename write of the RAW config.json
 * (same read/validate/atomic-write shape as `junco config set` in
 * src/configCmd.ts). Deleting `juncoSubdir` always accompanies `vaultRoot` —
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
function rewriteConfig(
  configPath: string,
  targetRoot: string,
  readFileFn: (p: string) => string,
  writeFileFn: (p: string, s: string) => void,
  renameFn: (from: string, to: string) => void,
): string[] {
  const raw = JSON.parse(readFileFn(configPath)) as Record<string, unknown>;
  const receipt: string[] = [];

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

  validateConfigObject(raw);

  const tmp = join(dirname(configPath), `.config.json.tmp-${process.pid}`);
  writeFileFn(tmp, JSON.stringify(raw, null, 2) + "\n");
  renameFn(tmp, configPath);
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
 * it currently lives. `rewriteReport` (task-2, #283) is printed right after
 * gh config — it always holds the ZERO value ({rewritten:0, ...}) on a run
 * that never reached that phase (an earlier throw), so "nothing rewritten"
 * is honest rather than a lie by omission, same discipline every other
 * section here follows. */
function printReceipt(
  print: (s: string) => void,
  queueReceipt: string[],
  state: MigrateResult | "not-run" | "interrupted",
  dataRootReceipt: string[],
  dataRootConflicts: string[],
  ghReceipt: string[],
  rewriteReport: RewriteReport,
  configReceipt: string[] | null,
  configMoveReceipt: string[],
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
  const env = deps.env ?? process.env;
  const readdirFn = deps.readdirFn ?? ((p: string) => readdirSync(p));

  // The single-root move target (see the module doc comment). Computed once
  // and threaded through every phase below, along with the fixed legacy path
  // this run should ALSO probe/lock/clean up (Critical 1 / Important 3) —
  // null when targetRoot isn't the canonical root at all (an explicit,
  // unrelated dataDir never has `~/.local/state/junco` swept in).
  const targetRoot = migrationTargetRoot(cfg, env);
  const legacyRoot = fixedLegacyRoot(targetRoot, env);
  // I-2: whether THIS run's config lives at the legacy XDG path — decoupled
  // from targetRoot/legacyRoot (data-root state), see the module doc comment.
  const canonicalConfigPath = defaultUserConfigPath(env);
  const configPathIsLegacy = configPath === legacyConfigPath(env);

  // 1a. Daemon-up refusal — both signals skipped entirely by --force.
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
    const workerLock = join(dirname(resolve(configPath)), "worker.lock");
    const holder = pidfileHolderFn(workerLock);
    if (holder !== null) {
      print(
        `junco data migrate: refusing — the daemon appears to be running ` +
          `(pid ${holder} holds ${workerLock}). ` +
          `Stop it first, or pass --force to skip this check.\n`,
      );
      return 1;
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
          : p.pending
            ? ""
            : " (nothing to move)";
        print(`  ${p.from} -> ${p.to}${suffix}\n`);
      }
      if (legacyRoot !== null) {
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
  // Phase trackers for an honest catch-path receipt: "not-run" = the phase
  // was never reached; "interrupted" = migrateFn threw mid-run (its completed
  // pairs are journaled durably); null configReceipt = rewrite never completed.
  let stateOutcome: MigrateResult | "not-run" | "interrupted" = "not-run";
  // Important 4: the ACTUAL location migrateStateTree writes to, independent
  // of targetRoot — phase 4 runs before the data-root move could ever
  // relocate it, so "interrupted" must point here, not at the target.
  const stateTreeJournalFile = join(cfg.dataDir, "migrated.json");
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
            verifyCopy(s.from, s.to);
            fsyncCopied(s.to, syncPathFn); // #196: durable before deleting source
            rmSync(s.from, { recursive: true, force: true });
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
          rmSync(pair.from, { force: true });
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
        const action = moveDataRootPair(
          pair.from,
          pair.to,
          existsFn,
          renameFn,
          copyDirFn,
          syncPathFn,
        );
        if (action === "skipped-conflict") {
          dataRootConflicts.push(
            `${pair.from} -> ${pair.to}: destination already exists and is not empty`,
          );
          dataRootReceipt.push(`${pair.from} -> ${pair.to}: skipped-conflict`);
          dataRootJournalSteps.push({ from: pair.from, to: pair.to, action: "skipped-conflict" });
        } else {
          dataRootReceipt.push(
            `${pair.from} -> ${pair.to}: ${action === "copied" ? "copied (cross-device)" : "moved"}`,
          );
          dataRootJournalSteps.push({ from: pair.from, to: pair.to, action: "renamed" });
        }
      }

      if (gh !== null && existsFn(gh.from)) {
        const action = moveDataRootPair(gh.from, gh.to, existsFn, renameFn, copyDirFn, syncPathFn);
        if (action === "skipped-conflict") {
          dataRootConflicts.push(
            `${gh.from} -> ${gh.to}: destination already exists and is not empty`,
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
    // Plain, non-recursive rmdirSync: refuses silently (ENOTEMPTY) when a
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
            unlinkSync(legacyGitignore);
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
        if (lstatFn(legacySkills).isSymbolicLink()) unlinkSync(legacySkills);
      } catch {
        /* absent or unreadable — rmdir below reports it as a leftover */
      }
      try {
        rmdirSync(legacyRoot);
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

    // 8. Config rewrite.
    configReceipt = rewriteConfig(configPath, targetRoot, readFileFn, writeFileFn, renameFn);

    // 9. Config relocation (I-2 — see the module doc comment). Only when
    // THIS run's config actually lives at the legacy XDG path; a canonical-
    // already machine (the common case) never reaches moveDataRootPair.
    // Reuses moveDataRootPair verbatim (file-aware since #196's
    // verifyCopyPath/fsyncCopiedPath dispatch on statSync) — its own
    // existsFn(to) check is what makes a pre-existing canonical file an
    // unconditional skipped-conflict, never overwritten. Journaled at the
    // target root exactly like every other pair above, so a re-run (config
    // already relocated, resolveConfigPath now finds it) sees nothing left
    // to do here.
    if (configPathIsLegacy) {
      const action = moveDataRootPair(
        configPath,
        canonicalConfigPath,
        existsFn,
        renameFn,
        copyDirFn,
        syncPathFn,
      );
      const step: MigrationStep = {
        from: configPath,
        to: canonicalConfigPath,
        action: action === "skipped-conflict" ? "skipped-conflict" : "renamed",
      };
      appendJournal(migratedFile, [step], readFileFn, writeFileFn, renameFn);
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
    }

    // 10. Receipt.
    printReceipt(
      print,
      queueReceipt,
      stateOutcome,
      dataRootReceipt,
      dataRootConflicts,
      ghReceipt,
      rewriteReport,
      configReceipt,
      configMoveReceipt,
      stateTreeJournalFile,
    );

    const stateConflicts = typeof stateOutcome === "string" ? 0 : stateOutcome.conflicts.length;
    const totalConflicts = stateConflicts + dataRootConflicts.length + (configMoveConflict ? 1 : 0);
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
      rewriteReport,
      configReceipt,
      configMoveReceipt,
      stateTreeJournalFile,
    );
    print(`\njunco data migrate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    for (const l of locksByRoot.values()) l.release();
  }
}
