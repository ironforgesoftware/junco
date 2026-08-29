/**
 * `junco submit --as-issue` — file a locally-authored ticket as a PARKED,
 * UNLABELED GitHub issue (spec docs/superpowers/specs/2026-08-21-issue-as-
 * inbox-design.md). The bot authors; only a human's trigger label launches.
 * The target repo is matched by watched clone path OR by the checkout's
 * `origin` (findWatchedForPath). Frontmatter is machine-owned at extraction
 * time (buildExecutionTicket), so everything except id/repo/pr_title is
 * discarded here — loudly.
 */
import { basename } from "node:path";
import type { Config, GithubRepoMapping } from "./types.js";
import { parseTicket } from "./ticket.js";
import { resolveWatchedRepos } from "./watchlist.js";
import { withBotAuth } from "./ghAuth.js";
import { createIssueLive } from "./assessFiling.js";
import { gh, git } from "./git.js";
import { expandHome } from "./config.js";
import { canonPath } from "./unwatchCmd.js";
import { extractPlanSetBody, nwoFromRemoteUrl } from "./githubInbox.js";
import { parsePlanSet } from "./planCompiler.js";
import { slugifyId } from "./slug.js";

const CARRIED_KEYS = new Set(["id", "repo", "pr_title"]);

/** Wrap `body` in a fence longer than any backtick run inside it, so the
 * bridge's extractFencedBlock (junco-ticket tag, githubInbox.ts) round-trips
 * bodies that contain code fences of their own. */
export function wrapInFence(tag: string, body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${tag}\n${body.trimEnd()}\n${fence}`;
}

function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

/**
 * Resolve a local path to its bridge-watched entry. Two routes: the path IS
 * a watched clone (the bridge's own managed clone, `github.repos[].path` or
 * the watchlist), or the path is the operator's OWN checkout of a watched
 * repo — its `origin` remote names a watched `owner/repo`. The second route
 * is the junco-dispatch case: the skill stamps `repo:` with the working
 * checkout, while the watchlist points at `<dataDir>/cache/clones/watched/…`,
 * so a path-only match refused every skill-authored ticket. Matching is
 * case-insensitive on the nwo (GitHub owner/repo names are). External
 * (fork-PR) entries are already excluded by resolveWatchedRepos. Any failure
 * reading `origin` (not a git checkout, no remote, non-GitHub URL) is simply
 * "no match" — the caller's refusal explains both routes.
 */
export async function findWatchedForPath(
  cfg: Config,
  target: string,
  gitFn: typeof git,
): Promise<GithubRepoMapping | null> {
  const watched = resolveWatchedRepos(cfg);
  const byPath = watched.find((r) => canonPath(r.path) === target);
  if (byPath) return byPath;
  let nwo: string | null = null;
  try {
    const r = await gitFn(cfg, ["remote", "get-url", "origin"], {
      cwd: target,
      timeoutMs: 10_000,
      check: false,
    });
    nwo = r.code === 0 ? nwoFromRemoteUrl(r.stdout.trim()) : null;
  } catch {
    nwo = null;
  }
  if (nwo === null) return null;
  const want = nwo.toLowerCase();
  return watched.find((r) => r.nwo.toLowerCase() === want) ?? null;
}

export interface SubmitAsIssueDeps {
  ghFn?: typeof gh;
  /** `git remote get-url origin` in the ticket's repo — the second route
   * findWatchedForPath tries. Default: the real `git`. */
  gitFn?: typeof git;
  printFn?: (s: string) => void;
  errFn?: (s: string) => void;
  /** Resolve (and attach) the bot's GitHub auth context onto Config. Typed
   * monomorphically over Config (mirrors cli.ts's withBotAuthFn: the real
   * withBotAuth is generic over `C extends Pick<Config, "botAccount" |
   * "ghBin">`, which this narrower shape still satisfies). Default: the real
   * withBotAuth. */
  withBotAuthFn?: (cfg: Config) => Promise<Config>;
}

/**
 * File `content` (already-read ticket text for `fileArg`) as a parked,
 * unlabeled issue on the ticket's `repo:` target — which must already be a
 * bridge-watched repo, since an unwatched repo could never launch the parked
 * issue. When `opts.plan` is set, this instead parks a plan-set fence
 * (validated with the same extractPlanSetBody → parsePlanSet rules the local
 * `junco submit --plan` branch runs) against `opts.repoFlag`, wrapped as a
 * `junco-plan` fence the bridge compiles once a human applies the trigger
 * label (Task 3's door).
 */
export async function submitAsIssue(
  cfg: Config,
  fileArg: string,
  content: string,
  opts: { plan: boolean; repoFlag?: string },
  deps: SubmitAsIssueDeps = {},
): Promise<number> {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const err = deps.errFn ?? ((s: string) => process.stderr.write(s));
  const withBotAuthFn = deps.withBotAuthFn ?? ((c: Config) => withBotAuth(c));

  if (!cfg.github.enabled) {
    err("junco submit --as-issue: GitHub integration is disabled (github.enabled)\n");
    return 1;
  }
  if (!cfg.botAccount.enabled) {
    err(
      "junco submit --as-issue: requires the bot account (botAccount.enabled) — " +
        "the bot authors the parked issue; a human's trigger label launches it. Run: junco auth login\n",
    );
    return 1;
  }

  if (opts.plan) {
    if (!cfg.planSets.enabled) {
      err(
        "junco submit --as-issue --plan: plan sets are disabled — set planSets.enabled in config.json\n",
      );
      return 1;
    }
    if (!opts.repoFlag) {
      err("Usage: junco submit --as-issue --plan <file> --repo <path>\n");
      return 2;
    }
    const fence = extractPlanSetBody(content);
    if (fence === null) {
      err(`junco submit --as-issue: no junco-plan fence found in '${fileArg}'\n`);
      return 1;
    }
    const parsedPlan = parsePlanSet(fence, { maxTasks: cfg.planSets.maxTasks });
    if (!parsedPlan.ok) {
      for (const e of parsedPlan.errors) err(`junco submit --as-issue: plan error: ${e}\n`);
      return 1;
    }
    const target = canonPath(expandHome(opts.repoFlag));
    const watched = await findWatchedForPath(cfg, target, gitFn);
    if (!watched) {
      err(
        `junco submit --as-issue: ${opts.repoFlag} is not a bridge-watched repo — neither a watched ` +
          "clone path nor a checkout whose origin is a watched owner/repo\n",
      );
      return 1;
    }
    const planId = "plan-" + slugifyId(basename(fileArg).replace(/\.md$/, ""));
    const issueBody =
      `_Parked junco plan set — apply the \`${cfg.github.triggerLabel}\` label to compile and queue it._\n\n` +
      wrapInFence("junco-plan", fence) +
      "\n\n<!-- junco:as-issue -->\n";

    let cfgBot: Config;
    try {
      cfgBot = await withBotAuthFn(cfg);
    } catch (e) {
      err(`junco submit --as-issue: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }

    const url = await createIssueLive(
      cfgBot,
      watched.nwo,
      `plan set: ${planId}`,
      issueBody,
      [],
      ghFn,
    );
    if (url === null) {
      err("junco submit --as-issue: gh issue create failed (see log)\n");
      return 1;
    }
    print(`parked as issue: ${url}\n`);
    print(`apply label '${cfg.github.triggerLabel}' to queue\n`);
    return 0;
  }

  // parseTicket (src/ticket.ts) never throws — unparsable YAML degrades to an
  // empty frontmatter record rather than raising. The try/catch is defensive
  // only (forward-compatible if that contract ever tightens); the realistic
  // "invalid ticket" refusal below is the missing repo: field check, which is
  // what a frontmatter-less/malformed ticket actually falls through to.
  let parsed: ReturnType<typeof parseTicket>;
  try {
    parsed = parseTicket(fileArg, content);
  } catch (e) {
    err(`junco submit --as-issue: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const repoRaw = parsed.frontmatter.repo;
  if (typeof repoRaw !== "string" || repoRaw === "") {
    err("junco submit --as-issue: ticket needs a repo: frontmatter path\n");
    return 1;
  }

  const target = canonPath(expandHome(repoRaw));
  const watched = await findWatchedForPath(cfg, target, gitFn);
  if (!watched) {
    err(
      `junco submit --as-issue: ${repoRaw} is not a bridge-watched repo — neither a watched clone ` +
        "path nor a checkout whose origin is a watched owner/repo, so the parked issue could never " +
        "launch. Watch the repo (github.repos / junco watch) or submit locally instead.\n",
    );
    return 1;
  }

  // Frontmatter is machine-owned on the issue route (buildExecutionTicket
  // stamps it fresh when the bridge later extracts the fence) — everything
  // beyond id/repo/pr_title is silently dropped by the round-trip, so warn
  // loudly rather than let an operator believe e.g. timeout_minutes: survived.
  const discarded = Object.keys(parsed.frontmatter).filter((k) => !CARRIED_KEYS.has(k));
  if (discarded.length > 0) {
    err(
      "junco submit --as-issue: warning — frontmatter is machine-owned on the issue route; " +
        `discarded: ${discarded.join(", ")}\n`,
    );
  }

  const body = parsed.body.trim();
  const title =
    (typeof parsed.frontmatter.pr_title === "string" && parsed.frontmatter.pr_title) ||
    firstHeading(body) ||
    parsed.id;
  const issueBody =
    `_Parked junco ticket — apply the \`${cfg.github.triggerLabel}\` label to queue it._\n\n` +
    wrapInFence("junco-ticket", body) +
    "\n\n<!-- junco:as-issue -->\n";

  let cfgBot: Config;
  try {
    cfgBot = await withBotAuthFn(cfg);
  } catch (e) {
    err(`junco submit --as-issue: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const url = await createIssueLive(cfgBot, watched.nwo, title, issueBody, [], ghFn);
  if (url === null) {
    err("junco submit --as-issue: gh issue create failed (see log)\n");
    return 1;
  }
  print(`parked as issue: ${url}\n`);
  print(`apply label '${cfg.github.triggerLabel}' to queue\n`);
  return 0;
}
