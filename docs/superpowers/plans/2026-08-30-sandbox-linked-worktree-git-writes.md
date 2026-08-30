# Sandbox: linked-worktree git writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under the default-on sandbox, let the agent `git commit` in the linked worktree junco hands it, by adding the owning repo's git common dir (`<repo>/.git`) to the sandbox's writable roots automatically — closing issue #320.

**Architecture:** `resolveSandbox` (`src/agent/session.ts`) is the only production caller of `buildPolicy`. It gains an injectable `gitDirs` seam that runs `git rev-parse --path-format=absolute --git-dir --git-common-dir` in the ticket's cwd (a new small module `src/agent/sandbox/gitDirs.ts`, `check: false`, any failure → null). A pure helper in `src/agent/sandbox/policy.ts`, `linkedWorktreeWritePaths({ cwd, gitDir, commonDir })`, turns that answer into extra writable roots: the whole common dir (maintainer's ruling on #320 — every git operation works; the trade-off that `.git/hooks`/`config` of the owning checkout become agent-writable is documented), plus the gitdir itself only when it lies outside both the common dir and the cwd; nothing when the common dir is inside the cwd (a standalone clone is already writable). `buildPolicy` takes the list as a new `gitWritePaths` option and places it after `cwd`/`scratchDir` and before `extraAllowWrite`. No backend changes: both OS backends already render writable roots (`subpath` / `--bind`), `readRules` already turns writable roots into read allow-backs that out-specify the wholesale data-root deny (so managed clones under `<dataDir>/cache/clones` work), and `traversalMetadataPaths` iterates those same allow rules. `junco doctor`'s stand-in preflight policy is untouched.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, prettier (100 cols), eslint (type-aware). Sandbox backends: Seatbelt (macOS), bubblewrap (Linux), none.

**Spec:** GitHub issue #320 (`gh issue view 320`) — problem statement, evidence, and the proposed fix — with the maintainer's ruling in this session: writable scope = the **whole** `<repo>/.git`, not the minimal `objects/refs/logs` set.

## Global Constraints

- Every side effect goes behind an injectable `deps` seam. `resolveGitDirs` takes a `gitFn` (default: the real `git` from `src/git.ts`); `resolveSandbox` takes `gitDirs` in `ResolveSandboxDeps`. Unit tests never spawn real `git`.
- `src/agent/session.ts` must never import the Pi SDK at module top level (type-only imports are fine). Importing `../git.js` is fine (node builtins + logging only).
- Sandbox unit tests use synthetic non-existent paths (`/sbxroot/...`) so `canonicalize()` (which realpaths real paths) is a no-op. Only `tests/sandbox.integration.test.ts` touches real dirs, and every enforcement case there calls `requireBackend(ctx)` first (it skips, never silently passes, when no OS backend is available).
- `buildPolicy` stays pure (no I/O). `SandboxPolicy`'s shape is unchanged: the new roots land in the existing `writableRoots` array.
- `src/ticketSchema.ts` untouched; no new config keys.
- Prettier at 100 cols: `npx prettier --write <files>` before every commit (Markdown included). Conventional commits; **no AI attribution** (no `Co-Authored-By: Claude`, no "Generated with" lines) — amend any auto-appended trailer away.
- Suite green at every commit. Full gate before declaring done: `npm run lint && npm run format:check && npm run typecheck && npm run build`, then `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` (capture the exit code explicitly, never through a pipe).
- Work only in this worktree (`.claude/worktrees/sandbox-git-writes`, branch `fix/sandbox-git-writes`). Never touch the main checkout, `config.json`, `tickets/`, `worktrees/`, or the live `~/.junco` tree. This shell aliases `grep` to `ugrep`; use `/usr/bin/grep` or `sed` for searches.

---

### Task 1: `linkedWorktreeWritePaths` + `gitWritePaths` in `buildPolicy`

**Files:**

- Modify: `src/agent/sandbox/policy.ts` (add the helper next to `builtinDenyReadPaths`; extend `buildPolicy`'s opts and its `writableRoots` construction ~line 82)
- Test: `tests/sandboxPolicy.test.ts`

**Interfaces:**

- Consumes: `canonicalize(p)` (already imported in policy.ts), `isUnder`-style prefix logic — implement locally with `node:path` (`sep`), do not import from `pathJail.ts` (it imports policy types; avoid a cycle).
- Produces:
  - `export interface GitDirs { gitDir: string; commonDir: string }`
  - `export function linkedWorktreeWritePaths(opts: { cwd: string } & GitDirs): string[]`
  - `buildPolicy(opts)` accepts `gitWritePaths?: string[]` (default `[]`), and `writableRoots` = `[canon(cwd), canon(scratchDir), ...gitWritePaths.map(canon), ...cfg.extraAllowWrite.map(canon)]` — Task 2 relies on this exact name and ordering.

- [ ] **Step 1: Write the failing tests**

In `tests/sandboxPolicy.test.ts`, extend the import from `../src/agent/sandbox/policy.js` to also import `linkedWorktreeWritePaths`. Then add, after the existing `describe("builtinDenyReadPaths", …)` block:

```ts
describe("linkedWorktreeWritePaths (#320)", () => {
  const cwd = "/sbxroot/work/tree";

  it("a linked worktree adds the owning repo's whole common dir", () => {
    expect(
      linkedWorktreeWritePaths({
        cwd,
        gitDir: "/sbxroot/repo/.git/worktrees/tree",
        commonDir: "/sbxroot/repo/.git",
      }),
    ).toEqual(["/sbxroot/repo/.git"]);
  });

  it("a standalone repo (common dir inside the cwd) adds nothing — the cwd already covers it", () => {
    expect(
      linkedWorktreeWritePaths({
        cwd,
        gitDir: "/sbxroot/work/tree/.git",
        commonDir: "/sbxroot/work/tree/.git",
      }),
    ).toEqual([]);
  });

  it("a gitdir outside both the common dir and the cwd is added too", () => {
    expect(
      linkedWorktreeWritePaths({
        cwd,
        gitDir: "/sbxroot/elsewhere/gitdir",
        commonDir: "/sbxroot/repo/.git",
      }),
    ).toEqual(["/sbxroot/repo/.git", "/sbxroot/elsewhere/gitdir"]);
  });

  it("is prefix-safe: /sbxroot/work/tree-2 is not inside /sbxroot/work/tree", () => {
    expect(
      linkedWorktreeWritePaths({
        cwd,
        gitDir: "/sbxroot/work/tree-2/.git",
        commonDir: "/sbxroot/work/tree-2/.git",
      }),
    ).toEqual(["/sbxroot/work/tree-2/.git"]);
  });
});
```

Inside the existing `describe("buildPolicy", …)` block, after the `it("writable roots = cwd + scratch + extras", …)` case, add:

```ts
it("gitWritePaths land after cwd/scratch and before the operator's extras (#320)", () => {
  const pol = buildPolicy({ ...base, gitWritePaths: ["/sbxroot/repo/.git"] });
  expect(pol.writableRoots).toEqual([
    "/sbxroot/work/tree",
    "/sbxroot/nowhere/scratch1",
    "/sbxroot/repo/.git",
    "/sbxroot/extra/writable",
  ]);
});
```

Inside `describe("buildPolicy — default <dataDir>-rooted layout (JS jail)", …)`, add after the `it("allows reads of the watched-clone gitdirs …")` case (note: this describe builds `policy` once at the top; the new case builds its own):

```ts
it("a linked worktree's git metadata under the denied clones tier is writable once threaded in (#320)", () => {
  const withGit = buildPolicy({
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: [],
      extraAllowWrite: [],
    },
    cwd,
    scratchDir: "/sbxroot/nowhere/scratch1",
    home: "/sbxroot/home/x",
    dataDenyPaths: {
      dirs: [`${dataDir}/queue`, `${dataDir}/review`],
      files: [`${dataDir}/watchlist.json`],
    },
    gitWritePaths: [`${dataDir}/clones/watched/o/r/.git`],
    network: false,
  });
  const lock = `${dataDir}/clones/watched/o/r/.git/worktrees/tkt-1/index.lock`;
  expect(assertWriteAllowed(lock, cwd, withGit)).toBe(lock);
  expect(assertWriteAllowed(`${dataDir}/clones/watched/o/r/.git/objects/ab/cd`, cwd, withGit)).toBe(
    `${dataDir}/clones/watched/o/r/.git/objects/ab/cd`,
  );
  // Without the threading, the same write is refused — the #320 symptom.
  expect(() => assertWriteAllowed(lock, cwd, policy)).toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sandboxPolicy.test.ts`
Expected: FAIL — `linkedWorktreeWritePaths` is not exported (import/TypeError), and the `gitWritePaths` cases fail to typecheck/assert.

- [ ] **Step 3: Implement**

In `src/agent/sandbox/policy.ts`:

Add after `builtinDenyReadPaths`:

```ts
/** The two answers of `git rev-parse --path-format=absolute --git-dir
 *  --git-common-dir`, run in the agent's cwd. */
export interface GitDirs {
  gitDir: string;
  commonDir: string;
}

/** `a` is `b` or lies strictly inside it (path-component-wise: `/x/y-2` is not
 *  under `/x/y`). Local on purpose — pathJail.ts imports this module's types. */
function isWithin(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Extra writable roots a LINKED worktree needs (#320). junco hands the agent
 * `git worktree add`'s output: `<cwd>/.git` is a FILE pointing at
 * `<repo>/.git/worktrees/<name>` (the gitdir — index, HEAD, logs), and every
 * commit writes `<repo>/.git/objects` and `<repo>/.git/refs` (the common dir).
 * None of that is under the cwd, so a cwd-only write policy makes the very
 * first `git commit` fail with "Unable to create '…/index.lock': Operation
 * not permitted" — which is what #320 is. Maintainer's ruling: allow the WHOLE
 * common dir (every git operation works — `config`, `gc`, ref deletion
 * included); the cost, documented in docs/operations.md, is that the owning
 * checkout's `.git/hooks` and `.git/config` become agent-writable too. The
 * gitdir is added separately only when it lies outside the common dir (a
 * `GIT_DIR`-style layout). A standalone repo — common dir inside the cwd — is
 * already writable through the cwd root and adds nothing.
 */
export function linkedWorktreeWritePaths(opts: { cwd: string } & GitDirs): string[] {
  const cwd = canonicalize(opts.cwd);
  const commonDir = canonicalize(opts.commonDir);
  const gitDir = canonicalize(opts.gitDir);
  const roots: string[] = [];
  if (!isWithin(commonDir, cwd)) roots.push(commonDir);
  if (!isWithin(gitDir, commonDir) && !isWithin(gitDir, cwd)) roots.push(gitDir);
  return roots;
}
```

`sep` is already imported from `node:path` in policy.ts (`import { dirname, join, sep } from "node:path";`) — no import change needed.

In `buildPolicy`'s opts type, add after `scratchDir: string;`:

```ts
  /** Extra writable roots for a LINKED worktree's git metadata — the owning
   *  repo's common dir (and, rarely, an out-of-tree gitdir), as computed by
   *  `linkedWorktreeWritePaths`. Threaded in by session.ts's resolveSandbox;
   *  callers that build stand-in policies (doctor, tests) leave it empty. */
  gitWritePaths?: string[];
```

Change the `writableRoots` construction to:

```ts
const writableRoots = [
  canonicalize(cwd),
  canonicalize(scratchDir),
  ...(opts.gitWritePaths ?? []).map(canonicalize),
  ...cfg.extraAllowWrite.map(canonicalize),
];
```

Update the `SandboxPolicy.writableRoots` doc comment to `/** Absolute roots the agent may write under (worktree, scratch, the linked worktree's git common dir (#320), extras). */`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sandboxPolicy.test.ts tests/sandboxPathJail.test.ts tests/sandboxPrecedence.test.ts tests/sandboxBackend.test.ts`
Expected: PASS (all files).

- [ ] **Step 5: Lint, format, typecheck, commit**

```bash
npx prettier --write src/agent/sandbox/policy.ts tests/sandboxPolicy.test.ts
npm run lint
npm run typecheck
git add src/agent/sandbox/policy.ts tests/sandboxPolicy.test.ts
git commit -m "fix(sandbox): linked worktree write roots — add the owning repo's git common dir (#320)"
```

Verify `git log -1 --format=%B` carries no `Co-Authored-By` trailer; amend it away if present.

---

### Task 2: Resolve the gitdirs at session start and thread them into the policy

**Files:**

- Create: `src/agent/sandbox/gitDirs.ts`
- Modify: `src/agent/session.ts` (`ResolveSandboxDeps` ~line 431; `resolveSandbox` body ~lines 449–513: the `buildPolicy` call and the #277 comment above it)
- Test: `tests/sandboxGitDirs.test.ts` (new), `tests/sessionSandboxWiring.test.ts`

**Interfaces:**

- Consumes: Task 1's `linkedWorktreeWritePaths` and `GitDirs` (from `./sandbox/policy.js`), `git(cfg, args, opts)` from `src/git.ts` (`{ cwd, timeoutMs, check: false }` returns `{ code, stdout, stderr }` on non-zero exit; a missing cwd rejects with `GitOpError`).
- Produces:
  - `export async function resolveGitDirs(cfg: { gitBin: string }, cwd: string, gitFn: typeof git = git): Promise<GitDirs | null>` in `src/agent/sandbox/gitDirs.ts`
  - `ResolveSandboxDeps.gitDirs?: (cwd: string) => Promise<GitDirs | null>` (default: `(c) => resolveGitDirs(cfg, c)`)
  - `resolveSandbox` passes `gitWritePaths: dirs ? linkedWorktreeWritePaths({ cwd, ...dirs }) : []` to `buildPolicy`. Task 3's integration harness mirrors this derivation.

- [ ] **Step 1: Write the failing tests**

Create `tests/sandboxGitDirs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveGitDirs } from "../src/agent/sandbox/gitDirs.js";

const cfg = { gitBin: "/sbxroot/bin/git" };

function fakeGit(reply: { code: number; stdout: string } | Error, calls: unknown[][] = []) {
  const fn = async (_c: unknown, args: string[], opts?: { cwd?: string }) => {
    calls.push([args, opts?.cwd]);
    if (reply instanceof Error) throw reply;
    return { code: reply.code, stdout: reply.stdout, stderr: "" };
  };
  return { fn: fn as never, calls };
}

describe("resolveGitDirs (#320)", () => {
  it("parses the two absolute paths git prints, in order", async () => {
    const g = fakeGit({
      code: 0,
      stdout: "/sbxroot/repo/.git/worktrees/tree\n/sbxroot/repo/.git\n",
    });
    const dirs = await resolveGitDirs(cfg, "/sbxroot/work/tree", g.fn);
    expect(dirs).toEqual({
      gitDir: "/sbxroot/repo/.git/worktrees/tree",
      commonDir: "/sbxroot/repo/.git",
    });
    expect(g.calls[0]?.[0]).toEqual([
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ]);
    expect(g.calls[0]?.[1]).toBe("/sbxroot/work/tree"); // run IN the agent's cwd
  });

  it("returns null when git exits non-zero (not a repository)", async () => {
    const g = fakeGit({ code: 128, stdout: "" });
    expect(await resolveGitDirs(cfg, "/sbxroot/plain-dir", g.fn)).toBeNull();
  });

  it("returns null when the spawn itself fails (missing cwd or binary)", async () => {
    const g = fakeGit(new Error("spawn ENOENT"));
    expect(await resolveGitDirs(cfg, "/sbxroot/missing", g.fn)).toBeNull();
  });

  it("returns null on malformed output (fewer than two lines)", async () => {
    const g = fakeGit({ code: 0, stdout: "/sbxroot/repo/.git\n" });
    expect(await resolveGitDirs(cfg, "/sbxroot/work/tree", g.fn)).toBeNull();
  });
});
```

In `tests/sessionSandboxWiring.test.ts`:

1. Add `import { assertWriteAllowed } from "../src/agent/sandbox/pathJail.js";` next to the other imports.
2. Make the shared fixture hermetic — add `gitDirs: async () => null,` to `okDeps` (otherwise the new default would spawn real `git` in the synthetic `/sbxroot/work` cwd).
3. Add, after the `it("denies the data root wholesale …")` case:

```ts
// #320: a LINKED worktree's git metadata lives under the owning repo's
// .git, not under the cwd. resolveSandbox must ask git where that is and
// thread the answer into the writable roots — or the very first
// `git commit` fails with "Unable to create '…/index.lock'".
it("threads the linked worktree's git common dir into the writable roots (#320)", async () => {
  const cwd = "/sbxroot/state/worktrees/tkt-1";
  const r = await resolveSandbox(cfgWith({ backend: "none" }), cwd, undefined, {
    ...okDeps,
    gitDirs: async (c) => {
      expect(c).toBe(cwd);
      return {
        gitDir: "/sbxroot/state/clones/watched/o__r.git/worktrees/tkt-1",
        commonDir: "/sbxroot/state/clones/watched/o__r.git",
      };
    },
  });
  const policy = r?.policy;
  if (!policy) throw new Error("expected a sandbox policy");
  expect(policy.writableRoots).toContain("/sbxroot/state/clones/watched/o__r.git");
  const lock = "/sbxroot/state/clones/watched/o__r.git/worktrees/tkt-1/index.lock";
  expect(assertWriteAllowed(lock, cwd, policy)).toBe(lock);
  // The clones tier sits inside the wholesale-denied data root; the writable
  // root out-specifies that deny for reads too.
  expect(resolveRead(lock, readRules(policy))).toBe("allow");
});

it("adds no git roots when the cwd is not a git checkout (#320)", async () => {
  const r = await resolveSandbox(cfgWith({ backend: "none" }), "/sbxroot/work", undefined, {
    ...okDeps,
    gitDirs: async () => null,
  });
  expect(r?.policy.writableRoots).toEqual(["/sbxroot/work", "/sbxroot/scratch"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sandboxGitDirs.test.ts tests/sessionSandboxWiring.test.ts`
Expected: FAIL — `../src/agent/sandbox/gitDirs.js` does not exist; the wiring test's `gitDirs` dep is rejected by the type / the policy lacks the root.

- [ ] **Step 3: Implement**

Create `src/agent/sandbox/gitDirs.ts`:

```ts
/**
 * Where a checkout keeps its git metadata (#320). junco runs the agent in a
 * LINKED worktree, so the index/HEAD/logs live in `<repo>/.git/worktrees/<name>`
 * and objects/refs in `<repo>/.git` — neither under the cwd the sandbox makes
 * writable. resolveSandbox asks git once, at session start, and threads the
 * answer through `linkedWorktreeWritePaths` into the policy.
 *
 * Best-effort by design: a cwd that is not a git checkout (Q&A `workdir:`
 * tickets can point anywhere), a missing binary, or malformed output all
 * resolve to null — the session then runs with the cwd-only write policy it
 * had before #320, never fails to start.
 */
import { git } from "../../git.js";
import { log } from "../../logging.js";
import type { GitDirs } from "./policy.js";

const REV_PARSE_TIMEOUT_MS = 10_000;

export async function resolveGitDirs(
  cfg: { gitBin: string },
  cwd: string,
  gitFn: typeof git = git,
): Promise<GitDirs | null> {
  try {
    const r = await gitFn(
      cfg,
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      {
        cwd,
        timeoutMs: REV_PARSE_TIMEOUT_MS,
        check: false,
      },
    );
    if (r.code !== 0) return null;
    const [gitDir, commonDir] = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (!gitDir || !commonDir) return null;
    return { gitDir, commonDir };
  } catch (e) {
    log.debug("sandbox: could not resolve git dirs; cwd-only write policy", {
      cwd,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
```

(`log.debug` exists — `src/logging.ts` defines the `debug` level and `git.ts`'s `runCmd` already uses it.)

In `src/agent/session.ts`:

1. Extend the policy import: `import { buildPolicy, linkedWorktreeWritePaths, type GitDirs, type SandboxPolicy } from "./sandbox/policy.js";` and add `import { resolveGitDirs } from "./sandbox/gitDirs.js";`.
2. Add to `ResolveSandboxDeps`:

```ts
  /** Where the cwd's git metadata lives (#320) — default asks `git rev-parse`
   *  in the cwd via resolveGitDirs; tests inject the answer (or null). */
  gitDirs?: (cwd: string) => Promise<GitDirs | null>;
```

3. In `resolveSandbox`, right before `const dataPaths = sandboxDenyPaths(cfg);`, add:

```ts
// #320: a linked worktree's index/objects/refs live under the owning repo's
// .git, outside the cwd — without these roots the agent's first `git commit`
// dies with "Unable to create '…/index.lock': Operation not permitted".
const gitDirs = await (deps.gitDirs ?? ((c: string) => resolveGitDirs(cfg, c)))(cwd);
const gitWritePaths = gitDirs ? linkedWorktreeWritePaths({ cwd, ...gitDirs }) : [];
```

4. Pass `gitWritePaths,` into the `buildPolicy({ … })` call (after `scratchDir,`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sandboxGitDirs.test.ts tests/sessionSandboxWiring.test.ts tests/session.test.ts tests/sdkImportSurface.test.ts`
Expected: PASS. (`sdkImportSurface.test.ts` guards session.ts's import surface — it must stay green.)

- [ ] **Step 5: Lint, format, typecheck, commit**

```bash
npx prettier --write src/agent/sandbox/gitDirs.ts src/agent/session.ts tests/sandboxGitDirs.test.ts tests/sessionSandboxWiring.test.ts
npm run lint
npm run typecheck
git add src/agent/sandbox/gitDirs.ts src/agent/session.ts tests/sandboxGitDirs.test.ts tests/sessionSandboxWiring.test.ts
git commit -m "fix(sandbox): resolve the linked worktree's git dirs at session start and make them writable (#320)"
```

Verify no attribution trailer; amend it away if present.

---

### Task 3: Integration test — a real `git commit` inside the sandboxed linked worktree

**Files:**

- Modify: `tests/sandbox.integration.test.ts` (`shippedTree` ~line 241–311: derive `gitWritePaths` through the production helpers; new cases inside `describe.each(["v2", "flat"])` after `it("git still reports the worktree's real content, …")`)

**Interfaces:**

- Consumes: Task 1's `linkedWorktreeWritePaths`, Task 2's `resolveGitDirs` (with the real `git` — this file is the one place real processes are allowed), `runShipped(command, t)`, `gitRun(args, cwd?)`, `requireBackend(ctx)`.
- Produces: nothing code-facing.

- [ ] **Step 1: Write the failing test**

In `shippedTree`, the policy is built with `buildPolicy({ cfg: cfg.sandbox, cwd: worktree, … })`. Change the function to `async function shippedTree(layout: "v2" | "flat"): Promise<ShippedTree>` and, just before the `buildPolicy` call, derive the git roots exactly as production does:

```ts
// #320: the same derivation resolveSandbox performs — real git, real linked
// worktree, so the writable roots under test are the ones a ticket gets.
const gitDirs = await resolveGitDirs(cfg, worktree);
if (!gitDirs) throw new Error("harness: resolveGitDirs returned null for a real linked worktree");
const gitWritePaths = linkedWorktreeWritePaths({ cwd: worktree, ...gitDirs });
```

and pass `gitWritePaths,` into that `buildPolicy` call. Update the imports: `linkedWorktreeWritePaths` from `../src/agent/sandbox/policy.js`, `resolveGitDirs` from `../src/agent/sandbox/gitDirs.js`. Every existing `const t = shippedTree(layout);` becomes `const t = await shippedTree(layout);` (the enclosing `it` callbacks are already `async`).

Then add, after `it("git still reports the worktree's real content, not an empty mask", …)`:

```ts
it("the agent can commit inside its linked worktree (#320)", async (ctx) => {
  requireBackend(ctx);
  const t = await shippedTree(layout);
  const before = gitRun(["git", "-C", t.worktree, "rev-parse", "HEAD"]).trim();
  // A real add + commit. Identity via -c so no global config is consulted;
  // the worktree is detached, so this exercises gitdir/HEAD + objects.
  const out = await runShipped(
    [
      `printf 'hello\\n' > added.txt`,
      `git add added.txt >/dev/null 2>&1; echo "add=$?"`,
      `git -c user.name=t -c user.email=t@example.invalid commit -q -m "c1" >/dev/null 2>&1; echo "commit=$?"`,
      `git checkout -q -b junco/tkt-1 >/dev/null 2>&1; echo "branch=$?"`,
      `printf 'more\\n' >> added.txt; git -c user.name=t -c user.email=t@example.invalid commit -q -am "c2" >/dev/null 2>&1; echo "commit2=$?"`,
    ].join("; "),
    t,
  );
  expect(out).toContain("add=0");
  expect(out).toContain("commit=0");
  expect(out).toContain("branch=0");
  expect(out).toContain("commit2=0");
  // The commits are real: HEAD moved, and the branch ref landed in the
  // owning repo's refs (outside the cwd — the whole point of #320).
  const after = gitRun(["git", "-C", t.worktree, "rev-parse", "HEAD"]).trim();
  expect(after).not.toBe(before);
  const ref = gitRun(["git", "-C", t.worktree, "rev-parse", "refs/heads/junco/tkt-1"]).trim();
  expect(ref).toBe(after);
});
```

- [ ] **Step 2: Run the test to verify it fails on the OLD policy**

Temporarily verify the test is load-bearing: run it with `gitWritePaths` NOT passed to `buildPolicy` in the harness (comment out that one line), `npx vitest run tests/sandbox.integration.test.ts -t "can commit"` → Expected: FAIL with `commit=128` / `add=128` in the output (the #320 symptom). Restore the line before continuing. Note in your report that you saw the failure.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run tests/sandbox.integration.test.ts`
Expected: PASS on this macOS host (Seatbelt available). If the host reports the backend unavailable, every case SKIPS with a named reason — say so in your report; the unit tests from Tasks 1–2 still cover the derivation.

- [ ] **Step 4: Lint, format, commit**

```bash
npx prettier --write tests/sandbox.integration.test.ts
npm run lint
npm run typecheck
git add tests/sandbox.integration.test.ts
git commit -m "test(sandbox): a real git commit inside the sandboxed linked worktree (#320)"
```

Verify no attribution trailer.

---

### Task 4: Docs and changelog

**Files:**

- Modify: `docs/operations.md` (the `**1. Native execution sandbox (\`sandbox\`).\*\*` paragraph, ~line 136)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Fixed`, insert as the FIRST bullet, before the existing `**Sandbox (macOS): the agent's \`git\` could not run at all.\*\*` bullet)
- Modify: `ARCHITECTURE.md` (the `agent/sandbox/` module-map row, ~line 246)

- [ ] **Step 1: docs/operations.md**

In that paragraph replace `Writes are restricted to the worktree,` with:

```
Writes are restricted to the worktree plus the owning repo's `.git` (junco hands the agent a _linked_ worktree, so its index, objects and refs live under `<repo>/.git`, not under the cwd — without that root the first `git commit` fails; note this makes the owning checkout's `.git/hooks` and `.git/config` agent-writable, so keep `botAccount` on and review PRs before merging),
```

- [ ] **Step 2: CHANGELOG.md**

Insert as the first bullet under `### Fixed` in `[Unreleased]`:

```
- **Sandbox: the agent could not `git commit`.** junco runs the agent in a _linked_ worktree, whose index/HEAD live in `<repo>/.git/worktrees/<name>` and whose commits write `<repo>/.git/objects` and `refs` — none of it under the cwd, which was the only writable root besides scratch. The first commit died with `fatal: Unable to create '<repo>/.git/worktrees/<name>/index.lock': Operation not permitted`, and an agent that went looking for a writable path could burn the whole ticket timeout on it (#320). `resolveSandbox` now asks `git rev-parse --git-dir --git-common-dir` in the cwd at session start and adds the owning repo's whole `.git` (and an out-of-tree gitdir, if any) to the writable roots; a standalone clone adds nothing. Trade-off, deliberate: the owning checkout's `.git/hooks` and `.git/config` are agent-writable (see docs/operations.md). The integration suite now commits for real inside the sandboxed worktree on both backends.
```

- [ ] **Step 3: ARCHITECTURE.md**

In the `agent/sandbox/` row, the `policy.ts` description ends with the exact text `and bwrap needs no equivalent because a \`--tmpfs\` mask leaves the directory node stattable)`. Immediately after that closing parenthesis (before the following `, \`bashOps.ts\`/\`fsOps.ts\``), insert: `; \`linkedWorktreeWritePaths\` + \`gitDirs.ts\`'s \`resolveGitDirs\` add the owning repo's \`.git\` (git-common-dir) to the writable roots at session start, since a linked worktree's index, objects and refs live there, not under the cwd (#320)`.

- [ ] **Step 4: Format, verify, commit**

```bash
npx prettier --write docs/operations.md CHANGELOG.md ARCHITECTURE.md
npx prettier --check docs/operations.md CHANGELOG.md ARCHITECTURE.md
git add docs/operations.md CHANGELOG.md ARCHITECTURE.md
git commit -m "docs: sandbox writes include the linked worktree's git common dir (#320)"
```

Verify no attribution trailer.

---

### Task 5: Full gate

- [ ] **Step 1: Run the whole gate and capture exit codes**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/junco-gate-320.out 2>&1; echo "vitest exit: $?"; tail -6 /tmp/junco-gate-320.out
```

Expected: every command exits 0; vitest summary all passed (the integration file may report skips only on a host without an OS backend).

- [ ] **Step 2: Confirm no AI attribution on the branch**

```bash
git log origin/main..HEAD --format=%B
```

Expected: plain conventional one-liners only.
