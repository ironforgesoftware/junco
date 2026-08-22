# Sandbox allow-over-deny precedence (WS-8, #277) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #277 — give the three sandbox backends allow-overrides-deny precedence, then deny `~/.junco` wholesale and allow `cache/` back, replacing the hand-maintained subtree enumeration.

**Architecture:** One shared resolver (`precedence.ts`) computes read permission by **longest-prefix-wins** over an ordered rule list. The three backends become thin emitters of that one ordering: Seatbelt's SBPL and bwrap's mount list are both **last-match-wins**, so both emit shortest-prefix-first; path-jail consumes the resolver directly. Writable roots participate as allow rules at their natural depth, which is what turns the current hand-maintained convention into a mechanical guarantee.

**Tech Stack:** TypeScript strict/ESM, vitest. Sandbox unit tests use synthetic non-existent paths (`/sbxroot/...`) so `canonicalize()` is a no-op; `sandbox.integration.test.ts` exercises real Seatbelt/bwrap and skips when the backend binary is absent.

**Spec:** GitHub issue #277 (follow-up to PR #272).

## Global Constraints

- Node ≥22.19, TypeScript strict/ESM/NodeNext. Every side effect behind an injectable `*Deps` seam.
- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. **Capture the vitest exit code explicitly** — never pipe into `grep`/`tail` as the last stage: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`. `npm test` does NOT type-check; always run `npm run typecheck` too.
- Sandbox unit tests MUST use synthetic non-existent paths (`/sbxroot/...`). `canonicalize()` realpaths real paths, so `/tmp` and `/var` collapse to `/private/...` on macOS and assertions drift.
- Conventional commits, suite green at every commit, **no AI-attribution trailers**.
- **Release HOLD:** no version bump, no tag, no publish.
- Branch `feat/sandbox-allow-over-deny` off `main`.

## Threat model this plan is accountable to

The change must not, on any platform, leave readable: `~/.junco/config.json` (may hold `model.apiKey`), `cache/mirror`, `cache/github-cache`, `transcripts/`, the queue, or the outbox. It must keep readable: the agent's own worktree and the clone gitdirs its git reads. **A bug here reads as strictly-more-restrictive in review while actually widening access** — that is the failure mode every task below is designed to catch.

---

### Task 1: The precedence resolver

**Files:**

- Create: `src/agent/sandbox/precedence.ts`
- Test: `tests/sandboxPrecedence.test.ts`

**Interfaces — Produces:**

```ts
export type RuleEffect = "allow" | "deny";
export interface ReadRule {
  /** Absolute, already-canonicalized path. */
  path: string;
  effect: RuleEffect;
  /** "subtree" = path and everything under it; "file" = this exact path. */
  kind: "subtree" | "file";
}
/** Ascending specificity: least specific first. Backends that are
 *  last-match-wins emit in exactly this order. Stable. */
export function orderRules(rules: ReadRule[]): ReadRule[];
/** Effect for an absolute path. No matching rule => "allow". */
export function resolveRead(abs: string, rules: ReadRule[]): RuleEffect;
```

**Why longest-prefix and not "any allow beats any deny":** the real rule set is three levels deep — deny `~/.junco`, allow `~/.junco/cache`, deny `~/.junco/cache/mirror`. A flat "allow wins" makes `mirror/` readable again. This is the single most dangerous way to get #277 wrong, so it is Task 1 and it is tested before anything consumes it.

**Specificity order (most specific last):** compare path segment depth ascending; deeper wins. Tie on depth → `kind: "file"` beats `"subtree"` (a literal is narrower than a subtree at the same path). Tie on both → `deny` beats `allow` (fail safe). Ties are otherwise stable in input order.

Use path-boundary matching, never raw `startsWith`: `/a/bc` must NOT match under `/a/b`. Reuse the `abs === r || abs.startsWith(r + sep)` shape already in `pathJail.ts:23-26`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { orderRules, resolveRead, type ReadRule } from "../src/agent/sandbox/precedence.js";

const sub = (path: string, effect: "allow" | "deny"): ReadRule => ({ path, effect, kind: "subtree" });
const file = (path: string, effect: "allow" | "deny"): ReadRule => ({ path, effect, kind: "file" });

// The real #277 shape, three levels deep.
const JUNCO: ReadRule[] = [
  sub("/sbxroot/.junco", "deny"),
  sub("/sbxroot/.junco/cache", "allow"),
  sub("/sbxroot/.junco/cache/mirror", "deny"),
  sub("/sbxroot/.junco/cache/github-cache", "deny"),
];

describe("resolveRead", () => {
  it("allows a path no rule covers", () => {
    expect(resolveRead("/sbxroot/elsewhere", JUNCO)).toBe("allow");
  });

  it("denies the wholesale root", () => {
    expect(resolveRead("/sbxroot/.junco/config.json", JUNCO)).toBe("deny");
  });

  it("allows a subtree that overrides the root deny", () => {
    expect(resolveRead("/sbxroot/.junco/cache/worktrees/t1", JUNCO)).toBe("allow");
  });

  // THE regression this whole task exists to prevent.
  it("re-denies a subtree nested inside an allow-back (longest prefix wins)", () => {
    expect(resolveRead("/sbxroot/.junco/cache/mirror/repo.git", JUNCO)).toBe("deny");
    expect(resolveRead("/sbxroot/.junco/cache/github-cache/x.json", JUNCO)).toBe("deny");
  });

  it("matches on path boundaries, not string prefixes", () => {
    // /sbxroot/.junco-backup must not be caught by the /sbxroot/.junco deny.
    expect(resolveRead("/sbxroot/.junco-backup/f", JUNCO)).toBe("allow");
    // ...and the allow for cache must not leak to cache-extra.
    expect(resolveRead("/sbxroot/.junco/cache-extra/f", JUNCO)).toBe("deny");
  });

  it("applies an exact-file rule over a subtree rule at the same path", () => {
    const rules = [sub("/sbxroot/d", "allow"), file("/sbxroot/d", "deny")];
    expect(resolveRead("/sbxroot/d", rules)).toBe("deny");
    // the file rule is exact: descendants still follow the subtree rule
    expect(resolveRead("/sbxroot/d/child", rules)).toBe("allow");
  });

  it("prefers deny when an allow and a deny tie exactly", () => {
    expect(resolveRead("/sbxroot/d/f", [sub("/sbxroot/d", "allow"), sub("/sbxroot/d", "deny")])).toBe("deny");
  });

  it("is independent of input order", () => {
    const shuffled = [JUNCO[2], JUNCO[0], JUNCO[3], JUNCO[1]];
    expect(resolveRead("/sbxroot/.junco/cache/mirror/r", shuffled)).toBe("deny");
    expect(resolveRead("/sbxroot/.junco/cache/worktrees/t", shuffled)).toBe("allow");
  });
});

describe("orderRules", () => {
  it("emits least-specific first so last-match-wins backends agree", () => {
    const out = orderRules([JUNCO[2], JUNCO[0], JUNCO[1]]).map((r) => r.path);
    expect(out).toEqual([
      "/sbxroot/.junco",
      "/sbxroot/.junco/cache",
      "/sbxroot/.junco/cache/mirror",
    ]);
  });

  it("agrees with resolveRead for every rule path in the set", () => {
    // Cross-check: emitting in orderRules order and taking the LAST match
    // must give the same answer as resolveRead's longest-prefix search.
    const probes = [
      "/sbxroot/.junco/config.json",
      "/sbxroot/.junco/cache/worktrees/t1",
      "/sbxroot/.junco/cache/mirror/r.git",
      "/sbxroot/nowhere",
    ];
    const ordered = orderRules(JUNCO);
    for (const p of probes) {
      const lastMatch = [...ordered].reverse().find((r) =>
        r.kind === "file" ? p === r.path : p === r.path || p.startsWith(r.path + "/"),
      );
      expect(lastMatch?.effect ?? "allow").toBe(resolveRead(p, JUNCO));
    }
  });
});
```

That last test is the load-bearing one: it pins that the ordering the OS backends rely on and the resolver path-jail uses can never disagree.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/sandboxPrecedence.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `precedence.ts`.**
- [ ] **Step 4: Verify green, run `npm run typecheck`, commit** — `feat(sandbox): longest-prefix-wins read precedence resolver`.

---

### Task 2: `buildPolicy` grows an allow list

**Files:**

- Modify: `src/agent/sandbox/policy.ts`
- Test: `tests/sandboxPolicy.test.ts`

**Interfaces — Consumes** Task 1's `ReadRule`. **Produces:**

```ts
export interface SandboxPolicy {
  writableRoots: string[];
  readDenyPaths: string[];
  readDenyFiles: string[];
  /** NEW: absolute subtrees that override a broader deny (e.g. cache/ inside
   *  a denied ~/.junco). Precedence is by specificity, not list order. */
  readAllowPaths: string[];
  network: boolean;
  scratchDir: string;
}
/** NEW: the policy's read rules as one ordered list — the single source both
 *  the OS profiles and the JS jail are generated from. */
export function readRules(policy: SandboxPolicy): ReadRule[];
```

`readRules` composes, in this order (order is irrelevant — `orderRules` sorts): `readDenyPaths` as deny/subtree, `readDenyFiles` as deny/file, `readAllowPaths` as allow/subtree, **and `writableRoots` as allow/subtree**.

**Why writable roots become allow rules:** a root the agent may write but not read is incoherent, and this is what makes #277 safe. Today "never deny an ancestor of a writable root" is a hand-maintained convention with **no runtime check** — `buildPolicy` validates nothing, and the rule is held up only by negative test assertions. Once writable roots are allow rules at their own depth, denying `~/.junco` wholesale is automatically correct: the worktree under `cache/worktrees` out-specifies the root deny. The convention stops being something a future maintainer can silently violate.

**Deliberately NOT an unconditional override:** a deny *deeper* than a writable root still wins, so an operator can `extra_deny_read` a `.env` inside the worktree. That is a real use case and it must keep working — Step 1 pins it.

- [ ] **Step 1: Write the failing tests** — add to `tests/sandboxPolicy.test.ts`:

```ts
it("exposes writable roots as read-allow rules so a denied ancestor cannot wall the agent out", () => {
  const p = buildPolicy({ /* …existing fixture shape… */ });
  // worktree lives under a denied data root; it must still resolve readable
  expect(resolveRead(p.writableRoots[0], readRules(p))).toBe("allow");
});

it("lets an operator deny a path INSIDE a writable root", () => {
  const p = buildPolicy({ /* cwd: "/sbxroot/wt", extraDenyRead: ["/sbxroot/wt/.env"] */ });
  expect(resolveRead("/sbxroot/wt/src/a.ts", readRules(p))).toBe("allow");
  expect(resolveRead("/sbxroot/wt/.env", readRules(p))).toBe("deny");
});

it("canonicalizes allow paths the same way as deny paths", () => {
  // both sides must go through canonicalize() or precedence compares apples to oranges
});
```

The reviewer must confirm the existing `tests/sandboxPolicy.test.ts` assertions that encode the *old* convention (around `:57-58`, `:95-148`) are **retargeted, not deleted** — each one that asserted "a deny is never an ancestor of a writable root" becomes "an ancestor deny is correctly overridden".

- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Verify green + typecheck + commit** — `feat(sandbox): readAllowPaths and a single readRules source`.

---

### Task 3: path-jail consumes the resolver

**Files:**

- Modify: `src/agent/sandbox/pathJail.ts`
- Test: `tests/sandboxPathJail.test.ts` (or wherever `assertReadAllowed` is covered)

`assertReadAllowed` currently does `isUnderAnyDeny(abs, readDenyPaths) || isUnderAnyDeny(abs, readDenyFiles)` (`pathJail.ts:50`) — a flat `.some()` with no precedence. Replace with `resolveRead(abs, readRules(policy)) === "deny"`.

**This is the only layer with platform-independent coverage** — it runs on every platform for all filesystem tools, including where the OS backend degraded to `none`. Keep `isUnderAnyDeny` exported only if something else uses it; otherwise delete it with its tests rather than leaving a second, now-wrong notion of denial in the module.

- [ ] Steps 1-4 as above. Tests must include the three-deep `~/.junco` shape end-to-end through `assertReadAllowed`, and must prove `assertWriteAllowed` is unchanged. Commit: `fix(sandbox): path-jail honours allow-over-deny precedence`.

---

### Task 4: Seatbelt emits in precedence order

**Files:**

- Modify: `src/agent/sandbox/backend.ts` (`seatbeltProfile`)
- Test: `tests/sandboxBackend.test.ts`

SBPL is **last-match-wins**, and the current profile already depends on that: a broad `(allow file-read*)` at `:42` is beaten by later `(deny … subpath)` lines at `:44`. So the change is emission *order*, not mechanism: emit `orderRules(readRules(policy))` after the broad allow, mapping allow/subtree → `(allow file-read* (subpath …))`, deny/subtree → `(deny file-read* (subpath …))`, deny/file → `(deny file-read* (literal …))`.

- [ ] **Step 1: Write the failing tests.** **Every existing Seatbelt assertion is `expect(p).toContain(...)` — order-blind by construction, so it cannot catch this class of bug at all.** New tests MUST assert relative order with `indexOf`:

```ts
it("emits the cache allow AFTER the junco deny and BEFORE the mirror deny", () => {
  const p = seatbeltProfile(policy);
  const denyRoot = p.indexOf(`(deny file-read* (subpath "/sbxroot/.junco"))`);
  const allowCache = p.indexOf(`(allow file-read* (subpath "/sbxroot/.junco/cache"))`);
  const denyMirror = p.indexOf(`(deny file-read* (subpath "/sbxroot/.junco/cache/mirror"))`);
  expect(denyRoot).toBeGreaterThanOrEqual(0);
  expect(allowCache).toBeGreaterThan(denyRoot);
  expect(denyMirror).toBeGreaterThan(allowCache);
});
```

- [ ] Steps 2-4. Commit: `fix(sandbox): seatbelt profile emits read rules in precedence order`.

---

### Task 5: bwrap mount order inverted

**Files:**

- Modify: `src/agent/sandbox/backend.ts` (`bwrapArgs` + its doc comment)
- Test: `tests/sandboxBackend.test.ts`

**This is the structurally riskiest task.** bwrap mounts apply in argv order and later mounts are *destructive*. Today writable binds come first and denies after (`:83-91`), with a doc comment (`:74-77`) explicitly stating the deny list must never contain an ancestor of a writable root because "a later tmpfs over an ancestor would shadow the bind entirely". #277 inverts exactly that, so the order must invert too:

1. `--ro-bind / /`, `--dev`, `--proc`, `--tmpfs /tmp` (unchanged)
2. deny mounts for the least-specific rules
3. allow-back binds
4. nested deny mounts
5. writable `--bind`s **last**, so nothing can shadow them

i.e. emit in `orderRules` order, with writable roots last.

**Move the `existsFn` guard.** It currently guards *denies* (`:85`, `:90`) because bwrap cannot create a mountpoint under the read-only root bind. After inversion, a deny is a tmpfs over a path that may now sit inside another tmpfs — and the thing that needs the guard is the **allow-back source**, which must exist to be bind-mounted. Re-derive which mounts need the guard from the new order; do not copy the old placement.

Rewrite the `:66-77` doc comment: it currently documents the exact invariant this task removes. Leaving it would be a comment that actively misleads.

- [ ] **Step 1: Write the failing tests** — argv-order assertions by index, same `indexOf` discipline as Task 4, plus: writable-root binds appear after every deny mount; a deny nested inside an allow-back appears after that allow-back.
- [ ] Steps 2-4. Commit: `fix(sandbox): bwrap mount order supports allow-over-deny`.

---

### Task 6: Real-execution coverage for bwrap (and the CI gap)

**Files:**

- Modify: `tests/sandbox.integration.test.ts`
- Modify: `.github/workflows/quality-gate.yml`

**The gap this task closes:** `sandbox.integration.test.ts` gates on `backend.isAvailable` and each test silently `return`s when the backend is absent. The workflow installs **no bubblewrap** — so bwrap's real enforcement is exercised nowhere in CI, and bwrap is the backend changing most structurally. macOS/Seatbelt does run for real, so Seatbelt's inversion is genuinely covered; bwrap's is not.

**Ruling: add bubblewrap to the Linux CI job.** `sudo apt-get install -y bubblewrap` on the ubuntu leg. Shipping a rewrite of the mount ordering with zero real-execution coverage on the platform it targets is not acceptable for a change whose failure mode is silent over-permission. If the install proves unavailable on the runner image, say so explicitly in the report rather than quietly leaving the leg skipped — that outcome is a finding, not a detail.

- [ ] **Step 1:** Add integration cases that assert, under a REAL backend, with a real temp `~/.junco`-shaped tree: `config.json` unreadable; `cache/mirror/**` unreadable; `cache/worktrees/<wt>/**` readable AND writable; a file written into the worktree survives.
- [ ] **Step 2:** Make the skip **loud** — when a test skips, it must report which backend was unavailable, so a silently-green CI leg is distinguishable from a genuinely-passing one.
- [ ] **Step 3:** Add the bubblewrap install to the workflow; confirm the ubuntu leg actually runs these tests rather than skipping.
- [ ] **Step 4:** Commit — `test(sandbox): real-execution allow-over-deny coverage; install bwrap in CI`.

---

### Task 7: Arm it — deny `~/.junco` wholesale

**Files:**

- Modify: `src/dataTree.ts` (`sandboxDenyPaths` + its doc comment)
- Test: `tests/dataTree.test.ts`

**Do this LAST.** Tasks 1-6 build and prove the machinery; this task is what actually changes what the agent can read. Splitting it out means a bisect lands on one commit, and a revert is one commit.

Replace the enumerated subtree list with: deny the data root; allow back `cache/` (v2) — the worktrees and clone gitdirs live there; re-deny `cache/mirror` and `cache/github-cache`. Keep `queueRoot` denied as-is (a legacy vaultRoot queue lives outside the root). Handle **both** layouts (`flat` and `v2`) — they differ in where `cache/` sits.

Keep the `skills` exemption and its reasoning: it is a symlink to the installed package's `skills/` dir, so `canonicalize()` would resolve a deny onto the junco installation and protect public packaged content while missing the real target. Under a wholesale root deny this needs re-examining — state explicitly in the report whether `skills` now resolves denied or allowed, and whether that is correct.

- [ ] **Step 1: Write the failing tests.** `tests/dataTree.test.ts` has a drift guard ("classifies every data-tree entry as denied or deliberately exempt") that today asserts the root is NOT denied. **Retarget it, do not delete it** — it becomes: every entry resolves to the correct effect *through `resolveRead`*, for both layouts. That test is the reason this change is safe to make at all; deleting it would remove the only thing standing between a future refactor and a silently-readable queue.
- [ ] **Step 2-3:** Verify fail, implement.
- [ ] **Step 4: Prove it end-to-end.** Build a full synthetic tree for both layouts and assert through `resolveRead(readRules(buildPolicy(...)))`: `config.json` deny; `mirror`, `github-cache`, `transcripts`, queue, outbox deny; worktree and clone gitdirs allow.
- [ ] **Step 5:** Full gate, then commit — `feat(sandbox): deny the junco data root wholesale, allowing cache/ back (#277)`.

---

## Final verification (before the branch is done)

- [ ] Full gate, five exit codes captured separately.
- [ ] A sandboxed smoke test with `HOME`/`XDG_CONFIG_HOME` overrides per CLAUDE.md — never against the live config.
- [ ] `CHANGELOG.md` entry under Unreleased. No version bump.
- [ ] Confirm on the real platform available here (macOS/Seatbelt) that the profile denies `~/.junco/config.json` and allows the worktree, by actually running `sandbox-exec`, not by reading the profile string.
