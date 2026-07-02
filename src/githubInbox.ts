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
}

/** Lifecycle label names derive from the trigger label. */
export function lifecycleLabels(trigger: string): LifecycleLabels {
  return {
    queued: `${trigger}:queued`,
    working: `${trigger}:working`,
    done: `${trigger}:done`,
    failed: `${trigger}:failed`,
    denied: `${trigger}:denied`,
  };
}

/** Eligible = trigger label present AND no lifecycle label. Re-dispatch = the
 * operator removes the lifecycle label and leaves the trigger on. */
export function isEligible(issue: GhIssue, trigger: string): boolean {
  const names = new Set(issue.labels.map((l) => l.name));
  if (!names.has(trigger)) return false;
  const ll = lifecycleLabels(trigger);
  return ![ll.queued, ll.working, ll.done, ll.failed, ll.denied].some((n) => names.has(n));
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
