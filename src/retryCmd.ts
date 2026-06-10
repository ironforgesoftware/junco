/**
 * `junco retry <name…|--all>` — move failed tickets back to the inbox for a
 * fresh attempt: claim stamp stripped, appended result artifacts removed,
 * worker retry bookkeeping (retry_count / not_before) cleared.
 */

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { submitTicket } from "./dispatch.js";
import { CLAIM_PREFIX_RE } from "./requeue.js";

/**
 * Cut everything from the FIRST appended junco-result separator onward.
 * (Known limitation, documented in the README: a ticket BODY containing the
 * literal separator loses its tail when retried.)
 */
export function stripResultArtifacts(content: string): string {
  const idx = content.indexOf("\n---\n<!-- junco-result");
  // trimEnd() inverts finalize's append (`trimEnd() + "\n\n---\n<!-- …"`).
  return idx === -1 ? content : content.slice(0, idx).trimEnd() + "\n";
}

/** Remove a `key: …` line from the frontmatter block, if present. */
export function removeFrontmatterKey(content: string, key: string): string {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return content;
  const newBlock = m[1]
    .split("\n")
    .filter((l) => !new RegExp(`^${key}:`).test(l))
    .join("\n");
  return content.slice(0, m.index) + `---\n${newBlock}\n---` + content.slice(m.index + m[0].length);
}

export interface RetryDeps {
  printFn?: (s: string) => void;
}

export async function runRetryCommand(
  cfg: Config,
  names: string[],
  opts: { all?: boolean } = {},
  deps: RetryDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const failedDir = queuePaths(cfg).failed;
  let entries: string[] = [];
  try {
    entries = readdirSync(failedDir).filter((n) => n.endsWith(".md"));
  } catch {
    /* no failed dir yet */
  }

  let targets: string[];
  if (opts.all) {
    targets = entries;
    if (targets.length === 0) {
      print("nothing in failed/\n");
      return 0;
    }
  } else {
    if (names.length === 0) {
      print("Usage: junco retry <name…|--all>\n");
      return 2;
    }
    targets = [];
    for (const name of names) {
      const exact = entries.filter((e) => e === name || e === `${name}.md`);
      const fuzzy = exact.length > 0 ? exact : entries.filter((e) => e.includes(name));
      if (fuzzy.length === 0) {
        print(`junco retry: no failed ticket matches '${name}'\n`);
        return 1;
      }
      if (fuzzy.length > 1) {
        print(`junco retry: '${name}' is ambiguous:\n${fuzzy.map((f) => `  ${f}`).join("\n")}\n`);
        return 2;
      }
      targets.push(fuzzy[0]);
    }
  }

  let failures = 0;
  for (const entry of targets) {
    const src = join(failedDir, entry);
    try {
      let content = stripResultArtifacts(readFileSync(src, "utf8"));
      content = removeFrontmatterKey(content, "retry_count");
      content = removeFrontmatterKey(content, "not_before");
      const cleanName = entry.replace(CLAIM_PREFIX_RE, "");
      const dst = submitTicket(cfg, content, { idHint: cleanName.replace(/\.md$/, "") });
      unlinkSync(src); // only after the inbox copy is safely in place
      print(`requeued: ${dst}\n`);
    } catch (e) {
      failures++;
      print(`junco retry: ${entry}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return failures > 0 ? 1 : 0;
}
