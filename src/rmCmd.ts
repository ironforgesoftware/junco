/**
 * `junco rm <name>` — best-effort delete of a QUEUED ticket from inbox/ only.
 *
 * Fuzzy-matches the name against inbox/*.md like `junco retry`. It NEVER touches
 * processing/ (the daemon owns it) and refuses any name that resolves outside
 * inbox/. It is deliberately ENOENT-tolerant: the daemon can atomically claim a
 * ticket into processing/ between the caller's listing and this delete, and a
 * transient requeue can even rename a just-deleted name back INTO inbox/
 * (`moveBackToInbox` in requeue.ts), so a miss is reported truthfully as "may
 * reappear" and exits 0 — this is a best-effort inbox delete, not an
 * authoritative kill.
 */

import { readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";

export interface RmDeps {
  printFn?: (s: string) => void;
  readdirFn?: (d: string) => string[];
  unlinkFn?: (p: string) => void;
}

const notPresent = (name: string): string =>
  `junco rm: '${name}' not present in inbox — it may be claimed or mid-requeue and could reappear\n`;

export async function runRmCommand(
  cfg: Config,
  args: string[],
  deps: RmDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const readdirFn = deps.readdirFn ?? ((d: string) => readdirSync(d));
  const unlinkFn = deps.unlinkFn ?? ((p: string) => unlinkSync(p));

  const name = args[0];
  if (!name) {
    print("Usage: junco rm <name>\n");
    return 2;
  }

  // Path safety: rm operates ONLY on a bare inbox filename. A name carrying a
  // path separator (../x, a/b, /abs/path, …/processing/x) or a leading dot can
  // never be a legit inbox ticket name — refuse outright rather than fuzzy-match.
  if (name !== basename(name) || name.startsWith(".")) {
    print(`junco rm: '${name}' is not a plain inbox ticket name\n`);
    return 2;
  }

  const inbox = queuePaths(cfg).inbox;
  let entries: string[] = [];
  try {
    entries = readdirFn(inbox).filter((n) => n.endsWith(".md"));
  } catch {
    /* no inbox dir yet — treat as empty */
  }

  const exact = entries.filter((e) => e === name || e === `${name}.md`);
  const fuzzy = exact.length > 0 ? exact : entries.filter((e) => e.includes(name));

  if (fuzzy.length > 1) {
    print(`junco rm: '${name}' is ambiguous:\n${fuzzy.map((f) => `  ${f}`).join("\n")}\n`);
    return 2;
  }
  if (fuzzy.length === 0) {
    // Nothing in inbox matches: a typo, or (far likelier for a TUI action taken
    // against a just-seen WAITING row) the daemon claimed it into processing/
    // moments ago. Truthful and non-authoritative → exit 0.
    print(notPresent(name));
    return 0;
  }

  const entry = fuzzy[0];
  try {
    unlinkFn(join(inbox, entry));
    print(`removed: ${entry}\n`);
    return 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      // Claimed/renamed between our listing and the unlink — the daemon won the
      // race. Best-effort semantics: report truthfully, exit 0.
      print(notPresent(entry));
      return 0;
    }
    print(`junco rm: ${entry}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
