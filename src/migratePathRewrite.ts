/**
 * Rewrites absolute paths recorded INSIDE the watchlist, queue tickets, and
 * four more JSON stores after `junco data migrate` has relocated the files
 * that hold them (#283). `junco data migrate` moves the tree correctly, but
 * `repo:`/`workdir:` frontmatter, watchlist `path` entries, and every store
 * below are opaque strings to every phase that came before this one — they
 * still point at the pre-migration root, so `junco doctor` reports every
 * watched repo as "not a git clone" the moment the legacy root is gone.
 *
 * The four additional stores, each verified (task-3 brief) to hold exactly
 * one absolute path field:
 *   - Pending assess batches (`PendingAssess.repoPath`, assessReview.ts) —
 *     one JSON file per batch under `review/assess` (identity-named under
 *     v2 too — flatToV2Pairs' `["review", "review"]` pair — so only the
 *     root changes).
 *   - Pending comment drafts (`PendingComment.repoPath`, commentReview.ts) —
 *     same shape, under `review/comments`.
 *   - Outbox ops (`op.repoPath`, githubOutbox.ts) — but ONLY the `push`/`pr`
 *     variants; `labels`/`comment`/`issue-create` carry no path. Walked in
 *     both the outbox dir and its `dead/` subdir. `StoredOp.path` is
 *     DERIVED at read time from the directory listing and stripped before
 *     writing (`Omit<StoredOp, "path">`) — never present on disk, never
 *     rewritten here.
 *   - Plan-set records (`PlanSetRecord.repoPath`, planSets.ts) — one JSON
 *     file per record under `plans/` (flat) / `data/plans` (v2 — the shape
 *     this phase always finds it in, since it runs after the data-root
 *     move has already restructured the target to v2).
 *
 * Four design rules, all load-bearing (see the task brief):
 *
 *   1. Rewrite only under prefixes that ACTUALLY moved. `buildPrefixMap`
 *      is built exclusively from journal steps whose `action` is
 *      `"renamed"` — never from the full candidate pair list. A
 *      `skipped-conflict` pair did not move; treating it as a rewrite
 *      target would point live data at a path that was never created,
 *      which is worse than the bug being fixed.
 *
 *      `buildPrefixMap` also transitively CLOSES the map (fix-wave review
 *      #283 Critical 1): the journal can legitimately contain a same-
 *      directory rename (`migrateStateTree`'s phase-4 normalization) AND a
 *      later root-level move of the renamed tree's new parent — e.g.
 *      `<root>/repos -> <root>/clones/watched` followed by
 *      `<root>/clones -> <target>/cache/clones`. `rewritePath` (below)
 *      applies exactly ONE matching prefix per call, so a stored value that
 *      matches the FIRST (same-directory) step would land on that
 *      intermediate hop — a path this run then deletes when it removes the
 *      legacy root — instead of the true final destination. `buildPrefixMap`
 *      resolves each entry's `to` against the same step set until it stops
 *      changing (bounded by the step count; a visited-value set stops and
 *      warns rather than looping or picking an arbitrary intermediate value
 *      if the journal ever contained a cycle), so by the time `rewritePath`
 *      sees the map every entry's `to` is already the FINAL destination and
 *      a single hop is always enough.
 *   2. Never touch paths outside those prefixes. A repo cloned at
 *      `~/dev/foo` (or anywhere else junco never owned) is left alone —
 *      `rewritePath` returns `null` the moment no prefix applies.
 *   3. Path-BOUNDARY matching, not `startsWith`. `/old/clones-backup` must
 *      never be rewritten by an `/old/clones` prefix — matching requires
 *      an exact hit or a hit followed by `path.sep`.
 *   4. Idempotent. An already-rewritten path (its prefix is now the NEW
 *      root, not the old one) matches nothing in the map and is returned
 *      unchanged — a resumed or re-run migrate is a no-op here, exactly
 *      like every other phase's journal-driven resume story. On a run with
 *      nothing left of ITS OWN to move, this now falls out of rule 2 rather
 *      than an empty map: `dataMigrateCmd.ts` seeds `buildPrefixMap`'s input
 *      from the durable on-disk journal (`readJournal` + `dedupeSteps`,
 *      fix-wave review #283 Important 2) in ADDITION to this run's own
 *      steps, so a resumed run whose PRIOR run already renamed a tree (and
 *      journaled it in a `finally`) but died before reaching this phase can
 *      still rebuild that prefix — the map is not necessarily empty, but
 *      every value under it has already been rewritten, so `rewritePath`
 *      returns `null` for all of them and nothing changes twice.
 *
 * Two more failure modes, both warn-and-continue, never abort (a read/parse
 * failure on any ONE file — unreadable ticket, corrupt watchlist — or a
 * `repo:`/`workdir:` value present but not in a shape this phase can
 * rewrite, e.g. a YAML block scalar): appended to the caller's
 * `RewriteReport.warnings`, phase moves on. The second case (fix-wave
 * review #283 Important 1) matters exactly as much as the first: before it,
 * an unrewritable-but-present field was silently skipped with NO warning at
 * all — a destructive migration reporting clean success while leaving part
 * of the operator's live queue pointed at a root that no longer exists.
 * `rewriteFrontmatterField`'s own doc comment has the full shape inventory
 * (double-quoted / single-quoted / plain scalar, and what still isn't
 * handled).
 */
import { sep, join, dirname, basename } from "node:path";
import type { Paths } from "./types.js";
import type { MigrationStep } from "./dataMigrate.js";
import { readWatchlist, writeWatchlist } from "./watchlist.js";
import { WATCHLIST_FILENAME, REVIEW_ASSESS_SUBDIR, REVIEW_COMMENTS_SUBDIR } from "./dataTree.js";
import { expandHome } from "./config.js";

// Outbox and plan-set records are NOT identity-named under v2 (unlike
// review/, which flatToV2Pairs maps "review" -> "review"): dataMigrate.ts's
// flatToV2Pairs maps "outbox" -> "data/outbox" and "plans" -> "data/plans".
// This phase runs after the data-root move has already landed the target at
// its v2 shape (dataMigrateCmd.ts inserts it post-move, pre-legacy-removal),
// so these are the only shapes it ever needs to look under — no LAYOUTS
// lookup required. Not exported from dataTree.ts today (only the flat names
// are), so mirrored here rather than added as a dependency for two literals.
const OUTBOX_V2_SUBDIR = "data/outbox";
const PLANS_V2_SUBDIR = "data/plans";

export interface PathPrefix {
  from: string;
  to: string;
}

/**
 * The actually-relocated prefixes, longest-`from`-first so a nested pair
 * (e.g. `/old/clones`) is tried before its parent (`/old`) and wins.
 * Only `"renamed"` steps count — see design rule 1 above.
 *
 * Each entry's `to` is transitively resolved against the SAME step set
 * before this returns (fix-wave review #283 Critical 1) — a `to` that
 * itself falls under another step's `from` (a same-directory rename
 * followed by a root-level move of its new parent) is chased to its final
 * destination, never left on an intermediate hop. Resolution for one entry
 * is bounded to at most `renamed.length` hops (it can never loop forever)
 * and tracks every value it has already visited for that entry: if the
 * next hop would repeat one, that is a cycle in the journal itself (e.g.
 * `A -> B` and `B -> A`, nonsensical for real renames but the journal is
 * on-disk, untrusted input) — resolution for that entry stops at its
 * LAST non-cyclic value (never an arbitrary later one) and a warning is
 * pushed onto the optional `warnings` sink rather than the caller silently
 * getting a partially- or wrongly-resolved prefix.
 */
export function buildPrefixMap(steps: MigrationStep[], warnings: string[] = []): PathPrefix[] {
  const renamed = steps
    .filter((s) => s.action === "renamed")
    .map((s): PathPrefix => ({ from: s.from, to: s.to }))
    .sort((a, b) => b.from.length - a.from.length);

  const resolved = renamed.map((p) => ({ ...p }));
  for (const entry of resolved) {
    const visited = new Set<string>([entry.from, entry.to]);
    for (let i = 0; i < renamed.length; i++) {
      const hop = renamed.find((o) => entry.to === o.from || entry.to.startsWith(o.from + sep));
      if (!hop) break;
      const next = hop.to + entry.to.slice(hop.from.length);
      if (visited.has(next)) {
        warnings.push(
          `path rewrite: cycle detected resolving ${entry.from} — stopped at ` +
            `${entry.to} (${hop.from} -> ${hop.to} would repeat a value already seen)`,
        );
        break;
      }
      visited.add(next);
      entry.to = next;
    }
  }

  return resolved;
}

/** De-duplicates a `MigrationStep` array before it feeds `buildPrefixMap` —
 * exported for `dataMigrateCmd.ts`'s resumability fix (fix-wave review,
 * #283 Important 2): the prefix map is unioned from this run's OWN steps
 * plus the durable on-disk journal's historical steps (a run that died
 * after the data-root move — already journaled in a `finally` — but before
 * reaching this phase would otherwise have no "renamed" step to rebuild
 * that prefix from on a resumed run, since the tree has already moved and
 * a re-run of the mover produces nothing new to rename). Two sources can
 * legitimately overlap (this run's own steps get appended to the SAME
 * journal file earlier in the same call), so the union needs de-duping,
 * not just concatenation. Two steps are the same when `from`, `to`, AND
 * `action` are all identical — generic over every action rather than just
 * "renamed" so callers never have to reason about which ones matter
 * (`buildPrefixMap` already filters those out on its own). */
export function dedupeSteps(steps: MigrationStep[]): MigrationStep[] {
  const seen = new Set<string>();
  const out: MigrationStep[] = [];
  for (const s of steps) {
    const key = JSON.stringify([s.from, s.to, s.action]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Rewrites `p` under the first (longest, per `buildPrefixMap`'s ordering)
 * matching prefix, or returns `null` when no prefix applies — either
 * because `p` was never under a moved root (rule 2) or because it has
 * already been rewritten (rule 4). Matching is on a path BOUNDARY (rule
 * 3): `p === from`, or `p` starts with `from + path.sep` — a bare
 * `p.startsWith(from)` would let `/old/clones-backup` slip through an
 * `/old/clones` prefix.
 */
export function rewritePath(p: string, map: PathPrefix[]): string | null {
  for (const { from, to } of map) {
    if (p === from) return to;
    if (p.startsWith(from + sep)) return to + p.slice(from.length);
  }
  return null;
}

export interface RewriteCtx {
  /** The migration's target root — everything is already here by the time
   * this phase runs (inserted after the data-root journal flush, before
   * the legacy-root removal). */
  targetRoot: string;
  /** The target root's queue dirs (post-move) — `inbox`/`processing`/
   * `done`/`failed`, each walked for `*.md` tickets. */
  queuePaths: Paths;
}

export interface RewriteDeps {
  // NOTE (fix-wave review #283 Minor 2): `readFileFn`/`writeFileFn` do NOT
  // cover the watchlist. `rewriteWatchlistFile` below reads/writes it via
  // `readWatchlist`/`writeWatchlist` (watchlist.ts), which hard-code the
  // real `node:fs` — those two functions take a bare file path, not an
  // injectable deps object, so there is no seam to route through without
  // changing watchlist.ts itself (out of this phase's scope: it is shared
  // by the dashboard and the bridge sweep, not owned here). Harmless in
  // production (both paths hit the same real filesystem either way), but a
  // TEST that stubs `readFileFn`/`writeFileFn` to intercept reads/writes
  // will NOT see the watchlist file through them — only ticket/JSON-record
  // I/O goes through this seam.
  readFileFn: (p: string) => string;
  writeFileFn: (p: string, s: string) => void;
  /** Filenames directly under a queue dir (not recursive — queue dirs are
   * flat). Default in `dataMigrateCmd.ts` is `fs.readdirSync`; `DataMigrateDeps`
   * does not otherwise seam directory listing, so this is its own seam. */
  readdirFn: (dir: string) => string[];
  existsFn: (p: string) => boolean;
  /** Fix-wave review #283 Important I1: every JSON-record/outbox-op/ticket
   * write below goes through `atomicWriteFile` (tmp-file via `writeFileFn`,
   * then `renameFn` onto the real path) instead of a bare `writeFileFn` call
   * — the same tmp+rename shape `rewriteConfig` (dataMigrateCmd.ts) and every
   * OTHER writer of these exact stores already uses (reviewStore.ts's `write`,
   * planSets.ts's `atomicWrite`, githubOutbox.ts's `enqueueOp`, and this
   * phase's own `writeWatchlist` call). A bare `writeFileFn` (== `writeFileSync` in
   * production) truncates first, so a crash mid-write would corrupt a live
   * queue ticket or plan-set record — the wrong failure mode for a migration
   * whose whole premise is crash-resumability. Default in `dataMigrateCmd.ts`
   * is `fs.renameSync`, already used elsewhere in that file for the same
   * purpose. */
  renameFn: (from: string, to: string) => void;
}

/** Writes `content` to `file` via tmp-file-then-rename rather than a bare
 * (truncate-first) write — see `RewriteDeps.renameFn`'s doc comment for why.
 * Same tmp-name shape `rewriteConfig` (dataMigrateCmd.ts) uses for the same
 * seam: a dotfile alongside the real file (same directory — required for
 * `renameFn` to be atomic on the same filesystem), suffixed with this
 * process's pid so two concurrent migrates never collide on the tmp name. */
function atomicWriteFile(
  file: string,
  content: string,
  deps: Pick<RewriteDeps, "writeFileFn" | "renameFn">,
): void {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}`);
  deps.writeFileFn(tmp, content);
  deps.renameFn(tmp, file);
}

export interface RewriteReport {
  /** Count of individual path VALUES rewritten (one watchlist entry's
   * `path`, or one ticket's `repo:`/`workdir:` field, each count as 1). */
  rewritten: number;
  /** Files actually modified on disk (the watchlist file, plus any ticket
   * file with at least one field rewritten). */
  files: string[];
  /** One entry per file that could not be read, parsed, or written —
   * never thrown (design rule 4 above). */
  warnings: string[];
}

/** Walks the watchlist and every queue dir's tickets, rewriting `path`/
 * `repo:`/`workdir:` values that fall under a moved prefix. A no-op
 * (returns the zero report without touching anything) when `map` is empty —
 * which, post-journal-seeding (design rule 4 above), is essentially never
 * the case on a resumed run once ANYTHING has ever been journaled; an empty
 * map now means a genuinely fresh install that has never moved a tree, not
 * "nothing left to move" (fix-wave review #283 Minor 1). */
export function rewriteStoredPaths(
  ctx: RewriteCtx,
  map: PathPrefix[],
  deps: RewriteDeps,
): RewriteReport {
  const report: RewriteReport = { rewritten: 0, files: [], warnings: [] };
  if (map.length === 0) return report;

  rewriteWatchlistFile(join(ctx.targetRoot, WATCHLIST_FILENAME), map, report);

  for (const dir of Object.values(ctx.queuePaths)) {
    rewriteTicketsInDir(dir, map, deps, report);
  }

  rewriteJsonRepoPathRecords(join(ctx.targetRoot, REVIEW_ASSESS_SUBDIR), map, deps, report);
  rewriteJsonRepoPathRecords(join(ctx.targetRoot, REVIEW_COMMENTS_SUBDIR), map, deps, report);
  rewriteJsonRepoPathRecords(join(ctx.targetRoot, PLANS_V2_SUBDIR), map, deps, report);

  const outboxDir = join(ctx.targetRoot, OUTBOX_V2_SUBDIR);
  rewriteOutboxOpsInDir(outboxDir, map, deps, report);
  rewriteOutboxOpsInDir(join(outboxDir, "dead"), map, deps, report);

  return report;
}

/** Reads/writes via `readWatchlist`/`writeWatchlist` directly — both take a
 * bare file path (no `Config` needed here), and both hard-code the real
 * `node:fs` rather than accepting injectable deps, so this bypasses
 * `RewriteDeps.readFileFn`/`writeFileFn` by necessity — see the doc comment
 * on those two fields for why, and for what that means for a test stubbing
 * them (fix-wave review #283 Minor 2).
 *
 * `error` is non-null for TWO distinct cases `readWatchlist` conflates under
 * one string, and BOTH are warned with the file left untouched entirely —
 * never just the corrupt-JSON one (fix-wave review #283 Minor 3, widening
 * this comment after it undersold the second case):
 *   - the file is corrupt/unparseable JSON — `entries` is `[]`.
 *   - the file parsed fine but held one or more entries that failed shape
 *     validation ("N invalid entries ignored") — `entries` THEN holds the
 *     valid remainder, not `[]`.
 * Writing back only that valid remainder in the second case would silently
 * DROP the invalid entries from disk — worse than leaving a stale path
 * unrewritten — so "leave the whole file alone and warn" is correct for
 * both, same "leave it alone" precedent `unwatchCmd.ts` uses for a
 * watchlist gone corrupt mid-operation; never clobber a file we can't fully
 * trust we parsed completely. A missing file (`error: null`, empty
 * entries) is not a warning: no watchlist is a normal, unwatched-repo
 * config. */
function rewriteWatchlistFile(file: string, map: PathPrefix[], report: RewriteReport): void {
  const { entries, error } = readWatchlist(file);
  if (error) {
    report.warnings.push(`watchlist ${file}: ${error}`);
    return;
  }
  if (entries.length === 0) return;

  let count = 0;
  const next = entries.map((e) => {
    const to = rewritePath(e.path, map);
    if (to === null) return e;
    count++;
    return { ...e, path: to };
  });
  if (count === 0) return;

  try {
    writeWatchlist(file, next);
  } catch (e) {
    report.warnings.push(
      `watchlist ${file}: write failed — ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  report.rewritten += count;
  report.files.push(file);
}

/** Structural subset shared by `PendingAssess` (assessReview.ts),
 * `PendingComment` (commentReview.ts), and `PlanSetRecord` (planSets.ts) —
 * each store's real type carries many more fields, but this phase only ever
 * touches the one `repoPath` string; every other field round-trips through
 * `JSON.parse`/`{ ...rec }`/`JSON.stringify` untouched. No import of the
 * concrete types needed (or wanted — this module stays independent of
 * assessReview.ts/commentReview.ts/planSets.ts). */
interface RecordWithRepoPath {
  repoPath: string;
}

function hasStringRepoPath(v: unknown): v is RecordWithRepoPath {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { repoPath?: unknown }).repoPath === "string"
  );
}

/** Shared walk for the three stores that hold exactly one absolute path
 * under a top-level `repoPath` field, one JSON file per record, directly
 * contained (not recursive — same flat-dir shape as the queue dirs).
 * Serialized as `JSON.stringify(x, null, 2) + "\n"` on write — the exact
 * shape reviewStore.ts's `write()` and planSets.ts's
 * `writePlanSetRecord`/`materializePlanSet` all use, so this stays a
 * byte-identical round-trip for every untouched field. A missing dir (e.g.
 * no batches/drafts/records ever written) is silently skipped, not a
 * warning — same precedent as `rewriteTicketsInDir`'s missing queue dir. A
 * readdir failure on an EXISTING dir, and any per-file read/parse/write
 * failure, is a warning and that ONE file is left untouched — never a
 * throw (design rule 4). A parsed file missing a string `repoPath` (an
 * unrecognized/malformed shape) is quietly skipped rather than warned:
 * every real record in these dirs has one, so this only guards against
 * something this phase has no business touching. */
/** Entries of `dir`: null when the dir is absent (silently skipped — never
 * created is a normal state) or unreadable on an EXISTING dir (permissions,
 * etc. — warned as `<label> <dir>: <error>`). */
function listDirOrWarn(
  dir: string,
  label: string,
  deps: RewriteDeps,
  report: RewriteReport,
): string[] | null {
  if (!deps.existsFn(dir)) return null;
  try {
    return deps.readdirFn(dir);
  } catch (e) {
    report.warnings.push(`${label} ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function rewriteJsonRepoPathRecords(
  dir: string,
  map: PathPrefix[],
  deps: RewriteDeps,
  report: RewriteReport,
): void {
  const names = listDirOrWarn(dir, "record dir", deps, report);
  if (names === null) return;

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let raw: string;
    try {
      raw = deps.readFileFn(file);
    } catch (e) {
      report.warnings.push(`record ${file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      report.warnings.push(`record ${file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!hasStringRepoPath(parsed)) continue;

    const to = rewritePath(parsed.repoPath, map);
    if (to === null) continue;

    try {
      atomicWriteFile(file, JSON.stringify({ ...parsed, repoPath: to }, null, 2) + "\n", deps);
    } catch (e) {
      report.warnings.push(
        `record ${file}: write failed — ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    report.rewritten += 1;
    report.files.push(file);
  }
}

/** Structural subset of `StoredOp` (githubOutbox.ts) needed to discriminate
 * and rewrite — see the `OutboxOp` union there for the full shape. Only the
 * `push`/`pr` variants carry `repoPath`; `labels`/`comment`/`issue-create`
 * do not, and must be left completely untouched. */
interface StoredOpShape {
  op?: { kind?: string; repoPath?: unknown };
}

/** Outbox ops: same JSON-per-file, flat-dir walk as
 * `rewriteJsonRepoPathRecords`, but `repoPath` is nested one level down
 * (`op.repoPath`, not a top-level field) and carried only by the `push`/
 * `pr` variants — every other variant is skipped untouched. The on-disk
 * shape has NO trailing newline (`enqueueOp` and `flushOutbox`'s own
 * rewrite both write `JSON.stringify(x, null, 2)` with no `+ "\n"`, unlike
 * every other store this phase touches) — matched here so an untouched op
 * stays byte-identical and a rewritten one matches every other outbox
 * writer. `StoredOp.path` is DERIVED at read time from the directory
 * listing and stripped before writing (`Omit<StoredOp, "path">`) — it is
 * never present in the parsed JSON here, so there is nothing to strip or
 * rewrite for it. Called once for the outbox dir and once for its `dead/`
 * subdir (a dead-lettered op still carries a path) — each call is its own
 * flat, non-recursive walk, so the outer call's `readdirFn` on the outbox
 * dir simply sees `dead` as a directory entry that fails the `.json` suffix
 * check and is skipped, same as any other non-op file. */
function rewriteOutboxOpsInDir(
  dir: string,
  map: PathPrefix[],
  deps: RewriteDeps,
  report: RewriteReport,
): void {
  const names = listDirOrWarn(dir, "outbox dir", deps, report);
  if (names === null) return;

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let raw: string;
    try {
      raw = deps.readFileFn(file);
    } catch (e) {
      report.warnings.push(`outbox op ${file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      report.warnings.push(`outbox op ${file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const stored = parsed as StoredOpShape;
    const op = stored.op;
    if (!op || (op.kind !== "push" && op.kind !== "pr") || typeof op.repoPath !== "string") {
      continue;
    }

    const to = rewritePath(op.repoPath, map);
    if (to === null) continue;

    try {
      atomicWriteFile(
        file,
        JSON.stringify({ ...stored, op: { ...op, repoPath: to } }, null, 2),
        deps,
      );
    } catch (e) {
      report.warnings.push(
        `outbox op ${file}: write failed — ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    report.rewritten += 1;
    report.files.push(file);
  }
}

/** Directly-contained `*.md` tickets only — queue dirs are flat. A missing
 * dir (e.g. `failed/` never created) is silently skipped, not a warning;
 * a readdir failure on an EXISTING dir (permissions, etc.) is. */
function rewriteTicketsInDir(
  dir: string,
  map: PathPrefix[],
  deps: RewriteDeps,
  report: RewriteReport,
): void {
  const names = listDirOrWarn(dir, "queue dir", deps, report);
  if (names === null) return;

  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const file = join(dir, name);
    let raw: string;
    try {
      raw = deps.readFileFn(file);
    } catch (e) {
      report.warnings.push(`ticket ${file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const { content, count, unparseableFields } = rewriteTicketContent(raw, map);
    // Important 1(b) (#283 fix-wave review): pushed regardless of `count` —
    // a ticket can have one rewritable field and one unparseable one, and
    // both outcomes must be visible on the receipt.
    for (const key of unparseableFields) {
      report.warnings.push(
        `ticket ${file}: ${key}: value present but not in a rewritable shape ` +
          `(expected a quoted or plain scalar)`,
      );
    }
    if (count === 0) continue;

    try {
      atomicWriteFile(file, content, deps);
    } catch (e) {
      report.warnings.push(
        `ticket ${file}: write failed — ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    report.rewritten += count;
    report.files.push(file);
  }
}

// Same frontmatter delimiter shape ticket.ts's own (unexported) parser uses —
// `---\n<frontmatter>\n---\n<body>`. The `d` (hasIndices) flag gives group 1's
// character offsets so the rewrite can splice ONLY the frontmatter block back
// into the original bytes, leaving delimiters, the body, and every untouched
// frontmatter line byte-for-byte identical — these are live queue tickets.
const TICKET_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/d;

/** Rewrites `repo:`/`workdir:` inside the frontmatter block only (never the
 * body — a ticket's instructions may well contain the literal text
 * "repo:" and must never be touched). Returns the original `raw` unchanged
 * (count 0) when there is no frontmatter block, or neither field matches a
 * moved prefix. `unparseableFields` names every field that WAS present but
 * whose value doesn't fit a shape this phase can rewrite (fix-wave review,
 * #283 Important 1(b)) — populated independently of `count`, so a ticket
 * with one rewritable field and one malformed one still reports both. */
function rewriteTicketContent(
  raw: string,
  map: PathPrefix[],
): { content: string; count: number; unparseableFields: Array<"repo" | "workdir"> } {
  const m = TICKET_FRONTMATTER_RE.exec(raw);
  if (!m || !m.indices) return { content: raw, count: 0, unparseableFields: [] };
  const [fmStart, fmEnd] = m.indices[1];
  let fm = raw.slice(fmStart, fmEnd);

  let count = 0;
  const unparseableFields: Array<"repo" | "workdir"> = [];
  for (const key of ["repo", "workdir"] as const) {
    const result = rewriteFrontmatterField(fm, key, map);
    if (result.unparseable) unparseableFields.push(key);
    if (result.text !== null) {
      fm = result.text;
      count++;
    }
  }
  if (count === 0) return { content: raw, count: 0, unparseableFields };
  return { content: raw.slice(0, fmStart) + fm + raw.slice(fmEnd), count, unparseableFields };
}

/** Matches a `<key>: <value>` frontmatter line in any of the three scalar
 * shapes real tickets carry: JSON-double-quoted (`repo: "/path"` — junco's
 * own src/ emitters: planCompiler.ts, analyzeCmd.ts, assessCmd.ts,
 * githubInbox.ts, externalDispatch.ts), YAML single-quoted (`repo:
 * '/path'`), and plain/unquoted (`repo: /path`). The plain form is what
 * junco's own SHIPPED templates and dispatch skill actually write —
 * templates/task-code.md, templates/plain/task-code.md,
 * skills/junco-dispatch/TEMPLATE.md, examples/*.md — and was missed
 * entirely before this fix, the exact silent-failure gap the fix-wave
 * review (#283 Important 1) caught: a real operator's ticket matching that
 * shape under a moved prefix used to yield `rewritten: 0` AND
 * `warnings: []` — no signal at all. Every branch replaces ONLY the value
 * substring and re-serializes in the SAME style it was found in — an
 * unquoted value stays unquoted, a single-quoted one stays single-quoted —
 * so every other byte on the line, and in the file, is untouched. The
 * quoted-value character classes are bounded to a single line
 * (`[^"\\\r\n]` / `[^'\r\n]`, not just `[^"\\]`) so an unterminated quote
 * can never accidentally span past its own line into a LATER quoted field
 * further down the frontmatter block.
 *
 * Returns `{ text: null, unparseable: false }` when the key is absent
 * entirely (a Q&A ticket with no `repo:`, or a `workdir:`-less ticket), OR
 * when it is present with NO value at all (a bare `repo:` — a YAML null,
 * fix-wave review #283 Minor 2: not a broken value, so not a warning either
 * — same "nothing to do" outcome the empty-string quoted forms `repo: ""` /
 * `repo: ''` already got). Returns `{ text: null, unparseable: true }` when
 * the key IS present with a value that doesn't fit one of the three shapes
 * above — a YAML block scalar (`repo: |`/`repo: >`, value on following
 * lines) or a malformed/unterminated quoted string. The caller
 * (`rewriteTicketContent`/`rewriteTicketsInDir`) turns that into a warning
 * naming the file rather than silently reporting nothing — silence is the
 * exact failure mode this fix closes.
 *
 * A `~`/`~/...` value is expanded (the local `resolve` helper below, via
 * config.ts's `expandHome`) before it is checked against `map` (fix-wave
 * review #283 Minor 3): `map` only ever holds absolute paths, but junco's own SHIPPED
 * templates and dispatch skill write `repo: ~/...`
 * (templates/task-code.md:7, skills/junco-dispatch/EXAMPLE.md:21) — no
 * src/ emitter ever does. Without expansion that shape matched neither
 * `map` nor the unparseable branch: silent `rewritten: 0, warnings: []`,
 * the same silent-failure class the earlier fix-wave closed for plain
 * scalars. `os.homedir()` (via `expandHome`) is this phase's own operator's
 * real `$HOME` — the identical mechanism `config.ts`'s own path resolution
 * uses everywhere else in the codebase, not a guess — so a real tilde value
 * under a moved prefix is now correctly resolved and rewritten to its
 * absolute final path (matching every other value this phase writes back);
 * one that still matches nothing after expansion is left exactly as
 * written, same as any other out-of-scope path (design rule 2). */
function rewriteFrontmatterField(
  text: string,
  key: "repo" | "workdir",
  map: PathPrefix[],
): { text: string | null; unparseable: boolean } {
  const splice = (index: number, matchLen: number, replacement: string): string =>
    text.slice(0, index) + replacement + text.slice(index + matchLen);
  const resolve = (value: string): string | null => rewritePath(expandHome(value), map);

  const dqRe = new RegExp(`^(${key}:[ \\t]*)"((?:[^"\\\\\r\n]|\\\\.)*)"`, "m");
  const dq = dqRe.exec(text);
  if (dq) {
    let value: string;
    try {
      value = JSON.parse(`"${dq[2]}"`) as string;
    } catch {
      return { text: null, unparseable: true };
    }
    const to = resolve(value);
    if (to === null) return { text: null, unparseable: false };
    return { text: splice(dq.index, dq[0].length, dq[1] + JSON.stringify(to)), unparseable: false };
  }

  // Single-quoted — YAML doubles an embedded `'` (`''` == a literal `'`).
  const sqRe = new RegExp(`^(${key}:[ \\t]*)'((?:[^'\r\n]|'')*)'`, "m");
  const sq = sqRe.exec(text);
  if (sq) {
    const value = sq[2].replace(/''/g, "'");
    const to = resolve(value);
    if (to === null) return { text: null, unparseable: false };
    const replacementValue = `'${to.replace(/'/g, "''")}'`;
    return { text: splice(sq.index, sq[0].length, sq[1] + replacementValue), unparseable: false };
  }

  // Neither quote form matched. The key may still be a plain/unquoted
  // scalar (the common real-world case — see the doc comment above) or a
  // shape this phase refuses to guess at.
  const plainRe = new RegExp(`^(${key}:[ \\t]*)([^\r\n]*)$`, "m");
  const plain = plainRe.exec(text);
  if (!plain) return { text: null, unparseable: false }; // key absent entirely

  const trailingWs = /[ \t]*$/.exec(plain[2])?.[0] ?? "";
  const value = plain[2].slice(0, plain[2].length - trailingWs.length);
  if (value === "") {
    // A bare `key:` with nothing after it — a YAML null, not a broken
    // value (fix-wave review #283 Minor 2): nothing to do, nothing to warn.
    return { text: null, unparseable: false };
  }
  if (
    value.startsWith("|") ||
    value.startsWith(">") ||
    value.startsWith('"') ||
    value.startsWith("'")
  ) {
    // Block scalar (value on following lines), or an unterminated/malformed
    // quote that didn't match above — never guessed at, same precedent this
    // module has always set for "block-scalar, indented" shapes.
    return { text: null, unparseable: true };
  }

  const to = resolve(value);
  if (to === null) return { text: null, unparseable: false };
  return {
    text: splice(plain.index, plain[0].length, plain[1] + to + trailingWs),
    unparseable: false,
  };
}
