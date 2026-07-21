# TUI Filing Identity + QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One PR closing #224 #225 #226 #227 #228 — the TUI review-confirm path files assess findings under the resolved `assess.fileAs` identity (the bot, when configured) instead of silently using the operator's ambient gh login, plus three help/hints/timeout QoL fixes and the ink-upgrade coupling doc.

**Architecture:** Each fix is surgical and file-disjoint (only Task 2 and the Task 4 test share a test file). Task 1 mirrors the CLI's `withFileAsAuth` resolution (assessCmd.ts) into the dashboard gh client behind the existing injectable-deps seam. Tasks 2–4 are display/roster corrections pinned by App-level Ink tests. Task 5 is documentation only.

**Tech Stack:** TypeScript strict / ESM NodeNext, Ink 7.1.0 + React 19, vitest + ink-testing-library (`tests/helpers/until.js` loop-until-condition — never fixed-tick sleeps).

## Global Constraints

- Conventional commits, **no AI attribution of any kind** (no Co-Authored-By, no "Generated with" lines).
- Suite green at every commit; run `npx prettier --write` on touched files before each commit.
- Capture vitest exit codes explicitly (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`) — never pipe into a filter.
- No new `Config` fields (no LEVERS/bijection work needed); no top-level Pi SDK imports (untouched here).
- Full gate before the PR: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.

---

### Task 1: fileReview resolves the filing identity (#224)

**Files:**

- Modify: `src/tui/ghClient.ts` (import at :19, `GhClientDeps` block at :171-197, `fileReview` at :543-550)
- Test: `tests/tuiGhClient.test.ts` (base `cfg` fixture at :15-34, `describe("fileReview")` at :731)

**Interfaces:**

- Consumes: `withFileAsAuth(cfg)` from `src/ghAuth.ts:101` — returns cfg unchanged when `assess.fileAs === "me"` (no side effects); attaches `ghAuth` when `"bot"`; throws actionable Error when `"bot"` but bot disabled/broken.
- Produces: `GhClientDeps.withFileAsAuthFn?: (cfg: Config) => Promise<Config>`.

- [ ] **Step 1: Write the failing tests.** In `tests/tuiGhClient.test.ts`, add `assess: { fileAs: "me" },` to the base `cfg` literal (after `branchPrefix`) — the real `withFileAsAuth` reads `cfg.assess.fileAs`, and the fixture is `as unknown as Config`-cast so a partial `assess` is fine. Then append inside `describe("fileReview")`:

```ts
it('fileAs "bot": the filing cfg carries the bot identity (batch read stays ambient)', async () => {
  const botFileCfg = { ...enabledCfg, assess: { fileAs: "bot" } } as unknown as Config;
  let filedWith: Config | null = null;
  const readPendingFn = vi.fn((_c: Config, _id: string) => ({ batch, error: null }));
  const fileFindingsFn = vi.fn((c: Config): Promise<FileResult> => {
    filedWith = c;
    return Promise.resolve({
      created: 1,
      queuedOffline: 0,
      deduped: 0,
      failed: 0,
      urls: [],
      warnings: [],
    });
  });
  const withFileAsAuthFn = vi.fn(attachFakeCtx);
  const client = makeGhDashboardClient(botFileCfg, {
    ...fakes(),
    readPendingFn,
    fileFindingsFn,
    withFileAsAuthFn,
  });
  const r = await client.fileReview("assess-x-1", ["f1"]);
  expect(r.ok).toBe(true);
  expect(filedWith?.ghAuth).toEqual(FAKE_CTX);
  expect(readPendingFn).toHaveBeenCalledWith(botFileCfg, "assess-x-1");
});

it('fileAs "bot" with a broken bot login: error Result, nothing filed', async () => {
  const readPendingFn = vi.fn((_c: Config, _id: string) => ({ batch, error: null }));
  const fileFindingsFn = vi.fn();
  const withFileAsAuthFn = vi.fn(() =>
    Promise.reject(
      new Error("botAccount.enabled is true but no working gh login — run: junco auth login"),
    ),
  );
  const client = makeGhDashboardClient(cfg, {
    ...fakes(),
    readPendingFn,
    fileFindingsFn,
    withFileAsAuthFn,
  });
  const r = await client.fileReview("assess-x-1", ["f1"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("junco auth login");
  expect(fileFindingsFn).not.toHaveBeenCalled();
});

it('fileAs "me" (default dep): the filing cfg stays ambient — no ghAuth attached', async () => {
  let filedWith: (Config & { ghAuth?: unknown }) | null = null;
  const readPendingFn = vi.fn((_c: Config, _id: string) => ({ batch, error: null }));
  const fileFindingsFn = vi.fn((c: Config): Promise<FileResult> => {
    filedWith = c;
    return Promise.resolve({
      created: 0,
      queuedOffline: 0,
      deduped: 1,
      failed: 0,
      urls: [],
      warnings: [],
    });
  });
  // No withFileAsAuthFn injected: the REAL withFileAsAuth runs — safe,
  // because fileAs "me" short-circuits before any gh probe.
  const client = makeGhDashboardClient(cfg, { ...fakes(), readPendingFn, fileFindingsFn });
  const r = await client.fileReview("assess-x-1", ["f1"]);
  expect(r.ok).toBe(true);
  expect(filedWith).not.toBeNull();
  expect(filedWith?.ghAuth).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify the new tests fail.** `npx vitest run tests/tuiGhClient.test.ts > /tmp/t1.out 2>&1; echo "exit: $?"` — expect exit 1: test 1 fails on `filedWith?.ghAuth` (undefined ≠ FAKE_CTX); test 2 fails on `r.ok` (true, the fake never rejects because the dep is unknown → TS error first, which is the same signal: `withFileAsAuthFn` does not exist on `GhClientDeps`).

- [ ] **Step 3: Implement.** In `src/tui/ghClient.ts`: change the import at line 19 to `import { withBotAuth, withFileAsAuth } from "../ghAuth.js";`. In `GhClientDeps`, after `withBotAuthFn` add:

```ts
  /** assess.fileAs resolution for the review-confirm filing path — same
   * contract as the CLI's `junco assess file` (assessCmd.ts): attach the bot
   * identity when fileAs is "bot", fail loud (→ error Result → toast) when
   * the bot login is broken. Injectable for tests, like withBotAuthFn. */
  withFileAsAuthFn?: (cfg: Config) => Promise<Config>;
```

Replace the `fileReview` body:

```ts
    fileReview(id, fingerprints) {
      return attempt(async () => {
        const { batch, error } = (deps.readPendingFn ?? readPending)(cfg, id);
        if (error) throw new Error(error);
        if (!batch) throw new Error(`no pending review '${id}'`);
        // assess.fileAs: the filing pass runs under the resolved identity, or
        // fails loud BEFORE anything posts (mirrors `junco assess file`,
        // assessCmd.ts) — the batch stays parked on a broken bot login. (#224)
        const fileCfg = await (deps.withFileAsAuthFn ?? ((c: Config) => withFileAsAuth(c)))(cfg);
        return (deps.fileFindingsFn ?? fileFindings)(fileCfg, batch, new Set(fingerprints), {
          ghFn,
        });
      });
    },
```

- [ ] **Step 4: Run the file, then the full suite.** `npx vitest run tests/tuiGhClient.test.ts > /tmp/t1.out 2>&1; echo "exit: $?"` → exit 0 (the three pre-existing fileReview tests now traverse the real `withFileAsAuth` — the fixture's `fileAs: "me"` keeps them side-effect-free). Then `npx vitest run > /tmp/all.out 2>&1; echo "exit: $?"` → exit 0.

- [ ] **Step 5: Commit.** `npx prettier --write src/tui/ghClient.ts tests/tuiGhClient.test.ts && git add -A && git commit -m "fix(tui): review-confirm filing honors assess.fileAs — resolve the identity like the CLI path"`

---

### Task 2: help hints are mode-agnostic (#225)

**Files:**

- Modify: `src/tui/App.tsx` (`hints` computation at :2361-2369; stale comment block at :2165-2173)
- Test: `tests/tuiLocalApp.test.tsx` (`describe("local help modal")` at :171)

**Interfaces:** none new — display only.

- [ ] **Step 1: Write the failing test** (append to `describe("local help modal")`):

```tsx
it("help hints replace the LOCAL rail hints while help is open", async () => {
  const r = renderApp({ initialUiMode: "local" });
  await until(() => (r.lastFrame() ?? "").includes("↑/↓ section")); // rail hints in the footer
  r.stdin.write("?");
  await until(() => (r.lastFrame() ?? "").includes("local mode")); // help modal open
  await until(() => !(r.lastFrame() ?? "").includes("↑/↓ section")); // stale rail chips gone
  expect(r.lastFrame()).toContain("any key");
});
```

(Pre-check during implementation: `grep -n '↑/↓ section' src/tui/components/HelpModal.tsx` must be empty so the negative assertion can settle — it is; that footer chip text only comes from `localHintsFor`.)

- [ ] **Step 2: Run to verify it fails.** `npx vitest run tests/tuiLocalApp.test.tsx > /tmp/t2.out 2>&1; echo "exit: $?"` — expect exit 1: the third `until` times out (rail chips persist under help).

- [ ] **Step 3: Implement.** In `src/tui/App.tsx` replace the `hints` computation with:

```tsx
const hints =
  view === "config"
    ? // Mode-agnostic, like the view === "config" render branch above: the
      // config editor's own hints apply regardless of which surface opened
      // it, not LOCAL's section-rail hints.
      hintsFor("config", pane, layout.mode, filtering)
    : view === "help"
      ? // Mode-agnostic for the same reason: the help modal's "any key
        // closes" applies on both surfaces — LOCAL must not keep rendering
        // stale rail/body chips under the modal. (#225)
        hintsFor("help", pane, layout.mode, filtering)
      : uiMode === "local"
        ? localHintsFor(localSection, localFocus)
        : hintsFor(view as HintView, pane, layout.mode, filtering);
```

Then shrink the now-stale `footerActions` comment (the 8 lines starting "LOCAL's help modal (like github's) leaves the rail/body hint row showing") to:

```ts
// help/config render mode-agnostic hint sets (see the `hints` computation),
// so their chips carry no LOCAL actions — fall through to the switch below
// (case "help" returns {}), same as github. The view guards stay as
// defense-in-depth should the two computations ever drift.
```

- [ ] **Step 4: Run the file + full suite** (same exit-code discipline). Expect exit 0.
- [ ] **Step 5: Commit.** `npx prettier --write src/tui/App.tsx tests/tuiLocalApp.test.tsx && git add -A && git commit -m "fix(tui): help hints are mode-agnostic — no stale LOCAL chips under the modal"`

---

### Task 3: per-command palette timeouts (#226)

**Files:**

- Modify: `src/tui/cliRunner.ts` (`PaletteCommand` + `cmd` helper at :13-30, roster rows for `assess`/`run-once`, `runCliCommand` timeout line at :87)
- Test: `tests/tuiCliRunner.test.ts`

**Interfaces:**

- Produces: `PaletteCommand.timeoutMs: number | null` (null = default), exported `DEFAULT_TIMEOUT_MS = 120_000` and `timeoutFor(name: string): number`.

- [ ] **Step 1: Write the failing tests** (new describe after `describe("PALETTE_COMMANDS roster")`; extend the import line with `timeoutFor, DEFAULT_TIMEOUT_MS`):

```ts
describe("per-command timeouts", () => {
  it("assess and run-once carry long budgets; everything else keeps the default", () => {
    expect(timeoutFor("assess")).toBe(600_000);
    expect(timeoutFor("run-once")).toBe(3_600_000);
    expect(timeoutFor("status")).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutFor("not-a-command")).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("an injected deps.timeoutMs still wins over the roster value", async () => {
    const child = fakeChild();
    const { d } = deps(child, 30); // run-once's roster budget is 60 min — injection must win
    const r = await runCliCommand("/cfg/config.json", "run-once", [], d);
    expect(r.timedOut).toBe(true);
    expect(child.killed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/tuiCliRunner.test.ts > /tmp/t3.out 2>&1; echo "exit: $?"` — expect exit 1 (`timeoutFor` not exported).

- [ ] **Step 3: Implement.** In `src/tui/cliRunner.ts`:

```ts
export interface PaletteCommand {
  name: string;
  /** Placeholder hint for the args field; null = takes no args. */
  argsHint: string | null;
  description: string;
  /** Args always prepended when none are typed (e.g. bounded logs). */
  defaultArgs: string[];
  /** Non-null = not runnable from the palette; the string is the reason. */
  excluded: string | null;
  /** Subprocess time budget; null = DEFAULT_TIMEOUT_MS. Long-runners only:
   * assess may fork+clone an unwatched repo, run-once executes a full ticket. */
  timeoutMs: number | null;
}

const cmd = (
  name: string,
  argsHint: string | null,
  description: string,
  defaultArgs: string[] = [],
  excluded: string | null = null,
  timeoutMs: number | null = null,
): PaletteCommand => ({ name, argsHint, description, defaultArgs, excluded, timeoutMs });
```

Roster rows: `assess` gains `[], null, 600_000` and `run-once` gains `[], null, 3_600_000` as trailing args. Below the roster:

```ts
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Palette subprocess budget: the roster override or the 120 s default. */
export function timeoutFor(name: string): number {
  return PALETTE_COMMANDS.find((c) => c.name === name)?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}
```

And in `runCliCommand`: `const timeoutMs = deps.timeoutMs ?? timeoutFor(name);`

- [ ] **Step 4: Run the file + full suite.** Expect exit 0 (roster shape tests at :39-65 don't touch the new field).
- [ ] **Step 5: Commit.** `npx prettier --write src/tui/cliRunner.ts tests/tuiCliRunner.test.ts && git add -A && git commit -m "feat(tui): per-command palette timeouts — assess 10 min, run-once 60 min"`

---

### Task 4: correct the stale local-mouse help copy (#227)

**Files:**

- Modify: `src/tui/components/HelpModal.tsx:93`
- Test: `tests/tuiLocalApp.test.tsx` (`describe("local help modal")`)

- [ ] **Step 1: Write the failing test** (append to `describe("local help modal")`):

```tsx
it("help copy reflects wired LOCAL mouse support (no stale keyboard-first note)", async () => {
  const r = renderApp({ initialUiMode: "local" });
  await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
  r.stdin.write("?");
  await until(() => (r.lastFrame() ?? "").includes("local mode"));
  const f = r.lastFrame() ?? "";
  expect(f).not.toContain("keyboard-first");
  expect(f).toContain("click-again");
});
```

- [ ] **Step 2: Run to verify failure** (same discipline) — expect exit 1 on `not.toContain("keyboard-first")`.
- [ ] **Step 3: Implement.** Replace `HelpModal.tsx:93` with:

```tsx
            ["mouse", "parity with github: click selects/focuses · click-again enters/opens · wheel scrolls"],
```

- [ ] **Step 4: Run the file + full suite.** Expect exit 0.
- [ ] **Step 5: Commit.** `npx prettier --write src/tui/components/HelpModal.tsx tests/tuiLocalApp.test.tsx && git add -A && git commit -m "fix(tui): correct stale local-mouse help copy — LOCAL rows are fully clickable"`

---

### Task 5: ink-upgrade coupling checklist (#228)

**Files:**

- Create: `docs/ink-upgrade.md`

- [ ] **Step 1: Write the doc** (documentation task — no test cycle; the mouseRegions suite it references already guards the coupling):

```markdown
# Ink upgrade checklist

ink is exact-pinned (no `^`) because two TUI behaviors are coupled to ink
internals. Before merging any ink version bump, walk this list.

## 1. `mouseRegions.ts` walks ink's semi-internal `yogaNode`

Hit-region rects for mouse targets are computed by walking `yogaNode` on
ink's DOM elements — the only module touching that internal
(`src/tui/mouseRegions.ts`). `tests/tuiMouseRegions.test.tsx` fails loudly if
the shape changes.

**On a bump:** run the mouse suites
(`npx vitest run tests/tuiMouseRegions.test.tsx tests/tuiMouseApp.test.tsx`),
then verify click/hover/wheel in a real terminal (`junco dashboard`): rail
clicks, footer chips, LOCAL body rows, wheel in lists and the daemon panel.

## 2. `exitOnCtrlC: false` is load-bearing

`dashboardCmd.ts` renders with `exitOnCtrlC: false`: under ink 7.1.0,
`true` makes `useInput` skip every registered handler for Ctrl-C, which
would break WizardApp's post-write Ctrl-C reporting and the FTUE-cancel
exit code (130). App installs its own Ctrl-C quit hook and the second input
cascade bails early so Ctrl-C is never misread as a plain `c`
(`src/tui/App.tsx`). Test streams are non-TTY, so this CANNOT be fully
validated by the suite.

**On a bump:** re-read ink's changelog for `exitOnCtrlC`/`useInput`
changes, then smoke in a real TTY: Ctrl-C from the dashboard (clean quit),
Ctrl-C mid-wizard (cancel + exit 130), and the wizard Account chapter's
suspended `gh auth login` (raw-mode handoff — issues #214/#216 regressed
here before).

## Related

- `tests/tuiRoot.test.tsx` (exit codes), `tests/useSuspendTty.test.tsx`
  (raw-mode drop during suspension) — light coverage; the real-TTY smoke
  above is the actual gate.
```

- [ ] **Step 2: Commit.** `npx prettier --write docs/ink-upgrade.md && git add docs/ink-upgrade.md && git commit -m "docs: ink-upgrade coupling checklist — yogaNode hit-testing, exitOnCtrlC"`

---

### Finish: full gate + PR

- [ ] `npm run lint && npm run format:check && npm run typecheck && npm run build` then `npm test > /tmp/gate.out 2>&1; echo "exit: $?"` — all green.
- [ ] Push `fix/tui-filing-identity-and-qol`; `gh pr create` with a body that explains the attribution root cause and lists `Closes #224/#225/#226/#227/#228`. No AI attribution anywhere.
- [ ] Do NOT merge — the maintainer confirms merges that touch live-runtime machinery.

## Self-Review

- Spec coverage: #224→Task 1, #225→Task 2, #226→Task 3, #227→Task 4, #228→Task 5. ✓
- No placeholders; every code step carries the code. ✓
- Type consistency: `withFileAsAuthFn?: (cfg: Config) => Promise<Config>` matches `withBotAuthFn`'s monomorphic-over-Config idiom; `timeoutFor`/`DEFAULT_TIMEOUT_MS` names used consistently in Task 3's test and impl. ✓
