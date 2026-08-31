/**
 * Pre-submit preflight — `junco lint` and (Task 3) `junco submit --dry-run`.
 *
 * The junco-dispatch skill's "Error handling" prose checks made deterministic
 * and CLI-owned (spec 2026-08-31-dispatch-hardening-design.md): repo path /
 * git-ness / GitHub origin / branch collision become lint-style violations,
 * merged with plan-lint's rules, so an authoring model runs ONE command
 * instead of executing a checklist in prose.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { parseTicket } from "./ticket.js";
import { lintTicket, formatViolations, type LintViolation } from "./planLint.js";
import { git } from "./git.js";
import { expandHome } from "./config.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { findWatchedForPath, CARRIED_KEYS, carriedTimeoutMinutes } from "./submitAsIssue.js";
import { canonPath } from "./unwatchCmd.js";
import { inboxPath } from "./dispatch.js";

export interface PreflightDeps {
  gitFn?: typeof git;
  printFn?: (s: string) => void;
  errFn?: (s: string) => void;
  existsFn?: (p: string) => boolean;
  fetchLabels?: (nwo: string) => Set<string>;
}

export interface EnvCheckResult {
  violations: LintViolation[];
  repoPath: string | null;
  repoNwo: string | null;
}

/** Same slug rule as dispatch.ts's submitTicket — the worker derives the
 * branch `junco/<slug(id)>`, so the collision check must match exactly. */
export function ticketSlug(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

const GIT_TIMEOUT_MS = 10_000;

export async function environmentChecks(
  cfg: Config,
  frontmatter: Record<string, unknown>,
  id: string,
  deps: PreflightDeps = {},
): Promise<EnvCheckResult> {
  const gitFn = deps.gitFn ?? git;
  const existsFn = deps.existsFn ?? existsSync;
  const v: LintViolation[] = [];
  const err = (rule: string, message: string): void => {
    v.push({ rule, severity: "error", message });
  };

  const repoRaw = frontmatter.repo;
  if (typeof repoRaw !== "string" || repoRaw === "") {
    err("repo_missing", "ticket has no repo: frontmatter path");
    return { violations: v, repoPath: null, repoNwo: null };
  }
  const repoPath = expandHome(repoRaw);
  if (!existsFn(repoPath)) {
    err("repo_path_missing", `repo: path does not exist: ${repoPath}`);
    return { violations: v, repoPath: null, repoNwo: null };
  }

  const gitDir = await gitFn(cfg, ["rev-parse", "--git-dir"], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
    check: false,
  });
  if (gitDir.code !== 0) {
    err("repo_not_git", `repo: path is not a git repository: ${repoPath}`);
    return { violations: v, repoPath, repoNwo: null };
  }

  const origin = await gitFn(cfg, ["remote", "get-url", "origin"], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
    check: false,
  });
  let repoNwo: string | null = null;
  if (origin.code !== 0 || origin.stdout.trim() === "") {
    err(
      "repo_no_origin",
      "repo has no origin remote — the worker needs one to push and open the PR",
    );
  } else {
    repoNwo = nwoFromRemoteUrl(origin.stdout.trim());
    if (repoNwo === null) {
      err(
        "repo_origin_not_github",
        `origin is not a GitHub remote (${origin.stdout.trim()}) — the worker opens PRs with gh`,
      );
    }
  }

  // Branch collision: the worker derives junco/<slug(id)> unless branch_name
  // overrides. A branch already on origin fails the run after the agent's
  // work is done — catch it before submit instead.
  const branch =
    typeof frontmatter.branch_name === "string" && frontmatter.branch_name !== ""
      ? frontmatter.branch_name
      : `junco/${ticketSlug(id)}`;
  const ls = await gitFn(cfg, ["ls-remote", "--heads", "origin", branch], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
    check: false,
  });
  if (ls.code !== 0) {
    v.push({
      rule: "branch_check_failed",
      severity: "warning",
      message: `could not check origin for branch ${branch} (git ls-remote failed); proceeding unvalidated`,
    });
  } else if (ls.stdout.trim() !== "") {
    err(
      "branch_exists",
      `branch ${branch} already exists on origin — bump the ticket id (or branch_name) so the worker's push does not collide`,
    );
  }

  return { violations: v, repoPath, repoNwo };
}

/** `junco lint <file>`: plan-lint + environment checks, no submit. Exit 0 when
 * error-free (warnings allowed), 1 on any error-severity violation. */
export async function runLint(
  cfg: Config,
  fileArg: string,
  content: string,
  deps: PreflightDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const parsed = parseTicket(fileArg, content, cfg.defaultTimeoutMinutes);

  const env = await environmentChecks(cfg, parsed.frontmatter, parsed.id, deps);
  const lint = lintTicket(parsed.body, parsed.frontmatter, {
    repoNwo: env.repoNwo,
    repoPath: env.repoPath,
    checkLabels: true,
    ghBin: cfg.ghBin,
    fetchLabels: deps.fetchLabels,
  });

  const violations = [...env.violations, ...lint.violations];
  if (violations.length > 0) print(formatViolations(violations) + "\n");
  const errors = violations.filter((x) => x.severity === "error").length;
  const warnings = violations.filter((x) => x.severity === "warning").length;
  if (errors === 0 && warnings === 0) {
    print("lint: ok\n");
  } else {
    const parts: string[] = [];
    if (errors > 0) parts.push(`${errors} error(s)`);
    if (warnings > 0) parts.push(`${warnings} warning(s)`);
    print(`lint: ${parts.join(", ")}\n`);
  }
  return errors > 0 ? 1 : 0;
}

export interface RouteDecision {
  destination: "issue" | "inbox";
  reasons: string[];
  watchedNwo: string | null;
  carriedTimeout: number | null;
  discarded: string[];
}

/** Deterministic mirror of the junco-dispatch skill's destination rules:
 * shape exclusions first (the issue route carries only id/repo/pr_title plus
 * the bounded timeout marker), then the three probe legs. Every inbox verdict
 * carries at least one reason line the skill can echo verbatim. */
export async function decideRoute(
  cfg: Config,
  frontmatter: Record<string, unknown>,
  deps: PreflightDeps = {},
): Promise<RouteDecision> {
  const gitFn = deps.gitFn ?? git;
  const reasons: string[] = [];
  const carriedTimeout = carriedTimeoutMinutes(frontmatter);
  const discarded = Object.keys(frontmatter).filter(
    (k) => !CARRIED_KEYS.has(k) && !(k === "timeout_minutes" && carriedTimeout !== null),
  );
  const inbox = (why: string): RouteDecision => {
    reasons.push(why);
    return { destination: "inbox", reasons, watchedNwo: null, carriedTimeout, discarded };
  };

  if (frontmatter.amends_pr !== undefined && frontmatter.amends_pr !== null)
    return inbox(
      "amends_pr tickets always use the inbox (the issue route is for plain fresh tickets)",
    );
  const dep = frontmatter.depends_on;
  if (Array.isArray(dep) ? dep.length > 0 : dep !== undefined && dep !== null)
    return inbox("depends_on ticket sets always use the inbox");
  if (typeof frontmatter.branch_name === "string" && frontmatter.branch_name !== "")
    return inbox("a custom branch_name does not survive the issue route");
  if (frontmatter.tools !== undefined && frontmatter.tools !== null)
    return inbox("a per-ticket tools: override does not survive the issue route");
  if (frontmatter.workdir !== undefined && frontmatter.workdir !== null)
    return inbox("a workdir: override does not survive the issue route");

  const repoRaw = frontmatter.repo;
  const repoPath = typeof repoRaw === "string" && repoRaw !== "" ? expandHome(repoRaw) : null;

  if (typeof frontmatter.base_branch === "string" && frontmatter.base_branch !== "" && repoPath) {
    const head = await gitFn(cfg, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      check: false,
    });
    const def = head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : null;
    if (def === null)
      return inbox("base_branch is set and the origin default branch could not be resolved");
    if (def !== frontmatter.base_branch)
      return inbox(`base_branch ${frontmatter.base_branch} differs from the origin default ${def}`);
  }

  if (!cfg.github.enabled) return inbox("github.enabled is off");
  if (!cfg.botAccount.enabled)
    return inbox("botAccount.enabled is off (the bot authors the parked issue)");
  if (!repoPath) return inbox("ticket has no repo: path to match against the watchlist");
  const watched = await findWatchedForPath(cfg, canonPath(repoPath), gitFn);
  if (!watched)
    return inbox("repo is not bridge-watched (neither a watched clone path nor an origin match)");

  reasons.push(`repo ${watched.nwo} is bridge-watched; github + bot account enabled`);
  return { destination: "issue", reasons, watchedNwo: watched.nwo, carriedTimeout, discarded };
}

/** `junco submit --dry-run <file>`: routing verdict + full lint, no submit.
 * Output lines are a stable contract the junco-dispatch skill echoes verbatim. */
export async function runSubmitDryRun(
  cfg: Config,
  fileArg: string,
  content: string,
  deps: PreflightDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const existsFn = deps.existsFn ?? existsSync;
  const parsed = parseTicket(fileArg, content, cfg.defaultTimeoutMinutes);

  const route = await decideRoute(cfg, parsed.frontmatter, deps);
  print(`destination: ${route.destination}\n`);
  for (const r of route.reasons) print(`reason: ${r}\n`);
  if (route.destination === "issue") {
    print(`watched: ${route.watchedNwo}\n`);
    if (route.carriedTimeout !== null) print(`carried: timeout_minutes=${route.carriedTimeout}\n`);
    if (route.discarded.length > 0) print(`would discard: ${route.discarded.join(", ")}\n`);
    const t = route.carriedTimeout ?? cfg.defaultTimeoutMinutes;
    print(
      `timeout: ${t} minutes (${route.carriedTimeout !== null ? "carried" : "worker default"})\n`,
    );
  } else {
    const dest = join(inboxPath(cfg), `${ticketSlug(parsed.id)}.md`);
    print(`would submit: ${dest}\n`);
    if (existsFn(dest)) print(`warning: ticket already queued at ${dest}\n`);
    print(
      `timeout: ${Math.round(parsed.timeoutSeconds / 60)} minutes (frontmatter or worker default)\n`,
    );
  }

  const env = await environmentChecks(cfg, parsed.frontmatter, parsed.id, deps);
  const lint = lintTicket(parsed.body, parsed.frontmatter, {
    repoNwo: env.repoNwo,
    repoPath: env.repoPath,
    checkLabels: true,
    ghBin: cfg.ghBin,
    fetchLabels: deps.fetchLabels,
  });
  const violations = [...env.violations, ...lint.violations];
  if (violations.length > 0) print(formatViolations(violations) + "\n");
  const errors = violations.filter((x) => x.severity === "error").length;
  const warnings = violations.filter((x) => x.severity === "warning").length;
  print(
    errors === 0 && warnings === 0
      ? "lint: ok\n"
      : `lint: ${[errors > 0 ? `${errors} error(s)` : null, warnings > 0 ? `${warnings} warning(s)` : null].filter(Boolean).join(", ")}\n`,
  );
  print("dry run — nothing submitted\n");
  return errors > 0 ? 1 : 0;
}
