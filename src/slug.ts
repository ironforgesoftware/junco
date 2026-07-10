import { join } from "node:path";

/**
 * Slugify a ticket id for safe use as a single filesystem path component.
 *
 * Keep alphanumerics, dots, underscores, and hyphens; collapse every other
 * run of characters (path separators, spaces, `..`-forming slashes, control
 * chars) to a single `-`; strip leading/trailing dashes; fall back to
 * "ticket" when nothing usable remains.
 *
 * This is the shared implementation behind the id slugs already applied
 * everywhere ids reach the filesystem — `worktreeSlug` (src/worktree.ts),
 * `submitTicket` (src/dispatch.ts), and the branch slug (src/repoContext.ts)
 * use the identical `re.sub(r"[^A-Za-z0-9._-]+", "-").strip("-") or "ticket"`
 * pattern (worker.py prepare_worktree line 1915). A frontmatter id like
 * `../../../../etc/anything` therefore becomes one inert filename component,
 * closing the transcript-path traversal hole (issue #32).
 */
export function slugifyId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

/**
 * The one construction site for a per-ticket event-transcript path.
 *
 * Every agent flow (PR: prFlow.ts, Q&A: runOnce.ts, assess: assessFlow.ts,
 * analyze: analyzeFlow.ts) routes through this helper so the id can only ever
 * reach the filesystem as a single `slugifyId`-collapsed path component — a raw
 * `../..`-shaped id can never escape `<stateDir>/transcripts/`. Centralizing it
 * is deliberate: the traversal hole (issue #32) regressed once (issue #94)
 * precisely because the slugify step was duplicated per call site and one site
 * was missed.
 */
export function transcriptPathFor(stateDir: string, id: string): string {
  return join(stateDir, "transcripts", `${slugifyId(id)}.jsonl`);
}
