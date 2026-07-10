/**
 * Dispatch helpers — submit tickets to the Junco inbox atomically.
 *
 * Stack-agnostic: these helpers know nothing about the execution engine;
 * they only know where the inbox lives and how to write a file safely.
 */

import {
  mkdirSync,
  writeFileSync,
  linkSync,
  renameSync,
  unlinkSync,
  existsSync,
  openSync,
  closeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { parseTicket } from "./ticket.js";

/** linkSync error codes that mean the inbox filesystem has no hard-link
 * support (exFAT/FAT, several CIFS/SMB mounts). On these we fall back to the
 * pre-#49 rename primitive, which is universally supported (issue #81). */
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOSYS", "EOPNOTSUPP", "EMLINK", "ENOTSUP"]);

/** Injectable side effects (tests only; production callers omit this). */
export interface SubmitTicketDeps {
  /** Hard-link primitive (default: fs.linkSync). Injectable so tests can
   * simulate a filesystem without hard-link support (EPERM/ENOSYS/...). */
  linkFn?: (existingPath: string, newPath: string) => void;
}

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
  deps: SubmitTicketDeps = {},
): string {
  const inbox = inboxPath(cfg);
  const linkFn = deps.linkFn ?? linkSync;

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
  //
  // The temp name is unique per submit (pid + random suffix), NOT derived from
  // the slug alone (issue #110): two concurrent submits of the same-slug ticket
  // must never write through one shared `.slug.md.tmp` inode — otherwise the
  // winner's inbox file could carry the loser's bytes, and a write into the
  // shared inode during the link→unlink window could mutate the already-queued
  // destination through the hardlink. Kept hidden + `.tmp` so the daemon's
  // `*.md` glob never sees it.
  const tmpPath = join(inbox, `.${slug}.md.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, sourceContent, "utf8");
  try {
    linkFn(tmpPath, destPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`ticket already queued: ${destPath}`);
    }
    if (code && NO_HARDLINK_CODES.has(code)) {
      // No hard-link support on this filesystem (issue #81) — fall back without
      // linkSync's EEXIST atomicity, but NOT to a check-then-act existsSync+
      // rename (issue #111). Claim an exclusive sentinel with O_EXCL (mirroring
      // pidfileLock): a racing submit fails EEXIST on the slot rather than
      // slipping through a bare existence check, and we only rename the
      // fully-written temp into place once we own the slot. We deliberately do
      // NOT O_EXCL destPath itself — a bare `wx` write there would momentarily
      // expose a half-written *.md to the daemon's glob — so the sentinel is a
      // hidden non-.md path and the .md only ever appears via an atomic rename
      // of a complete file.
      const slotPath = join(inbox, `.${slug}.md.claim`);
      let slotFd: number;
      try {
        slotFd = openSync(slotPath, "wx"); // O_CREAT | O_EXCL — atomic slot claim
      } catch (se) {
        // EEXIST: another submit owns the slot (or is mid-place) → duplicate.
        // Do NOT enter the finally below — we must not unlink a slot we don't own.
        if ((se as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`ticket already queued: ${destPath}`);
        }
        throw se;
      }
      try {
        closeSync(slotFd);
        // Slot is ours; a concurrent submit is now blocked at the O_EXCL above,
        // so this existence check + rename is effectively atomic against other
        // submitters. A pre-existing dest is a completed prior submit → duplicate.
        if (existsSync(destPath)) {
          throw new Error(`ticket already queued: ${destPath}`);
        }
        renameSync(tmpPath, destPath);
      } finally {
        try {
          unlinkSync(slotPath);
        } catch {
          /* slot already gone */
        }
      }
    } else {
      throw e;
    }
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* temp already gone (renamed into place, or never created) */
    }
  }

  return destPath;
}
