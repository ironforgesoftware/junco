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
 *   2. Never touch paths outside those prefixes. A repo cloned at
 *      `~/dev/foo` (or anywhere else junco never owned) is left alone —
 *      `rewritePath` returns `null` the moment no prefix applies.
 *   3. Path-BOUNDARY matching, not `startsWith`. `/old/clones-backup` must
 *      never be rewritten by an `/old/clones` prefix — matching requires
 *      an exact hit or a hit followed by `path.sep`.
 *   4. Idempotent. An already-rewritten path (its prefix is now the NEW
 *      root, not the old one) matches nothing in the map and is returned
 *      unchanged — a resumed or re-run migrate is a no-op here, exactly
 *      like every other phase's journal-driven resume story. This falls
 *      out of rule 1 for free: a second run's OWN "renamed" step list is
 *      empty (nothing left to move), so the map itself is empty and
 *      `rewriteStoredPaths` does nothing.
 *
 * A read/parse failure on any ONE file (unreadable ticket, corrupt
 * watchlist) is appended to the caller's `RewriteReport.warnings` and the
 * phase moves on — it must never abort the migration these files already
 * survived.
 */
import { sep, join } from "node:path";
import type { Paths } from "./types.js";
import type { MigrationStep } from "./dataMigrate.js";
import { readWatchlist, writeWatchlist } from "./watchlist.js";
import { WATCHLIST_FILENAME, REVIEW_ASSESS_SUBDIR, REVIEW_COMMENTS_SUBDIR } from "./dataTree.js";

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
 */
export function buildPrefixMap(steps: MigrationStep[]): PathPrefix[] {
  return steps
    .filter((s) => s.action === "renamed")
    .map((s): PathPrefix => ({ from: s.from, to: s.to }))
    .sort((a, b) => b.from.length - a.from.length);
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
  readFileFn: (p: string) => string;
  writeFileFn: (p: string, s: string) => void;
  /** Filenames directly under a queue dir (not recursive — queue dirs are
   * flat). Default in `dataMigrateCmd.ts` is `fs.readdirSync`; `DataMigrateDeps`
   * does not otherwise seam directory listing, so this is its own seam. */
  readdirFn: (dir: string) => string[];
  existsFn: (p: string) => boolean;
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
 * the common case on a resumed run once nothing is left to move. */
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
 * bare file path (no `Config` needed here). A read error (corrupt/invalid
 * JSON) is warned and the file is left untouched entirely, same "leave it
 * alone" precedent `unwatchCmd.ts` uses for a watchlist gone corrupt
 * mid-operation — never clobber a file we can't fully trust we parsed. A
 * missing file (`error: null`, empty entries) is not a warning: no watchlist
 * is a normal, unwatched-repo config. */
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
function rewriteJsonRepoPathRecords(
  dir: string,
  map: PathPrefix[],
  deps: RewriteDeps,
  report: RewriteReport,
): void {
  if (!deps.existsFn(dir)) return;
  let names: string[];
  try {
    names = deps.readdirFn(dir);
  } catch (e) {
    report.warnings.push(`record dir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

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
      deps.writeFileFn(file, JSON.stringify({ ...parsed, repoPath: to }, null, 2) + "\n");
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
  if (!deps.existsFn(dir)) return;
  let names: string[];
  try {
    names = deps.readdirFn(dir);
  } catch (e) {
    report.warnings.push(`outbox dir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

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
      deps.writeFileFn(file, JSON.stringify({ ...stored, op: { ...op, repoPath: to } }, null, 2));
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
  if (!deps.existsFn(dir)) return;
  let names: string[];
  try {
    names = deps.readdirFn(dir);
  } catch (e) {
    report.warnings.push(`queue dir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

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

    const { content, count } = rewriteTicketContent(raw, map);
    if (count === 0) continue;

    try {
      deps.writeFileFn(file, content);
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
 * moved prefix. */
function rewriteTicketContent(raw: string, map: PathPrefix[]): { content: string; count: number } {
  const m = TICKET_FRONTMATTER_RE.exec(raw);
  if (!m || !m.indices) return { content: raw, count: 0 };
  const [fmStart, fmEnd] = m.indices[1];
  let fm = raw.slice(fmStart, fmEnd);

  let count = 0;
  for (const key of ["repo", "workdir"] as const) {
    const rewritten = rewriteFrontmatterField(fm, key, map);
    if (rewritten !== null) {
      fm = rewritten;
      count++;
    }
  }
  if (count === 0) return { content: raw, count: 0 };
  return { content: raw.slice(0, fmStart) + fm + raw.slice(fmEnd), count };
}

/** Matches emitters' `<key>: ${JSON.stringify(path)}` style exactly
 * (planCompiler.ts, analyzeCmd.ts, assessCmd.ts, githubInbox.ts,
 * externalDispatch.ts all write it this way) — a top-level, unindented,
 * JSON-double-quoted scalar. Replaces only the quoted VALUE substring in
 * place, so the key, its spacing, and everything else on the line (there is
 * nothing else on the line, but the principle holds) survive untouched.
 * Anything not in that exact shape (unquoted, block-scalar, indented) is
 * left alone rather than guessed at — no ticket emitter in this codebase
 * writes it any other way. */
function rewriteFrontmatterField(
  text: string,
  key: "repo" | "workdir",
  map: PathPrefix[],
): string | null {
  const re = new RegExp(`^(${key}:[ \\t]*)"((?:[^"\\\\]|\\\\.)*)"`, "m");
  const m = re.exec(text);
  if (!m) return null;
  let value: string;
  try {
    value = JSON.parse(`"${m[2]}"`) as string;
  } catch {
    return null;
  }
  const to = rewritePath(value, map);
  if (to === null) return null;
  const replacement = m[1] + JSON.stringify(to);
  return text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);
}
