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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../types.js";
import type { DraftKind } from "../agent/transcriptSchema.js";
import type { LintViolation } from "../planLint.js";
import type { RouteDecision } from "../submitPreflight.js";
import { dataTreePaths } from "../dataTree.js";
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
export function draftFilesDir(cfg: Config, draftId: string): string {
  return join(chatDraftsDir(cfg), slugifyId(draftId));
}
export function draftFilePath(cfg: Config, draftId: string, name: string): string {
  return join(draftFilesDir(cfg, draftId), slugifyId(name));
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

/** JSON + the files beside it. The files land FIRST: a confirm that reads the
 * JSON can then assume every `files[].name` is already on disk. */
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
 * (the files dir stays put — the archive record still names it). */
export function archiveChatDraft(
  cfg: Config,
  id: string,
  sub: "submitted" | "discarded",
  deps: ReviewStoreDeps = {},
): boolean {
  return store.remove(chatDraftsDir(cfg), id, sub, deps);
}

/** Spec §6.3: the first failed draft is REMOVED (not archived) when its retry
 * parks — the operator never asked for it and it was never shown as a card. */
export function removeChatDraft(
  cfg: Config,
  id: string,
  deps: { rmFn?: (p: string) => void } = {},
): void {
  const rmFn = deps.rmFn ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  rmFn(join(chatDraftsDir(cfg), `${slugifyId(id)}.json`));
  rmFn(draftFilesDir(cfg, id));
}

/** ChatStatus.draftsParked (chatManager.ts) — how many drafts this session
 * has waiting for a human. */
export function draftsParkedFor(cfg: Config, slug: string, deps: ReviewStoreDeps = {}): number {
  return listChatDrafts(cfg, deps).filter((d) => d.slug === slug).length;
}
