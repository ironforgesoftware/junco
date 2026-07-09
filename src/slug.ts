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
