/**
 * Dispatch helpers — submit tickets to the Junco inbox atomically.
 *
 * Stack-agnostic: these helpers know nothing about the execution engine;
 * they only know where the inbox lives and how to write a file safely.
 */

import { mkdirSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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
 * - Writes to a hidden `.tmp` file first, then hardlinks it into place — so
 *   the daemon's `*.md` glob never sees a half-written file.
 * - Throws "ticket already queued" if a ticket with the same id is already
 *   present. The placement is ATOMIC: linkSync fails EEXIST rather than
 *   overwriting, so a concurrent submit racing for the same id loses cleanly
 *   (its ticket is never silently clobbered) instead of check-then-act.
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
  const slug = ticketId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";

  mkdirSync(inbox, { recursive: true });

  const destPath = join(inbox, `${slug}.md`);

  // Atomic placement: write a hidden dotfile, then hardlink it to destPath.
  // linkSync fails EEXIST if destPath already exists (the "already queued"
  // signal) instead of overwriting it — closing the check-then-act race where
  // a concurrent submit could silently clobber the other's ticket. The temp
  // hardlink is always dropped: on success destPath keeps the inode; on
  // failure it must not linger.
  const tmpPath = join(inbox, `.${slug}.md.tmp`);
  writeFileSync(tmpPath, sourceContent, "utf8");
  try {
    linkSync(tmpPath, destPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`ticket already queued: ${destPath}`);
    }
    throw e;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* temp already gone — nothing to clean up */
    }
  }

  return destPath;
}
