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

// compilePlan concatenates every free-text field (title, description, each
// acceptance/prohibitions entry, verification, shared_context) into ONE
// markdown body that src/verify.ts re-parses with two regexes that know
// nothing about YAML field boundaries: extractVerificationBlocks finds the
// FIRST `^## Verification` heading anywhere in the compiled body, then runs
// every ```bash fenced block up to the NEXT `^##\s` heading (or end of
// body). `description` lands near the top of the body — well before the
// compiler's own `## Verification` section — so a `description` that
// smuggles its own `## Verification` heading plus a ```bash fence becomes
// the block junco executes, and the real `verification:` block never runs
// (spec review CRITICAL C2: proven against this code — `blocks =
// ["echo PWNED"]` where `["npm test"]` was expected). The same applies to
// title/acceptance/prohibitions/shared_context: every one of them is
// emitted before or interleaved with the real `## Verification` section.
//
// Refuse a code fence (```) AND a `## ` heading in every free-text field,
// independently of each other, so neither check has to rely on the other or
// on today's field ordering in compilePlan to hold as a security boundary.
// We refuse EVERY `^##\s` heading — not only `^##\s+Verification` — for two
// reasons: (1) it keeps working if compilePlan's body order or heading text
// ever changes, instead of re-deriving a matching allowlist each time, and
// (2) it stops a field from spoofing any of the OTHER compiler-built
// sections (## Behavior, ## Prohibitions, ## Shared context) in front of
// the human approving the plan, not just ## Verification. A heading can
// also corrupt verify.ts's OWN section even without a paired fence: its
// end-of-section boundary is "next `^##\s`", not "next `## Verification`",
// so a heading smuggled inside `verification` itself truncates the real
// section and silently drops the block instead of running it.
const SMUGGLED_HEADING_RE = /^##\s/m;

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
  if (sharedContext !== null && sharedContext.includes("```")) {
    errors.push(
      "shared_context contains a code fence (```) — bash fences may only appear in the compiler-built ## Verification section",
    );
  }
  if (sharedContext !== null && SMUGGLED_HEADING_RE.test(sharedContext)) {
    errors.push(
      "shared_context contains a markdown heading (##) — headings may only appear in the compiler-built body sections — use ### or deeper for a subheading",
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
    if (title !== null && SMUGGLED_FM_RE.test(title)) {
      errors.push(
        `${at}: title contains a frontmatter delimiter (---) — frontmatter is machine-owned`,
      );
    }
    if (title !== null && title.includes("```")) {
      errors.push(
        `${at}: title contains a code fence (\`\`\`) — bash fences may only appear in the compiler-built ## Verification section`,
      );
    }
    if (title !== null && SMUGGLED_HEADING_RE.test(title)) {
      errors.push(
        `${at}: title contains a markdown heading (##) — headings may only appear in the compiler-built body sections — use ### or deeper for a subheading`,
      );
    }
    const dependsOn = strArr(m.depends_on ?? []) ?? null;
    if (dependsOn === null) errors.push(`${at}: depends_on must be a list of task ids`);
    const description =
      typeof m.description === "string" && m.description.trim() !== ""
        ? m.description.trim()
        : null;
    if (description === null) errors.push(`${at}: missing/empty description`);
    if (description !== null && SMUGGLED_FM_RE.test(description)) {
      errors.push(
        `${at}: description contains a frontmatter delimiter (---) — frontmatter is machine-owned`,
      );
    }
    if (description !== null && description.includes("```")) {
      errors.push(
        `${at}: description contains a code fence (\`\`\`) — bash fences may only appear in the compiler-built ## Verification section`,
      );
    }
    if (description !== null && SMUGGLED_HEADING_RE.test(description)) {
      errors.push(
        `${at}: description contains a markdown heading (##) — headings may only appear in the compiler-built body sections — use ### or deeper for a subheading`,
      );
    }
    const acceptance = strArr(m.acceptance) ?? [];
    if (acceptance.length === 0) errors.push(`${at}: missing/empty acceptance list`);
    if (acceptance.some((a) => SMUGGLED_FM_RE.test(a))) {
      errors.push(
        `${at}: acceptance contains a frontmatter delimiter (---) — frontmatter is machine-owned`,
      );
    }
    if (acceptance.some((a) => a.includes("```"))) {
      errors.push(
        `${at}: acceptance contains a code fence (\`\`\`) — bash fences may only appear in the compiler-built ## Verification section`,
      );
    }
    if (acceptance.some((a) => SMUGGLED_HEADING_RE.test(a))) {
      errors.push(
        `${at}: acceptance contains a markdown heading (##) — headings may only appear in the compiler-built body sections — use ### or deeper for a subheading`,
      );
    }
    const prohibitions = strArr(m.prohibitions ?? []) ?? [];
    if (prohibitions.some((p) => SMUGGLED_FM_RE.test(p))) {
      errors.push(
        `${at}: prohibitions contains a frontmatter delimiter (---) — frontmatter is machine-owned`,
      );
    }
    if (prohibitions.some((p) => p.includes("```"))) {
      errors.push(
        `${at}: prohibitions contains a code fence (\`\`\`) — bash fences may only appear in the compiler-built ## Verification section`,
      );
    }
    if (prohibitions.some((p) => SMUGGLED_HEADING_RE.test(p))) {
      errors.push(
        `${at}: prohibitions contains a markdown heading (##) — headings may only appear in the compiler-built body sections — use ### or deeper for a subheading`,
      );
    }
    const verification =
      typeof m.verification === "string" && m.verification.trim() !== ""
        ? m.verification.trim()
        : null;
    if (verification !== null && SMUGGLED_FM_RE.test(verification)) {
      errors.push(
        `${at}: verification contains a frontmatter delimiter (---) — frontmatter is machine-owned`,
      );
    }
    // `verification` is emitted RAW between literal ```bash fences in
    // compilePlan, so a triple backtick inside it closes the fence early: the
    // remainder lands in the child body as prose, and verify.ts's global
    // ```bash matcher will execute a second block if the smuggled text opens
    // one. Refuse rather than escape — the fence is model-authored and the
    // human approving the plan should see the attempt (#298).
    if (verification !== null && verification.includes("```")) {
      errors.push(
        `${at}: verification contains a code fence (\`\`\`) — it is emitted inside a bash fence and would escape it`,
      );
    }
    // A heading inside verification's OWN content can't hijack a section
    // upstream of it (the real ## Verification heading is always first in
    // the compiled body), but it CAN truncate the compiler's own section:
    // extractVerificationBlocks's end-of-section boundary is "next
    // `^##\s`", not "next `## Verification`" — so a heading smuggled here
    // silently drops the real block (and anything emitted after it) instead
    // of running it.
    if (verification !== null && SMUGGLED_HEADING_RE.test(verification)) {
      errors.push(
        `${at}: verification contains a markdown heading (##) — headings may only appear in the compiler-built body sections — use ### or deeper for a subheading`,
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

export interface CompileCtx {
  planId: string;
  repoPath: string;
  hash: string;
  github: { nwo: string; issue: number } | null;
}
export interface CompiledChild {
  taskId: string;
  ticketId: string;
  dependsOn: string[];
  content: string;
}

/** Deterministic fan-out of a validated plan. Frontmatter is DOOR-built here
 * (never model text — parsePlanSet refused smuggled blocks); the body follows
 * the junco-dispatch TEMPLATE section conventions so planLint, the critic
 * (whole-body spec), and verify.ts (## Verification bash blocks) consume it
 * with zero runtime changes (spec Layer 3). */
export function compilePlan(plan: PlanSet, ctx: CompileCtx): CompiledChild[] {
  return plan.tasks.map((task) => {
    const ticketId = `${ctx.planId}-${task.id}`;
    const dependsOn = task.dependsOn.map((d) => `${ctx.planId}-${d}`);
    const fm: string[] = ["---", `id: ${ticketId}`, `repo: ${JSON.stringify(ctx.repoPath)}`];
    if (ctx.github) {
      fm.push(
        "github:",
        `  nwo: ${JSON.stringify(ctx.github.nwo)}`,
        `  issue: ${ctx.github.issue}`,
        "  kind: pr",
      );
    }
    fm.push(
      "plan:",
      `  id: ${JSON.stringify(ctx.planId)}`,
      `  task: ${JSON.stringify(task.id)}`,
      `  hash: ${JSON.stringify(ctx.hash)}`,
    );
    if (dependsOn.length > 0) fm.push(`depends_on: [${dependsOn.join(", ")}]`);
    fm.push("---");

    const body: string[] = [`# ${task.title}`, "", task.description, ""];
    body.push("## Behavior (acceptance — testable assertions)", "");
    for (const a of task.acceptance) body.push(`- ${a}`);
    body.push("");
    if (task.prohibitions.length > 0) {
      body.push("## Prohibitions", "");
      for (const p of task.prohibitions) body.push(`- ${p}`);
      body.push("");
    }
    if (plan.sharedContext || dependsOn.length > 0) {
      body.push("## Shared context", "");
      if (plan.sharedContext) body.push(plan.sharedContext, "");
      if (dependsOn.length > 0) {
        body.push(
          `This task is part of plan \`${ctx.planId}\`. Its prerequisite tickets — already merged into the base branch by the time this runs — are: ${dependsOn.map((d) => `\`${d}\``).join(", ")}.`,
          "",
        );
      }
    }
    if (task.verification) {
      body.push(
        "## Verification (junco runs this — do NOT run it yourself)",
        "",
        "```bash",
        task.verification,
        "```",
        "",
      );
    }
    return {
      taskId: task.id,
      ticketId,
      dependsOn,
      content: fm.join("\n") + "\n\n" + body.join("\n").trimEnd() + "\n",
    };
  });
}
