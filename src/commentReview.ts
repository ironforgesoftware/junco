/**
 * Durable review queue for `junco analyze` comment drafts — one JSON file per
 * draft under <dataDir>/comment-review/ (atomic tmp+rename, watchlist/outbox
 * pattern). The analysis (analyzeFlow.ts) PARKS a draft here; a human-confirmed
 * post step (`junco analyze post`) posts it. Never throws on read: missing →
 * empty/null, corrupt → skipped (list) / `error` (read). Reviewed drafts
 * archive to posted/ or discarded/.
 *
 * Storage generalized into reviewStore.ts (Task 1, SP-2); this is the second
 * wrapper alongside assessReview.ts.
 */
import { makeReviewStore, type ReviewStoreDeps } from "./reviewStore.js";
import type { Config } from "./types.js";

export interface PendingComment {
  id: string; // ticket id (analyze-<owner>-<repo>-<n>)
  nwo: string;
  issue: number;
  issueTitle: string; // sanitized, display-only
  external: boolean;
  repoPath: string;
  createdAt: string; // ISO
  draft: string; // sanitized; stored WITHOUT the footer
  footer: boolean; // default true; appended at post/preview time
}

export type CommentReviewDeps = ReviewStoreDeps;

export const ANALYSIS_FOOTER =
  "_Analysis drafted with [junco](https://github.com/ironforgesoftware/junco) and human-reviewed before posting._";

const store = makeReviewStore<PendingComment>("comment-review");

/** draft + (footer ? "\n\n" + ANALYSIS_FOOTER : "") — the ONE place post/preview composition lives. */
export function composeCommentBody(d: PendingComment): string {
  return d.footer ? `${d.draft}\n\n${ANALYSIS_FOOTER}` : d.draft;
}

export function commentReviewPaths(cfg: Config): {
  dir: string;
  posted: string;
  discarded: string;
} {
  return {
    dir: store.dir(cfg),
    posted: store.archiveDir(cfg, "posted"),
    discarded: store.archiveDir(cfg, "discarded"),
  };
}

export function writeDraft(cfg: Config, d: PendingComment, deps: CommentReviewDeps = {}): string {
  return store.write(cfg, d, deps);
}

export function listDrafts(cfg: Config, deps: CommentReviewDeps = {}): PendingComment[] {
  return store.list(cfg, deps);
}

export function readDraft(
  cfg: Config,
  id: string,
  deps: CommentReviewDeps = {},
): { draft: PendingComment | null; error: string | null } {
  const { entry, error } = store.read(cfg, id, deps);
  return { draft: entry, error }; // preserve the generic store's {entry,error} → {draft,error}
}

export function removeDraft(
  cfg: Config,
  id: string,
  to: "posted" | "discarded",
  deps: CommentReviewDeps = {},
): void {
  store.remove(cfg, id, to, deps);
}

export function draftCount(cfg: Config, deps: CommentReviewDeps = {}): number {
  return store.count(cfg, deps);
}
