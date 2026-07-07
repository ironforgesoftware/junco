/**
 * Pure lifecycle derivation for the dashboard. An issue's state is a function
 * of its labels ONLY — the dashboard holds no queue state. Precedence mirrors
 * the bridge: terminal states shadow stale earlier labels; `approved` is a
 * distinct state only on top of plan-ready (pre-approval is inert by design).
 */

import { lifecycleLabels } from "../githubInbox.js";

export type IssueLifecycle =
  | "raw"
  | "planning"
  | "plan-ready"
  | "approved"
  | "queued"
  | "working"
  | "done"
  | "failed"
  | "denied";

export interface DashIssue {
  number: number;
  title: string;
  labels: string[];
  updatedAt: string;
  url: string;
}

export type DashAction = "dispatch" | "dispatchAsk" | "approve" | "replan" | "recycle";

export function deriveState(labels: string[], trigger: string): IssueLifecycle {
  const ll = lifecycleLabels(trigger);
  const has = (l: string): boolean => labels.includes(l);
  if (has(ll.denied)) return "denied";
  if (has(ll.failed)) return "failed";
  if (has(ll.done)) return "done";
  if (has(ll.working)) return "working";
  if (has(ll.queued)) return "queued";
  if (has(ll.planReady)) return has(ll.approved) ? "approved" : "plan-ready";
  if (has(ll.planning)) return "planning";
  return "raw";
}

const META: Record<IssueLifecycle, { glyph: string; color: string; badge: string }> = {
  raw: { glyph: "○", color: "gray", badge: "—" },
  planning: { glyph: "◔", color: "cyan", badge: "planning" },
  "plan-ready": { glyph: "●", color: "yellow", badge: "plan-ready" },
  approved: { glyph: "●", color: "blue", badge: "approved" },
  queued: { glyph: "◑", color: "cyan", badge: "queued" },
  working: { glyph: "◐", color: "cyan", badge: "working" },
  done: { glyph: "✓", color: "green", badge: "done" },
  failed: { glyph: "✗", color: "red", badge: "failed" },
  denied: { glyph: "⊘", color: "magenta", badge: "denied" },
};

export function stateMeta(s: IssueLifecycle): { glyph: string; color: string; badge: string } {
  return META[s];
}

const ACTIONS: Record<IssueLifecycle, DashAction[]> = {
  raw: ["dispatch", "dispatchAsk"],
  planning: [],
  "plan-ready": ["approve", "replan"],
  approved: ["replan"],
  queued: [],
  working: [],
  done: ["recycle"],
  failed: ["recycle"],
  denied: ["recycle"],
};

export function allowedActions(s: IssueLifecycle): DashAction[] {
  return ACTIONS[s];
}

// Sort groups: needs-review (plan-ready/approved) → raw → in-flight → terminal.
const GROUP: Record<IssueLifecycle, number> = {
  "plan-ready": 0,
  approved: 0,
  raw: 1,
  planning: 2,
  queued: 2,
  working: 2,
  done: 3,
  failed: 3,
  denied: 3,
};

export function sortIssues(issues: DashIssue[], trigger: string): DashIssue[] {
  return [...issues].sort((a, b) => {
    const ga = GROUP[deriveState(a.labels, trigger)];
    const gb = GROUP[deriveState(b.labels, trigger)];
    if (ga !== gb) return ga - gb;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });
}

/** Live `/` filter: case-insensitive substring across #number, title, and the
 * lifecycle badge. Blank query returns the input array identity (cheap no-op). */
export function filterIssues(issues: DashIssue[], q: string, trigger: string): DashIssue[] {
  const s = q.trim().toLowerCase();
  if (s === "") return issues;
  return issues.filter((i) => {
    const badge = stateMeta(deriveState(i.labels, trigger)).badge;
    return `#${i.number}`.includes(s) || i.title.toLowerCase().includes(s) || badge.includes(s);
  });
}
