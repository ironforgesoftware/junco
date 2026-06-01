/**
 * Dispatch helpers — submit tickets to the Junco inbox atomically.
 *
 * Stack-agnostic: these helpers know nothing about the execution engine;
 * they only know where the inbox lives and how to write a file safely.
 */

import { mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { parseTicket } from "./ticket.js";

/** Return the inbox directory path for the given config. */
export function inboxPath(cfg: Config): string {
  return queuePaths(cfg).inbox;
}

/**
 * Place a ticket into the inbox ATOMICALLY and return the destination path.
 *
 * - Derives the ticket id from the frontmatter (falling back to filename/idHint).
 * - Slugifies the id for safe use as a filename.
 * - Writes to a hidden `.tmp` file first, then renames — so the daemon's
 *   `*.md` glob never sees a half-written file.
 * - Throws if a ticket with the same id is already queued in the inbox.
 */
export function submitTicket(
  cfg: Config,
  sourceContent: string,
  opts: { idHint?: string } = {},
): string {
  const inbox = inboxPath(cfg);

  // Derive ticket id from frontmatter, falling back to idHint or placeholder.
  const parsed = parseTicket("submitted.md", sourceContent);
  // If the parsed id is "submitted" (the placeholder basename), prefer idHint.
  let ticketId = parsed.id;
  if (ticketId === "submitted" && opts.idHint) {
    ticketId = opts.idHint;
  }

  // Slugify: keep alphanumeric, dots, underscores, hyphens; collapse rest to "-".
  const slug =
    ticketId
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ticket";

  mkdirSync(inbox, { recursive: true });

  const destPath = join(inbox, `${slug}.md`);
  if (existsSync(destPath)) {
    throw new Error(`ticket already queued: ${destPath}`);
  }

  // Atomic write: hidden dotfile → rename.
  const tmpPath = join(inbox, `.${slug}.md.tmp`);
  writeFileSync(tmpPath, sourceContent, "utf8");
  renameSync(tmpPath, destPath);

  return destPath;
}
