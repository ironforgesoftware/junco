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
  /** Issue opener's login. Pre-field cache entries (written before this field
   * existed) deserialize with the key ABSENT — `undefined` at runtime, not
   * `null`, despite the type below. `isBotAuthored` accepts `undefined` too
   * and treats it the same as `null`: non-bot. */
  author: string | null;
}

/** True when a list row was opened by the configured bot account. */
export function isBotAuthored(
  author: string | null | undefined,
  botLogin: string | null | undefined,
): boolean {
  return typeof author === "string" && author !== "" && author === botLogin;
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

/** Longest lifecycle badge — the pill column's shared inner width. */
export const MAX_STATE_BADGE_LEN = Math.max(...Object.values(META).map((m) => m.badge.length));

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

/** The label names a delta is computed against: the configured trigger label
 * and the ask label (`cfg.github.triggerLabel` / `cfg.github.askLabel`); every
 * lifecycle label derives from the trigger via `lifecycleLabels`. */
export interface LabelNames {
  trigger: string;
  askLabel: string;
}

/** What one `DashAction` does to an issue's labels. */
export interface LabelDelta {
  add: string[];
  remove: string[];
}

/**
 * THE DashAction → label-transition table (#443) — the single source of truth
 * for both consumers: `ghClient.ts`'s `labelsOpFor` (the `gh`/outbox op) and
 * `App.tsx`'s `optimisticLabels` (the local, immediate UI update). It used to
 * be two exhaustive switches that had to be kept identical by hand; adding an
 * action was compile-safe, but *changing* one action's labels in one of them
 * let the dashboard show one thing and GitHub receive another, silently.
 *
 * `null` is the recycle zero-op short-circuit: nothing to remove. Callers must
 * honor it BEFORE calling `tryOrEnqueue` — a no-op recycle must neither call
 * gh (a flag-less `gh issue edit` exits 1) nor queue an outbox op.
 *
 * Lives in this pure module rather than in `ghClient.ts` (where #443 first
 * proposed it) so `App.tsx` can reach it: every `src/tui` import of
 * `ghClient.ts` is type-only by construction, and a value import would pull
 * the whole GitHub/CLI graph (analyzeCmd, healthServer, …) into the render
 * layer and its tests.
 */
export function labelDelta(
  action: DashAction,
  labels: string[],
  names: LabelNames,
): LabelDelta | null {
  const ll = lifecycleLabels(names.trigger);
  const has = (l: string): boolean => labels.includes(l);
  switch (action) {
    case "dispatch":
      return { add: [names.trigger], remove: [] };
    case "dispatchAsk":
      return { add: [names.trigger, names.askLabel], remove: [] };
    case "approve":
      return { add: [ll.approved], remove: [] };
    case "replan": {
      const remove = [ll.planReady];
      if (has(ll.approved)) remove.push(ll.approved);
      return { add: [], remove };
    }
    case "recycle": {
      const terminal = [ll.done, ll.failed, ll.denied].filter(has);
      if (terminal.length === 0) return null; // stale labels — clean no-op
      return { add: [], remove: terminal };
    }
  }
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
