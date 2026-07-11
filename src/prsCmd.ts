/**
 * `junco prs` — list junco-authored pull requests across every watched repo
 * (config `[[github.repos]]` ∪ dashboard watchlist, INCLUDING external fork-PR
 * repos — see `resolveWatchedReposForPrs` in watchlist.ts). Shares
 * its fetch+map+filter core with the dashboard's PRs view via
 * `fetchJuncoPrs` (src/githubPrs.ts) and its sort/lifecycle logic via
 * `sortPrs`/`derivePrState`/`prStateMeta` (src/tui/prState.ts) — the CLI and
 * TUI list PRs identically by construction, not by convention.
 */

import type { Config } from "./types.js";
import type { gh } from "./git.js";
import { resolveWatchedReposForPrs } from "./watchlist.js";
import { fetchJuncoPrs } from "./githubPrs.js";
import { derivePrState, prStateMeta, sortPrs, type DashPr } from "./tui/prState.js";

const NUM_DIGIT_WIDTH = 4; // digits right-aligned within this width, after a leading "#"
const BADGE_WIDTH = 18; // longest PrLifecycle badge: "changes-requested"
const CHECKS_WIDTH = 10;
const TITLE_WIDTH = 50;

function fmtChecks(c: DashPr["checks"]): string {
  if (c.total === 0) return "—";
  return `✓${c.pass} ✗${c.fail} ◍${c.pending}`;
}

function truncateTitle(title: string, max = TITLE_WIDTH): string {
  return title.length <= max ? title : title.slice(0, max - 1) + "…";
}

/** One plain-text line per PR — no color (CLI output may be piped), columns
 * kept aligned via fixed-width padding. */
export function formatPrLine(pr: DashPr): string {
  const num = `#${String(pr.number).padStart(NUM_DIGIT_WIDTH)}`;
  const badge = prStateMeta(derivePrState(pr)).badge.padEnd(BADGE_WIDTH);
  const checks = fmtChecks(pr.checks).padEnd(CHECKS_WIDTH);
  const title = truncateTitle(pr.title).padEnd(TITLE_WIDTH);
  return `${num}  ${badge}  ${checks}  ${title}  ${pr.url}`;
}

function errFirstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0];
}

export interface PrsCmdDeps {
  printFn?: (s: string) => void;
  /** Injected fake `gh` for tests — threaded through to `fetchJuncoPrs`. */
  ghFn?: typeof gh;
}

export async function runPrsCommand(cfg: Config, deps: PrsCmdDeps = {}): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  // Include external (fork-PR) repos: their draft PRs are the review surface and
  // must show here just like the dashboard (#131). Listing is read-only, so the
  // bridge-poll exclusion in resolveWatchedRepos does not apply.
  const repos = resolveWatchedReposForPrs(cfg);
  if (repos.length === 0) {
    print(
      "no watched repositories — add github.repos to config.json or watch one from the dashboard\n",
    );
    return 0;
  }

  const all: DashPr[] = [];
  let failures = 0;
  for (const repo of repos) {
    try {
      const prs = await fetchJuncoPrs(cfg, repo.nwo, { ghFn: deps.ghFn });
      all.push(...prs);
    } catch (e) {
      failures++;
      print(`${repo.nwo}: ${errFirstLine(e)}\n`);
    }
  }

  // Every configured repo failed — a real signal (auth/network down), not
  // just one flaky repo among many.
  if (failures === repos.length) return 1;

  const sorted = sortPrs(all);
  if (sorted.length === 0) {
    print("no junco PRs found\n");
    return 0;
  }
  for (const pr of sorted) print(formatPrLine(pr) + "\n");
  return 0;
}
