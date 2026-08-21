# Plan-Driven Ticket Sets — Layer 1 (Dependency-Aware Queue) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tickets can declare `depends_on` edges; the daemon claims them only after every dependency is done **and its PR merged**, cascades dependents of failed parents to `failed/`, and `junco retry` resurrects a cascade transitively.

**Architecture:** A new pure module `src/ticketDeps.ts` holds the ticket-state resolver, the dependency sweep (merge-gated satisfaction stamping via an injectable PR-state probe), and the failure cascade. The claim path gains one pure frontmatter filter (`depends_on ⊆ deps_satisfied`); all analysis lives in the sweep, which the daemon runs ahead of each claim pass, throttled by `planSets.mergePollSeconds`. No new queue directories; no bridge coupling.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, zod (config), `yaml` (frontmatter). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-plan-driven-ticket-sets-design.md` (Layer 1 + Configuration + Error-handling + Testing sections)

## Global Constraints

- `src/ticketSchema.ts` is the stable public contract — **additive changes only**.
- Every side effect behind an injectable deps seam; tests never touch network or a real model; fake `gh` is an inline-generated shell script.
- New `Config` field goes in `tests/helpers/config.ts` and nowhere else (ballast, not a seam — nothing in phase 1 branches on `planSets.enabled`).
- `depends_on` handling is **always on** (never gated by `planSets.enabled`); it activates lazily when an edge exists.
- Cascade fires only on an affirmative negative signal (dep in `failed/`, or PR state CLOSED); `gh` errors → warn and wait.
- Resolver precedence: **done > processing > inbox > failed > absent** (satisfaction is monotone).
- Conventional commits, no AI attribution trailers, suite green at every commit, `npx prettier --write` on touched files before each commit.
- Full gate before claiming done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- Vitest exit-code trap: never pipe vitest into a filter; run `npx vitest run tests/<f>.test.ts > /tmp/out 2>&1; echo "exit: $?"` and read the file.

## File Structure

- `src/ticketDeps.ts` (new) — `ticketState`, `findTicketFile`, `sweepDependencies`, `listWaiting`, cascade internals. One responsibility: dependency semantics over the queue dirs.
- `tests/ticketDeps.test.ts` (new) — resolver + sweep + cascade unit tests (tmp queue dirs, fake `gh`).
- Modified: `src/ticketSchema.ts`, `src/types.ts`, `src/ticket.ts`, `src/config.ts`, `src/runOnce.ts`, `src/resultMeta.ts`, `src/daemon.ts`, `src/retryCmd.ts`, `src/listCmd.ts`, `src/statusCmd.ts`, `src/cli.ts`, `tests/helpers/config.ts`, plus their test files.

---

### Task 1: Schema + `Ticket` parse for `depends_on` / `deps_satisfied` / `plan`

**Files:**

- Modify: `src/ticketSchema.ts` (add three properties)
- Modify: `src/types.ts` (Ticket fields, after `network`)
- Modify: `src/ticket.ts` (parse the three keys)
- Test: `tests/ticket.test.ts`, `tests/ticketSchema.test.ts`

**Interfaces:**

- Produces: `Ticket.dependsOn: string[]`, `Ticket.depsSatisfied: string[]`, `Ticket.plan: { id: string; task: string | null; hash: string | null } | null` — consumed by every later task.

- [ ] **Step 1: Write the failing tests** (append to `tests/ticket.test.ts`)

```ts
describe("dependency fields (spec 2026-08-20)", () => {
  it("parses depends_on, deps_satisfied, and plan", () => {
    const t = parseTicket(
      "t.md",
      `---
depends_on: [a, b]
deps_satisfied: [a]
plan:
  id: gh-acme-api-1a2b3c4d-7
  task: t3
  hash: abc123def456
---
Body`,
    );
    expect(t.dependsOn).toEqual(["a", "b"]);
    expect(t.depsSatisfied).toEqual(["a"]);
    expect(t.plan).toEqual({ id: "gh-acme-api-1a2b3c4d-7", task: "t3", hash: "abc123def456" });
  });

  it("defaults: absent keys → empty arrays / null plan", () => {
    const t = parseTicket("t.md", "---\nid: x\n---\nBody");
    expect(t.dependsOn).toEqual([]);
    expect(t.depsSatisfied).toEqual([]);
    expect(t.plan).toBeNull();
  });

  it("coerces a scalar depends_on to a one-element list; drops non-string entries", () => {
    expect(parseTicket("t.md", "---\ndepends_on: a\n---\n").dependsOn).toEqual(["a"]);
    expect(parseTicket("t.md", "---\ndepends_on: [a, 3, '']\n---\n").dependsOn).toEqual(["a"]);
  });

  it("plan without a string id is rejected whole", () => {
    expect(parseTicket("t.md", "---\nplan:\n  task: t3\n---\n").plan).toBeNull();
  });
});
```

And in `tests/ticketSchema.test.ts`, add to the existing property assertions:

```ts
it("documents the plan-set keys (spec 2026-08-20)", () => {
  const props = (TICKET_FRONTMATTER_JSON_SCHEMA as { properties: Record<string, unknown> })
    .properties;
  expect(props.depends_on).toBeDefined();
  expect(props.deps_satisfied).toBeDefined();
  expect(props.plan).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ticket.test.ts tests/ticketSchema.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect FAIL (`dependsOn` undefined / schema property missing).

- [ ] **Step 3: Implement**

`src/types.ts` — add to `Ticket` after `network`:

```ts
/** Ticket ids that must be satisfied before claim (spec 2026-08-20): the dep
 * ticket done AND (when it opened a PR) that PR merged. Dispatcher-settable. */
dependsOn: string[];
/** Worker-managed: edges the dependency sweep (ticketDeps.ts) has confirmed
 * satisfied. Claim gates on depends_on ⊆ deps_satisfied — a pure subset check. */
depsSatisfied: string[];
/** Plan-set membership/provenance (spec 2026-08-20). Null = not part of a set. */
plan: { id: string; task: string | null; hash: string | null } | null;
```

`src/ticket.ts` — before the `return`, add:

```ts
const depsRaw = frontmatter.depends_on;
const dependsOn = Array.isArray(depsRaw)
  ? depsRaw.filter((d): d is string => typeof d === "string" && d.trim() !== "")
  : typeof depsRaw === "string" && depsRaw.trim() !== ""
    ? [depsRaw]
    : [];
const satRaw = frontmatter.deps_satisfied;
const depsSatisfied = Array.isArray(satRaw)
  ? satRaw.filter((d): d is string => typeof d === "string" && d.trim() !== "")
  : [];
const planRaw = frontmatter.plan;
let plan: Ticket["plan"] = null;
if (planRaw !== null && typeof planRaw === "object" && !Array.isArray(planRaw)) {
  const p = planRaw as Record<string, unknown>;
  // id is required (parity with github.nwo strictness); task/hash optional.
  if (typeof p.id === "string" && p.id.trim() !== "") {
    plan = {
      id: p.id,
      task: typeof p.task === "string" ? p.task : null,
      hash: typeof p.hash === "string" ? p.hash : null,
    };
  }
}
```

…and add `dependsOn, depsSatisfied, plan,` to the returned object.

`src/ticketSchema.ts` — add to `properties` (after `analyze`), copying the spec's wording:

```ts
depends_on: {
  type: "array",
  items: { type: "string" },
  description:
    "Ticket ids that must be satisfied before this ticket is claimed: each referenced ticket finished successfully AND (when it opened a pull request) that PR was merged. Unsatisfied edges leave the ticket queued; a terminally failed dependency parks this ticket in failed/ (dependency cascade).",
},
deps_satisfied: {
  type: "array",
  items: { type: "string" },
  description:
    "Worker-managed: depends_on entries the dependency sweep has confirmed satisfied. Do not set by hand.",
},
plan: {
  type: "object",
  description:
    "Optional plan-set membership/provenance: ties this ticket to a compiled plan. `hash` is worker-managed (content hash of the approved plan).",
  properties: {
    id: { type: "string", description: "Plan-set identifier." },
    task: { type: "string", description: "Task id within the plan that produced this ticket." },
    hash: { type: "string", description: "Worker-managed: approved-plan content hash." },
  },
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ticket.test.ts tests/ticketSchema.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect exit 0.

- [ ] **Step 5: Typecheck the whole tree; fix any `Ticket` literal it flags**

Run: `npm run typecheck`. Any test fixture constructing a full `Ticket` literal now needs `dependsOn: [], depsSatisfied: [], plan: null`. Add exactly those values wherever flagged (expected: few or none — most fixtures go through `parseTicket`).

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/ticketSchema.ts src/types.ts src/ticket.ts tests/ticket.test.ts tests/ticketSchema.test.ts
git add -A && git commit -m "feat(schema): depends_on, deps_satisfied, and plan ticket frontmatter"
```

---

### Task 2: `planSets` config section

**Files:**

- Modify: `src/types.ts` (PlanSetsConfig + Config field)
- Modify: `src/config.ts` (zod schema + assembly)
- Modify: `tests/helpers/config.ts` (ballast)
- Test: `tests/config.test.ts`

**Interfaces:**

- Produces: `cfg.planSets: { enabled: boolean; mergePollSeconds: number; maxTasks: number }` — `mergePollSeconds` consumed by Task 7; `enabled`/`maxTasks` reserved for phase 2 (documented, unused here).

- [ ] **Step 1: Write the failing test** (append to `tests/config.test.ts`, mirroring an existing section-defaults test — e.g. the `assess` one)

```ts
describe("planSets section (spec 2026-08-20)", () => {
  it("defaults: disabled, 60s merge poll, 10-task cap", () => {
    const cfg = loadFixture({}); // use this file's existing minimal-config loader helper
    expect(cfg.planSets).toEqual({ enabled: false, mergePollSeconds: 60, maxTasks: 10 });
  });

  it("explicit values parse through", () => {
    const cfg = loadFixture({
      planSets: { enabled: true, mergePollSeconds: 120, maxTasks: 5 },
    });
    expect(cfg.planSets).toEqual({ enabled: true, mergePollSeconds: 120, maxTasks: 5 });
  });
});
```

(`loadFixture` = whatever helper `tests/config.test.ts` already uses to write a JSON config to tmp and `loadConfig` it — reuse it verbatim; do not invent a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect FAIL (`planSets` undefined).

- [ ] **Step 3: Implement**

`src/types.ts` — after `BotAccountConfig`:

```ts
/** [planSets] — plan-driven ticket sets (spec 2026-08-20). `enabled` gates plan
 * COMPILATION (Layer 2, not yet implemented); the Layer-1 dependency machinery
 * (depends_on claim gating, merge sweep, cascade) is always on and activates
 * lazily per edge. `maxTasks` is the Layer-2 compiler cap (reserved). */
export interface PlanSetsConfig {
  enabled: boolean;
  mergePollSeconds: number;
  maxTasks: number;
}
```

…and in `Config`, after `botAccount`: `planSets: PlanSetsConfig;`

`src/config.ts` — in `ConfigSchema` after the `botAccount` entry:

```ts
planSets: z
  .object({
    enabled: z.boolean().default(false),
    mergePollSeconds: z.number().min(5).default(60),
    maxTasks: z.number().int().min(1).default(10),
  })
  .default({}),
```

…and in the assembly object after `botAccount`:

```ts
planSets: {
  enabled: d.planSets.enabled,
  mergePollSeconds: d.planSets.mergePollSeconds,
  maxTasks: d.planSets.maxTasks,
},
```

`tests/helpers/config.ts` — in the ballast section (after `botAccount`):

```ts
planSets: { enabled: false, mergePollSeconds: 60, maxTasks: 10 },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/config.test.ts tests/helpersConfig.test.ts > /tmp/out 2>&1; echo "exit: $?"` then `npm run typecheck`. `tests/daemon.test.ts` builds Config through the helper, so it should compile untouched; fix any other full-Config literal the typecheck flags by adding the same ballast line.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/types.ts src/config.ts tests/helpers/config.ts tests/config.test.ts
git add -A && git commit -m "feat(config): planSets section (mergePollSeconds; enabled/maxTasks reserved)"
```

---

### Task 3: `ticketState` resolver (`src/ticketDeps.ts`)

**Files:**

- Create: `src/ticketDeps.ts`
- Test: `tests/ticketDeps.test.ts` (new)

**Interfaces:**

- Produces: `type TicketState = "done" | "processing" | "inbox" | "failed" | "absent"`, `ticketState(paths: Paths, id: string): TicketState`, `findTicketFile(dir: string, id: string): string | null` — consumed by Tasks 4–9.

- [ ] **Step 1: Write the failing tests** (`tests/ticketDeps.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ticketState, findTicketFile } from "../src/ticketDeps.js";
import type { Paths } from "../src/types.js";

let root: string;
let paths: Paths;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "junco-deps-"));
  paths = {
    inbox: join(root, "inbox"),
    processing: join(root, "processing"),
    done: join(root, "done"),
    failed: join(root, "failed"),
  };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ticketState", () => {
  it("absent when the id is nowhere", () => {
    expect(ticketState(paths, "t1")).toBe("absent");
  });

  it("resolves each directory by exact filename", () => {
    writeFileSync(join(paths.inbox, "t1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("inbox");
  });

  it("matches through the claim-stamp prefix", () => {
    writeFileSync(join(paths.processing, "2026-08-20T1200Z__t1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("processing");
  });

  it("matches worker suffixes: -r1 (requeue) and -2 (uniqueDest)", () => {
    writeFileSync(join(paths.inbox, "t1-r1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("inbox");
    rmSync(join(paths.inbox, "t1-r1.md"));
    writeFileSync(join(paths.done, "2026-08-20T1200Z__t1-2.md"), "x");
    expect(ticketState(paths, "t1")).toBe("done");
  });

  it("does NOT match a different id sharing a prefix", () => {
    writeFileSync(join(paths.done, "t1-extra.md"), "x");
    expect(ticketState(paths, "t1")).toBe("absent");
  });

  it("precedence: done > processing > inbox > failed (satisfaction is monotone)", () => {
    writeFileSync(join(paths.failed, "t1.md"), "x");
    writeFileSync(join(paths.inbox, "t1-r1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("inbox");
    writeFileSync(join(paths.done, "2026-08-20T1200Z__t1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("done");
  });

  it("findTicketFile returns the matched path", () => {
    const p = join(paths.done, "2026-08-20T1200Z__t1.md");
    writeFileSync(p, "x");
    expect(findTicketFile(paths.done, "t1")).toBe(p);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ticketDeps.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect FAIL (module not found).

- [ ] **Step 3: Implement** (`src/ticketDeps.ts`)

```ts
/**
 * Layer 1 of plan-driven ticket sets (spec 2026-08-20): ticket-state resolver,
 * dependency sweep (merge-gated satisfaction stamping), and failure cascade.
 * Pure queue-directory machinery — no bridge coupling; the only network touch
 * is the injectable PR-state probe.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./types.js";
import { CLAIM_PREFIX_RE } from "./requeue.js";

export type TicketState = "done" | "processing" | "inbox" | "failed" | "absent";

/** Filename stem resolves to `id`: exact, or a worker suffix — `-r<n>`
 * (requeue.ts collision) or `-<n>` (uniqueDest.ts collision). A suffix that is
 * not purely r?\d+ is a DIFFERENT id sharing a prefix, never a match. */
function stemMatches(stem: string, id: string): boolean {
  if (stem === id) return true;
  if (!stem.startsWith(id + "-")) return false;
  return /^r?\d+$/.test(stem.slice(id.length + 1));
}

/** First .md file in `dir` whose name (claim stamp stripped) resolves to `id`. */
export function findTicketFile(dir: string, id: string): string | null {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return null; // missing dir = empty box (same stance as discoverTasks)
  }
  for (const n of names) {
    const stem = n.replace(CLAIM_PREFIX_RE, "").replace(/\.md$/, "");
    if (stemMatches(stem, id)) return join(dir, n);
  }
  return null;
}

/** Resolve a ticket id to its queue state. Precedence done > processing >
 * inbox > failed (spec: satisfaction is monotone — once a task has a done
 * record it stays satisfied, whatever superseded/requeued siblings exist). */
export function ticketState(paths: Paths, id: string): TicketState {
  if (findTicketFile(paths.done, id)) return "done";
  if (findTicketFile(paths.processing, id)) return "processing";
  if (findTicketFile(paths.inbox, id)) return "inbox";
  if (findTicketFile(paths.failed, id)) return "failed";
  return "absent";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/ticketDeps.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/ticketDeps.ts tests/ticketDeps.test.ts
git add -A && git commit -m "feat(deps): ticketState resolver over the queue directories"
```

---

### Task 4: Claim predicate in `claimNextTask`

**Files:**

- Modify: `src/runOnce.ts:154-159` (after the not_before filter)
- Test: `tests/runOnce.test.ts`

**Interfaces:**

- Consumes: `Ticket.dependsOn` / `Ticket.depsSatisfied` (Task 1).

- [ ] **Step 1: Write the failing test** (append to `tests/runOnce.test.ts`, reusing that file's existing tmp-queue + `makeConfig` fixture idiom for `claimNextTask` tests)

```ts
describe("claimNextTask dependency gate (spec 2026-08-20)", () => {
  it("skips a ticket with unsatisfied depends_on; claims once deps_satisfied covers it", async () => {
    // Arrange with THIS file's existing fixture helpers: a cfg whose queueRoot
    // is a fresh tmp dir, inbox created.
    writeFileSync(join(inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\nBody");
    expect(await claimNextTask(cfg)).toBeNull();

    writeFileSync(
      join(inbox, "child.md"),
      "---\nid: child\ndepends_on: [parent]\ndeps_satisfied: [parent]\n---\nBody",
    );
    const work = await claimNextTask(cfg);
    expect(work?.ticket.id).toBe("child");
  });

  it("an unblocked sibling is claimed past a blocked one", async () => {
    writeFileSync(join(inbox, "blocked.md"), "---\nid: blocked\ndepends_on: [p]\n---\n");
    writeFileSync(join(inbox, "free.md"), "---\nid: free\n---\n");
    const work = await claimNextTask(cfg);
    expect(work?.ticket.id).toBe("free");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/runOnce.test.ts > /tmp/out 2>&1; echo "exit: $?"` — first test FAILS (blocked child gets claimed).

- [ ] **Step 3: Implement** — in `claimNextTask`, immediately after the `if (eligible.length === 0) return null;` of the not_before filter:

```ts
// Dependency gate (spec 2026-08-20): claim only when every depends_on edge
// has been confirmed by the dependency sweep (ticketDeps.ts). Pure frontmatter
// subset check — all satisfaction analysis (done-state, PR merge) lives in the
// sweep, which the daemon runs ahead of each claim pass.
const unblocked = eligible.filter((t) => t.dependsOn.every((d) => t.depsSatisfied.includes(d)));
if (unblocked.length === 0) return null;
```

…and change the claim loop header from `for (const t of eligible)` to `for (const t of unblocked)`. (The readiness gate between them keeps reading `eligible.length` for its log — change that to `unblocked.length` and move the readiness gate AFTER the dependency filter so a fully-blocked queue never probes the endpoint.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/runOnce.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/runOnce.ts tests/runOnce.test.ts
git add -A && git commit -m "feat(claim): gate claiming on satisfied depends_on edges"
```

---

### Task 5: Dependency sweep — satisfaction stamping

**Files:**

- Modify: `src/ticketDeps.ts`
- Test: `tests/ticketDeps.test.ts`

**Interfaces:**

- Consumes: `parseResultMeta` (`src/resultMeta.ts`), `upsertFrontmatterKey` (`src/requeue.ts`), `gh` (`src/git.ts`), `queuePaths` (`src/config.ts`).
- Produces: `sweepDependencies(cfg: Config, deps?: DepSweepDeps): Promise<DepSweepReport>` with `DepSweepDeps { prStateFn?: (cfg: Config, prUrl: string) => Promise<PrState> }`, `type PrState = "merged" | "open" | "closed" | "unknown"`, `interface DepSweepReport { stamped: number; cascaded: number }` — consumed by Tasks 6–7.

- [ ] **Step 1: Write the failing tests** (append to `tests/ticketDeps.test.ts`; extend the fixture with a `makeConfig` import — seams literal `{ dataDir: join(root, "data"), queueRoot: root, worktreeRoot: join(root, "wt"), tools: [], criticEnabled: false, planLintEnabled: false, verifyEnabled: false, supervisorEnabled: false, healthEnabled: false, removeWorktreeOnSuccess: true }` so `queuePaths(cfg)` resolves to the `paths` dirs already created)

```ts
describe("sweepDependencies — satisfaction stamping", () => {
  it("no-PR parent in done/ → stamps deps_satisfied", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nBody\n\n---\n<!-- junco-result\nstatus: completed\n-->\n\n## Result\n\nok\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(cfg);
    expect(r.stamped).toBe(1);
    const t = parseTicket("child.md", readFileSync(join(paths.inbox, "child.md"), "utf8"));
    expect(t.depsSatisfied).toEqual(["parent"]);
  });

  it("parent with pr_url → merged stamps, open waits", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const open = await sweepDependencies(cfg, { prStateFn: async () => "open" });
    expect(open.stamped).toBe(0);
    const merged = await sweepDependencies(cfg, { prStateFn: async () => "merged" });
    expect(merged.stamped).toBe(1);
  });

  it("unknown PR state (gh error) → waits, never cascades", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(cfg, { prStateFn: async () => "unknown" });
    expect(r).toEqual({ stamped: 0, cascaded: 0 });
    expect(existsSync(join(paths.inbox, "child.md"))).toBe(true);
  });

  it("absent / queued / in-flight dep → waits; ticket with no edges → no-op", async () => {
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [ghost]\n---\n");
    writeFileSync(join(paths.inbox, "plain.md"), "---\nid: plain\n---\n");
    const r = await sweepDependencies(cfg);
    expect(r).toEqual({ stamped: 0, cascaded: 0 });
  });

  it("default prStateFn shells the configured ghBin and maps MERGED", async () => {
    const fakeGh = join(root, "gh");
    writeFileSync(fakeGh, `#!/bin/sh\necho '{"state":"MERGED"}'\n`, { mode: 0o755 });
    const ghCfg = makeConfig(seams, { ghBin: fakeGh });
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(ghCfg);
    expect(r.stamped).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ticketDeps.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect FAIL (`sweepDependencies` not exported).

- [ ] **Step 3: Implement** — add to `src/ticketDeps.ts` (new imports: `readFileSync, writeFileSync, renameSync` from node:fs; `Config, Ticket` types; `queuePaths` from config.js; `parseTicket` from ticket.js; `parseResultMeta` from resultMeta.js; `upsertFrontmatterKey` from requeue.js; `gh` from git.js; `log` from logging.js):

```ts
export type PrState = "merged" | "open" | "closed" | "unknown";

export interface DepSweepDeps {
  /** PR-state probe (default: `gh pr view <url> --json state` via cfg.ghBin). */
  prStateFn?: (cfg: Config, prUrl: string) => Promise<PrState>;
}

export interface DepSweepReport {
  stamped: number;
  cascaded: number;
}

async function defaultPrState(cfg: Config, prUrl: string): Promise<PrState> {
  try {
    const r = await gh(cfg, ["pr", "view", prUrl, "--json", "state"]);
    if (r.code !== 0) return "unknown";
    const state = (JSON.parse(r.stdout) as { state?: string }).state;
    if (state === "MERGED") return "merged";
    if (state === "OPEN") return "open";
    if (state === "CLOSED") return "closed";
    return "unknown";
  } catch {
    return "unknown"; // unreachable gh / bad JSON — wait, never cascade (spec)
  }
}

/** Inbox tickets with at least one unconfirmed edge. Per-ticket defensive
 * parse, same stance as claimNextTask: one bad file never wedges the sweep. */
function readWaiting(paths: Paths, defaultTimeoutMinutes: number): Ticket[] {
  let names: string[] = [];
  try {
    names = readdirSync(paths.inbox).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Ticket[] = [];
  for (const n of names) {
    const p = join(paths.inbox, n);
    try {
      const t = parseTicket(p, readFileSync(p, "utf8"), defaultTimeoutMinutes);
      if (t.dependsOn.some((d) => !t.depsSatisfied.includes(d))) out.push(t);
    } catch {
      /* unreadable/vanished — the claim path logs these */
    }
  }
  return out;
}

/** Confirm one edge in the child's frontmatter (worker-managed key), atomic
 * tmp+rename in place — the .tmp name is invisible to the daemon's .md glob. */
function stampSatisfied(t: Ticket, depId: string): void {
  const content = readFileSync(t.path, "utf8");
  const next = [...new Set([...t.depsSatisfied, depId])];
  const updated = upsertFrontmatterKey(content, "deps_satisfied", `[${next.join(", ")}]`);
  const tmp = t.path + ".tmp";
  writeFileSync(tmp, updated, "utf8");
  renameSync(tmp, t.path);
  log.info("dependency satisfied", { id: t.id, dep: depId });
}

/**
 * The dependency sweep (spec 2026-08-20): for every inbox ticket with an
 * unconfirmed depends_on edge, resolve the dep —
 *   absent | inbox | processing → wait
 *   failed                      → cascade (Task 6)
 *   done, no PR recorded        → stamp deps_satisfied
 *   done, PR recorded           → merged → stamp · open/unknown → wait ·
 *                                 closed-unmerged → cascade (Task 6)
 * Runs in the daemon loop ahead of the claim pass (single process, serial —
 * the in-place frontmatter stamp cannot race a claim). Lazy: a queue with no
 * edges costs one readdir.
 */
export async function sweepDependencies(
  cfg: Config,
  deps: DepSweepDeps = {},
): Promise<DepSweepReport> {
  const paths = queuePaths(cfg);
  const prStateFn = deps.prStateFn ?? defaultPrState;
  const prCache = new Map<string, PrState>(); // one probe per PR per sweep
  const report: DepSweepReport = { stamped: 0, cascaded: 0 };
  for (;;) {
    const waiting = readWaiting(paths, cfg.defaultTimeoutMinutes);
    let changed = false;
    for (const t of waiting) {
      for (const d of t.dependsOn.filter((x) => !t.depsSatisfied.includes(x))) {
        const state = ticketState(paths, d);
        if (state === "absent" || state === "inbox" || state === "processing") continue;
        if (state === "failed") {
          // Cascade lands in Task 6; until then, wait (fail-safe).
          continue;
        }
        const doneFile = findTicketFile(paths.done, d);
        if (!doneFile) continue; // raced away between state check and read
        const prUrl = parseResultMeta(readFileSync(doneFile, "utf8")).prUrl;
        if (prUrl === null) {
          stampSatisfied(t, d);
          report.stamped++;
          changed = true;
          continue;
        }
        const pr = prCache.get(prUrl) ?? (await prStateFn(cfg, prUrl));
        prCache.set(prUrl, pr);
        if (pr === "merged") {
          stampSatisfied(t, d);
          report.stamped++;
          changed = true;
        }
        // open/unknown → wait; closed → cascade in Task 6.
      }
    }
    if (!changed) return report;
  }
}
```

(`Paths` import already present from Task 3.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/ticketDeps.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/ticketDeps.ts tests/ticketDeps.test.ts
git add -A && git commit -m "feat(deps): dependency sweep with merge-gated satisfaction stamping"
```

---

### Task 6: Failure cascade + `resultMeta.dependencyFailed`

**Files:**

- Modify: `src/resultMeta.ts` (one field)
- Modify: `src/ticketDeps.ts` (cascade; wire the two `continue` placeholders from Task 5)
- Test: `tests/ticketDeps.test.ts`, `tests/resultMeta.test.ts` if it exists (else the resultMeta assertions live in `tests/ticketDeps.test.ts`)

**Interfaces:**

- Produces: `ResultMeta.dependencyFailed: string | null`; cascade behavior inside `sweepDependencies` — consumed by Task 8 (retry resurrection).

- [ ] **Step 1: Write the failing tests** (append to `tests/ticketDeps.test.ts`)

```ts
describe("sweepDependencies — failure cascade", () => {
  it("failed dep → dependent finalized to failed/ with dependency_failed marker", async () => {
    writeFileSync(join(paths.failed, "parent.md"), "---\nid: parent\n---\n");
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\nBody");
    const r = await sweepDependencies(cfg);
    expect(r.cascaded).toBe(1);
    expect(existsSync(join(paths.inbox, "child.md"))).toBe(false);
    const rec = readFileSync(join(paths.failed, "child.md"), "utf8");
    expect(parseResultMeta(rec).status).toBe("failed");
    expect(parseResultMeta(rec).dependencyFailed).toBe("parent");
  });

  it("cascade is transitive within one sweep", async () => {
    writeFileSync(join(paths.failed, "a.md"), "---\nid: a\n---\n");
    writeFileSync(join(paths.inbox, "b.md"), "---\nid: b\ndepends_on: [a]\n---\n");
    writeFileSync(join(paths.inbox, "c.md"), "---\nid: c\ndepends_on: [b]\n---\n");
    const r = await sweepDependencies(cfg);
    expect(r.cascaded).toBe(2);
    expect(parseResultMeta(readFileSync(join(paths.failed, "c.md"), "utf8")).dependencyFailed).toBe(
      "b",
    );
  });

  it("PR closed without merge → cascade", async () => {
    writeFileSync(
      join(paths.done, "parent.md"),
      "---\nid: parent\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/7\n-->\n",
    );
    writeFileSync(join(paths.inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
    const r = await sweepDependencies(cfg, { prStateFn: async () => "closed" });
    expect(r.cascaded).toBe(1);
    expect(findTicketFile(paths.failed, "child")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ticketDeps.test.ts > /tmp/out 2>&1; echo "exit: $?"` — cascade tests FAIL (cascaded stays 0).

- [ ] **Step 3: Implement**

`src/resultMeta.ts` — add `dependencyFailed: string | null;` to `ResultMeta`, `dependencyFailed: null` to the absent-block return, and `dependencyFailed: field("dependency_failed")` to the parsed return.

`src/ticketDeps.ts` — add imports `mkdirSync` (node:fs), `basename` (node:path), `uniqueDestPath` from uniqueDest.js, `metrics` from metrics.js. Add:

```ts
/** Park a waiting dependent in failed/ with a machine-readable marker (spec:
 * dependency_failed cascade). Mirrors finalize.ts's tmp+rename + uniqueDest
 * move; zero usage — no session ever ran. */
function cascadeFail(paths: Paths, t: Ticket, failedDepId: string): void {
  const content = readFileSync(t.path, "utf8");
  const body =
    `${content.trimEnd()}\n\n---\n<!-- junco-result\n` +
    `status: failed\ndependency_failed: ${failedDepId}\n-->\n\n## Result\n\n` +
    `> **Failed.** Dependency \`${failedDepId}\` failed terminally; this ticket was parked by ` +
    `the dependency cascade before it ran. \`junco retry ${failedDepId}\` re-releases it with ` +
    `that parent (or retry this ticket directly once the dependency is resolved).\n`;
  const tmp = t.path + ".tmp";
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, t.path);
  mkdirSync(paths.failed, { recursive: true });
  const dst = uniqueDestPath(paths.failed, basename(t.path));
  renameSync(t.path, dst);
  metrics.recordTask("failed", { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 }, 0);
  log.warn("dependency failed — cascading dependent to failed/", {
    id: t.id,
    dep: failedDepId,
    dst,
  });
}
```

…and replace the two Task-5 wait-placeholders inside `sweepDependencies`:

```ts
if (state === "failed") {
  cascadeFail(paths, t, d);
  report.cascaded++;
  changed = true;
  break; // this ticket is gone from inbox — stop iterating its edges
}
```

…and after the `pr === "merged"` branch:

```ts
else if (pr === "closed") {
  cascadeFail(paths, t, d);
  report.cascaded++;
  changed = true;
  break;
}
```

(The `changed`-triggered fixpoint re-scan is what makes the cascade transitive: b lands in failed/, the next pass sees c's dep failed.)

- [ ] **Step 4: Run to verify pass; run neighbors**

Run: `npx vitest run tests/ticketDeps.test.ts tests/resultMeta.test.ts tests/listCmd.test.ts > /tmp/out 2>&1; echo "exit: $?"` (listCmd consumes parseResultMeta — must stay green). Expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/ticketDeps.ts src/resultMeta.ts tests/ticketDeps.test.ts
git add -A && git commit -m "feat(deps): failure cascade with dependency_failed markers"
```

---

### Task 7: Daemon wiring — throttled sweep in both loop modes

**Files:**

- Modify: `src/daemon.ts` (`MainLoopDeps` + `mainLoop`)
- Test: `tests/daemon.test.ts`

**Interfaces:**

- Consumes: `sweepDependencies` (Task 5/6), `cfg.planSets.mergePollSeconds` (Task 2).
- Produces: `MainLoopDeps.depSweepFn?: typeof sweepDependencies` seam.

- [ ] **Step 1: Write the failing tests** (append to `tests/daemon.test.ts`; use the file's existing `makeDeps` + `StopFlag` + config helpers)

```ts
describe("dependency sweep wiring (spec 2026-08-20)", () => {
  it("serial loop runs the dep sweep each eligible tick, throttled by mergePollSeconds", async () => {
    const stop = new StopFlag();
    let polls = 0;
    const depSweepFn = vi.fn(async () => ({ stamped: 0, cascaded: 0 }));
    const { deps } = makeDeps({
      depSweepFn,
      sleep: vi.fn(async () => {
        if (++polls >= 2) stop.requestStop();
        await new Promise((r) => setTimeout(r, 1)); // real tick — scheduler-test gotcha
      }),
    });
    // Throttle window spans both polls → exactly one sweep.
    await mainLoop(makeCfg(), stop, {}, deps);
    expect(depSweepFn).toHaveBeenCalledTimes(1);
  });

  it("mergePollSeconds: 0 override sweeps every poll", async () => {
    const stop = new StopFlag();
    let polls = 0;
    const depSweepFn = vi.fn(async () => ({ stamped: 0, cascaded: 0 }));
    const { deps } = makeDeps({
      depSweepFn,
      sleep: vi.fn(async () => {
        if (++polls >= 2) stop.requestStop();
        await new Promise((r) => setTimeout(r, 1));
      }),
    });
    await mainLoop(
      makeCfg({ planSets: { enabled: false, mergePollSeconds: 0, maxTasks: 10 } }),
      stop,
      {},
      deps,
    );
    expect(depSweepFn).toHaveBeenCalledTimes(2);
  });

  it("scheduler mode (maxConcurrent > 1) also sweeps", async () => {
    const stop = new StopFlag();
    const depSweepFn = vi.fn(async () => ({ stamped: 0, cascaded: 0 }));
    const { deps } = makeDeps({
      depSweepFn,
      sleep: vi.fn(async () => {
        stop.requestStop();
        await new Promise((r) => setTimeout(r, 1));
      }),
    });
    await mainLoop(makeCfg({ maxConcurrent: 2 }), stop, {}, deps);
    expect(depSweepFn).toHaveBeenCalled();
  });

  it("a throwing sweep is contained (loop keeps polling)", async () => {
    const stop = new StopFlag();
    let polls = 0;
    const { deps } = makeDeps({
      depSweepFn: vi.fn(async () => {
        throw new Error("boom");
      }),
      sleep: vi.fn(async () => {
        if (++polls >= 2) stop.requestStop();
        await new Promise((r) => setTimeout(r, 1));
      }),
    });
    await expect(mainLoop(makeCfg(), stop, {}, deps)).resolves.toBeUndefined();
    expect(polls).toBeGreaterThanOrEqual(2);
  });
});
```

(`makeCfg` = this test file's existing config-builder name — use whatever it is actually called there; it layers overrides on the shared `makeConfig` helper, so `planSets` ballast exists from Task 2.)

- [ ] **Step 2: Type + run to verify failure**

`makeDeps` builds `Required<MainLoopDeps>` — adding `depSweepFn` to the interface (Step 3) without adding a default stub there is a type error; the tests fail first at compile. Run: `npx vitest run tests/daemon.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect FAIL (unknown `depSweepFn` property).

- [ ] **Step 3: Implement**

`src/daemon.ts`:

- Import: `import { sweepDependencies } from "./ticketDeps.js";`
- Add to `MainLoopDeps`: `/** Dependency sweep seam (spec 2026-08-20); default sweepDependencies. */ depSweepFn?: typeof sweepDependencies;`
- In `mainLoop`, directly after the `maybeOutboxDrain` closure:

```ts
// Dependency sweep (spec 2026-08-20): stamps deps_satisfied for done+merged
// parents and cascades dependents of failed ones. Mode-agnostic — runs with
// the bridge disabled — and lazy: a queue with no depends_on edges costs one
// readdir per throttled tick.
const depSweepFn = deps.depSweepFn ?? sweepDependencies;
let lastDepSweepMs = -Infinity;
const maybeDepSweep = async (): Promise<void> => {
  if (monoMs() - lastDepSweepMs < activeCfg().planSets.mergePollSeconds * 1000) return;
  lastDepSweepMs = monoMs();
  try {
    await depSweepFn(activeCfg());
  } catch (e) {
    log.warn("dependency sweep failed; queue unaffected", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
```

(Note: `maybeDepSweep` reads `activeCfg()`, which is declared after the outbox closure in the current file — declare `maybeDepSweep` after `activeCfg` if the executor hits a use-before-declaration lint; the call sites below are all later.)

- Serial loop: after `await maybeOutboxDrain();` add `await maybeDepSweep();`
- Scheduler call: extend the composite passed as `maybeBridgeSweepFn`:

```ts
maybeBridgeSweepFn: async () => {
  await maybeBridgeSweep();
  await maybeOutboxDrain();
  await maybeDepSweep();
},
```

`tests/daemon.test.ts` `makeDeps`: add the default stub `depSweepFn: vi.fn(async () => ({ stamped: 0, cascaded: 0 })),`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/daemon.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/daemon.ts tests/daemon.test.ts
git add -A && git commit -m "feat(daemon): throttled dependency sweep in serial and scheduler loops"
```

---

### Task 8: `junco retry` — transitive cascade resurrection

**Files:**

- Modify: `src/retryCmd.ts`
- Test: `tests/retryCmd.test.ts`

**Interfaces:**

- Consumes: `parseResultMeta().dependencyFailed` (Task 6), `parseTicket` (existing).

- [ ] **Step 1: Write the failing test** (append to `tests/retryCmd.test.ts`, reusing its tmp-queue fixture)

```ts
describe("dependency-cascade resurrection (spec 2026-08-20)", () => {
  it("retrying a parent drags back its cascaded dependents, transitively", async () => {
    writeFileSync(
      join(failedDir, "a.md"),
      "---\nid: a\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\n-->\n\n## Result\n\nx\n",
    );
    writeFileSync(
      join(failedDir, "b.md"),
      "---\nid: b\ndepends_on: [a]\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\ndependency_failed: a\n-->\n",
    );
    writeFileSync(
      join(failedDir, "c.md"),
      "---\nid: c\ndepends_on: [b]\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\ndependency_failed: b\n-->\n",
    );
    const out: string[] = [];
    const code = await runRetryCommand(cfg, ["a"], {}, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(existsSync(join(inbox, "a.md"))).toBe(true);
    expect(existsSync(join(inbox, "b.md"))).toBe(true);
    expect(existsSync(join(inbox, "c.md"))).toBe(true);
    expect(out.join("")).toContain("requeued (dependent):");
  });

  it("an unrelated failed ticket is left alone", async () => {
    writeFileSync(
      join(failedDir, "a.md"),
      "---\nid: a\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\n-->\n",
    );
    writeFileSync(
      join(failedDir, "z.md"),
      "---\nid: z\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\n-->\n",
    );
    await runRetryCommand(cfg, ["a"], {}, { printFn: () => {} });
    expect(existsSync(join(failedDir, "z.md"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/retryCmd.test.ts > /tmp/out 2>&1; echo "exit: $?"` — first test FAILS (b/c stay in failed/).

- [ ] **Step 3: Implement** — in `src/retryCmd.ts`:
- Imports: add `import { parseResultMeta } from "./resultMeta.js";` and `import { parseTicket } from "./ticket.js";`
- In the main `for (const entry of targets)` loop, collect ids: declare `const retried = new Set<string>();` before the loop and after the successful `unlinkSync(src)` add `retried.add(parseTicket(cleanName, content).id);` (explicit frontmatter id wins; filename stem is the fallback).
- After the main loop, before the return:

```ts
// Dependency-cascade resurrection (spec 2026-08-20): a retried parent drags
// back the dependents its failure cascade parked — transitively, so one
// `junco retry <parent>` re-queues the whole chain. Keyed on the machine
// marker cascadeFail wrote (dependency_failed in the last junco-result block).
let grew = retried.size > 0;
while (grew) {
  grew = false;
  let remaining: string[] = [];
  try {
    remaining = readdirSync(failedDir).filter((n) => n.endsWith(".md"));
  } catch {
    break;
  }
  for (const entry of remaining) {
    const src = join(failedDir, entry);
    let raw: string;
    try {
      raw = readFileSync(src, "utf8");
    } catch {
      continue;
    }
    const dep = parseResultMeta(raw).dependencyFailed;
    if (dep === null || !retried.has(dep)) continue;
    try {
      let clean = stripResultArtifacts(raw);
      clean = removeFrontmatterKey(clean, "retry_count");
      clean = removeFrontmatterKey(clean, "not_before");
      const cleanName = entry.replace(CLAIM_PREFIX_RE, "");
      const dst = submitTicket(cfg, clean, { idHint: cleanName.replace(/\.md$/, "") });
      unlinkSync(src);
      retried.add(parseTicket(cleanName, clean).id);
      grew = true;
      print(`requeued (dependent): ${dst}\n`);
    } catch (e) {
      failures++;
      print(`junco retry: ${entry}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/retryCmd.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/retryCmd.ts tests/retryCmd.test.ts
git add -A && git commit -m "feat(retry): resurrect dependency-cascaded dependents transitively"
```

---

### Task 9: Visibility — `list` annotation, `status` counts, `submit` dangling warning

**Files:**

- Modify: `src/ticketDeps.ts` (add `listWaiting`)
- Modify: `src/listCmd.ts` (inbox `waiting on:` tag)
- Modify: `src/statusCmd.ts` (waiting count + missing-edge warning)
- Modify: `src/cli.ts` (submit warning, after the `submitted:` print)
- Test: `tests/ticketDeps.test.ts`, `tests/listCmd.test.ts`, `tests/statusCmd.test.ts`

**Interfaces:**

- Produces: `listWaiting(cfg: Config): { id: string; pending: string[]; missing: string[] }[]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ticketDeps.test.ts`:

```ts
describe("listWaiting", () => {
  it("reports pending and missing edges per waiting ticket", () => {
    writeFileSync(join(paths.done, "a.md"), "---\nid: a\n---\n");
    writeFileSync(join(paths.inbox, "w.md"), "---\nid: w\ndepends_on: [a, ghost]\n---\n");
    expect(listWaiting(cfg)).toEqual([{ id: "w", pending: ["a", "ghost"], missing: ["ghost"] }]);
  });
});
```

Append to `tests/listCmd.test.ts` (reusing its fixture):

```ts
it("annotates inbox tickets waiting on dependencies", async () => {
  writeFileSync(join(inbox, "child.md"), "---\nid: child\ndepends_on: [parent]\n---\n");
  const out: string[] = [];
  await runListCommand(cfg, "inbox", { printFn: (s) => out.push(s) });
  expect(out.join("")).toContain("[waiting on: parent]");
});
```

Append to `tests/statusCmd.test.ts` (reusing its fixture — the offline/no-daemon path):

```ts
it("surfaces dependency-waiting tickets and missing edges", async () => {
  writeFileSync(join(inbox, "w.md"), "---\nid: w\ndepends_on: [ghost]\n---\n");
  const out: string[] = [];
  await runStatusCommand(cfg, { printFn: (s) => out.push(s), fetchFn: failingFetch });
  const text = out.join("");
  expect(text).toContain("waiting:   1 on dependencies");
  expect(text).toContain("w waits on missing ticket(s): ghost");
});
```

(`failingFetch` = however this test file already forces the health-endpoint-down path — reuse its existing idiom.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ticketDeps.test.ts tests/listCmd.test.ts tests/statusCmd.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect FAIL.

- [ ] **Step 3: Implement**

`src/ticketDeps.ts`:

```ts
export interface WaitingInfo {
  id: string;
  /** Unconfirmed depends_on edges. */
  pending: string[];
  /** Pending edges that resolve to no ticket anywhere — likely typos or a
   * half-submitted set (spec: dangling edges wait; the CLI surfaces them). */
  missing: string[];
}

/** CLI-facing view of dependency-waiting inbox tickets (list/status/submit). */
export function listWaiting(cfg: Config): WaitingInfo[] {
  const paths = queuePaths(cfg);
  return readWaiting(paths, cfg.defaultTimeoutMinutes).map((t) => {
    const pending = t.dependsOn.filter((d) => !t.depsSatisfied.includes(d));
    return {
      id: t.id,
      pending,
      missing: pending.filter((d) => ticketState(paths, d) === "absent"),
    };
  });
}
```

`src/listCmd.ts` — add `import { parseTicket } from "./ticket.js";` and in the per-entry loop, alongside the done/failed status-tag branch:

```ts
if (b === "inbox") {
  try {
    const t = parseTicket(join(dir, e.n), readFileSync(join(dir, e.n), "utf8"));
    const pending = t.dependsOn.filter((d) => !t.depsSatisfied.includes(d));
    if (pending.length > 0) statusTag = `  [waiting on: ${pending.join(", ")}]`;
  } catch {
    /* vanished between stat and read → no tag */
  }
}
```

`src/statusCmd.ts` — add `import { listWaiting } from "./ticketDeps.js";` and after the `queue:` print:

```ts
// Dependency-waiting surface (spec 2026-08-20) — silent when no edges exist.
const waiting = listWaiting(cfg);
if (waiting.length > 0) {
  print(`waiting:   ${waiting.length} on dependencies\n`);
  for (const w of waiting.filter((x) => x.missing.length > 0)) {
    print(`⚠ ${w.id} waits on missing ticket(s): ${w.missing.join(", ")}\n`);
  }
}
```

`src/cli.ts` — in the submit handler after `printFn(\`submitted: ${dst}\n\`)`, add (imports: `parseTicket`from ticket.js,`ticketState`from ticketDeps.js,`queuePaths` from config.js — check which are already imported):

```ts
// Dangling-edge warning (spec 2026-08-20): submit never refuses — sets may
// arrive out of order — but a dep that exists nowhere is probably a typo.
const submitted = parseTicket(basename(dst), content);
const missing = submitted.dependsOn.filter(
  (d) => !submitted.depsSatisfied.includes(d) && ticketState(queuePaths(cfg), d) === "absent",
);
if (missing.length > 0) {
  process.stderr.write(
    `junco submit: warning — depends_on references no queued or finished ticket: ${missing.join(", ")} (the ticket will wait until they exist)\n`,
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/ticketDeps.test.ts tests/listCmd.test.ts tests/statusCmd.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/ticketDeps.ts src/listCmd.ts src/statusCmd.ts src/cli.ts tests/listCmd.test.ts tests/statusCmd.test.ts tests/ticketDeps.test.ts
git add -A && git commit -m "feat(cli): dependency visibility in list, status, and submit"
```

---

### Task 10: Documentation + full gate

**Files:**

- Modify: `ARCHITECTURE.md` (ticket-lifecycle section + module map)
- Modify: `docs/tickets.md` (if it documents frontmatter keys — add `depends_on`/`deps_satisfied`/`plan` rows matching the schema descriptions verbatim; skip if the file defers to `junco schema`)

- [ ] **Step 1: Update `ARCHITECTURE.md`**

In the module map, add a row for `ticketDeps.ts`: "Dependency-aware queue (spec 2026-08-20): ticket-state resolver, merge-gated dependency sweep, failure cascade, CLI waiting view." In the "Ticket lifecycle through the queue" section, extend the `claim()` line's gate note from "(not_before-gated; skipped while its repo is busy)" to also name the dependency gate, and add after the `inbox/` entry a short note:

```
  (depends_on-gated: the dependency sweep — daemon loop, every
   planSets.mergePollSeconds — stamps deps_satisfied once a dep
   ticket is done AND its PR merged; a failed dep cascades this
   ticket to failed/ with a dependency_failed marker, and
   `junco retry <dep>` resurrects the cascade transitively)
```

- [ ] **Step 2: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test` — all green. Fix anything it surfaces before committing (typical stragglers: prettier on ARCHITECTURE.md, an unused import).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: dependency-aware queue in ARCHITECTURE and ticket docs"
```

---

## Self-Review Notes (already applied)

- Spec coverage: schema (T1), config (T2), resolver (T3), claim predicate (T4), sweep incl. no-PR conditional + PR probe keyed on the parent's recorded `pr_url` (T5), cascade + affirmative-signal-only rule (T6), daemon both modes + containment (T7), retry resurrection (T8), list/status/submit visibility incl. dangling warning (T9), docs (T10). Not in scope here (phase 2, per spec): `junco-plan` fence, compiler, bridge door, dashboard, supersede, `enabled`/`maxTasks` consumers.
- The Task-5 sweep ships with failed/closed edges deliberately inert (wait) and Task 6 activates the cascade — each commit is green and behavior-honest.
- Type consistency: `sweepDependencies(cfg, deps?) → Promise<DepSweepReport>`, `ticketState(paths, id)`, `findTicketFile(dir, id)`, `listWaiting(cfg)`, `ResultMeta.dependencyFailed` are used with identical signatures across tasks.
