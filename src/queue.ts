import { readdirSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export function discoverTasks(inbox: string): string[] {
  try {
    return readdirSync(inbox)
      .filter((n) => n.endsWith(".md"))
      .map((n) => join(inbox, n))
      .sort();
  } catch (e) {
    // A missing inbox is normal (not created yet) → empty. Surface anything
    // else (EACCES, ENOTDIR, …) — silently returning [] would mask an operator
    // misconfiguration as "no work", matching the Python which let such errors fly.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
}

function utcStamp(now: Date): string {
  // YYYY-MM-DDTHHMMZ (UTC, minute resolution) — matches the Python claim prefix.
  return now.toISOString().slice(0, 16).replace(":", "") + "Z";
}

/** Injectable side effects (tests only; production callers omit this). */
export interface ClaimDeps {
  /** Clock seam (default: real wall clock). Injectable so a test can force two
   * claims into the same UTC minute deterministically to exercise the
   * destination-collision guard. */
  now?: () => Date;
}

export function claim(src: string, processingDir: string, deps: ClaimDeps = {}): string | null {
  const now = deps.now ?? (() => new Date());
  mkdirSync(processingDir, { recursive: true });
  const dst = join(processingDir, `${utcStamp(now())}__${basename(src)}`);
  // Destination-exists guard (issue #109): the stamp is minute-granular, so a
  // ticket resubmitted with the same id and claimed within the same UTC minute
  // computes an identical destination. A bare POSIX rename would SILENTLY
  // replace the in-flight processing file (and let the same id be claimed
  // twice). Refuse instead of clobber: leave the source in inbox for a later
  // poll — a fresh minute yields a fresh stamp, or the in-flight run finishes
  // first. Returning null matches the "source vanished" contract the caller
  // already handles (leave it queued, try the next candidate). Cannot preserve
  // atomicity via renameSync (POSIX rename always overwrites) and cannot vary
  // the stamp (requeue's CLAIM_PREFIX_RE / githubInbox's `__${id}.md` match
  // depend on the exact `<stamp>__<id>` shape); the worker/run-once poll is
  // serial, so this check-then-rename is safe against the realistic collision.
  if (existsSync(dst)) return null;
  try {
    renameSync(src, dst);
    return dst;
  } catch (e) {
    // Source vanished before we claimed it (lost a race / file deleted) → null.
    // (processingDir was just mkdir'd above, so ENOENT here means the source.)
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
}

/** mtimes (ms) of the `.md` files directly in `dir`; an unreadable dir or
 * file is skipped. Shared by `junco status` and the dashboard's queue stats
 * (both CLI-side and TUI-side callers, so it lives here rather than in
 * either). */
export function mdMtimes(
  dir: string,
  readdirFn: (d: string) => string[],
  statFn: (p: string) => { mtimeMs: number },
): number[] {
  try {
    return readdirFn(dir)
      .filter((n) => n.endsWith(".md"))
      .flatMap((n) => {
        try {
          return [statFn(join(dir, n)).mtimeMs];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
