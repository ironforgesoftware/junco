import type { PlanItemKind, UnwatchPlan } from "../unwatchCmd.js";

/** Deletion order (mirrors runUnwatch's own ordering) — the confirm body reads
 * as the sequence the CLI will actually walk, not as arrival order. */
const KIND_ORDER: PlanItemKind[] = [
  "clone",
  "inbox-ticket",
  "worktrees",
  "outbox-op",
  "assess-review",
  "comment-review",
  "assess-history",
  "mirror",
  "github-cache",
];

/** One chip per kind present. The count-less kinds are singular by nature
 * (one worktree namespace, one history file, one mirror) or read better
 * collapsed (the github cache is several files of one thing), so their label
 * ignores the item count; the rest carry it. */
const KIND_LABEL: Record<PlanItemKind, (n: number) => string> = {
  clone: () => "managed clone",
  "inbox-ticket": (n) => `${n} queued ticket(s)`,
  worktrees: () => "worktrees",
  "outbox-op": (n) => `${n} outbox op(s)`,
  "assess-review": (n) => `${n} pending assess batch(es)`,
  "comment-review": (n) => `${n} pending comment draft(s)`,
  "assess-history": () => "assess history",
  mirror: () => "mirror",
  "github-cache": () => "github cache",
};

/**
 * The confirm-modal body for `U` (unwatch): what the CLI will delete, what it
 * will leave alone, and the question. Itemized on purpose — this is the only
 * gate between a keystroke and a recursive delete, so the operator must see
 * the shape of the damage (a user-owned clone shows up under "keeps", never
 * under the deletions) before answering.
 */
export function summarizeUnwatchPlan(plan: UnwatchPlan): string {
  const counts = new Map<PlanItemKind, number>();
  for (const item of plan.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);

  const chips = KIND_ORDER.filter((k) => counts.has(k)).map((k) =>
    KIND_LABEL[k](counts.get(k) ?? 0),
  );
  const head =
    chips.length > 0
      ? `Will delete: ${chips.join(" · ")}`
      : "No junco-owned state to delete — just stop watching.";
  const keeps = plan.kept.length > 0 ? ` — keeps: ${plan.kept.join(", ")}` : "";
  return `${head}${keeps} Continue?`;
}
