import { readdirSync, renameSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

export function discoverTasks(inbox: string): string[] {
  try {
    return readdirSync(inbox)
      .filter((n) => n.endsWith(".md"))
      .map((n) => join(inbox, n))
      .sort();
  } catch {
    return [];
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
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}
