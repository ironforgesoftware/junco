import { realpathSync, lstatSync, readlinkSync } from "node:fs";
import { resolve, dirname, basename, join, isAbsolute } from "node:path";

/** Cap on symlink hops before giving up — matches the kernel's typical limit
 *  and prevents an infinite loop on a symlink cycle. */
const MAX_SYMLINK_DEPTH = 40;

/**
 * Resolve a path to its canonical (symlink-free) form — following symlinks even
 * when the final target does NOT exist yet. Two reasons this matters:
 *
 *  1. macOS: the OS sandbox (Seatbelt) evaluates the REAL path, and `os.tmpdir()`
 *     / `/tmp` / `/var` are symlinks into `/private/...`; a profile or jail keyed
 *     on the un-resolved path would deny legitimate writes.
 *  2. Security (#158): the in-process fs tools' path-jail must see the real
 *     target a write/read would actually touch. A DANGLING symlink (target
 *     missing) makes `realpathSync` throw, so the fallback resolves the leaf's
 *     symlink instead of appending it verbatim — otherwise a write to an in-jail
 *     symlink pointing OUT of the jail would pass the jail check and escape.
 *
 * Non-existent, non-symlink trailing segments (a not-yet-created file) are kept
 * verbatim inside the canonical parent. Never throws.
 */
export function canonicalize(p: string, depth = 0): string {
  const absInput = resolve(p);
  // Fast path: the whole path exists and fully resolves (follows all symlinks).
  try {
    return realpathSync(absInput);
  } catch {
    // Missing target and/or a dangling symlink somewhere — resolve manually.
  }
  if (depth >= MAX_SYMLINK_DEPTH) return absInput; // symlink-loop guard
  const parent = dirname(absInput);
  if (parent === absInput) return absInput; // reached root; nothing to resolve
  // Resolve the parent directory first (it usually exists → fast realpath).
  const canonParent = canonicalize(parent, depth + 1);
  const leafPath = join(canonParent, basename(absInput));
  // If the leaf itself is a symlink (possibly dangling), resolve its target so
  // the jail checks where the op would ACTUALLY land — not the link's own path.
  try {
    if (lstatSync(leafPath).isSymbolicLink()) {
      const target = readlinkSync(leafPath);
      const resolved = isAbsolute(target) ? target : join(canonParent, target);
      return canonicalize(resolved, depth + 1);
    }
  } catch {
    // Leaf does not exist → a new entry inside a canonical dir; leafPath is it.
  }
  return leafPath;
}
