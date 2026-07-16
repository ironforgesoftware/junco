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
} from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";

export interface MigrationStep {
  from: string;
  to: string;
  action: "renamed" | "skipped-conflict" | "noop";
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
}

interface Journal {
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

/** Pairs whose source currently exists — used by `junco data`/doctor to
 * report pending migrations without touching the filesystem. */
export function pendingMigrations(
  cfg: Config,
  existsFn: (p: string) => boolean = existsSync,
): Array<{ from: string; to: string }> {
  return stateTreeMigrations(cfg).filter((m) => existsFn(m.from));
}

/** RECURSIVE emptiness check: true when the subtree holds directories only —
 * zero files anywhere. That is exactly what ensureDataTree materializes
 * (nested archive dirs like review/assess/filed), so a dst in that state is
 * scaffolding, not data, and is safe to replace; any file anywhere makes it
 * real data. Non-directory entries (files, symlinks — never followed) count
 * as content. An ENOTDIR at the top (dst is a file — the watchlist pair) is
 * never "empty"; any other error (EACCES etc.) is a genuine fs error and
 * propagates rather than being swallowed. */
function isRecursivelyEmptyDir(
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

function readJournal(path: string, readFileFn: (p: string) => string): Journal {
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

function appendJournal(
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
  renameFn(tmp, path); // atomic tmp+rename — same pattern as reviewStore/watchlist writes
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

  const steps: MigrationStep[] = [];
  const conflicts: string[] = [];

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
  } finally {
    const completed = steps.filter((s) => s.action !== "noop");
    if (completed.length > 0) {
      appendJournal(dataTreePaths(cfg).migratedFile, completed, readFileFn, writeFileFn, renameFn);
    }
  }

  return { steps, conflicts };
}
