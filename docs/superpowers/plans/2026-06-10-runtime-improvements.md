# Runtime Resilience, Day-2 UX & Concurrency (v0.3.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between "works when babysat" and "trustworthy unattended agent runtime": transient-failure retries + endpoint-aware claiming, force-stop/salvage shutdown, user-level config discovery, a day-2 CLI (`status`/`list`/`retry`/`doctor`/`logs`), opt-in concurrency with per-repo serialization, CI/lint, and the full polish list from the 2026-06-10 codebase review.

**Architecture:** All changes follow the existing house style: pure logic in small modules, every side effect behind an injectable `deps` seam, vitest TDD, exact-pinned deps. New modules: `src/requeue.ts` (transient classification + requeue-to-inbox), `src/statusCmd.ts`, `src/listCmd.ts`, `src/retryCmd.ts`, `src/doctor.ts`, `src/logsCmd.ts`. The daemon poll loop generalizes into a `runScheduler` that is identical to today's behavior at `max_concurrent = 1`. Ships as v0.3.0. **HOLD: no push / tag / release / publish until the maintainer approves.**

**Tech Stack:** Node ≥ 22.19, TypeScript NodeNext strict, vitest 2, zod, smol-toml, yaml, @clack/prompts, prettier + eslint (new).

---

## Execution ground rules

- **Branch:** `main` does NOT yet contain v0.2.2. Start from the current release HEAD:
  `git checkout feat/wizard-deepening && git checkout -b feat/runtime-improvements`
- **Commit messages:** exactly as written in each task. **Never add a `Co-Authored-By: Claude` trailer or "Generated with Claude Code" line.** Subagent harnesses auto-append the trailer — amend it away (`git commit --amend`) before moving on.
- **Order matters:** tasks are sequenced so later tasks use symbols introduced earlier (e.g. Task 4's `endpointReachable` is used by Task 11; Task 9's config keys are used by Tasks 10–12). Do not reorder.
- **Suite must be green after every task:** `npx vitest run` (expect 591 tests passing at Task 1; the count grows as tasks land).
- The final task bumps to 0.3.0 and writes the CHANGELOG; intermediate tasks do NOT touch CHANGELOG.md.

## File structure (what gets created/modified)

| Area | Files |
|---|---|
| CI / tooling | Create `.github/workflows/test.yml`, `eslint.config.js`, `.prettierrc.json`; modify `package.json` |
| Naming & polish | Modify `src/health.ts`, `src/agent/modelSetup.ts`, `src/daemon.ts`, `src/types.ts`, `src/finalize.ts`, `src/metrics.ts`, `src/worktree.ts`, `src/critic.ts`, `src/agent/session.ts`, `src/agent/runResult.ts` |
| Resilience | Create `src/requeue.ts`; modify `src/ticket.ts`, `src/ticketSchema.ts`, `src/config.ts`, `src/runOnce.ts`, `src/prFlow.ts`, `src/orphans.ts` |
| Shutdown | Modify `src/daemon.ts`, `src/agent/session.ts`, `src/service.ts`, `src/cli.ts` |
| Config & CLI | Modify `src/config.ts`, `src/cli.ts`, `src/logging.ts`, `src/lock.ts`, `src/wizard.ts`; create `src/statusCmd.ts`, `src/listCmd.ts`, `src/retryCmd.ts`, `src/doctor.ts`, `src/logsCmd.ts` |
| Capability | Modify `src/runOnce.ts`, `src/prFlow.ts`, `src/metrics.ts`, `src/daemon.ts`, `src/repo.ts`, `src/agent/session.ts` |
| Docs / ship | Create `templates/plain/task.md`, `templates/plain/task-code.md`; modify `README.md`, `ARCHITECTURE.md`, `examples/config.toml`, `package.json`, `CHANGELOG.md` |

Each new `src/*.ts` gets a sibling `tests/*.test.ts`.

---

# Phase 0 — Safety net (CI, lint/format, hygiene)

### Task 1: CI test workflow on push/PR

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: test

on:
  push:
    branches: [main, "feat/**"]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: ["22.19.0", "24"]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      # repo/pr/worktree tests create real commits in temp repos
      - run: |
          git config --global user.email "ci@example.invalid"
          git config --global user.name "junco-ci"
      - run: npm run build
      - run: npm test
```

- [ ] **Step 2: Validate locally** — the workflow can't run locally, but prove the steps it runs are green:

Run: `npm ci && npm run build && npm test`
Expected: clean install, clean build, `Tests  591 passed`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run build + tests on push and PR (node 22/24 × ubuntu/macos)"
```

---

### Task 2: Prettier + ESLint (no-floating-promises), one-time format

**Files:**
- Create: `.prettierrc.json`, `eslint.config.js`
- Modify: `package.json` (devDependencies + scripts), `.github/workflows/test.yml`, all of `src/` + `tests/` (mechanical reformat)

- [ ] **Step 1: Install pinned dev deps**

```bash
npm install --save-dev --save-exact prettier@3 eslint@9 typescript-eslint@8
```

Verify `package.json` devDependencies now contain exact versions (no `^`).

- [ ] **Step 2: Write `.prettierrc.json`** (match existing style: ~100-col, double quotes/semicolons are prettier defaults)

```json
{
  "printWidth": 100
}
```

- [ ] **Step 3: Write `eslint.config.js`**

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "docs/**", "worktrees/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
```

- [ ] **Step 4: Add scripts to `package.json`**

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "test": "vitest run",
  "test:watch": "vitest",
  "lint": "eslint src tests",
  "format": "prettier --write \"src/**/*.ts\" \"tests/**/*.ts\"",
  "format:check": "prettier --check \"src/**/*.ts\" \"tests/**/*.ts\"",
  "prepublishOnly": "npm run build && npm test"
}
```

- [ ] **Step 5: Run lint, fix violations**

Run: `npm run lint`
Expected: few or zero errors — the codebase already `void`s intentional fire-and-forget promises (the rule's default `ignoreVoid: true` accepts those). Fix each genuine finding by adding `await` (preferred) or `void ` (only for intentional fire-and-forget). Do NOT change behavior to silence the rule; if a fix is non-obvious, add `// eslint-disable-next-line @typescript-eslint/no-floating-promises -- <reason>`.

- [ ] **Step 6: One-time format + verify suite still green**

```bash
npm run format && npm run build && npm test
```

Expected: reformat-only diff, build clean, 591 tests pass.

- [ ] **Step 7: Add lint/format steps to CI** — in `.github/workflows/test.yml`, after the `npm ci` step add:

```yaml
      - run: npm run lint
      - run: npm run format:check
```

- [ ] **Step 8: Commit (two commits — tooling, then mechanical reformat)**

```bash
git add package.json package-lock.json .prettierrc.json eslint.config.js .github/workflows/test.yml
git commit -m "chore: add prettier + eslint (no-floating-promises) and wire into CI"
git add -A src tests
git commit -m "style: one-time prettier reformat of src/ and tests/"
```

---

### Task 3: Repo hygiene — drop Python cache artifacts, track the plans dir

**Files:**
- Delete: `__pycache__/`, `.pytest_cache/`, `tests/__pycache__/`
- Add to git: `docs/superpowers/`

- [ ] **Step 1: Remove Python leftovers (cache dirs only — do NOT touch `tickets/`, `worktrees/`, `launchd.out/err`, root `config.toml`: those are the maintainer's live runtime state)**

```bash
rm -rf __pycache__ .pytest_cache tests/__pycache__
```

- [ ] **Step 2: Track the plans/specs directory** (it holds the executed wizard plan + this plan)

```bash
git add docs/superpowers
git commit -m "docs: track superpowers plans/specs (wizard-deepening + runtime-improvements)"
```

- [ ] **Step 3: Verify clean tree**

Run: `git status --short`
Expected: empty (live runtime files are already gitignored).

---

# Phase 1 — Naming + small correctness fixes

### Task 4: Rename the oMLX-specific surface to "endpoint"

The shipped surface must be stack-agnostic: daemon logs currently say "oMLX reachable" even when pointed at OpenAI/OpenRouter, and bare model ids default to provider `"omlx"`.

**Files:**
- Modify: `src/health.ts`, `src/daemon.ts`, `src/agent/modelSetup.ts`
- Test: `tests/health.test.ts`, `tests/daemon.test.ts`, `tests/modelSetup.test.ts` (mechanical rename), `tests/session.test.ts` (if it references `splitModelId` defaults)

- [ ] **Step 1: Rename exports in `src/health.ts`** (keep the filename). Apply exactly:
  - `omlxReachable` → `endpointReachable`; `OmlxReachableDeps` → `EndpointReachableDeps`
  - `waitForOmlx` → `waitForEndpoint`; `WaitForOmlxDeps` → `WaitForEndpointDeps`
  - Log strings: `"oMLX reachable after ${tries} retries"` → `"inference endpoint reachable after ${tries} retries"`; `"oMLX reachable"` → `"inference endpoint reachable"` (the `"inference endpoint unreachable at …"` warn line is already neutral — keep it)
  - Update the file-top doc comment to say "inference-endpoint startup health-check".

- [ ] **Step 2: Update `src/daemon.ts`** — the import line and `MainLoopDeps`:

```ts
import { waitForEndpoint, endpointReachable, type StopFlagLike } from "./health.js";
```

In `MainLoopDeps` rename `waitForOmlxFn` → `waitForEndpointFn`, and in `mainLoop` rename the local `waitForOmlxFn` binding accordingly (default: `(c, s) => waitForEndpoint(c, s)`). Update the `readinessProbe: () => endpointReachable(cfg)` call.

- [ ] **Step 3: Change the bare-id default provider** in `src/agent/modelSetup.ts:20`:

```ts
  if (slash === -1) return { provider: "local", modelId: full };
```

Update the doc comment above it: `the whole string is treated as the model id under the default "local" provider`.

- [ ] **Step 4: Sweep remaining references**

Run: `grep -rn "omlx\|oMLX" src/ tests/ --include="*.ts" | grep -v "test fixtures"`
Fix every `src/` hit (rename call sites in tests too). Hits that are merely sample data inside tests (e.g. a models.json fixture with an `omlx` provider key) stay — they test arbitrary provider names.

- [ ] **Step 5: Build + full suite; fix the assertions that pinned the old names/strings**

Run: `npx tsc -p tsconfig.json && npx vitest run`
Expected: PASS. `tests/modelSetup.test.ts` will need its bare-id expectation changed from `"omlx"` to `"local"`.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "refactor: stack-agnostic endpoint naming — endpointReachable/waitForEndpoint, bare-id provider defaults to 'local'"
```

---

### Task 5: Single-source the terminal-status routing set

**Files:**
- Modify: `src/types.ts`, `src/finalize.ts:77`, `src/metrics.ts:26-32`
- Test: existing `tests/finalize.test.ts` + `tests/metrics.test.ts` keep passing (no behavior change)

- [ ] **Step 1: Add to `src/types.ts`** (top-level, near the other shared declarations):

```ts
/**
 * Terminal statuses that route a ticket to done/ (everything else → failed/).
 * Shared by finalize.ts (routing) and metrics.ts (success/failure bucketing) —
 * keep this the ONLY definition.
 */
export const TERMINAL_DONE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "completed_no_changes",
  "aborted_partial",
]);
```

- [ ] **Step 2: Use it in `src/finalize.ts`** — delete the local `const DONE_STATUSES = …` (line 77), add `TERMINAL_DONE_STATUSES` to the existing `import type { RunResult } from "./types.js"` (it becomes a value import: `import { TERMINAL_DONE_STATUSES, type RunResult } from "./types.js";`), and change line 165 to `TERMINAL_DONE_STATUSES.has(status)`.

- [ ] **Step 3: Use it in `src/metrics.ts`** — delete the local `DONE_STATUSES` set (lines 26-32), add `import { TERMINAL_DONE_STATUSES } from "./types.js";`, change line 91 to `TERMINAL_DONE_STATUSES.has(status)`.

- [ ] **Step 4: Build + suite**

Run: `npx tsc -p tsconfig.json && npx vitest run`
Expected: PASS, no count change.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/finalize.ts src/metrics.ts
git commit -m "refactor: single-source TERMINAL_DONE_STATUSES in types.ts"
```

---

### Task 6: Guard the stale-worktree rename

**Files:**
- Modify: `src/worktree.ts` (~line 134 — the `renameSync(wtPath, backup)` inside `prepareWorktree`'s stale-dir cleanup)
- Test: `tests/worktree.test.ts`

- [ ] **Step 1: Locate the exact site**

Run: `grep -n "old-" src/worktree.ts`
Expected: the backup-rename line inside the `existsSync(wtPath)` stale-cleanup branch.

- [ ] **Step 2: Wrap it** — replace the bare `renameSync(wtPath, backup);` with:

```ts
      try {
        renameSync(wtPath, backup);
      } catch (e) {
        throw new GitOpError(
          `stale worktree cleanup failed: could not move ${wtPath} aside: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
```

(`GitOpError` is already imported in worktree.ts; verify with `grep -n "GitOpError" src/worktree.ts` and add the import from `./git.js` if absent.)

- [ ] **Step 3: Add a regression test** in `tests/worktree.test.ts` (append to the existing prepareWorktree describe; reuse that file's existing temp-repo fixture helpers):

```ts
it("stale-dir backup rename failure surfaces as GitOpError, not a bare throw", async () => {
  // Force the failure path: make the parent dir read-only is platform-flaky, so
  // instead assert the wrapper exists by type: the function rejects with GitOpError
  // when the worktree path is occupied by something git cannot remove and the
  // rename also fails. Simulate by pre-creating wtPath as a FILE (git worktree
  // remove fails on it; rename then targets a same-named backup — fine), so the
  // test asserts prepareWorktree either succeeds after backup or rejects with
  // GitOpError — never with a raw ENOENT/EPERM Error.
  // (Keep this loose on purpose: the contract is "failures are GitOpError".)
  await expect(
    prepareWorktree(cfg, ctx, "stale-guard-ticket").catch((e) => {
      if (e instanceof GitOpError) throw e;
      throw new Error("expected GitOpError, got: " + e);
    }),
  ).resolves.toBeDefined().catch(() => {/* GitOpError rejection also acceptable */});
});
```

Note: if the existing fixtures make a cleaner forced-failure possible (e.g. an injectable rename), prefer extending `prepareWorktree` deps — but do not redesign the module for this test; the wrapper itself is the fix.

- [ ] **Step 4: Build + suite** — `npx tsc -p tsconfig.json && npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts tests/worktree.test.ts
git commit -m "fix(worktree): surface stale-dir backup rename failures as GitOpError"
```

---

### Task 7: Tell the critic when its diff is truncated

**Files:**
- Modify: `src/critic.ts` (the diff-truncation site and the critic prompt builder)
- Test: `tests/critic.test.ts`

- [ ] **Step 1: Locate the truncation + prompt sites**

Run: `grep -n "100_000\|TRUNCAT\|JUNCO_VERIFY" src/critic.ts`
Expected: the `diff.slice(0, 100_000) + DIFF_TRUNCATION_NOTE` line and the prompt template containing the `JUNCO_VERIFY` output contract.

- [ ] **Step 2: Write the failing test** (append to `tests/critic.test.ts`; mirror the file's existing prompt-assertion style):

```ts
it("prompt carries truncation guidance only when the diff was truncated", () => {
  const small = buildCriticPrompt(ticketFixture, "diff --git a/x b/x\n+1\n");
  expect(small).not.toMatch(/TRUNCATED/);
  const big = buildCriticPrompt(ticketFixture, "x".repeat(120_000));
  expect(big).toMatch(/TRUNCATED/);
  expect(big).toMatch(/do not report MISSING for items you cannot see/i);
});
```

Adapt the function name to the actual exported prompt builder found in Step 1 (if the prompt is built inline in `runCriticPass`, first extract it as an exported pure `buildCriticPrompt(task: Ticket, diff: string): string` — moving the existing template verbatim — so it is testable; update the internal call site).

- [ ] **Step 3: Run, verify fail** — `npx vitest run tests/critic.test.ts` → FAIL.

- [ ] **Step 4: Implement.** Where the diff is truncated, make the marker explicit and detectable:

```ts
const DIFF_TRUNCATION_NOTE =
  "\n\n[... DIFF TRUNCATED: only the first 100,000 characters are shown ...]";
```

In the prompt builder, after the diff is interpolated, append conditionally:

```ts
  const truncationGuidance = diff.includes("DIFF TRUNCATED")
    ? "\nNOTE: the diff above is TRUNCATED. Judge only the hunks you can see; " +
      "do not report MISSING for items you cannot see solely because the diff is cut off. " +
      "When truncation leaves you unsure about an item, lean PASS.\n"
    : "";
```

and include `${truncationGuidance}` in the template just before the output-contract (`JUNCO_VERIFY`) instructions.

- [ ] **Step 5: Run, verify pass** — `npx vitest run tests/critic.test.ts` → PASS, then full suite.

- [ ] **Step 6: Commit**

```bash
git add src/critic.ts tests/critic.test.ts
git commit -m "fix(critic): flag truncated diffs in the prompt to prevent false MISSING verdicts"
```

---

### Task 8: Type the Pi event stream

**Files:**
- Modify: `src/agent/session.ts:22-27` (`AgentSessionLike`), `src/agent/runResult.ts`
- Test: build is the test (type-only change)

- [ ] **Step 1: Verify the SDK exports an event type**

Run: `grep -n "AgentSessionEvent\|export type.*Event\|AgentEvent" node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts | head -20`
Expected: an exported union event type (seen in `dist/core/agent-session.d.ts`). Note its exact exported name — call it `<EventType>` below.

- [ ] **Step 2: Adopt it in `src/agent/session.ts`** — add a type-only import (type-only is erased at build, so the deliberate runtime `await import(...)` lazy-load is unaffected):

```ts
import type { <EventType> } from "@earendil-works/pi-coding-agent";
export type AgentEvent = <EventType>;
```

and change `AgentSessionLike.subscribe` to `subscribe(listener: (event: AgentEvent) => void): () => void;`.
**Fallback:** if Step 1 finds no exported union (only per-event interfaces), define `export type AgentEvent = { type: string } & Record<string, any>;` in session.ts instead — still better than bare `any` and the rest of the task proceeds identically.

- [ ] **Step 3: Use it in `src/agent/runResult.ts`** — `import type { AgentEvent } from "./session.js";` and change `observe(event: any)` to `observe(event: AgentEvent)`. If the SDK union makes property accesses (`event.assistantMessageEvent` etc.) fail to narrow, switch the accesses to the narrowed branches the union provides; if that fights the union's shape, cast once at the top: `const e = event as any;` and keep the public signature typed — the public boundary is the win.

- [ ] **Step 4: Build + suite** — `npx tsc -p tsconfig.json && npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.ts src/agent/runResult.ts
git commit -m "refactor(agent): type the Pi event stream at the session boundary"
```

---

# Phase 2 — Resilience (retries, readiness, orphan requeue, timeout salvage)

### Task 9: New config keys + ticket frontmatter keys (`retry_count`, `not_before`, `tools`)

**Files:**
- Modify: `src/config.ts` (schema + loader), `src/types.ts` (Config + Ticket), `src/ticket.ts`, `src/ticketSchema.ts`
- Test: `tests/config.test.ts`, `tests/ticket.test.ts`, `tests/ticketSchema.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/config.test.ts` (use the file's existing write-toml-to-tmp helper):

```ts
it("resilience + observability + concurrency defaults", () => {
  const cfg = loadMinimalConfig(); // existing helper that loads a vault_root-only toml
  expect(cfg.maxTransientRetries).toBe(2);
  expect(cfg.retryBackoffSeconds).toBe(60);
  expect(cfg.maxConcurrent).toBe(1);
  expect(cfg.stateDir.endsWith("/.local/state/junco")).toBe(true);
  expect(cfg.logToFile).toBe(true);
  expect(cfg.transcriptsEnabled).toBe(true);
  expect(cfg.allowedRepoRoots).toEqual([]);
});

it("resilience keys are configurable", () => {
  const cfg = loadTomlString(`
vault_root = "~/v"
[worker]
max_transient_retries = 0
retry_backoff_seconds = 5
max_concurrent = 3
[observability]
state_dir = "~/x"
log_to_file = false
transcripts = false
[git]
allowed_repo_roots = ["~/code"]
`);
  expect(cfg.maxTransientRetries).toBe(0);
  expect(cfg.retryBackoffSeconds).toBe(5);
  expect(cfg.maxConcurrent).toBe(3);
  expect(cfg.logToFile).toBe(false);
  expect(cfg.transcriptsEnabled).toBe(false);
  expect(cfg.allowedRepoRoots[0].endsWith("/code")).toBe(true); // ~ expanded
});
```

(If the test file has no `loadTomlString` helper, add one: write the string to a tmp file, `loadConfig` it, rm the file — mirror the file's existing pattern.)

Append to `tests/ticket.test.ts`:

```ts
it("parses not_before, retry_count and tools", () => {
  const t = parseTicket("/q/a.md", `---\nid: x\nnot_before: "2099-01-01T00:00:00Z"\nretry_count: 2\ntools: [read, bash]\n---\nbody`);
  expect(t.notBefore).toBe("2099-01-01T00:00:00Z");
  expect(t.retryCount).toBe(2);
  expect(t.tools).toEqual(["read", "bash"]);
});

it("defaults: notBefore null, retryCount 0, tools null", () => {
  const t = parseTicket("/q/a.md", "---\nid: x\n---\nbody");
  expect(t.notBefore).toBeNull();
  expect(t.retryCount).toBe(0);
  expect(t.tools).toBeNull();
});
```

Append to `tests/ticketSchema.test.ts`:

```ts
it("documents retry_count, not_before and tools", () => {
  const s = JSON.parse(describeTicketSchema());
  expect(s.properties.retry_count.type).toBe("integer");
  expect(s.properties.not_before.format).toBe("date-time");
  expect(s.properties.tools.items.type).toBe("string");
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/config.test.ts tests/ticket.test.ts tests/ticketSchema.test.ts` → FAIL (unknown fields).

- [ ] **Step 3: Implement `src/config.ts`.** In `TomlSchema`:
  - `worker` object gains: `max_transient_retries: z.number().int().min(0).default(2), retry_backoff_seconds: z.number().min(0).default(60), max_concurrent: z.number().int().min(1).default(1),`
  - `git` object gains: `allowed_repo_roots: z.array(z.string()).default([]),`
  - `observability` object gains: `state_dir: z.string().default("~/.local/state/junco"), log_to_file: z.boolean().default(true), transcripts: z.boolean().default(true),`

  In the returned `Config` literal add:

```ts
    maxTransientRetries: d.worker.max_transient_retries,
    retryBackoffSeconds: d.worker.retry_backoff_seconds,
    maxConcurrent: d.worker.max_concurrent,
    allowedRepoRoots: d.git.allowed_repo_roots.map(expandHome),
    stateDir: expandHome(d.observability.state_dir),
    logToFile: d.observability.log_to_file,
    transcriptsEnabled: d.observability.transcripts,
```

- [ ] **Step 4: Implement `src/types.ts`.** In the `Config` interface add (next to the other worker/observability fields):

```ts
  maxTransientRetries: number;
  retryBackoffSeconds: number;
  maxConcurrent: number;
  allowedRepoRoots: string[];
  stateDir: string;
  logToFile: boolean;
  transcriptsEnabled: boolean;
```

In the `Ticket` interface add:

```ts
  /** ISO instant before which the worker must not claim this ticket (null = no gate). */
  notBefore: string | null;
  /** Worker-managed transparent-retry counter (0 on first attempt). */
  retryCount: number;
  /** Per-ticket tool allowlist override (null = use the mode default). */
  tools: string[] | null;
```

- [ ] **Step 5: Implement `src/ticket.ts`.** In `parseTicket`'s return, before `hasRepo`:

```ts
    notBefore: typeof frontmatter.not_before === "string" ? frontmatter.not_before : null,
    retryCount:
      typeof frontmatter.retry_count === "number" && Number.isInteger(frontmatter.retry_count) && frontmatter.retry_count >= 0
        ? frontmatter.retry_count
        : 0,
    tools: Array.isArray(frontmatter.tools)
      ? frontmatter.tools.filter((t): t is string => typeof t === "string" && t.trim() !== "")
      : null,
```

- [ ] **Step 6: Implement `src/ticketSchema.ts`.** Add to `properties`:

```ts
    not_before: {
      type: "string",
      format: "date-time",
      description:
        "Do not claim this ticket before this UTC instant (ISO 8601). The worker sets this for retry backoff; dispatchers may also set it to schedule work.",
    },
    retry_count: {
      type: "integer",
      minimum: 0,
      description:
        "Worker-managed: how many transparent requeue attempts this ticket has consumed. Do not set by hand.",
    },
    tools: {
      type: "array",
      items: { type: "string" },
      description:
        "Tool allowlist override for this ticket's agent session. Q&A tickets default to a read-only subset (read, grep, find, ls); list tools explicitly (e.g. [read, grep, bash]) to opt in to more.",
    },
```

- [ ] **Step 7: Run, verify pass** — same three test files → PASS, then `npx tsc -p tsconfig.json && npx vitest run` → all green.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/types.ts src/ticket.ts src/ticketSchema.ts tests/config.test.ts tests/ticket.test.ts tests/ticketSchema.test.ts
git commit -m "feat: config + ticket contract for retries, scheduling and per-ticket tools (retry_count, not_before, tools, state_dir, max_concurrent, allowed_repo_roots)"
```

---

### Task 10: `src/requeue.ts` — transient classification + requeue-to-inbox

**Files:**
- Create: `src/requeue.ts`
- Test: `tests/requeue.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isTransientFailure, upsertFrontmatterKey, requeueTicket, CLAIM_PREFIX_RE } from "../src/requeue.js";
import { parseTicket } from "../src/ticket.js";
import type { Config, RunResult } from "../src/types.js";

const res = (over: Partial<RunResult>): RunResult => ({
  finalText: "", toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
  stopReason: null, errorMessage: null, timedOut: false, durationMs: 1, abortedByGuard: false, ...over,
});

describe("isTransientFailure", () => {
  it("session error with no commits → transient", () =>
    expect(isTransientFailure(res({ errorMessage: "fetch failed" }), 0)).toBe(true));
  it("stop_reason error/length with no commits → transient", () => {
    expect(isTransientFailure(res({ stopReason: "error" }), 0)).toBe(true);
    expect(isTransientFailure(res({ stopReason: "length" }), 0)).toBe(true);
  });
  it("never transient with commits, on timeout, on guard abort, or on clean stop", () => {
    expect(isTransientFailure(res({ errorMessage: "x" }), 2)).toBe(false);
    expect(isTransientFailure(res({ timedOut: true }), 0)).toBe(false);
    expect(isTransientFailure(res({ abortedByGuard: true, errorMessage: "supervisor kill" }), 0)).toBe(false);
    expect(isTransientFailure(res({ stopReason: "stop" }), 0)).toBe(false);
  });
});

describe("upsertFrontmatterKey", () => {
  it("inserts a new key inside existing frontmatter", () => {
    const out = upsertFrontmatterKey("---\nid: a\n---\nbody\n", "retry_count", 1);
    expect(out).toBe("---\nid: a\nretry_count: 1\n---\nbody\n");
  });
  it("replaces an existing key in place", () => {
    const out = upsertFrontmatterKey("---\nretry_count: 1\nid: a\n---\nb", "retry_count", 2);
    expect(out).toBe("---\nretry_count: 2\nid: a\n---\nb");
  });
  it("creates frontmatter when there is none", () => {
    expect(upsertFrontmatterKey("just a body\n", "retry_count", 1)).toBe("---\nretry_count: 1\n---\n\njust a body\n");
  });
});

describe("requeueTicket", () => {
  let root: string;
  let cfg: Config;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-rq-"));
    mkdirSync(join(root, "inbox"), { recursive: true });
    mkdirSync(join(root, "processing"), { recursive: true });
    cfg = { vaultRoot: root, juncoSubdir: "", maxTransientRetries: 2, retryBackoffSeconds: 60 } as unknown as Config;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const claimedFile = (content: string, name = "2026-06-10T1200Z__t1.md"): string => {
    const p = join(root, "processing", name);
    writeFileSync(p, content, "utf8");
    return p;
  };

  it("moves the ticket back to inbox with retry_count+1, a future not_before, and the claim stamp stripped", () => {
    const p = claimedFile("---\nid: t1\n---\ndo it\n");
    const t = parseTicket(p, readFileSync(p, "utf8"));
    const out = requeueTicket(cfg, p, t, "stop_reason=error");
    expect(out.requeued).toBe(true);
    expect(out.attempt).toBe(1);
    expect(out.dst).toBe(join(root, "inbox", "t1.md"));
    expect(existsSync(p)).toBe(false);
    const moved = readFileSync(out.dst!, "utf8");
    const parsed = parseTicket(out.dst!, moved);
    expect(parsed.retryCount).toBe(1);
    expect(Date.parse(parsed.notBefore!)).toBeGreaterThan(Date.now());
    expect(moved).not.toMatch(/junco-result/); // no result artifacts added
  });

  it("declines when the budget is exhausted", () => {
    const p = claimedFile("---\nid: t1\nretry_count: 2\n---\nx");
    const t = parseTicket(p, readFileSync(p, "utf8"));
    expect(requeueTicket(cfg, p, t, "r").requeued).toBe(false);
    expect(existsSync(p)).toBe(true); // untouched — caller finalizes to failed/
  });

  it("suffixes the name when the inbox already holds a same-named ticket", () => {
    writeFileSync(join(root, "inbox", "t1.md"), "occupied", "utf8");
    const p = claimedFile("---\nid: t1\n---\nx");
    const t = parseTicket(p, readFileSync(p, "utf8"));
    const out = requeueTicket(cfg, p, t, "r");
    expect(out.dst).toBe(join(root, "inbox", "t1-r1.md"));
  });

  it("CLAIM_PREFIX_RE matches the queue claim stamp", () => {
    expect(CLAIM_PREFIX_RE.test("2026-06-10T1200Z__x.md")).toBe(true);
    expect(CLAIM_PREFIX_RE.test("plain.md")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/requeue.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/requeue.ts`**

```ts
/**
 * Transparent requeue for transient failures — instead of routing a ticket to
 * failed/ when the inference side hiccuped, move it back to inbox/ with a
 * bumped retry_count and a not_before backoff stamp. The budget
 * (cfg.maxTransientRetries) caps total attempts; an exhausted budget returns
 * {requeued:false} and the caller finalizes to failed/ exactly as before.
 *
 * Classification is deliberately conservative: anything that produced commits,
 * timed out, or was guard-killed is NOT transient (retrying would discard or
 * repeat real work).
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config, RunResult, Ticket } from "./types.js";
import { queuePaths } from "./config.js";
import { log } from "./logging.js";

/** Matches the UTC claim stamp queue.claim() prefixes onto processing/ names. */
export const CLAIM_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{4}Z__/;

export function isTransientFailure(result: RunResult, newCommits: number): boolean {
  if (newCommits > 0) return false; // never discard committed work
  if (result.timedOut) return false; // slow is not transient
  if (result.abortedByGuard) return false; // behavioral, not infrastructural
  if (result.errorMessage !== null) return true; // session/network/SDK error
  return result.stopReason === "error" || result.stopReason === "length";
}

/**
 * Textually upsert a `key: value` line inside the YAML frontmatter block,
 * preserving the user's formatting everywhere else. Creates a frontmatter
 * block when the content has none.
 */
export function upsertFrontmatterKey(content: string, key: string, value: string | number): string {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return `---\n${key}: ${value}\n---\n\n${content}`;
  const block = m[1];
  const lineRe = new RegExp(`^${key}:.*$`, "m");
  const newBlock = lineRe.test(block) ? block.replace(lineRe, `${key}: ${value}`) : `${block}\n${key}: ${value}`;
  return content.slice(0, m.index) + `---\n${newBlock}\n---` + content.slice(m.index + m[0].length);
}

export interface RequeueOutcome {
  requeued: boolean;
  dst?: string;
  attempt?: number;
}

/**
 * Move a claimed ticket back to inbox/ for another attempt. Returns
 * {requeued:false} (file untouched) when the retry budget is exhausted.
 * The move is atomic: content is updated in place (tmp+rename inside
 * processing/), then renamed into inbox/ — no duplicate-visible window.
 */
export function requeueTicket(cfg: Config, claimedPath: string, ticket: Ticket, reason: string): RequeueOutcome {
  if (ticket.retryCount >= cfg.maxTransientRetries) return { requeued: false };
  const attempt = ticket.retryCount + 1;
  const notBefore = new Date(Date.now() + cfg.retryBackoffSeconds * attempt * 1000).toISOString();

  let content = readFileSync(claimedPath, "utf8");
  content = upsertFrontmatterKey(content, "retry_count", attempt);
  content = upsertFrontmatterKey(content, "not_before", JSON.stringify(notBefore));

  const tmp = claimedPath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, claimedPath);

  const inbox = queuePaths(cfg).inbox;
  let name = basename(claimedPath).replace(CLAIM_PREFIX_RE, "");
  if (existsSync(join(inbox, name))) name = name.replace(/\.md$/, `-r${attempt}.md`);
  const dst = join(inbox, name);
  renameSync(claimedPath, dst);
  log.warn("transient failure — requeued for retry", { dst, attempt, max: cfg.maxTransientRetries, reason, notBefore });
  return { requeued: true, dst, attempt };
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run tests/requeue.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/requeue.ts tests/requeue.test.ts
git commit -m "feat(requeue): transient-failure classification + atomic requeue-to-inbox with backoff"
```

---

### Task 11: Wire retries + `not_before` + readiness gate into the claim/execute paths

**Files:**
- Modify: `src/runOnce.ts`, `src/prFlow.ts`, `src/daemon.ts`
- Test: `tests/runOnce.test.ts`, `tests/prFlow.test.ts`, `tests/daemon.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/runOnce.test.ts` (reuse its existing fixture helpers for cfg/inbox/fake session):

```ts
it("skips tickets whose not_before is in the future", async () => {
  writeTicket("future.md", `---\nid: future\nnot_before: "2099-01-01T00:00:00Z"\n---\nq`);
  const handled = await runOnce(cfg, { sessionFactoryFor: fakeFactory });
  expect(handled).toBe(false); // nothing eligible
  expect(existsSync(join(paths.inbox, "future.md"))).toBe(true); // not claimed
});

it("treats an unparsable not_before as eligible", async () => {
  writeTicket("odd.md", `---\nid: odd\nnot_before: "not-a-date"\n---\nq`);
  const handled = await runOnce(cfg, { sessionFactoryFor: fakeFactory });
  expect(handled).toBe(true);
});

it("readiness gate: does not claim when readyFn says the endpoint is down", async () => {
  writeTicket("t.md", "---\nid: t\n---\nq");
  const handled = await runOnce(cfg, { sessionFactoryFor: fakeFactory, readyFn: async () => false });
  expect(handled).toBe(false);
  expect(existsSync(join(paths.inbox, "t.md"))).toBe(true); // still in inbox, not burned
});

it("Q&A transient error requeues instead of failing (budget permitting)", async () => {
  writeTicket("t.md", "---\nid: t\n---\nq");
  const erroringFactory = () => async () => fakeSession({ throwOnPrompt: new Error("fetch failed") });
  const handled = await runOnce(cfg, { sessionFactoryFor: erroringFactory });
  expect(handled).toBe(true);
  expect(readdirSync(paths.inbox).length).toBe(1); // back in inbox with retry_count 1
  expect(readdirSync(paths.failed).length).toBe(0);
});
```

(Adapt `writeTicket` / `fakeFactory` / `fakeSession` to the helpers that already exist in the file — every runOnce test already builds these; `throwOnPrompt` may need a one-line extension of the local fake.)

Append to `tests/prFlow.test.ts` (reuse its real-temp-repo fixtures and fake session factories):

```ts
it("transient agent error with zero commits requeues the ticket and removes the worktree", async () => {
  // fake worker session that throws (no commits made)
  const dst = await runPrFlow(cfg, task, claimedPath, ctx, {
    sessionFactoryFor: () => () => Promise.reject(new Error("ECONNREFUSED")),
    dirs,
  });
  expect(dst).toMatch(/inbox/); // requeued, not failed
  expect(readFileSync(dst, "utf8")).toMatch(/retry_count: 1/);
});

it("transient error with retry budget exhausted routes to failed/ as before", async () => {
  // claimed ticket whose frontmatter already carries retry_count: 2 (== default budget)
  const dst = await runPrFlow(cfg, taskWithRetryCount2, claimedPath2, ctx2, {
    sessionFactoryFor: () => () => Promise.reject(new Error("ECONNREFUSED")),
    dirs,
  });
  expect(dst).toMatch(/failed/);
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/runOnce.test.ts tests/prFlow.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/runOnce.ts`.**
  - Extend `RunDeps`:

```ts
export interface RunDeps {
  sessionFactoryFor?: (cfg: Config, cwd: string) => () => Promise<AgentSessionLike>;
  criticSessionFactory?: () => Promise<AgentSessionLike>;
  /** Probe before claiming: false → leave the inbox untouched this poll. */
  readyFn?: () => Promise<boolean>;
}
```

  - After the priority sort, filter on `not_before` (unparseable = eligible):

```ts
  const now = Date.now();
  const eligible = parsed.filter((t) => {
    if (!t.notBefore) return true;
    const ts = Date.parse(t.notBefore);
    return Number.isNaN(ts) || ts <= now;
  });
  if (eligible.length === 0) return false;
```

  - Before claiming (and only when there is eligible work), gate on readiness:

```ts
  if (deps.readyFn && !(await deps.readyFn())) {
    log.warn("inference endpoint not ready; leaving inbox untouched this poll", { eligible: eligible.length });
    return false;
  }
  const next = eligible[0];
```

  - In the Q&A path, after `const result = await runAgent(...)` and before `finalize(...)`:

```ts
      if (isTransientFailure(result, 0)) {
        const rq = requeueTicket(cfg, claimed, next, result.errorMessage ?? `stop_reason=${result.stopReason}`);
        if (rq.requeued) return true;
      }
```

  - Imports: `import { isTransientFailure, requeueTicket } from "./requeue.js";`

- [ ] **Step 4: Implement `src/prFlow.ts`.**
  - Import: `import { isTransientFailure, requeueTicket } from "./requeue.js";`
  - Hoist the since-ref above Phase 5 (it currently lives in Phase 6): immediately after the `runAgent` call ends, compute `const sinceRef = isAmend(ctx) ? preRunHead : \`origin/${ctx.baseBranch}\`;` and delete the duplicate declaration in Phase 6.
  - Replace the Phase-5 block with:

```ts
  // --- Phase 5: Hard-exit check (non-guard error). A guard abort is a SOFT
  // abort; a TRANSIENT error with zero commits is requeued (budget permitting).
  const hardError = result.errorMessage !== null && !result.abortedByGuard && !result.timedOut;
  if (hardError) {
    let commitsSoFar = 0;
    try {
      commitsSoFar = await countNewCommits(cfg, wtPath, sinceRef);
    } catch {
      /* unreadable worktree → treat as 0; the requeue below is still safe */
    }
    if (isTransientFailure(result, commitsSoFar)) {
      const rq = requeueTicket(cfg, claimedPath, task, result.errorMessage ?? "agent session error");
      if (rq.requeued) {
        await cleanupWorktree(cfg, ctx, wtPath);
        return rq.dst!;
      }
    }
    prOutcome.worktreePreserved = true;
    return finalizePr(claimedPath, result, prOutcome, { dirs });
  }
```

  (Timeout handling moves to Task 13; until then keep the old behavior for timeouts by ALSO keeping, directly above the `hardError` block: `if (result.timedOut) { prOutcome.worktreePreserved = true; return finalizePr(claimedPath, result, prOutcome, { dirs }); }` — Task 13 replaces it.)

  - In Phase 8, before the existing `stop_reason === "error"` failure branch, insert:

```ts
    if (newCommits === 0 && (result.stopReason === "error" || result.stopReason === "length")) {
      const rq = requeueTicket(cfg, claimedPath, task, `stop_reason=${result.stopReason}`);
      if (rq.requeued) {
        await cleanupWorktree(cfg, ctx, wtPath);
        return rq.dst!;
      }
      // budget exhausted → fall through to the existing terminal handling below
    }
```

- [ ] **Step 5: Implement `src/daemon.ts`** — wire the daemon's default runOnce to the readiness probe (run-once CLI stays ungated):

```ts
  const runOnceFn = deps.runOnceFn ?? ((c: Config) => runOnce(c, { readyFn: () => endpointReachable(c) }));
```

(`endpointReachable` is already imported after Task 4.)

- [ ] **Step 6: Run, verify pass** — `npx vitest run tests/runOnce.test.ts tests/prFlow.test.ts tests/daemon.test.ts` → PASS; then full suite. Pay attention to one prFlow detail: after a requeue + `cleanupWorktree`, a second attempt must be able to re-provision the same branch. The existing `tests/worktree.test.ts` covers cleanup semantics; add this integration check to `tests/prFlow.test.ts` if not already covered by Step 1's first test running twice:

```ts
it("a requeued ticket can be re-claimed and re-provisioned (no branch collision)", async () => {
  const dst1 = await runPrFlow(cfg, task, claimedPath, ctx, { sessionFactoryFor: failingOnce, dirs });
  expect(dst1).toMatch(/inbox/);
  // re-claim (simulate the queue) and run again with a working fake session
  const claimed2 = claim(dst1, processingDir)!;
  const task2 = parseTicket(claimed2, readFileSync(claimed2, "utf8"));
  const dst2 = await runPrFlow(cfg, task2, claimed2, freshCtx(), { sessionFactoryFor: committingFake, dirs });
  expect(dst2).toMatch(/done/);
});
```

- [ ] **Step 7: Commit**

```bash
git add src/runOnce.ts src/prFlow.ts src/daemon.ts tests/runOnce.test.ts tests/prFlow.test.ts tests/daemon.test.ts
git commit -m "feat(resilience): transient-failure requeue with backoff, not_before scheduling, endpoint readiness gate before claim"
```

---

### Task 12: Orphan recovery requeues instead of failing (budget permitting)

**Files:**
- Modify: `src/orphans.ts`
- Test: `tests/orphans.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/orphans.test.ts` (reuse its tmp-vault fixture):

```ts
it("requeues a crashed ticket to inbox with retry_count+1 when budget remains", () => {
  writeFileSync(join(processing, "2026-06-10T1200Z__crash.md"), "---\nid: crash\n---\nwork\n", "utf8");
  const moved = recoverOrphans(cfg); // cfg.maxTransientRetries = 2 (default)
  expect(moved).toHaveLength(1);
  expect(moved[0]).toContain("inbox");
  const content = readFileSync(moved[0], "utf8");
  expect(content).toMatch(/retry_count: 1/);
  expect(content).not.toMatch(/Orphan recovery/); // no failure banner on a requeue
});

it("routes to failed/ with the banner once the budget is exhausted", () => {
  writeFileSync(join(processing, "2026-06-10T1200Z__crash.md"), "---\nid: crash\nretry_count: 2\n---\nwork\n", "utf8");
  const moved = recoverOrphans(cfg);
  expect(moved[0]).toContain("failed");
  expect(readFileSync(moved[0], "utf8")).toMatch(/Orphan recovery/);
});
```

(If the existing fixture's `cfg` stub lacks `maxTransientRetries`/`retryBackoffSeconds`, add them: `maxTransientRetries: 2, retryBackoffSeconds: 60`.)

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/orphans.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `src/orphans.ts`, inside the per-orphan loop, after reading `existing`, parse and try the requeue FIRST:

```ts
    // A crash is infrastructure, not a verdict on the ticket — requeue under
    // the same transient budget; only an exhausted budget routes to failed/.
    const parsed = parseTicket(orphanPath, existing);
    const rq = requeueTicket(cfg, orphanPath, parsed, "orphan-recovery (worker crashed mid-run)");
    if (rq.requeued) {
      moved.push(rq.dst!);
      continue;
    }
```

Add imports: `import { parseTicket } from "./ticket.js";` and `import { requeueTicket } from "./requeue.js";`. The existing metadata-block + banner + move-to-failed code stays as the fall-through path. Update the banner sentence "Moving to failed/ without re-running." → "Retry budget exhausted; moving to failed/. Move back to inbox/ to retry by hand."

- [ ] **Step 4: Run, verify pass** — `npx vitest run tests/orphans.test.ts` → PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/orphans.ts tests/orphans.test.ts
git commit -m "feat(orphans): requeue crashed tickets under the transient-retry budget instead of failing them"
```

---

### Task 13: Timeout salvage — push committed work, add `timeout_partial`

A guard kill already salvages commits into a PR; a timeout currently abandons them in a preserved worktree. Treat timeout as a soft abort: skip post-session review, salvage commits, push, open the PR with a partial-run banner.

**Files:**
- Modify: `src/prFlow.ts`, `src/finalize.ts`, `src/types.ts`
- Test: `tests/prFlow.test.ts`, `tests/finalize.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/finalize.test.ts`:

```ts
it("computePrStatus: timeout with pushed commits → timeout_partial (done/); without → timeout (failed/)", () => {
  const base = { finalText: "", toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
    stopReason: null, errorMessage: null, timedOut: true, durationMs: 1, abortedByGuard: false };
  expect(computePrStatus(base, { ...emptyOutcome, pushed: true } as PrOutcome, null)).toBe("timeout_partial");
  expect(computePrStatus(base, { ...emptyOutcome, pushed: false } as PrOutcome, null)).toBe("timeout");
});
```

(Use the file's existing `emptyOutcome`-style fixture or construct the minimal `PrOutcome` literal the file already uses.)

Append to `tests/prFlow.test.ts`:

```ts
it("a timed-out session with commits is salvaged: pushed, PR opened, status timeout_partial, ticket → done/", async () => {
  // fake session that makes a commit, then runAgent reports timedOut
  const dst = await runPrFlow(cfg, task, claimedPath, ctx, {
    sessionFactoryFor: committingThenTimingOutFake, dirs,
  });
  expect(dst).toMatch(/done/);
  expect(readFileSync(dst, "utf8")).toMatch(/status: timeout_partial/);
});

it("a timed-out session with no commits fails with a preserved worktree", async () => {
  const dst = await runPrFlow(cfg, task, claimedPath, ctx, {
    sessionFactoryFor: idleTimingOutFake, dirs,
  });
  expect(dst).toMatch(/failed/);
  expect(readFileSync(dst, "utf8")).toMatch(/timed out|timeout/i);
});
```

For the fakes: the file's existing fake sessions expose enough control to set `timedOut` — runAgent sets `timedOut` only via its own timer, so build the fake by passing `timeoutMs` ≈ 50 on the task fixture (`timeout_minutes: 0.001` is rejected by parseTicket's positive check — instead give the fake session a `prompt()` that commits via `execSync` in the worktree then hangs `await new Promise(() => {})` until runAgent's timer aborts it; `abort()` resolves the hang). Mirror whichever pattern `tests/session.test.ts` already uses for its timeout test.

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/finalize.test.ts tests/prFlow.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/types.ts`** — add `"timeout_partial"` to `TERMINAL_DONE_STATUSES`:

```ts
export const TERMINAL_DONE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "completed_no_changes",
  "aborted_partial",
  "timeout_partial",
]);
```

- [ ] **Step 4: Implement `src/finalize.ts`.**
  - `computePrStatus`: replace `if (result.timedOut) return "timeout";` with:

```ts
  if (result.timedOut) return pushed ? "timeout_partial" : "timeout";
```

  (`pushed` is already computed on the first line of the function.)
  - `renderPrResult`: extend the banner cascade with a `timeout_partial` case, after the `aborted_partial` branch:

```ts
  } else if (status === "timeout_partial") {
    lines.push(
      `> **⚠️ Partial run — hit the ticket timeout mid-session.** Commits made before the cutoff were salvaged and pushed. Review for completeness; consider an amendment ticket to finish.`,
    );
```

- [ ] **Step 5: Implement `src/prFlow.ts`.**
  - Delete the temporary timeout early-return added in Task 11 (`if (result.timedOut) { … }` above the `hardError` block). Timeouts now flow into Phases 6+.
  - Phase 8, before the stop-reason branches, add the zero-commit timeout gate:

```ts
    if (newCommits === 0 && result.timedOut) {
      const phaseError = `agent hit the ${Math.round(task.timeoutSeconds / 60)}-minute ticket timeout with no commits`;
      prOutcome.worktreePreserved = true;
      log.warn(`${phaseError} — preserving worktree, routing to failed`);
      return finalizePr(claimedPath, result, prOutcome, { dirs, phaseError });
    }
```

  - Phase 9: `const skipPostSessionReview = result.abortedByGuard || result.timedOut;` and extend the skip-metadata line:

```ts
      prOutcome.critic = {
        status: "skipped",
        findings: result.timedOut ? "timed-out session" : "aborted-by-repetition session",
        rawOutput: "",
      };
```

  - `buildPrBody`: after the existing `result.abortedByGuard` banner block, add:

```ts
  if (result.timedOut) {
    parts.push(
      "> ⚠️ **Partial run.** This PR was opened from a session that hit its ticket " +
        "timeout — commits made before the cutoff were salvaged. Review for " +
        "completeness; consider an amendment ticket to finish.",
    );
  }
```

- [ ] **Step 6: Run, verify pass** — target files, then full suite: `npx tsc -p tsconfig.json && npx vitest run` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/finalize.ts src/prFlow.ts tests/finalize.test.ts tests/prFlow.test.ts
git commit -m "feat(prflow): salvage committed work on timeout — push, open PR, terminal status timeout_partial"
```

---

# Phase 3 — Shutdown semantics

### Task 14: Force-stop — second signal aborts the in-flight session and salvages

**Files:**
- Modify: `src/daemon.ts` (StopFlag + installSignalHandlers + mainLoop default), `src/agent/session.ts` (runAgent abortSignal), `src/runOnce.ts`, `src/prFlow.ts` (thread the signal)
- Test: `tests/daemon.test.ts`, `tests/session.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/daemon.test.ts`:

```ts
describe("force stop", () => {
  it("StopFlag: requestForceStop aborts the forceSignal and latches requested", () => {
    const f = new StopFlag();
    expect(f.forceSignal.aborted).toBe(false);
    f.requestForceStop();
    expect(f.forceSignal.aborted).toBe(true);
    expect(f.requested).toBe(true);
  });

  it("signal handlers escalate: 1st → graceful, 2nd → force", () => {
    const f = new StopFlag();
    const uninstall = installSignalHandlers(f);
    process.emit("SIGTERM");
    expect(f.requested).toBe(true);
    expect(f.forceSignal.aborted).toBe(false);
    process.emit("SIGTERM");
    expect(f.forceSignal.aborted).toBe(true);
    uninstall();
  });
});
```

Append to `tests/session.test.ts` (reuse its fake-session helpers):

```ts
it("an aborted external signal kills the run and salvages (abortedByGuard semantics)", async () => {
  const ac = new AbortController();
  const session = fakeSession({
    onPrompt: async () => {
      ac.abort(); // operator presses Ctrl-C twice mid-run
      await abortedPromise; // resolves when session.abort() is called
    },
  });
  const result = await runAgent({
    body: "x", cwd: "/tmp", timeoutMs: 5_000,
    createSession: async () => session,
    abortSignal: ac.signal,
  });
  expect(result.abortedByGuard).toBe(true);
  expect(result.errorMessage).toMatch(/force-stop/);
});
```

(Build `fakeSession`/`abortedPromise` from the file's existing fake-session pattern: `abort()` resolves a deferred that `prompt()` awaits — the same mechanism its guard-kill tests already use.)

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/daemon.test.ts tests/session.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/daemon.ts`.** Extend `StopFlag`:

```ts
export class StopFlag implements StopFlagLike {
  private _requested = false;
  private readonly _force = new AbortController();

  get requested(): boolean {
    return this._requested;
  }

  /** Aborts when a force-stop is requested; runAgent listens on this. */
  get forceSignal(): AbortSignal {
    return this._force.signal;
  }

  requestStop(): void {
    if (!this._requested) {
      log.info("stop requested; will exit after current task (signal again to abort it)");
    }
    this._requested = true;
  }

  requestForceStop(): void {
    this._requested = true;
    if (!this._force.signal.aborted) {
      log.warn("force stop: aborting in-flight agent session (committed work will be salvaged)");
      this._force.abort();
    }
  }
}
```

Replace `installSignalHandlers`:

```ts
export function installSignalHandlers(stopFlag: StopFlag): () => void {
  let count = 0;
  const handler = (): void => {
    count++;
    if (count === 1) stopFlag.requestStop();
    else if (count === 2) stopFlag.requestForceStop();
    else process.exit(130); // third signal: operator really means it
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  return () => {
    process.removeListener("SIGTERM", handler);
    process.removeListener("SIGINT", handler);
  };
}
```

In `mainLoop`, thread the signal into the default runOnce (building on Task 11's default):

```ts
  const runOnceFn =
    deps.runOnceFn ??
    ((c: Config) => runOnce(c, { readyFn: () => endpointReachable(c), abortSignal: stopFlag.forceSignal }));
```

- [ ] **Step 4: Implement `src/agent/session.ts`.** Add to `RunAgentOptions`:

```ts
  /** External abort (operator force-stop). Treated like a guard kill: the run
   * is aborted softly and any commits already made are salvaged. */
  abortSignal?: AbortSignal;
```

In `runAgent`, after the timer is set up and before `subscribe`:

```ts
  const onExternalAbort = (): void => {
    if (killReason === null) killReason = "force-stop requested by operator";
    void session.abort().catch(() => {});
  };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) onExternalAbort();
    else opts.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
```

In the `finally`, before `session.dispose()`:

```ts
    opts.abortSignal?.removeEventListener("abort", onExternalAbort);
```

(No other change: a non-null `killReason` already produces `supervisor kill: …` errorMessage and `abortedByGuard: true` salvage semantics. The errorMessage will read `supervisor kill: force-stop requested by operator (no nudges issued)` — acceptable and grep-able.)

- [ ] **Step 5: Thread through `src/runOnce.ts` and `src/prFlow.ts`.**
  - `RunDeps` gains `abortSignal?: AbortSignal;` — pass it to the Q&A `runAgent({ …, abortSignal: deps.abortSignal })` and into `runPrFlow(cfg, next, claimed, ctx, { …, abortSignal: deps.abortSignal })`.
  - `PrFlowDeps` gains `abortSignal?: AbortSignal;` — pass to BOTH `runAgent` calls (worker + corrective re-dispatch). The critic's internal session is not threaded (it is short and tool-less); note this in a comment where the critic runs:

```ts
      // Force-stop does not abort the critic: it is tool-less and bounded; a
      // force-stopped worker session never reaches here anyway (guard-abort path).
```

- [ ] **Step 6: Run, verify pass** — `npx vitest run tests/daemon.test.ts tests/session.test.ts` → PASS; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/daemon.ts src/agent/session.ts src/runOnce.ts src/prFlow.ts tests/daemon.test.ts tests/session.test.ts
git commit -m "feat(daemon): force-stop on second signal — abort in-flight session, salvage commits, exit on third"
```

---

### Task 15: Service units get real stop timeouts + state-dir log paths

**Files:**
- Modify: `src/service.ts`, `src/cli.ts` (service subcommand)
- Test: `tests/service.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/service.test.ts`:

```ts
it("launchd plist sets ExitTimeOut from stopTimeoutSeconds", () => {
  const out = renderLaunchdPlist({ cliEntry: "/x/cli.js", configPath: "/x/config.toml", stopTimeoutSeconds: 2400 });
  expect(out).toContain("<key>ExitTimeOut</key><integer>2400</integer>");
});

it("systemd unit sets TimeoutStopSec from stopTimeoutSeconds", () => {
  const out = renderSystemdUnit({ cliEntry: "/x/cli.js", configPath: "/x/config.toml", stopTimeoutSeconds: 2400 });
  expect(out).toContain("TimeoutStopSec=2400");
});

it("defaults stopTimeoutSeconds to 2400 (40 min — covers the 30-min default ticket + drain)", () => {
  const out = renderSystemdUnit({ cliEntry: "/x/cli.js", configPath: "/x/config.toml" });
  expect(out).toContain("TimeoutStopSec=2400");
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/service.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/service.ts`.**
  - `ServiceOpts` gains:

```ts
  /** Grace period (seconds) the supervisor allows between its stop signal and
   * SIGKILL. Must exceed the longest ticket timeout so a graceful shutdown can
   * drain the in-flight task. Default 2400 (40 min). */
  stopTimeoutSeconds?: number;
```

  - `resolveOpts` resolves it: `const stopTimeoutSeconds = opts.stopTimeoutSeconds ?? 2400;` (add to the returned object).
  - `renderLaunchdPlist`: after the `<key>ThrottleInterval</key>` line add:

```
    <key>ExitTimeOut</key><integer>${o.stopTimeoutSeconds}</integer>
```

  - `renderSystemdUnit`: after `RestartSec=30` add:

```
TimeoutStopSec=${o.stopTimeoutSeconds}
```

- [ ] **Step 4: Implement `src/cli.ts` (service subcommand).** Derive the timeout and log dir from the config when it exists (the subcommand currently never loads config — make it best-effort):

```ts
    let stopTimeoutSeconds: number | undefined;
    let logDir: string | undefined;
    try {
      const cfg = loadConfigFn(configPath);
      stopTimeoutSeconds = (cfg.defaultTimeoutMinutes + 10) * 60; // ticket + drain margin
      logDir = cfg.stateDir;
    } catch {
      /* no config yet — renderService falls back to its defaults */
    }
    const rendered = renderService(platform, { cliEntry, configPath, stopTimeoutSeconds, logDir });
```

- [ ] **Step 5: Run, verify pass** — `npx vitest run tests/service.test.ts tests/cli.test.ts` → PASS; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/service.ts src/cli.ts tests/service.test.ts
git commit -m "feat(service): stop timeouts (ExitTimeOut/TimeoutStopSec) sized to the ticket timeout; logs under state dir"
```

---

# Phase 4 — Config discovery + day-2 CLI

### Task 16: User-level config resolution (`~/.config/junco/config.toml`)

**Files:**
- Modify: `src/config.ts` (add `resolveConfigPath` + `defaultUserConfigPath`), `src/cli.ts` (use it everywhere), `src/wizard.ts` (drop `--config` noise from next-steps when on the default path)
- Test: `tests/config.test.ts`, `tests/cli.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/config.test.ts`:

```ts
import { resolveConfigPath, defaultUserConfigPath } from "../src/config.js";

describe("resolveConfigPath", () => {
  it("explicit path wins, resolved against cwd", () => {
    expect(resolveConfigPath("rel/c.toml", { cwd: () => "/base" })).toBe("/base/rel/c.toml");
  });
  it("falls back to ./config.toml when it exists", () => {
    const p = resolveConfigPath(undefined, { cwd: () => "/base", existsFn: (x) => x === "/base/config.toml" });
    expect(p).toBe("/base/config.toml");
  });
  it("otherwise resolves the XDG user path", () => {
    const p = resolveConfigPath(undefined, {
      cwd: () => "/base",
      existsFn: () => false,
      env: { XDG_CONFIG_HOME: "/xdg" },
    });
    expect(p).toBe("/xdg/junco/config.toml");
  });
  it("defaultUserConfigPath honors XDG_CONFIG_HOME and falls back to ~/.config", () => {
    expect(defaultUserConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/junco/config.toml");
    expect(defaultUserConfigPath({}).endsWith("/.config/junco/config.toml")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/config.test.ts` → FAIL.

- [ ] **Step 3: Implement in `src/config.ts`** (below `expandHome`; `existsSync` needs adding to the fs import, `resolve` to the path import):

```ts
/** The user-level default config location (XDG_CONFIG_HOME or ~/.config). */
export function defaultUserConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== "" ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(base, "junco", "config.toml");
}

export interface ResolveConfigDeps {
  existsFn?: (p: string) => boolean;
  env?: Record<string, string | undefined>;
  cwd?: () => string;
}

/**
 * Where the config lives. Order: explicit --config → ./config.toml when present
 * (repo-local setups keep working) → the user-level default. The returned path
 * may not exist yet — first-run detection checks that separately.
 */
export function resolveConfigPath(explicit: string | undefined, deps: ResolveConfigDeps = {}): string {
  const existsFn = deps.existsFn ?? existsSync;
  const cwd = deps.cwd ?? (() => process.cwd());
  if (explicit) return resolve(cwd(), explicit);
  const local = resolve(cwd(), "config.toml");
  if (existsFn(local)) return local;
  return defaultUserConfigPath(deps.env ?? process.env);
}
```

- [ ] **Step 4: Implement `src/cli.ts`.**
  - `parseArgs` options: change `config: { type: "string", default: "config.toml" }` → `config: { type: "string" }` (no default).
  - Right after the `--help` early-return and the `existsFn` binding, resolve ONCE:

```ts
  const configPath = resolveConfigPath(values.config as string | undefined, { existsFn });
```

  - Replace every later use of `values.config as string` / `resolve(values.config as string)` with `configPath` (subcommands: service, run-once, start, inbox-path, submit, init; the first-run routing line becomes `positionals[0] ?? (existsFn(configPath) ? "start" : "init")`).
  - Update `USAGE`:

```
  --config <path>       Path to config.toml
                        [default: ./config.toml if present, else ~/.config/junco/config.toml]
```

  - Import: `import { loadConfig, queuePaths, resolveConfigPath } from "./config.js";`

- [ ] **Step 5: Update `src/wizard.ts` next-steps** — drop the `--config` suffixes when the wizard wrote to the resolved default. In `runInitWizard`, where the next-steps are printed:

```ts
    const flag = resolved === resolveConfigPath(undefined) ? "" : ` --config ${resolved}`;
    printFn(
      `\n✓ Wrote config:  ${resolved}\n` +
        `✓ Created queue: ${queueRoot}/{inbox,processing,done,failed}\n\n` +
        `Next steps:\n` +
        `  • Tweak the model/endpoint in ${resolved} if needed.\n` +
        `  • Start the worker:  junco start${flag}\n` +
        `  • Submit a ticket:   junco submit <ticket>.md${flag}\n`,
    );
```

(Import `resolveConfigPath` from `./config.js`.)

- [ ] **Step 6: Run the cli/wizard suites and repair pinned-path assertions**

Run: `npx vitest run tests/cli.test.ts tests/wizard.test.ts`
Expected breakage is mechanical and of one shape: tests that relied on the implicit `config.toml` CWD default. Fix rule: where a test asserted routing against `resolve("config.toml")`, it now asserts against `resolveConfigPath(undefined, { existsFn: <same injected fn> })` — or simpler, pass an explicit `--config <tmp>/config.toml` in the test's argv, which pins behavior independent of the environment. Do NOT weaken any assertion; prefer adding the explicit flag.

- [ ] **Step 7: Full suite** — `npx tsc -p tsconfig.json && npx vitest run` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/cli.ts src/wizard.ts tests/config.test.ts tests/cli.test.ts tests/wizard.test.ts
git commit -m "feat(cli): user-level config discovery — ./config.toml, else ~/.config/junco/config.toml"
```

---

### Task 17: Structured logs to a state-dir file + human-readable TTY format

**Files:**
- Modify: `src/logging.ts`, `src/cli.ts` (start/run-once wiring)
- Test: `tests/logging.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/logging.test.ts` (the file already captures stdout writes; follow its pattern):

```ts
it("setLogSink tees the JSON line to the sink regardless of format", () => {
  const sunk: string[] = [];
  setLogSink((l) => sunk.push(l));
  setLogFormat("human");
  log.info("hello", { a: 1 });
  setLogSink(null);
  setLogFormat("json");
  expect(sunk).toHaveLength(1);
  const entry = JSON.parse(sunk[0]);
  expect(entry.msg).toBe("hello");
  expect(entry.a).toBe(1);
});

it("formatHumanLine renders ts/level/ticket/msg and leftover fields", () => {
  const line = formatHumanLine({ ts: "2026-06-10T12:34:56.789Z", level: "warn", ticket: "t-1", msg: "careful", extra: 7 });
  expect(line).toContain("12:34:56");
  expect(line).toContain("WARN");
  expect(line).toContain("[t-1]");
  expect(line).toContain("careful");
  expect(line).toContain('"extra":7');
});

it("rotateLogIfLarge renames an oversized file to .1", () => {
  const dir = mkdtempSync(join(tmpdir(), "junco-log-"));
  const p = join(dir, "worker.log");
  writeFileSync(p, "x".repeat(64), "utf8");
  rotateLogIfLarge(p, 10);
  expect(existsSync(p)).toBe(false);
  expect(existsSync(p + ".1")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/logging.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/logging.ts`.** Add (keeping the existing exports untouched):

```ts
let sink: ((jsonLine: string) => void) | null = null;
let format: "json" | "human" = "json";

/** Tee every emitted entry (as its JSON line) to a sink — the daemon points
 * this at the state-dir worker.log. null disables. */
export function setLogSink(fn: ((jsonLine: string) => void) | null): void {
  sink = fn;
}

/** "human" renders colorized single-line output for TTYs; the sink always
 * receives JSON regardless. */
export function setLogFormat(f: "json" | "human"): void {
  format = f;
}

const LEVEL_COLOR: Record<Level, string> = {
  debug: "\x1b[2m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

/** Render one structured entry for human eyes (also used by `junco logs`). */
export function formatHumanLine(entry: Record<string, unknown>): string {
  const ts = typeof entry.ts === "string" ? entry.ts.slice(11, 19) : "";
  const level = String(entry.level ?? "info") as Level;
  const ticket = entry.ticket && entry.ticket !== "-" ? `[${String(entry.ticket)}] ` : "";
  const rest: Record<string, unknown> = { ...entry };
  delete rest.ts; delete rest.level; delete rest.ticket; delete rest.msg;
  const fields = Object.keys(rest).length > 0 ? " " + JSON.stringify(rest) : "";
  const color = LEVEL_COLOR[level] ?? "";
  return `${ts} ${color}${level.toUpperCase().padEnd(5)}${RESET} ${ticket}${String(entry.msg ?? "")}${fields}`;
}

/** Size-capped single-generation rotation: worker.log → worker.log.1. */
export function rotateLogIfLarge(path: string, maxBytes = 10 * 1024 * 1024): void {
  try {
    if (statSync(path).size > maxBytes) renameSync(path, path + ".1");
  } catch {
    /* missing file → nothing to rotate */
  }
}
```

and rework `emit`'s tail:

```ts
  const entry = { ...fields, ts: new Date().toISOString(), level, ticket, msg };
  const jsonLine = JSON.stringify(entry);
  if (sink) sink(jsonLine);
  process.stdout.write((format === "human" ? formatHumanLine(entry) : jsonLine) + "\n");
```

Imports: `import { statSync, renameSync } from "node:fs";`

- [ ] **Step 4: Wire in `src/cli.ts`.** Extract a tiny helper above `run()` and call it in BOTH the `start` and `run-once` subcommands, right after `setLogLevel(cfg.logLevel)`:

```ts
/** Daemon-mode log plumbing: human format on a TTY, JSON tee to the state-dir
 * worker.log (rotated at 10MB). Returns a cleanup that closes the stream. */
function setupLogOutputs(cfg: Config): () => void {
  if (process.stdout.isTTY && process.env.JUNCO_LOG_JSON !== "1") setLogFormat("human");
  if (!cfg.logToFile) return () => {};
  try {
    const logPath = join(cfg.stateDir, "worker.log");
    mkdirSync(cfg.stateDir, { recursive: true });
    rotateLogIfLarge(logPath);
    const stream = createWriteStream(logPath, { flags: "a" });
    setLogSink((l) => stream.write(l + "\n"));
    return () => {
      setLogSink(null);
      stream.end();
    };
  } catch (e) {
    log.warn("file logging disabled (state dir not writable)", { error: e instanceof Error ? e.message : String(e) });
    return () => {};
  }
}
```

Call pattern in `start` (mirror in `run-once`):

```ts
    const cfg = loadConfigFn(configPath);
    setLogLevel(cfg.logLevel);
    const teardownLogs = setupLogOutputs(cfg);
```

…and in the `start` subcommand's existing `finally` block add `teardownLogs();` (in `run-once`, wrap the `runOnceFn` call in `try { … } finally { teardownLogs(); }`).
Imports to add in cli.ts: `createWriteStream` from `node:fs`, and `setLogFormat, setLogSink, rotateLogIfLarge` from `./logging.js`.

- [ ] **Step 5: Run, verify pass** — `npx vitest run tests/logging.test.ts tests/cli.test.ts` → PASS; full suite green. (cli tests run non-TTY so the human-format branch stays off; no assertion churn expected.)

- [ ] **Step 6: Commit**

```bash
git add src/logging.ts src/cli.ts tests/logging.test.ts
git commit -m "feat(logging): JSON tee to <state_dir>/worker.log with rotation + human TTY format"
```

---

### Task 18: `junco status`

**Files:**
- Create: `src/statusCmd.ts`
- Modify: `src/lock.ts` (add `readLockHolder`), `src/cli.ts` (subcommand + usage)
- Test: `tests/statusCmd.test.ts`, `tests/lock.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `tests/statusCmd.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStatusCommand, fmtUptime } from "../src/statusCmd.js";
import type { Config } from "../src/types.js";

describe("fmtUptime", () => {
  it("renders s / m / h forms", () => {
    expect(fmtUptime(42)).toBe("42s");
    expect(fmtUptime(150)).toBe("2m30s");
    expect(fmtUptime(8010)).toBe("2h13m");
  });
});

describe("runStatusCommand", () => {
  let root: string;
  let cfg: Config;
  let out: string[];
  const print = (s: string) => out.push(s);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-status-"));
    for (const d of ["inbox", "processing", "done", "failed"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "inbox", "a.md"), "x");
    writeFileSync(join(root, "failed", "b.md"), "x");
    cfg = { vaultRoot: root, juncoSubdir: "", healthHost: "127.0.0.1", healthPort: 8787 } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("daemon running: renders /health fields + queue counts", async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({
        status: "ok", ready: true,
        metrics: { pid: 42, uptimeSeconds: 150, currentTicket: "t-1", currentTickets: ["t-1"],
          tasksProcessed: 3, tasksSucceeded: 2, tasksFailed: 1,
          totalTokensIn: 10, totalTokensOut: 20, lastTaskStatus: "completed", lastTaskAt: "2026-06-10T12:00:00Z" },
      }),
    })) as unknown as typeof fetch;
    const code = await runStatusCommand(cfg, { fetchFn, printFn: print, lockHolderFn: () => 42 });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/daemon:\s+running \(pid 42, up 2m30s\)/);
    expect(text).toMatch(/endpoint:\s+ready/);
    expect(text).toMatch(/current:\s+t-1/);
    expect(text).toMatch(/inbox 1 .* processing 0 .* done 0 .* failed 1/);
  });

  it("daemon down: says not running and still prints queue counts", async () => {
    const fetchFn = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const code = await runStatusCommand(cfg, { fetchFn, printFn: print, lockHolderFn: () => null });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/daemon:\s+not running/);
    expect(text).toMatch(/inbox 1/);
  });
});
```

Append to `tests/lock.test.ts`:

```ts
it("readLockHolder: live pid → pid; missing file or dead pid → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "junco-lockread-"));
  const p = join(dir, "worker.lock");
  expect(readLockHolder(p)).toBeNull();
  writeFileSync(p, String(process.pid), "utf8");
  expect(readLockHolder(p)).toBe(process.pid);
  writeFileSync(p, "999999", "utf8"); // almost certainly dead
  expect(readLockHolder(p)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/statusCmd.test.ts tests/lock.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/lock.ts` addition** (reuse the module's existing pid-liveness helper if one is factored; otherwise):

```ts
/** Who holds the lock? The pid in the pidfile when that process is alive, else
 * null. Read-only — never mutates the lock. (Like the stale check, this is
 * inherently TOCTOU; fine for a status display.) */
export function readLockHolder(lockPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // throws if dead / not ours
    return pid;
  } catch {
    return null;
  }
}
```

Also add a short comment on `acquireSingletonLock` documenting the accepted TOCTOU window (single-user daemon; the worst case is a redundant exit-0):

```ts
// NOTE: the stale-check + unlink + recreate sequence has a small TOCTOU window
// if two processes race a stale lock. Accepted: junco is a per-user daemon and
// the loser of the race exits 0 on the next claim conflict.
```

- [ ] **Step 4: Implement `src/statusCmd.ts`**

```ts
/**
 * `junco status` — one-glance daemon + queue view. Reads GET /health when the
 * daemon is up; falls back to lockfile + queue-dir counts when it is not.
 */

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { readLockHolder } from "./lock.js";

export interface StatusDeps {
  fetchFn?: typeof fetch;
  printFn?: (s: string) => void;
  lockHolderFn?: (lockPath: string) => number | null;
  /** Lock path override (cli passes dirname(configPath)/worker.lock). */
  lockPath?: string;
  timeoutMs?: number;
}

export function fmtUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function countMd(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

export async function runStatusCommand(cfg: Config, deps: StatusDeps = {}): Promise<number> {
  const fetchFn = deps.fetchFn ?? fetch;
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const lockHolderFn = deps.lockHolderFn ?? readLockHolder;
  const paths = queuePaths(cfg);

  let daemonLine: string;
  let detailLines: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 1500);
  try {
    const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${(resp as Response).status}`);
    const body = (await resp.json()) as {
      ready: boolean;
      metrics: Record<string, unknown> & { currentTickets?: string[] };
    };
    const m = body.metrics;
    daemonLine = `running (pid ${m.pid}, up ${fmtUptime(Number(m.uptimeSeconds ?? 0))})`;
    const current = (m.currentTickets ?? (m.currentTicket ? [m.currentTicket] : [])) as string[];
    detailLines = [
      `endpoint:  ${body.ready ? "ready" : "UNREACHABLE"}`,
      `current:   ${current.length > 0 ? current.join(", ") : "idle"}`,
      `processed: ${m.tasksProcessed} (${m.tasksSucceeded} ok / ${m.tasksFailed} failed) · tokens in=${m.totalTokensIn} out=${m.totalTokensOut}`,
      `last task: ${m.lastTaskStatus ?? "—"}${m.lastTaskAt ? ` @ ${m.lastTaskAt}` : ""}`,
    ];
  } catch {
    const lockPath = deps.lockPath ?? join(dirname(paths.inbox), "worker.lock");
    const holder = lockHolderFn(lockPath);
    daemonLine = holder ? `not responding (lock held by pid ${holder} but /health unreachable)` : "not running";
  } finally {
    clearTimeout(timer);
  }

  print(`daemon:    ${daemonLine}\n`);
  for (const l of detailLines) print(l + "\n");
  print(
    `queue:     inbox ${countMd(paths.inbox)} · processing ${countMd(paths.processing)} · done ${countMd(paths.done)} · failed ${countMd(paths.failed)}\n`,
  );
  return 0;
}
```

- [ ] **Step 5: Wire `src/cli.ts`.** Add to `USAGE` subcommands:

```
  status       Show daemon / queue health at a glance
```

Add the subcommand handler (next to inbox-path; note the lock lives beside the config file, matching `start`):

```ts
  if (subcommand === "status") {
    const cfg = loadConfigFn(configPath);
    return runStatusCommand(cfg, { printFn, lockPath: join(dirname(configPath), "worker.lock") });
  }
```

Import `runStatusCommand` from `./statusCmd.js`.

- [ ] **Step 6: Run, verify pass** — target files, then full suite → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/statusCmd.ts src/lock.ts src/cli.ts tests/statusCmd.test.ts tests/lock.test.ts
git commit -m "feat(cli): junco status — daemon, endpoint, in-flight and queue counts at a glance"
```

---

### Task 19: `junco list`

**Files:**
- Create: `src/listCmd.ts`
- Modify: `src/cli.ts`
- Test: `tests/listCmd.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `tests/listCmd.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runListCommand, ticketStatusOf } from "../src/listCmd.js";
import type { Config } from "../src/types.js";

describe("ticketStatusOf", () => {
  it("reads the LAST junco-result status", () => {
    const c = "body\n---\n<!-- junco-result\nstatus: failed\n-->\nmore\n---\n<!-- junco-result\nstatus: completed\n-->\n";
    expect(ticketStatusOf(c)).toBe("completed");
  });
  it("null when no result block", () => expect(ticketStatusOf("plain")).toBeNull());
});

describe("runListCommand", () => {
  let root: string; let cfg: Config; let out: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-list-"));
    for (const d of ["inbox", "processing", "done", "failed"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "inbox", "i1.md"), "x");
    writeFileSync(join(root, "failed", "f1.md"), "x\n---\n<!-- junco-result\nstatus: timeout\n-->\n");
    cfg = { vaultRoot: root, juncoSubdir: "" } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists all four boxes by default with counts, names, and terminal statuses", async () => {
    const code = await runListCommand(cfg, undefined, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/inbox \(1\)/);
    expect(text).toMatch(/i1\.md/);
    expect(text).toMatch(/failed \(1\)/);
    expect(text).toMatch(/f1\.md.*\[timeout\]/);
  });

  it("lists a single box when named, errors on an unknown box", async () => {
    expect(await runListCommand(cfg, "inbox", { printFn: (s) => out.push(s) })).toBe(0);
    expect(out.join("")).not.toMatch(/failed \(/);
    expect(await runListCommand(cfg, "nope", { printFn: (s) => out.push(s) })).toBe(2);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/listCmd.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/listCmd.ts`**

```ts
/** `junco list [inbox|processing|done|failed]` — newest-first ticket listing. */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";

const BOXES = ["inbox", "processing", "done", "failed"] as const;
type Box = (typeof BOXES)[number];

const RESULT_STATUS_RE = /<!-- junco-result\nstatus: ([^\n]+)/g;

/** The status recorded by the LAST junco-result block, or null. */
export function ticketStatusOf(content: string): string | null {
  let last: string | null = null;
  for (const m of content.matchAll(RESULT_STATUS_RE)) last = m[1].trim();
  return last;
}

function age(mtimeMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export interface ListDeps {
  printFn?: (s: string) => void;
  nowFn?: () => number;
  /** Cap per box (newest first). Default 15. */
  limit?: number;
}

export async function runListCommand(cfg: Config, box: string | undefined, deps: ListDeps = {}): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const now = (deps.nowFn ?? Date.now)();
  const limit = deps.limit ?? 15;
  if (box !== undefined && !BOXES.includes(box as Box)) {
    print(`junco list: unknown box '${box}' (expected: ${BOXES.join(" | ")})\n`);
    return 2;
  }
  const paths = queuePaths(cfg);
  const targets = box ? [box as Box] : [...BOXES];
  for (const b of targets) {
    const dir = paths[b];
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".md"));
    } catch {
      /* missing dir → empty box */
    }
    const entries = names
      .map((n) => ({ n, mtime: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b2) => b2.mtime - a.mtime);
    print(`${b} (${entries.length})\n`);
    for (const e of entries.slice(0, limit)) {
      let statusTag = "";
      if (b === "done" || b === "failed") {
        const s = ticketStatusOf(readFileSync(join(dir, e.n), "utf8"));
        if (s) statusTag = `  [${s}]`;
      }
      print(`  ${e.n}  (${age(e.mtime, now)})${statusTag}\n`);
    }
    if (entries.length > limit) print(`  … ${entries.length - limit} more\n`);
  }
  return 0;
}
```

- [ ] **Step 4: Wire `src/cli.ts`** — USAGE line `  list [box]   List tickets per queue box (inbox|processing|done|failed)` and:

```ts
  if (subcommand === "list") {
    const cfg = loadConfigFn(configPath);
    return runListCommand(cfg, positionals[1], { printFn });
  }
```

- [ ] **Step 5: Run, verify pass** — target + full suite → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/listCmd.ts src/cli.ts tests/listCmd.test.ts
git commit -m "feat(cli): junco list — newest-first queue listing with terminal statuses"
```

---

### Task 20: `junco retry`

**Files:**
- Create: `src/retryCmd.ts`
- Modify: `src/cli.ts`
- Test: `tests/retryCmd.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `tests/retryCmd.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripResultArtifacts, removeFrontmatterKey, runRetryCommand } from "../src/retryCmd.js";
import type { Config } from "../src/types.js";

describe("stripResultArtifacts", () => {
  it("cuts at the FIRST junco-result block (drops all appended artifacts)", () => {
    const c = "---\nid: a\n---\nbody\n\n---\n<!-- junco-result\nstatus: failed\n-->\n\n## Result\n…\n";
    expect(stripResultArtifacts(c)).toBe("---\nid: a\n---\nbody\n");
  });
  it("no-op when there is no result block", () => {
    expect(stripResultArtifacts("---\nid: a\n---\nbody\n")).toBe("---\nid: a\n---\nbody\n");
  });
});

describe("removeFrontmatterKey", () => {
  it("removes the key line, leaves the rest", () => {
    expect(removeFrontmatterKey("---\nid: a\nretry_count: 2\n---\nb", "retry_count")).toBe("---\nid: a\n---\nb");
  });
});

describe("runRetryCommand", () => {
  let root: string; let cfg: Config; let out: string[];
  const failedName = "2026-06-10T1200Z__fix-thing.md";
  const failedBody =
    "---\nid: fix-thing\nretry_count: 2\nnot_before: \"2026-06-10T13:00:00Z\"\n---\nplease fix\n\n---\n<!-- junco-result\nstatus: failed\n-->\n\n## Result\nnope\n";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-retry-"));
    for (const d of ["inbox", "processing", "done", "failed"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "failed", failedName), failedBody, "utf8");
    cfg = { vaultRoot: root, juncoSubdir: "", defaultTimeoutMinutes: 30 } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("moves a failed ticket back to inbox: stamp stripped, artifacts stripped, retry bookkeeping cleared", async () => {
    const code = await runRetryCommand(cfg, ["fix-thing"], {}, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    const dst = join(root, "inbox", "fix-thing.md");
    expect(existsSync(dst)).toBe(true);
    expect(existsSync(join(root, "failed", failedName))).toBe(false);
    const content = readFileSync(dst, "utf8");
    expect(content).not.toMatch(/junco-result|retry_count|not_before/);
    expect(content).toMatch(/please fix/);
  });

  it("--all retries everything in failed/", async () => {
    writeFileSync(join(root, "failed", "another.md"), "---\nid: another\n---\nx\n", "utf8");
    const code = await runRetryCommand(cfg, [], { all: true }, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(readdirSync(join(root, "failed"))).toHaveLength(0);
    expect(readdirSync(join(root, "inbox"))).toHaveLength(2);
  });

  it("ambiguous substring → error 2, nothing moved; unknown name → error 1", async () => {
    writeFileSync(join(root, "failed", "fix-thing-2.md"), "x", "utf8");
    expect(await runRetryCommand(cfg, ["fix"], {}, { printFn: (s) => out.push(s) })).toBe(2);
    expect(readdirSync(join(root, "failed"))).toHaveLength(2);
    expect(await runRetryCommand(cfg, ["zzz"], {}, { printFn: (s) => out.push(s) })).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/retryCmd.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/retryCmd.ts`**

```ts
/**
 * `junco retry <name…|--all>` — move failed tickets back to the inbox for a
 * fresh attempt: claim stamp stripped, appended result artifacts removed,
 * worker retry bookkeeping (retry_count / not_before) cleared.
 */

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";
import { submitTicket } from "./dispatch.js";
import { CLAIM_PREFIX_RE } from "./requeue.js";

/** Cut everything from the FIRST appended junco-result separator onward.
 * (Known limitation: a ticket BODY containing the literal separator loses its
 * tail — documented in the README.) */
export function stripResultArtifacts(content: string): string {
  const idx = content.indexOf("\n---\n<!-- junco-result");
  return idx === -1 ? content : content.slice(0, idx) + "\n";
}

/** Remove a `key: …` line from the frontmatter block, if present. */
export function removeFrontmatterKey(content: string, key: string): string {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return content;
  const newBlock = m[1]
    .split("\n")
    .filter((l) => !new RegExp(`^${key}:`).test(l))
    .join("\n");
  return content.slice(0, m.index) + `---\n${newBlock}\n---` + content.slice(m.index + m[0].length);
}

export interface RetryDeps {
  printFn?: (s: string) => void;
}

export async function runRetryCommand(
  cfg: Config,
  names: string[],
  opts: { all?: boolean } = {},
  deps: RetryDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const failedDir = queuePaths(cfg).failed;
  let entries: string[] = [];
  try {
    entries = readdirSync(failedDir).filter((n) => n.endsWith(".md"));
  } catch {
    /* no failed dir yet */
  }

  let targets: string[];
  if (opts.all) {
    targets = entries;
    if (targets.length === 0) {
      print("nothing in failed/\n");
      return 0;
    }
  } else {
    if (names.length === 0) {
      print("Usage: junco retry <name…|--all>\n");
      return 2;
    }
    targets = [];
    for (const name of names) {
      const exact = entries.filter((e) => e === name || e === `${name}.md`);
      const fuzzy = exact.length > 0 ? exact : entries.filter((e) => e.includes(name));
      if (fuzzy.length === 0) {
        print(`junco retry: no failed ticket matches '${name}'\n`);
        return 1;
      }
      if (fuzzy.length > 1) {
        print(`junco retry: '${name}' is ambiguous:\n${fuzzy.map((f) => `  ${f}`).join("\n")}\n`);
        return 2;
      }
      targets.push(fuzzy[0]);
    }
  }

  let failures = 0;
  for (const entry of targets) {
    const src = join(failedDir, entry);
    try {
      let content = stripResultArtifacts(readFileSync(src, "utf8"));
      content = removeFrontmatterKey(content, "retry_count");
      content = removeFrontmatterKey(content, "not_before");
      const cleanName = entry.replace(CLAIM_PREFIX_RE, "");
      const dst = submitTicket(cfg, content, { idHint: cleanName.replace(/\.md$/, "") });
      unlinkSync(src); // only after the inbox copy is safely in place
      print(`requeued: ${dst}\n`);
    } catch (e) {
      failures++;
      print(`junco retry: ${entry}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return failures > 0 ? 1 : 0;
}
```

- [ ] **Step 4: Wire `src/cli.ts`** — parseArgs options gain `all: { type: "boolean", default: false }`; USAGE line `  retry <name…|--all>  Move failed tickets back to the inbox for a fresh run`; handler:

```ts
  if (subcommand === "retry") {
    const cfg = loadConfigFn(configPath);
    return runRetryCommand(cfg, positionals.slice(1), { all: values.all as boolean }, { printFn });
  }
```

- [ ] **Step 5: Run, verify pass** — target + full suite → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/retryCmd.ts src/cli.ts tests/retryCmd.test.ts
git commit -m "feat(cli): junco retry — clean failed tickets and resubmit them to the inbox"
```

---

### Task 21: `junco doctor`

**Files:**
- Create: `src/doctor.ts`
- Modify: `src/cli.ts`
- Test: `tests/doctor.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `tests/doctor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import type { Config } from "../src/types.js";

const okConfig = {
  model: { id: "local/m", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k", modelsJson: null },
  vaultRoot: "/tmp/junco-doc-vault", juncoSubdir: "", worktreeRoot: "/tmp/junco-doc-wt",
  gitBin: "git", ghBin: "gh", hasRepoFlows: true,
} as unknown as Config;

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loadConfigFn: () => okConfig,
    execFn: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    reachableFn: async () => true,
    fetchModelsFn: async () => ["m"],
    accessOkFn: () => true,
    lockHolderFn: () => null,
    printFn: () => {},
    ...over,
  };
}

describe("runDoctor", () => {
  it("all green → exit 0", async () => {
    expect(await runDoctor("/x/config.toml", deps())).toBe(0);
  });

  it("unreachable endpoint → ✗ and exit 1", async () => {
    const lines: string[] = [];
    const code = await runDoctor("/x/config.toml", deps({ reachableFn: async () => false, printFn: (s) => lines.push(s) }));
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ .*endpoint/i);
  });

  it("missing gh is a warning, not a failure (Q&A-only setups are valid)", async () => {
    const lines: string[] = [];
    const code = await runDoctor("/x/config.toml", deps({
      execFn: async (cmd: string) => (cmd === "gh" ? { code: 127, stdout: "", stderr: "not found" } : { code: 0, stdout: "ok", stderr: "" }),
      printFn: (s) => lines.push(s),
    }));
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ .*gh/);
  });

  it("unparseable config → ✗ and exit 1, later checks skipped", async () => {
    const code = await runDoctor("/x/config.toml", deps({ loadConfigFn: () => { throw new Error("bad toml"); } }));
    expect(code).toBe(1);
  });

  it("model missing from the endpoint listing → warning only", async () => {
    const lines: string[] = [];
    const code = await runDoctor("/x/config.toml", deps({ fetchModelsFn: async () => ["other"], printFn: (s) => lines.push(s) }));
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ .*model/i);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/doctor.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/doctor.ts`**

```ts
/**
 * `junco doctor` — preflight every external dependency a ticket will need, so
 * failures surface here instead of after a 30-minute agent run.
 * ✓ pass · ⚠ warning (degraded but workable) · ✗ failure (exit 1).
 */

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./types.js";
import { loadConfig, queuePaths } from "./config.js";
import { endpointReachable } from "./health.js";
import { fetchModels } from "./wizard/models.js";
import { splitModelId } from "./agent/modelSetup.js";
import { readLockHolder } from "./lock.js";

export interface DoctorDeps {
  loadConfigFn?: (p: string) => Config;
  execFn?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  reachableFn?: (cfg: Config) => Promise<boolean>;
  fetchModelsFn?: typeof fetchModels;
  accessOkFn?: (dir: string) => boolean;
  lockHolderFn?: (lockPath: string) => number | null;
  printFn?: (s: string) => void;
}

function defaultExec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code === "ENOENT" ? 127 : 1) : 0, stdout, stderr });
    });
  });
}

function defaultAccessOk(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

type Verdict = "ok" | "warn" | "fail";

export async function runDoctor(configPath: string, deps: DoctorDeps = {}): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const execFn = deps.execFn ?? defaultExec;
  const reachableFn = deps.reachableFn ?? ((c: Config) => endpointReachable(c));
  const fetchModelsFn = deps.fetchModelsFn ?? fetchModels;
  const accessOkFn = deps.accessOkFn ?? defaultAccessOk;
  const lockHolderFn = deps.lockHolderFn ?? readLockHolder;

  const results: Array<{ v: Verdict; label: string; detail: string }> = [];
  const report = (v: Verdict, label: string, detail = ""): void => {
    results.push({ v, label, detail });
    const mark = v === "ok" ? "✓" : v === "warn" ? "⚠" : "✗";
    print(`${mark} ${label}${detail ? ` — ${detail}` : ""}\n`);
  };

  // 1. config
  let cfg: Config | null = null;
  try {
    cfg = (deps.loadConfigFn ?? loadConfig)(configPath);
    report("ok", "config", configPath);
  } catch (e) {
    report("fail", "config", `${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. node version
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 19)) report("ok", "node", process.versions.node);
  else report("fail", "node", `${process.versions.node} < required 22.19`);

  if (cfg) {
    // 3-4. git / gh
    const gitRes = await execFn(cfg.gitBin, ["--version"]);
    report(gitRes.code === 0 ? "ok" : "fail", "git", gitRes.code === 0 ? gitRes.stdout.trim() : "not found — PR-flow tickets need git");
    const ghVer = await execFn(cfg.ghBin, ["--version"]);
    if (ghVer.code !== 0) report("warn", "gh", "not found — PR-flow tickets will fail; Q&A tickets are fine");
    else {
      const auth = await execFn(cfg.ghBin, ["auth", "status"]);
      report(auth.code === 0 ? "ok" : "warn", "gh", auth.code === 0 ? "authenticated" : "installed but not authenticated (run: gh auth login)");
    }

    // 5. endpoint
    const up = await reachableFn(cfg);
    report(up ? "ok" : "fail", "inference endpoint", up ? cfg.model.baseUrl : `${cfg.model.baseUrl} unreachable`);

    // 6. model advertised (warn-only: not all endpoints list models)
    if (up) {
      const ids = await fetchModelsFn(cfg.model.baseUrl, cfg.model.apiKey);
      const { modelId } = splitModelId(cfg.model.id);
      if (ids.length === 0) report("warn", "model", "endpoint does not list models; cannot verify " + cfg.model.id);
      else report(ids.includes(modelId) || ids.includes(cfg.model.id) ? "ok" : "warn", "model",
        ids.includes(modelId) || ids.includes(cfg.model.id) ? cfg.model.id : `${cfg.model.id} not in the endpoint's ${ids.length} advertised models`);
    }

    // 7. queue + worktree dirs writable
    const paths = queuePaths(cfg);
    for (const [label, dir] of [["queue", dirname(paths.inbox)], ["worktree root", cfg.worktreeRoot]] as const) {
      report(accessOkFn(dir) ? "ok" : "fail", label, dir);
    }

    // 8. daemon (informational)
    const holder = lockHolderFn(join(dirname(configPath), "worker.lock"));
    report("ok", "daemon", holder ? `running (pid ${holder})` : "not running");
  }

  const fails = results.filter((r) => r.v === "fail").length;
  const warns = results.filter((r) => r.v === "warn").length;
  print(`\n${fails === 0 ? "ready" : "NOT ready"} — ${fails} failure(s), ${warns} warning(s)\n`);
  return fails === 0 ? 0 : 1;
}
```

- [ ] **Step 4: Wire `src/cli.ts`** — USAGE line `  doctor       Preflight: config, git/gh, endpoint, model, dirs, daemon` and handler (note: doctor loads config itself so it can report a broken one instead of crashing):

```ts
  if (subcommand === "doctor") {
    return runDoctor(configPath, { loadConfigFn, printFn });
  }
```

- [ ] **Step 5: Run, verify pass** — target + full suite → PASS. Also try it live: `node dist/cli.js doctor` after `npm run build` (expect sensible output against your real config).

- [ ] **Step 6: Commit**

```bash
git add src/doctor.ts src/cli.ts tests/doctor.test.ts
git commit -m "feat(cli): junco doctor — preflight config, toolchain, endpoint, model and queue dirs"
```

---

### Task 22: `junco logs`

**Files:**
- Create: `src/logsCmd.ts`
- Modify: `src/cli.ts`
- Test: `tests/logsCmd.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `tests/logsCmd.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLogsCommand } from "../src/logsCmd.js";
import type { Config } from "../src/types.js";

describe("runLogsCommand", () => {
  let dir: string; let cfg: Config; let out: string[];
  const line = (msg: string) => JSON.stringify({ ts: "2026-06-10T12:00:00.000Z", level: "info", ticket: "-", msg }) + "\n";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "junco-logs-"));
    cfg = { stateDir: dir } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints the last N lines, human-formatted", async () => {
    writeFileSync(join(dir, "worker.log"), line("one") + line("two") + line("three"), "utf8");
    const code = await runLogsCommand(cfg, { lines: 2 }, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).not.toMatch(/one/);
    expect(text).toMatch(/two/);
    expect(text).toMatch(/three/);
    expect(text).toMatch(/INFO/); // human format
  });

  it("--json passes raw lines through", async () => {
    writeFileSync(join(dir, "worker.log"), line("raw"), "utf8");
    await runLogsCommand(cfg, { lines: 10, json: true }, { printFn: (s) => out.push(s) });
    expect(out.join("")).toContain('"msg":"raw"');
  });

  it("missing log file → message + exit 1", async () => {
    const code = await runLogsCommand(cfg, {}, { printFn: (s) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/no log file/i);
  });

  it("--follow streams appended lines until stopped", async () => {
    const p = join(dir, "worker.log");
    writeFileSync(p, line("start"), "utf8");
    const stop = new AbortController();
    const done = runLogsCommand(cfg, { follow: true, lines: 1 }, { printFn: (s) => out.push(s), pollMs: 20, signal: stop.signal });
    await new Promise((r) => setTimeout(r, 40));
    appendFileSync(p, line("later"), "utf8");
    await new Promise((r) => setTimeout(r, 80));
    stop.abort();
    expect(await done).toBe(0);
    expect(out.join("")).toMatch(/later/);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/logsCmd.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/logsCmd.ts`**

```ts
/**
 * `junco logs [-f] [-n N] [--json]` — read the state-dir worker.log; pretty by
 * default, raw JSON with --json. Follow mode polls (fs.watch is unreliable
 * across editors/filesystems) and survives rotation (size shrink → reset).
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { formatHumanLine } from "./logging.js";

export interface LogsOpts {
  follow?: boolean;
  lines?: number;
  json?: boolean;
}

export interface LogsDeps {
  printFn?: (s: string) => void;
  pollMs?: number;
  /** Follow-mode stop signal (tests; the CLI passes a SIGINT-wired controller). */
  signal?: AbortSignal;
}

function render(rawLine: string, json: boolean): string {
  if (json) return rawLine + "\n";
  try {
    return formatHumanLine(JSON.parse(rawLine) as Record<string, unknown>) + "\n";
  } catch {
    return rawLine + "\n"; // non-JSON line (crash output etc.) — pass through
  }
}

export async function runLogsCommand(cfg: Config, opts: LogsOpts = {}, deps: LogsDeps = {}): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const json = opts.json ?? !process.stdout.isTTY;
  const path = join(cfg.stateDir, "worker.log");
  if (!existsSync(path)) {
    print(`junco logs: no log file at ${path} (the daemon writes it once started; see [observability].state_dir)\n`);
    return 1;
  }

  const tail = readFileSync(path, "utf8").split("\n").filter(Boolean);
  for (const l of tail.slice(-(opts.lines ?? 100))) print(render(l, json));
  if (!opts.follow) return 0;

  let pos = statSync(path).size;
  let carry = "";
  const pollMs = deps.pollMs ?? 500;
  return await new Promise<number>((resolveDone) => {
    const timer = setInterval(() => {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        return; // rotated away mid-poll; next tick re-stats
      }
      if (size < pos) { pos = 0; carry = ""; } // rotation
      if (size > pos) {
        const fd = openSync(path, "r");
        try {
          const buf = Buffer.alloc(size - pos);
          readSync(fd, buf, 0, buf.length, pos);
          pos = size;
          const chunk = carry + buf.toString("utf8");
          const parts = chunk.split("\n");
          carry = parts.pop() ?? "";
          for (const l of parts.filter(Boolean)) print(render(l, json));
        } finally {
          closeSync(fd);
        }
      }
    }, pollMs);
    const stop = (): void => {
      clearInterval(timer);
      resolveDone(0);
    };
    if (deps.signal) {
      if (deps.signal.aborted) stop();
      else deps.signal.addEventListener("abort", stop, { once: true });
    } else {
      process.once("SIGINT", stop);
    }
  });
}
```

- [ ] **Step 4: Wire `src/cli.ts`** — parseArgs options gain `follow: { type: "boolean", short: "f", default: false }, lines: { type: "string", short: "n" }, json: { type: "boolean", default: false }`; USAGE line `  logs [-f] [-n N] [--json]   Show (or follow) the worker log, human-readable on a TTY`; handler:

```ts
  if (subcommand === "logs") {
    const cfg = loadConfigFn(configPath);
    const n = values.lines !== undefined ? parseInt(values.lines as string, 10) : undefined;
    return runLogsCommand(cfg, {
      follow: values.follow as boolean,
      lines: Number.isInteger(n) && n! > 0 ? n : undefined,
      json: (values.json as boolean) || undefined,
    }, {});
  }
```

- [ ] **Step 5: Run, verify pass** — target + full suite → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/logsCmd.ts src/cli.ts tests/logsCmd.test.ts
git commit -m "feat(cli): junco logs — tail/follow the worker log with human formatting"
```

---

# Phase 5 — Capability

### Task 23: Per-ticket `tools:` override

**Files:**
- Modify: `src/runOnce.ts` (Q&A path), `src/prFlow.ts` (worker + corrective sessions)
- Test: `tests/runOnce.test.ts`, `tests/prFlow.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/runOnce.test.ts` (the existing fake factory receives `(cfg, cwd)` — capture what it gets):

```ts
it("Q&A default stays read-only; a tools: frontmatter overrides it", async () => {
  const seen: string[][] = [];
  const capturingFactory = (c: Config) => { seen.push(c.tools); return fakeFactory(c, ""); };
  writeTicket("plain.md", "---\nid: plain\n---\nq");
  await runOnce(cfg, { sessionFactoryFor: capturingFactory });
  expect(seen[0].sort()).toEqual(["find", "grep", "ls", "read"]); // intersection of cfg.tools default
  writeTicket("bashy.md", "---\nid: bashy\ntools: [read, bash]\n---\nq");
  await runOnce(cfg, { sessionFactoryFor: capturingFactory });
  expect(seen[1]).toEqual(["read", "bash"]);
});
```

Append to `tests/prFlow.test.ts`:

```ts
it("a tools: frontmatter narrows the PR-flow session's allowlist", async () => {
  const seen: string[][] = [];
  const dst = await runPrFlow(cfg, taskWithTools(["read", "edit"]), claimedPath, ctx, {
    sessionFactoryFor: (c) => { seen.push(c.tools); return committingFake(c, ""); },
    dirs,
  });
  expect(seen[0]).toEqual(["read", "edit"]);
});
```

(`taskWithTools` = the file's existing task-fixture builder with `tools: [read, edit]` in the frontmatter; build it the same way the fixture builds other frontmatter fields.)

- [ ] **Step 2: Run, verify fail** — both files → FAIL.

- [ ] **Step 3: Implement `src/runOnce.ts`.** Replace the Q&A `qaCfg` line:

```ts
      // Q&A default is the read-only subset; an explicit ticket `tools:` is an
      // owner-authored opt-in and is used verbatim.
      const qaTools = next.tools ?? cfg.tools.filter((t) => READ_ONLY_TOOLS.has(t));
      const qaCfg: Config = { ...cfg, tools: qaTools };
```

- [ ] **Step 4: Implement `src/prFlow.ts`.** Before the Phase-4 factory construction:

```ts
  const flowCfg: Config = task.tools ? { ...cfg, tools: task.tools } : cfg;
```

and use `flowCfg` (instead of `cfg`) in BOTH `(deps.sessionFactoryFor ?? makePiSessionFactory)(flowCfg, wtPath)` call sites (worker + corrective). Everything else keeps `cfg`.

- [ ] **Step 5: Run, verify pass** — target + full suite → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runOnce.ts src/prFlow.ts tests/runOnce.test.ts tests/prFlow.test.ts
git commit -m "feat(tickets): per-ticket tools override — Q&A stays read-only by default, opt-in via frontmatter"
```

---

### Task 24: Live progress in metrics + `/health`

**Files:**
- Modify: `src/agent/runResult.ts`, `src/agent/session.ts`, `src/metrics.ts`, `src/runOnce.ts`, `src/prFlow.ts`
- Test: `tests/runResult.test.ts`, `tests/session.test.ts`, `tests/metrics.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/runResult.test.ts`:

```ts
it("tracks turns and lastTool as progress", () => {
  const acc = new RunAccumulator();
  acc.observe({ type: "tool_execution_start", toolName: "bash", args: {} });
  acc.observe({ type: "turn_end", message: { usage: { input: 1, output: 2, totalTokens: 3 } } });
  acc.observe({ type: "tool_execution_start", toolName: "edit", args: {} });
  expect(acc.progress()).toEqual({ turns: 1, lastTool: "edit", outputTokens: 2 });
});
```

Append to `tests/session.test.ts`:

```ts
it("onProgress fires on turn ends and tool starts", async () => {
  const snaps: Array<{ turns: number }> = [];
  const session = fakeSession({
    events: [
      { type: "tool_execution_start", toolName: "read", args: {} },
      { type: "turn_end", message: { usage: { input: 1, output: 1, totalTokens: 2 } } },
    ],
  });
  await runAgent({ body: "x", cwd: "/tmp", timeoutMs: 5000, createSession: async () => session,
    onProgress: (p) => snaps.push(p) });
  expect(snaps.length).toBe(2);
  expect(snaps.at(-1)!.turns).toBe(1);
});
```

(Reuse the file's existing fake-session that replays an event list to its subscriber during `prompt()` — its other tests already do this.)

Append to `tests/metrics.test.ts`:

```ts
it("task progress is exposed in the snapshot and cleared with the task", () => {
  const m = new RunMetrics();
  m.setTaskProgress("t-1", { turns: 3, lastTool: "bash", outputTokens: 120 });
  expect(m.snapshot().currentProgress["t-1"].turns).toBe(3);
  m.clearTaskProgress("t-1");
  expect(m.snapshot().currentProgress["t-1"]).toBeUndefined();
});
```

- [ ] **Step 2: Run, verify fail** — three files → FAIL.

- [ ] **Step 3: Implement `src/agent/runResult.ts`** — add fields + getter to `RunAccumulator`:

```ts
  private turns = 0;
  private lastTool: string | null = null;
```

In `observe`: `case "tool_execution_start":` additionally `this.lastTool = event.toolName ?? this.lastTool;` and in `case "turn_end":` additionally `this.turns++;`. Add:

```ts
  /** Cheap live-progress view for the metrics surface. */
  progress(): { turns: number; lastTool: string | null; outputTokens: number } {
    return { turns: this.turns, lastTool: this.lastTool, outputTokens: this.usage.output };
  }
```

- [ ] **Step 4: Implement `src/agent/session.ts`** — `RunAgentOptions` gains:

```ts
  /** Called on turn ends and tool starts with a cheap progress snapshot —
   * wired to the metrics singleton so /health can show live progress. */
  onProgress?: (p: { turns: number; lastTool: string | null; outputTokens: number }) => void;
```

In the subscribe handler, directly after `acc.observe(e);`:

```ts
      if (opts.onProgress && (e?.type === "turn_end" || e?.type === "tool_execution_start")) {
        opts.onProgress(acc.progress());
      }
```

- [ ] **Step 5: Implement `src/metrics.ts`.**
  - `MetricsSnapshot` gains `currentProgress: Record<string, { turns: number; lastTool: string | null; outputTokens: number; updatedAt: string }>;`
  - `RunMetrics` gains:

```ts
  private _progress: Record<string, { turns: number; lastTool: string | null; outputTokens: number; updatedAt: string }> = {};

  setTaskProgress(id: string, p: { turns: number; lastTool: string | null; outputTokens: number }): void {
    this._progress[id] = { ...p, updatedAt: this._now().toISOString() };
  }

  clearTaskProgress(id: string): void {
    delete this._progress[id];
  }
```

  - `snapshot()` adds `currentProgress: { ...this._progress },` and `reset()` adds `this._progress = {};`

- [ ] **Step 6: Wire `src/runOnce.ts` + `src/prFlow.ts`.**
  - runOnce Q&A `runAgent` call gains `onProgress: (p) => metrics.setTaskProgress(next.id, p),`; in the `finally` next to `metrics.setCurrentTicket(null)` add `metrics.clearTaskProgress(next.id);`. Pass `onProgress` into `runPrFlow` deps: `PrFlowDeps` gains `onProgress?: (p: { turns: number; lastTool: string | null; outputTokens: number }) => void;` and runOnce supplies `onProgress: (p) => metrics.setTaskProgress(next.id, p)`.
  - prFlow passes `onProgress: deps.onProgress` to both `runAgent` calls.

- [ ] **Step 7: Run, verify pass** — target + full suite → PASS. `tests/healthServer.test.ts` asserts on the snapshot shape — extend its expectations if it enumerates keys.

- [ ] **Step 8: Commit**

```bash
git add src/agent/runResult.ts src/agent/session.ts src/metrics.ts src/runOnce.ts src/prFlow.ts tests/runResult.test.ts tests/session.test.ts tests/metrics.test.ts
git commit -m "feat(observability): live per-ticket progress (turns, last tool, output tokens) in /health"
```

---

### Task 25: Transcript sidecars (per-ticket event JSONL)

**Files:**
- Modify: `src/agent/session.ts`, `src/runOnce.ts`, `src/prFlow.ts`
- Test: `tests/session.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `tests/session.test.ts`:

```ts
it("streams non-delta events to the transcript path as JSONL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "junco-tx-"));
  const txPath = join(dir, "transcripts", "t-1.jsonl");
  const session = fakeSession({
    events: [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }, // skipped
      { type: "tool_execution_start", toolName: "read", args: { path: "/a" } },
      { type: "turn_end", message: { usage: { input: 1, output: 1, totalTokens: 2 } } },
    ],
  });
  await runAgent({ body: "x", cwd: "/tmp", timeoutMs: 5000, createSession: async () => session, transcriptPath: txPath });
  const lines = readFileSync(txPath, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]).type).toBe("tool_execution_start");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/session.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/agent/session.ts`.** `RunAgentOptions` gains:

```ts
  /** Append every non-delta event as a JSON line — the debugging record for
   * failed runs. Parent dir is created; write failures only warn. */
  transcriptPath?: string;
```

In `runAgent`, before the subscribe:

```ts
  let transcript: import("node:fs").WriteStream | null = null;
  if (opts.transcriptPath) {
    try {
      mkdirSync(dirname(opts.transcriptPath), { recursive: true });
      transcript = createWriteStream(opts.transcriptPath, { flags: "a" });
    } catch (e) {
      log.warn("transcript disabled (path not writable)", { path: opts.transcriptPath, error: e instanceof Error ? e.message : String(e) });
    }
  }
```

In the subscribe handler, after `acc.observe(e);` (before the progress hook):

```ts
      if (transcript && e?.type !== "message_update") transcript.write(JSON.stringify(e) + "\n");
```

In the `finally`: `transcript?.end();`
Imports: `createWriteStream, mkdirSync` from `node:fs`, `dirname` from `node:path`.

- [ ] **Step 4: Wire the call sites.**
  - `src/runOnce.ts` (Q&A): `transcriptPath: cfg.transcriptsEnabled ? join(cfg.stateDir, "transcripts", `${next.id}.jsonl`) : undefined,` (import `join` from `node:path` — already imported? check; add if not).
  - `src/prFlow.ts`: same expression with `task.id`, passed to BOTH `runAgent` calls (the corrective re-dispatch appends to the same file — chronological record of the whole ticket).

- [ ] **Step 5: Run, verify pass** — target + full suite → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/session.ts src/runOnce.ts src/prFlow.ts tests/session.test.ts
git commit -m "feat(observability): per-ticket transcript sidecars under <state_dir>/transcripts/"
```

---

### Task 26: `allowed_repo_roots` allowlist

**Files:**
- Modify: `src/repo.ts` (`validateRepoContext`)
- Test: `tests/repo.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/repo.test.ts` (this check fires before any gh/git call, so no fixture repo is needed):

```ts
describe("allowed_repo_roots", () => {
  it("rejects a repo outside every allowed root, before touching gh", async () => {
    const cfg2 = { ...cfg, allowedRepoRoots: ["/srv/allowed"] };
    await expect(validateRepoContext(cfg2, { ...ctx, repo: "/home/evil/repo" })).rejects.toThrow(/allowed_repo_roots/);
  });
  it("accepts a repo under an allowed root (continues to the existing checks)", async () => {
    const cfg2 = { ...cfg, allowedRepoRoots: [dirname(realRepoPath)] };
    await expect(validateRepoContext(cfg2, freshCtx())).resolves.toBeTruthy();
  });
  it("an empty allowlist allows everything (default)", async () => {
    await expect(validateRepoContext({ ...cfg, allowedRepoRoots: [] }, freshCtx())).resolves.toBeTruthy();
  });
});
```

(`cfg`/`ctx`/`realRepoPath`/`freshCtx` = the file's existing fixtures; the accept cases reuse the fixture repo that already passes validation.)

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/repo.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `src/repo.ts` `validateRepoContext`, as the FIRST check (before the existsSync):

```ts
  // Containment rail: when [git].allowed_repo_roots is non-empty, a ticket may
  // only target repos under one of those roots. The inbox is a code-execution
  // boundary — this caps where a hostile or fat-fingered ticket can point it.
  if (cfg.allowedRepoRoots.length > 0) {
    const real = resolve(ctx.repo);
    const ok = cfg.allowedRepoRoots.some((root) => {
      const r = resolve(root);
      return real === r || real.startsWith(r + sep);
    });
    if (!ok) {
      throw new GitOpError(
        `repo ${ctx.repo} is outside [git].allowed_repo_roots — refusing to run this ticket`,
      );
    }
  }
```

Imports: add `resolve`, `sep` to the `node:path` import.

- [ ] **Step 4: Run, verify pass** — target + full suite → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo.ts tests/repo.test.ts
git commit -m "feat(security): [git].allowed_repo_roots — confine PR-flow tickets to approved repo roots"
```

---

### Task 27: Concurrency — `max_concurrent` with per-repo serialization

The largest task. The queue claim is already an atomic rename and worktrees already isolate workspaces; the work is (a) splitting `runOnce` into claim/execute halves, (b) a scheduler loop that tops up slots, (c) multi-ticket metrics.

**Files:**
- Modify: `src/runOnce.ts`, `src/daemon.ts`, `src/metrics.ts`
- Test: `tests/runOnce.test.ts`, `tests/daemon.test.ts`, `tests/metrics.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `tests/metrics.test.ts`:

```ts
it("tracks multiple in-flight tickets; currentTicket stays as first-or-null for back-compat", () => {
  const m = new RunMetrics();
  m.taskStarted("a");
  m.taskStarted("b");
  expect(m.snapshot().currentTickets).toEqual(["a", "b"]);
  expect(m.snapshot().currentTicket).toBe("a");
  m.taskEnded("a");
  expect(m.snapshot().currentTickets).toEqual(["b"]);
  m.taskEnded("b");
  expect(m.snapshot().currentTicket).toBeNull();
});
```

Append to `tests/runOnce.test.ts`:

```ts
describe("claimNextTask", () => {
  it("skips tickets whose repoKey is busy and claims the next eligible", async () => {
    writeTicket("r1.md", `---\nid: r1\nrepo: ${repoA}\n---\nx`);
    writeTicket("r2.md", `---\nid: r2\nrepo: ${repoB}\n---\nx`);
    const w = await claimNextTask(cfg, { skipRepoKeys: new Set([resolve(repoA)]) });
    expect(w?.ticket.id).toBe("r2");
  });
  it("returns null when everything is gated", async () => {
    writeTicket("r1.md", `---\nid: r1\nrepo: ${repoA}\n---\nx`);
    const w = await claimNextTask(cfg, { skipRepoKeys: new Set([resolve(repoA)]) });
    expect(w).toBeNull();
  });
});
```

(`repoA`/`repoB` are just paths — claimNextTask resolves them without touching git.)

Append to `tests/daemon.test.ts`:

```ts
describe("runScheduler", () => {
  const fakeWork = (id: string, repoKey: string | null) =>
    ({ ticket: { id } as Ticket, claimedPath: `/p/${id}`, repoKey });

  it("runs up to max_concurrent tasks at once and per-repo serializes", async () => {
    const cfg2 = { ...cfg, maxConcurrent: 2, pollIntervalSeconds: 0.01 } as Config;
    const queue = [fakeWork("a", "/repo/X"), fakeWork("b", "/repo/X"), fakeWork("c", "/repo/Y")];
    let peak = 0, running = 0;
    const order: string[] = [];
    const stopFlag = new StopFlag();
    const claimFn = async (_c: Config, opts: { skipRepoKeys?: Set<string> }) => {
      const i = queue.findIndex((w) => !w.repoKey || !opts.skipRepoKeys?.has(w.repoKey));
      if (i === -1) { if (queue.length === 0) stopFlag.requestStop(); return null; }
      return queue.splice(i, 1)[0];
    };
    const executeFn = async (_c: Config, w: ReturnType<typeof fakeWork>) => {
      running++; peak = Math.max(peak, running); order.push(w.ticket.id);
      await new Promise((r) => setTimeout(r, 30));
      running--;
    };
    await runScheduler(cfg2, stopFlag, {}, { claimFn, executeFn });
    expect(order.sort()).toEqual(["a", "b", "c"]);
    expect(peak).toBe(2);          // c ran beside a (b blocked on repo X)
  });

  it("graceful stop drains in-flight work", async () => {
    const cfg2 = { ...cfg, maxConcurrent: 2, pollIntervalSeconds: 0.01 } as Config;
    const stopFlag = new StopFlag();
    let finished = 0;
    const claimFn = (() => {
      let given = false;
      return async () => {
        if (given) return null;
        given = true;
        return fakeWork("slow", null);
      };
    })();
    const executeFn = async () => {
      stopFlag.requestStop(); // stop arrives mid-task
      await new Promise((r) => setTimeout(r, 30));
      finished++;
    };
    await runScheduler(cfg2, stopFlag, {}, { claimFn, executeFn });
    expect(finished).toBe(1); // drained, not abandoned
  });
});
```

- [ ] **Step 2: Run, verify fail** — three files → FAIL.

- [ ] **Step 3: Implement `src/metrics.ts`.** Replace `_currentTicket`/`setCurrentTicket` with a multi-ticket set, keeping the snapshot back-compat:

```ts
  private _current: string[] = [];

  /** A task entered execution. */
  taskStarted(id: string): void {
    if (!this._current.includes(id)) this._current.push(id);
  }

  /** A task left execution (however it ended). Clears its progress too. */
  taskEnded(id: string): void {
    this._current = this._current.filter((x) => x !== id);
    this.clearTaskProgress(id);
  }
```

`MetricsSnapshot` gains `currentTickets: string[];` and keeps `currentTicket: string | null;` — snapshot fills `currentTickets: [...this._current], currentTicket: this._current[0] ?? null,`. `reset()` sets `this._current = [];`. Delete `setCurrentTicket` and fix its two call sites (next step). Run `grep -rn "setCurrentTicket" src/ tests/` and update every hit (tests asserting `currentTicket` keep passing via the back-compat field).

- [ ] **Step 4: Implement `src/runOnce.ts`.** Split into claim + execute (public API `runOnce` keeps its exact signature/behavior):

```ts
export interface ClaimedWork {
  ticket: Ticket;
  claimedPath: string;
  /** Resolved repo path for per-repo serialization; null for Q&A tickets. */
  repoKey: string | null;
}

export interface ClaimOpts {
  /** Repo keys currently executing — tickets targeting them are left queued. */
  skipRepoKeys?: Set<string>;
  /** Probe before claiming: false → claim nothing this poll. */
  readyFn?: () => Promise<boolean>;
}

export async function claimNextTask(cfg: Config, opts: ClaimOpts = {}): Promise<ClaimedWork | null> {
  const paths = queuePaths(cfg);
  const candidates = discoverTasks(paths.inbox);
  if (candidates.length === 0) return null;
  // …(existing defensive per-ticket parse block, unchanged)…
  // …(existing priority sort + Task-11 not_before filter, unchanged)…
  if (eligible.length === 0) return null;
  if (opts.readyFn && !(await opts.readyFn())) {
    log.warn("inference endpoint not ready; leaving inbox untouched this poll", { eligible: eligible.length });
    return null;
  }
  for (const t of eligible) {
    const repoKey =
      t.hasRepo && typeof t.frontmatter.repo === "string"
        ? resolve(expandHome(t.frontmatter.repo))
        : null;
    if (repoKey && opts.skipRepoKeys?.has(repoKey)) continue;
    const claimed = claim(t.path, paths.processing);
    if (!claimed) continue; // lost a race — try the next candidate
    return { ticket: t, claimedPath: claimed, repoKey };
  }
  return null;
}

export async function executeClaimed(cfg: Config, work: ClaimedWork, deps: RunDeps = {}): Promise<void> {
  const { ticket: next, claimedPath: claimed } = work;
  await withTicket(next.id, async (): Promise<void> => {
    metrics.taskStarted(next.id);
    try {
      // …(the ENTIRE existing claimed-ticket body of runOnce moves here
      //    verbatim: PR-flow branch, Q&A branch, transient requeue, finalize —
      //    with `return true` statements becoming plain `return`)…
    } finally {
      metrics.taskEnded(next.id);
    }
  });
}

export async function runOnce(cfg: Config, deps: RunDeps = {}): Promise<boolean> {
  const work = await claimNextTask(cfg, { readyFn: deps.readyFn });
  if (!work) return false;
  await executeClaimed(cfg, work, deps);
  return true;
}
```

Imports: `resolve` from `node:path`, `expandHome` from `./config.js`. The `metrics.setCurrentTicket`/`clearTaskProgress` calls inside the moved body become the `taskStarted`/`taskEnded` shown (progress clearing now lives in `taskEnded`).

- [ ] **Step 5: Implement `src/daemon.ts`.** Add the scheduler and use it from `mainLoop`:

```ts
export interface SchedulerDeps {
  claimFn?: (cfg: Config, opts: { skipRepoKeys: Set<string>; readyFn?: () => Promise<boolean> }) => Promise<ClaimedWork | null>;
  executeFn?: (cfg: Config, work: ClaimedWork) => Promise<void>;
  sleep?: (seconds: number, stopFlag: StopFlagLike) => Promise<void>;
  readyFn?: () => Promise<boolean>;
}

/**
 * Claim/execute scheduler — generalizes the serial poll loop to
 * cfg.maxConcurrent slots with per-repo serialization. At maxConcurrent=1 the
 * observable behavior matches the historical loop: one claim, run to
 * completion, poll again. Graceful stop drains in-flight work (force-stop
 * aborts the sessions via the StopFlag's forceSignal, threaded by executeFn).
 */
export async function runScheduler(
  cfg: Config,
  stopFlag: StopFlag,
  opts: { once?: boolean } = {},
  deps: SchedulerDeps = {},
): Promise<void> {
  const claimFn = deps.claimFn ?? ((c: Config, o: { skipRepoKeys: Set<string>; readyFn?: () => Promise<boolean> }) => claimNextTask(c, o));
  const executeFn =
    deps.executeFn ?? ((c: Config, w: ClaimedWork) => executeClaimed(c, w, { abortSignal: stopFlag.forceSignal }));
  const sleep = deps.sleep ?? sleepInterruptible;

  const inflight = new Set<Promise<void>>();
  const busyRepos = new Set<string>();
  let idleAnnounced = false;

  while (!stopFlag.requested) {
    metrics.recordPoll();
    let claimedThisPoll = 0;
    while (inflight.size < cfg.maxConcurrent && !stopFlag.requested) {
      const work = await claimFn(cfg, { skipRepoKeys: busyRepos, readyFn: deps.readyFn });
      if (!work) break;
      claimedThisPoll++;
      idleAnnounced = false;
      if (work.repoKey) busyRepos.add(work.repoKey);
      const p: Promise<void> = executeFn(cfg, work)
        .catch((e) => log.error("task execution crashed", { id: work.ticket.id, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }))
        .finally(() => {
          inflight.delete(p);
          if (work.repoKey) busyRepos.delete(work.repoKey);
        });
      inflight.add(p);
      if (opts.once) break;
    }

    if (opts.once && (claimedThisPoll > 0 || inflight.size > 0)) break;

    if (inflight.size === 0) {
      if (!idleAnnounced) {
        log.info("idle");
        idleAnnounced = true;
      }
      await sleep(cfg.pollIntervalSeconds, stopFlag);
    } else {
      // Wake on the next settle OR the next poll tick, whichever first — a
      // freed slot tops up immediately; a busy-but-not-full pool still polls.
      await Promise.race([sleep(cfg.pollIntervalSeconds, stopFlag), ...inflight]);
    }
  }

  if (inflight.size > 0) {
    log.info("draining in-flight tasks", { count: inflight.size });
    await Promise.allSettled([...inflight]);
  }
}
```

In `mainLoop`, replace the inner `try { let idleAnnounced … while … } finally { … }` poll loop with:

```ts
  try {
    await runScheduler(cfg, stopFlag, opts, {
      claimFn: deps.claimFn,
      executeFn: deps.executeFn,
      sleep: deps.sleep,
      readyFn: () => endpointReachable(cfg),
    });
  } finally {
    if (health) await health.close();
  }
```

`MainLoopDeps` gains `claimFn?/executeFn?` (same signatures as `SchedulerDeps`) and DROPS `runOnceFn` — update `tests/daemon.test.ts` call sites that injected `runOnceFn` to inject `claimFn`/`executeFn` instead (a fake `claimFn` returning one `ClaimedWork` then null + a fake `executeFn` reproduces every existing scenario; the once-mode and idle-logging assertions keep their meaning). Imports: `claimNextTask, executeClaimed, type ClaimedWork` from `./runOnce.js` (replacing the `runOnce` import).

- [ ] **Step 6: Run, verify pass** — `npx vitest run tests/metrics.test.ts tests/runOnce.test.ts tests/daemon.test.ts` → PASS, then the FULL suite (`npx tsc -p tsconfig.json && npx vitest run`) → PASS. Check specifically that `tests/healthServer.test.ts` and `tests/observability.integration.test.ts` still pass (snapshot shape changed additively).

- [ ] **Step 7: Live smoke (serial default unchanged):**

```bash
npm run build
SB=$(mktemp -d); HOME="$SB" node dist/cli.js init --yes --config "$SB/config.toml"
node dist/cli.js run-once --config "$SB/config.toml"   # empty inbox → "run-once complete handled:false"
rm -rf "$SB"
```

- [ ] **Step 8: Commit**

```bash
git add src/runOnce.ts src/daemon.ts src/metrics.ts tests/runOnce.test.ts tests/daemon.test.ts tests/metrics.test.ts
git commit -m "feat(daemon): max_concurrent scheduler with per-repo serialization and graceful drain"
```

---

# Phase 6 — Ship

### Task 28: Plain ticket templates (de-Obsidian)

**Files:**
- Create: `templates/plain/task.md`, `templates/plain/task-code.md`

- [ ] **Step 1: Write `templates/plain/task.md`**

```markdown
---
# Unique ticket id; delete this line to default to the filename (without .md).
id: my-task
priority: normal
timeout_minutes: 30
---

# My task

Describe the task here. The body (everything after the frontmatter closing
`---`) is sent verbatim to the configured coding agent as the prompt.
```

- [ ] **Step 2: Write `templates/plain/task-code.md`**

```markdown
---
id: my-code-task
priority: normal
timeout_minutes: 60
# PR-flow fields — presence of `repo:` triggers the git worktree + PR flow.
repo: ~/code/your-project
base_branch: main           # optional, default from config
# branch_name: junco/custom-name   # optional, default junco/<id>
# draft: true                      # optional, default from config (draft)
# pr_title: "Custom PR title"      # optional, default = first H1 in body
# labels: [cleanup, auto]          # optional
# reviewers: [your-github-username] # optional
# tools: [read, grep, bash, edit, write]  # optional per-ticket tool override
---

# My code task

Describe the work here. The body is sent to the configured coding agent as the
prompt. The worker prepends a short preamble about the worktree, branch name,
base branch, and commit rules — you don't need to restate those.

## Verification

```bash
# Optional: bash blocks under a "## Verification" heading run in the worktree
# after the agent finishes; failures are surfaced in the PR body.
npm test
```
```

(Note: the nested fence above needs the outer block in the plan only — the FILE content uses a normal ```bash fence.)

- [ ] **Step 3: Commit** (the Obsidian-Templater originals stay where they are; the README task documents the split)

```bash
git add templates/plain
git commit -m "feat(templates): plain ticket templates alongside the Obsidian-Templater ones"
```

---

### Task 29: Documentation sweep — README, ARCHITECTURE, example config

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `examples/config.toml`

- [ ] **Step 1: README — fix the drift + document everything new.** Make these edits:

  1. **Troubleshooting fix:** `grep -n "oMLX\].url\|\[oMLX\]" README.md` — change the troubleshooting reference from `[oMLX].url` to `[model].base_url` (keep the one back-compat mention that documents the legacy `[oMLX]` section as deprecated fallback).
  2. **Config resolution** — in the Configuration section, add up top:

```markdown
### Where the config lives

`junco` looks for its config in this order: an explicit `--config <path>`, then
`./config.toml` in the current directory, then the user-level default
`~/.config/junco/config.toml` (respects `XDG_CONFIG_HOME`). The wizard writes to
the user-level path unless you pass `--config`, so `junco` works from any
directory after first-run setup.
```

  3. **Day-2 CLI** — extend the CLI reference table/section with:

```markdown
| `junco status` | Daemon / endpoint / in-flight / queue counts at a glance |
| `junco list [box]` | Newest-first tickets per queue box, with terminal statuses |
| `junco retry <name…\|--all>` | Move failed tickets back to the inbox (result blocks stripped) |
| `junco doctor` | Preflight: config, node, git, gh auth, endpoint, model, dirs |
| `junco logs [-f] [-n N] [--json]` | Tail / follow the worker log (human-readable on a TTY) |
```

  4. **Reliability section** (new, after "How it works"):

```markdown
## Reliability

- **Transient failures retry themselves.** When a run fails for infrastructure
  reasons (endpoint error, truncated stream) with no commits made, the ticket
  goes back to the inbox with `retry_count` bumped and a `not_before` backoff
  stamp — up to `[worker].max_transient_retries` (default 2). Real failures
  (lint, verification, guard kills) still fail immediately.
- **The worker doesn't burn tickets while your endpoint is down.** Readiness is
  probed before every claim; work stays queued until the endpoint answers.
- **Crashes requeue, not fail.** Tickets found in `processing/` at startup
  rejoin the inbox under the same retry budget.
- **Timeouts salvage work.** A session that hits its timeout after committing
  gets its commits pushed and a draft PR opened (status `timeout_partial`),
  with a partial-run banner instead of losing the work in a dead worktree.
- **Ctrl-C twice force-stops.** First signal: finish the in-flight ticket then
  exit. Second: abort the agent session and salvage its commits. Third: hard
  exit.
```

  5. **Security model section** (new, before Troubleshooting):

```markdown
## Security model

The inbox is a **code-execution boundary**. Junco runs a coding agent with
bash/file tools on whatever ticket lands in `inbox/`, and `## Verification`
blocks run as your user — anyone who can write to the inbox can act as you.
Keep the inbox on a local disk you own, don't point it at a synced/shared
folder others can write to, and set `[git].allowed_repo_roots` to confine
PR-flow tickets to approved checkout locations:

```toml
[git]
allowed_repo_roots = ["~/code"]   # empty (default) = any path
```
```

  6. **Tickets section** — document the new frontmatter keys (`tools`, `not_before`, worker-managed `retry_count`), the plain templates (`templates/plain/` for non-Obsidian users; the top-level `templates/` ones use Obsidian-Templater syntax), and a one-line caveat under `junco retry`: a ticket body containing a literal `<!-- junco-result` separator line will lose its tail when retried.
  7. **Health & observability** — document `state_dir` (worker.log + transcripts), `junco logs`, the `/health` additions (`currentTickets`, `currentProgress`), and `[worker].max_concurrent` with the per-repo serialization guarantee.

- [ ] **Step 2: ARCHITECTURE.md** — update to match reality:
  - Daemon lifecycle: `waitForOmlx` → `waitForEndpoint`; poll loop → "scheduler (`runScheduler`): claims up to `max_concurrent` tickets, per-repo serialized; graceful stop drains, force-stop aborts via `StopFlag.forceSignal`".
  - PR-flow phase list: phase 5 note "transient errors with zero commits requeue (budget permitting)"; phase 8 note the timeout/no-commit gate; "timeout salvages commits → `timeout_partial`".
  - Module map: add rows for `requeue.ts`, `statusCmd.ts`, `listCmd.ts`, `retryCmd.ts`, `doctor.ts`, `logsCmd.ts`; update the `health.ts` row wording.
  - Ticket lifecycle diagram: add the requeue back-edge `processing/ → inbox/ (transient retry, retry_count++)`.

- [ ] **Step 3: `examples/config.toml`** — append the new keys, commented, with their defaults:

```toml
# [worker]
# max_transient_retries = 2     # requeue transient failures this many times
# retry_backoff_seconds = 60    # not_before backoff per retry (linear × attempt)
# max_concurrent = 1            # parallel tickets (per-repo always serialized)

# [git]
# allowed_repo_roots = []       # confine PR-flow tickets to these roots ([] = anywhere)

# [observability]
# state_dir = "~/.local/state/junco"  # worker.log + transcripts/ live here
# log_to_file = true
# transcripts = true            # per-ticket event JSONL under <state_dir>/transcripts/
```

- [ ] **Step 4: Verify docs claims against the code** — for each documented flag/command, run the matching `--help`/test once; no doc may promise what a test doesn't prove.

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md examples/config.toml
git commit -m "docs: reliability + security model, day-2 CLI, config resolution, new keys"
```

---

### Task 30: Release prep — v0.3.0 (HOLD before publish)

**Files:**
- Modify: `package.json`, `CHANGELOG.md`

- [ ] **Step 1:** `package.json` `"version": "0.2.2"` → `"0.3.0"`.

- [ ] **Step 2:** CHANGELOG — insert under `## [Unreleased]`:

```markdown
## [0.3.0] - <today's date>

### Added

- **Self-healing retries.** Transient failures (endpoint errors, truncated streams) with no commits requeue the ticket with backoff (`[worker].max_transient_retries`, default 2; `retry_count`/`not_before` frontmatter). Crashed tickets found in `processing/` at startup requeue under the same budget instead of failing.
- **Endpoint-aware claiming.** The daemon probes readiness before every claim — an endpoint outage queues work instead of burning the inbox into `failed/`.
- **Timeout salvage.** Sessions that hit the ticket timeout after committing get their commits pushed and a draft PR opened (new terminal status `timeout_partial`, routed to `done/`).
- **Force-stop.** Second SIGTERM/SIGINT aborts the in-flight session and salvages commits; third hard-exits. Rendered service units now set `ExitTimeOut`/`TimeoutStopSec` sized to the ticket timeout.
- **Day-2 CLI:** `junco status`, `junco list [box]`, `junco retry <name…|--all>`, `junco doctor`, `junco logs [-f] [-n N] [--json]`.
- **Concurrency.** `[worker].max_concurrent` (default 1) runs tickets in parallel with per-repo serialization and graceful drain.
- **Observability.** Structured logs tee to `<state_dir>/worker.log` (10MB rotation) with a human-readable TTY format; per-ticket transcripts under `<state_dir>/transcripts/`; live progress (turns, last tool, output tokens) in `/health`.
- **Per-ticket `tools:` override** — Q&A tickets stay read-only by default and can opt into more.
- **`[git].allowed_repo_roots`** confines PR-flow tickets to approved repo roots; README documents the inbox trust model.
- Plain (non-Obsidian) ticket templates under `templates/plain/`; CI test workflow on push/PR; prettier + eslint.

### Changed

- User-level config discovery: `--config` → `./config.toml` → `~/.config/junco/config.toml` (wizard writes the user-level path by default).
- Stack-agnostic naming: daemon logs say "inference endpoint"; bare model ids default to the `local` provider (previously `omlx`).
- The diff-vs-spec critic is told when its diff was truncated, preventing false MISSING verdicts on very large diffs.

### Fixed

- README troubleshooting referenced the legacy `[oMLX].url` key instead of `[model].base_url`.
- Stale-worktree cleanup failures now surface as a clear `GitOpError`.
```

- [ ] **Step 3: Full verification**

```bash
npm run lint && npm run format:check && npm run build && npm test
```

Expected: all clean, all tests green.

- [ ] **Step 4: Live smoke (isolated HOME)**

```bash
SB=$(mktemp -d)
HOME="$SB" XDG_CONFIG_HOME="$SB/.config" node dist/cli.js init --yes
test -f "$SB/.config/junco/config.toml" && echo "user-level config OK"
HOME="$SB" XDG_CONFIG_HOME="$SB/.config" node dist/cli.js status | head -5
HOME="$SB" XDG_CONFIG_HOME="$SB/.config" node dist/cli.js doctor || true   # endpoint ✗ expected offline
HOME="$SB" XDG_CONFIG_HOME="$SB/.config" node dist/cli.js list
rm -rf "$SB"
```

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): v0.3.0 — resilience, day-2 CLI, concurrency, observability"
```

**HOLD:** Do NOT tag / push / `gh release` / `npm publish`. Stop here and report: the diff summary, the green suite output, and the live-smoke transcript. Await maintainer approval.

---

## Self-review

- **Findings coverage** (vs the 2026-06-10 review): transient retries + readiness gate (T9–T11) ✓; orphan requeue (T12) ✓; timeout salvage (T13) ✓; force-stop + service stop-timeouts (T14–T15) ✓; user-level config (T16) ✓; status/list/retry/doctor/logs (T18–T22) ✓; log file + human TTY format (T17) ✓; concurrency w/ per-repo serialization (T27) ✓; CI + lint/format (T1–T2) ✓; omlx naming + `local` provider default (T4) ✓; trust model + allowed_repo_roots (T26, T29) ✓; progress visibility + transcripts (T24–T25) ✓; per-ticket tools (T23) ✓; DONE_STATUSES (T5) ✓; templates (T28) ✓; typed events (T8) ✓; critic truncation (T7) ✓; README `[oMLX].url` drift (T29) ✓; worktree rename guard (T6) ✓; lock TOCTOU documented (T18 Step 3) ✓; repo hygiene + plans tracked (T3) ✓. Deliberately deferred: an HTTP `junco cancel` endpoint (force-stop covers the operational need; a mutating health-server endpoint needs its own design pass).
- **Type consistency:** `ClaimedWork`/`claimNextTask`/`executeClaimed` (T27) match the scheduler's `SchedulerDeps` signatures; `RunDeps.readyFn`/`abortSignal` introduced T11/T14 and consumed T27; `endpointReachable` renamed T4 before first new use T11; `TERMINAL_DONE_STATUSES` created T5, extended T13; `CLAIM_PREFIX_RE` exported T10, reused T20; `formatHumanLine` exported T17, reused T22; `metrics.taskStarted/taskEnded/setTaskProgress/clearTaskProgress` introduced T24/T27 and used consistently; config fields added T9 are exactly those consumed by T10–T27.
- **Sequencing hazards called out inline:** T11 carries a temporary timeout early-return that T13 explicitly deletes; T27 removes `MainLoopDeps.runOnceFn` and says how to migrate the daemon tests; T16 names the one mechanical test-fix rule.
- **Placeholder scan:** every code step carries the actual code or an exact mechanical rule + verification grep; the only intentionally adaptive steps are fixture reuse instructions that name the pattern to copy from an existing test in the same file.

