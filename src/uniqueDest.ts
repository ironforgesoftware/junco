import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Return a path inside `dir` for `name` that does not collide with an
 * existing entry: `name.md` → `name-2.md` → `name-3.md` … The claim stamp has
 * only minute resolution (queue.ts), so two terminal records for the same
 * ticket id can land on the same destination name within a UTC minute (e.g. a
 * `junco retry` that fails again fast); a bare rename would POSIX-overwrite the
 * first, destroying its audit trail. This mirrors the requeue.ts uniquify (which
 * appends a `-r<attempt>` suffix on the inbox side) so the terminal moves in
 * finalize.ts / orphans.ts preserve every attempt's record (issue #48).
 */
export function uniqueDestPath(dir: string, name: string): string {
  let candidate = join(dir, name);
  if (!existsSync(candidate)) return candidate;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    candidate = join(dir, `${stem}-${n}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}
