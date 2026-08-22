# Sandbox deny-list gap: plan-set records (WS-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the live sandbox gap where `<dataDir>/data/plans` (plan-set records) is readable by the sandboxed agent, and add a drift guard so the next data-tree addition cannot silently repeat it.

**Architecture:** `sandboxDenyPaths(cfg, env)` in `src/dataTree.ts` enumerates the daemon-owned subtrees the agent sandbox must not read; `agent/session.ts` threads it into `buildPolicy`. The enumeration is hand-maintained (it cannot deny the `~/.junco` root — that would wall the agent out of its own worktree; see issue #277 for the eventual allow-over-deny redesign). Commit `7bda147` added `plans/` to the data tree but not to this list. This plan adds the missing denies and converts "remember to update the list" from a human obligation into a failing test.

**Tech Stack:** TypeScript strict/ESM, vitest. `tests/dataTree.test.ts` is a pure, zero-fs suite using synthetic `/sbxroot/...` paths so `canonicalize()` is a no-op (CLAUDE.md sandbox testing rule).

**Spec:** WS-1 — the open-issues roadmap's workstream to close the plan-set deny-list gap and add a drift guard against future omissions — and issue #277 ("Sandbox: allow-over-deny support so ~/.junco can be denied wholesale") for the CRITICAL invariant this must not violate and the eventual allow-over-deny redesign.

## Global Constraints

- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Capture vitest exit explicitly: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — never pipe into `grep`/`tail` (the pipeline reports the filter's status).
- **CRITICAL invariant — never deny an ancestor of the agent's writable roots** (`src/agent/sandbox/backend.ts:66-77`): not the `dataDir` root, not `cache/` itself. The agent's cwd (`cache/worktrees/<ticket>`) and git object reads (`cache/clones/*`) live under them.
- New `Config` fields go in `tests/helpers/config.ts` and nowhere else. (This plan adds none.)
- Synthetic non-existent `/sbxroot/...` paths only in these unit tests — real `/tmp` and `/var` realpath to `/private/...` on macOS and would break assertions.
- Conventional commits (`fix:` / `test:` / `docs:`), suite green at every commit, no AI attribution trailers.
- Branch `fix/sandbox-deny-plans`, already created off `main` @ `d78c0bd`. Baseline verified green: 208 files / 3519 tests.

---

### Task 1: Deny the plan-set records dir and the migrate lock

**Files:**

- Modify: `src/dataTree.ts:209-243` (`sandboxDenyPaths`) and its doc comment at `:181-208`
- Test: `tests/dataTree.test.ts:137-214` (`describe("sandboxDenyPaths")`)

**Interfaces:**

- Consumes: `dataTreePaths(cfg): DataTreePaths` (`src/dataTree.ts:106`) — fields `plans` (`:167`) and `migrateLockFile` (`:175`), already present in both layouts (`LAYOUTS.flat.plans = "plans"`, `LAYOUTS.v2.plans = "data/plans"`).
- Produces: no signature change. `sandboxDenyPaths(cfg, env)` keeps returning `{ dirs: string[]; files: string[] }`; `dirs` gains `p.plans`, `files` gains `p.migrateLockFile`.

**Why these two:** `plans/` holds `PlanSetRecord` JSON (`src/planSets.ts:19-46`) — `repoPath`, the GitHub nwo/issue number, task ids, `statusCommentId`. That is daemon-owned control-plane state of exactly the kind already denied (`outbox`, `history`, `assess-history`, `transcripts`). `migrate.lock` is the sibling of `migrated.json`, which is already denied at `:238`; denying it is free and consistent. Neither is an ancestor of any writable root under either layout.

- [ ] **Step 1: Write the failing assertions**

In `tests/dataTree.test.ts`, add to the flat-layout test (currently `:138-165`, after the `github-cache` line at `:153`):

```ts
expect(deny.dirs).toContain("/sbxroot/data/plans");
```

and after the `migrated.json` line at `:158`:

```ts
expect(deny.files).toContain("/sbxroot/data/migrate.lock");
```

Then add to the v2 test's `arrayContaining` block (currently `:190-200`), after the `data/transcripts` entry:

```ts
        "/sbxroot/home/.junco/data/plans",
```

and after the `config.json` assertion at `:201`:

```ts
expect(deny.files).toContain("/sbxroot/home/.junco/migrate.lock");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dataTree.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t1.txt`

Expected: FAIL — two tests failing, reporting that the deny arrays do not contain `/sbxroot/data/plans` / `/sbxroot/home/.junco/data/plans` (and the two `migrate.lock` paths).

- [ ] **Step 3: Add the denies**

In `src/dataTree.ts`, inside `sandboxDenyPaths`'s `dirs` array, add after the `p.transcripts` entry (`:222`):

```ts
      // Plan-set records (control-plane state: repoPath, issue nwo/number,
      // task ids, statusCommentId). Added to the data tree by the plan-sets
      // work; it was missing from this list until 2026-08-21 — the drift this
      // enumeration is prone to, and the reason for the classification test in
      // tests/dataTree.test.ts. Never an ancestor of a writable root: `plans`
      // is `plans/` (flat) / `data/plans` (v2), and nothing writable is nested
      // under either.
      p.plans,
```

and inside the `files` array, immediately after `p.migratedFile` (`:238`):

```ts
      p.migrateLockFile, // daemon-owned, sibling of migrated.json above
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dataTree.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t1.txt`

Expected: PASS, exit 0. The existing invariant assertions (`:162-164`, `:206-212`) must still pass — they prove no ancestor of a writable root was denied.

- [ ] **Step 5: Verify no downstream suite regressed**

Run: `npx vitest run tests/sandboxPolicy.test.ts tests/sessionSandboxWiring.test.ts tests/dataTree.test.ts > /tmp/t1b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t1b.txt`

Expected: PASS. `tests/sessionSandboxWiring.test.ts:69-81` asserts subtrees-denied-but-not-root; if it counts deny entries by length rather than membership, update the count and note it in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/dataTree.ts tests/dataTree.test.ts
git commit -m "fix(sandbox): deny plan-set records and the migrate lock

plans/ (flat) and data/plans (v2) hold PlanSetRecord control-plane state
— repoPath, issue nwo/number, task ids, statusCommentId — and were
readable by the sandboxed agent: the dir joined the data tree with the
plan-sets work but never joined sandboxDenyPaths. migrate.lock is the
already-denied migrated.json's sibling and is denied for the same reason.

Neither is an ancestor of a writable root under either layout, so the
backend.ts invariant is preserved."
```

---

### Task 2: Drift guard — force every data-tree entry to be classified

**Files:**

- Test: `tests/dataTree.test.ts` (new test at the end of `describe("sandboxDenyPaths")`, after the v2 test that currently ends at `:213`)

**Interfaces:**

- Consumes: `dataTreePaths(cfg)` and `sandboxDenyPaths(cfg, env)` — both already imported at the top of the file.
- Produces: no production symbol. The deliverable is a test that fails when a future `DataTreePaths` field is added without either denying it or recording why it must stay readable.

**Why:** issue #277's actual complaint is that this list "must be maintained by hand as the tree grows". The allow-over-deny redesign (WS-8) is the eventual fix; until then, this test makes the omission loud instead of silent — it is what would have caught the `plans` gap on the day it was introduced.

- [ ] **Step 1: Write the test**

Append inside `describe("sandboxDenyPaths")`:

```ts
// Drift guard (#277): sandboxDenyPaths is a hand-maintained enumeration —
// it cannot simply deny the root, because the agent's own cwd
// (cache/worktrees) and git object reads (cache/clones) live under it. That
// makes it prone to silent omission: `plans` joined the data tree with the
// plan-sets work and stayed agent-readable until 2026-08-21. This test fails
// when a NEW DataTreePaths field is neither denied nor listed as exempt, so
// the choice has to be made deliberately rather than forgotten.
it("classifies every data-tree entry as denied or deliberately exempt", () => {
  const cfg = makeConfig({
    dataDir: "/sbxroot/home/.junco",
    queueRoot: "/sbxroot/home/.junco/queue",
    worktreeRoot: "/sbxroot/home/.junco/cache/worktrees",
    dataLayout: "v2",
    github: {
      ...makeConfig().github,
      externalReposRoot: "/sbxroot/home/.junco/cache/clones/external",
    },
  });
  const paths = dataTreePaths(cfg);
  const deny = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
  const denied = [...deny.dirs, ...deny.files];

  // Each entry must stay agent-READABLE, with the reason it has to.
  const EXEMPT: Record<string, string> = {
    root: "CRITICAL invariant: ancestor of the agent's writable roots",
    queue: "not a path (Paths object) — denied via cfg.queueRoot",
    worktrees: "the agent's own cwd",
    clonesWatched: "git object reads from the watched clone",
    clonesExternal: "git object reads from external clones",
    skills:
      "symlink to the INSTALLED PACKAGE's public skills/ dir — canonicalize() " +
      "realpaths it, so a deny here would land on the junco install, not the data tree",
  };

  const covered = (v: string) => denied.some((d) => v === d || v.startsWith(d + "/"));

  for (const [field, value] of Object.entries(paths)) {
    if (field in EXEMPT) continue;
    expect(
      typeof value,
      `DataTreePaths.${field} is new and unclassified: deny it in sandboxDenyPaths, or add it to EXEMPT with the reason it must stay agent-readable`,
    ).toBe("string");
    expect(
      covered(value as string),
      `DataTreePaths.${field} (${String(value)}) is neither denied nor exempt — deny it in sandboxDenyPaths, or add it to EXEMPT with the reason it must stay agent-readable`,
    ).toBe(true);
  }
});
```

- [ ] **Step 2: Run it and verify it passes against Task 1's fix**

Run: `npx vitest run tests/dataTree.test.ts > /tmp/t2.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t2.txt`

Expected: PASS. Every non-exempt field resolves under a denied path: `reviewAssess`/`reviewComments` under `<root>/review`, `logFile` under `<root>/logs`, the rest denied directly.

- [ ] **Step 3: Prove the guard actually bites**

Temporarily comment out the `p.plans,` line added in Task 1, re-run the file, and confirm the new test fails naming `DataTreePaths.plans`. Then restore the line and re-run to green. (This is the "run it to make sure it fails" step for a test whose subject is an omission — a guard that cannot fail is worthless.)

Run: `npx vitest run tests/dataTree.test.ts > /tmp/t2b.txt 2>&1; echo "exit: $?"; grep -c "DataTreePaths.plans" /tmp/t2b.txt`

Expected while commented out: FAIL, with the message naming `DataTreePaths.plans`. After restoring: PASS, exit 0.

- [ ] **Step 4: Commit**

```bash
git add tests/dataTree.test.ts
git commit -m "test(sandbox): fail when a data-tree entry is neither denied nor exempt

sandboxDenyPaths cannot deny the ~/.junco root (the agent's cwd and git
object reads live under it), so it is a hand-maintained enumeration and
silently missed plans/. This guard forces each new DataTreePaths field to
be classified — denied, or exempt with a stated reason."
```

---

### Task 3: Document the exemption, correct the stale citation, changelog

**Files:**

- Modify: `src/dataTree.ts:181-208` (the `sandboxDenyPaths` doc comment)
- Modify: `tests/dataTree.test.ts:206` (stale line-number citation)
- Modify: `CHANGELOG.md` (Unreleased → Fixed)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Extend the doc comment**

In `src/dataTree.ts`, append to the CRITICAL-invariant paragraph (after the sentence ending `never cache/ itself.` at `:196`):

```
 * `skills` is exempt for a different reason: it is a SYMLINK to the installed
 * package's `skills/` dir (skillLinks.ts:97-98), so `canonicalize()` would
 * resolve a deny here onto the junco installation rather than the data tree —
 * denying the wrong target to protect public packaged content. The full list
 * of exemptions, each with its reason, is asserted in tests/dataTree.test.ts
 * ("classifies every data-tree entry as denied or deliberately exempt").
```

- [ ] **Step 2: Fix the stale citation**

`tests/dataTree.test.ts:206` cites `backend.ts:42-53` for the invariant; it now lives at `src/agent/sandbox/backend.ts:66-77`. Update the comment text to `(backend.ts:66-77 invariant)`. Verify the range first — CLAUDE.md requires these citations be true or deleted:

Run: `sed -n '66,77p' src/agent/sandbox/backend.ts`

Expected: the doc comment stating the deny list must never contain an ancestor of a writable root. If the range has shifted, cite the range you actually find.

- [ ] **Step 3: Add the changelog entry**

Under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md` (create the `### Fixed` subsection if absent, keeping Keep a Changelog ordering):

```markdown
- Sandbox: plan-set records (`plans/`, `data/plans`) and `migrate.lock` are now denied to the agent sandbox. The plan-set records directory joined the data tree with the plan-sets work but was never added to the sandbox deny list, leaving control-plane state (repo paths, issue numbers, task ids) agent-readable. A new classification test fails if a future data-tree entry is added without being denied or explicitly exempted.
```

- [ ] **Step 4: Format, then run the full gate**

```bash
npx prettier --write src/dataTree.ts tests/dataTree.test.ts CHANGELOG.md docs/superpowers/plans/2026-08-21-sandbox-deny-plans.md
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/gate.txt 2>&1; echo "vitest exit: $?"; tail -8 /tmp/gate.txt
```

Expected: lint/format/typecheck/build clean; vitest exit 0 with 3519+ tests passing (the count rises by 1 for the new test; the two edited tests keep their identities).

- [ ] **Step 5: Commit**

```bash
git add src/dataTree.ts tests/dataTree.test.ts CHANGELOG.md docs/superpowers/plans/2026-08-21-sandbox-deny-plans.md
git commit -m "docs(sandbox): record why skills is exempt from the deny list

Also corrects a stale backend.ts line citation in the data-tree tests and
adds the changelog entry for the plans/migrate.lock denies."
```

---

## Self-review

**Spec coverage:** WS-1's two deliverables — add the missing `plans` deny (Task 1) and sweep for other unclassified entries (Task 2's guard, which subsumes the manual sweep by making it mechanical) — are both covered, plus the open question WS-1 flagged (should `skills` be denied?) is resolved and documented in Task 3 rather than left dangling.

**Placeholder scan:** no TBDs; every code step carries the literal text to add, every run step carries the exact command and expected outcome.

**Type consistency:** `sandboxDenyPaths`'s return type is unchanged (`{dirs, files}`), so no consumer signature moves. `p.plans` and `p.migrateLockFile` are existing `string` fields of `DataTreePaths` (`src/dataTree.ts:90`, `:101`) — no new fields, so `tests/helpers/config.ts` is untouched. The drift test reads `Object.entries(paths)` generically and therefore needs no update when unrelated fields change type.

**Known judgment calls (flag in the PR):** (1) `migrate.lock` was added beyond the issue's literal scope — free, consistent with its already-denied sibling, and the drift guard would have forced the decision anyway; (2) `skills` is deliberately NOT denied, for the canonicalize-target reason above; (3) the guard test asserts _coverage by prefix_, so a future field nested under an already-denied dir passes without a new entry — intended.
