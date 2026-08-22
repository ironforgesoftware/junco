# Skill-links polish: ordering test, normalization drift, structured report (WS-6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #294, #292 and #293 — the three deferred follow-ups from the skill-links work.

**Architecture:** junco ships a `junco-dispatch` skill by symlinking a packaged directory into `<dataDir>/skills` and fanning per-harness links out from there. Three unrelated weaknesses: the wizard's load-bearing call ordering is untested, the wizard and CLI compare harness directories with two different spellings of the same path, and `SkillLinksReport` carries pre-rendered strings that two consumers parse back with `startsWith`/`endsWith`.

**Tech Stack:** TypeScript strict/ESM, vitest. `tests/skillLinks.test.ts` uses a hand-rolled in-memory fs; `tests/skillCmd.test.ts` and `tests/updateCmd.test.ts` use plain-function dep harnesses; `tests/wizard.test.ts` uses real tmpdirs; `tests/wizardChapters.test.tsx` renders Ink components and drives them with keypresses.

**Spec:** GitHub issues #294, #292, #293.

## Global Constraints

- Full gate before done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Capture vitest exit explicitly — never pipe into `grep`/`tail` as the last stage. **`npm test` does not type-check**; always run `npm run typecheck` too.
- `src/tui/**` runs `eslint-plugin-react-hooks` with **both** rules at **error**. A hook with an incomplete dep array fails the gate — fix the deps by stabilising the source, never with an `eslint-disable`.
- Ink/TUI tests must not assert one fixed `setTimeout` tick after a state change — loop-until-condition with a bounded retry, then assert.
- Every side effect behind an injectable `*Deps` seam.
- New `Config` fields go in `tests/helpers/config.ts` and nowhere else. (This plan adds none.)
- Conventional commits, suite green at every commit, no AI-attribution trailers.
- Branch `fix/skill-links-polish` off `main` @ `df59d16`.
- **Release HOLD:** no version bump, no tag, no publish.

---

### Task 1: Pin the wizard's ensure-after-ensureDirs ordering (#294)

**Files:**

- Test only: `tests/wizard.test.ts`

**Interfaces:** none — no production change.

**Why:** `buildWizardIO`'s `write` closure calls `ensureDirs(...)` and then `ensureSkillLinks(...)`. The order is load-bearing: `ensureSkillLinks` symlinks `<dataDir>/skills`, and if it ran first the symlink would be attempted into a not-yet-created data dir — where `ensureSkillLinks`'s failure lands in a **swallowed warning** (it never throws, and `wizard.ts` discards its return value). A regression would therefore be completely invisible. The existing test asserts the ensure ran **once with the re-loaded config**, not its position.

Note the ordering guarantee is partly incidental — `ensureDirs` creates the _queue_ dirs, and `dataDir` exists afterwards only because those sit under it and `mkdir -p` creates parents. That is an argument for pinning it, not for trusting it.

- [ ] **Step 1: Write the test**

Add to `tests/wizard.test.ts`, following its real-tmpdir style and the file-wide `NOOP_SKILL_LINKS` fixture:

```ts
it("fresh mode: write creates the data dirs BEFORE ensuring skill links", () => {
  const dir = tmp();
  const cp = join(dir, "config.json");
  const order: string[] = [];
  const r = buildWizardIO(cp, {
    existsFn: () => false,
    mkdirFn: () => {
      order.push("mkdir");
    },
    ensureSkillLinksFn: () => {
      order.push("links");
      return NOOP_SKILL_LINKS;
    },
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("expected ok:true");
  r.io.write({ ...r.io.initialAnswers, dataDir: join(dir, "vault") });

  // ensureSkillLinks symlinks <dataDir>/skills; if it ran before the dirs
  // existed, symlinkSync would fail into a warning ensureSkillLinks never
  // throws and wizard.ts discards — an invisible regression. Pin the order.
  expect(order.length).toBeGreaterThan(1);
  expect(order.at(-1)).toBe("links");
  expect(order.filter((s) => s === "links")).toEqual(["links"]);
});
```

**Important:** `ensureDirs` calls `mkdirFn` once per queue dir plus `worktreeRoot`, and fresh mode calls it again for the config's own directory — so `mkdirFn` fires several times. Do NOT write `expect(order).toEqual(["mkdir", "links"])`; assert that `links` is **last** and occurs exactly once, as above.

- [ ] **Step 2: Prove the test would catch a regression**

Temporarily swap the two calls in `src/wizard.ts`'s `write` closure (ensure skill links first, then `ensureDirs`), run the test, and confirm it FAILS. Then restore and confirm it passes. Quote both outcomes — a test that cannot fail proves nothing, and this one exists precisely because the real failure is silent.

Run: `npx vitest run tests/wizard.test.ts > /tmp/t1.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t1.txt`

- [ ] **Step 3: Commit**

```bash
npx prettier --write tests/wizard.test.ts
git add tests/wizard.test.ts
git commit -m "test(wizard): pin skill-link ensure after the data-dir ensure

The order is load-bearing — ensureSkillLinks symlinks <dataDir>/skills, and
running it first would fail into a warning it never throws and wizard.ts
discards, so the regression would be invisible. The existing test asserted
the call count and config, not the position."
```

---

### Task 2: One rule for comparing harness directories (#292)

**Files:**

- Modify: `src/skillLinks.ts` (new exported helper)
- Modify: `src/skillCmd.ts` (use it for the dedupe)
- Modify: `src/tui/wizard/chapters/Skills.tsx` (use it for all three comparisons)
- Test: `tests/skillLinks.test.ts`, `tests/skillCmd.test.ts`, `tests/wizardChapters.test.tsx`

**Interfaces:**

- Produces: `sameHarnessDir(a: string, b: string): boolean` in `src/skillLinks.ts` — true when two spellings denote the same directory, comparing `expandHome` on both sides.

**Why:** the CLI dedupes `--harness` entries against config on the **expandHome-normalized** form, but the wizard's Skills chapter compares with **raw string equality** in three places. The two spellings genuinely coexist: `detectInstalledHarnesses` emits the raw registry string (`~/.claude/skills`) — it expands only for its existence _probe_ — while `junco skill install --harness /Users/me/.claude/skills` legitimately stores the absolute form, and `loadConfig` expands `Config.skills.harnessDirs` on every read.

Consequence today: a config holding the absolute spelling renders **unchecked** on a wizard rerun, and re-checking it writes a two-spelling duplicate — the tilde form from the option list plus the absolute form carried through the undetected-union filter. `ensureSkillLinks` is idempotent over both, so nothing breaks downstream; it is exactly the aliasing the CLI's normalized dedupe was added for.

**Do not change what `detectInstalledHarnesses` emits.** A test pins that it returns the raw registry string, and the raw form is what keeps a written config portable across machines. Fix the comparisons, not the data.

- [ ] **Step 1: Write the failing tests**

In `tests/skillLinks.test.ts`:

```ts
describe("sameHarnessDir", () => {
  it("matches a tilde spelling against its expanded form", () => {
    expect(sameHarnessDir("~/.claude/skills", join(homedir(), ".claude/skills"))).toBe(true);
  });
  it("matches identical spellings", () => {
    expect(sameHarnessDir("~/.claude/skills", "~/.claude/skills")).toBe(true);
  });
  it("does not match different directories", () => {
    expect(sameHarnessDir("~/.claude/skills", "~/.codex/skills")).toBe(false);
  });
});
```

In `tests/wizardChapters.test.tsx`, add a Skills-chapter case whose `answers.harnessDirs` holds the **expanded absolute** spelling of a detected harness whose registry entry is the tilde spelling, and assert the option renders **checked**. Read the existing Skills describe block first — its `HARNESSES` fixture uses absolute `/sbx/home/...` dirs on both sides, which is why the drift is invisible there today; your new case must deliberately mix the two spellings. Follow the file's Ink conventions (keypress driving, loop-until-condition with a bounded retry — never a fixed `setTimeout` tick).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/skillLinks.test.ts tests/wizardChapters.test.tsx > /tmp/t2.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t2.txt`

Expected: FAIL — `sameHarnessDir` does not exist, and the mixed-spelling option renders unchecked.

- [ ] **Step 3: Add the helper**

In `src/skillLinks.ts`, next to `detectInstalledHarnesses`:

```ts
/**
 * True when two spellings denote the same harness directory. Both sides are
 * expandHome'd because the two forms genuinely coexist: the registry (and so
 * `detectInstalledHarnesses`) emits the tilde form, `junco skill install
 * --harness <path>` stores whatever the operator typed, and `loadConfig`
 * expands `skills.harnessDirs` on every read. Comparing raw strings makes an
 * already-consented harness render unchecked on a wizard rerun and then
 * writes a two-spelling duplicate (#292).
 */
export function sameHarnessDir(a: string, b: string): boolean {
  return expandHome(a) === expandHome(b);
}
```

- [ ] **Step 4: Use it at every comparison site**

- `src/skillCmd.ts`: replace the `Set`-of-normalized-strings dedupe with `sameHarnessDir`, keeping the existing behaviour — first occurrence wins, within-invocation repeats collapse, and the **raw** (un-expanded) form is what gets stored.
- `src/tui/wizard/chapters/Skills.tsx`: use it in all three places — the `checked` pre-check, the undetected-union filter, and the value written on submit. **Also dedupe on submit**: with `sameHarnessDir` in the filter, a duplicate can no longer arrive from the union, but a config that already holds both spellings must collapse to one rather than being written back doubled.

Note this file is under `src/tui/**`, where both react-hooks rules are errors. If your change touches a hook's dependencies, stabilise the source (memoize the value or callback) rather than disabling the rule.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/skillLinks.test.ts tests/skillCmd.test.ts tests/wizardChapters.test.tsx tests/wizardFlow.test.ts > /tmp/t2b.txt 2>&1; echo "exit: $?"; tail -20 /tmp/t2b.txt`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/skillLinks.ts src/skillCmd.ts src/tui/wizard/chapters/Skills.tsx tests/skillLinks.test.ts tests/wizardChapters.test.tsx
git add src/skillLinks.ts src/skillCmd.ts src/tui/wizard/chapters/Skills.tsx tests/skillLinks.test.ts tests/wizardChapters.test.tsx
git commit -m "fix(skills): compare harness dirs on one normalized rule

The CLI deduped --harness entries on the expandHome-normalized form while
the wizard chapter compared raw strings, so a config holding the absolute
spelling of a tilde-registry harness rendered unchecked on a rerun and
re-checking wrote both spellings. sameHarnessDir is now the single rule."
```

---

### Task 3: Structured `SkillLinksReport` (#293)

**Files:**

- Modify: `src/skillLinks.ts` (the report type and all eight producer sites)
- Modify: `src/skillCmd.ts`, `src/daemon.ts`, `src/updateCmd.ts`, `src/wizard.ts` (consumers)
- Test: `tests/skillLinks.test.ts`, `tests/skillCmd.test.ts`, `tests/daemon.test.ts`, `tests/updateCmd.test.ts`, `tests/wizard.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type SkillLinkKind =
    | "created"
    | "repaired"
    | "ok"
    | "harness-not-installed"
    | "target-missing"
    | "symlink-failed"
    | "occupied"
    | "repair-failed"
    | "mkdir-failed";

  export interface SkillLinkEntry {
    /** The link path, or the harness directory for harness-not-installed / mkdir-failed. */
    path: string;
    kind: SkillLinkKind;
    /** The harness directory this entry belongs to, when it has one. Lets a
     * caller decide "did MY requested harness fail?" without path arithmetic. */
    harnessDir?: string;
    /** Human detail — an error message, or the missing target. */
    detail?: string;
  }

  export interface SkillLinksReport {
    entries: SkillLinkEntry[];
  }

  export function isSkillLinkFailure(kind: SkillLinkKind): boolean;
  export function renderSkillLinkEntry(e: SkillLinkEntry): string;
  ```

**Why:** the report carries pre-rendered prose, and two `skillCmd` behaviours parse it back — the exit code prefix-matches warning strings against a requested link path **and its dirname**, and the print prefix is chosen by `endsWith("(harness not installed)")`. A reword of any producer string silently breaks both, with nothing failing at compile time. The `dirname` arm exists only because the mkdir-failed warning is keyed on the directory rather than the link path — precisely the ambiguity a `harnessDir` field removes.

The two meanings of the old `skipped` bucket must stay distinguishable: a live valid link (`ok`) versus a harness that was never linked because it is not installed here (`harness-not-installed`). Collapsing them would print "ok" for something that was never linked.

- [ ] **Step 1: Write the failing tests**

Rewrite `tests/skillLinks.test.ts`'s assertions against the new shape — each producer path asserted by `kind` plus `path`, not by string matching. Cover all nine kinds. Then update `tests/skillCmd.test.ts`'s two behavioural tests to construct **structured** entries:

- the print test: an `ok` entry and a `harness-not-installed` entry must still render as `ok:` and `skipped:` respectively;
- the exit-code test: a `symlink-failed` entry whose `harnessDir` matches a requested `--harness` must still exit 1, and one whose `harnessDir` does not must exit 0.

Add a case that would have caught the original fragility: **an entry whose `detail` text is reworded must not change the exit code or the print prefix.**

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/skillLinks.test.ts tests/skillCmd.test.ts > /tmp/t3.txt 2>&1; echo "exit: $?"; tail -30 /tmp/t3.txt`

Expected: FAIL — the new shape does not exist.

- [ ] **Step 3: Restructure the producer**

Replace `SkillLinksReport`'s four string buckets with the `entries` array, and convert all eight push sites in `ensureSkillLinks` to structured entries, carrying `harnessDir` wherever the entry belongs to one. Keep the existing control flow **exactly** as it is — this is a representation change, not a behaviour change. In particular preserve: a live symlink pointing elsewhere is left alone (`ok`), a non-symlink squatter is never touched (`occupied`), and an uninstalled harness is a silent skip rather than a warning.

Add `isSkillLinkFailure` (true for `target-missing`, `symlink-failed`, `occupied`, `repair-failed`, `mkdir-failed`) and `renderSkillLinkEntry` so every consumer shares one rendering.

- [ ] **Step 4: Migrate the four consumers**

- **`src/skillCmd.ts`** — print `created:`/`repaired:`/`ok:`/`skipped:`/`warning:` by `kind`, using `renderSkillLinkEntry` for the text. Replace the exit-code decision with: exit 1 when any entry `isSkillLinkFailure(kind)` and its `harnessDir` matches a requested dir via `sameHarnessDir` (from Task 2). **The `dirname` arithmetic goes away entirely.**
- **`src/daemon.ts`** — log the structured entries. Preserve the all-quiet contract: a report containing only `ok` / `harness-not-installed` entries logs **nothing**.
- **`src/updateCmd.ts`** — created/repaired to stdout, failures to stderr, same as today.
- **`src/wizard.ts`** — it currently **discards** the report. Now that warnings are structured, log the failures instead of dropping them. This closes #294's silent-failure hole from the other side: the ordering test pins the call order, and this makes a failure visible if it ever happens anyway.

- [ ] **Step 5: Consider doctor**

`src/doctor.ts` re-derives link health independently and does **not** consume the report; its `dead`/`blocked` states parallel the producer's kinds, and it duplicates the harness-parent-exists rule. **Do not migrate it in this task** — it probes live filesystem state rather than the outcome of an ensure run, which is a different question. Note the duplication in your report as a possible follow-up.

- [ ] **Step 6: Full gate**

Every literal `{ created: [], repaired: [], skipped: [], warnings: [] }` stub in the suite changes shape. The full inventory: `tests/skillCmd.test.ts`, `tests/daemon.test.ts`, `tests/updateCmd.test.ts`, `tests/wizard.test.ts`. Update them all to `{ entries: [] }`.

```bash
npx prettier --write src/skillLinks.ts src/skillCmd.ts src/daemon.ts src/updateCmd.ts src/wizard.ts tests/skillLinks.test.ts tests/skillCmd.test.ts tests/daemon.test.ts tests/updateCmd.test.ts tests/wizard.test.ts
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/gate.txt 2>&1; echo "vitest exit: $?"; tail -8 /tmp/gate.txt
```

- [ ] **Step 7: Changelog and commit**

Add under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md` (Keep a Changelog order; no version heading, no `package.json` change):

```markdown
- Skill links: `junco skill install` now decides its exit code and its per-line output from structured report entries instead of prefix- and suffix-matching rendered warning strings, so rewording a message can no longer silently change behaviour; the wizard and the CLI compare harness directories by one normalized rule, so an already-consented harness no longer renders unchecked on a rerun (or gets written twice in two spellings); and the setup walkthrough now surfaces skill-link failures instead of discarding them.
```

```bash
git add -A ':!docs/superpowers/plans'
git commit -m "refactor(skills): structured SkillLinksReport entries

skillCmd decided its exit code by prefix-matching warning strings against a
link path and its dirname, and picked its print prefix with endsWith on a
rendered suffix — so rewording any producer string silently broke both, with
nothing failing at compile time. Entries now carry a kind and the harness dir
they belong to; rendering moved to the print layer. The wizard, which
discarded the report entirely, now logs failures."
```

---

## Self-review

**Spec coverage:** #294 is Task 1 (test-only, with a falsification step because the real failure is silent), #292 is Task 2, #293 is Task 3.

**Placeholder scan:** no TBDs. Every code step carries literal text; every run step carries a command and its expected outcome. Three steps require reading existing fixtures first and say so.

**Type consistency:** `sameHarnessDir` is added in Task 2 and consumed by Task 3's exit-code decision — so Task 2 must precede Task 3. `SkillLinkKind`/`SkillLinkEntry`/`isSkillLinkFailure`/`renderSkillLinkEntry` are all defined in Task 3 Step 3 before Steps 4-6 use them. No `Config` field is added, so `tests/helpers/config.ts` is untouched.

**Ordering dependency:** 1 → 2 → 3. Task 1 is independent but trivial and goes first; Task 3 depends on Task 2's helper.

**Known judgment calls (flag in the PR):** (1) `detectInstalledHarnesses` keeps emitting the raw registry string — the fix is in the comparisons, so written configs stay portable across machines; (2) the two old `skipped` meanings become distinct kinds (`ok` vs `harness-not-installed`) rather than collapsing; (3) `doctor` is deliberately not migrated — it probes live filesystem state, a different question from an ensure run's outcome; (4) the wizard now logs skill-link failures instead of discarding them.
