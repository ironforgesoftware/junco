/**
 * `junco assess <path|owner/repo> [--auto-plan]` — compose and submit a
 * machine-owned assessment ticket. This command's only job is target
 * resolution + ticket authoring; the daemon's normal claim/execute path
 * (src/assessFlow.ts) runs the actual audit and files issues.
 */

import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Config } from "./types.js";
import { expandHome } from "./config.js";
import { submitTicket } from "./dispatch.js";
import { readWatchlist, watchlistPath } from "./watchlist.js";
import { buildAssessPrompt } from "./assessPrompt.js";

const NWO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Same slug rule dispatch.ts's submitTicket applies when choosing a
 * destination filename — mirrored here (not exported there) since this
 * builds the ticket id itself, not just the filename. */
function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC `YYYYMMDD-HHmm`. */
function stampOf(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`
  );
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build a machine-owned assessment ticket for `repoPath` (already resolved
 * by the caller). Frontmatter carries only `id`, `repo`, and `assess` —
 * nothing an agent session could widen; the body is the read-only audit
 * prompt. The nwo is unknown at authoring time (it's resolved from the
 * repo's origin remote when the ticket actually runs), so the prompt always
 * gets `nwo: null` here.
 */
export function buildAssessTicket(
  repoPath: string,
  opts: { autoPlan: boolean },
  now: Date,
): { id: string; content: string } {
  const id = `assess-${slugify(basename(repoPath))}-${stampOf(now)}`;
  const assessYaml = opts.autoPlan ? "assess:\n  auto_plan: true" : "assess: {}";
  const body = buildAssessPrompt({ nwo: null, repoPath });
  const content =
    `---\n` +
    `id: ${id}\n` +
    `repo: ${JSON.stringify(repoPath)}\n` +
    `${assessYaml}\n` +
    `---\n\n${body}`;
  return { id, content };
}

export interface AssessCmdDeps {
  printFn?: (s: string) => void;
  submitFn?: typeof submitTicket;
  nowFn?: () => Date;
}

export async function runAssessCommand(
  cfg: Config,
  target: string | undefined,
  opts: { autoPlan: boolean },
  deps: AssessCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const submitFn = deps.submitFn ?? submitTicket;
  const nowFn = deps.nowFn ?? ((): Date => new Date());

  if (!target) {
    print(`Usage: junco assess <path|owner/repo> [--auto-plan]\n`);
    return 2;
  }

  let repoPath: string;
  if (NWO_RE.test(target) && !isDirectory(target)) {
    // Include EXTERNAL entries: assess now files (via review) on repos the operator
    // does not own, so external clones are valid targets (unlike the bridge poll,
    // which still excludes them via resolveWatchedRepos).
    const fromConfig = cfg.github.repos.find((r) => r.nwo.toLowerCase() === target.toLowerCase());
    const { entries } = readWatchlist(watchlistPath(cfg));
    const fromWatch = entries.find((e) => e.nwo.toLowerCase() === target.toLowerCase());
    const match = fromConfig ?? fromWatch;
    if (!match) {
      print(
        `junco assess: '${target}' is not watched — add it under [[github.repos]] in config.toml, or watch it from the dashboard, then retry\n`,
      );
      return 2;
    }
    repoPath = expandHome(match.path);
  } else {
    const candidate = resolve(expandHome(target));
    if (!isDirectory(candidate)) {
      print(`junco assess: not a directory: ${candidate}\n`);
      return 2;
    }
    repoPath = candidate;
  }

  const { id, content } = buildAssessTicket(repoPath, opts, nowFn());

  let dst: string;
  try {
    dst = submitFn(cfg, content, { idHint: id });
  } catch (e) {
    print(`junco assess: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  print(`queued: ${dst}\n`);
  print("queued — the worker will audit the repo and file issues on its next claim\n");
  if (opts.autoPlan) {
    print(
      "--auto-plan requested — filed findings will carry the trigger label so the bridge plans them\n",
    );
  }
  return 0;
}
