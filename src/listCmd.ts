/** `junco list [inbox|processing|done|failed]` — newest-first ticket listing. */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";

const BOXES = ["inbox", "processing", "done", "failed"] as const;
type Box = (typeof BOXES)[number];

const RESULT_STATUS_RE = /<!-- junco-result\nstatus: ([^\n]+)/g;

/** The status recorded by the LAST junco-result block, or null. */
export function ticketStatusOf(content: string): string | null {
  let last: string | null = null;
  for (const m of content.matchAll(RESULT_STATUS_RE)) last = m[1].trim();
  return last;
}

function age(mtimeMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export interface ListDeps {
  printFn?: (s: string) => void;
  nowFn?: () => number;
  /** Cap per box (newest first). Default 15. */
  limit?: number;
}

export async function runListCommand(
  cfg: Config,
  box: string | undefined,
  deps: ListDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const now = (deps.nowFn ?? Date.now)();
  const limit = deps.limit ?? 15;
  if (box !== undefined && !BOXES.includes(box as Box)) {
    print(`junco list: unknown box '${box}' (expected: ${BOXES.join(" | ")})\n`);
    return 2;
  }
  const paths = queuePaths(cfg);
  const targets = box ? [box as Box] : [...BOXES];
  for (const b of targets) {
    const dir = paths[b];
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".md"));
    } catch {
      /* missing dir → empty box */
    }
    const entries = names
      .map((n) => {
        // A live daemon can rename a ticket out of this box between readdir and
        // stat; a vanished entry (ENOENT) is skipped, not fatal (#120).
        try {
          return { n, mtime: statSync(join(dir, n)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is { n: string; mtime: number } => e !== null)
      .sort((a, b2) => b2.mtime - a.mtime);
    print(`${b} (${entries.length})\n`);
    for (const e of entries.slice(0, limit)) {
      let statusTag = "";
      if (b === "done" || b === "failed") {
        try {
          const s = ticketStatusOf(readFileSync(join(dir, e.n), "utf8"));
          if (s) statusTag = `  [${s}]`;
        } catch {
          /* vanished between stat and read → list it without a status tag */
        }
      }
      print(`  ${e.n}  (${age(e.mtime, now)})${statusTag}\n`);
    }
    if (entries.length > limit) print(`  … ${entries.length - limit} more\n`);
  }
  return 0;
}
