/**
 * Plan-set compiler (spec 2026-08-20, Layer 2) — the PURE half of turning an
 * approved `junco-plan` fence into child tickets. No filesystem, no network:
 * the doors (bridge / CLI) own trust and side effects. All validation is
 * fail-closed and errors are collected whole — nothing dispatches on any error.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

export interface PlanTask {
  id: string;
  title: string;
  dependsOn: string[];
  description: string;
  acceptance: string[];
  prohibitions: string[];
  verification: string | null;
}
export interface PlanSet {
  version: 1;
  sharedContext: string | null;
  tasks: PlanTask[];
}
export type PlanParse = { ok: true; plan: PlanSet } | { ok: false; errors: string[] };

/** sha256 of the fence body, first 12 hex — compile provenance (stamped into
 * child `plan.hash`), NOT an approval gate (the temporal check owns that). */
export function hashPlan(fenceBody: string): string {
  return createHash("sha256").update(fenceBody, "utf8").digest("hex").slice(0, 12);
}

const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Ids the queue resolver's suffix grammar would confuse with a retry/uniqueDest
 * suffix of ANOTHER ticket (ticketDeps.ts stemMatches: `-r<n>` / `-<n>`). */
const SUFFIX_COLLISION_RE = /^r?\d+$/;
// Mirrors ticket.ts FRONTMATTER_RE / githubInbox.ts SMUGGLED_FRONTMATTER_RE —
// a task description that tries to open a frontmatter block is refused, not
// silently stripped: the fence is model-authored, and stripping would hide the
// smuggle attempt from the human who approves the plan.
const SMUGGLED_FM_RE = /^---\s*$/m;

const strArr = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

export function parsePlanSet(fenceBody: string, opts: { maxTasks: number }): PlanParse {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(fenceBody);
  } catch (e) {
    return { ok: false, errors: [`invalid yaml: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["plan must be a yaml mapping"] };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1)
    errors.push(`unsupported version: ${JSON.stringify(doc.version)} (want 1)`);
  const sharedContext =
    typeof doc.shared_context === "string" && doc.shared_context.trim() !== ""
      ? doc.shared_context.trim()
      : null;
  if (sharedContext !== null && SMUGGLED_FM_RE.test(sharedContext)) {
    errors.push(
      "shared_context contains a frontmatter delimiter (---) — frontmatter is machine-owned",
    );
  }
  const tasksRaw = Array.isArray(doc.tasks) ? doc.tasks : null;
  if (tasksRaw === null || tasksRaw.length === 0) {
    errors.push("tasks must be a non-empty list");
    return { ok: false, errors };
  }
  if (tasksRaw.length > opts.maxTasks) {
    errors.push(`more than ${opts.maxTasks} tasks (${tasksRaw.length}) — planSets.maxTasks cap`);
  }

  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  tasksRaw.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      errors.push(`${at}: must be a mapping`);
      return;
    }
    const m = t as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id : "";
    if (!TASK_ID_RE.test(id)) {
      errors.push(`${at}: task id ${JSON.stringify(m.id)} must match ${TASK_ID_RE}`);
    } else if (SUFFIX_COLLISION_RE.test(id)) {
      errors.push(
        `${at}: task id ${JSON.stringify(id)} collides with the queue's retry/uniqueDest suffix grammar (r?\\d+) — pick a non-numeric id`,
      );
    } else if (seen.has(id)) {
      errors.push(`duplicate task id: ${JSON.stringify(id)}`);
    }
    if (id) seen.add(id);
    const title = typeof m.title === "string" && m.title.trim() !== "" ? m.title.trim() : null;
    if (title === null) errors.push(`${at}: missing/empty title`);
    const dependsOn = strArr(m.depends_on ?? []) ?? null;
    if (dependsOn === null) errors.push(`${at}: depends_on must be a list of task ids`);
    const description =
      typeof m.description === "string" && m.description.trim() !== ""
        ? m.description.trim()
        : null;
    if (description === null) errors.push(`${at}: missing/empty description`);
    const acceptance = strArr(m.acceptance) ?? [];
    if (acceptance.length === 0) errors.push(`${at}: missing/empty acceptance list`);
    const prohibitions = strArr(m.prohibitions ?? []) ?? [];
    const verification =
      typeof m.verification === "string" && m.verification.trim() !== ""
        ? m.verification.trim()
        : null;
    if (description !== null && SMUGGLED_FM_RE.test(description)) {
      errors.push(
        `${at}: description contains a frontmatter delimiter (---) — frontmatter is machine-owned`,
      );
    }
    tasks.push({
      id,
      title: title ?? "",
      dependsOn: dependsOn ?? [],
      description: description ?? "",
      acceptance,
      prohibitions,
      verification,
    });
  });

  // Edge validation over the collected ids (after the per-task loop so a
  // forward reference to a later task is legal).
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!seen.has(d))
        errors.push(`task ${JSON.stringify(t.id)}: unknown depends_on ${JSON.stringify(d)}`);
      if (d === t.id) errors.push(`task ${JSON.stringify(t.id)}: depends on itself`);
    }
  }
  // Cycle detection: Kahn's algorithm over the declared edges.
  if (errors.length === 0) {
    const indeg = new Map(tasks.map((t) => [t.id, 0]));
    for (const t of tasks)
      for (const d of t.dependsOn) indeg.set(t.id, (indeg.get(t.id) ?? 0) + (d ? 1 : 0));
    const q = tasks.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
    let visited = 0;
    while (q.length > 0) {
      const n = q.shift() as string;
      visited++;
      for (const t of tasks) {
        if (!t.dependsOn.includes(n)) continue;
        indeg.set(t.id, (indeg.get(t.id) ?? 0) - 1);
        if (indeg.get(t.id) === 0) q.push(t.id);
      }
    }
    if (visited !== tasks.length) errors.push("dependency cycle detected among tasks");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { version: 1, sharedContext, tasks } };
}
