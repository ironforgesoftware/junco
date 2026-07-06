/**
 * GitHub → inbox bridge (dispatch side of GitHub-integrated mode).
 *
 * Design: docs/superpowers/specs/2026-07-02-github-inbox-design.md.
 * Issues are SNAPSHOTS: the labeled body is copied once into an ordinary
 * ticket via submitTicket; the existing queue machinery runs unchanged from
 * there. Lifecycle labels on GitHub mirror local state — local done//failed/
 * plus the PR are the source of truth.
 */

import type { Config, GithubRepoMapping } from "./types.js";
import { gh, git } from "./git.js";
import { submitTicket } from "./dispatch.js";
import { log } from "./logging.js";

/** Shape of `gh issue list --json number,title,body,labels`. */
export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}

export interface LifecycleLabels {
  queued: string;
  working: string;
  done: string;
  failed: string;
  denied: string;
  planning: string;
  planReady: string;
  approved: string;
}

/** Lifecycle label names derive from the trigger label. */
export function lifecycleLabels(trigger: string): LifecycleLabels {
  return {
    queued: `${trigger}:queued`,
    working: `${trigger}:working`,
    done: `${trigger}:done`,
    failed: `${trigger}:failed`,
    denied: `${trigger}:denied`,
    planning: `${trigger}:planning`,
    planReady: `${trigger}:plan-ready`,
    approved: `${trigger}:approved`,
  };
}

/** Eligible = trigger label present AND no lifecycle label. Re-dispatch = the
 * operator removes the lifecycle label and leaves the trigger on. */
export function isEligible(issue: GhIssue, trigger: string): boolean {
  const names = new Set(issue.labels.map((l) => l.name));
  if (!names.has(trigger)) return false;
  const ll = lifecycleLabels(trigger);
  return ![ll.queued, ll.working, ll.done, ll.failed, ll.denied, ll.planning, ll.planReady].some(
    (n) => names.has(n),
  );
}

/** Parse owner/repo out of a github.com remote URL (https or ssh). Null when
 * the URL is not a github remote — the origin cross-check fails closed on it. */
export function nwoFromRemoteUrl(url: string): string | null {
  const u = url.trim();
  const m =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Convert an eligible issue into a Junco ticket file (id + full content).
 * JSON.stringify produces valid YAML double-quoted scalars — titles and paths
 * with quotes/colons round-trip through parseTicket. */
export function issueToTicket(
  issue: GhIssue,
  repo: GithubRepoMapping,
  cfg: Config,
  parent: { title: string; body: string | null } | null,
): { id: string; content: string } {
  const [owner, name] = repo.nwo.split("/");
  const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const id = `gh-${slug(owner)}-${slug(name)}-${issue.number}`;
  const kind = issue.labels.some((l) => l.name === cfg.github.askLabel) ? "ask" : "pr";

  const fm: string[] = ["---", `id: ${id}`];
  if (kind === "pr") {
    fm.push(`repo: ${JSON.stringify(repo.path)}`);
    fm.push(`pr_title: ${JSON.stringify(issue.title)}`);
  } else {
    fm.push(`workdir: ${JSON.stringify(repo.path)}`);
  }
  fm.push(
    "github:",
    `  nwo: ${JSON.stringify(repo.nwo)}`,
    `  issue: ${issue.number}`,
    `  kind: ${kind}`,
    "---",
  );

  const parts: string[] = [`# ${issue.title}`];
  const body = (issue.body ?? "").trim();
  if (body) parts.push(body);
  if (parent) {
    const pBody = (parent.body ?? "").trim();
    parts.push(
      "## Context: parent issue\n\n" +
        "_Background only — the instruction is the body above._\n\n" +
        `**${parent.title}**` +
        (pBody ? `\n\n${pBody}` : ""),
    );
  }
  return { id, content: fm.join("\n") + "\n\n" + parts.join("\n\n") + "\n" };
}

// ---------------------------------------------------------------------------
// Sweep — poll watched repos, verify, materialize tickets, mark queued.
// ---------------------------------------------------------------------------

export interface BridgeState {
  /** nwo set whose lifecycle labels were ensured this process. */
  labelsEnsured: Set<string>;
  /** nwo → origin-check verdict (a mismatch disables the repo this process). */
  originOk: Map<string, boolean>;
}

export function newBridgeState(): BridgeState {
  return { labelsEnsured: new Set(), originOk: new Map() };
}

export interface BridgeDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  submitFn?: (cfg: Config, content: string, opts?: { idHint?: string }) => string;
}

const GH_TIMEOUT = 60_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const LABEL_SPECS: ReadonlyArray<[keyof LifecycleLabels, string, string]> = [
  ["queued", "FBCA04", "junco: queued for the worker"],
  ["working", "1D76DB", "junco: worker is on it"],
  ["done", "0E8A16", "junco: finished — see the closing comment"],
  ["failed", "B60205", "junco: failed — see the closing comment"],
  ["denied", "5319E7", "junco: trigger label applied without write permission"],
  ["planning", "C5DEF5", "junco: authoring a plan from this issue"],
  ["planReady", "D4A72C", "junco: plan posted — review the plan comment"],
  ["approved", "54AEFF", "apply AFTER reviewing the plan comment to authorize execution"],
];

async function originOkFor(
  cfg: Config,
  repo: GithubRepoMapping,
  state: BridgeState,
  gitFn: typeof git,
): Promise<boolean> {
  const cached = state.originOk.get(repo.nwo);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const r = await gitFn(cfg, ["-C", repo.path, "remote", "get-url", "origin"], { check: false });
    const actual = r.code === 0 ? nwoFromRemoteUrl(r.stdout.trim()) : null;
    ok = actual !== null && actual.toLowerCase() === repo.nwo.toLowerCase();
    if (!ok) {
      log.error("github bridge: mapped path origin does not match nwo; repo disabled this run", {
        nwo: repo.nwo,
        path: repo.path,
        actual,
      });
    }
  } catch (e) {
    log.error("github bridge: origin check failed; repo disabled this run", {
      nwo: repo.nwo,
      error: errMsg(e),
    });
  }
  state.originOk.set(repo.nwo, ok);
  return ok;
}

async function ensureLabels(
  cfg: Config,
  nwo: string,
  state: BridgeState,
  ghFn: typeof gh,
): Promise<void> {
  if (state.labelsEnsured.has(nwo)) return;
  const ll = lifecycleLabels(cfg.github.triggerLabel);
  for (const [key, color, description] of LABEL_SPECS) {
    // --force = create-or-update, idempotent.
    await ghFn(
      cfg,
      [
        "label",
        "create",
        ll[key],
        "--repo",
        nwo,
        "--color",
        color,
        "--description",
        description,
        "--force",
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
  }
  state.labelsEnsured.add(nwo);
}

/** Who last applied the trigger label, and may they dispatch? Fail-closed:
 * any verification error → "unverified" (skip this sweep, retry next). */
async function verifyLabeler(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  ghFn: typeof gh,
): Promise<"ok" | "denied" | "unverified"> {
  try {
    const ev = await ghFn(
      cfg,
      [
        "api",
        "--paginate",
        `repos/${nwo}/issues/${issueNumber}/events`,
        "--jq",
        '.[] | select(.event == "labeled") | {actor: .actor.login, label: .label.name}',
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const events = ev.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { actor: string; label: string });
    const last = [...events].reverse().find((l) => l.label === cfg.github.triggerLabel);
    if (!last) return "unverified";
    const perm = await ghFn(
      cfg,
      ["api", `repos/${nwo}/collaborators/${last.actor}/permission`, "--jq", ".permission"],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const p = perm.stdout.trim();
    // The legacy permission field maps maintain→write, so admin|write covers it.
    return p === "admin" || p === "write" ? "ok" : "denied";
  } catch (e) {
    log.warn("github bridge: labeler verification failed; skipping issue this sweep", {
      nwo,
      issue: issueNumber,
      error: errMsg(e),
    });
    return "unverified";
  }
}

/** Sub-issue parent lookup (GraphQL `parent` field). Non-fatal: null on any error. */
async function fetchParent(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  ghFn: typeof gh,
): Promise<{ title: string; body: string | null } | null> {
  const [owner, name] = nwo.split("/");
  try {
    const r = await ghFn(
      cfg,
      [
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{title body}}}}",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${issueNumber}`,
        "--jq",
        ".data.repository.issue.parent",
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const out = r.stdout.trim();
    if (!out || out === "null") return null;
    const p = JSON.parse(out) as { title?: unknown; body?: unknown };
    return typeof p.title === "string"
      ? { title: p.title, body: typeof p.body === "string" ? p.body : null }
      : null;
  } catch {
    return null; // background context only — never blocks dispatch
  }
}

/**
 * One bridge sweep across all configured repos. Failures are contained at the
 * repo and issue level — the queue never depends on GitHub being up. Ordering
 * per issue: submit BEFORE label, so a crash between the two self-heals (the
 * next sweep re-submits, hits the duplicate guard, and re-applies the label).
 */
export async function pollGithubInbox(
  cfg: Config,
  state: BridgeState,
  deps: BridgeDeps = {},
): Promise<number> {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const submitFn = deps.submitFn ?? submitTicket;
  const trigger = cfg.github.triggerLabel;
  const ll = lifecycleLabels(trigger);
  let bridged = 0;

  for (const repo of cfg.github.repos) {
    try {
      if (!(await originOkFor(cfg, repo, state, gitFn))) continue;
      await ensureLabels(cfg, repo.nwo, state, ghFn);
      const list = await ghFn(
        cfg,
        [
          "issue",
          "list",
          "--repo",
          repo.nwo,
          "--label",
          trigger,
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          "number,title,body,labels",
        ],
        { timeoutMs: GH_TIMEOUT, retryNetwork: true },
      );
      const issues = (JSON.parse(list.stdout) as GhIssue[]).filter((i) => isEligible(i, trigger));

      for (const issue of issues) {
        try {
          const verdict = await verifyLabeler(cfg, repo.nwo, issue.number, ghFn);
          if (verdict === "unverified") continue; // fail-closed; retry next sweep
          if (verdict === "denied") {
            await ghFn(
              cfg,
              ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", ll.denied],
              { timeoutMs: GH_TIMEOUT, retryNetwork: true },
            );
            log.warn("github bridge: trigger label applied without write permission", {
              nwo: repo.nwo,
              issue: issue.number,
            });
            continue;
          }
          const parent = await fetchParent(cfg, repo.nwo, issue.number, ghFn);
          const t = issueToTicket(issue, repo, cfg, parent);
          try {
            submitFn(cfg, t.content, { idHint: t.id });
          } catch (e) {
            if (!errMsg(e).includes("already queued")) throw e;
            log.info("github bridge: ticket already queued; re-marking", { id: t.id });
          }
          await ghFn(
            cfg,
            ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", ll.queued],
            { timeoutMs: GH_TIMEOUT, retryNetwork: true },
          );
          bridged++;
          log.info("github bridge: dispatched issue", {
            nwo: repo.nwo,
            issue: issue.number,
            id: t.id,
          });
        } catch (e) {
          log.warn("github bridge: issue skipped", {
            nwo: repo.nwo,
            issue: issue.number,
            error: errMsg(e),
          });
        }
      }
    } catch (e) {
      log.warn("github bridge: repo sweep failed; queue unaffected", {
        nwo: repo.nwo,
        error: errMsg(e),
      });
    }
  }
  return bridged;
}
