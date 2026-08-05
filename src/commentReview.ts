/**
 * Durable review queue for `junco analyze` comment drafts — one JSON file per
 * draft under <dataDir>/review/comments/ (atomic tmp+rename, watchlist/outbox
 * pattern). The analysis (analyzeFlow.ts) PARKS a draft here; a human-confirmed
 * post step (`junco analyze post`) posts it. Never throws on read: missing →
 * empty/null, corrupt → skipped (list) / `error` (read). Reviewed drafts
 * archive to posted/ or discarded/.
 *
 * Storage generalized into reviewStore.ts (Task 1, SP-2); this is the second
 * wrapper alongside assessReview.ts. dataTreePaths(cfg).reviewComments is the
 * only join of the "review/comments" subdir onto the data root — every
 * function below resolves it fresh per call (reviewStore.ts takes the
 * absolute dir at call time, not a subdir at construction).
 */
import { makeReviewStore, type ReviewStoreDeps } from "./reviewStore.js";
import { dataTreePaths } from "./dataTree.js";
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

const store = makeReviewStore<PendingComment>();

/** draft + (footer ? "\n\n" + ANALYSIS_FOOTER : "") — the ONE place post/preview composition lives. */
export function composeCommentBody(d: PendingComment): string {
  return d.footer ? `${d.draft}\n\n${ANALYSIS_FOOTER}` : d.draft;
}

export function commentReviewPaths(cfg: Config): {
  dir: string;
  posted: string;
  discarded: string;
} {
  const dir = dataTreePaths(cfg).reviewComments;
  return {
    dir,
    posted: store.archiveDir(dir, "posted"),
    discarded: store.archiveDir(dir, "discarded"),
  };
}

export function writeDraft(cfg: Config, d: PendingComment, deps: CommentReviewDeps = {}): string {
  return store.write(dataTreePaths(cfg).reviewComments, d, deps);
}

export function listDrafts(cfg: Config, deps: CommentReviewDeps = {}): PendingComment[] {
  return store.list(dataTreePaths(cfg).reviewComments, deps);
}

export function readDraft(
  cfg: Config,
  id: string,
  deps: CommentReviewDeps = {},
): { draft: PendingComment | null; error: string | null } {
  const { entry, error } = store.read(dataTreePaths(cfg).reviewComments, id, deps);
  return { draft: entry, error }; // preserve the generic store's {entry,error} → {draft,error}
}

export function removeDraft(
  cfg: Config,
  id: string,
  to: "posted" | "discarded",
  deps: CommentReviewDeps = {},
): void {
  store.remove(dataTreePaths(cfg).reviewComments, id, to, deps);
}

export function draftCount(cfg: Config, deps: CommentReviewDeps = {}): number {
  return store.count(dataTreePaths(cfg).reviewComments, deps);
}
