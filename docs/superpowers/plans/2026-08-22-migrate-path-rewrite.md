# Migration correctness: stored absolute paths, missing pairs, rollback guard (WS-4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `junco data migrate` leave a working installation — rewrite the absolute paths stored _inside_ data files (#283), move the two trees it currently forgets, actually remove the emptied legacy root, and warn when a downgrade has rebuilt a second tree (#280).

**Architecture:** `junco data migrate` relocates junco's data tree to `~/.junco` and restructures flat→v2. It moves files correctly but never touches paths recorded _within_ them, so after a migrate the watchlist, queue tickets, review batches, outbox ops and plan-set records all point into the removed root. This adds a journaled rewrite phase between the data-root move and the legacy-root removal, fixes two forgotten trees, and adds a doctor check for the downgrade-rebuild case.

**Tech Stack:** TypeScript strict/ESM, vitest. `dataMigrateCmd` tests use real tmpdirs with `process.env.HOME` overridden (they call the real `loadConfig`); `dataMigrate` and `doctor` tests inject `env` as a dep and never touch `process.env`.

**Spec:** GitHub issues #283 and #280, plus two untracked bugs found while surveying the backlog (recorded as N2/N3 below).

## Global Constraints

- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Capture vitest exit explicitly (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`) — never pipe into `grep`/`tail` as the last stage. **`npm test` does not type-check**; always run `npm run typecheck` too.
- **`src/ticketSchema.ts` is a stable public contract — additive only.** This plan reads `repo:`/`workdir:` and rewrites their _values_; it must not change the schema.
- Every side effect behind an injectable `*Deps` seam. `DataMigrateDeps` already seams `existsFn`, `renameFn`, `readFileFn`, `writeFileFn`, `copyDirFn`, `syncPathFn`, `pidfileHolderFn`, `fetchFn`, `env`. It does **not** seam `mkdirSync`/`rmSync`/`readdirSync`/`statSync`/`lstat` — add a seam for anything new you need rather than calling `node:fs` directly.
- New `Config` fields go in `tests/helpers/config.ts` and nowhere else. (This plan adds none.)
- **Migration is destructive and resumable.** Every new step must be idempotent (safe to re-run after an interruption), journaled like its neighbours, and must never fail the whole migrate for a single unreadable file.
- Conventional commits, suite green at every commit, no AI-attribution trailers.
- Branch `fix/migrate-path-rewrite` off `main` @ `df59d16`.
- **Release HOLD:** no version bump, no tag, no publish.

---

### Task 1: Move the two trees migrate forgets, and let the legacy root actually be removed

**Files:**

- Modify: `src/dataMigrate.ts` (`flatToV2Pairs`)
- Modify: `src/dataMigrateCmd.ts` (`DataMigrateDeps`; the legacy-root removal block)
- Test: `tests/dataMigrate.test.ts`, `tests/dataMigrateCmd.test.ts`

**Interfaces:**

- Produces: `flatToV2Pairs` gains `["plans", "data/plans"]`. `DataMigrateDeps` gains `lstatFn?: (p: string) => { isSymbolicLink(): boolean }` (same contract as `fs.lstatSync` — throws ENOENT when absent), used only to identify the `skills` mount.

**Why (two bugs, both confirmed against current code):**

- **N2:** `flatToV2Pairs` lists 16 pairs and covers every `LAYOUTS` key **except `plans`** (`plans` → `data/plans`). On a cross-root move the legacy `plans/` tree — the plan-set records — is silently left behind, and it also blocks the legacy-root removal.
- **N3:** `<root>/skills` is a **symlink** created by `ensureSkillLinks` at every daemon startup. Nothing in the migrate path mentions it, so it is left in the legacy root and `rmdirSync` fails ENOTEMPTY — meaning the advertised legacy-root removal **never fires on any machine whose daemon has run**. This is exactly the failure the `.gitignore` special-case already in that block was written to fix; mirror its shape. Note `existsFn` follows symlinks, so a broken link (its target is the old package dir) reports absent — you need `lstat`.

- [ ] **Step 1: Write the failing tests**

In `tests/dataMigrate.test.ts`, add to the `flatToV2Pairs` describe block:

```ts
it("moves the plan-set records tree", () => {
  const pairs = flatToV2Pairs("/from", "/to");
  expect(pairs).toContainEqual({ from: join("/from", "plans"), to: join("/to", "data/plans") });
});

it("covers every layout key (guards against a forgotten tree)", () => {
  // A new LAYOUTS entry with no pair here is silently left behind by a
  // cross-root migrate AND blocks the legacy-root rmdir. Keep this list in
  // sync deliberately rather than discovering the gap in production.
  const pairs = flatToV2Pairs("/from", "/to").map((p) => p.from);
  for (const key of [
    "queue",
    "review",
    "outbox",
    "assess-history",
    "history",
    "transcripts",
    "plans",
    "clones",
    "worktrees",
    "github-cache",
    "mirror",
  ]) {
    expect(pairs, `missing pair for ${key}`).toContain(join("/from", key));
  }
});
```

In `tests/dataMigrateCmd.test.ts`, add a case to whichever describe block exercises the legacy-root removal (read the file first and reuse its `freshRoot`/HOME-override harness): seed the legacy root with a `skills` symlink pointing anywhere, run the migrate, and assert the legacy root is gone.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/dataMigrate.test.ts tests/dataMigrateCmd.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t1.txt`

Expected: FAIL — no `plans` pair, and the legacy root survives with `skills` inside.

- [ ] **Step 3: Add the missing pair**

In `src/dataMigrate.ts`'s `flatToV2Pairs`, add next to the `transcripts` entry (matching `ensureDataTree`'s ordering, which lists `transcripts` then `plans`):

```ts
    ["plans", "data/plans"],
```

- [ ] **Step 4: Remove the skills mount before the rmdir**

Add the seam to `DataMigrateDeps`, next to `existsFn`:

```ts
  /** lstat that does NOT follow the link — the only way to identify the
   * `<root>/skills` symlink mount, since `existsFn` follows links and a
   * migrated mount's target is the old package dir (so it reads as absent).
   * Throws ENOENT when the path does not exist, same contract as
   * `fs.lstatSync`. Default: the real lstatSync. */
  lstatFn?: (p: string) => { isSymbolicLink(): boolean };
```

Resolve it alongside the other deps, then in the legacy-root removal block — immediately after the existing `.gitignore` special-case and before the `rmdirSync` — remove a leftover `skills` **symlink only**:

```ts
// `<root>/skills` is a symlink mount that skillLinks.ts recreates at
// every daemon startup, so on any machine the daemon has run it is
// sitting in the legacy root with no pair to move it — and, exactly
// like the scaffolded .gitignore above, it makes the rmdir below fail
// ENOTEMPTY every time. Only a SYMLINK is unlinked here; a real
// directory or file at that path is left alone and reported as a
// leftover like anything else. The mount is regenerated at the new
// root by ensureSkillLinks on the next daemon start.
const legacySkills = join(legacyRoot, "skills");
try {
  if (lstatFn(legacySkills).isSymbolicLink()) unlinkSync(legacySkills);
} catch {
  /* absent or unreadable — rmdir below reports it as a leftover */
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/dataMigrate.test.ts tests/dataMigrateCmd.test.ts > /tmp/t1b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t1b.txt`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/dataMigrate.ts src/dataMigrateCmd.ts tests/dataMigrate.test.ts tests/dataMigrateCmd.test.ts
git add src/dataMigrate.ts src/dataMigrateCmd.ts tests/dataMigrate.test.ts tests/dataMigrateCmd.test.ts
git commit -m "fix(migrate): move the plans tree; unlink the skills mount before the rmdir

flatToV2Pairs covered every layout key except plans, so a cross-root
migrate silently left the plan-set records behind. And <root>/skills is a
symlink skillLinks.ts recreates at every daemon start with no pair to move
it, so the legacy-root rmdir failed ENOTEMPTY on any machine the daemon
had run — the advertised removal never fired. Same failure the scaffolded
.gitignore case already handles; same shape of fix."
```

---

### Task 2: A journaled phase that rewrites relocated paths, applied to the watchlist and queue tickets

**Files:**

- Create: `src/migratePathRewrite.ts`
- Modify: `src/dataMigrateCmd.ts` (call the new phase; extend the receipt)
- Test: `tests/migratePathRewrite.test.ts`, `tests/dataMigrateCmd.test.ts`

**Interfaces:**

- Produces:
  - `buildPrefixMap(steps: MigrationStep[]): Array<{ from: string; to: string }>` — the actually-relocated prefixes, **longest-`from`-first** so a nested pair wins over its parent.
  - `rewritePath(p: string, map: Array<{from: string; to: string}>): string | null` — the rewritten path, or `null` when no prefix applies (leave it alone).
  - `rewriteStoredPaths(ctx: RewriteCtx, map, deps): RewriteReport` — walks the stores and rewrites in place. `RewriteReport` carries `{ rewritten: number; files: string[]; warnings: string[] }`.
- Consumes: `MigrationStep` from `src/dataMigrate.ts`.

**Why:** `junco data migrate` moves files but never the absolute paths recorded inside them. After a migrate the watchlist points into the removed root and `junco doctor` reports every watched repo as "not a git clone" — the symptom that produced #283. Queue tickets are the same class: `repo:` (and `workdir:`) are absolute.

**Design rules — all four matter:**

1. **Only rewrite under a prefix that actually moved.** Build the map from journal steps whose action is `renamed` (plus the queue-move steps), never from the full pair list — a `skipped-conflict` pair did not move.
2. **Never touch paths outside those prefixes.** A repo at `~/dev/foo` is not junco's to rewrite.
3. **Idempotent.** Re-running after an interruption must find nothing to rewrite (the old prefix no longer matches).
4. **Never fail the migrate for one bad file.** An unreadable or unparseable file is a warning on the receipt, not a throw.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/migratePathRewrite.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPrefixMap, rewritePath } from "../src/migratePathRewrite.js";

describe("buildPrefixMap", () => {
  it("keeps only steps that actually moved", () => {
    const map = buildPrefixMap([
      { from: "/old/clones", to: "/new/cache/clones", action: "renamed" },
      { from: "/old/queue", to: "/new/queue", action: "skipped-conflict" },
      { from: "/old/x", to: "/new/x", action: "noop" },
    ]);
    expect(map).toEqual([{ from: "/old/clones", to: "/new/cache/clones" }]);
  });

  it("orders longest prefix first so a nested pair wins", () => {
    const map = buildPrefixMap([
      { from: "/old", to: "/new", action: "renamed" },
      { from: "/old/clones", to: "/new/cache/clones", action: "renamed" },
    ]);
    expect(map[0].from).toBe("/old/clones");
  });
});

describe("rewritePath", () => {
  const map = [{ from: "/old/clones", to: "/new/cache/clones" }];

  it("rewrites a path under a moved prefix", () => {
    expect(rewritePath("/old/clones/o/r", map)).toBe("/new/cache/clones/o/r");
  });

  it("rewrites the prefix itself", () => {
    expect(rewritePath("/old/clones", map)).toBe("/new/cache/clones");
  });

  it("returns null for a path outside every prefix", () => {
    expect(rewritePath("/home/me/dev/foo", map)).toBeNull();
  });

  it("does not match a sibling that merely shares a string prefix", () => {
    expect(rewritePath("/old/clones-backup/x", map)).toBeNull();
  });

  it("is idempotent — an already-rewritten path is left alone", () => {
    expect(rewritePath("/new/cache/clones/o/r", map)).toBeNull();
  });
});
```

The sibling-prefix case is the one that bites: match on a path boundary, not a bare `startsWith`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/migratePathRewrite.test.ts > /tmp/t2.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t2.txt`

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the pure helpers**

Create `src/migratePathRewrite.ts` with a header explaining the four design rules above, then `buildPrefixMap` (filter to `action === "renamed"`, map to `{from,to}`, sort by descending `from.length`) and `rewritePath` (return `to` when `p === from`; return `to + p.slice(from.length)` when `p.startsWith(from + sep)`; else try the next entry; else `null`). Use `node:path`'s separator rather than a hardcoded `/`.

- [ ] **Step 4: Rewrite the watchlist and queue tickets**

Add to the same module a `rewriteStoredPaths` that takes the target root, the queue paths, the prefix map, and injected `readFileFn`/`writeFileFn`/`readdirFn`/`existsFn`, and:

- **watchlist.json** — read via `readWatchlist(file)`, rewrite each entry's `path` where `rewritePath` returns non-null, write back via `writeWatchlist(file, entries)` only if something changed. Both take a bare file path, so no `Config` is needed.
- **queue tickets** — for each of `inbox`/`processing`/`done`/`failed`, list `*.md` and rewrite the `repo:` and `workdir:` frontmatter values. **Both are absolute paths**; `workdir:` is the Q&A twin of `repo:`. Rewrite the VALUE only, preserving the file's exact byte layout otherwise — these are live tickets. Match the emission style (`repo: "…"`, JSON-quoted) rather than reformatting.

Every read/parse failure appends to `report.warnings` and continues.

- [ ] **Step 5: Call it as a journaled phase**

In `src/dataMigrateCmd.ts`, insert the phase **after** the data-root journal flush and **before** the legacy-root removal — at that point everything is at the target root and the legacy root has not yet been touched. Build the map from the journal steps the earlier phases accumulated (queue steps plus the data-root steps), call `rewriteStoredPaths`, journal the result with a new `MigrationStep`-shaped action, and add a receipt section listing the count and any warnings.

`MigrationStep.action` is currently `"renamed" | "skipped-conflict" | "noop"` — widen it additively to include `"rewrote"`, and confirm `readJournal`/`appendJournal` tolerate the new value (read them before assuming).

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/migratePathRewrite.test.ts tests/dataMigrateCmd.test.ts tests/watchlist.test.ts > /tmp/t2b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t2b.txt`

Expected: PASS. Add an end-to-end case in `tests/dataMigrateCmd.test.ts`: seed a legacy root with a watchlist entry and a ticket whose `repo:` points inside it, migrate, and assert both now point at the new root.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/migratePathRewrite.ts src/dataMigrateCmd.ts tests/migratePathRewrite.test.ts tests/dataMigrateCmd.test.ts
git add src/migratePathRewrite.ts src/dataMigrateCmd.ts tests/migratePathRewrite.test.ts tests/dataMigrateCmd.test.ts
git commit -m "fix(migrate): rewrite relocated absolute paths in the watchlist and queue tickets

junco data migrate moved files but never the absolute paths recorded
inside them, so afterwards the watchlist pointed into the removed root and
doctor reported every watched repo as 'not a git clone' (#283). A new
journaled phase rewrites paths under prefixes that actually moved, leaving
everything else alone, and is idempotent so a resumed migrate is a no-op."
```

---

### Task 3: Extend the rewrite to the four remaining stores

**Files:**

- Modify: `src/migratePathRewrite.ts`
- Test: `tests/migratePathRewrite.test.ts`, `tests/dataMigrateCmd.test.ts`

**Interfaces:** no signature change — `rewriteStoredPaths` covers more stores and reports a higher count.

**The four stores, each verified to hold an absolute path:**

- **Pending assess batches** — `PendingAssess.repoPath`, one JSON per file under `<root>/review/assess` (layout-independent, so only the root changes).
- **Pending comment drafts** — `PendingComment.repoPath`, under `<root>/review/comments`.
- **Outbox ops** — `op.repoPath` on the `push` and `pr` variants only (`labels`, `comment`, `issue-create` carry none). Scan both the outbox dir **and its `dead/` subdir**. Note `StoredOp.path` is derived at read time and stripped before writing, so it needs no rewrite — do not add one.
- **Plan-set records** — `PlanSetRecord.repoPath`, one JSON per file under the plans dir (`plans/` flat → `data/plans` v2 — moved by the pair Task 1 added).

Confirmed to need nothing: assess-history, task history, `spend.json`, `update-check.json`.

- [ ] **Step 1: Write the failing tests**

Extend `tests/migratePathRewrite.test.ts` with a case per store: write a JSON fixture carrying an old-root `repoPath`, run the rewrite, assert the path moved and every other field is byte-identical. For the outbox, include one `push` op, one `pr` op, one `labels` op (must be untouched), and one op in `dead/`.

Also add the guard case: a record whose `repoPath` points somewhere junco never moved is left alone.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/migratePathRewrite.test.ts > /tmp/t3.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t3.txt`

Expected: FAIL — these stores are not visited yet.

- [ ] **Step 3: Implement**

Extend `rewriteStoredPaths` to walk the four dirs. Read each `*.json`, parse, rewrite the single `repoPath` field when `rewritePath` returns non-null, and write back **only when changed**, preserving formatting conventions (these stores write `JSON.stringify(x, null, 2) + "\n"` — match it). For outbox ops, rewrite `op.repoPath` only on the `push`/`pr` variants and leave everything else untouched.

Every parse failure is a warning, never a throw — a corrupt file must not abort a migration.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/migratePathRewrite.test.ts tests/dataMigrateCmd.test.ts > /tmp/t3b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t3b.txt`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/migratePathRewrite.ts tests/migratePathRewrite.test.ts tests/dataMigrateCmd.test.ts
git add src/migratePathRewrite.ts tests/migratePathRewrite.test.ts tests/dataMigrateCmd.test.ts
git commit -m "fix(migrate): rewrite relocated paths in review, outbox and plan-set records

Completes #283's inventory: pending assess batches, pending comment
drafts, outbox push/pr ops (including dead/), and plan-set records all
store an absolute repoPath. StoredOp.path is derived at read time and
needs no rewrite."
```

---

### Task 4: Doctor warns when both data roots hold a tree

**Files:**

- Modify: `src/doctor.ts`
- Modify: `CHANGELOG.md`
- Test: `tests/doctor.test.ts`

**Interfaces:** no signature change. `DoctorDeps` already seams `existsFn`, `env`, and `readdirFn`.

**Why (#280):** after a migrate, running a pre-0.10 binary recreates `~/.local/state/junco` from its hardcoded default — a silent second tree, the exact divergence the single-root work eliminated. Doctor is the place that catches it on the next upgrade.

**The interplay this must handle — do not skip it.** Check 2b already reports "unmigrated data dirs … run 'junco data migrate' to unify" whenever legacy-named dirs exist. A downgrade-rebuild materialises exactly those dirs, so 2b fires with advice that is **actively wrong** in this state: re-running migrate would merge or conflict against live data. The new check must pre-empt or reword 2b when both roots hold trees.

**Verdict level:** report `warn`, not `fail` — doctor's exit code is driven only by `fail`, and this is a "you should look at this" condition, not a broken install.

- [ ] **Step 1: Write the failing test**

In `tests/doctor.test.ts` (fully hermetic — synthetic `/sbxroot/...` paths, `deps()` factory, `env` injected as a dep, `process.env` never touched):

```ts
it("warns when both the canonical and legacy data roots hold a tree", async () => {
  const out: string[] = [];
  const code = await runDoctor(
    "/sbxroot/home/.junco/config.json",
    deps({
      printFn: (s) => out.push(s),
      env: { HOME: "/sbxroot/home" },
      existsFn: (p) =>
        p.startsWith("/sbxroot/home/.junco/queue") ||
        p.startsWith("/sbxroot/home/.local/state/junco/queue") ||
        p.endsWith("/skills"),
    }),
  );
  const text = out.join("");
  expect(text).toMatch(/both data roots/i);
  expect(text).toContain("/sbxroot/home/.local/state/junco");
  expect(code).toBe(0); // a warning, never a failure
});

it("does not warn when only one root holds a tree", async () => {
  const out: string[] = [];
  await runDoctor(
    "/sbxroot/home/.junco/config.json",
    deps({
      printFn: (s) => out.push(s),
      env: { HOME: "/sbxroot/home" },
      existsFn: (p) => p.startsWith("/sbxroot/home/.junco/queue") || p.endsWith("/skills"),
    }),
  );
  expect(out.join("")).not.toMatch(/both data roots/i);
});
```

Adapt to the file's actual `deps()` defaults — read them first; the `endsWith("/skills")` clause mirrors the existing default so the unrelated skill-links check keeps passing.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/doctor.test.ts > /tmp/t4.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t4.txt`

Expected: FAIL — no such check.

- [ ] **Step 3: Add the check**

Import `migrationTargetRoot` and `fixedLegacyRoot` from `./dataMigrate.js` and `dataRootHasTree` from `./config.js`. Insert immediately after check 2b's block:

```ts
// 2b-bis. Rollback divergence (#280): a pre-0.10 binary run after a
// migrate recreates the legacy root from its hardcoded default, so BOTH
// roots hold a tree — the split-state the single-root work eliminated.
// Deliberately a warn: nothing is broken, but the operator is now
// writing to whichever root the running binary picks.
//
// This also SUPPRESSES 2b above, whose "run 'junco data migrate'" advice
// is actively wrong here — re-running migrate would merge or conflict
// against live data. Inspect and remove the stale tree instead.
const targetRoot = migrationTargetRoot(cfg, env);
const legacyRoot = fixedLegacyRoot(targetRoot, env);
const bothRoots =
  legacyRoot !== null &&
  dataRootHasTree(targetRoot, existsFn) &&
  dataRootHasTree(legacyRoot, existsFn);
if (bothRoots) {
  report(
    "warn",
    "both data roots hold a tree",
    `${targetRoot} and ${legacyRoot} — a pre-0.10 binary was probably run after 'junco data migrate'. ` +
      `Check which one the daemon is using ('junco data'), then remove the stale tree by hand. Do NOT re-run migrate.`,
  );
}
```

Then gate check 2b so it does not also fire — restructure so the pending-migrations warning is skipped when `bothRoots` is true, and say in your report how you did it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/doctor.test.ts > /tmp/t4b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t4b.txt`

Expected: PASS, including every pre-existing doctor test — several assert exact warning counts, so a stray extra warning will surface here. If one legitimately changes, report it rather than editing the assertion silently.

- [ ] **Step 5: Changelog and full gate**

Add under `## [Unreleased]` → `### Fixed` (Keep a Changelog order; **no version heading, no version bump, `package.json` untouched**):

```markdown
- `junco data migrate` now rewrites the absolute paths stored _inside_ data files — the watchlist, queue tickets (`repo:`/`workdir:`), pending assess batches, pending comment drafts, outbox push/PR ops, and plan-set records — so a migrated install keeps working instead of pointing at the removed root. It also moves the plan-set records tree, which had no migration pair, and unlinks the `skills` symlink mount that made the legacy-root removal fail on every machine whose daemon had run.
- `junco doctor` warns when both the canonical and legacy data roots hold a tree — the split state a pre-0.10 binary recreates if it is run after a migrate — and suppresses the "unmigrated data dirs" hint in that case, since re-running the migration is the wrong remedy there.
```

```bash
npx prettier --write src/doctor.ts tests/doctor.test.ts CHANGELOG.md
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/gate.txt 2>&1; echo "vitest exit: $?"; tail -8 /tmp/gate.txt
```

- [ ] **Step 6: Commit**

```bash
git add src/doctor.ts tests/doctor.test.ts CHANGELOG.md
git commit -m "feat(doctor): warn when both data roots hold a tree

A pre-0.10 binary run after 'junco data migrate' recreates the legacy root
from its hardcoded default — a silent second tree. Doctor now names both
paths and suppresses the 'unmigrated data dirs' hint in that state, whose
advice to re-run the migration would merge or conflict against live data."
```

---

## Self-review

**Spec coverage:** #283 is Tasks 2 and 3 (the full store inventory, including the `workdir:` field the issue did not name); #280 is Task 4, including the check-2b interplay the issue's own text flags. The two untracked bugs are Task 1.

**Placeholder scan:** no TBDs. Each code step carries literal text; each run step carries a command and its expected outcome. Three steps require reading existing fixtures/deps before writing tests, and say so.

**Type consistency:** `buildPrefixMap`/`rewritePath` are defined in Task 2 Step 3 before Task 3 consumes them. `MigrationStep.action` is widened additively in Task 2 Step 5. `DataMigrateDeps.lstatFn` is added in Task 1 and used only there. `RewriteReport`'s shape is fixed in Task 2 and only its counts change in Task 3. No `Config` field is added, so `tests/helpers/config.ts` is untouched.

**Ordering dependency:** Task 1's `plans` pair must land before Task 3 rewrites plan-set records, or that tree will not have moved to where Task 3 looks for it.

**Known judgment calls (flag in the PR):** (1) rewriting only under prefixes that actually moved (`action === "renamed"`), never the full pair list; (2) path-boundary matching so a sibling like `clones-backup` is not caught; (3) an unreadable file is a receipt warning, never a failed migration; (4) `StoredOp.path` deliberately not rewritten — it is derived at read time; (5) doctor reports `warn`, so exit code is unchanged; (6) only a **symlink** at `<legacyRoot>/skills` is unlinked — a real file or directory there is reported as a leftover.
