import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { log } from "./logging.js";

export interface OrphanDeps {
  now?: () => string;
}

/**
 * On daemon startup, any ticket sitting in processing/ means a prior worker
 * crashed mid-run (the singleton lock guarantees no live concurrent instance,
 * so every processing-dir file is genuinely orphaned — no age check needed).
 *
 * Each orphan is annotated with a <!-- junco-result ... --> metadata block
 * (status: failed, reason: orphan-recovery) plus a human "## Orphan recovery"
 * banner, then atomically moved to failed/.
 *
 * Returns the list of destination paths (moved-to-failed/ paths).
 *
 * Faithful port of worker.py recover_orphans (lines 530-559).
 */
export function recoverOrphans(cfg: Config, deps: OrphanDeps = {}): string[] {
  const { processing, failed } = queuePaths(cfg);

  mkdirSync(processing, { recursive: true });
  mkdirSync(failed, { recursive: true });

  // List and sort .md files only — leave other files untouched.
  const names = readdirSync(processing)
    .filter((n) => n.endsWith(".md"))
    .sort();

  const moved: string[] = [];

  for (const name of names) {
    const orphanPath = join(processing, name);
    log.warn("recovering orphaned task", { name });

    let existing: string;
    try {
      existing = readFileSync(orphanPath, "utf8");
    } catch (e) {
      log.error("could not read orphan", { name, err: String(e) });
      continue;
    }

    const ts = deps.now?.() ?? new Date().toISOString();

    // Metadata block — same delimiters as src/finalize.ts renderResult.
    const metaBlock =
      `<!-- junco-result\n` +
      `status: failed\n` +
      `reason: orphan-recovery\n` +
      `finished: ${ts}\n` +
      `-->`;

    // Human banner — mirrors Python wording.
    const banner =
      `## Orphan recovery\n\n` +
      `This task was found in \`processing/\` at worker startup (${ts}), ` +
      `meaning a previous worker process crashed or was killed mid-run. ` +
      `Moving to failed/ without re-running. Move back to inbox/ to retry.`;

    const updated =
      `${existing.trimEnd()}\n\n---\n${metaBlock}\n\n${banner}\n`;

    // Atomic write: temp sibling → rename (PR #1 pattern used across the codebase).
    const tmp = orphanPath + ".tmp";
    try {
      writeFileSync(tmp, updated, "utf8");
      renameSync(tmp, orphanPath);
    } catch (e) {
      log.error("could not write updated orphan", { name, err: String(e) });
      // Fall through — still attempt the move per Python behaviour.
    }

    // Move to failed/ — non-fatal on error (log and continue).
    const dst = join(failed, name);
    try {
      renameSync(orphanPath, dst);
      moved.push(dst);
    } catch (e) {
      log.error("could not move orphan to failed/", { name, err: String(e) });
    }
  }

  return moved;
}
