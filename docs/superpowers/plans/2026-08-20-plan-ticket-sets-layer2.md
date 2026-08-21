# Plan-Driven Ticket Sets — Layer 2 (Plan Compiler + Doors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An approved plan can decompose into a dependency-ordered ticket set: the planner may emit a multi-task `junco-plan` fence, a deterministic fail-closed compiler fans it out into child tickets with `depends_on` edges, the bridge maintains a set dashboard/labels on the issue (including supersede on re-approval), and `junco submit --plan` gives local dispatchers the same compiler.

**Architecture:** Two new modules carry the weight: `src/planCompiler.ts` (pure — fence parsing, fail-closed validation, child emission, hashing; no I/O) and `src/planSets.ts` (the set store under the data tree: plan materialization, JSON records, queue-state resolution, fan-out, dashboard rendering, supersede disposition). `src/planSetBridge.ts` wires both into the GitHub bridge: a dispatch door in the plan-ready branch and a sweep-driven `maintainPlanSets` pass that recomputes set state from the queue — sweep-driven because cascaded children never produce reporter events, so event-driven dashboards would go stale. The reporter suppresses per-child issue traffic for set children; the sweep owns all set-level reporting.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, `yaml` (fence parsing), `node:crypto` (sha256). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-plan-driven-ticket-sets-design.md` (Layer 2 + Layer 3 + CLI door + Error-handling + Testing sections). Layer 1 (deps queue, sweep, cascade, retry) is merged and on `main`.

## Global Constraints

- **The compiler rejects task ids matching `/^r?\d+$/`** (resolver suffix-grammar collision — `stemMatches` in `src/ticketDeps.ts` treats `-r<n>`/`-<n>` as the same ticket) and requires ids match `/^[a-z0-9][a-z0-9-]{0,31}$/`. Both are fail-closed compile errors.
- **All compile errors are collected and reported whole** (never first-only); nothing dispatches on any error.
- **Task blocks cannot set frontmatter** — `repo`, `base_branch`, `tools`, `network`, etc. come from the door; smuggled frontmatter inside any task text is stripped with the existing `SMUGGLED_FRONTMATTER_RE` discipline (and is a compile error, not a silent strip — the bridge's trust boundary).
- **Child ticket ids are `<planId>-<taskId>`** (bridge: `planId = githubTicketId(nwo, issue)` base; CLI: `plan-<slug>`); child frontmatter is door-built: `id`, `repo`, `github:` (bridge only), `plan: {id, task, hash}`, `depends_on`. `pr_title` deliberately omitted.
- **Fan-out idempotence uses the whole-queue resolver**: skip a child when `ticketState(queuePaths(cfg), id) !== "absent"` — never the inbox/processing-only `ticketInFlight` guard (a child that finished between crash and re-sweep must not re-run).
- **`planSets.enabled` gates compilation only** (bridge fence acceptance + planner teaching); Layer-1 `depends_on` handling stays always-on. `junco submit --plan` is gated on `planSets.enabled` too (one flag, one meaning: plan-set compilation is on).
- **Config seams ruling (revises a Layer-1 parked note):** `planSets` STAYS ballast in `tests/helpers/config.ts` — tests that exercise plan-set behavior state it via `makeConfig(seams, { planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 } })` overrides. Promoting it to `ConfigSeams` would force ~200 unrelated call sites to state it; the existing six toggle seams gate phases every PR-flow test hits, which `planSets.enabled` does not. Do not edit CLAUDE.md's seams line (still true).
- **Set-level issue reporting is sweep-owned**: the reporter returns early for set children (`t.plan && t.github`); `maintainPlanSets` recomputes state from the queue each bridge sweep and updates dashboard/labels — self-healing, cascade-aware.
- Dashboard comment edits are **best-effort direct gh calls** (skip on failure; the next sweep repaints); the one-shot degraded comment and label swaps ride the durable outbox (`tryOrEnqueue`) like existing reporter traffic.
- `src/ticketSchema.ts`: no changes needed this layer (the `plan:`/`depends_on` keys landed in Layer 1); if a task believes it needs a schema change, stop and escalate.
- Docs and skill text stay **stack-agnostic**; conventional commits; **NO AI-attribution trailers**; suite green at every commit; `npx prettier --write` touched files before each commit.
- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Vitest exit-code trap: `npx vitest run <files> > /tmp/out 2>&1; echo "exit: $?"` — never pipe through a filter.

## File Structure

- Create `src/planCompiler.ts` — pure fence→plan parser, validation, hashing, child emission. No fs/network.
- Create `src/planSets.ts` — set store (`<dataDir>/…/plans/`): materialize plan md + JSON record, read/list records, queue-state resolution, fan-out submit, dashboard markdown, supersede disposition. fs only; no gh.
- Create `src/planSetBridge.ts` — gh-facing: `dispatchPlanSet` (compile + materialize + fan-out for the bridge) and `maintainPlanSets` (dashboard/labels/degraded/supersede each sweep).
- Create tests: `tests/planCompiler.test.ts`, `tests/planSets.test.ts`, `tests/planSetBridge.test.ts`.
- Modify: `src/githubInbox.ts` (fence generalization + plan-ready wiring + exports), `src/githubReport.ts` (set-child suppression), `src/planPrompt.ts` (conditional junco-plan teaching), `src/dataTree.ts` (plans dir), `src/cli.ts` (`submit --plan`), `skills/junco-dispatch/SKILL.md` (set authoring), `ARCHITECTURE.md`, plus their test files.

---

### Task 1: Fence generalization + bridge exports

**Files:**

- Modify: `src/githubInbox.ts` (extractPlanBody internals ~200-254; export additions)
- Test: `tests/githubInbox.test.ts` (or wherever `extractPlanBody` is currently tested — find with `grep -rln extractPlanBody tests/`)

**Interfaces:**

- Produces: `PLAN_SET_FENCE = "junco-plan"` (exported const), `extractPlanSetBody(text: string): string | null` (exported), `buildPlanComment(planBody, opts & { fenceTag?: string })` (additive optional param, default `PLAN_FENCE`), and exports of the previously-private `findOwnPlanComment` and `verifyLabelApplier` (unchanged signatures) for Task 10/11.

- [ ] **Step 1: Write the failing tests** (append to the file that tests `extractPlanBody`)

`````ts
describe("junco-plan fence (spec 2026-08-20 layer 2)", () => {
  it("extractPlanSetBody pulls the last junco-plan fence; junco-ticket fences are ignored", () => {
    const text =
      "intro\n```junco-ticket\nsingle\n```\n\n````junco-plan\nversion: 1\ntasks: []\n````\ntail";
    expect(extractPlanSetBody(text)).toBe("version: 1\ntasks: []");
    expect(extractPlanBody(text)).toBe("single");
  });

  it("extractPlanSetBody returns null when no complete junco-plan fence exists", () => {
    expect(extractPlanSetBody("```junco-plan\nunclosed")).toBeNull();
    expect(extractPlanSetBody("no fences at all")).toBeNull();
  });

  it("buildPlanComment renders with the requested fence tag and stays re-extractable", () => {
    const c = buildPlanComment("version: 1\ntasks: []", {
      issue: 7,
      trigger: "junco",
      requireApproval: true,
      fenceTag: PLAN_SET_FENCE,
    });
    expect(c).not.toBeNull();
    expect(extractPlanSetBody(c as string)).toBe("version: 1\ntasks: []");
  });
});
`````

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run <that test file> > /tmp/out 2>&1; echo "exit: $?"` — FAIL (`extractPlanSetBody` not exported).

- [ ] **Step 3: Implement**

In `src/githubInbox.ts`:

```ts
export const PLAN_SET_FENCE = "junco-plan";
```

Refactor the body of `extractPlanBody` into a private generic:

````ts
/** Pull the LAST complete ```<fenceTag> block out of `text` (CommonMark
 * fence-length-aware, CRLF-normalized, smuggled frontmatter stripped) —
 * shared by the single-ticket (junco-ticket) and plan-set (junco-plan)
 * extractors. Null = no usable complete block. */
function extractFencedBlock(text: string, fenceTag: string): string | null {
  // ...move the existing extractPlanBody body here verbatim, replacing the
  // hardcoded PLAN_FENCE in openRe with fenceTag...
}

export function extractPlanBody(text: string): string | null {
  return extractFencedBlock(text, PLAN_FENCE);
}

export function extractPlanSetBody(text: string): string | null {
  return extractFencedBlock(text, PLAN_SET_FENCE);
}
````

`buildPlanComment`: add `fenceTag?: string` to its opts; use `const tag = opts.fenceTag ?? PLAN_FENCE;` in place of the hardcoded `PLAN_FENCE` in the rendered fence line. All existing callers pass no tag → behavior unchanged.

Add `export` to `findOwnPlanComment` and `verifyLabelApplier` (no signature change; update their doc comments to note the bridge-external consumers arriving in this plan).

- [ ] **Step 4: Run to verify pass; run the whole current test file plus `tests/githubReport.test.ts`** (it imports `extractPlanBody`/`buildPlanComment`). Expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts <test file>
git add -A && git commit -m "feat(bridge): junco-plan fence extraction and shared fence plumbing"
```

---

### Task 2: Compiler — parse + validate (`src/planCompiler.ts`)

**Files:**

- Create: `src/planCompiler.ts`
- Test: `tests/planCompiler.test.ts` (new)

**Interfaces:**

- Produces (consumed by Tasks 3, 9, 12):

```ts
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
export function parsePlanSet(fenceBody: string, opts: { maxTasks: number }): PlanParse;
export function hashPlan(fenceBody: string): string; // sha256 hex, first 12 chars
```

- [ ] **Step 1: Write the failing tests** (`tests/planCompiler.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { parsePlanSet, hashPlan } from "../src/planCompiler.js";

const VALID = `version: 1
shared_context: |
  One repo, additive changes only.
tasks:
  - id: schema
    title: Add the keys
    depends_on: []
    description: |
      Add the frontmatter keys.
    acceptance:
      - Keys parse
    prohibitions:
      - Do not touch the queue
    verification: |
      npx vitest run tests/ticket.test.ts
  - id: resolver
    title: Resolve state
    depends_on: [schema]
    description: |
      Build the resolver.
    acceptance:
      - Resolves done
`;

describe("parsePlanSet", () => {
  it("parses a valid two-task plan", () => {
    const r = parsePlanSet(VALID, { maxTasks: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.tasks.map((t) => t.id)).toEqual(["schema", "resolver"]);
    expect(r.plan.tasks[1].dependsOn).toEqual(["schema"]);
    expect(r.plan.sharedContext).toContain("additive changes only");
    expect(r.plan.tasks[0].verification).toContain("vitest");
    expect(r.plan.tasks[1].verification).toBeNull();
    expect(r.plan.tasks[1].prohibitions).toEqual([]);
  });

  it("collects ALL errors, not just the first", () => {
    const bad = `version: 1
tasks:
  - id: schema
    title: A
    depends_on: [ghost]
    description: x
    acceptance: [a]
  - id: schema
    title: B
    depends_on: []
    description: ""
    acceptance: []
`;
    const r = parsePlanSet(bad, { maxTasks: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join("\n");
    expect(all).toMatch(/unknown depends_on/i); // ghost
    expect(all).toMatch(/duplicate task id/i); // schema twice
    expect(all).toMatch(/empty description/i);
    expect(all).toMatch(/empty acceptance/i);
  });

  it("fails closed on: bad YAML, wrong version, cycle, task cap, bad id charset, resolver-suffix id, smuggled frontmatter", () => {
    const fail = (body: string, re: RegExp) => {
      const r = parsePlanSet(body, { maxTasks: 2 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join("\n")).toMatch(re);
    };
    fail("not: [valid", /yaml/i);
    fail("version: 2\ntasks: []", /version/i);
    fail(
      "version: 1\ntasks:\n  - {id: a, title: T, depends_on: [b], description: x, acceptance: [y]}\n  - {id: b, title: T, depends_on: [a], description: x, acceptance: [y]}",
      /cycle/i,
    );
    fail(
      "version: 1\ntasks:\n  - {id: a, title: T, depends_on: [], description: x, acceptance: [y]}\n  - {id: b, title: T, depends_on: [], description: x, acceptance: [y]}\n  - {id: c, title: T, depends_on: [], description: x, acceptance: [y]}",
      /more than 2 tasks/i,
    );
    fail(
      "version: 1\ntasks:\n  - {id: Bad_Id, title: T, depends_on: [], description: x, acceptance: [y]}",
      /task id/i,
    );
    // r?\d+ ids collide with the queue resolver's -r<n>/-<n> suffix grammar
    fail(
      "version: 1\ntasks:\n  - {id: '2', title: T, depends_on: [], description: x, acceptance: [y]}",
      /suffix/i,
    );
    fail(
      "version: 1\ntasks:\n  - {id: r1, title: T, depends_on: [], description: x, acceptance: [y]}",
      /suffix/i,
    );
    fail(
      "version: 1\ntasks:\n  - id: a\n    title: T\n    depends_on: []\n    description: |\n      ---\n      repo: /evil\n      ---\n      body\n    acceptance: [y]",
      /frontmatter/i,
    );
  });

  it("an empty tasks list is an error; version must be literal 1", () => {
    const r = parsePlanSet("version: 1\ntasks: []", { maxTasks: 10 });
    expect(r.ok).toBe(false);
  });
});

describe("hashPlan", () => {
  it("is 12 lowercase hex chars and content-sensitive", () => {
    expect(hashPlan("a")).toMatch(/^[0-9a-f]{12}$/);
    expect(hashPlan("a")).not.toBe(hashPlan("b"));
    expect(hashPlan("a")).toBe(hashPlan("a"));
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement** (`src/planCompiler.ts`)

```ts
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
    for (const [field, text] of [
      ["description", description ?? ""],
      ["shared_context", sharedContext ?? ""],
    ] as const) {
      if (SMUGGLED_FM_RE.test(text)) {
        errors.push(
          `${at}: ${field} contains a frontmatter delimiter (---) — frontmatter is machine-owned`,
        );
      }
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
```

(Note the `shared_context` smuggle check runs once per task in the loop above — hoist it out of the loop so it reports once: move the `shared_context` half of that `for` into a single check before the `forEach`. Keep only `description` inside the loop.)

- [ ] **Step 4: Run to verify pass** — expect exit 0. Also run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planCompiler.ts tests/planCompiler.test.ts
git add -A && git commit -m "feat(compiler): junco-plan fence parser with fail-closed validation"
```

---

### Task 3: Compiler — child emission

**Files:**

- Modify: `src/planCompiler.ts`
- Test: `tests/planCompiler.test.ts`

**Interfaces:**

- Produces (consumed by Tasks 6, 9, 12):

```ts
export interface CompileCtx {
  planId: string; // set identifier AND child-id prefix
  repoPath: string; // door-resolved local clone path
  hash: string; // hashPlan(fenceBody)
  github: { nwo: string; issue: number } | null; // bridge door only
}
export interface CompiledChild {
  taskId: string;
  ticketId: string; // `${planId}-${taskId}`
  dependsOn: string[]; // ticket ids
  content: string; // full ticket file (frontmatter + body)
}
export function compilePlan(plan: PlanSet, ctx: CompileCtx): CompiledChild[];
```

- [ ] **Step 1: Write the failing tests** (append to `tests/planCompiler.test.ts`)

```ts
import { compilePlan, type PlanSet } from "../src/planCompiler.js";
import { parseTicket } from "../src/ticket.js";

const PLAN: PlanSet = {
  version: 1,
  sharedContext: "All changes additive.",
  tasks: [
    {
      id: "schema",
      title: "Add keys",
      dependsOn: [],
      description: "Add the keys.",
      acceptance: ["Keys parse", "Defaults hold"],
      prohibitions: ["No queue changes"],
      verification: "npx vitest run tests/ticket.test.ts",
    },
    {
      id: "resolver",
      title: "Resolve state",
      dependsOn: ["schema"],
      description: "Build the resolver.",
      acceptance: ["Resolves done"],
      prohibitions: [],
      verification: null,
    },
  ],
};
const CTX = {
  planId: "gh-acme-api-1a2b3c4d-9",
  repoPath: "/sbxroot/clone",
  hash: "abc123def456",
  github: { nwo: "acme/api", issue: 9 },
};

describe("compilePlan", () => {
  it("emits one child per task with door-built frontmatter and edge translation", () => {
    const kids = compilePlan(PLAN, CTX);
    expect(kids.map((k) => k.ticketId)).toEqual([
      "gh-acme-api-1a2b3c4d-9-schema",
      "gh-acme-api-1a2b3c4d-9-resolver",
    ]);
    const t = parseTicket("x.md", kids[1].content);
    expect(t.id).toBe("gh-acme-api-1a2b3c4d-9-resolver");
    expect(t.frontmatter.repo).toBe("/sbxroot/clone");
    expect(t.github).toEqual({ nwo: "acme/api", issue: 9, kind: "pr", external: false });
    expect(t.plan).toEqual({ id: CTX.planId, task: "resolver", hash: CTX.hash });
    expect(t.dependsOn).toEqual(["gh-acme-api-1a2b3c4d-9-schema"]);
    expect(t.frontmatter.pr_title).toBeUndefined();
  });

  it("renders the TEMPLATE-aligned body: title, description, acceptance, prohibitions, shared context, deps note, verification", () => {
    const body = parseTicket("x.md", compilePlan(PLAN, CTX)[0].content).body;
    expect(body).toContain("# Add keys");
    expect(body).toContain("Add the keys.");
    expect(body).toContain("## Behavior (acceptance — testable assertions)");
    expect(body).toContain("- Keys parse");
    expect(body).toContain("## Prohibitions");
    expect(body).toContain("- No queue changes");
    expect(body).toContain("## Shared context");
    expect(body).toContain("All changes additive.");
    expect(body).toContain("## Verification (junco runs this — do NOT run it yourself)");
    expect(body).toContain("npx vitest run tests/ticket.test.ts");
  });

  it("a dependent task's body names its dependency tickets; a no-verification task omits the section", () => {
    const kids = compilePlan(PLAN, CTX);
    const dep = parseTicket("x.md", kids[1].content).body;
    expect(dep).toContain("gh-acme-api-1a2b3c4d-9-schema");
    expect(dep).not.toContain("## Verification");
  });

  it("local (github: null) children carry no github block", () => {
    const t = parseTicket("x.md", compilePlan(PLAN, { ...CTX, github: null })[0].content);
    expect(t.github).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `compilePlan` not exported.

- [ ] **Step 3: Implement** (append to `src/planCompiler.ts`)

````ts
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
````

- [ ] **Step 4: Run to verify pass** + `npm run typecheck`. Expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planCompiler.ts tests/planCompiler.test.ts
git add -A && git commit -m "feat(compiler): deterministic child-ticket emission from a validated plan"
```

---

### Task 4: Set store — data-tree dir, records, materialization (`src/planSets.ts`)

**Files:**

- Modify: `src/dataTree.ts` (add `plans` to `DataTreePaths`, both `LAYOUTS` entries — v2: `"data/plans"`, flat: `"plans"` — and the ensure/creation list; mirror exactly how `transcripts` appears in all three places)
- Create: `src/planSets.ts`
- Test: `tests/planSets.test.ts` (new), `tests/dataTree.test.ts` (one assertion)

**Interfaces:**

- Produces (consumed by Tasks 5, 6, 9, 10, 11, 12):

```ts
export interface PlanSetRecord {
  v: 1;
  planId: string;
  hash: string;
  repoPath: string;
  github: { nwo: string; issue: number } | null;
  tasks: { id: string; ticketId: string; dependsOn: string[] }[];
  createdAt: string; // ISO
  statusCommentId: number | null; // dashboard comment cache (bridge sets)
  degradedPosted: boolean;
  lastLabel: string | null; // last set-level lifecycle label applied
  closed: boolean; // all-terminal handled; maintenance stops
}
export function plansDir(cfg: Config): string;
export function writePlanSetRecord(cfg: Config, record: PlanSetRecord): void; // tmp+rename
export function readPlanSetRecord(cfg: Config, planId: string): PlanSetRecord | null;
export function listPlanSetRecords(cfg: Config): PlanSetRecord[];
export function materializePlanSet(cfg: Config, record: PlanSetRecord, fenceBody: string): void;
// writes <plansDir>/<planId>.md (the durable plan copy) + the record json
```

- [ ] **Step 1: Write the failing tests** (`tests/planSets.test.ts` — fixture: `mkdtempSync` root + `makeConfig` with the ten seams, `dataDir: join(root, "data")`, `queueRoot: join(root, "queue")`)

```ts
describe("plan-set store", () => {
  it("materializes the plan md + record json and round-trips the record", () => {
    const rec = record(); // local helper building a full PlanSetRecord literal
    materializePlanSet(cfg, rec, "version: 1\ntasks: []");
    expect(readFileSync(join(plansDir(cfg), "p1.md"), "utf8")).toContain("version: 1");
    expect(readPlanSetRecord(cfg, "p1")).toEqual(rec);
    expect(listPlanSetRecords(cfg).map((r) => r.planId)).toEqual(["p1"]);
  });

  it("readPlanSetRecord returns null for absent/corrupt records; list skips corrupt files", () => {
    expect(readPlanSetRecord(cfg, "nope")).toBeNull();
    mkdirSync(plansDir(cfg), { recursive: true });
    writeFileSync(join(plansDir(cfg), "bad.json"), "{not json");
    expect(readPlanSetRecord(cfg, "bad")).toBeNull();
    expect(listPlanSetRecords(cfg)).toEqual([]);
  });
});
```

And in `tests/dataTree.test.ts`, extend the existing layout-paths assertions: v2 layout's `plans` ends with `data/plans`, flat ends with `plans` (mirror how the `transcripts` assertions are written there).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** `dataTree.ts`: add the `plans` key to `DataTreePaths`, both `LAYOUTS` maps, the `dataTreePaths` return, and the directory-ensure list — one line each, exactly parallel to `transcripts`. `src/planSets.ts`:

```ts
/**
 * Plan-set store (spec 2026-08-20, Layer 2): the durable record of a compiled
 * set — the approved plan's markdown copy plus a JSON record naming the
 * children — under the data tree (transcripts precedent). fs only; the gh side
 * lives in planSetBridge.ts.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";

export interface PlanSetRecord {
  /* …exactly the interface above… */
}

export function plansDir(cfg: Config): string {
  return dataTreePaths(cfg).plans;
}

function atomicWrite(path: string, content: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function writePlanSetRecord(cfg: Config, record: PlanSetRecord): void {
  const dir = plansDir(cfg);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${record.planId}.json`), JSON.stringify(record, null, 2) + "\n");
}

export function readPlanSetRecord(cfg: Config, planId: string): PlanSetRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(plansDir(cfg), `${planId}.json`), "utf8")) as unknown;
    return raw !== null && typeof raw === "object" && (raw as PlanSetRecord).v === 1
      ? (raw as PlanSetRecord)
      : null;
  } catch {
    return null; // absent or corrupt — callers treat as no record
  }
}

export function listPlanSetRecords(cfg: Config): PlanSetRecord[] {
  let names: string[] = [];
  try {
    names = readdirSync(plansDir(cfg)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => readPlanSetRecord(cfg, n.replace(/\.json$/, "")))
    .filter((r): r is PlanSetRecord => r !== null);
}

export function materializePlanSet(cfg: Config, record: PlanSetRecord, fenceBody: string): void {
  const dir = plansDir(cfg);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${record.planId}.md`), fenceBody.trimEnd() + "\n");
  writePlanSetRecord(cfg, record);
}
```

- [ ] **Step 4: Run to verify pass** (`tests/planSets.test.ts`, `tests/dataTree.test.ts`) + `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/dataTree.ts src/planSets.ts tests/planSets.test.ts tests/dataTree.test.ts
git add -A && git commit -m "feat(plansets): durable set store under the data tree"
```

---

### Task 5: Set-state resolution + dashboard rendering

**Files:**

- Modify: `src/planSets.ts`
- Test: `tests/planSets.test.ts`

**Interfaces:**

- Produces (consumed by Tasks 10, 11):

```ts
export const PLAN_STATUS_MARKER = "<!-- junco:plan-status -->";
export type TaskRunState = "queued" | "waiting" | "processing" | "done" | "failed" | "absent";
export interface TaskStatus {
  id: string;
  ticketId: string;
  state: TaskRunState;
  prUrl: string | null;
  dependencyFailed: string | null;
}
export interface SetState {
  tasks: TaskStatus[];
  allTerminal: boolean;
  allDone: boolean;
  anyFailed: boolean;
  anyProcessing: boolean;
}
export function resolveSetState(cfg: Config, record: PlanSetRecord): SetState;
export function renderDashboard(record: PlanSetRecord, state: SetState): string;
```

- [ ] **Step 1: Write the failing tests** (append; fixture creates real queue dirs under `queueRoot` and drops ticket files)

```ts
describe("resolveSetState / renderDashboard", () => {
  it("maps queue reality to per-task states", () => {
    const rec = record({
      tasks: [
        { id: "a", ticketId: "p1-a", dependsOn: [] },
        { id: "b", ticketId: "p1-b", dependsOn: ["p1-a"] },
        { id: "c", ticketId: "p1-c", dependsOn: ["p1-b"] },
        { id: "d", ticketId: "p1-d", dependsOn: [] },
      ],
    });
    writeFileSync(
      join(qp.done, "p1-a.md"),
      "---\nid: p1-a\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/1\n-->\n",
    );
    writeFileSync(join(qp.processing, "2026-08-20T1200Z__p1-b.md"), "---\nid: p1-b\n---\n");
    writeFileSync(join(qp.inbox, "p1-c.md"), "---\nid: p1-c\ndepends_on: [p1-b]\n---\n");
    writeFileSync(
      join(qp.failed, "p1-d.md"),
      "---\nid: p1-d\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\ndependency_failed: p1-x\n-->\n",
    );
    const s = resolveSetState(cfg, rec);
    expect(s.tasks.map((t) => t.state)).toEqual(["done", "processing", "waiting", "failed"]);
    expect(s.tasks[0].prUrl).toBe("https://github.com/a/b/pull/1");
    expect(s.tasks[3].dependencyFailed).toBe("p1-x");
    expect(s.allTerminal).toBe(false);
    expect(s.anyFailed).toBe(true);
    expect(s.anyProcessing).toBe(true);
  });

  it("inbox ticket with all deps satisfied is 'queued', not 'waiting'; absent is 'absent'", () => {
    const rec = record({
      tasks: [
        { id: "a", ticketId: "p1-a", dependsOn: [] },
        { id: "b", ticketId: "p1-b", dependsOn: [] },
      ],
    });
    writeFileSync(join(qp.inbox, "p1-a.md"), "---\nid: p1-a\n---\n");
    const s = resolveSetState(cfg, rec);
    expect(s.tasks[0].state).toBe("queued");
    expect(s.tasks[1].state).toBe("absent");
  });

  it("renderDashboard carries the marker, checkboxes, PR links, and waiting edges", () => {
    const rec = record({ tasks: [{ id: "a", ticketId: "p1-a", dependsOn: [] }] });
    const md = renderDashboard(rec, {
      tasks: [
        {
          id: "a",
          ticketId: "p1-a",
          state: "done",
          prUrl: "https://x/pr/1",
          dependencyFailed: null,
        },
      ],
      allTerminal: true,
      allDone: true,
      anyFailed: false,
      anyProcessing: false,
    });
    expect(md).toContain(PLAN_STATUS_MARKER);
    expect(md).toContain("- [x] `a` — done — https://x/pr/1");
    expect(md).toContain(rec.hash);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** (append to `src/planSets.ts`; new imports: `queuePaths` from config.js, `ticketState, findTicketFile` from ticketDeps.js, `parseResultMeta` from resultMeta.js, `parseTicket` from ticket.js, `TERMINAL_DONE_STATUSES` from types.js — note the failed-state read below never needs it, listed only if you use it):

```ts
export const PLAN_STATUS_MARKER = "<!-- junco:plan-status -->";
export type TaskRunState = "queued" | "waiting" | "processing" | "done" | "failed" | "absent";
export interface TaskStatus {
  /* …as above… */
}
export interface SetState {
  /* …as above… */
}

/** Recompute a set's task states from queue reality — the single source the
 * dashboard/labels derive from. Sweep-driven on purpose: cascaded children
 * never pass through the reporter, so event-driven state would go stale. */
export function resolveSetState(cfg: Config, record: PlanSetRecord): SetState {
  const paths = queuePaths(cfg);
  const tasks: TaskStatus[] = record.tasks.map((t) => {
    const st = ticketState(paths, t.ticketId);
    let state: TaskRunState;
    let prUrl: string | null = null;
    let dependencyFailed: string | null = null;
    if (st === "done" || st === "failed") {
      state = st;
      const f = findTicketFile(st === "done" ? paths.done : paths.failed, t.ticketId);
      if (f) {
        const meta = parseResultMeta(readFileSync(f, "utf8"));
        prUrl = meta.prUrl;
        dependencyFailed = meta.dependencyFailed;
      }
    } else if (st === "processing") {
      state = "processing";
    } else if (st === "inbox") {
      const f = findTicketFile(paths.inbox, t.ticketId);
      let pending = false;
      if (f) {
        try {
          const parsed = parseTicket(f, readFileSync(f, "utf8"));
          pending = parsed.dependsOn.some((d) => !parsed.depsSatisfied.includes(d));
        } catch {
          /* vanished/unreadable — treat as queued; next sweep refreshes */
        }
      }
      state = pending ? "waiting" : "queued";
    } else {
      state = "absent";
    }
    return { id: t.id, ticketId: t.ticketId, state, prUrl, dependencyFailed };
  });
  const terminal = (s: TaskRunState): boolean => s === "done" || s === "failed";
  return {
    tasks,
    allTerminal: tasks.every((t) => terminal(t.state)),
    allDone: tasks.every((t) => t.state === "done"),
    anyFailed: tasks.some((t) => t.state === "failed"),
    anyProcessing: tasks.some((t) => t.state === "processing"),
  };
}

export function renderDashboard(record: PlanSetRecord, state: SetState): string {
  const lines: string[] = [
    PLAN_STATUS_MARKER,
    `**Plan set status** — plan \`${record.planId}\`, rev \`${record.hash}\``,
    "",
  ];
  for (const t of state.tasks) {
    const box = t.state === "done" ? "x" : " ";
    let detail: string = t.state;
    if (t.state === "done" && t.prUrl) detail = `done — ${t.prUrl}`;
    if (t.state === "failed")
      detail = t.dependencyFailed
        ? `failed — dependency \`${t.dependencyFailed}\` failed`
        : "failed";
    if (t.state === "waiting") {
      const deps = record.tasks.find((r) => r.id === t.id)?.dependsOn ?? [];
      detail = `waiting on: ${deps.map((d) => `\`${d}\``).join(", ")}`;
    }
    lines.push(`- [${box}] \`${t.id}\` — ${detail}`);
  }
  lines.push("", "_Maintained by the worker each sweep; edits here are overwritten._");
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run to verify pass** + typecheck.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planSets.ts tests/planSets.test.ts
git add -A && git commit -m "feat(plansets): queue-derived set state and dashboard rendering"
```

---

### Task 6: Fan-out submit with whole-queue idempotence

**Files:**

- Modify: `src/planSets.ts`
- Test: `tests/planSets.test.ts`

**Interfaces:**

- Produces (Tasks 9, 11, 12): `submitPlanSet(cfg: Config, children: CompiledChild[]): { submitted: string[]; skipped: string[] }` (imports `CompiledChild` type from planCompiler.js, `submitTicket` from dispatch.js).

- [ ] **Step 1: Write the failing tests**

```ts
describe("submitPlanSet", () => {
  const kid = (id: string): CompiledChild => ({
    taskId: id.split("-").pop() as string,
    ticketId: id,
    dependsOn: [],
    content: `---\nid: ${id}\n---\nBody\n`,
  });

  it("submits absent children; skips ones anywhere in the queue (done included)", () => {
    writeFileSync(join(qp.done, "2026-08-20T1200Z__p1-a.md"), "x"); // finished on a prior crash-recovery cycle
    writeFileSync(join(qp.inbox, "p1-b.md"), "x");
    const r = submitPlanSet(cfg, [kid("p1-a"), kid("p1-b"), kid("p1-c")]);
    expect(r.skipped.sort()).toEqual(["p1-a", "p1-b"]);
    expect(r.submitted).toEqual(["p1-c"]);
    expect(existsSync(join(qp.inbox, "p1-c.md"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
/** Idempotent fan-out: a child whose id exists ANYWHERE in the queue —
 * done/ and failed/ included — is skipped, never re-run. This is deliberately
 * stricter than the bridge's single-ticket ticketInFlight guard (inbox+
 * processing only): a set child that finished between a crash and the
 * re-sweep must not execute twice; set re-cycling goes through supersede,
 * not the remove-label gesture. */
export function submitPlanSet(
  cfg: Config,
  children: CompiledChild[],
): { submitted: string[]; skipped: string[] } {
  const paths = queuePaths(cfg);
  const submitted: string[] = [];
  const skipped: string[] = [];
  for (const c of children) {
    if (ticketState(paths, c.ticketId) !== "absent") {
      skipped.push(c.ticketId);
      continue;
    }
    submitTicket(cfg, c.content, { idHint: c.ticketId });
    submitted.push(c.ticketId);
  }
  return { submitted, skipped };
}
```

- [ ] **Step 4: Run to verify pass** + typecheck.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planSets.ts tests/planSets.test.ts
git add -A && git commit -m "feat(plansets): idempotent whole-queue fan-out submit"
```

---

### Task 7: Planner teaching — conditional `junco-plan` instructions

**Files:**

- Modify: `src/planPrompt.ts` (buildPlannerPrompt opts), `src/githubInbox.ts` (`buildPlanningTicket` passes the flag — find its `buildPlannerPrompt` call and thread `planSets: cfg.planSets.enabled`; it has access to cfg)
- Test: `tests/planPrompt.test.ts` (or wherever buildPlannerPrompt is tested — `grep -rln buildPlannerPrompt tests/`)

**Interfaces:**

- Produces: `buildPlannerPrompt(opts & { planSets?: boolean })` — additive optional flag, default false (existing callers unchanged).

- [ ] **Step 1: Write the failing tests**

````ts
it("teaches the junco-plan fence only when planSets is on", () => {
  const base = { title: "T", body: "B", nwo: "a/b", parent: null };
  const off = buildPlannerPrompt(base);
  const on = buildPlannerPrompt({ ...base, planSets: true });
  expect(off).not.toContain("junco-plan");
  expect(on).toContain("```junco-plan");
  expect(on).toContain("depends_on");
  // single-ticket teaching survives in both modes
  expect(on).toContain("junco-ticket");
});
````

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `buildPlannerPrompt`, after rule 5 (the fence rule), when `opts.planSets` is true append a rule 6 part to the first `parts[]` entry (keep it one template literal appended to the rules string):

```ts
const planSetRule = opts.planSets
  ? `

6. IF AND ONLY IF the issue naturally decomposes into 2–10 tasks with real
   dependency ordering, you may instead emit ONE fenced block tagged
   \`junco-plan\` (INSTEAD of the junco-ticket fence): a YAML document —

\`\`\`junco-plan
version: 1
shared_context: |
  Constraints that apply to every task.
tasks:
  - id: short-slug            # [a-z0-9][a-z0-9-]{0,31}; NOT purely numeric
    title: Verb-first title
    depends_on: []            # other task ids; the worker orders execution
    description: |
      Self-contained: what to build and why.
    acceptance:
      - Testable assertion
    prohibitions:
      - What must not change
    verification: |
      commands the worker runs to verify (optional)
\`\`\`

   Each task becomes its own ticket and pull request, executed in dependency
   order (a task starts only after its dependencies' PRs are merged). Prefer
   the single junco-ticket fence whenever the work fits one PR.`
  : "";
```

…and interpolate `${planSetRule}` at the end of the rules block (before the closing "A missing or empty fence fails the ticket." line, adjusting that line to "A missing or empty fence fails the ticket." — it already covers both). In `src/githubInbox.ts`'s `buildPlanningTicket`, pass `planSets: cfg.planSets.enabled` into the `buildPlannerPrompt` call (the function already receives cfg or the caller does — thread it as needed; keep the change minimal).

- [ ] **Step 4: Run to verify pass** + run the githubInbox test file (buildPlanningTicket snapshot-ish tests may assert prompt content — update only if they break on the new optional arg, and say so in your report) + typecheck.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planPrompt.ts src/githubInbox.ts <touched tests>
git add -A && git commit -m "feat(planner): conditional junco-plan fence teaching behind planSets.enabled"
```

---

### Task 8: Reporter suppression for set children

**Files:**

- Modify: `src/githubReport.ts`
- Test: `tests/githubReport.test.ts`

**Interfaces:**

- Consumes: `Ticket.plan` (Layer 1). Behavior: for a ticket with BOTH `plan` and `github` set, `onStart`/`onRequeue`/`onFinal` do nothing — `maintainPlanSets` (Task 10) owns all set-level issue traffic. Tickets with `plan` but no `github` (CLI-door sets) are already no-ops (every method guards on `t.github`).

- [ ] **Step 1: Write the failing test** (append to `tests/githubReport.test.ts`, reusing its fake-gh/reporter fixture idiom)

```ts
it("set children (plan + github) produce zero reporter traffic — the sweep owns set reporting", async () => {
  const t = ticket({
    github: { nwo: "a/b", issue: 3, kind: "pr", external: false },
    plan: { id: "p1", task: "schema", hash: "abc" },
  }); // use this file's existing Ticket fixture builder
  await reporter.onStart(t);
  await reporter.onRequeue(t);
  await reporter.onFinal(t, outcome({ status: "completed", prUrl: "https://x/pr/1" }));
  expect(ghCalls()).toEqual([]); // however this file observes gh invocations
});
```

- [ ] **Step 2: Run to verify failure** (label/comment calls fire today).

- [ ] **Step 3: Implement.** In `makeGithubReporter`, add as the FIRST line of each of `onStart`, `onRequeue`, `onFinal`:

```ts
// Plan-set children: per-child comments and label flips on the shared parent
// issue would thrash (N children, one issue) and cascaded children never
// reach this reporter at all — maintainPlanSets (planSetBridge.ts) recomputes
// set state from the queue each sweep and owns ALL set-level issue traffic.
if (t.plan && t.github) return;
```

- [ ] **Step 4: Run to verify pass** (whole githubReport test file) + typecheck.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubReport.ts tests/githubReport.test.ts
git add -A && git commit -m "feat(reporter): suppress per-child issue traffic for plan-set children"
```

---

### Task 9: Bridge dispatch door (`src/planSetBridge.ts` + plan-ready wiring)

**Files:**

- Create: `src/planSetBridge.ts`
- Modify: `src/githubInbox.ts` (plan-ready branch, directly after `extractPlanBody`'s null-check region — see wiring below)
- Test: `tests/planSetBridge.test.ts` (new), `tests/githubInbox.test.ts` (wiring)

**Interfaces:**

- Produces (Task 10/11 extend this module):

```ts
export type DispatchResult =
  | { ok: true; submitted: string[]; skipped: string[] }
  | { ok: false; errors: string[] };
export function dispatchPlanSet(
  cfg: Config,
  repo: GithubRepoMapping,
  issueNumber: number,
  fenceBody: string,
  nowIso: string,
): DispatchResult;
```

- Consumes: `parsePlanSet`/`compilePlan`/`hashPlan` (Tasks 2-3), `materializePlanSet`/`submitPlanSet`/`PlanSetRecord` (Tasks 4/6), `githubTicketId` (githubInbox — export it if private; check).

- [ ] **Step 1: Write the failing tests** (`tests/planSetBridge.test.ts`; tmp queue+data dirs via makeConfig with `planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 }` override)

```ts
const FENCE = `version: 1
tasks:
  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}
  - {id: b, title: T B, depends_on: [a], description: Build B., acceptance: [works]}
`;

describe("dispatchPlanSet", () => {
  it("compiles, materializes, and fans out; record carries the children", () => {
    const r = dispatchPlanSet(cfg, { nwo: "acme/api", path: "/sbxroot/clone" }, 9, FENCE, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submitted).toHaveLength(2);
    const rec = readPlanSetRecord(cfg, r.submitted[0].replace(/-a$/, ""));
    expect(rec).not.toBeNull();
    expect(rec?.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(rec?.github).toEqual({ nwo: "acme/api", issue: 9 });
    expect(existsSync(join(qp.inbox, `${rec?.planId}-a.md`))).toBe(true);
  });

  it("compile errors dispatch nothing and return the whole error list", () => {
    const r = dispatchPlanSet(
      cfg,
      { nwo: "acme/api", path: "/p" },
      9,
      "version: 1\ntasks: []",
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThan(0);
    expect(readdirSync(qp.inbox)).toEqual([]);
  });

  it("re-dispatch after a crash resubmits only missing children (done child skipped)", () => {
    const first = dispatchPlanSet(cfg, { nwo: "acme/api", path: "/p" }, 9, FENCE, NOW);
    if (!first.ok) throw new Error("setup");
    const planId = first.submitted[0].replace(/-a$/, "");
    // child a "finished" while the label swap was lost:
    renameSync(join(qp.inbox, `${planId}-a.md`), join(qp.done, `${planId}-a.md`));
    rmSync(join(qp.inbox, `${planId}-b.md`));
    const again = dispatchPlanSet(cfg, { nwo: "acme/api", path: "/p" }, 9, FENCE, NOW);
    expect(again.ok && again.submitted).toEqual([`${planId}-b`]);
    expect(again.ok && again.skipped).toEqual([`${planId}-a`]);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** (`src/planSetBridge.ts`):

```ts
/**
 * Bridge doors for plan sets (spec 2026-08-20, Layer 2): dispatch (this task)
 * and sweep-driven maintenance (dashboard/labels/supersede — later tasks).
 * Trust shape: the model authored a fence, a human approved the comment
 * (temporal check in pollGithubInbox), and THIS code — never model text —
 * builds every byte of child frontmatter via the pure compiler.
 */
import type { Config, GithubRepoMapping } from "./types.js";
import { githubTicketId } from "./githubInbox.js";
import { parsePlanSet, compilePlan, hashPlan } from "./planCompiler.js";
import { materializePlanSet, submitPlanSet, type PlanSetRecord } from "./planSets.js";
import { log } from "./logging.js";

export type DispatchResult =
  | { ok: true; submitted: string[]; skipped: string[] }
  | { ok: false; errors: string[] };

export function dispatchPlanSet(
  cfg: Config,
  repo: GithubRepoMapping,
  issueNumber: number,
  fenceBody: string,
  nowIso: string,
): DispatchResult {
  const parsed = parsePlanSet(fenceBody, { maxTasks: cfg.planSets.maxTasks });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const planId = githubTicketId(repo.nwo, issueNumber);
  const hash = hashPlan(fenceBody);
  const children = compilePlan(parsed.plan, {
    planId,
    repoPath: repo.path,
    hash,
    github: { nwo: repo.nwo, issue: issueNumber },
  });
  const record: PlanSetRecord = {
    v: 1,
    planId,
    hash,
    repoPath: repo.path,
    github: { nwo: repo.nwo, issue: issueNumber },
    tasks: children.map((c) => ({ id: c.taskId, ticketId: c.ticketId, dependsOn: c.dependsOn })),
    createdAt: nowIso,
    statusCommentId: null,
    degradedPosted: false,
    lastLabel: null,
    closed: false,
  };
  // Materialize BEFORE fan-out: the record is what maintenance and crash
  // recovery key on; a record without children self-heals (next dispatch
  // resubmits), children without a record would be an untracked set.
  materializePlanSet(cfg, record, fenceBody);
  const r = submitPlanSet(cfg, children);
  log.info("plan set dispatched", {
    planId,
    submitted: r.submitted.length,
    skipped: r.skipped.length,
  });
  return { ok: true, ...r };
}
```

(`githubTicketId` — export it from githubInbox.ts if not already exported; check with grep and add `export` if needed.)

**githubInbox wiring** — in the plan-ready branch, replace the current block that starts at `const planBody = extractPlanBody(comment.body);` with:

```ts
// Layer 2: a junco-plan fence (multi-task set) takes precedence when the
// feature is on; the single-ticket junco-ticket path below is unchanged and
// still handles every pre-existing plan comment.
const setBody = cfg.planSets.enabled ? extractPlanSetBody(comment.body) : null;
if (setBody !== null) {
  const dr = dispatchPlanSet(cfg, repo, issue.number, setBody, new Date().toISOString());
  if (!dr.ok) {
    const errList = dr.errors.map((e) => `- ${e}`).join("\n");
    const failureComment = `**Junco could not compile this plan set** — nothing was dispatched.\n\n${errList}\n\n_Edit the plan comment and re-apply approval to retry._\n`;
    await postIssueComment(cfg, repo.nwo, issue.number, failureComment, ghFn); // see note below
    const failArgs = [
      "issue",
      "edit",
      String(issue.number),
      "--repo",
      repo.nwo,
      "--add-label",
      ll.failed,
      "--remove-label",
      ll.planReady,
    ];
    if (cfg.github.requireApproval) failArgs.push("--remove-label", ll.approved);
    await ghFn(cfg, failArgs, { timeoutMs: GH_TIMEOUT, retryNetwork: true });
    continue;
  }
  // Same submit-before-label ordering as the single path.
  const setArgs = [
    "issue",
    "edit",
    String(issue.number),
    "--repo",
    repo.nwo,
    "--add-label",
    ll.queued,
    "--remove-label",
    ll.planReady,
  ];
  if (cfg.github.requireApproval) setArgs.push("--remove-label", ll.approved);
  await ghFn(cfg, setArgs, { timeoutMs: GH_TIMEOUT, retryNetwork: true });
  bridged++;
  log.info("github bridge: approved plan set dispatched", { nwo: repo.nwo, issue: issue.number });
  continue;
}
const planBody = extractPlanBody(comment.body);
// …existing single-ticket path unchanged from here…
```

`postIssueComment`: githubInbox likely has an existing comment-posting helper (grep for `issue", "comment"` in the file); reuse it. If none exists at module level (the reporter owns comments today), add a small local helper using the same `gh issue comment --body-file` tempfile pattern as `githubReport.ts`'s `postComment`.

- [ ] **Step 4: Run to verify pass** (planSetBridge + githubInbox test files; the githubInbox harness has fake-gh scripts — add a wiring test there: a plan-ready+approved issue whose comment holds a junco-plan fence, `planSets.enabled: true` → two tickets in inbox + labels swapped; and with `enabled: false` → the fence is IGNORED and the junco-ticket path runs, i.e. no set tickets). Run typecheck.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planSetBridge.ts src/githubInbox.ts tests/planSetBridge.test.ts tests/githubInbox.test.ts
git add -A && git commit -m "feat(bridge): plan-set dispatch door behind planSets.enabled"
```

---

### Task 10: Sweep-driven maintenance — dashboard, set labels, degraded comment

**Files:**

- Modify: `src/planSetBridge.ts`, `src/githubInbox.ts` (call site), `src/planSets.ts` (only if a helper is missing)
- Test: `tests/planSetBridge.test.ts`

**Interfaces:**

- Produces: `maintainPlanSets(cfg: Config, deps?: { ghFn?: typeof gh; nowIso?: string }): Promise<void>` — called once per `pollGithubInbox` sweep, after the repo/issue loop (bridge cadence). Iterates `listPlanSetRecords(cfg)` where `github !== null && !closed`.

Behavior per record (write the implementation to match exactly):

1. `resolveSetState`. Compute `desiredLabel`: `allDone` → `ll.done`; `allTerminal && anyFailed` → `ll.failed`; `anyProcessing` → `ll.working`; else `ll.queued`.
2. Dashboard: render via `renderDashboard`; post-or-edit the `PLAN_STATUS_MARKER` comment — if `record.statusCommentId` is null, create via `gh api repos/{nwo}/issues/{n}/comments -f body=… --jq .id` and store the id in the record; else `gh api repos/{nwo}/issues/comments/{id} -X PATCH -f body=…`. Skip the gh call entirely when the rendered body is byte-identical to `record.lastDashboard` (add that string field to `PlanSetRecord` in this task — additive; default absent tolerated by the Task-4 reader since it only checks `v === 1`). A 404 on PATCH (comment deleted) → null the cached id and recreate next sweep. All dashboard gh calls are best-effort: catch, `log.warn`, continue.
3. Degraded: when `anyFailed && !record.degradedPosted`, post ONE durable comment via the outbox pattern (`tryOrEnqueue` with a `comment` op, same shape as githubReport's `guardOrQueue`) naming the failed task(s) and the parked dependents, then set `degradedPosted: true`.
4. Labels: when `desiredLabel !== record.lastLabel`, swap via the outbox-guarded label op (`add: [desiredLabel]`, `remove:` the previous `lastLabel ?? ll.queued`), update `record.lastLabel`.
5. When `allTerminal`: set `closed: true` (maintenance stops; a later supersede reopens by writing a fresh record).
6. Persist the record once per iteration if anything changed (`writePlanSetRecord`).

- [ ] **Step 1: Write the failing tests** — fake `gh` script that logs its argv to a file and prints `{"id": 555}` for the comment-create call (`gh api … --jq .id` → print `555`); assertions:

```ts
it("first maintenance posts the dashboard, stores the comment id, applies working label", async () => {
  /* seed a dispatched set with one processing child; run maintainPlanSets; assert gh log contains an api create with the marker body; record.statusCommentId === 555; labels swap queued→working; record.lastLabel updated */
});
it("unchanged state produces zero gh calls on the next sweep", async () => {
  /* run twice; gh log length unchanged after second run */
});
it("failure posts one degraded comment (once) and the failed label at all-terminal", async () => {
  /* seed done child + cascade-failed child; run; assert degraded comment once across two runs; label → failed; record.closed true */
});
```

(Write these as real tests with the planSetBridge fixture — queue dirs + records seeded on disk, fake gh via `makeConfig(seams, { ghBin: fakeGh, planSets: {...} })`. The fake gh must handle three argv shapes: `api …/comments` create, `api …/comments/<id> -X PATCH`, and `issue edit … --add-label …`; have it append `process.argv`-equivalent (`"$@"`) lines to a log file the test reads.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per the numbered behavior above. Key snippets:

```ts
async function upsertDashboard(
  cfg: Config,
  record: PlanSetRecord,
  body: string,
  ghFn: typeof gh,
): Promise<void> {
  const g = record.github as { nwo: string; issue: number };
  const dir = mkdtempSync(join(tmpdir(), "junco-dash-"));
  const file = join(dir, "body.md");
  writeFileSync(file, body, "utf8");
  try {
    if (record.statusCommentId === null) {
      const r = await ghFn(
        cfg,
        ["api", `repos/${g.nwo}/issues/${g.issue}/comments`, "-F", `body=@${file}`, "--jq", ".id"],
        { timeoutMs: GH_TIMEOUT },
      );
      const id = parseInt(r.stdout.trim(), 10);
      if (Number.isFinite(id)) record.statusCommentId = id;
    } else {
      const r = await ghFn(
        cfg,
        [
          "api",
          `repos/${g.nwo}/issues/comments/${record.statusCommentId}`,
          "-X",
          "PATCH",
          "-F",
          `body=@${file}`,
        ],
        { timeoutMs: GH_TIMEOUT },
      );
      if (r.code !== 0 && /404/.test(r.stderr)) record.statusCommentId = null; // recreate next sweep
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

(`gh()` throws on nonzero exit by default — wrap the PATCH in try/catch and null the id when the thrown message matches 404; verify against `git.ts`'s GitOpError text and note what you found in your report.) The degraded comment and label swaps reuse the exact `tryOrEnqueue`/`withCommentMarker` pattern from `githubReport.ts:115-145` — copy the small guard helper locally rather than importing reporter internals.

**Wiring:** at the end of `pollGithubInbox` (after the repo loop, before the return), when `cfg.planSets.enabled`:

```ts
try {
  await maintainPlanSets(cfg, { ghFn });
} catch (e) {
  log.warn("plan-set maintenance failed; queue unaffected", { error: errMsg(e) });
}
```

- [ ] **Step 4: Run to verify pass** (planSetBridge + githubInbox files) + typecheck.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planSetBridge.ts src/planSets.ts src/githubInbox.ts tests/planSetBridge.test.ts
git add -A && git commit -m "feat(bridge): sweep-driven plan-set dashboard, labels, and degraded comment"
```

---

### Task 11: Supersede

**Files:**

- Modify: `src/planSetBridge.ts`, `src/planSets.ts`
- Test: `tests/planSetBridge.test.ts`, `tests/planSets.test.ts`

**Interfaces:**

- Produces in `planSets.ts`: `supersedeUnclaimed(cfg: Config, record: PlanSetRecord, newHash: string): { disposed: string[] }` — every record child currently in `inbox/` gets a result block appended (`status: failed`, `superseded: <newHash>` inside the junco-result block) via tmp+rename, then moves to `failed/` via `uniqueDestPath`. One batch; NO `dependency_failed` markers and no metrics task-count (these never ran and are not failures of work — mirror `cascadeFail`'s file mechanics but not its marker or metrics call).
- Produces in `planSetBridge.ts`: supersede detection inside `maintainPlanSets`, BEFORE the dashboard/label steps, for records with `github !== null` (closed records included — supersede reopens a finished set):

1. Fetch the issue's labels + own plan comment (`findOwnPlanComment` — now exported). No comment → skip.
2. Compute `candidate = extractPlanSetBody(comment.body)`; skip when null or `hashPlan(candidate) === record.hash` (no change).
3. Approval rule: when `cfg.github.requireApproval`, require the `approved` label present AND `verifyLabelApplier(...).verdict === "ok"` AND `approval.atMs > comment.updatedAtMs` (same fail-closed numeric guards as the dispatch path). When `requireApproval` is false, an edit alone (hash difference) suffices.
4. Quiescence: `resolveSetState(...).anyProcessing` → log info `"plan set supersede deferred — children in flight"` and skip this sweep.
5. Dispose: `supersedeUnclaimed(cfg, record, newHash)`.
6. Recompile from `candidate` (`parsePlanSet` + `compilePlan` with the SAME `planId`); on compile errors: post the compile-failure comment (Task 9's shape) and leave the old record in place (children already disposed stay disposed — the human sees the errors and edits again; state is recoverable because done children are skipped by fan-out and disposed ones sit in failed/ with markers).
7. Fan-out (`submitPlanSet` — done tasks skip automatically via whole-queue idempotence), write a FRESH record: new `hash`, same `planId`, keep `statusCommentId`, reset `degradedPosted: false`, `closed: false`, keep `lastLabel`.
8. Remove the `approved` label (it authorized this supersede; leaving it would re-trigger).

- [ ] **Step 1: Write the failing tests**

```ts
// planSets.test.ts
it("supersedeUnclaimed disposes inbox children with a superseded marker; done/processing untouched", () => {
  /* seed inbox child + done child; call; assert inbox child now in failed/ with `superseded: newhash` in its junco-result block and NO dependency_failed; done child untouched; disposed list correct */
});

// planSetBridge.test.ts
it("supersede: edited+approved plan recompiles, skips done tasks, resets degraded/closed", async () => {
  /* fake gh serving labels + comments (own login, edited fence, approved label with later timestamp); seed record with done task a + queued task b; edited fence renames b's content and adds task c; run maintainPlanSets; assert b's old inbox file superseded-failed, new b + c in inbox, record.hash updated, approved label removal in gh log */
});
it("supersede defers while a child is processing", async () => {
  /* seed processing child; run; assert no disposal and an info-path (inbox unchanged) */
});
```

(The fake gh for this file grows a case serving `api repos/*/issues/*/comments --paginate` returning a JSON-lines comment with the junco-plan fence and `api repos/*/issues/*/events` / permission endpoints for `verifyLabelApplier`, plus `issue list`-style label reads — mirror how `tests/githubInbox.test.ts` fakes these endpoints today; reuse its helper script patterns rather than inventing new ones.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per the numbered behavior. `supersedeUnclaimed` core:

```ts
export function supersedeUnclaimed(
  cfg: Config,
  record: PlanSetRecord,
  newHash: string,
): { disposed: string[] } {
  const paths = queuePaths(cfg);
  const disposed: string[] = [];
  for (const t of record.tasks) {
    const f = findTicketFile(paths.inbox, t.ticketId);
    if (!f) continue; // done/processing/failed/absent — not ours to dispose
    const content = readFileSync(f, "utf8");
    const body =
      `${content.trimEnd()}\n\n---\n<!-- junco-result\n` +
      `status: failed\nsuperseded: ${newHash}\n-->\n\n## Result\n\n` +
      `> Superseded before running — the plan was edited and re-approved (rev \`${newHash}\`).\n`;
    const tmp = f + ".tmp";
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, f);
    mkdirSync(paths.failed, { recursive: true });
    renameSync(f, uniqueDestPath(paths.failed, basename(f)));
    disposed.push(t.ticketId);
  }
  return { disposed };
}
```

- [ ] **Step 4: Run to verify pass** (both files) + a full-suite run (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`) — the interplay with the dependency sweep is the risk; the Layer-1 resolver's inbox-over-failed precedence is what keeps new children waiting on resubmitted siblings instead of cascading, and existing ticketDeps tests must stay green.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planSetBridge.ts src/planSets.ts tests/planSetBridge.test.ts tests/planSets.test.ts
git add -A && git commit -m "feat(bridge): plan-set supersede on edited, re-approved plans"
```

---

### Task 12: CLI door — `junco submit --plan`

**Files:**

- Modify: `src/cli.ts` (submit handler ~972-1035; add `repo: { type: "string" }` to the parseArgs options if absent — `--plan` already exists as a global boolean used by unwatch)
- Test: `tests/cli.test.ts` (the existing `run(['submit', …])` describe block)

**Interfaces:**

- Consumes: `extractPlanSetBody` (githubInbox), `parsePlanSet`/`compilePlan`/`hashPlan` (planCompiler), `materializePlanSet`/`submitPlanSet` (planSets), `slugify` — check `src/slug.ts` for the exported name and signature; use it.

Behavior (implement exactly):

- `junco submit --plan <file> --repo <path>`: requires `planSets.enabled` (else stderr `junco submit: plan sets are disabled — set planSets.enabled in config.json` exit 1); requires `--repo` (else usage to stderr, exit 2); reads the file (stdin `-` unsupported with `--plan` — usage error), extracts the `junco-plan` fence (none → stderr `no junco-plan fence found in <file>`, exit 1), parses with `cfg.planSets.maxTasks` (errors → each on its own stderr line, exit 1), compiles with `planId = "plan-" + slug(basename(file, ".md"))`, `github: null`, `repoPath = resolve(expandHome(--repo))`; materializes; `submitPlanSet`; prints one `submitted: <path>` line per child (reuse the existing submit success print shape) plus a first line `plan set <planId> (<n> tasks, rev <hash>)`; exit 0. Duplicate re-submit (all children skipped) prints `plan set <planId>: all <n> tickets already in the queue` and exits 0.
- Local trust model: no approval machinery — the dispatcher is trusted exactly like every locally-authored ticket today (the junco-dispatch preview gate is the approval).

- [ ] **Step 1: Write the failing tests** (append to the submit describe block in `tests/cli.test.ts`, reusing its `run()` harness and tmp-config fixture; enable planSets via the fixture's config write)

```ts
it("submit --plan compiles a set into the inbox", async () => {
  /* write plan file with a 2-task junco-plan fence; run(["submit", "--plan", file, "--repo", repoDir]); expect code 0, stdout matches /plan set plan-/ and two submitted: lines; two ticket files in inbox with depends_on translated */
});
it("submit --plan refuses compile errors whole and dispatches nothing", async () => {
  /* fence with dup ids + cycle; expect exit 1, stderr lists 2+ errors, inbox empty */
});
it("submit --plan without --repo or with planSets disabled fails with guidance", async () => {
  /* two runs: missing --repo → exit 2; enabled:false → exit 1 with the disabled message */
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** in the submit handler, immediately after `content` is read and before the existing `submitTicket` call:

```ts
if (values.plan === true) {
  if (fileArg === "-") {
    process.stderr.write("Usage: junco submit --plan <file> --repo <path> (stdin not supported)\n");
    return 2;
  }
  const cfg2 = loadConfigFn(configPath);
  if (!cfg2.planSets.enabled) {
    process.stderr.write(
      "junco submit: plan sets are disabled — set planSets.enabled in config.json\n",
    );
    return 1;
  }
  const repoFlag = values.repo as string | undefined;
  if (!repoFlag) {
    process.stderr.write("Usage: junco submit --plan <file> --repo <path>\n");
    return 2;
  }
  const fence = extractPlanSetBody(content);
  if (fence === null) {
    process.stderr.write(`junco submit: no junco-plan fence found in '${fileArg}'\n`);
    return 1;
  }
  const parsed = parsePlanSet(fence, { maxTasks: cfg2.planSets.maxTasks });
  if (!parsed.ok) {
    for (const e of parsed.errors) process.stderr.write(`junco submit: plan error: ${e}\n`);
    return 1;
  }
  const planId = "plan-" + slugify(basename(fileArg).replace(/\.md$/, ""));
  const hash = hashPlan(fence);
  const children = compilePlan(parsed.plan, {
    planId,
    repoPath: resolve(expandHome(repoFlag)),
    hash,
    github: null,
  });
  materializePlanSet(
    cfg2,
    {
      v: 1,
      planId,
      hash,
      repoPath: resolve(expandHome(repoFlag)),
      github: null,
      tasks: children.map((c) => ({ id: c.taskId, ticketId: c.ticketId, dependsOn: c.dependsOn })),
      createdAt: new Date().toISOString(),
      statusCommentId: null,
      degradedPosted: false,
      lastLabel: null,
      closed: false,
    },
    fence,
  );
  const r = submitPlanSet(cfg2, children);
  printFn(`plan set ${planId} (${children.length} tasks, rev ${hash})\n`);
  if (r.submitted.length === 0) {
    printFn(`plan set ${planId}: all ${children.length} tickets already in the queue\n`);
    return 0;
  }
  for (const id of r.submitted) printFn(`submitted: ${join(inboxPath(cfg2), `${id}.md`)}\n`);
  return 0;
}
```

(Adjust the identifier names to the handler's actual locals — `loadConfigFn`, `printFn`, `values`, `positionals` — and import what's missing: `extractPlanSetBody`, `parsePlanSet`/`compilePlan`/`hashPlan`, `materializePlanSet`/`submitPlanSet`, `inboxPath`, `expandHome`, `resolve`, and slug.ts's export — check its real name with `grep "export" src/slug.ts` and use that. If `repo` isn't in parseArgs options, add `repo: { type: "string" }` and a `--repo` line to the help text near the existing `--plan` help entry, noting both meanings.)

- [ ] **Step 4: Run to verify pass** (cli test file) + typecheck.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/cli.ts tests/cli.test.ts
git add -A && git commit -m "feat(cli): junco submit --plan — the local plan-set door"
```

---

### Task 13: Parked Layer-1 polish tests

**Files:**

- Test: `tests/daemon.test.ts` (or `tests/runOnce.test.ts` — wherever the scheduler claim harness lives), `tests/retryCmd.test.ts`

Two tests parked at Layer-1 merge, no production code:

- [ ] **Step 1: Scheduler-mode dependency-gated claim** — in the scheduler tests' harness (real `claimNextTask`, not a stubbed `claimFn`): seed an inbox with a dep-blocked child (`depends_on: [ghost]`) and a free ticket; run `runScheduler` (or `mainLoop` with `maxConcurrent: 2`) with an `executeFn` spy and a stop-after-first-poll sleep; assert the spy ran only for the free ticket and the blocked child stayed in inbox. Follow the file's existing StopFlag + real-tick sleep idiom exactly.
- [ ] **Step 2: `retry --all` + cascade interaction** — seed failed/: a parent and a cascade-marked dependent (`dependency_failed: <parent>`); `runRetryCommand(cfg, [], { all: true })`; assert both land in inbox exactly once, no duplicate `-r` copies, exit 0, and output contains no `requeued (dependent):` line for a file the main loop already handled.
- [ ] **Step 3: Run both files + full suite once; commit**

```bash
npx prettier --write <touched test files>
git add -A && git commit -m "test: scheduler dependency-gated claim and retry --all cascade coverage"
```

---

### Task 14: Skill + docs + full gate

**Files:**

- Modify: `skills/junco-dispatch/SKILL.md`, `ARCHITECTURE.md`, `docs/tickets.md` (only if it gained frontmatter rows in Layer 1 — extend consistently)

- [ ] **Step 1: SKILL.md set authoring.** Keep it stack-agnostic. Two edits: (a) soften the "Multiple parallel branches / PRs per ticket" never-rule to state that multi-PR work is expressed as a SET of tickets with `depends_on` edges — one PR per ticket still holds; (b) extend the >180-min decomposition note into a short "Ticket sets" subsection: author N tickets, give each an explicit `id:`, reference sibling ids in `depends_on:`, submit in any order (edges wait), the worker executes in dependency order gating on merged PRs, `junco retry <parent>` revives a failed chain. Mention `junco submit --plan <file> --repo <path>` as the compiler-backed alternative when `planSets.enabled` is on: one `junco-plan` fenced document (show the same YAML shape as planPrompt's rule 6, abbreviated) instead of N hand-written tickets.
- [ ] **Step 2: ARCHITECTURE.md.** Module map rows for `planCompiler.ts`, `planSets.ts`, `planSetBridge.ts` (one line each, matching the table's voice). In the ticket-lifecycle section, extend the plan⇄execute paragraph: when `planSets.enabled` and the approved comment carries a `junco-plan` fence, the bridge compiles it into a dependency-ordered ticket SET, maintains a `junco:plan-status` dashboard comment and set-level labels each sweep, and an edited+re-approved plan supersedes the unclaimed remainder. Verify every claim against the code as landed.
- [ ] **Step 3: Full gate.** `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test` — fix stragglers (typical: prettier on markdown).
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: plan-set compiler, doors, and set authoring in skill and architecture docs"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** fence + compiler (T1-3, incl. the `^r?\d+$` ban and whole-error reporting), materialization to dataDir (T4), Layer-3 body rendering (T3), fan-out idempotence via whole-queue resolver (T6), planner teaching gated on `enabled` (T7), reporter suppression + sweep-owned set reporting incl. cascade feedback via dashboard/degraded comment (T8/T10 — closes the Layer-1 carry-note), bridge door with fail-closed error comment + submit-before-label (T9), supersede incl. quiescence, batch disposition without cascade markers, done-task skip, approval-label consumption (T11), CLI door (T12), parked polish (T13), skill/docs (T14).
- **Deliberate scope choices:** COMMENT_LIMIT refusal already exists in `buildPlanComment` (returns null → the planner-failure path fires) — no new work needed; noted here so reviewers don't hunt for a missing task. Dashboard edits are best-effort direct gh (not outboxed) — the sweep repaints; degraded comment and labels are outboxed. `plan_sets` re-cycling goes through supersede only; the single-ticket remove-label re-cycle gesture is unchanged.
- **Type consistency check:** `PlanParse`/`PlanSet`/`PlanTask`/`CompileCtx`/`CompiledChild` (T2/T3) are used with identical shapes in T9/T11/T12; `PlanSetRecord` fields (T4, +`lastDashboard` in T10) match every reader; `DispatchResult` only in T9; `resolveSetState`/`renderDashboard`/`submitPlanSet`/`supersedeUnclaimed` signatures consistent across T5/T6/T10/T11.
