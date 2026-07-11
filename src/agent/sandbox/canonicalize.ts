import { realpathSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";

/**
 * Resolve a path to its canonical form, collapsing symlinks in the longest
 * existing prefix. On macOS the OS sandbox (Seatbelt) evaluates the REAL path,
 * and `os.tmpdir()` / `/tmp` / `/var` are symlinks into `/private/...`; a
 * profile or jail keyed on the un-resolved path would deny legitimate writes.
 * Non-existent trailing segments (e.g. a not-yet-created file) are appended
 * verbatim. Never throws.
 */
export function canonicalize(p: string): string {
  const absInput = resolve(p);
  try {
    return realpathSync(absInput);
  } catch {
    // Whole path does not exist yet — resolve the longest existing prefix.
  }
  let abs = absInput;
  const tail: string[] = [];
  while (true) {
    const parent = dirname(abs);
    if (parent === abs) return absInput; // reached root; nothing resolvable
    tail.unshift(basename(abs));
    abs = parent;
    try {
      return join(realpathSync(abs), ...tail);
    } catch {
      // keep walking up
    }
  }
}
