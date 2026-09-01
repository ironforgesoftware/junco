/**
 * Apply tickets (spec 2026-08-31-apply-tickets-design.md): a ticket whose body
 * carries a `junco-patch` fence is executed by applying that `git format-patch`
 * mbox series — no agent session. Detection is body-based on purpose: the
 * GitHub issue route rebuilds frontmatter machine-side, and the marker-
 * delimited body (#329) carries the series byte-exact.
 */
import { extractPatchBody } from "./githubInbox.js";

/** Refuse a series larger than this (the local route has no other cap; the
 * GitHub route is already bounded by the 64 KB issue-body limit). */
export const MAX_PATCH_BYTES = 512 * 1024;

export interface PatchSeries {
  /** The mbox text, exactly as it will be handed to `git am`. */
  raw: string;
  /** Patches in the series — one commit each. */
  count: number;
  /** Post- and pre-image paths the series touches (deduped, sorted). */
  files: string[];
}

const MBOX_FROM = /^From [0-9a-f]{7,40} /gm;
const DIFF_GIT = /^diff --git a\/(.+?) b\/(.+)$/gm;

/** The series carried by `body`, or null when this is not an apply ticket
 * (no fence, or a fence that is not a well-formed series). */
export function parsePatchSeries(body: string): PatchSeries | null {
  const raw = extractPatchBody(body);
  if (raw === null) return null;
  if (raw.length > MAX_PATCH_BYTES) return null;
  const froms = raw.match(MBOX_FROM);
  if (!froms || froms.length === 0) return null;
  if (!/^diff --git /m.test(raw)) return null;
  const files = new Set<string>();
  for (const m of raw.matchAll(DIFF_GIT)) {
    for (const p of [m[1], m[2]]) if (p !== "/dev/null") files.add(p);
  }
  if (files.size === 0) return null;
  return { raw, count: froms.length, files: [...files].sort() };
}

/** Paths a series must never touch: absolute, traversing, or empty. The patch's
 * own file list IS the scope declaration (spec open question 1), so this is a
 * containment check, not a policy allowlist. */
export function unsafePatchPaths(files: string[]): string[] {
  return files.filter(
    (f) => f === "" || f.startsWith("/") || f.split("/").includes("..") || f.includes("\0"),
  );
}

/** True when the series contains a binary hunk — `git am` would apply bytes no
 * reviewer read in the issue. */
export function hasBinaryHunk(raw: string): boolean {
  return /^GIT binary patch$/m.test(raw);
}
