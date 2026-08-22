# Migration polish bundle (WS-9, #281) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #281 — the twelve non-blocking items parked during PR #272's reviews. **Nine are implemented; three are deliberately dropped** (see Rulings).

**Architecture:** Almost everything lives in `src/dataMigrateCmd.ts` (the command, its receipt, and its dry-run) plus `src/dataMigrate.ts` (the pair planner). Task 1 lands the deps seam first because it is what makes the error-path tasks testable; the rest are independent.

**Tech Stack:** TypeScript strict/ESM, vitest. `tests/dataMigrateCmd.test.ts` is the main surface (**35 tests at baseline** `ce22fbd` — an earlier draft of this line said 64, which is wrong and would read as if this branch deleted tests; corrected in the fix round after final review F2).

**Spec:** GitHub issue #281.

## Global Constraints

- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. **Capture the vitest exit code explicitly** — never pipe into `grep`/`tail` as the last stage. `npm test` does NOT type-check; always run `npm run typecheck` too.
- Every side effect behind an injectable `*Deps` seam; read env through an injected `env` object.
- New `Config` fields go in `tests/helpers/config.ts` and nowhere else. **This plan adds none.**
- Conventional commits, suite green at every commit, **no AI-attribution trailers**. No version bump (release HOLD).
- Branch `fix/migrate-polish` off `main` @ `ce22fbd`.
- **This command deletes directories.** Any change to `moveDataRootPair` or its callers is data-destructive if wrong. Treat Task 1 with corresponding care.

## Rulings — three items are NOT implemented

- **Item 8 (journal duplication on a failed `rmSync`) — DROPPED.** No consumer is harmed by a duplicate, so there is no symptom to fix: `destinationHoldsPartialCopy` (`src/dataMigrateCmd.ts:482`) only re-sets a flag, and the path-rewrite phase filters then de-dupes what it reads (`dedupeSteps`, `src/migratePathRewrite.ts:171`). **De-duplication is NOT global** — corrected in the fix round after final review F3, which caught the original wording ("a duplicated journal entry is collapsed before it reaches a reader") claiming more than the code does. `dedupeSteps` is applied at exactly ONE place, `src/dataMigrateCmd.ts:1276` (building the path-rewrite prefix map), and `appendJournal` (`src/dataMigrate.ts:394`) de-dupes **only** `skipped-conflict` steps — its own comment says `"renamed"` entries always append, because the same pair can genuinely rename twice. So a duplicated `renamed` entry DOES persist in `migrated.json` and any other reader, a human included, sees it. The drop stands on "no consumer is harmed", not on de-duplication.
- **Item 12 (`reviewStore` `subdir`→`dir` log key) — DROPPED.** Renamed in `ac80e2c`. Verified: no consumer, no test, no documented contract. There is nothing to fix and nothing to document.
- **Item 7 (`ensureDataTree` after `migrate.lock` release) — CODE CHANGE DROPPED, comment only.** The race is not reachable in normal operation: `worker.lock` is held across the whole daemon startup (`cli.ts:705` → `:781` → `:796`), so only `--force` enters the window; NO statement runs between the release and `mkdirs` (two closing braces — an earlier draft said "one statement", corrected in the fix round); and `ensureDataTree` only mkdirs and writes a `.gitignore`. Worst case is an ENOTEMPTY abort with an honest receipt that the filesystem-driven resume recovers. The genuinely destructive `recoverOrphans`/`pruneStaleWorktrees` were never under that lock in the first place. Record the reasoning in a comment so the next reader does not re-derive it — **done in the fix round after final review F1** (the comment sits at the `migLock.release()` → `mkdirs(cfg)` window in `src/daemon.ts`; that is this item's only deliverable).

---

### Task 1: route `moveDataRootPair`'s destructive fs ops through the deps seam

**Files:** Modify `src/dataMigrateCmd.ts`. Test: `tests/dataMigrateCmd.test.ts`.

**Why first:** it is what makes Tasks 2 and 4's error paths testable at all, and it is the highest-risk change in the bundle — `rmSync(to, { recursive: true })` at `src/dataMigrateCmd.ts:354` deletes a directory tree during a migration, guarded only by the `isRecursivelyEmptyDir` check above it.

Direct calls to fix: `:353`, `:354`, `:359`, `:368`, plus `statSync` at `:269`, `:272`, `:306`, `:310`, `:313`, `:323`. Note #305's `readdirFn` (`:195`) is **path-rewrite-scoped and untyped** — it does not cover these.

**Sharp edges, all of which have bitten before:**

- **Copy the seam names verbatim from `MigrateDeps` (`src/dataMigrate.ts:53-68`)** — `rmFn`/`mkdirFn`/`statFn`/typed `readdirFn`. A second vocabulary for the same operations is exactly the drift this codebase keeps paying for.
- **Never default `rmFn` with `force: true`.** The current call is `rmSync(to, { recursive: true })`; `force` would silently swallow the ENOENT that today signals a real bug.
- **`statFn` must keep returning something with `isDirectory()`** — the config-relocation call at `:1091` passes a *file*, not a directory.
- The Critical-2 `claimedByEarlierPhase` guard sits **outside** this function at `:843` — do not move it inside while refactoring.
- The function already takes six positional parameters. **Pass a deps object**, do not add three more positionals.
- The existing half-seam already throws ENOENT if `existsFn` is stubbed alone — so a partial seam is worse than none. Complete it.

- [x] **Step 1: Write the failing tests** — prove each new seam is actually consulted: a fake `rmFn` records its calls and the real filesystem is never touched; a fake `statFn` drives the directory/file branch. At least one test must fail if a call site is left on the real `fs`.
- [x] **Step 2:** run, confirm they fail for the right reason.
- [x] **Step 3:** implement. **Behaviour must be byte-identical** — this is a pure refactor. If any observable output changes, stop and say so.
- [x] **Step 4:** verify green, `npm run typecheck`, commit — `refactor(migrate): route moveDataRootPair's destructive fs ops through the deps seam`.

**Falsification:** revert one call site to the real `fs` and show a test fails. If none does, the seam is not pinned — strengthen and say so.

---

### Task 2: phase 9 journals before it reports (item 9)

**Files:** Modify `src/dataMigrateCmd.ts` (`:1090-1116`). Test: `tests/dataMigrateCmd.test.ts`.

**This is the highest-value item in the bundle — it makes the receipt lie about where the config is.** Phase 9 journals the config relocation *before* pushing its receipt line, inverted relative to the data-root loop. A throw at `:1104` therefore prints **"config: nothing to relocate"** for a config that has just been moved — telling an operator their config is at the old path when it is at the new one, in the exact situation (a partial failure) where they most need the truth.

It is also **missing the `#197.1` guard** that both other journal writes have.

- [ ] **Step 1: Write the failing test** — force a throw between the journal write and the receipt push; assert the receipt does NOT claim "nothing to relocate" and that it names the actual outcome. Use Task 1's seam to induce the failure.
- [ ] **Step 2-3:** verify fail, then fix the ordering to match the data-root loop and add the missing guard.
- [ ] **Step 4:** verify green, commit — `fix(migrate): phase 9 reports the relocation it journaled`.

**Falsification:** restore the inverted order; the new test must fail.

---

### Task 3: receipt and dry-run wording (items 1, 4, 5)

**Files:** Modify `src/dataMigrateCmd.ts`. Test: `tests/dataMigrateCmd.test.ts`.

All three are output-only and share one test file, so they are one commit.

- **Item 1** — gh-creds conflicts print under the `data-root conflicts:` heading (`:877-882`, rendered at `:495`). Give them their own heading. **There is no gh-conflict test at all today** — add one.
- **Item 4** — the dry-run prints an identity arrow at `:666`, and mentions legacy-root removal at `:677-679` even when the legacy root is absent. The second half is a **real dry-run/act divergence**: the acting run gates on `existsFn` at `:1009`, so the dry-run promises work the real run will skip. Gate the dry-run the same way.
- **Item 5** — the "would be skipped-conflict" line for the config move (`:695-697`) is untested; the string appears nowhere in `tests/`. Add the case to the describe block at `tests/dataMigrateCmd.test.ts:1057`.

- [ ] **Steps 1-4** as usual. Commit — `fix(migrate): honest dry-run and a heading of its own for gh-creds conflicts`.

**Note:** no existing assertion pins this wording, so nothing should break. If something does, that is a finding — report it rather than editing the old test to match.

---

### Task 4: a failed EXDEV copy leaves a hint (item 2)

**Files:** Modify `src/dataMigrateCmd.ts` (`:363-372`). Test: `tests/dataMigrateCmd.test.ts`.

The cross-device fallback copies, then removes the source. If the copy fails partway, the partial destination stays. **Run 1 does print the raw error (`:1154`) — but run 2 and every run after show only the generic "destination already exists and is not empty", and the pair is never journaled.** So the migration is permanently stuck with no indication of why.

Make the partial state self-describing: either clean up the partial copy on failure, or record enough that later runs can say "this destination holds a partial copy from an interrupted run". **State which you chose and why.** Cleaning up deletes data the user may still have only there — if you choose cleanup, it must be provably safe (the source still exists) and you must say how you proved it.

- [ ] **Steps 1-4.** Commit — `fix(migrate): a partial cross-device copy no longer strands the pair silently`.

---

### Task 5: `dataRootPairs` drops a pending legacy source (item 6)

**Files:** Modify `src/dataMigrate.ts` (`:201`, and the doc comment at `:176-179`). Test: `tests/dataMigrate.test.ts`.

When both roots pend the same target, `cfg.dataDir` iterates first (`:195`), takes the map slot, and the legacy candidate is **dropped from the returned array**. The user sees: run 1 exits 0 with the legacy straggler never planned, moved, journaled, or reported — its only trace a "legacy root … still contains: outbox" line buried in the receipt. Run 2 it wins the slot uncontested, hits a populated destination, and reports `skipped-conflict` with exit 1. **No data loss, but a spurious success followed by a spurious failure** — the worst possible sequence for operator trust.

**The doc comment at `:176-179` is factually wrong** about this behaviour. Fix it with the code; a comment that misdescribes a dedupe is how this survived review the first time.

**This changes an exported contract** that leaks into `doctor.ts:224` and `junco data --json` — check both consumers and say what you found.

- [ ] **Steps 1-4.** Commit — `fix(migrate): a pending legacy source is no longer dropped when both roots target one path`.

---

### Task 6: surface a pending config relocation (item 11)

**Files:** Modify `src/doctor.ts` (`:220-226`) and `src/dataCmd.ts` (`:459`). Tests: `tests/doctor.test.ts`, `tests/dataCmd.test.ts`.

`junco data` and `junco doctor` both surface pending data pairs but not a pending **config** relocation — so an operator is told the migration is complete while the config is still at the legacy path.

**#307 constrains this fix.** The report must mirror the `configPathOverride` guard at `dataMigrateCmd.ts:584-594`: under a `JUNCO_CONFIG` override an explicitly-named config is deliberately never relocated, so reporting it as "pending" would warn about something `junco data migrate` correctly refuses to do — a warning that can never be cleared. **Reuse that guard's logic; do not re-spell it.**

Consider splitting `doctor` from `junco data` into two commits — the latter needs a signature change and a `--json` shape change. Decide and say why.

- [ ] **Steps 1-4.** Commit(s) — `feat(doctor): surface a pending config relocation` (+ a second for `junco data` if split).

---

### Task 7: ARCHITECTURE.md (item 10)

**Files:** Modify `ARCHITECTURE.md` (`:215`).

The issue says the `dataMigrateCmd` row needs the config-relocation phase appended. **It is understated** — the row is missing **phase 9 and phase 6.5**, and `src/migratePathRewrite.ts` (added by #305) has **no module-map row at all**.

Do this last so it describes the code as it ends up, not as it started.

- [ ] Verify every phase you list against the real order in `runDataMigrate`. A module map that is confidently wrong is worse than one that is merely incomplete.
- [ ] Commit — `docs: correct the dataMigrateCmd phase list and add migratePathRewrite`.

---

## Final verification

- [ ] Full gate, five exit codes captured separately.
- [ ] `CHANGELOG.md` under Unreleased — one entry covering the user-visible fixes (items 1, 2, 4, 6, 9, 11). No version bump.
- [ ] Confirm the three dropped items (7-code, 8, 12) are recorded in the PR body with their reasoning, so #281 can be closed honestly rather than looking half-done.
