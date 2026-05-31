import { readdirSync, renameSync, mkdirSync } from "node:fs";
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

function utcStamp(): string {
  // YYYY-MM-DDTHHMMZ (UTC, minute resolution) — matches the Python claim prefix.
  return new Date().toISOString().slice(0, 16).replace(":", "") + "Z";
}

export function claim(src: string, processingDir: string): string | null {
  mkdirSync(processingDir, { recursive: true });
  const dst = join(processingDir, `${utcStamp()}__${basename(src)}`);
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
