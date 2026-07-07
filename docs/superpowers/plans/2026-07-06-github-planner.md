# GitHub Planner Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the planner stage to the default GitHub PR path: raw trigger-labeled issues get a daemon-authored plan (junco-dispatch discipline, read-only session against the clone), the plan is posted on the issue for review, and only the approved plan becomes an execution ticket. Spec: `docs/superpowers/specs/2026-07-02-github-inbox-design.md` (revision of 2026-07-06).

**Architecture:** Delta on the merged v1 bridge (branch `feat/github-inbox`). New module `src/planPrompt.ts` (loads `skills/junco-dispatch/TEMPLATE.md` as the single-source discipline); `src/githubInbox.ts` gains three lifecycle labels, plan extraction/comment helpers, a planning-ticket builder, and an approval scan; `src/githubReport.ts` gains kind-aware plan behavior; `executeClaimed` gains a planner-model-id swap. Planning tickets ride the existing Q&A rails untouched.

**Tech Stack:** TypeScript (Node ≥22.19, ESM/NodeNext, strict), vitest, zod, `gh` CLI via the existing `gh()` wrapper.

## Global Constraints

- **No AI attribution, ever** in commits or PRs. No new dependencies (exact-pin policy moot — none added).
- **`src/ticketSchema.ts` is additive-only**; never widen the Q&A read-only default. The planner emits body only; frontmatter is machine-built (security boundary — preserve it in every task).
- **Vitest exit-code trap:** `npx vitest run <files> > /tmp/out 2>&1; echo "exit: $?"` — never pipe into a filter.
- **Prettier before every commit** on touched files; re-read files the formatter touched before further edits.
- **Config fixture gotcha:** Task 1 adds two keys to `Config.github`; EVERY test fixture with a full `github` object literal must gain them (runtime failures, not compile-time). Verification greps are part of the task.
- **Live-runtime rule:** never `junco start` from the repo root; sandbox any manual smoke.
- Suite green at every commit; conventional commits on `feat/github-inbox`.

---

### Task 1: Config — `require_approval` + `planner_model_id` (+ fixture sweep)

**Files:**

- Modify: `src/types.ts` (GithubConfig, ~line 50)
- Modify: `src/config.ts` (TomlSchema github block + loadConfig return)
- Test: `tests/config.test.ts`
- Modify (fixture sweep): every test file whose `github:` literal was added by the v1 plan — enumerate with `grep -ln "triggerLabel" tests/*.ts`

**Interfaces:**

- Produces: `GithubConfig` gains `requireApproval: boolean` (default true) and `plannerModelId: string | null`. All later tasks read `cfg.github.requireApproval` / `cfg.github.plannerModelId`.

- [ ] **Step 1: Failing tests.** In `tests/config.test.ts`, extend the `[github] config section` describe:

In the existing "defaults" test, change the `toEqual` expectation object to include the new keys:

```ts
expect(cfg.github).toEqual({
  enabled: false,
  triggerLabel: "junco",
  askLabel: "junco:ask",
  pollIntervalSeconds: 60,
  repos: [],
  requireApproval: true,
  plannerModelId: null,
});
```

Append two new cases inside the same describe:

```ts
it("parses require_approval and planner_model_id", () => {
  const cfg = loadConfig(
    writeToml(
      `vault_root = "/tmp/v"\n[github]\nrequire_approval = false\nplanner_model_id = "prov/big"\n`,
    ),
  );
  expect(cfg.github.requireApproval).toBe(false);
  expect(cfg.github.plannerModelId).toBe("prov/big");
});

it("rejects an empty planner_model_id", () => {
  expect(() =>
    loadConfig(writeToml(`vault_root = "/tmp/v"\n[github]\nplanner_model_id = ""\n`)),
  ).toThrow();
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/config.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL (unknown keys).

- [ ] **Step 3: Implement.** `src/types.ts`, inside `GithubConfig` after `pollIntervalSeconds`:

```ts
requireApproval: boolean; // false ⇒ plan-ready auto-executes next sweep
plannerModelId: string | null; // planning-session model id override (same endpoint)
```

`src/config.ts`, inside the `github` zod object after `poll_interval_seconds`:

```ts
      require_approval: z.boolean().default(true),
      planner_model_id: z.string().min(1).optional(),
```

and in the `loadConfig` return's `github` object after `pollIntervalSeconds`:

```ts
      requireApproval: d.github.require_approval,
      plannerModelId: d.github.planner_model_id ?? null,
```

- [ ] **Step 4: Fixture sweep.** The v1 sweep left two literal shapes. Single-line fixtures:

```bash
perl -0pi -e 's/github: \{ enabled: false, triggerLabel: "junco", askLabel: "junco:ask", pollIntervalSeconds: 60, repos: \[\] \}/github: { enabled: false, triggerLabel: "junco", askLabel: "junco:ask", pollIntervalSeconds: 60, repos: [], requireApproval: true, plannerModelId: null }/g' tests/*.ts
```

Multi-line fixtures (prettier reflowed some — e.g. `tests/prFlow.test.ts`, `tests/daemon.test.ts`, `tests/runOnce.test.ts`):

```bash
perl -0pi -e 's/(github: \{\n(\s+)enabled: false,\n\s+triggerLabel: "junco",\n\s+askLabel: "junco:ask",\n\s+pollIntervalSeconds: 60,\n)(\s+)repos: \[\],\n/$1$3repos: [],\n$3requireApproval: true,\n$3plannerModelId: null,\n/g' tests/*.ts
```

Also update inline bridge/daemon test configs that spread partial github objects (`tests/githubInbox.test.ts` `cfg` const, `tests/githubReport.test.ts` `cfg` const, `tests/daemon.test.ts` `bridgeGithub()` helper, `tests/doctor.test.ts` `okConfig.github`) — add `requireApproval: true, plannerModelId: null` to each literal.

Verify completeness (must print nothing):

```bash
grep -ln "triggerLabel" tests/*.ts | xargs grep -L "requireApproval"
```

- [ ] **Step 5: Full suite + build** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0; `npm run build > /tmp/out2 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/types.ts src/config.ts tests/
git add -A src tests && git commit -m "feat(config): [github] require_approval + planner_model_id"
```

---

### Task 2: Ticket kind `plan` (additive schema)

**Files:**

- Modify: `src/types.ts` (`TicketGithub.kind`)
- Modify: `src/ticket.ts` (parseTicket kind guard)
- Modify: `src/ticketSchema.ts` (github.kind enum)
- Test: `tests/ticket.test.ts`, `tests/ticketSchema.test.ts`

**Interfaces:**

- Produces: `TicketGithub.kind: "pr" | "ask" | "plan"`. Tasks 6–9 dispatch on `"plan"`.

- [ ] **Step 1: Failing tests.** `tests/ticket.test.ts`, append inside the parseTicket describe:

```ts
it("accepts kind: plan in the github block", () => {
  const t = parseTicket(
    "/q/a.md",
    `---\nid: gh-a-b-1-plan\nworkdir: /tmp/c\ngithub:\n  nwo: a/b\n  issue: 1\n  kind: plan\n---\nbody`,
  );
  expect(t.github?.kind).toBe("plan");
});
```

`tests/ticketSchema.test.ts`, append:

```ts
it("github.kind enum includes plan", () => {
  const s = JSON.parse(describeTicketSchema()) as {
    properties: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
  };
  expect(s.properties.github.properties?.kind.enum).toEqual(["pr", "ask", "plan"]);
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/ticket.test.ts tests/ticketSchema.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** `src/types.ts`:

```ts
kind: "pr" | "ask" | "plan";
```

`src/ticket.ts`, in the github-block guard, change the kind check to:

```ts
g.kind === "pr" || g.kind === "ask" || g.kind === "plan";
```

`src/ticketSchema.ts`, the github.kind property:

```ts
        kind: { type: "string", enum: ["pr", "ask", "plan"], description: "Execution path." },
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/types.ts src/ticket.ts src/ticketSchema.ts tests/ticket.test.ts tests/ticketSchema.test.ts
git add -A src tests && git commit -m "feat(ticket): additive plan kind in the github provenance block"
```

---

### Task 3: Lifecycle labels — planning / plan-ready / approved + eligibility

**Files:**

- Modify: `src/githubInbox.ts` (`LifecycleLabels`, `lifecycleLabels`, `isEligible`, `LABEL_SPECS`)
- Test: `tests/githubInbox.test.ts`

**Interfaces:**

- Produces: `LifecycleLabels` gains `planning`, `planReady` (label text `<trigger>:plan-ready`), `approved`. `isEligible` excludes planning + plan-ready but NOT approved. `ensureLabels` creates all 8.

- [ ] **Step 1: Failing tests.** In `tests/githubInbox.test.ts`, replace the `lifecycleLabels` expectation:

```ts
expect(lifecycleLabels("bot")).toEqual({
  queued: "bot:queued",
  working: "bot:working",
  done: "bot:done",
  failed: "bot:failed",
  denied: "bot:denied",
  planning: "bot:planning",
  planReady: "bot:plan-ready",
  approved: "bot:approved",
});
```

In the `isEligible` describe, extend the lifecycle-exclusion array with `"junco:planning"`, `"junco:plan-ready"` and add:

```ts
it("approved alone does NOT block eligibility (neutralized by the timestamp rule)", () => {
  expect(isEligible(issue(["junco", "junco:approved"]), "junco")).toBe(true);
});
```

In the `pollGithubInbox` caching test, change the expected label-create count from 5 to 8.

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubInbox.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** `src/githubInbox.ts` — extend the interface and factory:

```ts
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
```

`isEligible` — exclude the two new bridge-applied states (approved is human-applied and non-blocking):

```ts
export function isEligible(issue: GhIssue, trigger: string): boolean {
  const names = new Set(issue.labels.map((l) => l.name));
  if (!names.has(trigger)) return false;
  const ll = lifecycleLabels(trigger);
  return ![ll.queued, ll.working, ll.done, ll.failed, ll.denied, ll.planning, ll.planReady].some(
    (n) => names.has(n),
  );
}
```

`LABEL_SPECS` — append three rows (approved is pre-created so humans can pick it in the label UI):

```ts
  ["planning", "C5DEF5", "junco: authoring a plan from this issue"],
  ["planReady", "D4A72C", "junco: plan posted — review the plan comment"],
  ["approved", "54AEFF", "apply AFTER reviewing the plan comment to authorize execution"],
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts tests/githubInbox.test.ts
git add -A src tests && git commit -m "feat(github): planner lifecycle labels + eligibility exclusions"
```

---

### Task 4: `src/planPrompt.ts` — template loading + planner prompt

**Files:**

- Create: `src/planPrompt.ts`
- Test: `tests/planPrompt.test.ts` (new)

**Interfaces:**

- Produces (consumed by Tasks 5, 6, 10):

```ts
export const PLAN_FENCE = "junco-ticket";
export function loadDispatchTemplate(): string; // throws when TEMPLATE.md unreadable
export function buildPlannerPrompt(opts: {
  title: string;
  body: string;
  nwo: string;
  parent: { title: string; body: string | null } | null;
}): string;
```

- [ ] **Step 1: Failing tests.** Create `tests/planPrompt.test.ts`:

````ts
import { describe, it, expect } from "vitest";
import { loadDispatchTemplate, buildPlannerPrompt, PLAN_FENCE } from "../src/planPrompt.js";

describe("loadDispatchTemplate", () => {
  it("loads the real shipped template (single source with the skill)", () => {
    const t = loadDispatchTemplate();
    expect(t).toContain("# Junco ticket template");
    expect(t).toContain("## Steps");
    expect(t).toContain("## Verification");
  });
});

describe("buildPlannerPrompt", () => {
  const opts = {
    title: "Add rate limiting",
    body: "Uploads hammer the API.",
    nwo: "acme/api",
    parent: null,
  };

  it("contains the fence instruction, the template, and the issue", () => {
    const p = buildPlannerPrompt(opts);
    expect(p).toContain("```" + PLAN_FENCE);
    expect(p).toContain("# Junco ticket template");
    expect(p).toContain("Add rate limiting");
    expect(p).toContain("Uploads hammer the API.");
    expect(p).toContain("acme/api");
    expect(p).toContain("Do NOT include a frontmatter block");
  });

  it("appends parent context when present", () => {
    const p = buildPlannerPrompt({
      ...opts,
      parent: { title: "Perf umbrella", body: "Track all perf work." },
    });
    expect(p).toContain("Parent issue (background only)");
    expect(p).toContain("Perf umbrella");
  });

  it("handles an empty issue body", () => {
    const p = buildPlannerPrompt({ ...opts, body: "" });
    expect(p).toContain("_(the issue has no body — plan from the title and the repo)_");
  });
});
````

- [ ] **Step 2: Verify failure** — `npx vitest run tests/planPrompt.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL (module missing).

- [ ] **Step 3: Implement.** Create `src/planPrompt.ts`:

````ts
/**
 * Planner prompt assembly — the daemon-side reuse of the junco-dispatch
 * authoring discipline. skills/junco-dispatch/TEMPLATE.md is the SINGLE
 * SOURCE for the plan shape (shared verbatim with the interactive skill);
 * only the preamble below is daemon-specific. EXAMPLE.md is appended as a
 * shape anchor when readable.
 *
 * The planner emits the ticket BODY ONLY inside a ```junco-ticket fence —
 * frontmatter is machine-built by the bridge (security boundary: model
 * output can never set repo:/workdir:/tools:).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLAN_FENCE = "junco-ticket";

// dist/ and src/ are both direct children of the package root, so one level
// up from this module reaches skills/ in both the built and vitest layouts.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_PATH = join(PACKAGE_ROOT, "skills", "junco-dispatch", "TEMPLATE.md");
const EXAMPLE_PATH = join(PACKAGE_ROOT, "skills", "junco-dispatch", "EXAMPLE.md");

let templateCache: string | null = null;

/** Read TEMPLATE.md (cached). Throws when unreadable — planning must fail
 * loud rather than plan without the discipline; `doctor` preflights this. */
export function loadDispatchTemplate(): string {
  if (templateCache === null) {
    templateCache = readFileSync(TEMPLATE_PATH, "utf8");
  }
  return templateCache;
}

function loadExample(): string | null {
  try {
    return readFileSync(EXAMPLE_PATH, "utf8");
  } catch {
    return null; // shape anchor only — never blocks planning
  }
}

export function buildPlannerPrompt(opts: {
  title: string;
  body: string;
  nwo: string;
  parent: { title: string; body: string | null } | null;
}): string {
  const template = loadDispatchTemplate();
  const example = loadExample();
  const issueBody = opts.body.trim();

  const parts: string[] = [
    `You are the PLANNER for the junco worker. A GitHub issue on \`${opts.nwo}\` has been
dispatched, and your ONLY job this session is to author an execution plan for it —
you implement nothing.

Rules:

1. Your working directory is a read-only clone of the repository. EXPLORE IT before
   writing the plan: read the build manifest (package.json / pyproject.toml /
   Cargo.toml), and read the actual files you will cite. Verify every path, symbol,
   and signature you reference — never from memory.
2. Follow the ticket template below EXACTLY. Populate every section; write \`_None._\`
   for a genuinely inapplicable one rather than dropping it.
3. If the issue already contains a complete, template-shaped plan, adopt it with
   minimal corrections instead of rewriting it.
4. Do NOT include a frontmatter block (no \`---\` header) — the worker builds
   frontmatter itself. Start the plan at the \`# <title>\` heading.
5. Your FINAL message must contain the finished plan inside a single fenced block
   tagged \`${PLAN_FENCE}\`, and nothing else of substance:

\`\`\`${PLAN_FENCE}
# <verb-first title>
...every template section...
\`\`\`

A missing or empty fence fails the ticket.`,
    `--- TICKET TEMPLATE (follow the body sections; ignore its frontmatter guidance) ---\n\n${template}`,
  ];
  if (example) {
    parts.push(`--- WORKED EXAMPLES (shape anchors) ---\n\n${example}`);
  }
  parts.push(
    `--- THE ISSUE TO PLAN ---\n\n# ${opts.title}\n\n${issueBody || "_(the issue has no body — plan from the title and the repo)_"}`,
  );
  if (opts.parent) {
    const pBody = (opts.parent.body ?? "").trim();
    parts.push(
      `--- Parent issue (background only — the instruction is the issue above) ---\n\n**${opts.parent.title}**${pBody ? `\n\n${pBody}` : ""}`,
    );
  }
  return parts.join("\n\n") + "\n";
}
````

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planPrompt.ts tests/planPrompt.test.ts
git add -A src tests && git commit -m "feat(github): planner prompt — single-sourced from the junco-dispatch template"
```

---

### Task 5: Plan extraction + plan comment helpers

**Files:**

- Modify: `src/githubInbox.ts` (pure helpers; imports `PLAN_FENCE` from `./planPrompt.js`)
- Test: `tests/githubInbox.test.ts`

**Interfaces:**

- Produces (consumed by Tasks 7, 8):

```ts
export const PLAN_COMMENT_MARKER = "<!-- junco:plan -->";
export function extractPlanBody(text: string): string | null; // last fence, frontmatter-stripped
export function buildPlanComment(
  planBody: string,
  opts: { issue: number; trigger: string; requireApproval: boolean },
): string | null; // null = too large for a GitHub comment
```

- [ ] **Step 1: Failing tests.** Append to `tests/githubInbox.test.ts`:

````ts
import { extractPlanBody, buildPlanComment, PLAN_COMMENT_MARKER } from "../src/githubInbox.js";

describe("extractPlanBody", () => {
  const fenced = (inner: string) => "chatter\n\n```junco-ticket\n" + inner + "\n```\n\ntrailing";

  it("extracts the fenced plan body", () => {
    expect(extractPlanBody(fenced("# Title\n\n## Steps\n- do"))).toBe("# Title\n\n## Steps\n- do");
  });

  it("takes the LAST fence when several exist (newer plan supersedes)", () => {
    const text = fenced("# Old") + "\n\n" + fenced("# New");
    expect(extractPlanBody(text)).toBe("# New");
  });

  it("strips a smuggled frontmatter block", () => {
    const out = extractPlanBody(fenced("---\nrepo: /etc\ntools: [bash]\n---\n# Title\nbody"));
    expect(out).toBe("# Title\nbody");
    expect(out).not.toContain("repo:");
  });

  it("returns null when no fence or an empty fence", () => {
    expect(extractPlanBody("no fence here")).toBeNull();
    expect(extractPlanBody("```junco-ticket\n   \n```")).toBeNull();
  });
});

describe("buildPlanComment", () => {
  it("carries the marker, the fenced plan, and approval instructions", () => {
    const c = buildPlanComment("# Plan\n## Steps", {
      issue: 42,
      trigger: "junco",
      requireApproval: true,
    });
    expect(c).not.toBeNull();
    expect(c).toContain(PLAN_COMMENT_MARKER);
    expect(c).toContain("```junco-ticket\n# Plan\n## Steps\n```");
    expect(c).toContain("junco:approved");
    expect(extractPlanBody(c!)).toBe("# Plan\n## Steps"); // round-trips
  });

  it("auto mode says it executes on the next sweep", () => {
    const c = buildPlanComment("# P", { issue: 1, trigger: "junco", requireApproval: false });
    expect(c).toContain("next sweep");
    expect(c).not.toContain("junco:approved");
  });

  it("returns null when the plan cannot fit a comment", () => {
    expect(
      buildPlanComment("x".repeat(70_000), { issue: 1, trigger: "junco", requireApproval: true }),
    ).toBeNull();
  });
});
````

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubInbox.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** In `src/githubInbox.ts` (add `import { PLAN_FENCE } from "./planPrompt.js";` and the frontmatter regex near the top of the helpers section):

````ts
export const PLAN_COMMENT_MARKER = "<!-- junco:plan -->";

// Mirrors ticket.ts FRONTMATTER_RE — used to STRIP a smuggled block, never to parse it.
const SMUGGLED_FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n?/;

/** Pull the plan body out of the LAST ```junco-ticket fence in `text` (planner
 * finalText or a plan comment — same format both places). Any frontmatter block
 * inside the fence is stripped: frontmatter is machine-owned, model output and
 * issue text can never set repo:/workdir:/tools:. Null = no usable plan. */
export function extractPlanBody(text: string): string | null {
  const re = new RegExp("```" + PLAN_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "g");
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1];
  if (last === null) return null;
  const stripped = last.replace(SMUGGLED_FRONTMATTER_RE, "").trim();
  return stripped === "" ? null : stripped;
}

/** Render the ONE plan comment: marker (machine-recoverable) + instructions +
 * the plan in a fence (readable AND re-extractable). Null when the result
 * would blow GitHub's comment cap — the caller fails the plan instead of
 * truncating the machine copy. */
export function buildPlanComment(
  planBody: string,
  opts: { issue: number; trigger: string; requireApproval: boolean },
): string | null {
  const next = opts.requireApproval
    ? `review it, then apply \`${opts.trigger}:approved\` to execute. You can EDIT this comment first — the edited plan is what runs.`
    : `it will execute on the next sweep (\`require_approval = false\`). You can still EDIT this comment before then.`;
  const out =
    `${PLAN_COMMENT_MARKER}\n**Proposed plan** for #${opts.issue} — ${next}\n\n` +
    "```" +
    PLAN_FENCE +
    "\n" +
    planBody +
    "\n```\n" +
    `\n_Re-plan: remove \`${opts.trigger}:plan-ready\` (a newer plan comment supersedes this one)._\n`;
  return out.length > 60_000 ? null : out;
}
````

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts tests/githubInbox.test.ts
git add -A src tests && git commit -m "feat(github): plan extraction + plan comment helpers (frontmatter-strip defense)"
```

---

### Task 6: Sweep — new issues become planning tickets

**Files:**

- Modify: `src/githubInbox.ts` (`buildPlanningTicket`; new-issue branch of the sweep)
- Test: `tests/githubInbox.test.ts`

**Interfaces:**

- Consumes: `buildPlannerPrompt` (Task 4), labels (Task 3).
- Produces: `buildPlanningTicket(issue, repo, parent): { id, content }` (exported for tests); the sweep's new-issue path submits it and applies `<trigger>:planning`. Ask issues keep the direct path + `queued`. `issueToTicket` keeps serving the ask path.

- [ ] **Step 1: Failing tests.** In `tests/githubInbox.test.ts`:

Rewrite the existing "bridges an eligible issue: submit then queued label" test to the new expectation:

```ts
it("bridges an eligible PR issue into a PLANNING ticket + planning label", async () => {
  const f = makeFakes({ issues: [rawIssue], events: labeledEvent, permission: "write" });
  const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
  expect(n).toBe(1);
  expect(f.submitted).toHaveLength(1);
  expect(f.submitted[0].idHint).toBe("gh-acme-api-42-plan");
  expect(f.submitted[0].content).toContain("kind: plan");
  expect(f.submitted[0].content).toContain("workdir:");
  expect(f.submitted[0].content).not.toContain("\nrepo:");
  expect(f.submitted[0].content).toContain("# Junco ticket template"); // discipline embedded
  expect(f.submitted[0].content).toContain("Add rate limiting"); // the issue
  const edit = f.calls.find((c) => c[0] === "issue" && c[1] === "edit");
  expect(edit).toContain("junco:planning");
  expect(edit).not.toContain("junco:queued");
});

it("ask issues keep the direct path: verbatim ask ticket + queued label", async () => {
  const askIssue = { ...rawIssue, labels: [{ name: "junco" }, { name: "junco:ask" }] };
  const f = makeFakes({ issues: [askIssue], events: labeledEvent, permission: "write" });
  const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
  expect(n).toBe(1);
  expect(f.submitted[0].idHint).toBe("gh-acme-api-42");
  expect(f.submitted[0].content).toContain("kind: ask");
  const edit = f.calls.find((c) => c[0] === "issue" && c[1] === "edit");
  expect(edit).toContain("junco:queued");
});
```

Update the two older tests that asserted the queued label on the PR path — "duplicate submit still applies the queued label" becomes planning-label (`expect(f.calls.find((c) => c[1] === "edit" && c.includes("junco:planning"))).toBeDefined();` and the throwing submit's message uses id `gh-acme-api-42-plan`), and "includes parent context when the issue is a sub-issue" now asserts on the planner prompt containing `Parent issue (background only)` instead of `## Context: parent issue`.

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubInbox.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** In `src/githubInbox.ts` (import `buildPlannerPrompt` too):

```ts
/** Materialize the PLANNING ticket for a raw PR issue: Q&A rails (workdir,
 * read-only), kind "plan", body = the full planner prompt (transparent — the
 * inbox file shows exactly what the planner was asked). */
export function buildPlanningTicket(
  issue: GhIssue,
  repo: GithubRepoMapping,
  parent: { title: string; body: string | null } | null,
): { id: string; content: string } {
  const [owner, name] = repo.nwo.split("/");
  const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const id = `gh-${slug(owner)}-${slug(name)}-${issue.number}-plan`;
  const fm = [
    "---",
    `id: ${id}`,
    `workdir: ${JSON.stringify(repo.path)}`,
    "github:",
    `  nwo: ${JSON.stringify(repo.nwo)}`,
    `  issue: ${issue.number}`,
    "  kind: plan",
    "---",
  ];
  const prompt = buildPlannerPrompt({
    title: issue.title,
    body: issue.body ?? "",
    nwo: repo.nwo,
    parent,
  });
  return { id, content: fm.join("\n") + "\n\n" + prompt };
}
```

In the sweep's per-issue loop, replace the single convert-and-queue block with a kind split (ask keeps `issueToTicket`; note `issueToTicket` no longer needs its `kind === "pr"` branch exercised by the bridge, but stays as-is for compatibility):

```ts
const isAsk = issue.labels.some((l) => l.name === cfg.github.askLabel);
const parent = isAsk ? null : await fetchParent(cfg, repo.nwo, issue.number, ghFn);
const t = isAsk ? issueToTicket(issue, repo, cfg, null) : buildPlanningTicket(issue, repo, parent);
const stateLabel = isAsk ? ll.queued : ll.planning;
try {
  submitFn(cfg, t.content, { idHint: t.id });
} catch (e) {
  if (!errMsg(e).includes("already queued")) throw e;
  log.info("github bridge: ticket already queued; re-marking", { id: t.id });
}
await ghFn(
  cfg,
  ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", stateLabel],
  { timeoutMs: GH_TIMEOUT, retryNetwork: true },
);
bridged++;
log.info("github bridge: dispatched issue", {
  nwo: repo.nwo,
  issue: issue.number,
  id: t.id,
  kind: isAsk ? "ask" : "plan",
});
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts tests/githubInbox.test.ts
git add -A src tests && git commit -m "feat(github): sweep plans raw PR issues; asks keep the direct path"
```

---

### Task 7: Sweep — approval scan → execution ticket

**Files:**

- Modify: `src/githubInbox.ts` (generalize the applier check; viewer-login cache; approval branch; `buildExecutionTicket`)
- Test: `tests/githubInbox.test.ts`

**Interfaces:**

- Consumes: Tasks 3, 5.
- Produces: `BridgeState` gains `login: string | null`; `buildExecutionTicket(issue, repo, planBody): { id, content }` (exported for tests). Internal: `verifyLabelApplier(cfg, nwo, issueNumber, label, ghFn): Promise<{ verdict: "ok" | "denied" | "unverified"; atMs: number | null }>` (rewires the trigger gate too); `findOwnPlanComment(...): Promise<{ body: string; createdAtMs: number } | null>`.

- [ ] **Step 1: Failing tests.** Append to `tests/githubInbox.test.ts` (extend `makeFakes` with `comments` and `viewer` options; events gain `created_at`):

````ts
// In makeFakes opts: comments?: unknown[]; viewer?: string;
// Add handlers to its ghFn:
//   if (args[0] === "api" && args[1] === "user") return ok(opts.viewer ?? "junco-bot");
//   if (args[0] === "api" && String(args[2] ?? "").includes("/comments"))
//     return ok((opts.comments ?? []).map((c) => JSON.stringify(c)).join("\n"));
// and change the events default so entries can carry created_at.

describe("approval scan", () => {
  const planComment = (body: string, over: Record<string, unknown> = {}) => ({
    author: "junco-bot",
    body,
    created_at: "2026-07-06T10:00:00Z",
    ...over,
  });
  const planBody = "# The plan\n\n## Steps\n- do it";
  const fencedComment =
    "<!-- junco:plan -->\nProposed plan\n\n```junco-ticket\n" + planBody + "\n```\n";
  const readyIssue = {
    number: 42,
    title: "Add rate limiting",
    body: "raw",
    labels: [{ name: "junco" }, { name: "junco:plan-ready" }, { name: "junco:approved" }],
  };
  const approvedAfter = `{"actor":"alice","label":"junco:approved","created_at":"2026-07-06T11:00:00Z"}`;
  const approvedBefore = `{"actor":"alice","label":"junco:approved","created_at":"2026-07-06T09:00:00Z"}`;

  it("approved plan-ready issue → execution ticket from the comment + label swap", async () => {
    const f = makeFakes({
      issues: [readyIssue],
      events: approvedAfter,
      permission: "write",
      comments: [planComment(fencedComment)],
    });
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(1);
    expect(f.submitted[0].idHint).toBe("gh-acme-api-42");
    expect(f.submitted[0].content).toContain("kind: pr");
    expect(f.submitted[0].content).toContain('repo: "/home/u/code/api"');
    expect(f.submitted[0].content).toContain("# The plan");
    const edit = f.calls.find((c) => c[1] === "edit");
    expect(edit).toEqual(
      expect.arrayContaining([
        "--add-label",
        "junco:queued",
        "--remove-label",
        "junco:plan-ready",
        "--remove-label",
        "junco:approved",
      ]),
    );
  });

  it("plan-ready without approved waits (require_approval on)", async () => {
    const noApproval = { ...readyIssue, labels: [{ name: "junco" }, { name: "junco:plan-ready" }] };
    const f = makeFakes({ issues: [noApproval], comments: [planComment(fencedComment)] });
    expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
    expect(f.submitted).toHaveLength(0);
  });

  it("stale approval (predates the plan comment) is ignored", async () => {
    const f = makeFakes({
      issues: [readyIssue],
      events: approvedBefore,
      permission: "write",
      comments: [planComment(fencedComment)],
    });
    expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
  });

  it("approval by a non-writer is ignored", async () => {
    const f = makeFakes({
      issues: [readyIssue],
      events: approvedAfter,
      permission: "read",
      comments: [planComment(fencedComment)],
    });
    expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
  });

  it("forged plan comment (wrong author) is ignored", async () => {
    const f = makeFakes({
      issues: [readyIssue],
      events: approvedAfter,
      permission: "write",
      comments: [planComment(fencedComment, { author: "mallory" })],
    });
    expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
    expect(f.submitted).toHaveLength(0);
  });

  it("require_approval=false: plan-ready alone converts", async () => {
    const autoCfg = {
      ...bridgeCfg,
      github: { ...bridgeCfg.github, requireApproval: false },
    } as Config;
    const noApproval = { ...readyIssue, labels: [{ name: "junco" }, { name: "junco:plan-ready" }] };
    const f = makeFakes({ issues: [noApproval], comments: [planComment(fencedComment)] });
    expect(await pollGithubInbox(autoCfg, newBridgeState(), f as never)).toBe(1);
    expect(f.submitted[0].idHint).toBe("gh-acme-api-42");
  });

  it("the LATEST own-authored plan comment wins", async () => {
    const older = planComment("<!-- junco:plan -->\n```junco-ticket\n# Old plan\n```\n", {
      created_at: "2026-07-06T08:00:00Z",
    });
    const f = makeFakes({
      issues: [readyIssue],
      events: approvedAfter,
      permission: "write",
      comments: [older, planComment(fencedComment)],
    });
    await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(f.submitted[0].content).toContain("# The plan");
    expect(f.submitted[0].content).not.toContain("# Old plan");
  });
});
````

Also update the existing trigger-gate tests: `labeledEvent` gains a `created_at` field (`{"actor":"alice","label":"junco","created_at":"2026-07-06T00:00:00Z"}`) so the generalized applier parser keeps passing.

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubInbox.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** In `src/githubInbox.ts`:

`BridgeState` gains the viewer-login cache:

```ts
export interface BridgeState {
  labelsEnsured: Set<string>;
  originOk: Map<string, boolean>;
  /** Authenticated gh login (cached) — plan comments must be self-authored. */
  login: string | null;
}

export function newBridgeState(): BridgeState {
  return { labelsEnsured: new Set(), originOk: new Map(), login: null };
}
```

Generalize `verifyLabeler` → `verifyLabelApplier` (same events call, `--jq` now also selects `created_at`; the permission step is unchanged; returns `{verdict, atMs}` where `atMs = Date.parse(created_at)` of the matched event or null). Rewire the trigger gate to `verifyLabelApplier(cfg, nwo, n, trigger, ghFn)` and keep its behavior identical (it ignores `atMs`).

```ts
async function verifyLabelApplier(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  label: string,
  ghFn: typeof gh,
): Promise<{ verdict: "ok" | "denied" | "unverified"; atMs: number | null }> {
  try {
    const ev = await ghFn(
      cfg,
      [
        "api",
        "--paginate",
        `repos/${nwo}/issues/${issueNumber}/events`,
        "--jq",
        '.[] | select(.event == "labeled") | {actor: .actor.login, label: .label.name, created_at: .created_at}',
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const events = ev.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { actor: string; label: string; created_at?: string });
    const last = [...events].reverse().find((l) => l.label === label);
    if (!last) return { verdict: "unverified", atMs: null };
    const perm = await ghFn(
      cfg,
      ["api", `repos/${nwo}/collaborators/${last.actor}/permission`, "--jq", ".permission"],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const p = perm.stdout.trim();
    const atMs = last.created_at ? Date.parse(last.created_at) : null;
    // The legacy permission field maps maintain→write, so admin|write covers it.
    return { verdict: p === "admin" || p === "write" ? "ok" : "denied", atMs };
  } catch (e) {
    log.warn("github bridge: label-applier verification failed; skipping this sweep", {
      nwo,
      issue: issueNumber,
      label,
      error: errMsg(e),
    });
    return { verdict: "unverified", atMs: null };
  }
}
```

New helpers:

```ts
async function viewerLogin(cfg: Config, state: BridgeState, ghFn: typeof gh): Promise<string> {
  if (state.login === null) {
    const r = await ghFn(cfg, ["api", "user", "--jq", ".login"], {
      timeoutMs: GH_TIMEOUT,
      retryNetwork: true,
    });
    state.login = r.stdout.trim();
  }
  return state.login;
}

/** Latest plan comment AUTHORED BY the bridge's own login — a contributor's
 * forged marker comment is never recoverable. Null = nothing usable. */
async function findOwnPlanComment(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  login: string,
  ghFn: typeof gh,
): Promise<{ body: string; createdAtMs: number } | null> {
  const r = await ghFn(
    cfg,
    [
      "api",
      "--paginate",
      `repos/${nwo}/issues/${issueNumber}/comments`,
      "--jq",
      ".[] | {author: .user.login, body: .body, created_at: .created_at}",
    ],
    { timeoutMs: GH_TIMEOUT, retryNetwork: true },
  );
  let found: { body: string; createdAtMs: number } | null = null;
  for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
    const c = JSON.parse(line) as { author: string; body: string; created_at: string };
    if (c.author === login && c.body.includes(PLAN_COMMENT_MARKER)) {
      found = { body: c.body, createdAtMs: Date.parse(c.created_at) }; // last wins
    }
  }
  return found;
}

/** Execution ticket from a reviewed plan: machine frontmatter (id, mapped
 * repo path, provenance) + the plan body verbatim. pr_title omitted —
 * derivePrTitle picks the plan's H1. */
export function buildExecutionTicket(
  issueNumber: number,
  repo: GithubRepoMapping,
  planBody: string,
): { id: string; content: string } {
  const [owner, name] = repo.nwo.split("/");
  const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const id = `gh-${slug(owner)}-${slug(name)}-${issueNumber}`;
  const fm = [
    "---",
    `id: ${id}`,
    `repo: ${JSON.stringify(repo.path)}`,
    "github:",
    `  nwo: ${JSON.stringify(repo.nwo)}`,
    `  issue: ${issueNumber}`,
    "  kind: pr",
    "---",
  ];
  return { id, content: fm.join("\n") + "\n\n" + planBody + "\n" };
}
```

In the sweep's per-issue loop, classify BEFORE the eligibility path (plan-ready issues carry a lifecycle label, so `isEligible` already excludes them from the new-issue path — add the approval branch first):

```ts
const names = new Set(issue.labels.map((l) => l.name));
if (names.has(ll.planReady)) {
  try {
    const login = await viewerLogin(cfg, state, ghFn);
    const comment = await findOwnPlanComment(cfg, repo.nwo, issue.number, login, ghFn);
    if (!comment) {
      log.warn("github bridge: plan-ready but no own-authored plan comment", {
        nwo: repo.nwo,
        issue: issue.number,
      });
      continue;
    }
    if (cfg.github.requireApproval) {
      if (!names.has(ll.approved)) continue; // awaiting review
      const approval = await verifyLabelApplier(cfg, repo.nwo, issue.number, ll.approved, ghFn);
      if (approval.verdict !== "ok") {
        log.warn("github bridge: approval not by a verified writer; ignoring", {
          nwo: repo.nwo,
          issue: issue.number,
        });
        continue;
      }
      if (approval.atMs === null || approval.atMs <= comment.createdAtMs) {
        log.warn("github bridge: approval predates the plan comment; re-apply it", {
          nwo: repo.nwo,
          issue: issue.number,
        });
        continue;
      }
    }
    const planBody = extractPlanBody(comment.body);
    if (!planBody) {
      log.error("github bridge: plan comment has no extractable plan; fix the comment", {
        nwo: repo.nwo,
        issue: issue.number,
      });
      continue;
    }
    const t = buildExecutionTicket(issue.number, repo, planBody);
    try {
      submitFn(cfg, t.content, { idHint: t.id });
    } catch (e) {
      if (!errMsg(e).includes("already queued")) throw e;
      log.info("github bridge: execution ticket already queued; re-marking", { id: t.id });
    }
    const editArgs = [
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
    if (cfg.github.requireApproval) editArgs.push("--remove-label", ll.approved);
    await ghFn(cfg, editArgs, { timeoutMs: GH_TIMEOUT, retryNetwork: true });
    bridged++;
    log.info("github bridge: approved plan dispatched for execution", {
      nwo: repo.nwo,
      issue: issue.number,
      id: t.id,
    });
  } catch (e) {
    log.warn("github bridge: approval scan failed for issue; retrying next sweep", {
      nwo: repo.nwo,
      issue: issue.number,
      error: errMsg(e),
    });
  }
  continue;
}
if (!isEligible(issue, trigger)) continue;
// ...existing new-issue path (trigger verification onward)...
```

Note: the list call already filters `--label <trigger>` and does NOT filter lifecycle labels, so plan-ready issues appear in it — but the pre-existing `.filter((i) => isEligible(...))` on the list result must MOVE into the loop (as shown) so plan-ready issues reach the approval branch. Delete the eager filter.

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts tests/githubInbox.test.ts
git add -A src tests && git commit -m "feat(github): approval scan — verified, post-plan approvals turn plans into execution tickets"
```

---

### Task 8: Reporter — plan-kind behavior

**Files:**

- Modify: `src/githubReport.ts`
- Test: `tests/githubReport.test.ts`

**Interfaces:**

- Consumes: `extractPlanBody`, `buildPlanComment`, labels (Tasks 3, 5); `TERMINAL_DONE_STATUSES`.
- Produces: kind-aware reporter — plan tickets: onStart/onRequeue no-ops; onFinal posts the plan comment + `planning→plan-ready`, or a failure comment + `planning→failed`.

- [ ] **Step 1: Failing tests.** Append to `tests/githubReport.test.ts` (the `ticket`/`out`/`fakeGh` helpers exist; `gt` kind becomes `"plan"` via spread):

````ts
describe("plan-kind reporting", () => {
  const planTicket = ticket({ nwo: "acme/api", issue: 42, kind: "plan" });
  const goodFinal = out({
    kind: "qa",
    status: "completed",
    prUrl: null,
    finalText: "chatter\n\n```junco-ticket\n# The plan\n## Steps\n- x\n```\n",
  });

  it("onStart/onRequeue are label no-ops for plan tickets", async () => {
    const f = fakeGh();
    const r = makeGithubReporter(cfg, f as never);
    await r.onStart(planTicket);
    await r.onRequeue(planTicket);
    expect(f.calls).toHaveLength(0);
  });

  it("onFinal success: posts the plan comment then flips planning→plan-ready", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(planTicket, goodFinal);
    expect(f.calls[0][1]).toBe("comment");
    expect(f.calls[1]).toEqual(
      expect.arrayContaining([
        "--add-label",
        "junco:plan-ready",
        "--remove-label",
        "junco:planning",
      ]),
    );
  });

  it("onFinal with no extractable plan: failure comment + planning→failed", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(
      planTicket,
      out({ kind: "qa", status: "completed", prUrl: null, finalText: "no fence here" }),
    );
    expect(f.calls[0][1]).toBe("comment");
    expect(f.calls[1]).toEqual(
      expect.arrayContaining(["--add-label", "junco:failed", "--remove-label", "junco:planning"]),
    );
  });

  it("onFinal failure status: failure comment + planning→failed", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(
      planTicket,
      out({ kind: "qa", status: "failed", prUrl: null, failureReason: "endpoint died" }),
    );
    expect(f.calls[1]).toEqual(expect.arrayContaining(["--add-label", "junco:failed"]));
  });
});
````

(The test-file `cfg` already gained `requireApproval: true, plannerModelId: null` in Task 1.)

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubReport.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** In `src/githubReport.ts` (import `extractPlanBody`, `buildPlanComment` from `./githubInbox.js`). Extract the comment-posting mechanics into a local `postComment(g, body)` helper (mkdtemp + `--body-file` + rm — the code currently inline in `onFinal`), then make the three methods kind-aware:

```ts
    async onStart(t: Ticket): Promise<void> {
      if (!t.github || t.github.kind === "plan") return; // planning label persists
      const g = t.github;
      await guard("onStart", t.id, () => swap(g, ll.working, ll.queued));
    },
    async onRequeue(t: Ticket): Promise<void> {
      if (!t.github || t.github.kind === "plan") return;
      const g = t.github;
      await guard("onRequeue", t.id, () => swap(g, ll.queued, ll.working));
    },
    async onFinal(t: Ticket, outcome: TicketOutcome): Promise<void> {
      if (!t.github) return;
      const g = t.github;
      if (g.kind === "plan") {
        const done = TERMINAL_DONE_STATUSES.has(outcome.status);
        const planBody = done ? extractPlanBody(outcome.finalText) : null;
        const comment = planBody
          ? buildPlanComment(planBody, {
              issue: g.issue,
              trigger: cfg.github.triggerLabel,
              requireApproval: cfg.github.requireApproval,
            })
          : null;
        if (comment) {
          await guard("plan comment", t.id, () => postComment(g, comment));
          await guard("plan labels", t.id, () => swap(g, ll.planReady, ll.planning));
        } else {
          const reason = !done
            ? (outcome.failureReason ?? `status ${outcome.status}`)
            : planBody === null
              ? "planner produced no usable plan (missing/empty junco-ticket fence)"
              : "plan too large for an issue comment";
          await guard("plan failure comment", t.id, () =>
            postComment(
              g,
              `**Junco could not produce a plan** for this issue.\n\n> ${reason.slice(0, 1000)}\n\n_Remove the \`${ll.failed}\` label to re-plan._\n`,
            ),
          );
          await guard("plan failure labels", t.id, () => swap(g, ll.failed, ll.planning));
        }
        return;
      }
      // pr/ask: the EXISTING v1 body of onFinal, verbatim, with its inline
      // mkdtemp/body-file/rm block replaced by the postComment(g, body) helper:
      await guard("final comment", t.id, () => postComment(g, buildFinalComment(t, outcome)));
      const done = TERMINAL_DONE_STATUSES.has(outcome.status);
      await guard("final labels", t.id, () => swap(g, done ? ll.done : ll.failed, ll.working));
    },
```

where `postComment` is the extracted helper (same code that lives inline today):

```ts
const postComment = async (g: TicketGithub, body: string): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "junco-ghc-"));
  const file = join(dir, "comment.md");
  writeFileSync(file, body, "utf8");
  try {
    await ghFn(cfg, ["issue", "comment", String(g.issue), "--repo", g.nwo, "--body-file", file], {
      timeoutMs: GH_TIMEOUT,
      retryNetwork: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubReport.ts tests/githubReport.test.ts
git add -A src tests && git commit -m "feat(github): reporter posts the plan comment and drives planning labels"
```

---

### Task 9: Planner model override in `executeClaimed`

**Files:**

- Modify: `src/runOnce.ts` (Q&A `qaCfg` construction, ~line 208)
- Test: `tests/runOnce.test.ts`

**Interfaces:**

- Consumes: `cfg.github.plannerModelId` (Task 1), `Ticket.github.kind === "plan"` (Task 2).

- [ ] **Step 1: Failing test.** Append to `tests/runOnce.test.ts`:

```ts
describe("planner model override", () => {
  it("plan-kind tickets swap cfg.model.id when planner_model_id is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(
      join(j, "inbox", "p.md"),
      `---\nid: gh-a-b-1-plan\ngithub:\n  nwo: a/b\n  issue: 1\n  kind: plan\n---\nplan prompt\n`,
      "utf8",
    );
    const c: Config = {
      ...cfg(root),
      github: { ...cfg(root).github, plannerModelId: "prov/big" },
    };
    let seenModelId = "";
    await runOnce(c, {
      sessionFactoryFor: (passedCfg) => {
        seenModelId = passedCfg.model.id;
        return fakeFactory();
      },
    });
    expect(seenModelId).toBe("prov/big");
  });

  it("non-plan tickets keep the configured model", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(join(j, "inbox", "q.md"), "---\nid: q\n---\nask\n", "utf8");
    const c: Config = {
      ...cfg(root),
      github: { ...cfg(root).github, plannerModelId: "prov/big" },
    };
    let seenModelId = "";
    await runOnce(c, {
      sessionFactoryFor: (passedCfg) => {
        seenModelId = passedCfg.model.id;
        return fakeFactory();
      },
    });
    expect(seenModelId).toBe("m");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/runOnce.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** In `src/runOnce.ts`, replace the `qaCfg` line:

```ts
// Planning tickets may run a stronger model id (same endpoint/key) —
// plan quality is the biggest lever on execution quality.
const qaModel =
  next.github?.kind === "plan" && cfg.github.plannerModelId
    ? { ...cfg.model, id: cfg.github.plannerModelId }
    : cfg.model;
const qaCfg: Config = { ...cfg, tools: qaTools, model: qaModel };
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/runOnce.ts tests/runOnce.test.ts
git add -A src tests && git commit -m "feat(runOnce): planner_model_id override for plan-kind sessions"
```

---

### Task 10: Doctor template check, wizard example, docs

**Files:**

- Modify: `src/doctor.ts` (template-readability check in the github block)
- Modify: `src/wizard.ts` (`renderConfigToml` github example gains `require_approval`)
- Modify: `README.md` (GitHub-integrated mode section: planner flow, label table, approval, re-plan gestures, `require_approval`/`planner_model_id`)
- Modify: `ARCHITECTURE.md` (module map: `planPrompt.ts`; lifecycle diagram: plan hop)
- Modify: `CHANGELOG.md` (Unreleased → rewrite the GitHub entry for the two-hop flow)
- Test: `tests/doctor.test.ts`, `tests/wizard.test.ts`

- [ ] **Step 1: Failing tests.** `tests/doctor.test.ts`, inside the github-checks describe:

```ts
it("fails when the dispatch template is unreadable (bridge enabled)", async () => {
  const lines: string[] = [];
  const code = await runDoctor(
    "/x/config.toml",
    deps({
      loadConfigFn: () => githubConfig([]),
      readTemplateFn: () => {
        throw new Error("ENOENT");
      },
      printFn: (s) => lines.push(s),
    }),
  );
  expect(code).toBe(1);
  expect(lines.join("")).toMatch(/✗ github planner template/);
});

it("reports the template ok when readable", async () => {
  const lines: string[] = [];
  await runDoctor(
    "/x/config.toml",
    deps({ loadConfigFn: () => githubConfig([]), printFn: (s) => lines.push(s) }),
  );
  expect(lines.join("")).toMatch(/✓ github planner template/);
});
```

`tests/wizard.test.ts` — in the `[github]` example test add:

```ts
expect(toml).toContain("# require_approval = true");
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/doctor.test.ts tests/wizard.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement doctor.** `src/doctor.ts`: add `readTemplateFn?: () => string;` to `DoctorDeps` (default `loadDispatchTemplate` imported from `./planPrompt.js`), and inside the `cfg.github.enabled` block (before the per-repo loop):

```ts
try {
  (deps.readTemplateFn ?? loadDispatchTemplate)();
  report("ok", "github planner template", "skills/junco-dispatch/TEMPLATE.md");
} catch (e) {
  report(
    "fail",
    "github planner template",
    `unreadable — planning tickets will fail (${e instanceof Error ? e.message : String(e)})`,
  );
}
```

- [ ] **Step 4: Implement wizard.** In the commented `[github]` block in `renderConfigToml`, after the `poll_interval_seconds` line add:

```ts
    '# require_approval = true  # plans wait for a junco:approved label from a writer',
```

- [ ] **Step 5: Docs.** README "GitHub-integrated mode": rewrite "The loop" for the two hops (plan → review → approve → execute); extend the label table with `junco:planning`/`junco:plan-ready`/`junco:approved`; document the plan comment (editable before approval), re-plan gestures, `require_approval = false` (recommended only for private personal repos), and `planner_model_id`. ARCHITECTURE: add `planPrompt.ts` to the module map ("planner prompt assembly — single-sources skills/junco-dispatch/TEMPLATE.md") and add the plan hop to the lifecycle diagram. CHANGELOG Unreleased: rewrite the GitHub bullet — labeled issues are **planned first** (daemon-authored plan via the junco-dispatch template, posted for review, approval-gated execution; `require_approval`, `planner_model_id`).

- [ ] **Step 6: Full gate + commit**

```bash
npm run lint && npm run format:check && npm run build && npm test > /tmp/out 2>&1; echo "exit: $?"
npx prettier --write src/doctor.ts src/wizard.ts README.md ARCHITECTURE.md CHANGELOG.md tests/doctor.test.ts tests/wizard.test.ts
git add -A src tests README.md ARCHITECTURE.md CHANGELOG.md && git commit -m "feat(observability)+docs: planner template preflight, config example, two-hop lifecycle docs"
```

---

### Task 11: Final gate + branch review

- [ ] **Step 1: Full gate on a clean tree** — `npm run lint && npm run format:check && npm run build && npm test > /tmp/out 2>&1; echo "exit: $?"` → 0; `git status --short` empty.

- [ ] **Step 2: Branch review** — `git log --oneline main..HEAD` (v1 commits + spec/plan + ~10 new); `git log main..HEAD --format=%B | grep -ci "claude\|generated with"` → 0; `git diff main -- package.json` → empty; ticket-schema changes additive only.

- [ ] **Step 3: Report** to the maintainer. PR #1 is already open for this branch — pushing updates it; do NOT merge, tag, or release (release HOLD). Suggest updating the PR title/body to cover the planner stage when pushing.
