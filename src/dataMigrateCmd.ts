/**
 * `junco data migrate` — explicit, opt-in full unification of the legacy
 * vaultRoot queue + state-tree subdirs + config.json legacy keys into the
 * unified data root (spec 2026-07-16 §7 "Explicit"). Refuses while the
 * daemon appears to be running, judged two ways: ANY /health response (even
 * non-200) means something is listening on that port, and a live-held
 * `<config dir>/worker.lock` pidfile (the daemon's single-instance lock, see
 * cli.ts) catches healthEnabled:false daemons the probe can never observe.
 * Either signal → back off rather than race the daemon's own in-flight fs
 * mutations. `--force` skips both checks (documented escape hatch). A
 * pidfile lock (`<dataDir>/migrate.lock`), held for the whole run and
 * released in a `finally`, keeps two concurrent migrates from racing each
 * other.
 *
 * Order of operations: probe → plan (read-only) → (`--dry-run`: print + stop,
 * exit 0 — BEFORE the lock, whose acquisition mkdirs cfg.dataDir as a side
 * effect) → lock → queue move → state-tree migrate (`migrateStateTree`) →
 * config.json rewrite → receipt. State-tree conflicts and a failed config
 * rewrite are reported via a non-zero exit code AFTER every non-conflicted
 * step has completed — nothing already moved/renamed is ever rolled back,
 * and the receipt stays honest about phases that never ran or were
 * interrupted (see printReceipt).
 */
import {
  existsSync,
  renameSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  statSync,
  readdirSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import type { Config, Paths } from "./types.js";
import {
  HEALTH_TIMEOUT_MS,
  queuePaths,
  configDeprecations,
  validateConfigObject,
  expandHome,
} from "./config.js";
import { migrateStateTree, pendingMigrations, type MigrateResult } from "./dataMigrate.js";
import { dataTreePaths } from "./dataTree.js";
import { acquirePidfileLock, readPidfileHolder } from "./pidfileLock.js";

const QUEUE_DIR_KEYS: (keyof Paths)[] = ["inbox", "processing", "done", "failed"];

/** The default (pre-unification) dataDir — matches config.ts's assembleConfig
 * fallback (`d.observability.stateDir ?? d.dataDir ?? "~/.local/state/junco"`). */
const DEFAULT_DATA_DIR = "~/.local/state/junco";

export interface DataMigrateDeps {
  /** /health probe fetch. Default: global fetch. */
  fetchFn?: typeof fetch;
  /** Existence probe (plan computation + pendingMigrations). Default: fs.existsSync. */
  existsFn?: (p: string) => boolean;
  /** Rename primitive — used for BOTH the queue-dir moves and the config.json
   * atomic tmp+rename write. Default: fs.renameSync. */
  renameFn?: (from: string, to: string) => void;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  printFn?: (s: string) => void;
  /** State-tree migration. Default: the real migrateStateTree (real fs). */
  migrateFn?: (cfg: Config) => MigrateResult;
  /** Recursive directory copy for the EXDEV fallback. Default: fs.cpSync. */
  copyDirFn?: (from: string, to: string) => void;
  /** fsync a single path (open+fsync+close) in the EXDEV fallback, so copies
   * are durable before the source is deleted (#196). Default: real fsync. */
  syncPathFn?: (p: string) => void;
  /** Daemon-pidfile liveness probe (the /health-independent "is the daemon
   * up" signal). Default: the real readPidfileHolder. */
  pidfileHolderFn?: (lockPath: string) => number | null;
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
 * already lives at `<dataDir>/queue`, nothing to move. When set,
 * `cfg.queueRoot` IS the legacy root (`<vaultRoot>/<juncoSubdir>`), so
 * `queuePaths(cfg)` hands back the four legacy source paths directly. */
function queueSteps(cfg: Config): QueueStep[] {
  if (!cfg.legacy.vaultRoot) return [];
  const legacy = queuePaths(cfg);
  const targetRoot = join(cfg.dataDir, "queue");
  return QUEUE_DIR_KEYS.map((key) => ({ key, from: legacy[key], to: join(targetRoot, key) }));
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
 * it was. */
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
 * copy+fsync+verify+delete; the size verify still runs first (above). */
function fsyncCopied(to: string, syncPathFn: (p: string) => void): void {
  const dirs = new Set<string>([to]);
  for (const rel of listFilesRecursive(to)) {
    const full = join(to, rel);
    syncPathFn(full);
    dirs.add(dirname(full));
  }
  for (const d of dirs) syncPathFn(d);
}

/** Read → mutate → validate → atomic tmp+rename write of the RAW config.json
 * (same read/validate/atomic-write shape as `junco config set` in
 * src/configCmd.ts). Deleting `juncoSubdir` always accompanies `vaultRoot` —
 * the pair is meaningless without each other. Deleting
 * `observability.stateDir` deletes an emptied `observability` object too,
 * rather than leaving a stray `"observability": {}` behind. `dataDir` is
 * only written when it differs from the expanded default, so an operator
 * who never customized it gets no new top-level key. Returns the list of
 * human-readable changes made (empty when nothing needed changing). */
function rewriteConfig(
  configPath: string,
  cfg: Config,
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
  if (cfg.dataDir !== defaultDataDir) {
    raw.dataDir = cfg.dataDir;
    receipt.push(`set dataDir = ${cfg.dataDir}`);
  }

  validateConfigObject(raw);

  const tmp = join(dirname(configPath), `.config.json.tmp-${process.pid}`);
  writeFileFn(tmp, JSON.stringify(raw, null, 2) + "\n");
  renameFn(tmp, configPath);
  return receipt;
}

/** Receipt sections stay honest on the catch path: a state-tree phase that
 * never ran prints "not attempted"; one whose `migrateFn` threw MID-RUN prints
 * "interrupted" and points at the durable journal (migrateStateTree journals
 * completed pairs in a `finally`, so their receipts survive the throw — see
 * src/dataMigrate.ts); a config rewrite that never completed prints "not
 * rewritten (error)" rather than the false "no changes needed". */
function printReceipt(
  print: (s: string) => void,
  queueReceipt: string[],
  state: MigrateResult | "not-run" | "interrupted",
  configReceipt: string[] | null,
  migratedFile: string,
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
    print(`\nstate tree: interrupted — any completed steps are journaled in ${migratedFile}\n`);
  } else {
    const acted = state.steps.filter((s) => s.action !== "noop");
    print(
      acted.length > 0
        ? `\nstate tree:\n${acted.map((s) => `  ${s.from} -> ${s.to}: ${s.action}`).join("\n")}\n`
        : "\nstate tree: nothing pending\n",
    );
    if (state.conflicts.length > 0) {
      print(`\nconflicts:\n${state.conflicts.map((c) => `  ${c}`).join("\n")}\n`);
    }
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
  // a dry-run is not a run, and acquirePidfileLock mkdirs the lock file's
  // parent as a side effect, which would fabricate cfg.dataDir on a machine
  // that has never had one — exactly the command's primary audience.
  const qSteps = queueSteps(cfg).map((s) => ({ ...s, pending: existsFn(s.from) }));
  const pending = pendingMigrations(cfg, existsFn);
  const defaultDataDir = expandHome(DEFAULT_DATA_DIR);
  const willSetDataDir = cfg.dataDir !== defaultDataDir;
  const deprecations = configDeprecations(cfg);
  const migratedFile = dataTreePaths(cfg).migratedFile;

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
    print("\nconfig.json:\n");
    print("  would remove: vaultRoot, juncoSubdir, observability.stateDir (if present)\n");
    print(
      willSetDataDir
        ? `  would set: dataDir = ${cfg.dataDir}\n`
        : "  dataDir left unset (matches the default)\n",
    );
    print(`\nstate tree journal: ${migratedFile}\n`);
    return 0;
  }

  // 1b. Migration lock — held for the whole acting run, released in `finally`.
  const lockPath = dataTreePaths(cfg).migrateLockFile;
  const lock = acquirePidfileLock(lockPath);
  if (lock === null) {
    print("junco data migrate: another migrate is running\n");
    return 1;
  }

  const queueReceipt: string[] = [];
  // Phase trackers for an honest catch-path receipt: "not-run" = the phase
  // was never reached; "interrupted" = migrateFn threw mid-run (its completed
  // pairs are journaled durably); null configReceipt = rewrite never completed.
  let stateOutcome: MigrateResult | "not-run" | "interrupted" = "not-run";
  let configReceipt: string[] | null = null;

  try {
    // 3. Queue move. Re-probe existence under the lock — the pre-lock plan
    // flags could be stale if a concurrent migrate completed in between.
    const toMove = qSteps.filter((s) => existsFn(s.from));
    if (toMove.length > 0) {
      mkdirSync(join(cfg.dataDir, "queue"), { recursive: true });
      for (const s of toMove) {
        try {
          renameFn(s.from, s.to);
          queueReceipt.push(`queue/${s.key}: moved ${s.from} -> ${s.to}`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "EXDEV") {
            copyDirFn(s.from, s.to);
            verifyCopy(s.from, s.to);
            fsyncCopied(s.to, syncPathFn); // #196: durable before deleting source
            rmSync(s.from, { recursive: true, force: true });
            queueReceipt.push(`queue/${s.key}: copied (cross-device) ${s.from} -> ${s.to}`);
          } else {
            throw e;
          }
        }
      }
    }

    // 4. State tree. "interrupted" is set first and only overwritten on a
    // clean return — if migrateFn throws mid-run, the catch-path receipt
    // points at the journal instead of claiming "nothing pending".
    stateOutcome = "interrupted";
    stateOutcome = migrateFn(cfg);

    // 5. Config rewrite.
    configReceipt = rewriteConfig(configPath, cfg, readFileFn, writeFileFn, renameFn);

    // 6. Receipt.
    printReceipt(print, queueReceipt, stateOutcome, configReceipt, migratedFile);

    if (stateOutcome.conflicts.length > 0) {
      print(
        `\njunco data migrate: ${stateOutcome.conflicts.length} state-tree conflict(s) — resolve manually and re-run\n`,
      );
      return 1;
    }
    return 0;
  } catch (e) {
    printReceipt(print, queueReceipt, stateOutcome, configReceipt, migratedFile);
    print(`\njunco data migrate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    lock.release();
  }
}
