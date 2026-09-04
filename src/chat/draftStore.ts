/**
 * Parked chat drafts (spec 2026-09-01 §6.2): a makeReviewStore over
 * <chatDrafts>/ (the third instance of the audit/investigate park idiom) plus
 * the ticket files beside the JSON — <chatDrafts>/<draftId>/<name> — so
 * confirm hands the CLI a byte-identical path.
 *
 * Both path components run through slugifyId (src/slug.ts) before they touch
 * the filesystem. The draft id is junco-generated (`<chatSlug>-<ts>-<n>`) and
 * survives it unchanged, but the FILE NAME is `<frontmatter id>.md` — model-
 * authored, so `id: ../../../etc/x` would otherwise escape the drafts dir
 * (the issue #32 class; slug.ts's own docstring is the standing rule that the
 * slugify step never gets skipped at a new call site).
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../types.js";
import type { DraftKind } from "../agent/transcriptSchema.js";
import type { LintViolation } from "../planLint.js";
import type { RouteDecision } from "../submitPreflight.js";
import { dataTreePaths } from "../dataTree.js";
import { log } from "../logging.js";
import { makeReviewStore, type ReviewStoreDeps } from "../reviewStore.js";
import { slugifyId } from "../slug.js";

export interface DraftFile {
  name: string;
  /** Byte-identical to what lint saw and to what lands on disk. */
  content: string;
  lint: LintViolation[];
  /** decideRoute's verdict; null for the kinds that never route (audit/
   *  investigate run a CLI verb, planSet compiles first). */
  route: RouteDecision | null;
  droppedKeys: string[];
}

export interface PendingDraft {
  id: string;
  key: string;
  slug: string;
  kind: DraftKind;
  files: DraftFile[];
  cwd: string;
  nwo: string | null;
  createdAt: string;
  lintFailed: boolean;
  blocked: string | null;
  routeOverride: "auto" | "inbox" | "issue";
  commandArgs: string[] | null;
}

// keyOf defaults to slugifyId — ids are `<chatSlug>-<ts>-<n>`, already inside
// [A-Za-z0-9._-], so the slug is a no-op on them and lossless (the collision
// hazard that made assessHistory pass its own deriver does not apply).
const store = makeReviewStore<PendingDraft>([
  "id",
  "key",
  "slug",
  "kind",
  "files",
  "cwd",
  "createdAt",
  "lintFailed",
  "routeOverride",
]);

export function chatDraftsDir(cfg: Config): string {
  return dataTreePaths(cfg).chatDrafts;
}

/**
 * slugifyId collapses separators but KEEPS dots, so "." and ".." survive it
 * intact — and `join(dir, "..")` is the drafts dir's PARENT, which
 * `removeChatDraft` would then rm -rf. Every component below goes through
 * here: a name that cannot be a real directory entry is a throw, never a
 * path. (Traversal shapes like "../../x" are unaffected: they slugify to one
 * inert component.) */
function safeComponent(raw: string, what: "draft id" | "draft file name"): string {
  const s = slugifyId(raw);
  if (s === "" || s === "." || s === "..")
    throw new Error(`unsafe ${what}: ${JSON.stringify(raw)}`);
  return s;
}
/** `<chatDrafts>/<slugifyId(id)>.json` — the one place a draft id becomes its
 * JSON path, so `removeChatDraft` and `unwatchCmd.ts`'s chat-draft plan item
 * can never compute it differently from each other or from what
 * `store.write` (the makeReviewStore instance above) actually wrote. */
export function draftJsonPath(cfg: Config, id: string): string {
  return join(chatDraftsDir(cfg), `${safeComponent(id, "draft id")}.json`);
}
export function draftFilesDir(cfg: Config, draftId: string): string {
  return join(chatDraftsDir(cfg), safeComponent(draftId, "draft id"));
}
/** Defence in depth: chatDrafts.ts already slugifies `DraftFile.name` at park
 * time, so the stored name IS this path's last component and the slug here is
 * a no-op (slugifyId is idempotent). It stays because this function is the
 * only place a name reaches the filesystem, and a caller that builds a
 * PendingDraft by hand must not be able to escape the drafts dir. */
export function draftFilePath(cfg: Config, draftId: string, name: string): string {
  return join(draftFilesDir(cfg, draftId), safeComponent(name, "draft file name"));
}

export function listChatDrafts(cfg: Config, deps: ReviewStoreDeps = {}): PendingDraft[] {
  return store.list(chatDraftsDir(cfg), deps);
}

export function readChatDraft(
  cfg: Config,
  id: string,
  deps: ReviewStoreDeps = {},
): { entry: PendingDraft | null; error: string | null } {
  return store.read(chatDraftsDir(cfg), id, deps);
}

/** JSON + the files beside it. The files land FIRST, and `files[].name` is
 * already slug-safe (chatDrafts.ts), so a confirm that reads the JSON can take
 * `draftFilePath(cfg, id, name)` as the exact byte-identical path on disk. */
export function writeChatDraft(
  cfg: Config,
  draft: PendingDraft,
  deps: ReviewStoreDeps = {},
): string {
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  mkdirFn(draftFilesDir(cfg, draft.id));
  for (const f of draft.files) writeFileFn(draftFilePath(cfg, draft.id, f.name), f.content);
  return store.write(chatDraftsDir(cfg), draft, deps);
}

/** Operator-visible disposal: the JSON moves under submitted/ or discarded/
 * and the files dir goes WITH it (`<sub>/<id>/<name>` beside `<sub>/<id>.json`,
 * #450) — leaving it behind grew `<chatDrafts>/` by one directory per draft
 * forever, with nothing to sweep it. The JSON's move is the verdict: a files
 * dir that will not follow (no such dir, a racing sweep, a read-only tree) is
 * logged, never a throw, because the archive it belongs to has ALREADY
 * happened and `submitExec` would otherwise report a queued submission as
 * "did not archive". */
export function archiveChatDraft(
  cfg: Config,
  id: string,
  sub: "submitted" | "discarded",
  deps: ReviewStoreDeps = {},
): boolean {
  const dir = chatDraftsDir(cfg);
  const archived = store.remove(dir, id, sub, deps);
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const from = draftFilesDir(cfg, id);
  const to = join(dir, sub, safeComponent(id, "draft id"));
  try {
    mkdirFn(join(dir, sub));
    renameFn(from, to);
  } catch (e) {
    // ENOENT is the ordinary case for a draft archived twice, or one written
    // with no files at all — not worth a line in the log.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT")
      log.warn("chat draft archived, but its files dir did not move", {
        from,
        to,
        error: e instanceof Error ? e.message : String(e),
      });
  }
  return archived;
}

/** Spec §6.3: the first failed draft is REMOVED (not archived) when its retry
 * parks — the operator never asked for it and it was never shown as a card. */
export function removeChatDraft(
  cfg: Config,
  id: string,
  deps: { rmFn?: (p: string) => void } = {},
): void {
  const rmFn = deps.rmFn ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  rmFn(draftJsonPath(cfg, id));
  rmFn(draftFilesDir(cfg, id));
}

/** ChatStatus.draftsParked (chatManager.ts) — how many drafts this session
 * has waiting for a human. */
export function draftsParkedFor(cfg: Config, slug: string, deps: ReviewStoreDeps = {}): number {
  return listChatDrafts(cfg, deps).filter((d) => d.slug === slug).length;
}

export type DraftLookup =
  | { ok: true; draft: PendingDraft }
  | { ok: false; reason: "none" | "unknown" | "ambiguous"; candidates: PendingDraft[] };

/** Resolve the draft a chat verb names (spec 2026-09-03 §3.1): a draft id,
 * or a ticket id (the file stem). No `ref` → the ONLY parked draft of this
 * chat; two or more → ambiguous, the caller must name one. Scoped to `key`,
 * so a chat can never touch another repo's draft. */
export function findChatDraft(
  cfg: Config,
  key: string,
  ref: string | undefined,
  deps: ReviewStoreDeps = {},
): DraftLookup {
  const mine = listChatDrafts(cfg, deps).filter((d) => d.key === key);
  if (mine.length === 0) return { ok: false, reason: "none", candidates: [] };
  if (ref === undefined) {
    return mine.length === 1
      ? { ok: true, draft: mine[0]! }
      : { ok: false, reason: "ambiguous", candidates: mine };
  }
  const hit = mine.filter(
    (d) => d.id === ref || d.files.some((f) => f.name === ref || f.name === `${ref}.md`),
  );
  if (hit.length === 1) return { ok: true, draft: hit[0]! };
  return hit.length === 0
    ? { ok: false, reason: "unknown", candidates: mine }
    : { ok: false, reason: "ambiguous", candidates: hit };
}
