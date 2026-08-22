/**
 * `junco data` — pure, read-only view of the unified data tree (spec
 * 2026-07-16 §8 "Visibility"): resolved paths, live counts, legacy-override
 * provenance, pending migrations, and config deprecations. `junco data
 * migrate` (src/dataMigrateCmd.ts) is the sibling that actually MUTATES the
 * tree; this command never does — no mkdir, no write, no rename. Every node
 * is listed even when its directory/file does not exist yet (an `(absent)`
 * marker takes the place of its count), so a fresh install shows the full
 * shape of what WOULD exist rather than an empty report.
 */
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config, LegacyPathFlags } from "./types.js";
import { configDeprecations } from "./config.js";
import { dataTreePaths, type DataTreePaths } from "./dataTree.js";
import { pendingMigrations, pendingConfigRelocation } from "./dataMigrate.js";
import { pendingCount, assessReviewPaths } from "./assessReview.js";
import { draftCount, commentReviewPaths } from "./commentReview.js";
import { outboxDepth, deadCount } from "./githubOutbox.js";
import { makeSpendLedger } from "./spendLedger.js";

export interface StatLike {
  isDirectory(): boolean;
  size: number;
}

export interface DataCmdDeps {
  readdirFn?: (d: string) => string[];
  statFn?: (p: string) => StatLike;
  existsFn?: (p: string) => boolean;
  readFileFn?: (p: string) => string;
  printFn?: (s: string) => void;
  /** Clock fed to the spend ledger's local-date read (#199.1). Injecting a
   * fixed instant lets a test build the fixture date and read the ledger off
   * the SAME moment, closing the midnight-rollover flake window. Default:
   * Date.now. */
  nowFn?: () => number;
  /** Process environment — feeds `pendingMigrations`' target/legacy root
   * derivation and the pending config-relocation report (item 11, #281).
   * Defaults to `process.env`; injectable so a test never reads the real
   * HOME/XDG_CONFIG_HOME/JUNCO_CONFIG (the relocation report is a pure
   * function of the config path and these, so without the seam it would
   * answer differently on the maintainer's machine than in CI). */
  env?: Record<string, string | undefined>;
}

interface FileInfo {
  exists: boolean;
  size: number;
}

interface DataCounts {
  queue: { inbox: number; processing: number; done: number; failed: number };
  reviewAssess: { pending: number; filed: number };
  reviewComments: { pending: number; posted: number; discarded: number };
  outbox: { ops: number; dead: number };
  mirror: { repos: number; files: number };
  clonesWatched: { repos: number };
  clonesExternal: { repos: number };
  worktrees: { dirs: number };
  assessHistory: { repos: number };
  history: { files: number };
  transcripts: { files: number; bytes: number };
  watchlistFile: FileInfo;
  updateCheckFile: FileInfo;
  spendFile: FileInfo & { usd: number | null };
  metricsFile: FileInfo;
  logFile: FileInfo;
  migratedFile: FileInfo;
}

// ---------------------------------------------------------------------------
// Counting helpers — every one degrades to a zero-ish result on a missing/
// unreadable directory rather than throwing (same posture as
// statusCmd.ts/githubOutbox.ts's countMd/outboxDepth/deadCount).
// ---------------------------------------------------------------------------

function countByExt(dir: string, ext: string, readdirFn: (d: string) => string[]): number {
  try {
    return readdirFn(dir).filter((n) => n.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

function countMd(dir: string, readdirFn: (d: string) => string[]): number {
  return countByExt(dir, ".md", readdirFn);
}

function countJson(dir: string, readdirFn: (d: string) => string[]): number {
  return countByExt(dir, ".json", readdirFn);
}

function countJsonl(dir: string, readdirFn: (d: string) => string[]): number {
  return countByExt(dir, ".jsonl", readdirFn);
}

function countSubdirs(
  dir: string,
  readdirFn: (d: string) => string[],
  statFn: (p: string) => StatLike,
): number {
  let names: string[];
  try {
    names = readdirFn(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    try {
      if (statFn(join(dir, name)).isDirectory()) n++;
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  return n;
}

/** Two-level owner/repo walk (clonesWatched/clonesExternal/mirror): counts
 * leaf directories one level below an owner directory one level below `dir`. */
function countOwnerRepoDirs(
  dir: string,
  readdirFn: (d: string) => string[],
  statFn: (p: string) => StatLike,
): number {
  let owners: string[];
  try {
    owners = readdirFn(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const owner of owners) {
    const ownerPath = join(dir, owner);
    let st: StatLike;
    try {
      st = statFn(ownerPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    total += countSubdirs(ownerPath, readdirFn, statFn);
  }
  return total;
}

/** Recursive file count under `dir` (mirror's "issue/pr files" — 0 until PR 2,
 * since nothing writes there yet). */
function countNestedFiles(
  dir: string,
  readdirFn: (d: string) => string[],
  statFn: (p: string) => StatLike,
): number {
  let names: string[];
  try {
    names = readdirFn(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    const full = join(dir, name);
    let st: StatLike;
    try {
      st = statFn(full);
    } catch {
      continue;
    }
    total += st.isDirectory() ? countNestedFiles(full, readdirFn, statFn) : 1;
  }
  return total;
}

/** Flat (non-recursive) file count + summed bytes — transcripts/ is one file
 * per ticket (`<ticket-id>.jsonl`), never nested. */
function flatFilesAndBytes(
  dir: string,
  readdirFn: (d: string) => string[],
  statFn: (p: string) => StatLike,
): { files: number; bytes: number } {
  let names: string[];
  try {
    names = readdirFn(dir);
  } catch {
    return { files: 0, bytes: 0 };
  }
  let files = 0;
  let bytes = 0;
  for (const name of names) {
    let st: StatLike;
    try {
      st = statFn(join(dir, name));
    } catch {
      continue;
    }
    if (st.isDirectory()) continue;
    files++;
    bytes += st.size;
  }
  return { files, bytes };
}

function fileInfo(
  path: string,
  existsFn: (p: string) => boolean,
  statFn: (p: string) => StatLike,
): FileInfo {
  if (!existsFn(path)) return { exists: false, size: 0 };
  try {
    return { exists: true, size: statFn(path).size };
  } catch {
    return { exists: true, size: 0 };
  }
}

/** Today's spend via the ledger's OWN read semantics — `makeSpendLedger`'s
 * `todayUsd()` (src/spendLedger.ts read(): missing/corrupt-shape/STALE-DATE
 * → 0), never an ad-hoc reparse: a spend.json from a previous local day must
 * report $0 here exactly like it does to the budget gate, not resurrect
 * yesterday's total. Null only when the file doesn't exist at all (the line
 * already reads "(absent)" — printing $0.00 would fabricate a reading from
 * nothing). `todayUsd()` is a pure read (only `recordUsd` writes), so the
 * view's no-mutation guarantee holds; the ledger's readFileFn is fed from
 * this command's own readFileFn seam (the utf8-string overload is the only
 * one the ledger uses). */
function readSpendUsd(
  path: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string,
  nowFn: () => number,
): number | null {
  if (!existsFn(path)) return null;
  const ledger = makeSpendLedger(path, {
    now: nowFn,
    readFileFn: ((p: string) => readFileFn(p)) as unknown as typeof readFileSync,
  });
  return ledger.todayUsd();
}

/** Human-readable byte size for the text view (e.g. "1.5 KB", "3 MB"). */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

function computeCounts(
  cfg: Config,
  p: DataTreePaths,
  readdirFn: (d: string) => string[],
  statFn: (p: string) => StatLike,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string,
  nowFn: () => number,
): DataCounts {
  const assessPaths = assessReviewPaths(cfg);
  const commentPaths = commentReviewPaths(cfg);
  return {
    queue: {
      inbox: countMd(p.queue.inbox, readdirFn),
      processing: countMd(p.queue.processing, readdirFn),
      done: countMd(p.queue.done, readdirFn),
      failed: countMd(p.queue.failed, readdirFn),
    },
    reviewAssess: {
      pending: pendingCount(cfg, { readdirFn }),
      filed: countJson(assessPaths.filed, readdirFn),
    },
    reviewComments: {
      pending: draftCount(cfg, { readdirFn }),
      posted: countJson(commentPaths.posted, readdirFn),
      discarded: countJson(commentPaths.discarded, readdirFn),
    },
    outbox: {
      ops: outboxDepth(cfg, { readdirFn }),
      dead: deadCount(cfg, { readdirFn }),
    },
    mirror: {
      repos: countOwnerRepoDirs(p.mirror, readdirFn, statFn),
      files: countNestedFiles(p.mirror, readdirFn, statFn),
    },
    clonesWatched: { repos: countOwnerRepoDirs(p.clonesWatched, readdirFn, statFn) },
    clonesExternal: { repos: countOwnerRepoDirs(p.clonesExternal, readdirFn, statFn) },
    worktrees: { dirs: countSubdirs(p.worktrees, readdirFn, statFn) },
    assessHistory: { repos: countJson(p.assessHistory, readdirFn) },
    history: { files: countJsonl(p.history, readdirFn) },
    transcripts: flatFilesAndBytes(p.transcripts, readdirFn, statFn),
    watchlistFile: fileInfo(p.watchlistFile, existsFn, statFn),
    updateCheckFile: fileInfo(p.updateCheckFile, existsFn, statFn),
    spendFile: {
      ...fileInfo(p.spendFile, existsFn, statFn),
      usd: readSpendUsd(p.spendFile, existsFn, readFileFn, nowFn),
    },
    metricsFile: fileInfo(p.metricsFile, existsFn, statFn),
    logFile: fileInfo(p.logFile, existsFn, statFn),
    migratedFile: fileInfo(p.migratedFile, existsFn, statFn),
  };
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

/** "<label> <n>" when the dir exists, "<label> (absent)" when it doesn't —
 * the count is meaningless (and misleadingly "0") for a directory that was
 * never created, so absence gets its own explicit marker. */
function fmtBox(label: string, dir: string, n: number, existsFn: (p: string) => boolean): string {
  return `${label} ${existsFn(dir) ? String(n) : "(absent)"}`;
}

function legacySuffix(legacy: LegacyPathFlags, key: keyof LegacyPathFlags): string {
  return legacy[key] ? ` ← legacy override: ${key}  [deprecated]` : "";
}

function renderText(
  cfg: Config,
  p: DataTreePaths,
  counts: DataCounts,
  pending: Array<{ from: string; to: string }>,
  configMove: { from: string; to: string } | null,
  deprecations: string[],
  existsFn: (p: string) => boolean,
  print: (s: string) => void,
): void {
  const legacy = cfg.legacy;
  const suf = (key: keyof LegacyPathFlags): string => legacySuffix(legacy, key);
  // Single-root move hint (2026-08-03 plan): distinct from the per-subtree
  // `suf(...)` overrides above — this fires when the WHOLE root resolved via
  // the pre-0.10 `~/.local/state/junco` fallback (config.ts's
  // resolveDataRoot), not because any individual key was overridden.
  const legacyRootHint = legacy.dataRoot ? ` (legacy — run 'junco data migrate')` : "";

  print(`junco data — root: ${p.root}${suf("stateDir")}${legacyRootHint}\n`);

  print(`\nqueue      ${cfg.queueRoot}${suf("vaultRoot")}\n`);
  print(
    `  ${fmtBox("inbox", p.queue.inbox, counts.queue.inbox, existsFn)} · ` +
      `${fmtBox("processing", p.queue.processing, counts.queue.processing, existsFn)} · ` +
      `${fmtBox("done", p.queue.done, counts.queue.done, existsFn)} · ` +
      `${fmtBox("failed", p.queue.failed, counts.queue.failed, existsFn)}\n`,
  );

  print(`\nreview\n`);
  print(
    `  ${"assess".padEnd(10)}${
      existsFn(p.reviewAssess)
        ? `${counts.reviewAssess.pending} pending · ${counts.reviewAssess.filed} filed`
        : "(absent)"
    }   ${p.reviewAssess}\n`,
  );
  print(
    `  ${"comments".padEnd(10)}${
      existsFn(p.reviewComments)
        ? `${counts.reviewComments.pending} pending · ${counts.reviewComments.posted} posted · ` +
          `${counts.reviewComments.discarded} discarded`
        : "(absent)"
    }   ${p.reviewComments}\n`,
  );

  print(
    `\noutbox     ${
      existsFn(p.outbox) ? `ops ${counts.outbox.ops} · dead ${counts.outbox.dead}` : "(absent)"
    }   ${p.outbox}\n`,
  );

  print(
    `\nmirror     ${
      existsFn(p.mirror)
        ? `${counts.mirror.repos} repos · ${counts.mirror.files} files`
        : "(absent)"
    }   ${p.mirror}\n`,
  );

  print(`\nclones\n`);
  print(
    `  ${"watched".padEnd(10)}${
      existsFn(p.clonesWatched) ? `${counts.clonesWatched.repos} repos` : "(absent)"
    }   ${p.clonesWatched}\n`,
  );
  print(
    `  ${"external".padEnd(10)}${
      existsFn(p.clonesExternal) ? `${counts.clonesExternal.repos} repos` : "(absent)"
    }   ${p.clonesExternal}${suf("externalReposRoot")}\n`,
  );

  print(
    `\nworktrees  ${
      existsFn(p.worktrees) ? `${counts.worktrees.dirs} dirs` : "(absent)"
    }   ${p.worktrees}${suf("worktreeRoot")}\n`,
  );

  print(
    `\nassess-history ${
      existsFn(p.assessHistory) ? `${counts.assessHistory.repos} repos` : "(absent)"
    }   ${p.assessHistory}\n`,
  );

  print(
    `\nhistory ${
      existsFn(p.history) ? `${counts.history.files} shards` : "(absent)"
    }   ${p.history}\n`,
  );

  print(
    `\ntranscripts ${
      existsFn(p.transcripts)
        ? `${counts.transcripts.files} files · ${humanSize(counts.transcripts.bytes)}`
        : "(absent)"
    }   ${p.transcripts}\n`,
  );

  print(`\nfiles\n`);
  const fileLine = (label: string, path: string, info: FileInfo, extra = ""): void => {
    print(
      `  ${label.padEnd(16)}${info.exists ? humanSize(info.size) : "(absent)"}${extra}   ${path}\n`,
    );
  };
  fileLine("watchlist.json", p.watchlistFile, counts.watchlistFile);
  fileLine("update-check.json", p.updateCheckFile, counts.updateCheckFile);
  fileLine(
    "spend.json",
    p.spendFile,
    counts.spendFile,
    counts.spendFile.usd !== null ? ` · $${counts.spendFile.usd.toFixed(2)} today` : "",
  );
  fileLine("metrics.json", p.metricsFile, counts.metricsFile);
  fileLine("worker.log", p.logFile, counts.logFile);
  fileLine("migrated.json", p.migratedFile, counts.migratedFile);

  if (pending.length > 0 || configMove !== null) {
    print(`\n`);
    for (const m of pending) {
      print(`⚠ unmigrated: ${m.from} → ${m.to} (run 'junco data migrate')\n`);
    }
    // Item 11 (#281): its own line, and its own wording — every line above is
    // a data DIRECTORY still awaiting a move, this one is the config FILE.
    // Without it `junco data` claimed the tree was fully unified while
    // `junco data migrate`'s phase 9 still owed this relocation.
    if (configMove !== null) {
      print(
        `⚠ config not relocated: ${configMove.from} → ${configMove.to} ` +
          `(run 'junco data migrate')\n`,
      );
    }
  }

  if (deprecations.length > 0) {
    print(`\ndeprecations:\n`);
    for (const d of deprecations) print(`  ${d}\n`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `junco data` — pure view: reads paths/counts, never mutates. `opts.json`
 * emits the machine-readable shape instead of the human tree.
 *
 * `configPath` is this process's ALREADY-RESOLVED config path (same second
 * positional as `runDataMigrate`, deliberately — they are siblings over the
 * same tree). It is here only so the view can report a pending config-file
 * relocation (item 11, #281) through the mover's own gate; nothing is read
 * from it.
 */
export function runData(
  cfg: Config,
  configPath: string,
  opts: { json: boolean },
  deps: DataCmdDeps = {},
): number {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const statFn = deps.statFn ?? statSync;
  const existsFn = deps.existsFn ?? existsSync;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const nowFn = deps.nowFn ?? (() => Date.now());
  const env = deps.env ?? process.env;

  const p = dataTreePaths(cfg);
  const pending = pendingMigrations(cfg, existsFn, env);
  // Item 11 (#281): NOT folded into `pending` — that array is also doctor's
  // "unmigrated data dirs" list, and a config.json among data directories
  // would misname it in both places. `pendingConfigRelocation` is `junco data
  // migrate`'s OWN phase-9 gate (dataMigrate.ts), so this view can never
  // report a relocation the mover refuses to perform — in particular under a
  // JUNCO_CONFIG override (#307), where an explicitly-named config is
  // deliberately never relocated.
  const configMove = pendingConfigRelocation(configPath, env);
  const deprecations = configDeprecations(cfg);
  const counts = computeCounts(cfg, p, readdirFn, statFn, existsFn, readFileFn, nowFn);

  if (opts.json) {
    print(
      JSON.stringify(
        {
          root: p.root,
          layout: cfg.dataLayout,
          paths: p,
          counts,
          legacy: cfg.legacy,
          pendingMigrations: pending,
          // Always present, `null` when nothing is owed — a key that appears
          // only sometimes makes every consumer write the same optional-chain
          // twice over.
          pendingConfigRelocation: configMove,
          deprecations,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  renderText(cfg, p, counts, pending, configMove, deprecations, existsFn, print);
  return 0;
}
