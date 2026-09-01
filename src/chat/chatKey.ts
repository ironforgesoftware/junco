/**
 * Chat repo keys (spec 2026-09-01 §1.2). The KEY is the rail's selection key
 * (railModel.ts): `nwo.toLowerCase()` for a watched repo, the resolved
 * checkout path for a local-only row. Clients always send the key; the daemon
 * derives the on-disk SLUG here and never parses a slug back (meta.json holds
 * the key).
 */
import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";

/** "owner/repo" — has a slash and is not an absolute path. */
export function isWatchedKey(key: string): boolean {
  return !isAbsolute(key) && !/^[a-zA-Z]:[\\/]/.test(key) && key.includes("/");
}

/** watched → `owner__repo` (lowercased); local → `local-<basename>-<sha1[:8]>`.
 * The prefixes cannot collide, and neither form can contain a path separator
 * or `..` (the basename is slugified to [a-z0-9._-]). */
export function chatSlug(key: string): string {
  if (isWatchedKey(key)) return key.toLowerCase().replace(/\//g, "__");
  const base = basename(key)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  return `local-${base || "repo"}-${hash}`;
}
