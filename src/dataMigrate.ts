/**
 * In-place state-tree migration (spec 2026-07-16 §7): same-directory renames
 * from the pre-unification names to the dataTree.ts names, journaled to
 * <dataDir>/migrated.json. Runs at daemon startup (before ensureDataTree —
 * eager mkdir would otherwise fabricate empty destinations) and from
 * `junco data migrate` (`junco data` only REPORTS pending migrations via
 * pendingMigrations). github-cache/ is deliberately NOT touched until PR 2
 * (tui/ghClient.ts still owns it; migration there is a delete, not a rename).
 *
 * Per spec: "Each completed step is journaled ... re-running is a no-op."
 * Only steps that actually DO something (renamed / skipped-conflict) are
 * appended to the persisted journal — routine "noop" (nothing to migrate) is
 * NOT journaled, or every one of the daemon's countless future startups would
 * append 6 more inert entries to migrated.json forever. A from-scratch
 * dataDir that never had legacy dirs never gets a migrated.json at all: the
 * file is a receipt for actual migrations, not a startup heartbeat. The
 * in-memory MigrateResult returned to the caller (and logged/tested) DOES
 * include every pair's outcome, noop included, for full visibility.
 */
import {
  existsSync,
  renameSync,
  readdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";
import { juncoHome, homeOf } from "./config.js";
import { log } from "./logging.js";

export interface MigrationStep {
  from: string;
  to: string;
  // "rewrote" (task-2, #283): dataMigrateCmd.ts's post-move path-rewrite
  // phase (src/migratePathRewrite.ts) — journaled as one summary step for
  // the whole phase, not per rewritten value. readJournal/appendJournal are
  // both generic over this field (appendJournal only special-cases
  // "skipped-conflict" for its dedup rule; every other action, "rewrote"
  // included, always appends) — neither needed a change for this addition.
  action: "renamed" | "skipped-conflict" | "noop" | "rewrote";
}

export interface MigrateResult {
  steps: MigrationStep[];
  conflicts: string[];
}

export interface MigrateDeps {
  existsFn?: (p: string) => boolean;
  renameFn?: (from: string, to: string) => void;
  /** Typed readdir (withFileTypes) — the recursive emptiness check needs to
   * tell files from directories. Default: readdirSync(d, {withFileTypes}). */
  readdirTypedFn?: (d: string) => Array<{ name: string; isDirectory(): boolean }>;
  /** Recursive directory removal for a repairable (file-free) dst.
   * Default: rmSync(d, {recursive: true}). */
  rmFn?: (d: string) => void;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  /** Where a journal-write failure that follows a migration error is logged
   * (rather than being allowed to mask the original — #197.1). Default:
   * log.warn. */
  logFn?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface Journal {
  version: 1;
  steps: MigrationStep[];
}

/**
 * The full old-name → new-name pair list for the resolved dataDir. `external`
 * only migrates when the external root is NOT legacy-overridden — an
 * explicit `externalReposRoot` keeps clones wherever the operator put them,
 * so there is nothing under dataDir to rename for that pair.
 */
export function stateTreeMigrations(cfg: Config): Array<{ from: string; to: string }> {
  const r = cfg.dataDir;
  const p = dataTreePaths(cfg);
  const list = [
    { from: join(r, "assess-review"), to: p.reviewAssess },
    { from: join(r, "comment-review"), to: p.reviewComments },
    { from: join(r, "github-outbox"), to: p.outbox },
    { from: join(r, "repos"), to: p.clonesWatched },
    { from: join(r, "github-watchlist.json"), to: p.watchlistFile },
  ];
  if (!cfg.legacy.externalReposRoot) {
    list.push({ from: join(r, "external"), to: p.clonesExternal });
  }
  return list;
}

/** Flat→v2 mapping for the single-root move (2026-08-03 plan). Serves both
 * the cross-root move (fromRoot ≠ toRoot: legacy ~/.local/state/junco →
 * ~/.junco) and the in-place restructure (fromRoot === toRoot: an explicit
 * dataDir keeping its location but adopting the v2 shape). `clones` moves as
 * ONE rename (covers watched/ + external/); identity pairs are skipped. */
export function flatToV2Pairs(
  fromRoot: string,
  toRoot: string,
): Array<{ from: string; to: string }> {
  const pairs: Array<[string, string]> = [
    ["queue", "queue"],
    ["review", "review"],
    ["watchlist.json", "watchlist.json"],
    ["migrated.json", "migrated.json"],
    ["outbox", "data/outbox"],
    ["assess-history", "data/assess-history"],
    ["history", "data/history"],
    ["transcripts", "data/transcripts"],
    ["plans", "data/plans"],
    ["spend.json", "data/spend.json"],
    ["metrics.json", "data/metrics.json"],
    ["clones", "cache/clones"],
    ["worktrees", "cache/worktrees"],
    ["github-cache", "cache/github-cache"],
    ["mirror", "cache/mirror"],
    ["update-check.json", "cache/update-check.json"],
    ["worker.log", "logs/worker.log"],
  ];
  return pairs
    .map(([f, t]) => ({ from: join(fromRoot, f), to: join(toRoot, t) }))
    .filter((p) => p.from !== p.to);
}

/** The single-root move target (2026-08-03 plan — see `dataMigrateCmd.ts`'s
 * module doc comment for the full rationale): `juncoHome(env)` when
 * `cfg.legacy.dataRoot` (a pre-0.10 `~/.local/state/junco` tree adopted via
 * config.ts's probe-based fallback — see resolveDataRoot), else `cfg.dataDir`
 * (an explicit dataDir keeps its own location; only its SHAPE may change).
 * Factored out here so `dataMigrateCmd.ts` (the actual mover) and
 * `pendingMigrations` below (read-only reporting) can never disagree on
 * where a pending move would land. */
export function migrationTargetRoot(
  cfg: Config,
  env: Record<string, string | undefined> = process.env,
): string {
  return cfg.legacy.dataRoot ? juncoHome(env) : cfg.dataDir;
}

/** The fixed pre-0.10 fallback path (config.ts's `resolveDataRoot` probes the
 * exact same literal) — only relevant to a run whose target is the canonical
 * `~/.junco` (an operator with a genuinely custom, unrelated `dataDir` must
 * never have an unrelated `~/.local/state/junco` swept in). Not
 * existence-gated here: `dataRootPairs`/`dataMigrateCmd.ts`'s lock-root set
 * only act on it per-pair/via `existsFn` themselves, so a nonexistent
 * candidate is simply inert rather than needing a second check everywhere
 * it's threaded through. Exported (moved from `dataMigrateCmd.ts`, 2026-08-05
 * task-6 review) so `pendingMigrations` below reuses the EXACT SAME
 * source-existence logic the actual `junco data migrate` mover uses via
 * `dataRootPairs` — the two can never drift apart on what's pending. */
export function fixedLegacyRoot(
  targetRoot: string,
  env: Record<string, string | undefined>,
): string | null {
  return targetRoot === juncoHome(env) ? join(homeOf(env), ".local", "state", "junco") : null;
}

export interface DataRootPair {
  from: string;
  to: string;
  pending: boolean;
}

/** The flat→v2 data-root pairs whose source currently exists, probed from
 * EVERY root that could hold one (Critical 1 — see `dataMigrateCmd.ts`'s
 * module doc comment): `cfg.dataDir` (this run's current resolution) and,
 * whenever relevant, the FIXED legacy path — independently of what
 * `cfg.legacy.dataRoot` says, since that flag can no longer see stragglers
 * once resolution has flipped away from the legacy root (the resumed-
 * migration case). Pairs from different source roots that land on the SAME
 * target are deduped, preferring whichever source actually has something
 * pending (the rare case where both somehow do is left for
 * `moveDataRootPair`'s own `existsFn(to)` conflict check to catch safely, in
 * `dataMigrateCmd.ts`). Exported (moved from `dataMigrateCmd.ts`, 2026-08-05
 * task-6 review — see `pendingMigrations` below) so the actual mover and the
 * read-only reporter share one source-existence implementation instead of
 * two that can silently drift: this is purely existence-driven, with NO
 * `cfg.legacy.dataRoot`/`cfg.dataLayout` gate — a real flat-named path on
 * disk under `cfg.dataDir` is pending regardless of what the config's OWN
 * fields currently claim about it (an explicit, non-legacy dataDir that
 * simply hasn't been restructured to v2 yet is exactly as pending as a
 * legacy-root cross-root move). */
export function dataRootPairs(
  cfg: Config,
  targetRoot: string,
  legacyRoot: string | null,
  existsFn: (p: string) => boolean,
): DataRootPair[] {
  const sourceRoots =
    legacyRoot !== null && legacyRoot !== cfg.dataDir ? [cfg.dataDir, legacyRoot] : [cfg.dataDir];
  const byTarget = new Map<string, DataRootPair>();
  for (const sourceRoot of sourceRoots) {
    for (const pair of flatToV2Pairs(sourceRoot, targetRoot)) {
      const pending = existsFn(pair.from);
      const existing = byTarget.get(pair.to);
      if (!existing || (pending && !existing.pending)) {
        byTarget.set(pair.to, { ...pair, pending });
      }
    }
  }
  return [...byTarget.values()];
}

/** Just the state-tree portion of `pendingMigrations` — old-name dirs whose
 * source currently exists. Exported so `dataMigrateCmd.ts`'s dry-run "state
 * tree:" section (which reports it in its own dedicated block, separate from
 * "data root:") shares this exact filter rather than reimplementing it
 * inline (they'd drift otherwise, same reasoning as `dataRootPairs` above). */
export function pendingStateTreeMigrations(
  cfg: Config,
  existsFn: (p: string) => boolean = existsSync,
): Array<{ from: string; to: string }> {
  return stateTreeMigrations(cfg).filter((m) => existsFn(m.from));
}

/** Pairs whose source currently exists — used by `junco data`/doctor to
 * report pending migrations without touching the filesystem (beyond
 * `existsFn` probes). Two independent migrations, concatenated:
 *   - state-tree pairs (`pendingStateTreeMigrations`): old-name dirs still
 *     present under `cfg.dataDir`, waiting on the same-directory rename
 *     `junco data migrate`'s state-tree phase performs.
 *   - single-root layout/root pairs (`dataRootPairs`, filtered to
 *     `.pending`): UNCONDITIONAL — no `cfg.legacy.dataRoot` gate. Reusing
 *     `dataRootPairs` (the exact function `junco data migrate` itself plans
 *     against) means `junco data`/doctor can never report a truncated
 *     picture of what a migrate run would actually act on: it covers both
 *     an explicit, non-legacy, still-flat-shaped `dataDir` (an in-place
 *     restructure is genuinely pending) AND a resumed cross-root migration
 *     (`cfg.legacy.dataRoot` already flipped false because the target root
 *     gained its first marker, while a straggler is still sitting in the
 *     FIXED legacy root — `dataRootPairs` probes that fixed path
 *     independently of the flag for exactly this reason). */
export function pendingMigrations(
  cfg: Config,
  existsFn: (p: string) => boolean = existsSync,
  env: Record<string, string | undefined> = process.env,
): Array<{ from: string; to: string }> {
  const targetRoot = migrationTargetRoot(cfg, env);
  const legacyRoot = fixedLegacyRoot(targetRoot, env);
  const layoutPending = dataRootPairs(cfg, targetRoot, legacyRoot, existsFn)
    .filter((p) => p.pending)
    .map(({ from, to }) => ({ from, to }));
  return [...pendingStateTreeMigrations(cfg, existsFn), ...layoutPending];
}

/** RECURSIVE emptiness check: true when the subtree holds directories only —
 * zero files anywhere. That is exactly what ensureDataTree materializes
 * (nested archive dirs like review/assess/filed), so a dst in that state is
 * scaffolding, not data, and is safe to replace; any file anywhere makes it
 * real data. Non-directory entries (files, symlinks — never followed) count
 * as content. An ENOTDIR at the top (dst is a file — the watchlist pair) is
 * never "empty"; any other error (EACCES etc.) is a genuine fs error and
 * propagates rather than being swallowed. Exported for `dataMigrateCmd.ts`'s
 * flat→v2 data-root move (2026-08-03 plan): the same conflict semantics
 * apply there — reused, not reimplemented. */
export function isRecursivelyEmptyDir(
  dst: string,
  readdirTypedFn: (d: string) => Array<{ name: string; isDirectory(): boolean }>,
): boolean {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirTypedFn(dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOTDIR") return false;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) return false;
    if (!isRecursivelyEmptyDir(join(dst, entry.name), readdirTypedFn)) return false;
  }
  return true;
}

/** Exported for `dataMigrateCmd.ts`'s migrated.json self-reference merge
 * (task review round 2, Important — see `dataMigrateCmd.ts`'s module doc
 * comment on the `migrated.json` pair): reading the legacy journal's steps
 * before merging them into the target reuses this exact tolerant parse
 * (missing/corrupt → empty) instead of a second implementation. */
export function readJournal(path: string, readFileFn: (p: string) => string): Journal {
  try {
    const parsed: unknown = JSON.parse(readFileFn(path));
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Journal).steps)) {
      return { version: 1, steps: (parsed as Journal).steps };
    }
    return { version: 1, steps: [] };
  } catch {
    // Missing file or corrupt/unparseable content — never throw, start fresh.
    return { version: 1, steps: [] };
  }
}

/** Append `newSteps` (already-filtered to non-noop outcomes by the caller) to
 * the journal at `path`, read-modify-write with the same dedupe-repeated-
 * conflicts semantics `migrateStateTree` uses for its own journal. Exported
 * for `dataMigrateCmd.ts`'s data-root/gh-creds move (2026-08-03 plan,
 * Critical 1 fix): reused verbatim rather than reimplemented, so both
 * journals share one format and one de-dup rule. */
export function appendJournal(
  path: string,
  newSteps: MigrationStep[],
  readFileFn: (p: string) => string,
  writeFileFn: (p: string, s: string) => void,
  renameFn: (from: string, to: string) => void,
): void {
  const existing = readJournal(path, readFileFn);
  // A PERSISTENT conflict re-surfaces on every startup until the operator
  // resolves it — journal it once, not once per run (the journal is a receipt
  // of distinct outcomes, not a heartbeat). "renamed" entries always append:
  // the same pair can genuinely rename twice (operator restores a backup).
  const seen = new Set(
    existing.steps
      .filter((s) => s.action === "skipped-conflict")
      .map((s) => `${s.from}\u0000${s.to}`),
  );
  const fresh = newSteps.filter(
    (s) => s.action !== "skipped-conflict" || !seen.has(`${s.from}\u0000${s.to}`),
  );
  if (fresh.length === 0) return; // nothing new — don't rewrite the file
  const journal: Journal = { version: 1, steps: [...existing.steps, ...fresh] };
  const tmp = `${path}.tmp`;
  writeFileFn(tmp, JSON.stringify(journal, null, 2) + "\n");
  try {
    renameFn(tmp, path); // atomic tmp+rename — same pattern as reviewStore/watchlist writes
  } catch (renameErr) {
    // The rename is the ONLY step that can fail after `tmp` is already a real
    // file on disk (writeFileFn either fully succeeds or throws before
    // creating anything) — best-effort unlink it so a genuine fs error here
    // doesn't leave an unmapped `<name>.tmp` sitting next to the journal
    // forever (nothing in flatToV2Pairs/stateTreeMigrations accounts for a
    // `.tmp` suffix, so it would permanently block an empty-dir rmdir at
    // whichever root `path` lives under). Never masks the real error: a
    // failed unlink (ENOENT if the rename partially completed despite
    // throwing, EACCES, ...) is swallowed, and `renameErr` always propagates.
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort — the original renameErr below is what matters */
    }
    throw renameErr;
  }
}

/**
 * Runs the migration for every pending pair. Decision rules per pair:
 *   - src missing                      → "noop" (dst, if any, is untouched)
 *   - dst missing                      → mkdir(dirname(to)), rename, "renamed"
 *   - dst exists, RECURSIVELY empty    → rm -r dst, rename, "renamed"
 *     (directories only, zero files      (repairs a crash-after-mkdir from a
 *     anywhere in the subtree)           previous partial run AND
 *                                        ensureDataTree's own nested
 *                                        scaffolding materialized while the
 *                                        old-name dir still held the data —
 *                                        version rollback, old-CLI writes)
 *   - dst has any FILE anywhere        → "skipped-conflict" (pushed to
 *     (or is itself a file — the         conflicts; nothing destroyed on
 *     watchlist pair)                    either side)
 * Never throws for a conflict — it is reported, not raised. Genuine fs
 * errors (EACCES etc.) may still propagate — but the journal write runs in
 * a `finally`, so pairs that DID rename before the throw still get their
 * receipt: their src is gone, so a later run resolves them to "noop" and
 * could never back-fill the entry.
 */
export function migrateStateTree(cfg: Config, deps: MigrateDeps = {}): MigrateResult {
  const existsFn = deps.existsFn ?? existsSync;
  const renameFn = deps.renameFn ?? renameSync;
  const readdirTypedFn =
    deps.readdirTypedFn ?? ((d: string) => readdirSync(d, { withFileTypes: true }));
  const rmFn = deps.rmFn ?? ((d: string) => rmSync(d, { recursive: true }));
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const logFn = deps.logFn ?? ((m: string, f?: Record<string, unknown>) => log.warn(m, f));

  const steps: MigrationStep[] = [];
  const conflicts: string[] = [];
  // #197.1: track clean completion so the finally can tell a journal-write
  // failure that FOLLOWS a migration error (must not mask it) from one on the
  // happy path (must still propagate — a silently unwritten receipt is a bug).
  let loopCompleted = false;

  // The journal append lives in `finally`: a genuine fs error on a LATER
  // pair must not lose the receipts of pairs that already renamed on disk
  // this run — their src is gone, so a re-run sees them as "noop" and the
  // journal entry could never be back-filled. Steps are only pushed AFTER
  // their rename succeeds, so the pair that threw is never journaled.
  try {
    for (const { from, to } of stateTreeMigrations(cfg)) {
      if (!existsFn(from)) {
        steps.push({ from, to, action: "noop" });
        continue;
      }
      if (!existsFn(to)) {
        mkdirSync(dirname(to), { recursive: true });
        renameFn(from, to);
        steps.push({ from, to, action: "renamed" });
        continue;
      }
      if (isRecursivelyEmptyDir(to, readdirTypedFn)) {
        rmFn(to);
        renameFn(from, to);
        steps.push({ from, to, action: "renamed" });
        continue;
      }
      steps.push({ from, to, action: "skipped-conflict" });
      conflicts.push(`${from} -> ${to}: destination already exists and is not empty`);
    }
    loopCompleted = true;
  } finally {
    const completed = steps.filter((s) => s.action !== "noop");
    if (completed.length > 0) {
      try {
        appendJournal(
          dataTreePaths(cfg).migratedFile,
          completed,
          readFileFn,
          writeFileFn,
          renameFn,
        );
      } catch (journalErr) {
        // #197.1: JS finally semantics let a throw here REPLACE the in-flight
        // migration error. On the throwing path, log the journal failure and
        // let the original error propagate; on the clean path, propagate the
        // journal error (an unwritten receipt must not be swallowed).
        if (loopCompleted) throw journalErr;
        logFn("state-tree migration: journal write failed after a migration error", {
          error: journalErr instanceof Error ? journalErr.message : String(journalErr),
        });
      }
    }
  }

  return { steps, conflicts };
}
