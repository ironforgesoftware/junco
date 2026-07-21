# Test-Suite Consolidation — Design

Date: 2026-07-21. Sub-project A of a two-part effort; sub-project B (App.tsx
state decomposition) is deferred and re-scoped after this lands.

## Goal

Cut the test suite's maintenance tax and fix a latent hermeticity bug, without
reducing coverage. Concretely: the "adding a `Config` field" tax drops from **19
files to 1**; ~2,000–3,300 lines of duplicated scaffolding are deleted; a
coverage floor exists where none does today.

**Explicit non-goal: reducing test count.** Count is not the problem (see
Baseline), and optimizing for it is precisely how load-bearing tests get
deleted.

## Baseline (measured 2026-07-21, clean runs)

| Metric                                    | Value                                              |
| ----------------------------------------- | -------------------------------------------------- |
| Tests / files                             | 3,126 / 173                                        |
| Wall time                                 | **26.8s** (two runs: 26.86s, 26.83s)               |
| CPU split                                 | tests 125s, import 20s, transform 6s               |
| src : tests                               | 37,646 : 58,358 lines (ratio 1.55)                 |
| Cheap tail                                | 1,968 tests across 114 files run in **2.5s total** |
| Hot head                                  | 839 tests across 30 files = ~92% of runtime        |
| Lines containing `expect(`                | **13.8%**                                          |
| Cross-file verbatim clone (8-line window) | ~7%                                                |

Growth context: src grew 4.7× in six weeks (Jun 1 → today) while test:src drifted
only 1.39 → 1.55, and test-line churn runs 1.22× src-line churn. The suite
tracked the product; it did not balloon.

**Two fixes were tried and rejected on evidence:**

- `--no-isolate`: _slower_ (38.5s vs 26.8s) and breaks 3 tests in
  `useTerminalSize.test.tsx` via stdout leakage.
- `until()` poll 20ms → 2ms: saved 4s CPU, **zero** wall change. TUI cost is
  real Ink rendering, not sleeping.

There is no configuration-level win available. This design therefore targets
maintenance, not speed — with one bounded exception (§4).

## Decisions (user-confirmed)

- **Scope:** test-layer only. `src/tui/App.tsx` decomposition is sub-project B,
  brainstormed fresh after this lands, so it can lean on the improved fixtures.
- **Config helper:** base + **type-enforced required seams**. A test cannot
  silently inherit a semantically meaningful default.
- **Deletions:** _unit tests own the matrix, integration tests own the wiring_,
  plus the provably-dead cases.
- **Verification:** both layers — a `@vitest/coverage-v8` floor in CI **and**
  prove-it-fails-first on every judgment-call deletion.
- **Coverage badge:** job-status chip (no percentage), via a separate
  `coverage.yml` workflow. Preserves the repo's no-secrets, no-third-party
  property; no coverage data leaves the maintainer's infrastructure.

## §1 The helper layer

Five modules under the existing `tests/helpers/` (which already holds
`until.ts` (23 importers), `forkHarness.ts` (4), `localFixtures.tsx` (8) — the
pattern is proven, it was simply never applied to `Config`).

| Module            | Replaces                                        | Lines today |
| ----------------- | ----------------------------------------------- | ----------- |
| `config.ts`       | 19 full `Config` literals                       | 1,587       |
| `gitHarness.ts`   | 6× `run()` + 6× `setupGitHarness`               | 213         |
| `fakeSession.ts`  | 8 `AgentSessionLike` fakes                      | 248         |
| `ghScript.ts`     | 15 inline fake-`gh` blocks                      | 177         |
| `dashFixtures.ts` | 6× `DashPr`, 6× `DashIssue`, 5× `GhAuthContext` | 230         |

Plus `makeQueueTree(root)` for the 4-dir scaffold repeated **59 times across 8
files**.

### §1.1 The seam set (derived mechanically, cross-validated)

Parsing all 19 helpers yields **71 key paths: 50 byte-identical everywhere, 21
varying.** Two independent methods agree on these counts.

**Required seams — 10.** The call site must state these; omission is a type
error:

`dataDir`, `queueRoot`, `worktreeRoot`, `tools`, `criticEnabled`,
`planLintEnabled`, `verifyEnabled`, `supervisorEnabled`, `healthEnabled`,
`removeWorktreeOnSuccess`

`tools` is required specifically because the read-only Q&A default is a hard
contract in CLAUDE.md; a shared default that silently widened it would be a
security-relevant regression that no test would catch.

**Cosmetic variants — normalized into ballast.** These vary only in spelling and
no test depends on the difference:

- `model.id`: `"m"` / `"test/model"` / `"test-model"` / `"omlx/test-model"` → `"test/model"`
- `model.apiKey`: `"k"` / `"test"` / `"test-key"` → `"test-key"`
- `model.baseUrl`: `"u"` / two real URLs → `"http://127.0.0.1:1234/v1"`

**Poison defaults.** Anything that could reach the real world defaults to a
value that fails loudly rather than silently succeeding:

- `ghBin` → `"/nonexistent/gh"` (not `"gh"`). A test that needs `gh` must point
  at its own fake; one that forgets fails immediately instead of shelling out to
  the maintainer's real, authenticated `gh`.
- `dataDir`/`queueRoot`/`worktreeRoot` are required seams, so no default can
  point at a real path (see §3).

**Ballast with override — the remainder.** `defaultTimeoutMinutes`, `healthPort`,
`verifyCommandTimeout`, `planLintBlockOnError`, `planLintCheckLabels`,
`model.baseUrlExplicit`, `github.externalReposRoot`, `legacy` (uniformly
all-false across all 19 helpers; per-test overrides live in test bodies today
and stay there).

### §1.2 What deliberately stays duplicated

- **Fake-`gh` case tables stay at call sites.** Each `*) exit 1` arm is a
  _negative assertion_ that no unexpected subcommand was invoked. `prFlow`'s six
  distinct case sets (`gh-resume`, `gh-refuse`, `gh-exists`, `gh-nogo`,
  `gh-net`, `gh-amend`) are six contracts, not six copies. Only the
  _generator_ (`ghCases`/`ghShim`, which `prFlow.test.ts` already invented
  internally) is shared.
- **`/sbxroot/...` synthetic paths** (`dataTree` 61×, `sandboxPolicy` 32×,
  `sandboxPathJail` 21×) must not become tmpdirs — `canonicalize()` realpaths
  real paths, so `/tmp` → `/private/tmp` on macOS and the exact-path assertions
  become unwritable.
- **`tests/config.test.ts` gets no fixture.** It round-trips real JSON through
  the module under test; a shared literal would assert the fixture against
  itself.
- **`tests/configLevers.test.ts`'s `schemaLeaves()` stays derived.** It is the
  bijection oracle that catches a new `ConfigSchema` leaf lacking a `LEVERS`
  entry. A hand-maintained fixture would drift and disarm it.

`forkHarness.ts` is refactored onto the shared primitives rather than left as a
seventh copy.

## §2 Deletions

Governing rule: **unit tests own the matrix; integration tests own the wiring.**

| Target                              | Change                    | Basis                                                                                                              |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `providerFailure.test.ts`           | unchanged (11 cases)      | owns the matrix                                                                                                    |
| `runOnce.test.ts` gate matrix       | 12 → 2                    | keeps count-free vs budgeted requeue — a genuine integration difference                                            |
| `prFlow.test.ts` gate matrix        | 11 → 2                    | same                                                                                                               |
| `doctor.test.ts:1091–1122`          | delete (32 lines)         | byte-identical setup to `:1056`; its sole assertion is a **substring** of that test's. Verified by `diff`          |
| `doctor.test.ts` cluster A          | 8 → 0, folded into `:772` | eight byte-identical `runDoctor(...)` calls each asserting one `not.toMatch`; `:772` already asserts four absences |
| `prFlow.test.ts` `timingOutFactory` | dedupe                    | lines 730 and 1512 byte-identical                                                                                  |

**Prerequisite, must land first:** normalize the 20 `lines.join("\n")` sites onto
`join("")` (76 sites). `report()` already appends `\n`, so the two forms make
any regex spanning a line boundary mean different things. This must be settled
before a shared assertion helper exists, or the helper bakes in the ambiguity.

**Also reduce:** the ten `/N warning\(s\)/` assertions in `doctor.test.ts`
(lines 426, 781, 1322, 1358, 1385, 1404, 1431, 1449, 1463, 1479) couple every
test to a file-wide counter — adding any new warn-level check to `runDoctor`
breaks all ten at once, in tests unrelated to the change. Reduce to one
canonical site (`:772`), except `:397`/`:426`, where the count is what
distinguishes ✓-hint from ⚠-warn.

## §3 Hermeticity fix

`doctor.test.ts`'s shared fixture points at **real paths** —
`okConfig.dataDir = "/tmp/junco-doc-state"`, and `worktreeRoot` likewise. Eight
tests (`:772`, `:1248`, `:1293`, `:1327`, `:1363`, `:1436`, `:1452`, `:1466`)
run the real `fs` against them _and_ assert exact warning counts. They pass only
because those directories happen not to exist on the machine running them.

Issue #199.3 fixed exactly this at `:96` and `:379` — but for only 2 of the ~10
affected tests. This design propagates that injection pattern to the rest and
makes the shared config default to a synthetic non-existent path. This is the
one part of the effort that fixes a real bug rather than relocating lines.

## §4 Harness performance (bounded)

The real-git harness runs in `beforeEach` across ~169 tests in 7 files.
Benchmarked: **142.5ms** to build vs **6.8ms** to `cpSync` a template built once
— 21×. This lands _inside_ `setupGitHarness`, not as a separate workstream.

**Unverified assumption, gating this section:** the benchmark measured the copy,
not whether git operations behave correctly on a copied repo. Task 1 verifies a
`cpSync`'d bare remote still accepts pushes. **If it does not hold, §4 is
dropped** — nothing else in this design depends on it.

Expected effect if it holds: `prFlow.test.ts` ~27s → ~20s, suite ~27s → ~22s.
Modest, and explicitly not the point of the effort.

## §5 Coverage floor and badge

`@vitest/coverage-v8`, exact-pinned per the dependency rule. The floor is
vitest's built-in thresholds, with the committed numbers **as** the baseline:

```ts
coverage: { provider: "v8", thresholds: { lines: ?, branches: ?, functions: ?, statements: ? } }
```

The four numbers are not chosen — they are **filled in from the step-1 baseline
measurement, rounded down to the nearest whole percent**, and committed in the
same task. Baseline is captured **before any change** in this branch. A silent coverage drop
becomes impossible; an intentional one is a visible, reviewable line in a diff.

**Badge:** GitHub badges are per-workflow, not per-job, so the chip requires a
separate `.github/workflows/coverage.yml`. It runs the single canonical leg
(**ubuntu, node 22.19**) — the 4-way gate matrix would otherwise produce four
different numbers, because `sandbox.integration.test.ts` is platform-gated and
skips when the backend binary is absent. README chip goes directly after the CI
chip.

Open for review, not decided here: whether `coverage` becomes a **required**
merge check (the aggregate `quality-gate` currently is) or stays advisory
initially.

Cost: a second full suite run in CI, in parallel with the gate. Measured during
implementation; if disproportionate, the fallback is restricting the workflow to
PRs and pushes to `main`.

## §6 Do-not-touch list

~45 of the 255 tests in the four largest files encode a specific regression, a
real filesystem/race precondition, or a negative assertion no table can express.
The implementation plan carries the full list with a reason per entry. The
highest-risk examples:

- **`doctor.test.ts:1019` (#186 + #192.3).** Its coverage lives in its `execFn`,
  not its assertion: lines 1041–1045 return `WRITE` **only if**
  `GH_CONFIG_DIR === "/sbx/junco-gh"` and both `GH_TOKEN`/`GITHUB_TOKEN` are
  empty. Flattening it to a table row with a plain `WRITE` stub **silently
  deletes the token-clearing pin with a green suite.**
- **`prFlow.test.ts:1185` / `:1225` (#70).** A deliberate opposed pair: identical
  remote setup, opposite policy keyed on `retry_count`. Merging destroys the
  contrast that _is_ the fix.
- **`runOnce.test.ts:403` (#115)** needs a regular file planted at
  `Junco/failed` so `mkdirSync` throws `EEXIST`; **`:1294` (#113)** needs a real
  on-disk symlink. The fixture is the test.
- **`prFlow.test.ts:884` (#123/#125)** asserts a _negative_ — the false "with no
  committed work" banner must be absent.
- **`daemon.test.ts:978` vs `:1158`** look like duplicates and are not: one is
  the account-level branch (fail, exit 1), the other per-repo (warn, exit 0).

## §7 Sequencing

1. Coverage baseline captured (nothing to diff against otherwise)
2. `lines.join` normalization (§2 prerequisite)
3. `cpSync` viability spike (§4 gate)
4. Helper modules created, each proved against exactly one adopter
5. Adoption file-by-file — mechanical, file-disjoint, parallelizable
6. Deletions, each with prove-it-fails-first
7. Harness perf, if §4 held
8. `coverage.yml` + README chip
9. Final coverage diff vs baseline

Roughly 12–16 commits, suite green at each.

## Risks

- **Adoption touches ~19 files.** No open PRs or issues at design time, so the
  runway is clear; re-check before starting and merge `origin/main` between
  tasks.
- **`prFlow`/`daemon` tests guard live-runtime machinery.** The daemon runs from
  this checkout. Test-only changes cannot affect it, but the do-not-touch list
  is the guard against weakening the tests that protect it.
- **CLAUDE.md becomes wrong.** Its "update every test fixture that builds a full
  `Config` literal — tests/{runOnce,prFlow,orphans,repo,worktree,daemon}" line
  must change in the same branch (it already understates the count: 19 files,
  not 6). Stale guidance would send the next session chasing helpers that no
  longer exist.

## Out of scope

- `src/tui/App.tsx` decomposition — sub-project B.
- Coverage gaps found but not addressed here: `configLevers.ts` (801 lines /
  194-line test), `execProbe.ts` (no importing test at all), `guardManager.ts`
  and `pidfileLock.ts` (below median despite being crash-safety-critical).
  These become issues, not scope creep.
- Mass `it.each` conversion. The clusters are real, but the tests are already
  nearly free to run and the `doctor.test.ts:1019` class of trap makes the
  risk/benefit unfavourable.
