# Test-Suite Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse ~2,000–3,300 lines of duplicated test scaffolding into a shared fixture layer, delete provably-redundant tests, fix a latent hermeticity bug, and establish a coverage floor — with zero coverage loss.

**Architecture:** Five new modules under the existing `tests/helpers/`. The `Config` helper uses a **required-seams** signature so no test can silently inherit a semantically meaningful default. Deletions follow one rule: unit tests own the matrix, integration tests own the wiring. Every judgment-call deletion is gated by prove-it-fails-first.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), vitest, `@vitest/coverage-v8`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-21-test-suite-consolidation-design.md`

## Global Constraints

- Node ≥ 22.19, ESM/NodeNext, strict TypeScript. Test imports use `.js` extensions (`./helpers/config.js`).
- Dependencies are **exact-pinned** — `npm install --save-exact`, never `^`.
- **No AI attribution in commits.** No `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" line. Subagent-driven commits auto-append the trailer — amend it away.
- Conventional commits (`test:`, `refactor:`, `chore:`, `docs:`, `ci:`), suite green at **every** commit.
- Full gate before claiming done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- **Exit-code trap:** piping vitest into `grep`/`tail` makes the pipeline exit with the _filter's_ status. Always: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`.
- Prettier may reformat between read and edit — re-read before editing, run `npx prettier --write` on touched files before committing.
- **Do not touch live runtime state:** `config.json`, `tickets/`, `worktrees/`, `launchd.out/err`. Never run `junco start`.
- `npm run typecheck` (not `lint`) is what covers `tests/` — run it after any shared-type change.
- **Never widen the Q&A read-only `tools` default.** It is a hard contract.

---

## Task 1: Coverage baseline and threshold floor

**Files:**

- Modify: `package.json` (devDependency)
- Modify: `vitest.config.ts`

**Interfaces:**

- Produces: a committed `coverage.thresholds` block that later tasks must not regress.

- [ ] **Step 1: Install the coverage provider, version-matched to vitest**

```bash
npm install --save-exact @vitest/coverage-v8@$(node -p "require('vitest/package.json').version")
```

- [ ] **Step 2: Measure the baseline**

```bash
npx vitest run --coverage > /tmp/cov-baseline.txt 2>&1; echo "exit: $?"
tail -30 /tmp/cov-baseline.txt
```

Expected: exit 0, and an "All files" row reporting `% Stmts | % Branch | % Funcs | % Lines`. Record those four numbers.

- [ ] **Step 3: Write the thresholds into vitest.config.ts, rounded DOWN to whole percent**

Replace the file with (substituting the four measured numbers — do not invent them):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Floor = the pre-consolidation baseline, rounded down. Raising these is a
      // reviewable edit; lowering them is a visible one. See
      // docs/superpowers/specs/2026-07-21-test-suite-consolidation-design.md §5.
      thresholds: {
        statements: <MEASURED>,
        branches: <MEASURED>,
        functions: <MEASURED>,
        lines: <MEASURED>,
      },
    },
  },
});
```

- [ ] **Step 4: Verify the floor passes and is actually enforced**

```bash
npx vitest run --coverage > /tmp/cov1.txt 2>&1; echo "exit: $?"
```

Expected: exit 0.

Now prove the gate bites — temporarily raise `lines` by 5 and re-run:

```bash
npx vitest run --coverage > /tmp/cov2.txt 2>&1; echo "exit: $?"
grep -i "coverage.*threshold" /tmp/cov2.txt
```

Expected: **non-zero exit** and a threshold-failure message. Revert the +5.

- [ ] **Step 5: Record the wall-clock cost of coverage**

```bash
/usr/bin/time -p npx vitest run > /tmp/t-plain.txt 2>&1; grep ^real /tmp/t-plain.txt
/usr/bin/time -p npx vitest run --coverage > /tmp/t-cov.txt 2>&1; grep ^real /tmp/t-cov.txt
```

Note both numbers in the commit body. If coverage more than doubles wall time, flag it for the user before Task 2.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "test: add coverage-v8 with the pre-consolidation baseline as the floor"
```

---

## Task 2: Coverage workflow and README chip

**Files:**

- Create: `.github/workflows/coverage.yml`
- Modify: `README.md:5-8`

**Interfaces:**

- Consumes: the `coverage.thresholds` block from Task 1.

- [ ] **Step 1: Create the workflow**

Single canonical leg — the 4-way gate matrix would produce four different numbers because `sandbox.integration.test.ts` is platform-gated.

```yaml
name: Coverage

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: coverage-${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  coverage:
    name: coverage floor
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22.19"
          cache: npm
      - run: npm ci
      - run: git config --global user.email "ci@example.com"
      - run: git config --global user.name "CI"
      - run: npx vitest run --coverage
```

Note: the `git config` steps mirror `quality-gate.yml` — the real-git harness tests need them.

- [ ] **Step 2: Add the chip directly after the CI chip**

In `README.md`, insert between the CI line (`:6`) and the node line (`:7`):

```markdown
[![coverage](https://github.com/ironforgesoftware/junco/actions/workflows/coverage.yml/badge.svg)](https://github.com/ironforgesoftware/junco/actions/workflows/coverage.yml)
```

- [ ] **Step 3: Verify the README badge block is well-formed**

```bash
sed -n '4,10p' README.md
```

Expected: five consecutive badge lines — npm, CI, coverage, node, license.

- [ ] **Step 4: Verify the workflow parses**

```bash
node -e "const y=require('fs').readFileSync('.github/workflows/coverage.yml','utf8'); if(!/vitest run --coverage/.test(y)) throw new Error('missing coverage run'); console.log('ok')"
```

Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/coverage.yml README.md
git commit -m "ci: coverage floor workflow and README chip"
```

---

## Task 3: Normalize doctor's `lines.join` before any shared assertion

**Files:**

- Modify: `tests/doctor.test.ts` (20 `join("\n")` sites)

**Why first:** `report()` already appends `\n`, so `join("")` is faithful and `join("\n")` double-spaces. Any regex spanning a line boundary means different things under the two. This must be settled before a shared helper bakes in the ambiguity.

- [ ] **Step 1: Inventory both forms**

```bash
grep -c 'lines.join("")' tests/doctor.test.ts
grep -n 'lines.join("\\n")' tests/doctor.test.ts
```

Expected: 76 and 20 respectively.

- [ ] **Step 2: Convert each `join("\n")` site one at a time**

For each line number from Step 1, change `lines.join("\n")` to `lines.join("")`, then immediately re-run:

```bash
npx vitest run tests/doctor.test.ts > /tmp/d.txt 2>&1; echo "exit: $?"
```

If a site fails after conversion, its regex spans a line boundary and **depends** on the separator. Do not force it — leave that site as `join("\n")` and add a comment:

```ts
// join("\n") deliberately: this regex spans a line boundary.
```

- [ ] **Step 3: Confirm the file is green and record how many sites resisted**

```bash
npx vitest run tests/doctor.test.ts > /tmp/d.txt 2>&1; echo "exit: $?"
grep -c 'lines.join("\\n")' tests/doctor.test.ts
```

Expected: exit 0. Note the residual count in the commit body.

- [ ] **Step 4: Commit**

```bash
git add tests/doctor.test.ts
git commit -m "test(doctor): normalize lines.join(\"\") so assertions share one separator"
```

---

## Task 4: `tests/helpers/gitHarness.ts` — with the cpSync spike as its gate

**Files:**

- Create: `tests/helpers/gitHarness.ts`
- Create: `tests/gitHarness.test.ts`

**Interfaces:**

- Produces:
  - `run(args: string[], cwd?: string): string`
  - `interface GitHarness { root: string; remote: string; work: string }`
  - `setupGitHarness(root: string): GitHarness`
  - `harnessTemplate(): string` — builds the seeded tree once per process
  - `cloneHarness(dest: string): GitHarness` — `cpSync` from the template

- [ ] **Step 1: Write the failing spike test**

This test is the §4 gate from the spec. If it cannot pass, `cloneHarness` is abandoned and callers use `setupGitHarness` directly — nothing else in the plan depends on it.

`tests/gitHarness.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, setupGitHarness, cloneHarness } from "./helpers/gitHarness.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("gitHarness", () => {
  it("setupGitHarness seeds a clone whose origin has main", () => {
    const h = setupGitHarness(tmp("gh-setup-"));
    expect(run(["git", "-C", h.work, "rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(run(["git", "-C", h.remote, "rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
  });

  // THE SPIKE: a cpSync'd bare remote must still accept a push.
  it("a cloned harness accepts a push to its copied remote", () => {
    const h = cloneHarness(tmp("gh-clone-"));
    writeFileSync(join(h.work, "new.txt"), "x\n");
    run(["git", "-C", h.work, "add", "new.txt"]);
    run(["git", "-C", h.work, "commit", "-m", "add"]);
    run(["git", "-C", h.work, "push", "origin", "main"]);
    const remoteHead = run(["git", "-C", h.remote, "rev-parse", "main"]).trim();
    const workHead = run(["git", "-C", h.work, "rev-parse", "main"]).trim();
    expect(remoteHead).toBe(workHead);
  });

  it("two clones are independent", () => {
    const a = cloneHarness(tmp("gh-a-"));
    const b = cloneHarness(tmp("gh-b-"));
    writeFileSync(join(a.work, "only-a.txt"), "a\n");
    run(["git", "-C", a.work, "add", "only-a.txt"]);
    run(["git", "-C", a.work, "commit", "-m", "a"]);
    run(["git", "-C", a.work, "push", "origin", "main"]);
    expect(run(["git", "-C", b.remote, "rev-parse", "main"]).trim()).not.toBe(
      run(["git", "-C", a.remote, "rev-parse", "main"]).trim(),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/gitHarness.test.ts > /tmp/gh.txt 2>&1; echo "exit: $?"
```

Expected: FAIL — `Cannot find module './helpers/gitHarness.js'`.

- [ ] **Step 3: Implement the helper**

`tests/helpers/gitHarness.ts`:

```ts
/**
 * Shared real-git harness: a bare remote plus a seeded clone.
 *
 * Six near-identical copies of `run()` and `setupGitHarness()` predated
 * tests/helpers/ and were never retrofitted (repo, pr, worktree, critic,
 * prFlow, forkHarness). This is the single source.
 *
 * `cloneHarness` exists because building the tree costs ~142ms (10 git
 * subprocesses) while cpSync-ing a prebuilt one costs ~7ms. The template is
 * built at most once per worker process.
 */
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function run(args: string[], cwd?: string): string {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CI",
      GIT_AUTHOR_EMAIL: "ci@example.com",
      GIT_COMMITTER_NAME: "CI",
      GIT_COMMITTER_EMAIL: "ci@example.com",
    },
  });
}

export interface GitHarness {
  root: string;
  remote: string;
  work: string;
}

export function setupGitHarness(root: string): GitHarness {
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  mkdirSync(root, { recursive: true });

  run(["git", "init", "--bare", "-b", "main", remote]);
  run(["git", "init", "-b", "main", work]);
  run(["git", "-C", work, "config", "user.email", "ci@example.com"]);
  run(["git", "-C", work, "config", "user.name", "CI"]);
  run(["git", "-C", work, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(work, "README.md"), "seed\n");
  run(["git", "-C", work, "add", "README.md"]);
  run(["git", "-C", work, "commit", "-m", "seed"]);
  run(["git", "-C", work, "remote", "add", "origin", remote]);
  run(["git", "-C", work, "push", "-u", "origin", "main"]);
  return { root, remote, work };
}

let template: string | null = null;

export function harnessTemplate(): string {
  if (template === null) {
    template = mkdtempSync(join(tmpdir(), "junco-harness-tpl-"));
    setupGitHarness(template);
  }
  return template;
}

export function cloneHarness(dest: string): GitHarness {
  mkdirSync(dest, { recursive: true });
  cpSync(harnessTemplate(), dest, { recursive: true });
  return { root: dest, remote: join(dest, "remote.git"), work: join(dest, "work") };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run tests/gitHarness.test.ts > /tmp/gh.txt 2>&1; echo "exit: $?"
```

Expected: exit 0, 3 passed.

**If the push test fails:** the `cpSync` approach is dead. Delete `harnessTemplate`/`cloneHarness` and their two tests, keep `run`/`setupGitHarness`, and note in the commit body that spec §4 was dropped on evidence. Continue to Task 5 — nothing downstream depends on it.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/gitHarness.ts tests/gitHarness.test.ts
git commit -m "test(helpers): shared git harness with a template-copy fast path"
```

---

## Task 5: `tests/helpers/config.ts` with required seams

**Files:**

- Create: `tests/helpers/config.ts`
- Create: `tests/helpersConfig.test.ts`

**Interfaces:**

- Produces:
  - `interface ConfigSeams` — the 10 required keys
  - `makeConfig(seams: ConfigSeams, overrides?: Partial<Config>): Config`
  - `READ_ONLY_TOOLS: string[]`

The seam set was derived mechanically from all 19 helpers: 71 key paths, 50 byte-identical, 21 varying. See spec §1.1.

- [ ] **Step 1: Write the failing test**

`tests/helpersConfig.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeConfig, READ_ONLY_TOOLS } from "./helpers/config.js";

const seams = {
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/queue",
  worktreeRoot: "/sbxroot/wts",
  tools: [] as string[],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
};

describe("makeConfig", () => {
  it("returns the stated seams verbatim", () => {
    const c = makeConfig(seams);
    expect(c.dataDir).toBe("/sbxroot/data");
    expect(c.queueRoot).toBe("/sbxroot/queue");
    expect(c.worktreeRoot).toBe("/sbxroot/wts");
    expect(c.criticEnabled).toBe(false);
    expect(c.removeWorktreeOnSuccess).toBe(true);
  });

  it("fills the 50 ballast keys", () => {
    const c = makeConfig(seams);
    expect(c.branchPrefix).toBe("junco/");
    expect(c.defaultBaseBranch).toBe("main");
    expect(c.maxTransientRetries).toBe(2);
    expect(c.legacy).toEqual({
      vaultRoot: false,
      stateDir: false,
      worktreeRoot: false,
      externalReposRoot: false,
    });
  });

  // Poison default: a test that forgets to point ghBin at a fake must fail
  // loudly, never shell out to the maintainer's real authenticated gh.
  it("defaults ghBin to a non-existent path", () => {
    expect(makeConfig(seams).ghBin).toBe("/nonexistent/gh");
  });

  it("lets overrides win over ballast", () => {
    const c = makeConfig(seams, { branchPrefix: "x/", dailyBudgetUsd: 5 });
    expect(c.branchPrefix).toBe("x/");
    expect(c.dailyBudgetUsd).toBe(5);
  });

  it("exposes the read-only Q&A tool set", () => {
    expect(READ_ONLY_TOOLS).toEqual(["read", "grep", "find", "ls"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/helpersConfig.test.ts > /tmp/hc.txt 2>&1; echo "exit: $?"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`tests/helpers/config.ts`:

```ts
/**
 * The single Config fixture. Replaces 19 near-identical ~83-line literals.
 *
 * Derived mechanically from those 19: 71 key paths, 50 byte-identical
 * (ballast, below), 21 varying. Of the varying, 10 are semantic and are
 * REQUIRED seams the call site must state — a test must never silently
 * inherit a meaningful default. The rest are ballast-with-override, and
 * three (model.id/apiKey/baseUrl) were pure spelling noise and are
 * canonicalized.
 *
 * Adding a Config field? Add it HERE and nowhere else.
 * See docs/superpowers/specs/2026-07-21-test-suite-consolidation-design.md §1.1
 */
import type { Config } from "../../src/types.js";

/** The Q&A read-only default. Widening this is a hard-contract violation. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/** The 10 keys whose value changes what is under test. All required. */
export interface ConfigSeams {
  dataDir: string;
  queueRoot: string;
  worktreeRoot: string;
  tools: string[];
  criticEnabled: boolean;
  planLintEnabled: boolean;
  verifyEnabled: boolean;
  supervisorEnabled: boolean;
  healthEnabled: boolean;
  removeWorktreeOnSuccess: boolean;
}

export function makeConfig(seams: ConfigSeams, overrides: Partial<Config> = {}): Config {
  return {
    // ---- required seams ----
    dataDir: seams.dataDir,
    queueRoot: seams.queueRoot,
    worktreeRoot: seams.worktreeRoot,
    tools: seams.tools,
    criticEnabled: seams.criticEnabled,
    planLintEnabled: seams.planLintEnabled,
    verifyEnabled: seams.verifyEnabled,
    supervisorEnabled: seams.supervisorEnabled,
    healthEnabled: seams.healthEnabled,
    removeWorktreeOnSuccess: seams.removeWorktreeOnSuccess,

    // ---- poison default: must not reach the real gh ----
    ghBin: "/nonexistent/gh",

    // ---- ballast: byte-identical across all 19 helpers ----
    legacy: { vaultRoot: false, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    model: {
      id: "test/model",
      api: "openai-completions",
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:1234/v1",
      baseUrlExplicit: false,
      contextWindow: 131072,
      maxTokens: 49152,
      input: ["text", "image"],
      reasoning: true,
      source: "auto",
      thinkingLevel: "medium",
      modelsJson: null,
    },
    defaultTimeoutMinutes: 30,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
    endpointProbe: "auto",
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    allowedRepoRoots: [],
    draftByDefault: true,
    defaultLabels: [],
    verifyCommandTimeout: 60,
    verifyBlockOnFail: false,
    planLintBlockOnError: false,
    planLintCheckLabels: false,
    commitLeftoversEnabled: false,
    dailyBudgetUsd: 0,
    criticMaxRetries: 1,
    criticThinking: "minimal",
    healthHost: "127.0.0.1",
    healthPort: 8787,
    logLevel: "info",
    logToFile: false,
    transcriptsEnabled: false,
    github: {
      enabled: false,
      repos: [],
      triggerLabel: "junco",
      askLabel: "junco:ask",
      requireApproval: true,
      pollIntervalSeconds: 60,
      plannerModelId: null,
      externalReposRoot: "/sbxroot/external",
    },
    ...overrides,
  } as Config;
}
```

Note: `assess`, `sandbox`, and `botAccount` sub-objects must also be filled from the current helpers. Copy them verbatim from `tests/runOnce.test.ts`'s `cfg()` — they are byte-identical across all 19.

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run tests/helpersConfig.test.ts > /tmp/hc.txt 2>&1; echo "exit: $?"
npx tsc -p tsconfig.eslint.json --noEmit 2>&1 | grep -c "helpers/config" || echo "0 type errors in helper"
```

Expected: exit 0; no type errors referencing `helpers/config`.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/config.ts tests/helpersConfig.test.ts
git commit -m "test(helpers): single Config fixture with type-enforced seams"
```

---

## Tasks 6–9: Adopt the Config helper (four waves)

Each wave is one commit. The mechanical procedure is **identical** for every file; it is stated in full here and applies to Tasks 6, 7, 8, and 9.

**Procedure per file:**

1. Read the file's existing helper (`makeConfig` / `cfg` / `makeCfg` / `makeFakeConfig` / `DISPATCH_CONFIG_BASE` / `CONFIG_DEFAULTS`).
2. Read off its values for the 10 seams. These are already in the file — do not invent them.
3. Replace the helper body with a `makeConfig(...)` call carrying those seams. Keep the local function name and signature so **call sites do not change**:

```ts
import { makeConfig as baseConfig } from "./helpers/config.js";

function makeConfig(h: Harness, overrides: Partial<Config> = {}): Config {
  return baseConfig(
    {
      dataDir: h.root,
      queueRoot: join(h.root, "Junco"),
      worktreeRoot: h.wtsRoot,
      tools: [],
      criticEnabled: false,
      planLintEnabled: false,
      verifyEnabled: false,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: false, // preserve so we can assert on commits
    },
    { ghBin: h.ghBin, ...overrides },
  );
}
```

4. **Preserve every existing intent comment.** `// preserve so we can assert on commits`, `// off by default; opt-in per test`, `// not used in worktree tests` — these document why a seam has its value. Carry them onto the seam lines.
5. Any key the file set to a **non-ballast** value that is not a seam goes in the second argument (e.g. `ghBin`, `healthPort: 0`, `defaultTimeoutMinutes: 1`).
6. Run that file's suite. Green before moving to the next file.

**Verification after each file:**

```bash
npx vitest run tests/<file>.test.ts > /tmp/w.txt 2>&1; echo "exit: $?"
```

**Verification at the end of each wave:**

```bash
npx vitest run > /tmp/all.txt 2>&1; echo "exit: $?"
npx tsc -p tsconfig.eslint.json --noEmit > /tmp/tc.txt 2>&1; echo "exit: $?"
npx prettier --write "tests/**/*.ts" > /dev/null
```

Expected: 3,126 tests still passing (count must not drop — this task deletes no tests).

### Task 6: Wave A — the flow suites

**Files:** `tests/runOnce.test.ts:28`, `tests/prFlow.test.ts:105`, `tests/daemon.test.ts:120`, `tests/critic.test.ts:43`, `tests/verify.test.ts:17`

- [ ] Apply the procedure to each of the five files
- [ ] Run the wave verification
- [ ] Commit: `git commit -m "test: adopt the shared Config fixture in the flow suites"`

### Task 7: Wave B — the git-harness suites

**Files:** `tests/repo.test.ts:101`, `tests/pr.test.ts:75`, `tests/worktree.test.ts:91`, `tests/health.test.ts:17`, `tests/orphans.test.ts:10`

- [ ] Apply the procedure to each of the five files
- [ ] Run the wave verification
- [ ] Commit: `git commit -m "test: adopt the shared Config fixture in the git-harness suites"`

### Task 8: Wave C — the data/config-command suites

**Files:** `tests/dataCmd.test.ts:34`, `tests/dataMigrate.test.ts:33`, `tests/dataMigrateCmd.test.ts:30`, `tests/dataTree.test.ts:15`, `tests/configCmd.test.ts:16`

**Extra care:** `dataTree.test.ts` uses `/sbxroot/...` synthetic paths 61 times. Those are seams (`dataDir`, `queueRoot`, `worktreeRoot`) and must stay synthetic — `canonicalize()` realpaths real paths, so a tmpdir would break its exact-path assertions. The `legacy` overrides in the data-migration suites go in the second argument.

- [ ] Apply the procedure to each of the five files
- [ ] Run the wave verification
- [ ] Commit: `git commit -m "test: adopt the shared Config fixture in the data-command suites"`

### Task 9: Wave D — the remaining suites

**Files:** `tests/analyzeFlow.test.ts:16`, `tests/assessFlow.test.ts:19`, `tests/cli.test.ts:833`, `tests/dispatch.test.ts:27`

Note: `analyzeFlow`'s and `assessFlow`'s helpers are byte-identical to `runOnce`'s — after adoption all three should read identically.

- [ ] Apply the procedure to each of the four files
- [ ] Run the wave verification
- [ ] **Confirm the tax is actually gone:**

```bash
grep -rlE "(const|function) (makeConfig|cfg|baseConfig|makeCfg|makeFakeConfig)\b" tests/ | grep -v helpers/ | wc -l
```

Expected: only files that now delegate to `helpers/config.js` — verify each remaining hit is a thin wrapper, not a full literal.

- [ ] Commit: `git commit -m "test: adopt the shared Config fixture in the remaining suites"`

---

## Task 10: Adopt the shared git harness

**Files:** `tests/repo.test.ts:24,38`, `tests/pr.test.ts:32,47`, `tests/worktree.test.ts:45,60`, `tests/critic.test.ts:29,219`, `tests/prFlow.test.ts:47,62`, `tests/helpers/forkHarness.ts:16`

- [ ] **Step 1: Replace each local `run()` with the shared import**

```ts
import { run } from "./helpers/gitHarness.js";
```

Delete the local definition. `forkHarness.ts` imports from `./gitHarness.js` (same directory).

- [ ] **Step 2: Replace each local harness builder with `cloneHarness`**

Where a file builds the bare-remote-plus-clone tree in `beforeEach`, call `cloneHarness(root)` instead. Keep every file-specific extra (prFlow's fake-gh script and queue dirs; worktree's `wtsRoot`) in the local wrapper:

```ts
function setup(): Harness {
  const root = mkdtempSync(join(tmpdir(), "junco-prflow-"));
  const { remote, work } = cloneHarness(root);
  const wtsRoot = join(root, "wts");
  // ... file-specific dirs and fake-gh, unchanged
  return { root, remote, work, wtsRoot, ghBin, processing, done, failed };
}
```

**If Task 4's spike failed,** use `setupGitHarness(root)` here instead — same signature, no perf gain.

- [ ] **Step 3: Verify each file, then measure the win**

```bash
for f in repo pr worktree critic prFlow; do npx vitest run tests/$f.test.ts > /tmp/$f.txt 2>&1; echo "$f exit: $?"; done
/usr/bin/time -p npx vitest run > /tmp/after.txt 2>&1; grep ^real /tmp/after.txt
```

Expected: all exit 0. Record the wall time against the 26.8s baseline.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: adopt the shared git harness across the real-git suites"
```

---

## Task 11: `tests/helpers/fakeSession.ts`

**Files:**

- Create: `tests/helpers/fakeSession.ts`
- Modify: `tests/runOnce.test.ts:112,142`, `tests/analyzeFlow.test.ts:149,175`, `tests/assessFlow.test.ts:152,178`

**Interfaces:**

- Produces:
  - `fakeSession(events: AgentEvent[]): AgentSessionLike` — emits via `queueMicrotask` on `subscribe`
  - `fakeFactory(events: AgentEvent[]): () => Promise<AgentSessionLike>`

`analyzeFlow.test.ts:149-174` and `assessFlow.test.ts:152-177` are byte-identical; `analyzeFlow.test.ts:177` carries a comment saying so.

**Do NOT fold in `critic.test.ts:150,189`** — its variants are push-based (`listeners[]` driven by `prompt()`) because critic drives the session synchronously. That is a structural difference, not duplication.

- [ ] **Step 1: Write the failing test** in `tests/helpersFakeSession.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fakeSession } from "./helpers/fakeSession.js";
import type { AgentEvent } from "../src/agent/session.js";

describe("fakeSession", () => {
  it("delivers queued events to a subscriber and resolves prompt", async () => {
    const events = [{ type: "turn_end" }] as unknown as AgentEvent[];
    const s = fakeSession(events);
    const seen: AgentEvent[] = [];
    s.subscribe((e) => seen.push(e));
    await s.prompt("go");
    await new Promise((r) => setTimeout(r, 1));
    expect(seen).toHaveLength(1);
  });

  it("unsubscribe stops delivery", async () => {
    const s = fakeSession([{ type: "turn_end" }] as unknown as AgentEvent[]);
    const seen: AgentEvent[] = [];
    s.subscribe((e) => seen.push(e))();
    await s.prompt("go");
    await new Promise((r) => setTimeout(r, 1));
    expect(seen).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/helpersFakeSession.test.ts > /tmp/fs.txt 2>&1; echo "exit: $?"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — copy the body of `tests/runOnce.test.ts:142`'s `fakeSession` verbatim into `tests/helpers/fakeSession.ts`, exporting it and `fakeFactory`. It already implements the `AgentSessionLike` contract (`subscribe`/`prompt`/`dispose`/`abort`, `src/agent/session.ts:48-53`).

- [ ] **Step 4: Adopt in the three files and verify**

```bash
for f in runOnce analyzeFlow assessFlow helpersFakeSession; do npx vitest run tests/$f.test.ts > /tmp/$f.txt 2>&1; echo "$f exit: $?"; done
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test(helpers): share the fake AgentSessionLike across flow suites"
```

---

## Task 12: `tests/helpers/ghScript.ts`

**Files:**

- Create: `tests/helpers/ghScript.ts`
- Modify: `tests/prFlow.test.ts` (7 blocks), `tests/repo.test.ts:70,482`, `tests/pr.test.ts:419`, `tests/runOnce.test.ts:1562`, `tests/git.test.ts:292`, `tests/planLint.test.ts:651,669,690`

**Interfaces:**

- Produces: `ghCases(dir: string, name: string, cases: Record<string, string>): string` — writes an executable `sh` script, returns its path.

**Critical constraint — spec §1.2:** only the _generator_ moves. Every **case table stays at its call site**. Each `*) echo "fake-gh: unhandled: $args" >&2; exit 1` arm is a negative assertion that no unexpected subcommand was invoked; one shared mega-`gh` would silently accept wrong calls. `prFlow`'s six distinct sets (`gh-resume`, `gh-refuse`, `gh-exists`, `gh-nogo`, `gh-net`, `gh-amend`) are six contracts.

- [ ] **Step 1: Write the failing test** in `tests/helpersGhScript.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghCases } from "./helpers/ghScript.js";

const d = mkdtempSync(join(tmpdir(), "ghs-"));
afterAll(() => rmSync(d, { recursive: true, force: true }));

describe("ghCases", () => {
  it("dispatches a matched subcommand", () => {
    const bin = ghCases(d, "gh-ok", { "pr create *": 'echo "https://x/pull/1"; exit 0' });
    expect(execFileSync(bin, ["pr", "create", "--title", "t"], { encoding: "utf8" }).trim()).toBe(
      "https://x/pull/1",
    );
  });

  // The fallback arm is a negative assertion: an unexpected call must fail.
  it("exits non-zero on an unmatched subcommand", () => {
    const bin = ghCases(d, "gh-strict", { "pr create *": "exit 0" });
    expect(() => execFileSync(bin, ["repo", "delete"], { encoding: "utf8" })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/helpersGhScript.test.ts > /tmp/gs.txt 2>&1; echo "exit: $?"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement** by lifting `prFlow.test.ts`'s existing `ghCases`/`ghShim` (around line 1160) into the helper. Behavior is unchanged; the **signature gains a leading `dir` parameter** because the helper can no longer close over a harness-local root. Update prFlow's call sites to pass `h.root`.

- [ ] **Step 4: Adopt in the listed files, one at a time, verifying each**

```bash
for f in prFlow repo pr runOnce git planLint helpersGhScript; do npx vitest run tests/$f.test.ts > /tmp/$f.txt 2>&1; echo "$f exit: $?"; done
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test(helpers): share the fake-gh generator, keep case tables local"
```

---

## Task 13: `tests/helpers/dashFixtures.ts` and `makeQueueTree`

**Files:**

- Create: `tests/helpers/dashFixtures.ts`
- Modify: `tests/tuiApp.test.tsx:317,341`, `tests/tuiPrPreview.test.tsx:18`, `tests/tuiPrList.test.tsx:12`, `tests/tuiPrColumns.test.tsx:9`, `tests/tuiPrState.test.ts:25`, `tests/prsCmd.test.ts:193`, `tests/tuiIssueList.test.tsx:10`, `tests/tuiState.test.ts:11`, `tests/tuiPreview.test.tsx:7`, `tests/tuiPrimitives.test.tsx:165`, `tests/tuiIssueColumns.test.tsx:9`, `tests/botAccess.test.ts:6`, `tests/git.test.ts:279`, `tests/cli.test.ts:29`, `tests/externalDispatch.test.ts:23`, `tests/tuiGhClient.test.ts:40`
- Modify (queue tree): `tests/runOnce.test.ts`, `tests/analyzeFlow.test.ts`, `tests/assessFlow.test.ts`, `tests/daemon.test.ts`, `tests/listCmd.test.ts`, `tests/retryCmd.test.ts`, `tests/rmCmd.test.ts`, `tests/statusCmd.test.ts`

**Interfaces:**

- Produces:
  - `makeDashPr(overrides?: Partial<DashPr>): DashPr` (replaces 6 copies, 143 lines)
  - `makeDashIssue(overrides?: Partial<DashIssue>): DashIssue` (6 copies, 52 lines)
  - `GH_AUTH_CTX: GhAuthContext` (5 copies)
  - `makeQueueTree(root: string): { inbox: string; processing: string; done: string; failed: string }` (59 occurrences across 8 files)

- [ ] **Step 1: Write the failing test** in `tests/helpersDashFixtures.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDashPr, makeDashIssue, makeQueueTree } from "./helpers/dashFixtures.js";

const d = mkdtempSync(join(tmpdir(), "dfx-"));
afterAll(() => rmSync(d, { recursive: true, force: true }));

describe("dash fixtures", () => {
  it("makeDashPr applies overrides over defaults", () => {
    expect(makeDashPr({ number: 7 }).number).toBe(7);
    expect(makeDashPr().number).toBeTypeOf("number");
  });

  it("makeDashIssue applies overrides over defaults", () => {
    expect(makeDashIssue({ number: 3 }).number).toBe(3);
  });

  it("makeQueueTree creates the four queue dirs", () => {
    const p = makeQueueTree(d);
    for (const dir of [p.inbox, p.processing, p.done, p.failed]) expect(existsSync(dir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/helpersDashFixtures.test.ts > /tmp/dfx.txt 2>&1; echo "exit: $?"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**, copying the default field values verbatim from `tests/tuiApp.test.tsx:317` (`DashPr`, 21 fields) and `:341` (`DashIssue`). `makeQueueTree`:

```ts
export function makeQueueTree(root: string): {
  inbox: string;
  processing: string;
  done: string;
  failed: string;
} {
  const names = ["inbox", "processing", "done", "failed"] as const;
  const out = {} as Record<(typeof names)[number], string>;
  for (const n of names) {
    out[n] = join(root, n);
    mkdirSync(out[n], { recursive: true });
  }
  return out;
}
```

- [ ] **Step 4: Adopt file-by-file and verify the full suite**

```bash
npx vitest run > /tmp/all.txt 2>&1; echo "exit: $?"
```

Expected: exit 0, 3,126 tests.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test(helpers): share dashboard fixtures and the queue-tree scaffold"
```

---

## Task 14: Provably-dead deletions

**Files:** `tests/doctor.test.ts`

These have **mathematically zero** marginal coverage — verified by `diff` and by substring containment. No prove-it-fails cycle is required; the proof is structural.

- [ ] **Step 1: Re-verify the subset claim before deleting**

```bash
sed -n '1056,1089p' tests/doctor.test.ts > /tmp/a.txt
sed -n '1091,1122p' tests/doctor.test.ts > /tmp/b.txt
diff <(sed -n '3,30p' /tmp/a.txt) <(sed -n '3,30p' /tmp/b.txt) && echo "IDENTICAL SETUP"
grep -n "junco auth grant" /tmp/a.txt /tmp/b.txt
```

Expected: identical setup; `b`'s assertion regex is a substring of `a`'s. **If this does not hold, stop and report** — do not delete.

- [ ] **Step 2: Delete `tests/doctor.test.ts:1091-1122`** (32 lines, the TRIAGE-fixture-reused test).

- [ ] **Step 3: Fold cluster A into `:772`**

The 8 tests at `:153`, `:786`, `:904`, `:1248`, `:1293`, `:1327`, `:1363` each issue a byte-identical `runDoctor("/x/config.json", deps({ printFn: (s) => lines.push(s) }))` and assert one `not.toMatch`. Move each `expect(...).not.toMatch(...)` line into the body of `:772` (which already asserts four absences) and delete the 7 now-empty tests.

**Keep `:96`** — it injects `existsFn`/`readdirFn` for #199.3 hermeticity, which `:772` does not.

- [ ] **Step 4: Reduce the global warning-counter coupling**

Ten sites assert `/N warning\(s\)/` against the file-wide summary: `:426`, `:781`, `:1322`, `:1358`, `:1385`, `:1404`, `:1431`, `:1449`, `:1463`, `:1479`. Adding any new warn-level check to `runDoctor` breaks all ten at once. Remove the counter assertion from all except:

- `:772`/`:781` — the canonical summary site
- `:397`/`:426` — where the count is what distinguishes ✓-hint from ⚠-warn

- [ ] **Step 5: Verify**

```bash
npx vitest run tests/doctor.test.ts > /tmp/d.txt 2>&1; echo "exit: $?"
grep -c "^\s*it(" tests/doctor.test.ts
```

Expected: exit 0; test count 75 → 67.

- [ ] **Step 6: Commit**

```bash
git add tests/doctor.test.ts
git commit -m "test(doctor): drop a proven-subset test and fold the absence cluster into one run"
```

---

## Task 15: Gate-matrix deletions, each gated by prove-it-fails-first

**Files:** `tests/runOnce.test.ts:655-1051`, `tests/prFlow.test.ts:1427-1794`

**Rule:** unit tests own the matrix, integration tests own the wiring. `tests/providerFailure.test.ts` keeps all 11 classification cases and is **not touched**.

Keep exactly **2** representatives per integration file — count-free vs budgeted requeue, which is a genuine integration difference:

- `runOnce.test.ts`: keep `:656` (401 → auth → count-free) and `:742` ("agent gave up" → budgeted). Delete `:689`, `:712`, `:838`, `:862`, `:884`, `:1032` and the remaining matrix rows.
- `prFlow.test.ts`: keep `:1540` (401 → auth → count-free) and `:1614` (ECONNREFUSED → outage → budgeted). Delete `:1590`, `:1639`, `:1662`, `:1690`, `:1712`.

**Do NOT delete `prFlow.test.ts:1565`** (`commitThenThrowFactory`) — its disposition is fail-plus-preserve, a third distinct outcome, not a matrix row.

- [ ] **Step 1: Prove the remaining suite still catches a classifier regression BEFORE deleting**

Break the classifier in `src/providerFailure.ts` — make `classifyProviderFailure` return `null` unconditionally:

```bash
npx vitest run tests/providerFailure.test.ts tests/runOnce.test.ts tests/prFlow.test.ts > /tmp/pf.txt 2>&1; echo "exit: $?"
```

Expected: **FAIL**. Record which files fail. Revert the break.

- [ ] **Step 2: Delete the listed tests**

- [ ] **Step 3: Prove-it-fails-first — re-break and confirm the reduced suite STILL goes red**

Apply the identical break from Step 1:

```bash
npx vitest run tests/providerFailure.test.ts tests/runOnce.test.ts tests/prFlow.test.ts > /tmp/pf2.txt 2>&1; echo "exit: $?"
```

Expected: **FAIL**, still. If it now passes, coverage was lost — **revert the deletions** and report.

Revert the break.

- [ ] **Step 4: Prove the wiring representatives still bite**

Break the _wiring_ instead — in `src/runOnce.ts`, stop calling the gate's failure hook:

```bash
npx vitest run tests/runOnce.test.ts > /tmp/w.txt 2>&1; echo "exit: $?"
```

Expected: **FAIL** (the 2 kept representatives catch it). Revert.

- [ ] **Step 5: Full suite plus coverage floor**

```bash
npx vitest run --coverage > /tmp/cov.txt 2>&1; echo "exit: $?"
```

Expected: exit 0 — the Task 1 thresholds must still hold. **If coverage dropped below the floor, revert and report.**

- [ ] **Step 6: Commit**

```bash
git add tests/runOnce.test.ts tests/prFlow.test.ts
git commit -m "test: let providerFailure own the classifier matrix, integration own the wiring"
```

---

## Task 16: Hermeticity fix

**Files:** `tests/doctor.test.ts:17,19` and the affected tests

`okConfig.dataDir = "/tmp/junco-doc-state"` and `worktreeRoot` are **real paths**. Eight tests run the real `fs` against them and assert exact warning counts — they pass only because those directories happen not to exist on the machine. #199.3 fixed this at `:96` and `:379` for 2 of ~10.

- [ ] **Step 1: Prove the bug is real**

```bash
mkdir -p /tmp/junco-doc-state
npx vitest run tests/doctor.test.ts > /tmp/h.txt 2>&1; echo "exit: $?"
```

Expected: **FAIL** — tests break purely because a directory exists. This is the bug. Leave the directory in place for Step 3.

- [ ] **Step 2: Point the shared fixture at synthetic paths**

Change `okConfig`'s `dataDir` to `/sbxroot/doc-state` and `worktreeRoot` to `/sbxroot/doc-worktrees` (non-existent by construction, and `canonicalize()` is a no-op on them). Propagate #199.3's `existsFn`/`readdirFn` injection to the remaining affected tests: `:772`, `:1248`, `:1293`, `:1327`, `:1363`, `:1436`, `:1452`, `:1466`.

- [ ] **Step 3: Prove the fix — the polluting directory must no longer matter**

```bash
npx vitest run tests/doctor.test.ts > /tmp/h2.txt 2>&1; echo "exit: $?"
rmdir /tmp/junco-doc-state
npx vitest run tests/doctor.test.ts > /tmp/h3.txt 2>&1; echo "exit: $?"
```

Expected: **exit 0 both times** — the result no longer depends on the real filesystem.

- [ ] **Step 4: Commit**

```bash
git add tests/doctor.test.ts
git commit -m "test(doctor): make the config fixture hermetic (completes #199.3)"
```

---

## Task 17: Update CLAUDE.md and close out

**Files:** `CLAUDE.md`

CLAUDE.md's testing-gotchas section is now wrong: it names 6 files with `Config` literals (the real count was 19) and instructs updating every one. Leaving it would send the next session chasing helpers that no longer exist.

- [ ] **Step 1: Replace the stale bullet**

Old:

> **Adding a `Config` field? Update every test fixture that builds a full `Config` literal** — `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts` each have a `makeConfig`/`cfg()` helper.

New:

> **Adding a `Config` field? Add it to `tests/helpers/config.ts` and nowhere else.** That file is the only full `Config` literal in the suite (it replaced 19). Its `ConfigSeams` are the ~10 keys whose value changes what is under test — if the new field is one of those, add it to the interface so call sites must state it; otherwise it is ballast. Shared fixtures live in `tests/helpers/`: `config`, `gitHarness`, `fakeSession`, `ghScript`, `dashFixtures`, `until`, `forkHarness`, `localFixtures`.

- [ ] **Step 2: Add a coverage line to the Commands table**

```markdown
| Coverage | `npx vitest run --coverage` (floor enforced by `vitest.config.ts` thresholds; CI job `coverage`) |
```

- [ ] **Step 3: Run the full gate**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run --coverage > /tmp/final.txt 2>&1; echo "exit: $?"
tail -20 /tmp/final.txt
```

Expected: exit 0 throughout. Coverage at or above the Task 1 floor.

- [ ] **Step 4: Report the outcome against the spec's targets**

```bash
echo "test lines now: $(find tests -name '*.ts' -o -name '*.tsx' | xargs wc -l | tail -1)"
echo "baseline was:   58358"
echo "tests now:      $(grep -c 'Tests ' /tmp/final.txt; grep 'Tests ' /tmp/final.txt)"
/usr/bin/time -p npx vitest run > /tmp/t.txt 2>&1; grep ^real /tmp/t.txt
echo "wall baseline:  26.8s"
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: point the Config-fixture guidance at tests/helpers/config.ts"
```

---

## Do-not-touch list

These encode a specific regression, a real filesystem/race precondition, or a negative assertion. **No task in this plan may modify, table, or delete them.**

| Location                        | Why                                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor.test.ts:1019`           | #186/#192.3. Coverage is in its `execFn`: returns `WRITE` only if `GH_CONFIG_DIR === "/sbx/junco-gh"` and both `GH_TOKEN`/`GITHUB_TOKEN` are empty. A plain `WRITE` stub silently deletes the token-clearing pin. |
| `prFlow.test.ts:1185` + `:1225` | #70. Opposed pair: identical remote setup, opposite policy keyed on `retry_count`. The contrast _is_ the fix.                                                                                                     |
| `prFlow.test.ts:884`            | #123/#125. Asserts a **negative** — the false "with no committed work" banner must be absent.                                                                                                                     |
| `prFlow.test.ts:1288`           | #73. Deterministic `gh pr create` failure must fail terminally, never requeue.                                                                                                                                    |
| `prFlow.test.ts:2108`           | #75. Asserts recorded argv for `gh pr list --head owner:branch`.                                                                                                                                                  |
| `prFlow.test.ts:1351`           | #50. `status: completed` **and** `pushed: false` simultaneously.                                                                                                                                                  |
| `prFlow.test.ts:1565`           | Third disposition (fail + preserve), not a matrix row.                                                                                                                                                            |
| `runOnce.test.ts:403`           | #115. Needs a regular file at `Junco/failed` so `mkdirSync` throws `EEXIST`.                                                                                                                                      |
| `runOnce.test.ts:1294`          | #113. Needs a real on-disk symlink for `realpathSync.native` aliasing.                                                                                                                                            |
| `runOnce.test.ts:779`           | Recovered auto-retry blip; the event _sequence_ encodes a critical `runResult.ts` fix.                                                                                                                            |
| `runOnce.test.ts:920` + `:977`  | #180. Deliberate pair: timeout must beat a stale gate-class `errorMessage`.                                                                                                                                       |
| `runOnce.test.ts:1526`          | The file's only true integration test (real git, real fake-gh, real review store).                                                                                                                                |
| `daemon.test.ts:978` vs `:1158` | Look identical, are not: account-level (fail, exit 1) vs per-repo (warn, exit 0).                                                                                                                                 |
| `daemon.test.ts:1692`           | Crash never strands a claimed ticket; real queue + real `claimNextTask`.                                                                                                                                          |
| `daemon.test.ts:1580`           | Real-`setTimeout` concurrency race; the 20ms at `:1599` is load-bearing.                                                                                                                                          |
| `doctor.test.ts:604`            | Google `/v1beta` double-suffix guard; the input `baseUrl` is the test.                                                                                                                                            |
| `doctor.test.ts:319`            | #71. Empty `healthHost`; the empty string is the whole test.                                                                                                                                                      |
| `doctor.test.ts:96`, `:379`     | #199.3 hermeticity injections — propagate, never remove.                                                                                                                                                          |
| `configLevers.test.ts:8-19`     | The bijection oracle. Must stay derived from `ConfigSchema`, never fixtured.                                                                                                                                      |
| `config.test.ts` (whole file)   | Round-trips real JSON through the module under test. A fixture would assert itself.                                                                                                                               |

## Follow-ups (file as issues, do not do here)

- `src/types.ts:111-113` — `updateCheck?: boolean` is optional _only_ "so test fixtures that build full Config literals keep compiling." With one fixture, that optionality can likely be tightened to required.
- `configLevers.ts` (801 lines) has a 194-line test; `execProbe.ts` has no importing test at all; `guardManager.ts` and `pidfileLock.ts` are below median coverage despite being crash-safety-critical.
- `src/tui/App.tsx` decomposition — sub-project B, brainstormed separately.
